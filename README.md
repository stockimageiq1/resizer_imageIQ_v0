# ImageIQ Resizer

STOCK IMAGEIQ local media-downscaler: a processing engine with two entry
points — a CLI and an Electron desktop app. Produces a lowres proxy tree of an
input folder (images ≤1024 px JPEG, videos ≤720p H.264, metadata stripped) for
metadata processing with CSV export.

## Packaging (Milestone 4)

- `npm run package:mac` → `release/ImageIQ-Resizer-mac-<arch>.dmg` (host
  arch; per-arch dmgs instead of universal — see electron-builder.yml).
- `npm run package:win` → `release/ImageIQ-Resizer-win-x64.exe` (nsis,
  x64; cross-buildable from macOS, natively built + runtime-verified in CI).
- CI: pushing a `v*` tag builds mac (arm64+x64) and windows installers and
  attaches them to a draft GitHub Release (.github/workflows/release.yml).
- v1 ships unsigned — user-facing Gatekeeper/SmartScreen steps in
  docs/INSTALL.md; Windows runtime checklist in docs/WINDOWS_TEST.md.
- ffmpeg is asarUnpack'd and path-rewritten (`ffmpegPath()`); a startup
  assertion verifies every bundled binary and shows an error dialog if
  missing. Auto-update: ON for Windows, OFF for macOS until signing lands
  (`src/main/updater.ts`).

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
- Settings page: image max dimension (256–4096, default 1024), JPEG
  quality (40–95, default 80), video max height (240–2160, default 720), CRF
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
originals when uploading to stock photo/video sites. Non-JPEG images therefore
contain JPEG bytes under their original name (`small.png` is a JPEG named
`small.png`); videos are re-encoded into a container matching their original
extension. Folder names (semantic context for the SaaS) are preserved exactly.

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
  orientation applied to pixels, resized to max 1024 px on the longest side
  (never upscaled), all metadata (EXIF/GPS/XMP) stripped, JPEG q80
  progressive/mozjpeg. 4 parallel workers.
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
mirror, resize/rotation/stripping, corrupt files copied + reported, zip root
name, collision/overwrite behavior, unsafe-output rejection.
