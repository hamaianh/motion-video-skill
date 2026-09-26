// Generates voice-over, sound effects and background music through the multix CLI,
// using the providers chosen in data/providers.json (see <skill>/scripts/setup-providers.mjs):
//   voice: gemini | elevenlabs | openai | fal      sfx: elevenlabs | fal      music: elevenlabs | fal | file
// Run scripts/arrange-music.mjs afterwards to put the music's drops on the video's beats.
// Usage: node scripts/generate-audio-assets.mjs <vo|sfx|music|all> [--force] [--only=id1,id2]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fal, ffmpegCopy, loadProviders, multix, pool, root, spokenText, workDir } from "./multix-lib.mjs";

const script = JSON.parse(readFileSync(join(root, "data/script.json"), "utf8"));
const sfxSpec = JSON.parse(readFileSync(join(root, "data/sfx.json"), "utf8"));
const P = loadProviders();
const args = process.argv.slice(2);
const mode = args[0] || "all";
const force = args.includes("--force");
const only = (args.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);

async function speak(text, style, out) {
  const v = P.voice;
  const model = v.model || script.voice.model;
  const voice = v.voice || script.voice.voice;
  if (v.provider === "gemini") {
    await multix(["gemini", "generate-speech", "--model", model, "--voice", voice, "--style", style, "--text", text, "--output", out]);
  } else if (v.provider === "openai") {
    await multix(["openai", "generate-speech", "--model", model, "--voice", voice, "--instructions", style, "--output-format", "wav", "--text", text, "--output", out]);
  } else if (v.provider === "elevenlabs") {
    // ElevenLabs takes no sentence-style direction; the delivery comes from the voice itself.
    const mp3 = join(workDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
    await multix(["elevenlabs", "tts", "--model", model, "--voice", voice, "--format", "mp3_44100_192", "--text", text, "--output", mp3]);
    await ffmpegCopy(mp3, out);
    rmSync(mp3, { force: true });
  } else if (v.provider === "fal") {
    // ElevenLabs v3 billed through fal.ai: no free-tier voice-library limits; no sentence-style direction
    await fal(model || "fal-ai/elevenlabs/tts/eleven-v3", { text, voice, ...(P.language.voice === "vi" ? { language_code: "vi" } : {}) }, out);
  } else throw new Error(`voice provider "${v.provider}" is not supported`);
}

async function genVo() {
  const dir = join(root, "assets/audio/vo");
  mkdirSync(dir, { recursive: true });
  const scenes = script.scenes.filter((s) => !only.length || only.includes(s.id));
  // clips spoken in another language are stale: regenerate them all when the voice language changes
  const marker = join(dir, ".lang");
  const stale = existsSync(marker) && readFileSync(marker, "utf8").trim() !== P.language.voice;
  if (stale) console.log(`voice language changed to ${P.language.voice}: regenerating every clip`);
  // one request at a time: free tiers rate-limit TTS per minute
  await pool(scenes, P.voice.provider === "gemini" ? 1 : 3, async (s) => {
    const out = join(dir, `${s.id}.wav`);
    if (existsSync(out) && !force && !stale) return console.log(`skip vo ${s.id}`);
    const lang = P.language.voice;
    const text = s.lines.map((l) => spokenText(l, lang)).join(" ");
    // style prompts are written in English; tell the narrator which language to speak
    const style = (s.outro ? script.outroStyle : script.voice.style) + (lang === "vi" ? " Speak natural, fluent Vietnamese." : "");
    await speak(text, style, out);
    console.log(`vo ${s.id} -> ${out} (${P.voice.provider}, ${lang})`);
  });
  writeFileSync(marker, P.language.voice);
}

async function genSfx() {
  const dir = join(root, "assets/audio/sfx");
  mkdirSync(dir, { recursive: true });
  const list = sfxSpec.filter((s) => !only.length || only.includes(s.id));
  await pool(list, 4, async (s) => {
    const out = join(dir, `${s.id}.mp3`);
    if (existsSync(out) && !force) return console.log(`skip sfx ${s.id}`);
    if (P.sfx.provider === "elevenlabs") {
      await multix(["elevenlabs", "sfx", "--text", s.prompt, "--duration-seconds", s.duration, "--prompt-influence", "0.6", "--output", out]);
    } else if (P.sfx.provider === "fal") {
      await fal(P.sfx.model || "fal-ai/elevenlabs/sound-effects/v2", { text: s.prompt, duration_seconds: s.duration, prompt_influence: 0.6, output_format: "mp3_44100_128" }, out);
    } else throw new Error(`sfx provider "${P.sfx.provider}" is not supported`);
    console.log(`sfx ${s.id} -> ${out} (${P.sfx.provider})`);
  });
}

async function composeMusic(plan, file) {
  const out = join(root, "assets/audio/music", file);
  if (P.music.provider === "file") {
    if (!existsSync(out)) throw new Error(`music provider "file": put your licensed track at ${out}`);
    return console.log(`music ${file}: using the supplied file`);
  }
  if (existsSync(out) && !force) return console.log(`skip music ${file}`);
  if (P.music.provider === "elevenlabs") {
    const log = await multix(["elevenlabs", "music", "--plan", join(root, "data", plan), "--format", "mp3_44100_192", "--output", out, "--verbose"]);
    console.log(log.split("\n").slice(-6).join("\n"));
  } else if (P.music.provider === "fal") {
    const compositionPlan = JSON.parse(readFileSync(join(root, "data", plan), "utf8"));
    // fal rejects sections shorter than 3 s and refuses force_instrumental together with a plan
    // (the plan's negative styles already exclude vocals)
    for (const s of compositionPlan.sections || []) s.duration_ms = Math.max(3000, s.duration_ms || 3000);
    await fal(P.music.model || "fal-ai/elevenlabs/music", { composition_plan: compositionPlan, respect_sections_durations: true, output_format: "mp3_44100_192" }, out);
    console.log(`music ${file} -> ${out} (fal)`);
  } else throw new Error(`music provider "${P.music.provider}" is not supported`);
}

// The main track fades out before the ending, so the calm outro bed is a separate composition.
async function genMusic() {
  mkdirSync(join(root, "assets/audio/music"), { recursive: true });
  await composeMusic("music-plan.json", "bgm-raw.mp3");
  // short ads without a calm ending simply have no outro-plan.json
  if (existsSync(join(root, "data/outro-plan.json"))) await composeMusic("outro-plan.json", "outro-raw.mp3");
}

const jobs = { vo: genVo, sfx: genSfx, music: genMusic };
for (const [name, job] of Object.entries(jobs)) {
  if (mode === "all" || mode === name) await job();
}
