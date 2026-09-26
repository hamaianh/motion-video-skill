# Providers and API keys

Every new video starts by confirming one provider per group. The choice is saved in
`<project>/data/providers.json` (no secrets); keys live only in `~/.multix/.env` (mode 600).
The pipeline scripts read `providers.json` through `scripts/multix-lib.mjs`.

## The seven groups

| # | Group | Options (`--set` id) | Key | Watch out |
|---|---|---|---|---|
| 1 | Giọng đọc (TTS) | `gemini` (3.8 Flash TTS), `gemini-lite`, `elevenlabs` (eleven_v3), `openai` (gpt-4o-mini-tts), `fal` (ElevenLabs eleven_v3 via fal) | GEMINI / ELEVENLABS / OPENAI / FAL | Gemini Free tier: 3 TTS requests/min and 10/day. ElevenLabs Free cannot use library voices via API (402). `fal` avoids both, billed from the fal balance. ElevenLabs voices take no style prompt. |
| 2 | Hiệu ứng âm thanh (SFX) | `elevenlabs`, `fal` (fal-ai/elevenlabs/sound-effects/v2) | ELEVENLABS / FAL | ElevenLabs key needs the Sound Effects permission. |
| 3 | Nhạc nền (Music) | `elevenlabs`, `fal` (fal-ai/elevenlabs/music), `file` | ELEVENLABS / FAL / — | ElevenLabs Music API is paid-plan only (Free answers 402). `file` = your own licensed track at `assets/audio/music/bgm-raw.mp3` (+ `outro-raw.mp3`). |
| 4 | Căn thời gian từng từ | `elevenlabs` (forced alignment) | ELEVENLABS | Required; the key needs the Forced Alignment permission. |
| 5 | Hình ảnh / nhân vật | `file`, `gemini`, `openai`, `codex`, `fal` (model id, e.g. fal-ai/flux/dev) | — / GEMINI / OPENAI / — / FAL | Gemini Free tier has an image quota of 0 (enable billing). `codex` uses the logged-in Codex CLI and its account quota. |
| 6 | Kích thước video xuất | `16:9`, `9:16`, `1:1`, `4:5` (one) | — | One run renders exactly one video in this format. |
| 7 | Ngôn ngữ video | `lang=en/vi`, `vi/vi`, `en/en`, `vi/en`, `en/none`, `vi/none` (voice/captions) | — | On-screen text follows the voice language (`data-vi`). |

## Group 6: video output format

Not a provider: the one format this project renders — `16:9` (1920×1080), `9:16` (1080×1920,
TikTok/Reels/Shorts), `1:1` (1080×1080, feed) or `4:5` (1080×1350, feed). Saved as
`output.format`; set with `--set format=9:16`. `render-formats.mjs` renders only that video.
Author the composition for that format directly (see `composition-contract.md` → Output formats);
`--formats=16:9,1:1` renders extra formats only when a `LAYOUT` table for them exists.

## Group 7: video language

Voice language `en` or `vi`, caption language `vi`, `en` or `none`; saved as `language`
(`--set lang=vi/vi`). The voice speaks `line.vi` (or `say_vi`) / `line.en` (or `say`) from
`data/script.json`, the style prompt gets a "speak Vietnamese" suffix, and captions use the
chosen line field (1:1 word timing when voice and captions share a language). On-screen text
follows the voice language through `data-vi` attributes. Changing the voice language
regenerates every VO clip and alignment (a `.lang` marker detects it); prefer a separate
project per language edition so the first one stays untouched.

## Image aspect ratio

Pick a default for group 5: `9:16`, `16:9`, `1:1`, `4:3` or `3:4` (saved as `image.aspect`,
set with `--set aspect=9:16`). Precedence: `generate-images.mjs --aspect=…` > the image's own
`"aspect"` in `data/images.json` > `image.aspect` > `3:4`.

| Aspect | Gemini | fal.ai | OpenAI / Codex |
|---|---|---|---|
| 9:16 | exact | `portrait_16_9` | 1024×1536 (2:3, nearest) |
| 16:9 | exact | `landscape_16_9` | 1536×1024 (3:2, nearest) |
| 1:1 | exact | `square_hd` | 1024×1024 |
| 4:3 | exact | `landscape_4_3` | 1536×1024 (3:2, nearest) |
| 3:4 | exact | `portrait_4_3` | 1024×1536 (2:3, nearest) |

This is the size of generated stills only; the video frame stays 1920×1080. Portraits for comic
panels work best at 3:4 or 9:16, key art at 16:9.

## How the agent runs this step

1. `node <skill>/scripts/setup-providers.mjs <project> --show` prints the current choice per group
   and which keys are set or missing (never values). Exit code 2 = a key is missing.
2. Ask the user one question per group (AskUserQuestion, max 4 questions per call, so two calls; ask the image aspect with group 5),
   showing the "Watch out" notes above. Then save with
   `node <skill>/scripts/setup-providers.mjs <project> --set voice=gemini sfx=elevenlabs music=fal align=elevenlabs image=file`
   (`group=option:model` overrides the model, e.g. `image=fal:fal-ai/flux-pro/v1.1`).
3. If `--show` reports a missing key, ask the user to run, **in their own terminal** (not with `!`,
   the prompt is interactive): `node <skill>/scripts/setup-providers.mjs <project> --keys`.
   Keys are typed hidden. The plain interactive mode (no flag) walks through groups and keys together.
4. Re-run `--show` until nothing is missing, then continue with the pipeline.

Never ask for keys in chat, never echo them, never write them into project files. If a user pastes
a key into the chat anyway, store it in `~/.multix/.env` without printing it and tell them to rotate it.

## Errors and what they mean

| Error | Meaning | Fix |
|---|---|---|
| `429 … limit: 3 requests per minute on Free Tier` | Gemini TTS free tier | Wait (auto-retry) or enable billing |
| `429 … limit: 0, model: …-image` | Gemini image on free tier | Enable billing, or pick another image provider |
| `401 missing the permission sound_generation / music_generation / forced_alignment` | Scoped ElevenLabs key | New key with that permission |
| `402 paid_plan_required` (ElevenLabs music) | Free ElevenLabs plan | Paid plan, or music via `fal` / `file` |
| `403 User is locked. Exhausted balance` (fal) | fal.ai balance empty | Top up at fal.ai/dashboard/billing |
| `429 … 10 requests per day` (Gemini TTS) | Gemini free-tier daily cap | Wait for the reset, bill the project, or switch voice to `fal` and regenerate every clip |
| `402 Free users cannot use library voices via the API` | ElevenLabs Free + library voice | Paid plan, or voice via `fal` |
| fal music `422` with `force_instrumental` / sections < 3000 ms | fal ElevenLabs Music limits | Handled by `generate-audio-assets.mjs` (flag dropped, sections clamped to 3 s) |
