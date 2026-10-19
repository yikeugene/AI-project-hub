import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { DESKTOP_CHANNELS, type DesktopBridge } from '../shared/desktop.js';
import type { UpdateState } from '../shared/updates.js';

const bridge: DesktopBridge = Object.freeze({
  chooseDirectory: () => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseDirectory),
  saveText: (input: { filename: string; text: string }) => ipcRenderer.invoke(DESKTOP_CHANNELS.saveText, input),
  writeClipboard: (text: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.writeClipboard, text),
  getUpdateState: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(DESKTOP_CHANNELS.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(DESKTOP_CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(DESKTOP_CHANNELS.installUpdate),
  openReleases: () => ipcRenderer.invoke(DESKTOP_CHANNELS.openReleases),
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const receive = (_event: IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on(DESKTOP_CHANNELS.updateState, receive);
    return () => { ipcRenderer.removeListener(DESKTOP_CHANNELS.updateState, receive); };
  },
});
contextBridge.exposeInMainWorld('hubDesktop', bridge);
