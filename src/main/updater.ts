import { app, dialog } from 'electron';
import { STR } from '../shared/strings';

/**
 * AUTO-UPDATE FEATURE FLAG (per platform).
 *
 * macOS: electron-updater REQUIRES a signed (and notarized) app — unsigned
 * updates fail at install. Ships OFF. THE ONE-STEP CHANGE once the Apple
 * Developer certificate lands: flip `darwin` to true (and set the signing
 * identity in electron-builder.yml).
 *
 * Windows: unsigned auto-update works (SmartScreen aside) — ON.
 */
const AUTO_UPDATE_ENABLED: Partial<Record<NodeJS.Platform, boolean>> = {
  darwin: false,
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
      const { autoUpdater } = await import('electron-updater');
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
        autoUpdater.quitAndInstall();
      });
      await autoUpdater.checkForUpdates();
    } catch {
      /* quiet fail */
    }
  })();
}
