#!/usr/bin/env node
// Chooses the AI provider/model for each production group and stores the API keys multix needs.
// Choices (no secrets) -> <project>/data/providers.json. Keys -> ~/.multix/.env (mode 600), never printed.
//
//   node <skill>/scripts/setup-providers.mjs [project]            interactive: every group, then the keys it needs
//   node <skill>/scripts/setup-providers.mjs [project] --keys     interactive: only the keys for the current choices
//   node <skill>/scripts/setup-providers.mjs [project] --show     print choices + which keys are set/missing (safe for agents)
//   node <skill>/scripts/setup-providers.mjs [project] --set voice=gemini music=fal image=gemini aspect=9:16 format=16:9,9:16 ...
//
// Run the interactive modes in your own terminal: keys are typed hidden and never pass through a chat.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

// ---------- provider catalog, grouped so nothing is forgotten ----------
const GROUPS = [
  {
    id: "voice",
    title: "1. Giọng đọc (Voice-over / TTS)",
    options: [
      { id: "gemini", label: "Gemini 3.8 Flash TTS", set: { provider: "gemini", model: "gemini-3.8-flash-tts", voice: "Fenrir" }, keys: ["GEMINI_API_KEY"], note: "Nhận style prompt (hype, keynote…). Gói Free chỉ 3 request/phút: script tự chờ và thử lại." },
      { id: "gemini-lite", label: "Gemini 3.8 Flash Lite TTS", set: { provider: "gemini", model: "gemini-3.8-flash-lite-tts", voice: "Fenrir" }, keys: ["GEMINI_API_KEY"], note: "Nhanh/rẻ hơn, ít biểu cảm hơn." },
      { id: "elevenlabs", label: "ElevenLabs TTS (eleven_v3)", set: { provider: "elevenlabs", model: "eleven_v3", voice: "kdmDKE6EkgrWrrykO9Qt" }, keys: ["ELEVENLABS_API_KEY"], note: "Key cần quyền Text to Speech. Không nhận style prompt; đổi voice id để đổi chất giọng." },
      { id: "openai", label: "OpenAI gpt-4o-mini-tts", set: { provider: "openai", model: "gpt-4o-mini-tts", voice: "marin" }, keys: ["OPENAI_API_KEY"], note: "Style truyền qua --instructions." },
    ],
  },
  {
    id: "sfx",
    title: "2. Hiệu ứng âm thanh (SFX)",
    options: [
      { id: "elevenlabs", label: "ElevenLabs Sound Effects (trực tiếp)", set: { provider: "elevenlabs" }, keys: ["ELEVENLABS_API_KEY"], note: "Key cần quyền Sound Effects (sound_generation)." },
      { id: "fal", label: "ElevenLabs Sound Effects qua fal.ai", set: { provider: "fal", model: "fal-ai/elevenlabs/sound-effects/v2" }, keys: ["FAL_KEY"], note: "Trả theo lượt trên fal.ai; tài khoản phải còn số dư." },
    ],
  },
  {
    id: "music",
    title: "3. Nhạc nền (Music)",
    options: [
      { id: "elevenlabs", label: "ElevenLabs Music (trực tiếp)", set: { provider: "elevenlabs" }, keys: ["ELEVENLABS_API_KEY"], note: "CHỈ gói trả phí (Free trả 402) + key có quyền Music (music_generation)." },
      { id: "fal", label: "ElevenLabs Music qua fal.ai", set: { provider: "fal", model: "fal-ai/elevenlabs/music" }, keys: ["FAL_KEY"], note: "Nhận composition plan, giữ đúng độ dài section. Cần số dư fal.ai." },
      { id: "file", label: "File nhạc có sẵn (tự cung cấp)", set: { provider: "file" }, keys: [], note: "Đặt bgm-raw.mp3 (+ outro-raw.mp3) vào assets/audio/music/. Phải có bản quyền dùng cho quảng cáo nếu chạy ads." },
    ],
  },
  {
    id: "align",
    title: "4. Căn thời gian từng từ (phụ đề karaoke, cue SFX)",
    options: [
      { id: "elevenlabs", label: "ElevenLabs Forced Alignment", set: { provider: "elevenlabs" }, keys: ["ELEVENLABS_API_KEY"], note: "Bắt buộc cho pipeline. Key cần quyền Forced Alignment." },
    ],
  },
  {
    id: "image",
    title: "5. Hình ảnh / nhân vật (Image generation)",
    options: [
      { id: "file", label: "Ảnh có sẵn (tự cung cấp)", set: { provider: "file" }, keys: [], note: "Bỏ ảnh vào assets/chars/<id>.png theo data/images.json." },
      { id: "gemini", label: "Gemini Nano Banana / Imagen", set: { provider: "gemini" }, keys: ["GEMINI_API_KEY"], note: "Gói Free có hạn mức ảnh = 0: phải bật billing cho project Gemini." },
      { id: "openai", label: "OpenAI gpt-image-2", set: { provider: "openai", model: "gpt-image-2" }, keys: ["OPENAI_API_KEY"], note: "Trả theo ảnh qua OpenAI API." },
      { id: "codex", label: "OpenAI qua Codex CLI (đã đăng nhập)", set: { provider: "codex", model: "gpt-image-2" }, keys: [], note: "Thử nghiệm; dùng hạn mức tài khoản ChatGPT/Codex. Cần `codex login` trước." },
      { id: "fal", label: "fal.ai (Flux… nhập model id)", set: { provider: "fal", model: "fal-ai/flux/dev" }, keys: ["FAL_KEY"], note: "Model id đổi được, vd fal-ai/flux-pro/v1.1. Cần số dư fal.ai.", askModel: true },
    ],
  },
];

