# Windows runtime verification checklist

The Windows installer is produced (and its contents verified) from macOS /
CI, but **runtime verification needs a real Windows 10/11 x64 machine** —
ideally one pass each on NVIDIA, Intel-iGPU, and AMD hardware for the
encoder matrix. Work through this list and record results.

## Install

- [ ] Run `IQ Shrink Setup <version>.exe` → SmartScreen appears → More info
      → Run anyway (wording per docs/INSTALL.md).
- [ ] Installer allows choosing the install directory; desktop shortcut is
      created; app launches from both shortcut and Start menu.

## Engine bring-up

- [ ] App starts with NO "Video engine missing" dialog (the startup
      assertion found `ffmpeg.exe` in `resources/app.asar.unpacked/...`).
- [ ] Run the harness from a terminal for a machine-readable report:
      `"C:\...\IQ Shrink\IQ Shrink.exe" --e2e "C:\path\to\test folder"`
      → the `E2E RESULT` line prints `caps` (capabilities) and
      `encoderUsage`.
- [ ] `caps.heicSupported` — record true/false (expected true with the
      bundled prebuilt sharp; if false, HEIC files must be reported as
      copied-unprocessed, not fail the run).

## Encoder probes (M3 mappings are UNTESTED best-practice defaults!)

- [ ] Record `caps.videoEncoder` per machine:
      NVIDIA → expect `h264_nvenc`; Intel iGPU → `h264_qsv`;
      AMD → `h264_amf`; none/VM → `libx264`.
- [ ] **Visual spot-check required**: compare a HW-encoded output against
      `libx264` at the same CRF setting (Settings → Hardware acceleration
      OFF re-runs software). The CRF→HW mappings (nvenc `-rc vbr -cq`,
      qsv `-global_quality`, amf `-rc cqp`) were chosen on paper and MUST
      be sanity-checked for visible quality gaps or bloated file sizes.
- [ ] Force a HW failure if possible (e.g. outdated driver) and confirm the
      per-file fallback recovers via libx264 (`encoderUsage` shows it).

## Output correctness

- [ ] Drop a real folder (nested subfolders, spaces/unicode names, JPG +
      PNG + HEIC + MOV/MP4): file names preserved EXACTLY, originals
      untouched, junk (.DS_Store/Thumbs.db) excluded.
- [ ] Images ≤1024 px JPEG, metadata stripped; videos ≤720p H.264, no
      audio (unless the setting is on), original extensions kept.
- [ ] ZIP root folder is the original folder name (no `_lowres`).
- [ ] Cancel mid-run kills the encode and deletes the partial output.

## Auto-update (enabled on Windows)

- [ ] With no newer release published: app launches with no update prompt
      and no error (quiet fail).
- [ ] With a newer draft release published: "Update available" dialog →
      Download & Restart installs and relaunches the new version.
