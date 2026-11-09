import { app, dialog } from 'electron';
import { STR } from '../shared/strings';
import { anyRunActive } from './runManager';
import { restartWhenIdle } from './updateRestart';
import { loadAutoUpdater } from './updaterModule';

/**
 * AUTO-UPDATE FEATURE FLAG (per platform).
 *
 * macOS: ON since 0.4.0, the first signed and notarized version
 * (electron-updater cannot install an unsigned update). Feed: the public
 * stockimageiq-resizer-releases repository (electron-builder.yml, publish).
 *
 * Windows: unsigned auto-update works (SmartScreen aside) — ON, but no Windows
 * build is released for now.
 */
const AUTO_UPDATE_ENABLED: Partial<Record<NodeJS.Platform, boolean>> = {
  darwin: true,
  win32: true,
};

/**
 * Check GitHub Releases on launch; quiet-fail on any error (offline, no
 * releases yet, rate limit — the app must never nag about updates failing).
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  if (AUTO_UPDATE_ENABLED[process.platform] !== true) return;
  void (async () => {
    try {
      const autoUpdater = await loadAutoUpdater();
      autoUpdater.autoDownload = false;
      autoUpdater.on('error', () => undefined); // quiet fail
      autoUpdater.on('update-available', (info) => {
        void (async () => {
          const choice = await dialog.showMessageBox({
            type: 'info',
            buttons: [STR.updater.download, STR.updater.later],
            defaultId: 0,
            cancelId: 1,
            message: STR.updater.title,
            detail: STR.updater.detail(info.version),
          });
          if (choice.response === 0) {
            try {
              await autoUpdater.downloadUpdate();
            } catch {
              /* quiet fail */
            }
          }
        })();
      });
      autoUpdater.on('update-downloaded', () => {
        // A resize started while the update was downloading finishes first.
        restartWhenIdle(anyRunActive, () => autoUpdater.quitAndInstall());
      });
      await autoUpdater.checkForUpdates();
    } catch {
      /* quiet fail */
    }
  })();
}
