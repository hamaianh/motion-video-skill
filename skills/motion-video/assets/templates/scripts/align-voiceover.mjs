// Forced-aligns every voice-over clip against its spoken text (ElevenLabs align via multix)
// and writes data/vo-lines.json: per scene, per line start/end in clip-local seconds.
// Usage: node scripts/align-voiceover.mjs [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProviders, multix, root, spokenText } from "./multix-lib.mjs";

const script = JSON.parse(readFileSync(join(root, "data/script.json"), "utf8"));
const force = process.argv.includes("--force");
const alignDir = join(root, "data/align");
mkdirSync(alignDir, { recursive: true });
// Word timings drive the captions, SFX cues and reveals; only ElevenLabs forced alignment returns them.
const P = loadProviders();
const { provider } = P.align;
if (provider !== "elevenlabs") throw new Error(`align provider "${provider}" is not supported (use elevenlabs)`);
const run = (argv) => multix(argv);

const spoken = (line) => spokenText(line, P.language.voice);
const tokens = (text) => text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));

// alignments of another language are stale
const marker = join(alignDir, ".lang");
const stale = existsSync(marker) && readFileSync(marker, "utf8").trim() !== P.language.voice;
const queue = [...script.scenes];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const s = queue.shift();
      const out = join(alignDir, `${s.id}.json`);
      if (existsSync(out) && !force && !stale) continue;
      const text = s.lines.map(spoken).join(" ");
      await run(["elevenlabs", "align", "--input", join(root, `assets/audio/vo/${s.id}.wav`), "--text", text, "--output", out]);
      console.log(`aligned ${s.id}`);
    }
  }),
);

writeFileSync(marker, P.language.voice);

// Map aligned words back onto script lines by token count (alignment keeps text order).
const result = {};
for (const s of script.scenes) {
  const align = JSON.parse(readFileSync(join(alignDir, `${s.id}.json`), "utf8"));
  const words = align.words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
  let i = 0;
  const lines = s.lines.map((line) => {
    const n = tokens(spoken(line)).length;
    const seg = words.slice(i, i + n);
    i += n;
    return { start: seg[0].start, end: seg[seg.length - 1].end, words: seg.map((w) => ({ t: w.text, s: w.start, e: w.end })) };
  });
  if (i !== words.length) console.warn(`${s.id}: ${words.length} aligned words vs ${i} script tokens`);
  result[s.id] = { speechStart: lines[0].start, speechEnd: lines[lines.length - 1].end, lines };
}
writeFileSync(join(root, "data/vo-lines.json"), JSON.stringify(result, null, 1));
for (const [id, v] of Object.entries(result)) console.log(id, v.speechStart.toFixed(2), v.speechEnd.toFixed(2), v.lines.map((l) => `${l.start.toFixed(2)}-${l.end.toFixed(2)}`).join(" | "));
