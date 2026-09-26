#!/usr/bin/env node
// Motion Video Studio: a local web page to fill in a video brief (content, images, style, format,
// language, providers) and press "Tạo video". Each job scaffolds a project, writes the brief and
// provider choices, then runs Claude Code headless with the motion-video skill to build and render it.
//
//   node <skill>/studio/server.mjs [--port 4173] [--workspace <dir>]
//
// Binds to 127.0.0.1 only. Every API call needs the per-run token embedded in the page, so other
// websites cannot drive it. API keys are written to ~/.multix/.env (mode 600) and never returned.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = resolve(arg("workspace", process.cwd()));
const PORT = Number(arg("port", 4173));
const PROJECTS = join(WORKSPACE, "assets/videos");
const STATE = join(WORKSPACE, ".studio");
const JOBS = join(STATE, "jobs");
const ENV_FILE = join(homedir(), ".multix/.env");
const TOKEN = randomBytes(18).toString("hex");
mkdirSync(JOBS, { recursive: true });
mkdirSync(PROJECTS, { recursive: true });
// keep studio state and any stray local files out of git if the workspace is a repo
if (!existsSync(join(STATE, ".gitignore"))) writeFileSync(join(STATE, ".gitignore"), "*\n");

// ---------- secrets ----------
const KEY_NAMES = ["GEMINI_API_KEY", "ELEVENLABS_API_KEY", "FAL_KEY", "OPENAI_API_KEY"];
function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}
function writeEnvKey(name, value) {
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith(`${name}=`)) : [];
  lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}
