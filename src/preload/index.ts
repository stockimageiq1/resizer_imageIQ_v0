import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IpcChannels,
  RendererApi,
  RunDoneMessage,
  RunProgressMessage,
  Settings,
  StartRunRequest,
} from '../shared/ipc';

const api: RendererApi = {
  scanPreview: (inputDir, outputParentDir) => ipcRenderer.invoke(IpcChannels.scanPreview, inputDir, outputParentDir),
  resolveOutDir: (inputDir, outputParentDir) =>
    ipcRenderer.invoke(IpcChannels.resolveOutDir, inputDir, outputParentDir),
  startRun: (request: StartRunRequest) => ipcRenderer.invoke(IpcChannels.startRun, request),
  cancelRun: () => ipcRenderer.invoke(IpcChannels.cancelRun),
  onProgress: (callback) => {
    const listener = (_event: unknown, message: RunProgressMessage): void => callback(message);
    ipcRenderer.on(IpcChannels.runProgress, listener);
    return () => ipcRenderer.removeListener(IpcChannels.runProgress, listener);
  },
  onDone: (callback) => {
    const listener = (_event: unknown, message: RunDoneMessage): void => callback(message);
    ipcRenderer.on(IpcChannels.runDone, listener);
    return () => ipcRenderer.removeListener(IpcChannels.runDone, listener);
  },
  selectFolder: () => ipcRenderer.invoke(IpcChannels.selectFolder),
  openPath: (target) => ipcRenderer.invoke(IpcChannels.openPath, target),
  showItemInFolder: (target) => ipcRenderer.invoke(IpcChannels.showItemInFolder, target),
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IpcChannels.settingsSet, patch),
  isDirectory: (target) => ipcRenderer.invoke(IpcChannels.isDirectory, target),
  getCapabilities: () => ipcRenderer.invoke(IpcChannels.capabilities),
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('iqShrink', api);
