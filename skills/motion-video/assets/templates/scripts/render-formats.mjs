// Validates, renders and verifies the composition in every output format chosen in
// data/providers.json ("output": { "formats": ["16:9", "9:16", ...] }), one after the other:
// set-format -> lint -> check -> (snapshot | render -> remux mix -> social encode -> ffprobe/loudness/black check).
// index.html is switched back to the first format at the end.
// Usage: node scripts/render-formats.mjs [--formats=16:9,9:16] [--snapshot=2,18.5,40] [--name=slug]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { loadProviders, root } from "./multix-lib.mjs";
import { FORMATS, setFormat } from "./set-format.mjs";

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1];
const formats = (arg("formats") || (loadProviders().output?.formats || ["16:9"]).join(",")).split(",").filter(Boolean);
const snapshotAt = arg("snapshot");
const name = arg("name") || basename(root);
const HF = ["--yes", "hyperframes@0.7.99"];
for (const f of formats) if (!FORMATS[f]) throw new Error(`unknown format ${f} (${Object.keys(FORMATS).join(", ")})`);
mkdirSync(join(root, "renders"), { recursive: true });

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};
const stderrOf = (args) => spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8" }).stderr;

const report = [];
try {
  for (const aspect of formats) {
    const f = setFormat(root, aspect);
    const tag = f.key;
    console.log(`\n=== ${aspect} (${f.w}x${f.h}) ===`);
    const lint = run("npx", [...HF, "lint"]);
    const check = run("npx", [...HF, "check"]);
    const lintErr = /(\d+) error\(s\)/.exec(lint.out)?.[1] ?? "?";
    const checkOk = /Check passed/.test(check.out);
    console.log(`lint errors: ${lintErr} · check: ${checkOk ? "passed" : "FAILED"}`);
    if (!checkOk) console.log(check.out.split("\n").filter((l) => /✗/.test(l)).slice(0, 15).join("\n"));

    if (snapshotAt) {
      const out = join(root, "snapshots", tag);
      rmSync(out, { recursive: true, force: true });
      run("npx", [...HF, "snapshot", "--at", snapshotAt, "--describe", "false"]);
      if (existsSync(join(root, "snapshots"))) {
        mkdirSync(out, { recursive: true });
        for (const file of execFileSync("ls", [join(root, "snapshots")], { encoding: "utf8" }).split("\n").filter((x) => /\.(png|jpg)$/.test(x))) {
          renameSync(join(root, "snapshots", file), join(out, file));
        }
      }
      console.log(`snapshots -> snapshots/${tag}/`);
      report.push({ aspect, lintErr, checkOk });
      continue;
    }

    const raw = join(root, "renders", `${name}-${tag}.raw.mp4`);
    const master = join(root, "renders", `${name}-${tag}.mp4`);
    const social = join(root, "renders", `${name}-${tag}-social.mp4`);
    const r = run("npx", [...HF, "render", "-q", "high", "-f", "30", "--strict", "-o", raw]);
    if (!r.ok) throw new Error(`render ${aspect} failed:\n${r.out.slice(-1200)}`);
    // the renderer re-encodes AAC and can push the true peak up; copy the untouched mix instead
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-i", join(root, "assets/audio/mix.m4a"), "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", master]);
    rmSync(raw, { force: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", master, "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1", "-g", "60", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", social]);

    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-show_entries", "format=duration", "-of", "json", master], { encoding: "utf8" });
    const p = JSON.parse(probe);
    const loud = stderrOf(["-i", master, "-af", "ebur128=peak=true", "-vn", "-f", "null", "-"]);
    const sum = loud.slice(loud.lastIndexOf("Summary"));
    const black = (stderrOf(["-i", master, "-vf", "blackdetect=d=0.1:pix_th=0.05", "-an", "-f", "null", "-"]).match(/black_start/g) || []).length;
    const row = {
      aspect,
      size: `${p.streams[0].width}x${p.streams[0].height}`,
      fps: p.streams[0].r_frame_rate,
      duration: Number(p.format.duration).toFixed(2),
      lufs: /I:\s+(-?[\d.]+)/.exec(sum)?.[1],
      peak: /Peak:\s+(-?[\d.]+)/.exec(sum)?.[1],
      black,
      lintErr,
      checkOk,
      files: [basename(master), basename(social)],
    };
    report.push(row);
    console.log(row);
  }
} finally {
  setFormat(root, formats[0]);
}
console.log("\nSummary");
console.table(report.map(({ files, ...r }) => r));