const keyStatus = () => {
  const env = readEnv();
  return Object.fromEntries(KEY_NAMES.map((k) => [k, env[k] ? `…${env[k].slice(-4)}` : null]));
};
// strip anything that looks like a credential before it reaches a log or the browser
const redact = (s) =>
  String(s)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza…[redacted]")
    .replace(/sk_[0-9a-f]{20,}/g, "sk_…[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-…[redacted]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}/g, "[fal key redacted]")
    .replace(/meigen_sk_[A-Za-z0-9]+/g, "meigen_sk_…[redacted]");

// ---------- options shown in the form ----------
const OPTIONS = {
  styles: [
    { id: "comic-spiderverse", label: "Comic multiverse (Spider-Verse)", ref: "references/style-comic-spiderverse.md" },
    { id: "glass-keynote", label: "Glass keynote (Apple-like)", ref: "references/style-glass-keynote.md" },
  ],
  formats: [
    { id: "16:9", label: "16:9 ngang · 1920×1080 · YouTube/web" },
    { id: "9:16", label: "9:16 dọc · 1080×1920 · TikTok/Reels/Shorts" },
    { id: "1:1", label: "1:1 vuông · 1080×1080 · Feed" },
    { id: "4:5", label: "4:5 dọc · 1080×1350 · Feed Instagram/Facebook" },
  ],
  languages: [
    { id: "en", label: "EN — tiếng Anh" },
    { id: "vi", label: "VN — tiếng Việt" },
  ],
  captions: [
    { id: "same", label: "Cùng ngôn ngữ với giọng đọc" },
    { id: "vi", label: "Tiếng Việt" },
    { id: "en", label: "Tiếng Anh" },
    { id: "none", label: "Không phụ đề" },
  ],
  voice: [
    { id: "gemini", label: "Gemini 3.8 Flash TTS (style prompt)", key: "GEMINI_API_KEY" },
    { id: "gemini-lite", label: "Gemini 3.8 Flash Lite TTS", key: "GEMINI_API_KEY" },
    { id: "elevenlabs", label: "ElevenLabs eleven_v3", key: "ELEVENLABS_API_KEY" },
    { id: "openai", label: "OpenAI gpt-4o-mini-tts", key: "OPENAI_API_KEY" },
    { id: "fal", label: "ElevenLabs eleven_v3 qua fal.ai (không giới hạn gói Free)", key: "FAL_KEY" },
  ],
  voiceNames: {
    gemini: ["Fenrir", "Puck", "Kore", "Charon", "Aoede", "Leda", "Orus", "Zephyr"],
    "gemini-lite": ["Fenrir", "Puck", "Kore", "Charon", "Aoede", "Leda", "Orus", "Zephyr"],
    elevenlabs: ["kdmDKE6EkgrWrrykO9Qt"],
    openai: ["marin", "cedar", "alloy", "ash", "coral", "sage", "verse"],
    fal: ["Brian", "Rachel", "Aria", "Roger", "Sarah", "George", "Charlie", "Laura"],
  },
  sfx: [
    { id: "fal", label: "ElevenLabs SFX qua fal.ai", key: "FAL_KEY" },
    { id: "elevenlabs", label: "ElevenLabs SFX trực tiếp", key: "ELEVENLABS_API_KEY" },
  ],
  music: [
    { id: "fal", label: "ElevenLabs Music qua fal.ai", key: "FAL_KEY" },
    { id: "elevenlabs", label: "ElevenLabs Music trực tiếp (gói trả phí)", key: "ELEVENLABS_API_KEY" },
    { id: "file", label: "File nhạc tự upload", key: null },
  ],
  image: [
    { id: "file", label: "Dùng ảnh upload", key: null },
    { id: "fal", label: "Tạo ảnh bằng fal.ai (Flux)", key: "FAL_KEY" },
    { id: "gemini", label: "Tạo ảnh bằng Gemini (cần billing)", key: "GEMINI_API_KEY" },
    { id: "openai", label: "Tạo ảnh bằng OpenAI gpt-image", key: "OPENAI_API_KEY" },
    { id: "codex", label: "Tạo ảnh qua Codex CLI (đã đăng nhập)", key: null },
  ],
  goals: ["Quảng cáo tải app / đăng ký", "Ra mắt phiên bản / tính năng", "Giới thiệu sản phẩm", "Explainer / hướng dẫn"],
  durations: [15, 30, 45, 60, 100],
};

// ---------- jobs ----------
const jobs = new Map(); // id -> { meta, proc, clients:Set }
const jobFile = (id) => join(JOBS, `${id}.json`);
const logFile = (id) => join(JOBS, `${id}.log`);
const saveMeta = (m) => writeFileSync(jobFile(m.id), JSON.stringify(m, null, 1));
for (const f of readdirSync(JOBS).filter((f) => f.endsWith(".json"))) {
  const m = JSON.parse(readFileSync(join(JOBS, f), "utf8"));
  if (m.status === "running" || m.status === "queued") {
    m.status = "interrupted";
    saveMeta(m);
  }
  jobs.set(m.id, { meta: m, clients: new Set() });
}
const queue = [];
let running = null;

function log(id, line) {
  const text = redact(line);
  appendFileSync(logFile(id), text + "\n");
  for (const res of jobs.get(id)?.clients || []) res.write(`data: ${JSON.stringify({ line: text })}\n\n`);
}
function setStatus(id, patch) {
  const j = jobs.get(id);
  Object.assign(j.meta, patch, { updated: new Date().toISOString() });
  saveMeta(j.meta);
  for (const res of j.clients) res.write(`data: ${JSON.stringify({ status: j.meta })}\n\n`);
}

const slugify = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "video";

function scaffold(dir) {
  const T = join(SKILL, "assets/templates");
  for (const d of ["data", "scripts", "assets/fonts", "assets/images", "assets/chars", "assets/audio/vo", "assets/audio/sfx", "assets/audio/music", "renders"]) mkdirSync(join(dir, d), { recursive: true });
  cpSync(join(T, "scripts"), join(dir, "scripts"), { recursive: true });
  cpSync(join(SKILL, "scripts/fit-beat-grid.py"), join(dir, "scripts/fit-beat-grid.py"));
  cpSync(join(T, "hyperframes.json"), join(dir, "hyperframes.json"));
  cpSync(join(T, "index-skeleton.html"), join(dir, "index.html"));
  for (const f of readdirSync(join(T, "data"))) cpSync(join(T, "data", f), join(dir, "data", f.replace(".example", "")));
}

function saveUpload(dir, file, name) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(file.data || "");
  if (!m) throw new Error(`upload ${file.name}: not a data URL`);
  const buf = Buffer.from(m[2], "base64");
  const ext = (extname(file.name || "").toLowerCase() || ".bin").replace(/[^.a-z0-9]/g, "");
  const out = join(dir, `${name}${ext}`);
  writeFileSync(out, buf);
  return out;
}