// Group 6 is not a provider: the video formats render-formats.mjs renders (one composition, one LAYOUT per format).
const FORMATS = [
  { id: "16:9", label: "16:9 ngang — 1920×1080", note: "YouTube, web, màn hình ngang." },
  { id: "9:16", label: "9:16 dọc — 1080×1920", note: "TikTok, Reels, Shorts, Stories. Chừa vùng UI: trên ~220 px, dưới ~420 px." },
  { id: "1:1", label: "1:1 vuông — 1080×1080", note: "Feed Facebook/Instagram, quảng cáo carousel." },
  { id: "4:5", label: "4:5 dọc — 1080×1350", note: "Feed Instagram/Facebook, chiếm nhiều màn hình nhất trong feed." },
];

// Image aspect ratios every image provider can serve (OpenAI rounds to its nearest size).
const ASPECTS = ["9:16", "16:9", "1:1", "4:3", "3:4"];

const KEY_HELP = {
  GEMINI_API_KEY: "https://aistudio.google.com/apikey",
  ELEVENLABS_API_KEY: "https://elevenlabs.io/app/settings/api-keys (bật: Text to Speech, Sound Effects, Music, Forced Alignment)",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
  FAL_KEY: "https://fal.ai/dashboard/keys (nạp số dư ở /dashboard/billing)",
};

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const sets = argv.filter((a) => /^\w+=/.test(a));
const project = resolve(argv.find((a) => !a.startsWith("--") && !/^\w+=/.test(a)) || process.cwd());
const provFile = join(project, "data/providers.json");
const envFile = join(homedir(), ".multix/.env");

// ---------- storage ----------
const readProviders = () => (existsSync(provFile) ? JSON.parse(readFileSync(provFile, "utf8")) : {});
function writeProviders(p) {
  mkdirSync(join(project, "data"), { recursive: true });
  writeFileSync(provFile, JSON.stringify(p, null, 2) + "\n");
}
function readEnv() {
  if (!existsSync(envFile)) return {};
  return Object.fromEntries(
    readFileSync(envFile, "utf8").split("\n").filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
  );
}
function writeEnvKey(name, value) {
  mkdirSync(join(homedir(), ".multix"), { recursive: true });
  const lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith(`${name}=`)) : [];
  lines.push(`${name}=${value}`);
  writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(envFile, 0o600);
}
const optionOf = (g, choice) => g.options.find((o) => choice && o.set.provider === choice.provider && (!o.set.model || !choice.model || o.set.model === choice.model)) || null;
const neededKeys = (p) => [...new Set(GROUPS.flatMap((g) => optionOf(g, p[g.id])?.keys || []))];
const hint = (v) => (v ? `đã có (…${v.slice(-4)})` : "CHƯA CÓ");

// ---------- modes ----------
function show() {
  const p = readProviders();
  const env = { ...readEnv(), ...process.env };
  console.log(`Project: ${project}`);
  for (const g of GROUPS) {
    const o = optionOf(g, p[g.id]);
    const model = p[g.id]?.model ? ` · ${p[g.id].model}` : "";
    const aspect = g.id === "image" && p.image?.aspect ? ` · tỉ lệ ${p.image.aspect}` : "";
    console.log(`  ${g.title}\n     → ${o ? o.label : p[g.id] ? JSON.stringify(p[g.id]) : "(chưa chọn — dùng mặc định)"}${model}${aspect}`);
  }
  const fm = p.output?.formats || ["16:9"];
  console.log(`  6. Kích thước video xuất\n     → ${fm.map((id) => FORMATS.find((f) => f.id === id)?.label || id).join(" · ")}`);
  const keys = neededKeys(p);
  console.log(`\nKey cần cho lựa chọn hiện tại (${envFile}):`);
  if (!keys.length) console.log("  (không cần key)");
  for (const k of keys) console.log(`  ${env[k] ? "✓" : "✗"} ${k} ${env[k] ? "đã đặt" : "THIẾU"}`);
  const missing = keys.filter((k) => !env[k]);
  process.exitCode = missing.length ? 2 : 0;
}

