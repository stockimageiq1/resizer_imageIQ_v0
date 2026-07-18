import * as path from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';
import { registerIpc } from './ipc';
import { anyRunActive, cancelRun } from './runManager';

const smokeTest = process.argv.includes('--smoke-test');
const e2eFlagIndex = process.argv.indexOf('--e2e');
const e2eInputDir = e2eFlagIndex >= 0 ? process.argv[e2eFlagIndex + 1] : undefined;

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 780,
    height: 720,
    minWidth: 560,
    minHeight: 540,
    title: 'IQ Shrink',
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

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // single window, no menus
  registerIpc(() => {
    if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow();
    return mainWindow;
  });
  mainWindow = createWindow();

  if (smokeTest) {
    const win = mainWindow;
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents
          .executeJavaScript(`document.getElementById('root')?.children.length ?? -1`)
          .then((childCount: unknown) => {
            console.log(typeof childCount === 'number' && childCount > 0 ? 'SMOKE OK — UI rendered' : `SMOKE FAIL — empty #root (${String(childCount)})`);
            app.quit();
          })
          .catch((err: unknown) => {
            console.log(`SMOKE FAIL — ${String(err)}`);
            app.quit();
          });
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

      const preview = await window.iqShrink.scanPreview(dir, null);

      const cancelledPromise = waitDone();
      const start1 = await window.iqShrink.startRun({ inputDir: dir });
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
      const start2 = await window.iqShrink.startRun({ inputDir: dir });
      const done = start2.started ? await donePromise : { status: 'never-started', detail: start2 };
      offProgress();

      return {
        preview: { images: preview.imageCount, videos: preview.videoCount, files: preview.totalFiles },
        cancelledStatus: cancelled.status,
        partialGone,
        doneStatus: done.status,
        summary: done.status === 'done'
          ? {
              images: done.summary.imagesProcessed,
              videos: done.summary.videosProcessed,
              copied: done.summary.copiedUnprocessed.length,
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
