import { isNewerStable, releaseUrl, type ReleaseSource, type UpdateState, type UpdateUnavailableReason } from '../shared/updates.js';

export interface UpdateAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (value: any) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}
export interface UpdateOptions {
  currentVersion: string;
  source: ReleaseSource | null;
  unavailable?: UpdateUnavailableReason;
  adapter?: UpdateAdapter;
  changed: (state: UpdateState) => void;
  requestClose: () => void;
}

/** Owns update intent; neither ordinary quit nor a canceled close installs anything. */
export class UpdateController {
  private state: UpdateState;
  private pendingInstall = false;
  constructor(private readonly options: UpdateOptions) {
    const url = releaseUrl(options.source);
    const reason = !url ? 'unconfigured' : options.unavailable;
    this.state = { revision: 0, currentVersion: options.currentVersion, releaseUrl: url, status: reason || !options.adapter ? 'unavailable' : 'idle', ...(reason ? { reason } : {}) };
    const adapter = options.adapter;
    if (!adapter || reason) return;
    adapter.autoDownload = false;
    adapter.autoInstallOnAppQuit = false;
    adapter.autoRunAppAfterInstall = true;
    adapter.allowDowngrade = false;
    adapter.allowPrerelease = false;
    adapter.on('error', error => this.fail(error));
    adapter.on('update-not-available', () => { if (this.state.status === 'checking') this.set({ status: 'current' }); });
    adapter.on('update-available', info => {
      if (this.state.status !== 'checking') return;
      if (typeof info?.version !== 'string' || !isNewerStable(info.version, options.currentVersion)) { this.set({ status: 'current' }); return; }
      this.set({ status: 'available', latestVersion: info.version });
    });
    adapter.on('download-progress', progress => {
      if (this.state.status === 'downloading' && typeof progress?.percent === 'number' && Number.isFinite(progress.percent)) this.set({ progress: Math.max(0, Math.min(100, progress.percent)) });
    });
    adapter.on('update-downloaded', info => {
      if (this.state.status === 'downloading' && info?.version === this.state.latestVersion) this.set({ status: 'downloaded', progress: 100 });
    });
  }
  snapshot(): UpdateState { return { ...this.state }; }
  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.options.changed(this.snapshot());
  }
  private fail(error: unknown) {
    this.pendingInstall = false;
    this.set({ status: 'error', error: error instanceof Error ? error.message : String(error), progress: undefined });
  }
  async check(): Promise<UpdateState> {
    if (!this.options.adapter || !['idle', 'current', 'error', 'available'].includes(this.state.status)) return this.snapshot();
    this.set({ status: 'checking', error: undefined, latestVersion: undefined, progress: undefined });
    try { await this.options.adapter.checkForUpdates(); }
    catch (error) { this.fail(error); }
    return this.snapshot();
  }
  async download(): Promise<UpdateState> {
    if (!this.options.adapter || this.state.status !== 'available') return this.snapshot();
    this.set({ status: 'downloading', error: undefined, progress: 0 });
    try { await this.options.adapter.downloadUpdate(); }
    catch (error) { this.fail(error); }
    return this.snapshot();
  }
  requestInstall(): UpdateState {
    if (this.state.status !== 'downloaded' || this.pendingInstall) return this.snapshot();
    this.pendingInstall = true;
    this.options.requestClose();
    return this.snapshot();
  }
  cancelInstall() { this.pendingInstall = false; }
  get installationPending() { return this.pendingInstall; }
  /** Call only after the window closed and runtime.stop() resolved successfully. */
  installAfterShutdown(): boolean {
    if (!this.pendingInstall || this.state.status !== 'downloaded' || !this.options.adapter) return false;
    this.pendingInstall = false;
    this.set({ status: 'installing' });
    try { this.options.adapter.quitAndInstall(false, true); }
    catch (error) { this.fail(error); }
    return this.snapshot().status === 'installing';
  }
}
