// Generates the still images a composition uses (characters, key art) from data/images.json,
// with the image provider chosen in data/providers.json:
//   gemini (Nano Banana, needs a billed project) | openai (gpt-image) | codex (logged-in Codex CLI) | fal | file
// images.json: { "style": "shared style suffix", "images": [{ "id": "hero", "prompt": "...", "aspect": "3:4" }] }
// Aspect ratio, first match wins: --aspect=9:16 flag > the image's "aspect" > providers.json image.aspect > 3:4.
// Supported: 9:16, 16:9, 1:1, 4:3, 3:4 (OpenAI only has 1024², 1536×1024, 1024×1536, so it rounds to the nearest).
// Output: assets/chars/<id>.png. With provider "file", it only checks that the files are there.
// Usage: node scripts/generate-images.mjs [--force] [--only=id1,id2] [--aspect=9:16|16:9|1:1|4:3|3:4]
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fal, ffmpegCopy, loadProviders, multix, root, workDir } from "./multix-lib.mjs";

const spec = JSON.parse(readFileSync(join(root, "data/images.json"), "utf8"));
const P = loadProviders().image;
const force = process.argv.includes("--force");
const aspectFlag = (process.argv.find((a) => a.startsWith("--aspect=")) || "").slice(9);
const ASPECTS = ["9:16", "16:9", "1:1", "4:3", "3:4"];
if (aspectFlag && !ASPECTS.includes(aspectFlag)) throw new Error(`--aspect must be one of ${ASPECTS.join(", ")}`);
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const dir = join(root, "assets/chars");
mkdirSync(dir, { recursive: true });

// provider-specific size names for the aspect ratio
const openaiSize = (a) => ({ "16:9": "1536x1024", "4:3": "1536x1024", "1:1": "1024x1024", "9:16": "1024x1536", "3:4": "1024x1536" })[a];
const falSize = (a) => ({ "16:9": "landscape_16_9", "4:3": "landscape_4_3", "1:1": "square_hd", "9:16": "portrait_16_9", "3:4": "portrait_4_3" })[a];

const missing = [];
for (const img of spec.images.filter((i) => !only.length || only.includes(i.id))) {
  const out = join(dir, `${img.id}.png`);
  if (P.provider === "file") {
    if (!existsSync(out)) missing.push(out);
    continue;
  }
  if (existsSync(out) && !force) {
    console.log(`skip image ${img.id}`);
    continue;
  }
  const prompt = spec.style ? `${img.prompt}, ${spec.style}` : img.prompt;
  const aspect = aspectFlag || img.aspect || P.aspect || "3:4";
  if (!ASPECTS.includes(aspect)) throw new Error(`${img.id}: aspect "${aspect}" not in ${ASPECTS.join(", ")}`);
  if ((P.provider === "openai" || P.provider === "codex") && ["16:9", "9:16", "4:3", "3:4"].includes(aspect)) console.log(`note: OpenAI has no exact ${aspect}; using ${openaiSize(aspect)}`);
  if (P.provider === "gemini") {
    const m = P.model ? ["--model", P.model] : [];
    await multix(["gemini", "generate", "--prompt", prompt, ...m, "--aspect-ratio", aspect, "--size", "2K", "--no-webp", "--output", out]);
  } else if (P.provider === "openai" || P.provider === "codex") {
    await multix(["openai", "generate", "--prompt", prompt, "--driver", P.provider === "codex" ? "codex" : "api", "-m", P.model || "gpt-image-2", "--size", openaiSize(aspect), "--quality", "high", "--no-webp", "--output", out]);
  } else if (P.provider === "fal") {
    const tmp = join(workDir, `${img.id}-${Date.now()}.img`);
    await multix(["fal", "image", prompt, "-m", P.model || "fal-ai/flux/dev", "--image-size", falSize(aspect), "--no-webp", "--output", tmp]);
    await ffmpegCopy(tmp, out);
    rmSync(tmp, { force: true });
  } else throw new Error(`image provider "${P.provider}" is not supported`);
  console.log(`image ${img.id} -> ${out} (${P.provider})`);
}
if (missing.length) {
  console.error(`image provider "file": missing\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