function buildPrompt(b, project, images, musicFile) {
  const rel = project.replace(WORKSPACE + sep, "");
  const style = OPTIONS.styles.find((s) => s.id === b.style) || OPTIONS.styles[0];
  const voiceLang = b.language === "vi" ? "vi" : "en";
  const captions = b.captions === "same" || !b.captions ? voiceLang : b.captions;
  const langRules =
    voiceLang === "en" && captions !== "vi"
      ? `Language: ENGLISH ONLY. Voice-over, ${captions === "none" ? "no captions" : "karaoke captions"}, headlines, labels, bubbles and CTA are all English. Do not write any Vietnamese anywhere: script.json lines carry only "en" (and optional "say"); no "vi" fields, no data-vi attributes.`
      : voiceLang === "vi"
        ? `Language: Vietnamese voice-over (script lines need "vi" + optional "say_vi" for pronunciation, plus "en" as the anchor text). Captions: ${captions}. On-screen text in Vietnamese via data-vi on every visible string (keep brand names). Use fonts with Vietnamese glyphs (Pangolin instead of Permanent Marker).`
        : `Language: English voice-over with ${captions === "vi" ? "Vietnamese" : captions} captions (script lines need "en" and "${captions}").`;
  return `You are running unattended from Motion Video Studio. Nobody will answer questions: make sensible decisions yourself and keep going until the video is rendered.

Use the motion-video skill at ${SKILL} (read its SKILL.md and the references it points to) to produce ONE video.

Project directory (already scaffolded from the skill templates): ${rel}
- data/brief.json holds the full brief from the form. Read it first.
- data/providers.json is already set by the user (voice, sfx, music, align, image, output format ${b.format}, language). Do NOT change it and SKIP the skill's step 0 questions. Keys are already in ~/.multix/.env; never print or copy them.
- Uploaded images: ${images.length ? images.map((p) => p.replace(project + sep, "")).join(", ") : "none"}${images.length ? " (use them as the characters / key visuals)" : ""}.
${musicFile ? `- Uploaded music: ${musicFile.replace(project + sep, "")} (music provider "file": use it as the source track, fit the beat grid and splice it).` : ""}

Brief summary:
- Product / brand: ${b.brand || "(see description)"}
- Goal: ${b.goal || "product video"}; call to action: ${b.cta || "(derive from the brief)"}
- Duration: about ${b.duration || 60} seconds
- Style: ${style.label} (${style.ref}). Art direction: ${b.artDirection || "follow the style reference"}
- Output: exactly one video in ${b.format} using scripts/render-formats.mjs (no other formats).
- ${langRules}
- Facts: only from the description${b.sourceUrl ? ` and ${b.sourceUrl}` : ""}; no invented numbers or superlatives. Write the evidence to plans/reports/${basename(project)}-facts.md.
- Signature: ${b.signature ? `"${b.signature}"` : "none (remove the #sig element)"}.

Follow the skill's pipeline end to end: script, audio (generate-audio-assets vo/sfx/music with the chosen providers), align, beat grid + arrangement, build-timeline, composition for ${b.format}, lint/check, snapshots review, render-formats.mjs render + verify. If a provider fails (quota, permission, balance), report it clearly and stop instead of faking the output.

When finished, print one last line exactly like:
STUDIO_RESULT: {"ok": true|false, "video": "<path of the master mp4 relative to the workspace>", "social": "<social mp4 path>", "notes": "<one sentence>"}`;
}

