# ImageIQ Resizer

STOCK IMAGEIQ local media-downscaler: a processing engine with two entry
points — a CLI and an Electron desktop app. Produces a lowres proxy tree of an
input folder (images ≤1280 px in the format of the original, capture date kept
and all other metadata stripped; videos ≤720p H.264) for metadata processing
with CSV export.

## Packaging

**Mac only for now; Windows later** (we do not release a build without code
signing). The app is signed with the Developer ID, notarised and stapled, so
macOS shows only the "downloaded from the Internet" window (`docs/INSTALL.md`).

```bash
npm run dist:mac                  # Apple silicon: signed, notarised, stapled
npm run package:mac:x64           # Intel, built in ../wt-resizer-x64
npm run release:mac               # both builds → release/upload-<version>/, 7 files
npm run dist:mac:unsigned         # quick local try, not for anyone else
npm run package:mac:x64:unsigned  # the same, Intel
npm run package:win               # build test only, not released
```

Per-arch dmgs instead of universal: see `electron-builder.yml`. ffmpeg is
asarUnpack'd and path-rewritten (`ffmpegPath()`); a startup assertion verifies
every bundled binary and shows an error dialog if missing. `--smoke-test`
checks sharp, ffmpeg and electron-updater in the packaged app (exit code 1 on
failure). CI (`.github/workflows/release.yml`) only runs typecheck and tests;
Windows is packaged there as a test and nothing is kept.

Signed builds need, on the Mac that builds them: the Developer ID Application
certificate in the login keychain (with more than one, `CSC_NAME` says which)
and the App Store Connect API key in the environment, from `.env.signing`
(template: `.env.signing.example`, the same variables as the Mac app; never
committed). `scripts/check-mac-signing.sh` checks all of it before a build.
Entitlements (`build/entitlements.mac.plist`): `allow-jit` and
`allow-unsigned-executable-memory`, which Electron's V8 needs under the
hardened runtime. No `disable-library-validation`: sharp and ffmpeg are signed
with the app, by the same team. Electron fuses as in the Mac app
(`electron-builder.yml`): nothing outside the app can run code inside it.

## Releasing an update (macOS)

The app updates itself from **GitHub Releases of
`stockimageiq1/stockimageiq-resizer-releases`** (public, release files only, no
code; `publish` in `electron-builder.yml`). It checks at start, offers
"Download & Restart", and restarts once no resize is running. An update must be
signed by the same Apple team and keep the app id `com.stockimageiq.resizer`.
Nothing in this repository uploads anything: every build command passes
`--publish never`.

A release, on the owner's Mac, in one Terminal window:

```bash
cd ~/Desktop/IMAGEIQ_CLEAN/resizer_imageIQ_v0
git switch main && git pull --ff-only && npm ci      # the commit to release
set -a; source .env.signing; set +a
bash scripts/check-mac-signing.sh                    # → check-mac-signing: OK
npm run dist:mac                                     # Apple silicon
bash scripts/verify-mac-sign.sh                      # → PASS
"release/mac-arm64/ImageIQ Resizer.app/Contents/MacOS/ImageIQ Resizer" --smoke-test  # → SMOKE OK
npm run package:mac:x64                              # Intel
bash scripts/verify-mac-sign.sh                      # → PASS for both
npm run release:mac                                  # → release/upload-<version>/, 7 files
```

`npm run release:mac` refuses unless both apps are the version in
`package.json`, both pass `verify-mac-sign.sh`, and each zip is the file its
`latest-mac.yml` describes. Then on github.com: the releases repository →
Releases → Draft a new release → tag `v<version>`, title `ImageIQ Resizer
<version>` → drag in all seven files → Save draft → check the list → Publish
release. A draft is invisible to the app; once published, installed apps see it
at their next start, and `…/releases/latest/download/ImageIQ-Resizer-mac-arm64.dmg`
(or `-x64.dmg`) gives the new files. File names never carry the version, so the
links stay.

## Desktop app

- `npm run dev` — Electron + vite dev mode (HMR)
- `npm run build:app && npm start` — production build + launch
- Engine runs in the main process; renderer is sandboxed
  (contextIsolation, no nodeIntegration) and talks only through the typed
  `window.iqShrink` bridge defined in `src/shared/ipc.ts`.
- Sidebar navigation (New Run / Settings). New Run: drag a single
  folder (or Choose Folder…) → preview with count chips + size, an in-flow
  "Save to" choice (next to source / custom location, "Remember this choice"
  persists it) and a per-run ZIP toggle → Resize now → live
  progress (weighted bar, active-video percent, ETA) → done screen with size
  headline and Show in Folder. Cancel kills the active ffmpeg encode and
  deletes the partial output. Collisions offer Overwrite / Keep Both / Cancel
  (Keep Both writes `{name}_lowres_2`, `_3`, …).
- Settings page: image max dimension (256–4096, default 1280), JPEG
  and WebP quality (40–95, default 92), video max height (240–2160, default 720), CRF
  (18–35, default 27), keep audio (default off), hardware acceleration
  (default on), create-zip default, default output location. Persisted in
  userData; main clamps ranges; changes apply to the next run.
  Reset-to-defaults on the page.
- Light + dark theme via system preference; STOCK IMAGEIQ design tokens in
  `src/renderer/src/tokens.css`. ALL user-facing strings
  (renderer + native dialogs) live in `src/shared/strings.ts` — a Slovenian
  translation is a single-file change.

