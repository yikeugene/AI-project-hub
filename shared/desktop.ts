import type { UpdateState } from './updates.js';

export const DESKTOP_CHANNELS = {
  chooseDirectory: 'hub:choose-directory', saveText: 'hub:save-text', writeClipboard: 'hub:write-clipboard',
  getUpdateState: 'hub:update-state', checkForUpdates: 'hub:update-check', downloadUpdate: 'hub:update-download',
  installUpdate: 'hub:update-install', openReleases: 'hub:update-releases', updateState: 'hub:update-changed',
} as const;

/** The only native surface exposed to the sandboxed renderer. */
export interface DesktopBridge {
  chooseDirectory(): Promise<string | null>;
  saveText(input: { filename: string; text: string }): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  openReleases(): Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window { hubDesktop?: DesktopBridge }
}
