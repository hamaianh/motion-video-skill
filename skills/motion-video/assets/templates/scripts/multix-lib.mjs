// Shared helpers for the pipeline scripts: provider choices (data/providers.json) and multix calls.
// Provider choices are written by <skill>/scripts/setup-providers.mjs; API keys live only in ~/.multix/.env.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Defaults match the reference editions, so a project without providers.json behaves as before.
const DEFAULTS = {
  voice: { provider: "gemini", model: "gemini-3.8-flash-tts", voice: "Fenrir" },
  sfx: { provider: "elevenlabs" },
  music: { provider: "elevenlabs" },
  align: { provider: "elevenlabs" },
  image: { provider: "file" },
  output: { formats: ["16:9"] }, // video formats to render: 16:9, 9:16, 1:1, 4:5
};

export function loadProviders() {
  const file = join(root, "data/providers.json");
  const chosen = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, { ...v, ...(chosen[k] || {}) }]));
}

// multix drops a copy of every output into ./multix-output; keep that out of the project.
export const workDir = join(os.tmpdir(), `${basename(root)}-multix`);
mkdirSync(workDir, { recursive: true });

const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;

function runOnce(argv, env) {
  return new Promise((ok, fail) => {
    const child = spawn("multix", argv.map(quote), { shell: true, cwd: workDir, env: { ...process.env, ...env } });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) => (code === 0 ? ok(log) : fail(new Error(`multix ${argv[0]} ${argv[1]} failed (${code}):\n${log.slice(-800)}`))));
  });
}

// Free tiers rate-limit hard (Gemini TTS: 3 requests/minute), so HTTP 429 is retried after a pause.
// Missing permissions (401/403) and empty balances (402) fail fast with a hint instead.
export async function multix(argv, { env = {}, tries = 6, wait = 30000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await runOnce(argv, env);
    } catch (e) {
      if (/missing the permission|missing_permissions/i.test(e.message)) e.message += "\nHint: the ElevenLabs key lacks a permission; create a key with it enabled (see references/providers-and-keys.md).";
      if (/402|payment_required|paid_plan_required|Exhausted balance/i.test(e.message)) e.message += "\nHint: this provider needs a paid plan or a top-up; pick another provider with setup-providers.mjs.";
      if (i >= tries || !/\b429\b|rate limit/i.test(e.message)) throw e;
      console.log(`rate limited (${argv[0]} ${argv[1]}), retry ${i} in ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Runs any fal.ai model and copies its first downloaded media file to `out`.
export async function fal(model, input, out) {
  const dir = mkdtempSync(join(os.tmpdir(), "fal-"));
  try {
    const inputFile = join(dir, "input.json");
    writeFileSync(inputFile, JSON.stringify(input));
    await multix(["fal", "run", model, "--input", `@${inputFile}`], { env: { MULTIX_OUTPUT_DIR: dir } });
    const media = readdirSync(dir).filter((f) => f.startsWith("fal-"));
    if (!media.length) throw new Error(`fal ${model}: no media downloaded`);
    mkdirSync(dirname(out), { recursive: true });
    const src = join(dir, media[0]);
    if (extname(src) === extname(out)) copyFileSync(src, out);
    else await ffmpegCopy(src, out);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ffmpegCopy(src, out) {
  return new Promise((ok, fail) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", src, out]);
    child.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`ffmpeg could not convert ${src} -> ${out}`))));
  });
}

export async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}