function resumePrompt(meta, patch) {
  const rel = meta.project.replace(WORKSPACE + sep, "");
  return `You are running unattended from Motion Video Studio. Nobody will answer questions.

Continue the motion-video project ${rel} (skill at ${SKILL}) from where it stopped and finish the render.
Previous run notes: ${meta.result?.notes || "(see the project files)"}
${Object.keys(patch).length ? `The user changed providers in data/providers.json: ${JSON.stringify(patch)}. If the voice provider or voice changed, regenerate EVERY voice-over clip with --force (one voice for the whole video) and re-align with --force.` : "Providers are unchanged; retry the step that failed."}
Keep data/brief.json, data/providers.json (as updated), the language and the output format. Reuse finished assets; do not ask questions; never print keys.
Finish with lint/check, a snapshot review, render-formats.mjs render + verify, then print one last line exactly like:
STUDIO_RESULT: {"ok": true|false, "video": "<master mp4 path relative to the workspace>", "social": "<social mp4 path>", "notes": "<one sentence>"}`;
}

function resumeJob(id, body) {
  const j = jobs.get(id);
  if (["running", "queued"].includes(j.meta.status)) throw new Error("Job đang chạy.");
  const patch = {};
  const sets = [];
  for (const [field, group] of [["voiceProvider", "voice"], ["musicProvider", "music"], ["sfxProvider", "sfx"]]) {
    if (body[field] && body[field] !== j.meta.brief[field]) { sets.push(`${group}=${body[field]}`); patch[group] = body[field]; j.meta.brief[field] = body[field]; }
  }
  if (sets.length) execFileSync("node", [join(SKILL, "scripts/setup-providers.mjs"), j.meta.project, "--set", ...sets], { encoding: "utf8" });
  if (body.voiceName && (body.voiceName !== j.meta.brief.voiceName || patch.voice)) {
    const pf = join(j.meta.project, "data/providers.json");
    const p = JSON.parse(readFileSync(pf, "utf8"));
    p.voice.voice = body.voiceName;
    writeFileSync(pf, JSON.stringify(p, null, 2) + "\n");
    patch.voiceName = body.voiceName;
    j.meta.brief.voiceName = body.voiceName;
  }
  j.prompt = resumePrompt(j.meta, patch);
  delete j.meta.result;
  setStatus(id, { status: "queued", resumed: (j.meta.resumed || 0) + 1 });
  log(id, `↻ Chạy tiếp${Object.keys(patch).length ? ` với ${JSON.stringify(patch)}` : ""}`);
  queue.push(id);
  startNext();
  return j.meta;
}

