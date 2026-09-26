// Switches index.html to one output format by rewriting the root size and data-format.
// The composition reads data-format and applies its LAYOUT table for that format before any tween.
// Usage: node scripts/set-format.mjs <16:9|9:16|1:1|4:5>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FORMATS = {
  "16:9": { key: "16x9", w: 1920, h: 1080, resolution: "landscape" },
  "9:16": { key: "9x16", w: 1080, h: 1920, resolution: "portrait" },
  "1:1": { key: "1x1", w: 1080, h: 1080, resolution: "square" },
  "4:5": { key: "4x5", w: 1080, h: 1350, resolution: "portrait" },
};

export function setFormat(root, aspect) {
  const f = FORMATS[aspect];
  if (!f) throw new Error(`format must be one of ${Object.keys(FORMATS).join(", ")}`);
  const file = join(root, "index.html");
  let html = readFileSync(file, "utf8");
  // the studio may prepend data-hf-id attributes, so match id anywhere in the tag
  html = html.replace(/<div\b[^>]*?\bid="root"[^>]*>/, (tag) => {
    let t = tag.replace(/data-width="\d+"/, `data-width="${f.w}"`).replace(/data-height="\d+"/, `data-height="${f.h}"`);
    t = /data-format="/.test(t) ? t.replace(/data-format="[^"]*"/, `data-format="${f.key}"`) : t.replace(/>$/, ` data-format="${f.key}">`);
    return t;
  });
  html = html.replace(/(<html\b[^>]*?data-resolution=")[^"]*"/, `$1${f.resolution}"`);
  html = html.replace(/<meta name="viewport" content="width=\d+, height=\d+">/, `<meta name="viewport" content="width=${f.w}, height=${f.h}">`);
  writeFileSync(file, html);
  return f;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const f = setFormat(root, process.argv[2] || "16:9");
  console.log(`index.html -> ${process.argv[2] || "16:9"} (${f.w}x${f.h}, data-format="${f.key}")`);
}
