import { promises as fs } from 'node:fs';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { engineCapabilities } from '../engine/capabilities';
import { Capabilities, IpcChannels, Settings, StartRunRequest } from '../shared/ipc';
import { cancelRun, resolveOutDir, scanPreview, startRun } from './runManager';
import { getSettings, setSettings } from './settings';

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function asParentDir(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value, 'outputParentDir');
}

function asStartRunRequest(value: unknown): StartRunRequest {
  const raw = value as Partial<StartRunRequest> | null;
  if (raw === null || typeof raw !== 'object') throw new Error('invalid startRun request');
  return { inputDir: asString(raw.inputDir, 'inputDir') };
}

export function registerIpc(getWindow: () => BrowserWindow): void {
  ipcMain.handle(IpcChannels.scanPreview, (_event, inputDir: unknown, parentDir: unknown) =>
    scanPreview(asString(inputDir, 'inputDir'), asParentDir(parentDir)),
  );

  ipcMain.handle(IpcChannels.resolveOutDir, (_event, inputDir: unknown, parentDir: unknown) =>
    resolveOutDir(asString(inputDir, 'inputDir'), asParentDir(parentDir)),
  );

  ipcMain.handle(IpcChannels.startRun, (_event, request: unknown) =>
    startRun(getWindow(), asStartRunRequest(request)),
  );

  ipcMain.handle(IpcChannels.cancelRun, () => {
    cancelRun();
  });

  ipcMain.handle(IpcChannels.selectFolder, async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IpcChannels.openPath, async (_event, target: unknown) => {
    await shell.openPath(asString(target, 'path'));
  });

  ipcMain.handle(IpcChannels.showItemInFolder, (_event, target: unknown) => {
    shell.showItemInFolder(asString(target, 'path'));
  });

  ipcMain.handle(IpcChannels.settingsGet, (): Promise<Settings> => getSettings());

  ipcMain.handle(IpcChannels.settingsSet, (_event, patch: unknown): Promise<Settings> => {
    if (patch === null || typeof patch !== 'object') throw new Error('invalid settings patch');
    return setSettings(patch as Partial<Settings>);
  });

  ipcMain.handle(IpcChannels.isDirectory, async (_event, target: unknown) => {
    try {
      return (await fs.stat(asString(target, 'path'))).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle(IpcChannels.capabilities, async (): Promise<Capabilities> => {
    const caps = await engineCapabilities();
    return {
      heicSupported: caps.heicSupported,
      ffmpegAvailable: caps.ffmpegAvailable,
      videoEncoder: caps.videoEncoder,
      hdrTonemap: caps.hdrTonemap,
    };
  });
}