function startNext() {
  if (running || !queue.length) return;
  const id = queue.shift();
  const j = jobs.get(id);
  running = id;
  setStatus(id, { status: "running", started: new Date().toISOString() });
  log(id, `▶ Claude Code bắt đầu trong ${WORKSPACE}`);
  const args = ["-p", j.prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--add-dir", SKILL];
  if (j.meta.brief.claudeModel) args.push("--model", j.meta.brief.claudeModel);
  const proc = spawn("claude", args, { cwd: WORKSPACE, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  j.proc = proc;
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      appendFileSync(join(JOBS, `${id}.jsonl`), redact(line) + "\n");
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant") {
          for (const c of ev.message?.content || []) {
            if (c.type === "text" && c.text.trim()) {
              log(id, `💬 ${c.text.trim()}`);
              const m = /STUDIO_RESULT:\s*(\{.*\})/.exec(c.text);
              if (m) try { setStatus(id, { result: JSON.parse(m[1]) }); } catch {}
            } else if (c.type === "tool_use") {
              const inp = c.input || {};
              const what = inp.description || inp.command || inp.file_path || inp.pattern || inp.prompt || "";
              log(id, `🔧 ${c.name}: ${String(what).split("\n")[0].slice(0, 160)}`);
            }
          }
        } else if (ev.type === "result") {
          log(id, `■ Kết thúc: ${ev.subtype}${ev.total_cost_usd != null ? ` · $${ev.total_cost_usd.toFixed(2)}` : ""} · ${Math.round((ev.duration_ms || 0) / 60000)} phút`);
        }
      } catch {
        log(id, line.slice(0, 300));
      }
    }
  });
  proc.stderr.on("data", (d) => log(id, `stderr: ${String(d).trim().slice(0, 400)}`));
  proc.on("close", (code) => {
    const renders = join(j.meta.project, "renders");
    const outputs = existsSync(renders) ? readdirSync(renders).filter((f) => f.endsWith(".mp4")).map((f) => join(renders, f).replace(WORKSPACE + sep, "")) : [];
    const ok = code === 0 && outputs.length > 0 && j.meta.result?.ok !== false;
    setStatus(id, { status: j.meta.status === "cancelled" ? "cancelled" : ok ? "done" : "failed", exitCode: code, outputs, finished: new Date().toISOString() });
    log(id, ok ? `✅ Xong: ${outputs.join(", ")}` : `⚠ Dừng (exit ${code}). Xem log phía trên.`);
    running = null;
    startNext();
  });
}

function createJob(body) {
  const b = body.brief || {};
  if (!b.description?.trim() && !b.brand?.trim()) throw new Error("Cần ít nhất tên sản phẩm hoặc mô tả.");
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  let slug = slugify(b.projectName || b.brand || "video");
  while (existsSync(join(PROJECTS, slug))) slug = `${slug.replace(/-\d+$/, "")}-${Math.floor(Math.random() * 900 + 100)}`;
  const project = join(PROJECTS, slug);
  scaffold(project);
  const images = (body.images || []).map((f, i) => saveUpload(join(project, "assets/chars"), f, `c${i + 1}`));
  const musicFile = body.music ? saveUpload(join(project, "assets/audio/music"), body.music, "bgm-raw") : null;
  // provider + format + language choices through the skill's own setup script
  const voiceLang = b.language === "vi" ? "vi" : "en";
  const captions = !b.captions || b.captions === "same" ? voiceLang : b.captions;
  const sets = [
    `voice=${b.voiceProvider || "gemini"}`,
    `sfx=${b.sfxProvider || "fal"}`,
    `music=${musicFile ? "file" : b.musicProvider || "fal"}`,
    "align=elevenlabs",
    `image=${images.length && (b.imageProvider || "file") === "file" ? "file" : b.imageProvider || "file"}`,
    `aspect=${b.imageAspect || "3:4"}`,
    `format=${b.format || "16:9"}`,
    `lang=${voiceLang}/${captions}`,
  ];
  execFileSync("node", [join(SKILL, "scripts/setup-providers.mjs"), project, "--set", ...sets], { encoding: "utf8" });
  if (b.voiceName) {
    const pf = join(project, "data/providers.json");
    const p = JSON.parse(readFileSync(pf, "utf8"));
    p.voice.voice = b.voiceName;
    writeFileSync(pf, JSON.stringify(p, null, 2) + "\n");
  }
  writeFileSync(join(project, "data/brief.json"), JSON.stringify({ ...b, images: images.map((p) => basename(p)), music: musicFile && basename(musicFile), created: new Date().toISOString() }, null, 2));
  const meta = { id, slug, project, status: "queued", created: new Date().toISOString(), brief: b, format: b.format || "16:9", language: `${voiceLang}/${captions}` };
  const prompt = buildPrompt(b, project, images, musicFile);
  jobs.set(id, { meta, prompt, clients: new Set() });
  saveMeta(meta);
  writeFileSync(logFile(id), "");
  log(id, `📁 Project: ${project.replace(WORKSPACE + sep, "")} · ${meta.format} · ngôn ngữ ${meta.language} · ${images.length} ảnh${musicFile ? " · nhạc upload" : ""}`);
  queue.push(id);
  if (running) log(id, "⏳ Đang chờ job trước chạy xong…");
  startNext();
  return meta;
}

