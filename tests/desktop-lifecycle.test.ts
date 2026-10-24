import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopLifecycle } from '../desktop/lifecycle.js';
import { DESKTOP_CHANNELS } from '../shared/desktop.js';
import type { UpdateOptions } from '../desktop/updater.js';
import type { Locale } from '../shared/i18n.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

describe('desktop close intent', () => {
  it('never drains on hide or unexpected loss, and falls back to real quit without a tray', () => {
    const state = new DesktopLifecycle();
    expect(state.allWindowsClosed()).toBe('recover');
    expect(state.beginShutdown()).toBe(false);
    state.setTrayAvailable(true);
    expect(state.windowClose()).toBe('hide');
    expect(state.beginShutdown()).toBe(false);
    state.setTrayAvailable(false);
    expect(state.windowClose()).toBe('close');
    expect(state.closeIntent).toBe('quit');
    expect(state.beginShutdown()).toBe(true);
    expect(state.beginShutdown()).toBe(false);
    state.cancelClose();
    expect(state.closeIntent).toBe('quit');
  });

  it.each(['quit', 'update', 'startup-failed'] as const)('%s bypasses hide and only an uncanceled exit permits shutdown', intent => {
    const state = new DesktopLifecycle();
    state.setTrayAvailable(true);
    expect(state.requestExit(intent)).toBe(true);
    expect(state.windowClose()).toBe('close');
    expect(state.allWindowsClosed()).toBe('shutdown');
    expect(state.requestExit('quit')).toBe(false);
    expect(state.closeIntent).toBe(intent);
    state.cancelClose();
    expect(state.closeIntent).toBe('hide');
    expect(state.windowClose()).toBe('hide');
    expect(state.beginShutdown()).toBe(false);
  });
});

