import type { AppUpdater } from 'electron-updater';

/**
 * electron-updater is CommonJS and its `autoUpdater` is a lazy getter, which
 * Node's import() does not copy onto the module namespace: it exists only on
 * `.default`. Taken from the namespace it is undefined, and the quiet-fail
 * catch in updater.ts would hide that for good: no update would ever be
 * offered, and no installed copy could be fixed from outside.
 *
 * Both the normal run and --smoke-test come through here, so a packaged build
 * proves the real path. No Electron import: the Node tests load this file.
 */
export async function updaterExports(): Promise<typeof import('electron-updater')> {
  return (await import('electron-updater')).default;
}

export async function loadAutoUpdater(): Promise<AppUpdater> {
  const { autoUpdater } = await updaterExports();
  return autoUpdater;
}