function applySets() {
  const p = readProviders();
  for (const s of sets) {
    const [group, value] = s.split("=");
    if (group === "format") {
      const list = value.split(",").filter(Boolean);
      const bad = list.filter((x) => !FORMATS.some((f) => f.id === x));
      if (!list.length || bad.length) throw new Error(`format must be a comma list of ${FORMATS.map((f) => f.id).join(", ")}`);
      p.output = { formats: list };
      continue;
    }
    if (group === "aspect") {
      if (!ASPECTS.includes(value)) throw new Error(`aspect must be one of ${ASPECTS.join(", ")}`);
      p.image = { ...(p.image || { provider: "file" }), aspect: value };
      continue;
    }
    const g = GROUPS.find((x) => x.id === group);
    if (!g) throw new Error(`unknown group "${group}" (${GROUPS.map((x) => x.id).join(", ")})`);
    const [id, model] = value.split(":");
    const o = g.options.find((x) => x.id === id);
    if (!o) throw new Error(`unknown option "${id}" for ${group} (${g.options.map((x) => x.id).join(", ")})`);
    p[group] = { ...o.set, ...(model ? { model } : {}), ...(group === "image" && p.image?.aspect ? { aspect: p.image.aspect } : {}) };
  }
  writeProviders(p);
  show();
}

// hidden input: echo "*" instead of the typed characters
function askHidden(rl, q) {
  return new Promise((ok) => {
    const out = rl._writeToOutput;
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(q) ? s : s.replace(/[^\r\n]/g, "*"));
    rl.question(q, (a) => {
      rl._writeToOutput = out;
      rl.output.write("\n");
      ok(a.trim());
    });
  });
}

async function interactive(keysOnly) {
  if (!process.stdin.isTTY) {
    console.error("Cần chạy trong terminal của bạn (không chạy qua chat/agent): node setup-providers.mjs [project]");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((ok) => rl.question(q, (a) => ok(a.trim())));
  const p = readProviders();
  if (!keysOnly) {
    console.log(`\n=== Chọn provider cho project: ${project} ===\n(Enter = giữ lựa chọn hiện tại)\n`);
    for (const g of GROUPS) {
      const cur = optionOf(g, p[g.id]);
      console.log(`\n${g.title}`);
      g.options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${cur === o ? "  [đang chọn]" : ""}\n       ${o.note}${o.keys.length ? `  · key: ${o.keys.join(", ")}` : ""}`));
      const def = cur ? g.options.indexOf(cur) + 1 : 1;
      const a = g.options.length === 1 ? "1" : await ask(`  Chọn [${def}]: `);
      const o = g.options[(parseInt(a, 10) || def) - 1] || g.options[def - 1];
      const prevAspect = p[g.id]?.aspect;
      p[g.id] = { ...o.set };
      if (o.askModel) {
        const m = await ask(`  Model id [${p[g.id].model}]: `);
        if (m) p[g.id].model = m;
      }
      if (g.id === "image" && o.set.provider !== "file") {
        const cur = ASPECTS.indexOf(prevAspect || "3:4") + 1;
        console.log(`  Tỉ lệ ảnh mặc định: ${ASPECTS.map((a, i) => `${i + 1}) ${a}`).join("  ")}`);
        const a = await ask(`  Chọn [${cur}]: `);
        p[g.id].aspect = ASPECTS[(parseInt(a, 10) || cur) - 1] || ASPECTS[cur - 1];
      }
    }
    const curF = p.output?.formats || ["16:9"];
    console.log(`\n6. Kích thước video xuất (chọn một hoặc nhiều, vd 1,2)`);
    FORMATS.forEach((f, i) => console.log(`  ${i + 1}) ${f.label}${curF.includes(f.id) ? "  [đang chọn]" : ""}\n       ${f.note}`));
    const defF = curF.map((id) => FORMATS.findIndex((f) => f.id === id) + 1).filter(Boolean).join(",");
    const af = await ask(`  Chọn [${defF}]: `);
    const picked = (af || defF).split(/[,\s]+/).map((x) => FORMATS[parseInt(x, 10) - 1]?.id).filter(Boolean);
    p.output = { formats: [...new Set(picked.length ? picked : curF)] };
    writeProviders(p);
    console.log(`\n✓ Đã lưu lựa chọn vào ${provFile}`);
  }
  const env = readEnv();
  const keys = neededKeys(p);
  console.log(`\n=== API key (lưu ở ${envFile}, quyền 600, không in ra) ===`);
  if (!keys.length) console.log("Lựa chọn hiện tại không cần key.");
  for (const k of keys) {
    console.log(`\n${k}: ${hint(env[k])}\n  Lấy key: ${KEY_HELP[k] || ""}`);
    const v = await askHidden(rl, env[k] ? "  Dán key mới (Enter = giữ key cũ): " : "  Dán key: ");
    if (v) {
      writeEnvKey(k, v);
      console.log(`  ✓ đã lưu ${k} (…${v.slice(-4)})`);
    } else if (!env[k]) console.log(`  ⚠ ${k} vẫn thiếu: bước dùng provider này sẽ lỗi.`);
  }
  rl.close();
  console.log("\nKiểm tra lại: node setup-providers.mjs --show   ·   multix check");
}

if (flags.has("--show")) show();
else if (sets.length) applySets();
else await interactive(flags.has("--keys"));