/** Test-only Electron host. Production main/bridge/lifecycle run unmodified. */
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
async function boot(options: { trayFails?: boolean; loadFails?: boolean; startupWait?: Promise<void>; initialSession?: 'active' | 'idle' | 'locked' | 'unknown' } = {}) {
  vi.resetModules();
  vi.stubGlobal('__dirname', '/fixture/app');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/fixture/resources' });
  const createWindowsForegroundSource = vi.fn((_options: { executable: string }) => ({ available: () => true, sample: vi.fn() }));
  const calls: string[] = [];
  const backend = {
    origin: 'http://127.0.0.1:43171',
    store: { getSettings: () => ({ locale: 'en' as Locale }) },
    stop: vi.fn(async () => { calls.push('stop'); }),
    setActivityMode: vi.fn(), setAppObservationSessionAvailable: vi.fn(), resumed: vi.fn(),
  };
  let onSettingsChanged: (settings: { locale: Locale }) => void = () => {};
  const createHubRuntime = vi.fn(async (input: { appOptions: { onSettingsChanged: typeof onSettingsChanged } }) => {
    onSettingsChanged = input.appOptions.onSettingsChanged;
    await options.startupWait;
    return backend;
  });
  const ipc = new Map<string, (...args: any[]) => any>();
  const ipcMain = { handle: vi.fn((channel: string, callback: (...args: any[]) => any) => {
    if (ipc.has(channel)) throw new Error('Duplicate IPC handler');
    ipc.set(channel, callback);
  }) };
  const dialog = { showMessageBoxSync: vi.fn(() => 0), showErrorBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
  const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleState: vi.fn(() => options.initialSession ?? 'active') });
  const exited = vi.fn();
  const app = Object.assign(new EventEmitter(), {
    setName: vi.fn(), setAppUserModelId: vi.fn(), setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() }, requestSingleInstanceLock: () => true,
    getPath: () => '/fixture/app', getAppPath: () => '/fixture/app', isPackaged: false,
    whenReady: async () => {}, exit: vi.fn(),
    quit: vi.fn(() => { const e = event(); app.emit('before-quit', e); if (!e.prevented) exited(); }),
  });
  type Item = { id?: string; label?: string; submenu?: Item[]; click?: () => void };
  let applicationMenu: Item[] = [];
  const Menu = { buildFromTemplate: (items: Item[]) => items, setApplicationMenu: (items: Item[]) => { applicationMenu = items; } };
  function makeSession() {
    return {
      setProxy: vi.fn(async () => {}), setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn<(filter: any, listener?: any) => void>() },
    };
  }
  const sessions: ReturnType<typeof makeSession>[] = [];
  const windows: Window[] = [];
  class Window extends EventEmitter {
    destroyed = false; visible = false; minimized = false; dirty = false;
    focus = vi.fn();
    webContents = Object.assign(new EventEmitter(), {
      id: windows.length + 1, mainFrame: { url: backend.origin + '/' },
      setWindowOpenHandler: vi.fn(), send: vi.fn(),
    });
    constructor(readonly options: Record<string, any>) { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; this.emit('hide'); }
    minimize() { this.minimized = true; this.emit('minimize'); }
    restore() { this.minimized = false; this.emit('restore'); }
    async loadURL() { if (options.loadFails) throw new Error('Failed to load'); this.emit('ready-to-show'); }
    close() {
      const close = event(); this.emit('close', close);
      if (close.prevented) return;
      if (this.dirty) {
        const unload = event(); this.webContents.emit('will-prevent-unload', unload);
        if (!unload.prevented) return;
      }
      this.destroy();
    }
    destroy() {
      this.destroyed = true; this.visible = false; this.emit('closed');
      if (windows.every(window => window.destroyed)) app.emit('window-all-closed');
    }
  }
  const trays: Tray[] = [];
  class Tray extends EventEmitter {
    destroyed = false; menu: Item[] = [];
    constructor() { super(); if (options.trayFails) throw new Error('Tray unavailable'); trays.push(this); }
    setToolTip() {}
    setContextMenu(items: Item[]) { this.menu = items; }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  let updater: TestUpdater;
  class TestUpdater {
    pending = false;
    constructor(readonly options: UpdateOptions) { updater = this; }
    cancelInstall = vi.fn(() => { this.pending = false; });
    installAfterShutdown = vi.fn(() => { calls.push('install'); this.pending = false; return true; });
    get installationPending() { return this.pending; }
    snapshot() { return { status: 'downloaded' }; }
    requestInstall() { this.pending = true; this.options.requestClose(); }
  }
  vi.doMock('electron', () => ({ app, BrowserWindow: Window, Menu, Tray, dialog, ipcMain, powerMonitor,
    clipboard: {}, shell: {}, safeStorage: {}, nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    session: { fromPartition: vi.fn(() => { const instance = makeSession(); sessions.push(instance); return instance; }) }, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1400, height: 1000 } }) },
  }));
  vi.doMock('node:fs', () => ({ mkdirSync: vi.fn(), existsSync: () => false, readFileSync: () => 'null' }));
  vi.doMock('electron-updater', () => ({ NsisUpdater: class {} }));
  vi.doMock('../desktop/updater.js', () => ({ UpdateController: TestUpdater }));
  vi.doMock('../server/windows-foreground.js', () => ({ createWindowsForegroundSource }));
  vi.doMock('../server/runtime.js', () => ({ createHubRuntime, defaultDataDirectory: () => '/fixture/data', DESKTOP_KEY_HEADER: 'x-hub-desktop-key' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../desktop/main.js');
  await turn();
  return {
    app, backend, calls, dialog, exited, ipc, ipcMain, powerMonitor, windows, trays, sessions, createHubRuntime, createWindowsForegroundSource,
    get updater() { return updater; },
    quit: () => applicationMenu[0].submenu![0].click!(),
    locale: (locale: Locale) => onSettingsChanged({ locale }),
  };
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const id of ['electron', 'node:fs', 'electron-updater', '../desktop/updater.js', '../server/runtime.js', '../server/windows-foreground.js']) vi.doUnmock(id);
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
  else delete (process as unknown as { resourcesPath?: string }).resourcesPath;
});