// ---------- http ----------
const readBody = (req, limit = 80 * 1024 * 1024) =>
  new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Upload quá lớn (tối đa 80 MB)"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
  });
const json = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};
const MIME = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".json": "application/json" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      const html = readFileSync(join(SKILL, "studio/index.html"), "utf8").replace("__STUDIO_TOKEN__", TOKEN);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    // project files (renders, snapshots) for preview/download: only inside assets/videos
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      if (url.searchParams.get("t") !== TOKEN) return json(res, 403, { error: "token" });
      const p = normalize(join(WORKSPACE, decodeURIComponent(url.pathname.slice(7))));
      if (!p.startsWith(PROJECTS + sep) || !existsSync(p) || !statSync(p).isFile()) return json(res, 404, { error: "not found" });
      const size = statSync(p).size;
      const type = MIME[extname(p).toLowerCase()] || "application/octet-stream";
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Number(range[2]) : size - 1;
        res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
        return createReadStream(p, { start, end }).pipe(res);
      }
      res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
      return createReadStream(p).pipe(res);
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    const token = req.headers["x-studio-token"] || url.searchParams.get("t");
    if (token !== TOKEN) return json(res, 403, { error: "Token không hợp lệ — tải lại trang." });

    if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, { options: OPTIONS, keys: keyStatus(), workspace: WORKSPACE });
    if (req.method === "POST" && url.pathname === "/api/keys") {
      const body = JSON.parse(await readBody(req, 64 * 1024));
      for (const k of KEY_NAMES) if (typeof body[k] === "string" && body[k].trim()) writeEnvKey(k, body[k].trim());
      return json(res, 200, { keys: keyStatus() });
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") return json(res, 200, [...jobs.values()].map((j) => j.meta).sort((a, b) => b.created.localeCompare(a.created)));
    if (req.method === "POST" && url.pathname === "/api/jobs") return json(res, 200, createJob(JSON.parse(await readBody(req))));
    const m = /^\/api\/jobs\/([\w-]+)(\/events|\/cancel|\/resume|\/log)?$/.exec(url.pathname);
    if (m && jobs.has(m[1])) {
      const j = jobs.get(m[1]);
      if (m[2] === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ status: j.meta })}\n\n`);
        const past = existsSync(logFile(m[1])) ? readFileSync(logFile(m[1]), "utf8").split("\n").filter(Boolean) : [];
        for (const line of past.slice(-400)) res.write(`data: ${JSON.stringify({ line })}\n\n`);
        j.clients.add(res);
        req.on("close", () => j.clients.delete(res));
        return;
      }
      if (m[2] === "/resume" && req.method === "POST") return json(res, 200, resumeJob(m[1], JSON.parse((await readBody(req, 64 * 1024)) || "{}")));
      if (m[2] === "/cancel" && req.method === "POST") {
        const qi = queue.indexOf(m[1]);
        if (qi >= 0) queue.splice(qi, 1);
        setStatus(m[1], { status: "cancelled" });
        if (j.proc) try { process.kill(-j.proc.pid, "SIGTERM"); } catch {}
        log(m[1], "✖ Đã huỷ theo yêu cầu.");
        return json(res, 200, j.meta);
      }
      return json(res, 200, j.meta);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: redact(e.message) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Motion Video Studio → http://127.0.0.1:${PORT}   (workspace: ${WORKSPACE})`);
});
