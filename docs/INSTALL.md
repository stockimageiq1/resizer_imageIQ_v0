# Installing ImageIQ Resizer (v0.1.x — unsigned builds)

ImageIQ Resizer v1 ships **unsigned** (code signing certificates come later).
Both macOS and Windows will warn you the first time — this is expected for
unsigned apps and the steps below get you past it. You only do this once.

## macOS (.dmg)

1. Open the downloaded `ImageIQ-Resizer-mac-arm64.dmg` (Apple Silicon) or
   `ImageIQ-Resizer-mac-x64.dmg` (Intel) and drag **ImageIQ Resizer** into
   **Applications**.
2. Open the app. macOS will block it with:

   > **“ImageIQ Resizer” Not Opened** — Apple could not verify “ImageIQ Resizer” is free
   > of malware that may harm your Mac or compromise your privacy.

   Click **Done** (not *Move to Trash*).
3. Open **System Settings → Privacy & Security**, scroll down to the
   **Security** section. You'll see:

   > “ImageIQ Resizer” was blocked to protect your Mac.

   Click **Open Anyway**, authenticate (Touch ID / password), then click
   **Open Anyway** again in the confirmation dialog.
4. The app opens normally from now on.

On older macOS versions (Sonoma 14 and earlier) there is a shortcut:
right-click (Control-click) **ImageIQ Resizer.app** → **Open** → **Open**.

## Windows (.exe installer)

1. Run `ImageIQ-Resizer-win-x64.exe`. SmartScreen will show:

   > **Windows protected your PC** — Microsoft Defender SmartScreen
   > prevented an unrecognized app from starting.

2. Click **More info**, then **Run anyway**.
3. The installer lets you choose the install directory and creates a
   desktop shortcut. Finish and launch.

## Auto-updates

- **Windows**: the app checks GitHub Releases on launch and offers
  “Download & Restart” when a new version exists. Failures are silent
  (offline is fine).
- **macOS**: auto-update is **disabled** until the app is code-signed
  (Squirrel.Mac requires a valid signature to install updates). Once the
  Apple Developer certificate lands, the one-step change is flipping the
  `darwin` flag in `src/main/updater.ts` (plus signing config in
  `electron-builder.yml`). Until then, download new macOS versions manually.