describe('Electron lifecycle wiring', () => {
  it('keeps foreground collection blocked until the session is known unlocked and separates it from Hub visibility', async () => {
    const host = await boot({ initialSession: 'locked' });
    expect(host.backend.setAppObservationSessionAvailable).toHaveBeenLastCalledWith(false);
    host.powerMonitor.emit('unlock-screen');
    expect(host.backend.setAppObservationSessionAvailable).toHaveBeenLastCalledWith(true);
    host.windows[0].hide();
    expect(host.backend.setActivityMode).toHaveBeenLastCalledWith('background');
    expect(host.backend.setAppObservationSessionAvailable).toHaveBeenLastCalledWith(true);
    host.windows[0].show(); host.windows[0].emit('blur');
    expect(host.backend.setActivityMode).toHaveBeenLastCalledWith('foreground');
    host.powerMonitor.emit('suspend'); host.powerMonitor.emit('unlock-screen');
    expect(host.backend.setAppObservationSessionAvailable).toHaveBeenLastCalledWith(false);
    host.powerMonitor.getSystemIdleState.mockReturnValue('active'); host.powerMonitor.emit('resume');
    expect(host.backend.setAppObservationSessionAvailable).toHaveBeenLastCalledWith(true);
    host.powerMonitor.emit('lock-screen'); expect(host.backend.setAppObservationSessionAvailable).toHaveBeenLastCalledWith(false);
  });
  it('creates one packaged collector and one power subscription even after a lost window', async () => {
    const host = await boot();
    expect(host.createWindowsForegroundSource).toHaveBeenCalledOnce();
    expect(host.createWindowsForegroundSource.mock.calls[0][0].executable.replaceAll('\\', '/')).toBe('/fixture/resources/app-observation/foreground-app.exe');
    host.windows[0].destroy(); await turn();
    expect(host.windows).toHaveLength(2); expect(host.createWindowsForegroundSource).toHaveBeenCalledOnce();
    for (const name of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) expect(host.powerMonitor.listenerCount(name)).toBe(1);
  });
  it('X keeps the same dirty renderer and runtime; tray/second instance restore it and menus relocalize', async () => {
    const host = await boot();
    const window = host.windows[0]; window.dirty = true;
    window.close();
    expect(window.destroyed).toBe(false); expect(window.visible).toBe(false);
    expect(host.dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(host.backend.stop).not.toHaveBeenCalled();
    expect(host.backend.setActivityMode).toHaveBeenLastCalledWith('background');
    expect(host.trays[0].menu.map(item => item.label).filter(Boolean)).toEqual(['Open AI Project Hub', 'Quit AI Project Hub']);
    host.trays[0].menu[0].click!();
    expect(window.visible).toBe(true); expect(window.focus).toHaveBeenCalled();
    window.minimize(); expect(host.backend.setActivityMode).toHaveBeenLastCalledWith('background');
    host.app.emit('second-instance');
    expect(window.minimized).toBe(false); expect(host.windows).toHaveLength(1);
    expect(host.backend.setActivityMode).toHaveBeenLastCalledWith('foreground');
    host.powerMonitor.emit('resume'); expect(host.backend.resumed).toHaveBeenCalledOnce();
    host.locale('zh-TW');
    expect(host.trays[0].menu.map(item => item.label).filter(Boolean)).toEqual(['開啟 AI Project Hub', '完全退出 AI Project Hub']);
  });

  it('canceled File Quit clears intent, retains drafts and makes the next X hide again', async () => {
    const host = await boot(); const window = host.windows[0]; window.dirty = true;
    window.hide(); host.quit();
    expect(window.visible).toBe(true); expect(window.destroyed).toBe(false);
    expect(host.updater.cancelInstall).toHaveBeenCalled();
    expect(host.backend.stop).not.toHaveBeenCalled();
    window.close(); expect(window.visible).toBe(false); expect(window.destroyed).toBe(false);
    host.dialog.showMessageBoxSync.mockReturnValue(1);
    host.trays[0].menu[2].click!();
    await turn();
    expect(window.destroyed).toBe(true); expect(host.backend.stop).toHaveBeenCalledOnce();
    expect(host.exited).toHaveBeenCalledOnce(); expect(host.updater.installAfterShutdown).not.toHaveBeenCalled();
  });

  it('app.before-quit is a real guarded quit, not a hide', async () => {
    const host = await boot(); const window = host.windows[0]; window.dirty = true;
    host.app.quit(); expect(window.destroyed).toBe(false);
    window.close(); expect(window.visible).toBe(false);
    host.dialog.showMessageBoxSync.mockReturnValue(1); host.app.quit(); await turn();
    expect(host.backend.stop).toHaveBeenCalledOnce(); expect(host.exited).toHaveBeenCalledOnce();
  });

  it('canceled update clears both intents; approved update waits for busy backend drain before installing', async () => {
    const host = await boot(); const window = host.windows[0]; window.dirty = true;
    host.updater.requestInstall(); await turn();
    expect(host.updater.installationPending).toBe(false); expect(window.visible).toBe(true);
    window.close(); expect(window.destroyed).toBe(false); expect(window.visible).toBe(false);
    let drained!: () => void;
    host.backend.stop.mockImplementation(() => new Promise<void>(resolve => { drained = () => { host.calls.push('drained'); resolve(); }; }));
    host.dialog.showMessageBoxSync.mockReturnValue(1);
    host.updater.requestInstall(); await turn();
    expect(window.destroyed).toBe(true); expect(host.backend.stop).toHaveBeenCalledOnce();
    expect(host.updater.installAfterShutdown).not.toHaveBeenCalled();
    host.app.quit(); // The updater's intent must survive an additional before-quit while draining.
    drained(); await turn();
    expect(host.calls).toEqual(['drained', 'install']);
    expect(host.updater.installAfterShutdown).toHaveBeenCalledOnce();
    expect(host.trays[0].destroyed).toBe(true);
  });

  it('ordinary quit after a canceled update never installs the downloaded update', async () => {
    const host = await boot(); const window = host.windows[0]; window.dirty = true;
    host.updater.requestInstall(); await turn();
    expect(host.updater.installationPending).toBe(false);
    window.dirty = false; host.quit(); await turn();
    expect(host.backend.stop).toHaveBeenCalledOnce(); expect(host.exited).toHaveBeenCalledOnce();
    expect(host.updater.installAfterShutdown).not.toHaveBeenCalled();
  });

  it('shutdown failure cancels installation and reports the failure rather than installing', async () => {
    const host = await boot();
    host.backend.stop.mockRejectedValue(new Error('Could not drain'));
    host.updater.requestInstall(); await turn();
    expect(host.updater.installationPending).toBe(false);
    expect(host.updater.installAfterShutdown).not.toHaveBeenCalled();
    expect(host.dialog.showErrorBox).toHaveBeenCalledWith('AI Project Hub could not close', 'Could not drain');
    expect(host.app.exit).toHaveBeenCalledWith(1);
  });

  it('a tray that disappears after creation no longer permits hiding', async () => {
    const host = await boot(); host.trays[0].destroy();
    host.windows[0].close(); await turn();
    expect(host.windows[0].destroyed).toBe(true);
    expect(host.backend.stop).toHaveBeenCalledOnce(); expect(host.exited).toHaveBeenCalledOnce();
  });

  it('tray creation failure never hides the app and still honors unsaved-content cancel', async () => {
    const host = await boot({ trayFails: true }); const window = host.windows[0]; window.dirty = true;
    window.close(); expect(window.visible).toBe(true); expect(host.backend.stop).not.toHaveBeenCalled();
    host.dialog.showMessageBoxSync.mockReturnValue(1); window.close(); await turn();
    expect(host.backend.stop).toHaveBeenCalledOnce(); expect(host.exited).toHaveBeenCalledOnce();
  });

  it('unexpected loss recovers a secured window with one bridge and no backend restart', async () => {
    const host = await boot(); const original = host.windows[0]; const handlerCount = host.ipcMain.handle.mock.calls.length;
    original.destroy(); await turn();
    const recovered = host.windows[1];
    expect(recovered.visible).toBe(true); expect(host.backend.stop).not.toHaveBeenCalled();
    expect(host.createHubRuntime).toHaveBeenCalledOnce(); expect(host.ipcMain.handle).toHaveBeenCalledTimes(handlerCount);
    expect(recovered.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
    expect(host.sessions).toHaveLength(2);
    const handler = host.ipc.get(DESKTOP_CHANNELS.getUpdateState)!;
    expect(() => handler({ sender: original.webContents, senderFrame: original.webContents.mainFrame })).toThrow();
    expect(handler({ sender: recovered.webContents, senderFrame: recovered.webContents.mainFrame })).toEqual({ status: 'downloaded' });
    expect(() => handler({ sender: recovered.webContents, senderFrame: { url: host.backend.origin + '/' } })).toThrow();
    const headerGuard = host.sessions[1].webRequest.onBeforeSendHeaders.mock.calls[0][1];
    const callback = vi.fn();
    headerGuard({ webContentsId: original.webContents.id, url: host.backend.origin + '/api/workspace' }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    headerGuard({ webContentsId: recovered.webContents.id, url: host.backend.origin + '/api/workspace', requestHeaders: {} }, callback);
    expect(callback.mock.lastCall![0].requestHeaders['x-hub-desktop-key']).toMatch(/^[a-f0-9]{64}$/);
    recovered.webContents.emit('render-process-gone'); await turn();
    expect(host.windows).toHaveLength(3); expect(host.windows[2].visible).toBe(true);
    expect(host.ipcMain.handle).toHaveBeenCalledTimes(handlerCount);
  });

  it('startup failure drains instead of recovering an unusable window', async () => {
    const host = await boot({ loadFails: true });
    expect(host.dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(host.backend.stop).toHaveBeenCalledOnce(); expect(host.exited).toHaveBeenCalledOnce();
    expect(host.windows).toHaveLength(1); expect(host.windows[0].destroyed).toBe(true);
  });

  it('quit during runtime initialization waits for and drains the acquired backend', async () => {
    let ready!: () => void;
    const host = await boot({ startupWait: new Promise<void>(resolve => { ready = resolve; }) });
    host.app.quit(); expect(host.exited).not.toHaveBeenCalled();
    ready(); await turn();
    expect(host.windows).toHaveLength(0); expect(host.backend.stop).toHaveBeenCalledOnce(); expect(host.exited).toHaveBeenCalledOnce();
  });
});