**Key invariant:** every output file keeps its **exact original name including
extension** — the downstream CSV is keyed by file name and must match the
originals when uploading to stock photo/video sites — and is encoded in the
format that extension names, because the server refuses a file whose bytes do
not match its extension (415, and the whole batch with it). `small.png` is a
PNG, `a.tiff` a TIFF; videos are re-encoded into a container matching their
original extension. Folder names (semantic context for the SaaS) are preserved
exactly. The one exception: HEIC/HEIF copies are JPEGs named `.jpg`, because
the web app does not take HEIC; if that name is already taken in the folder the
HEIC is copied unprocessed and reported instead of overwriting.

**Iron rule:** originals are never written to. The output tree is a sibling
folder `{inputName}_lowres`; the engine refuses any output location that is,
contains, or is inside the input folder.

## CLI

```
iq-shrink <input-folder> [--zip] [--out <path>] [--overwrite]
```

- Existing output folder (or zip) aborts unless `--overwrite`, which deletes
  and recreates it — never merges into stale contents.
- `--zip` creates `{inputName}_lowres.zip` next to the output folder. The root
  folder **inside** the zip is the original input name (no `_lowres` leak).
- Files that can't be processed (corrupt, unsupported codec, HEIC without
  decoder) are copied unchanged into the output tree and reported — never
  skipped silently, never abort the run.
- Exit 0 when everything was processed or copied; exit 1 only for run-level
  failures (bad input, output collision, insufficient disk).

Local dev: `npm run build && node dist/src/cli.js <folder> --zip`

## Engine (library — consumed by both the CLI and the desktop app)

```ts
import { runShrink, ShrinkSummary, ProgressEvent } from 'iq-shrink';

const summary = await runShrink({
  inputDir: '/path/to/Client Shoot 2026',
  zip: true,               // default false
  overwrite: false,        // default false
  // outDir: custom path   // default: sibling "{inputName}_lowres"
  // imageConcurrency: 4   // videos always run 1 at a time, alongside images
  onProgress: (e: ProgressEvent) => { /* drive a GUI progress bar */ },
});
```

No console I/O in the engine; all feedback flows through `onProgress`:
`scan` → `file-start` / `video-progress{percent}` / `file-done{outcome}` →
`zip-start` / `zip-done`. Run-level failures throw `ShrinkError` with a typed
`code` (`INPUT_NOT_FOUND | INPUT_NOT_DIRECTORY | OUTPUT_EXISTS |
UNSAFE_OUTPUT | INSUFFICIENT_DISK | CANCELLED`).

`ShrinkSummary`: `imagesProcessed`, `videosProcessed`, `encoderUsage`,
`copiedUnprocessed[{relPath, reason}]`, `inputBytes`, `outputBytes`,
`percentSaved`, `elapsedMs`, `outputPath`, `zipPath?`.

Also exported: `engineCapabilities()`, `heicSupported()`, `ffmpegPath()`,
and `encoderArgs(crf, encoder)` — the one place encoder/rate-control
settings live (libx264 + the hardware encoders).

## Processing rules

- **Images** (`.jpg .jpeg .png .heic .heif .tiff .tif .webp`, sharp): EXIF
  orientation applied to pixels, resized to max 1280 px on the longest side
  (never upscaled), 8-bit sRGB. Same format as the original: JPEG q92
  progressive/mozjpeg, PNG level 6, TIFF deflate, WebP q92; HEIC/HEIF → JPEG
  `.jpg` (real iPhone HEVC files are decoded by macOS `sips`; elsewhere they
  are copied unprocessed). The capture-date fields (`DateTimeOriginal`,
  `DateTimeDigitized`, `OffsetTime*`) stay, in every format; everything else
  (EXIF, GPS, XMP, IPTC) is stripped. 4 parallel workers.
- **Videos** (`.mov .mp4 .m4v .avi .mkv .mts .m2ts`, bundled ffmpeg): scaled
  to fit 1280×720 (never upscaled, even dimensions enforced), H.264 at CRF 27
  equivalent, yuv420p, no audio; `+faststart` for mov/mp4-family containers.
  One at a time, in parallel with images. Progress parsed from ffmpeg stderr.
- **Hardware encoding**: candidates probed at first use with a real tiny
  encode (macOS: videotoolbox→libx264; Windows: nvenc→qsv→amf→libx264;
  Linux: libx264). Per-file fallback to libx264 on HW failure; encoder used
  is reported per file and in the summary (`encoderUsage`). Toggleable in
  Settings (default ON). `engineCapabilities()` exposes the probe results.
- **Robustness**: HDR (PQ/HLG/bt2020) sources are tonemapped to bt709 via
  zscale+hable (capability probed at detection); VFR sources are forced to
  CFR at their average rate (CFR sources untouched); rotation side data is
  honored (vertical stays vertical); odd dimensions round to even.
- **Benchmark**: `node dist/scripts/bench.js <folder> [--encoder libx264]`
  (manual only; scripts/ is not packaged).
- **Junk** skipped: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `__MACOSX`,
  hidden dot-files/dirs.
- **Everything else** (and any processing failure): copied unchanged +
  reported with a reason.
- Before starting: output size estimated at ~5% of input; free disk space at
  the output location is checked and the run aborts early if insufficient.

## Tests

`npm test` — builds, generates a fixture tree in a temp dir (sharp-drawn
images incl. one EXIF-rotated, ffmpeg-generated clips incl. one with audio,
unicode/space folder names, junk files, deliberately corrupt image and video),
runs the engine, and asserts: originals untouched (checksums), exact-name
mirror, output format per input format, capture date read back, resize/rotation/stripping, corrupt files copied + reported, zip root
name, collision/overwrite behavior, unsafe-output rejection.
