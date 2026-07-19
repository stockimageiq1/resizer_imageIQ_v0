import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme } from 'electron';
import { ffmpegPath } from '../engine/videoProcessor';
import { STR } from '../shared/strings';
import { registerIpc } from './ipc';
import { anyRunActive, cancelRun } from './runManager';
import { getSettings } from './settings';
import { initAutoUpdater } from './updater';

const smokeTest = process.argv.includes('--smoke-test');
const e2eFlagIndex = process.argv.indexOf('--e2e');
const e2eInputDir = e2eFlagIndex >= 0 ? process.argv[e2eFlagIndex + 1] : undefined;

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    title: 'ImageIQ Resizer',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devServerUrl !== undefined) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * Startup assertion: every bundled binary the engine spawns must exist and be
 * executable in the packaged layout (asarUnpack + path rewrite). ffmpeg is
 * currently the ONLY binary (M3 deliberately avoided adding ffprobe) — add
 * any future binary to this list.
 */
async function assertBundledBinaries(): Promise<void> {
  const binaries: { name: string; path: string | null }[] = [{ name: 'ffmpeg', path: ffmpegPath() }];
  for (const binary of binaries) {
    let ok = binary.path !== null;
    if (ok && binary.path !== null) {
      try {
        await fs.access(binary.path, fsConstants.X_OK);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      // machine-readable line for smoke/e2e harnesses; dialog for real users
      console.log(`BINARY-ASSERT FAIL ${binary.name}: ${binary.path ?? '(unresolved)'}`);
      if (!smokeTest && e2eInputDir === undefined) {
        dialog.showErrorBox(STR.dialogs.ffmpegMissingTitle, STR.dialogs.ffmpegMissing(binary.path ?? '(unresolved)'));
      }
    }
  }
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // single window, no menus
  // Appearance setting drives prefers-color-scheme via nativeTheme (default
  // dark = the Frame Picker look); settings changes re-apply it live.
  nativeTheme.themeSource = (await getSettings()).appearance;
  // dev harness override so both palettes can be smoke-rendered in CI
  if (process.argv.includes('--theme=dark')) nativeTheme.themeSource = 'dark';
  if (process.argv.includes('--theme=light')) nativeTheme.themeSource = 'light';
  // History feature was removed — silently clear any leftover store
  await fs.rm(path.join(app.getPath('userData'), 'history.json'), { force: true }).catch(() => undefined);
  await assertBundledBinaries();
  initAutoUpdater();
  registerIpc(() => {
    if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow();
    return mainWindow;
  });
  mainWindow = createWindow();

  if (smokeTest) {
    const win = mainWindow;
    // --capture=<path>: save a PNG of the rendered window (self-capture,
    // no OS screen-recording permission involved) for visual verification
    const captureArg = process.argv.find((arg) => arg.startsWith('--capture='));
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const childCount: unknown = await win.webContents.executeJavaScript(
              `document.getElementById('root')?.children.length ?? -1`,
            );
            console.log(
              typeof childCount === 'number' && childCount > 0
                ? 'SMOKE OK — UI rendered'
                : `SMOKE FAIL — empty #root (${String(childCount)})`,
            );
            if (captureArg !== undefined) {
              const dest = captureArg.slice('--capture='.length);
              const image = await win.webContents.capturePage();
              await fs.writeFile(dest, image.toPNG());
              console.log(`SMOKE CAPTURE ${dest}`);
            }
          } catch (err) {
            console.log(`SMOKE FAIL — ${String(err)}`);
          }
          app.quit();
        })();
      }, 700);
    });
  }

  if (e2eInputDir !== undefined) {
    const win = mainWindow;
    win.webContents.once('did-finish-load', () => {
      void runE2e(win, e2eInputDir);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

/**
 * Dev/CI harness (--e2e <folder>): drives the REAL preload bridge from the
 * renderer — cancel scenario first, then a full run — and prints the result.
 */
async function runE2e(win: BrowserWindow, inputDir: string): Promise<void> {
  const script = `
    (async () => {
      const dir = ${JSON.stringify(inputDir)};
      const waitDone = () =>
        new Promise((resolve) => {
          const off = window.iqShrink.onDone((m) => { off(); resolve(m); });
        });

      const caps = await window.iqShrink.getCapabilities();
      const preview = await window.iqShrink.scanPreview(dir, null);

      const cancelledPromise = waitDone();
      const start1 = await window.iqShrink.startRun({ inputDir: dir, outputParentDir: null, createZip: true });
      await window.iqShrink.cancelRun();
      const cancelled = start1.started ? await cancelledPromise : { status: 'never-started' };
      const partialGone = start1.started ? !(await window.iqShrink.isDirectory(start1.outDir)) : null;

      let progressCount = 0;
      let sawVideoPercent = false;
      const offProgress = window.iqShrink.onProgress((m) => {
        progressCount += 1;
        if (m.event.type === 'video-progress' && m.event.percent > 0) sawVideoPercent = true;
      });
      const donePromise = waitDone();
      const start2 = await window.iqShrink.startRun({ inputDir: dir, outputParentDir: null, createZip: true });
      const done = start2.started ? await donePromise : { status: 'never-started', detail: start2 };
      offProgress();

      return {
        caps,
        preview: { images: preview.imageCount, videos: preview.videoCount, files: preview.totalFiles },
        cancelledStatus: cancelled.status,
        partialGone,
        doneStatus: done.status,
        summary: done.status === 'done'
          ? {
              images: done.summary.imagesProcessed,
              videos: done.summary.videosProcessed,
              copied: done.summary.copiedUnprocessed.length,
              encoderUsage: done.summary.encoderUsage,
              outputPath: done.summary.outputPath,
              zipPath: done.summary.zipPath ?? null,
            }
          : null,
        progressCount,
        sawVideoPercent,
      };
    })()
  `;
  try {
    const result: unknown = await win.webContents.executeJavaScript(script);
    console.log(`E2E RESULT ${JSON.stringify(result)}`);
  } catch (err) {
    console.log(`E2E FAIL ${String(err)}`);
  }
  app.quit();
}

// single-window utility: quitting on close (also on macOS) keeps run state
// simple. A close mid-run cancels first so the ffmpeg child dies and the
// partial output cleanup gets a moment to finish.
app.on('window-all-closed', () => {
  const wasRunning = anyRunActive();
  cancelRun();
  setTimeout(() => app.quit(), wasRunning ? 800 : 0);
});
