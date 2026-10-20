import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, powerMonitor, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { NsisUpdater } from 'electron-updater';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHubRuntime, defaultDataDirectory, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import { DESKTOP_CHANNELS } from '../shared/desktop.js';
import { APP_VERSION } from '../shared/types.js';
import { DEFAULT_LOCALE, translate, type Locale } from '../shared/i18n.js';
import { desktopMessages } from '../shared/locales/desktop.js';
import { releaseUrl, type ReleaseSource, type UpdateState, type UpdateUnavailableReason } from '../shared/updates.js';
import { clipboardInput, isAppUrl, isMainDocumentUrl, saveTextInput } from './security.js';
import { createCredentialCodec } from './credentials.js';
import { UpdateController } from './updater.js';
import { DesktopLifecycle, type ExitIntent } from './lifecycle.js';

app.setName('AI Project Hub');
app.setAppUserModelId('local.aiprojecthub.desktop');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const dataDir = resolve(arg('--data-dir') || process.env.HUB_DATA_DIR || defaultDataDirectory());
const profile = join(dataDir, 'desktop-profile');
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: HubRuntime | null = null;
let startingRuntime: Promise<HubRuntime> | undefined;
let creatingWindow: Promise<void> | undefined;
let desktopSecret: string;
let disposed = false;
let shutdown: Promise<void> | undefined;
let locale: Locale = DEFAULT_LOCALE;
let updater: UpdateController;
const lifecycle = new DesktopLifecycle();
const t = (key: keyof typeof desktopMessages.en) => translate(desktopMessages, locale, key);

async function finishShutdown() {
  if (shutdown) return shutdown;
  if (!lifecycle.beginShutdown()) return;
  shutdown = (async () => {
    // Quit may arrive while startup is acquiring the listener/database.
    const activeRuntime = runtime ?? await startingRuntime?.catch(() => null);
    await activeRuntime?.stop();
    disposed = true;
    tray?.destroy(); tray = null;
    if (lifecycle.closeIntent === 'update' && updater?.installationPending && updater.installAfterShutdown()) return;
    updater?.cancelInstall();
    app.quit();
  })().catch(error => {
    updater?.cancelInstall();
    dialog.showErrorBox(t('shutdownFailed'), error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
  return shutdown;
}

function reportActivity() {
  runtime?.setActivityMode(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized() ? 'foreground' : 'background');
}

function revealWindow(owner: BrowserWindow) {
  if (owner.isMinimized()) owner.restore();
  owner.show(); owner.focus();
}

function showWindow() {
  if (lifecycle.exiting || disposed) return;
  if (window && !window.isDestroyed()) revealWindow(window);
  else if (runtime) void createMainWindow().catch(startupFailed);
}

function requestExit(intent: ExitIntent): boolean {
  if (!lifecycle.requestExit(intent)) return false;
  if (intent !== 'update') updater?.cancelInstall();
  // A hidden window must be visible if its unsaved-content guard cancels exit.
  if (window && !window.isDestroyed()) { revealWindow(window); window.close(); }
  else void finishShutdown();
  return true;
}

async function startupFailed(error: unknown) {
  if (!lifecycle.requestExit('startup-failed')) { await shutdown; return; }
  updater?.cancelInstall();
  dialog.showErrorBox(t('startupFailed'), error instanceof Error ? error.message : String(error));
  if (window && !window.isDestroyed()) window.destroy();
  await finishShutdown();
}

function trustedSender(event: IpcMainInvokeEvent) {
  if (!window || !runtime || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isMainDocumentUrl(event.senderFrame.url, runtime.origin))
    throw new Error(t('trusted'));
  return window;
}

function installNativeBridge() {
  ipcMain.handle(DESKTOP_CHANNELS.chooseDirectory, async (event: IpcMainInvokeEvent) => {
    const owner = trustedSender(event);
    const result = await dialog.showOpenDialog(owner, { title: t('directory'), properties: ['openDirectory', 'dontAddToRecent'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(DESKTOP_CHANNELS.writeClipboard, async (event: IpcMainInvokeEvent, input: unknown) => {
    trustedSender(event);
    const parsed = clipboardInput.safeParse(input);
    if (!parsed.success) throw new Error(t('invalidClipboard'));
    await clipboard.writeText(parsed.data);
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveText, async (event: IpcMainInvokeEvent, input: unknown) => {
    const owner = trustedSender(event);
    const parsed = saveTextInput.safeParse(input);
    if (!parsed.success) throw new Error(t('invalidSave'));
    const { filename, text } = parsed.data;
    const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    const result = await dialog.showSaveDialog(owner, {
      title: t('save'), defaultPath: join(app.getPath('documents'), filename),
      filters: [{ name: extension === 'md' ? 'Markdown' : extension === 'json' ? 'JSON' : t('text'), extensions: [extension] }],
      properties: ['showOverwriteConfirmation', 'createDirectory', 'dontAddToRecent'],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 });
    return true;
  });
  ipcMain.handle(DESKTOP_CHANNELS.getUpdateState, (event: IpcMainInvokeEvent) => { trustedSender(event); return updater.snapshot(); });
  ipcMain.handle(DESKTOP_CHANNELS.checkForUpdates, (event: IpcMainInvokeEvent) => { trustedSender(event); return updater.check(); });
  ipcMain.handle(DESKTOP_CHANNELS.downloadUpdate, (event: IpcMainInvokeEvent) => { trustedSender(event); return updater.download(); });
  ipcMain.handle(DESKTOP_CHANNELS.installUpdate, (event: IpcMainInvokeEvent) => { trustedSender(event); return updater.requestInstall(); });
  ipcMain.handle(DESKTOP_CHANNELS.openReleases, async (event: IpcMainInvokeEvent) => {
    trustedSender(event);
    const url = updater.snapshot().releaseUrl;
    if (url) await shell.openExternal(url);
  });
}

function rebuildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: t('file'), submenu: [{ id: 'quit', label: t('quit'), accelerator: 'CmdOrCtrl+Q', click: () => { requestExit('quit'); } }] },
    { label: t('edit'), submenu: [{ role: 'undo', label: t('undo') }, { role: 'redo', label: t('redo') }, { type: 'separator' }, { role: 'cut', label: t('cut') }, { role: 'copy', label: t('copy') }, { role: 'paste', label: t('paste') }, { role: 'selectAll', label: t('selectAll') }] },
    { label: t('view'), submenu: [{ role: 'resetZoom', label: t('actualSize') }, { role: 'zoomIn', label: t('zoomIn') }, { role: 'zoomOut', label: t('zoomOut') }, { role: 'togglefullscreen', label: t('fullscreen') }] },
    { label: t('help'), submenu: [{ label: t('about'), click: () => { if (window) void dialog.showMessageBox(window, { type: 'info', title: 'AI Project Hub', message: `AI Project Hub ${APP_VERSION}`, detail: t('aboutDetail') }); } }] },
  ]));
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) { lifecycle.setTrayAvailable(false); return; }
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { id: 'open', label: t('open'), click: showWindow },
      { type: 'separator' },
      { id: 'quit', label: t('quit'), click: () => { requestExit('quit'); } },
    ]));
    lifecycle.setTrayAvailable(true);
  } catch (error) {
    lifecycle.setTrayAvailable(false);
    tray.destroy(); tray = null;
    console.error('Could not configure the system tray:', error);
    if (window && !window.isDestroyed()) revealWindow(window);
  }
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(join(app.getAppPath(), 'icon.png'));
    if (image.isEmpty()) throw new Error('The application tray icon is unavailable.');
    tray = new Tray(image);
    tray.setToolTip('AI Project Hub');
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    rebuildTrayMenu();
  } catch (error) {
    lifecycle.setTrayAvailable(false);
    tray?.destroy(); tray = null;
    // Close falls back to the guarded real-quit path instead of orphaning a hidden app.
    console.error('Could not create the system tray:', error);
  }
}

function loadReleaseSource(): ReleaseSource | null {
  try {
    const source = JSON.parse(readFileSync(join(app.getAppPath(), 'release-source.json'), 'utf8')) as ReleaseSource | null;
    return source && typeof source.owner === 'string' && typeof source.repo === 'string' && releaseUrl(source) ? source : null;
  } catch { return null; }
}

function configureUpdater() {
  const source = loadReleaseSource();
  let reason: UpdateUnavailableReason | undefined;
  let installed = false;
  try {
    installed = readFileSync(join(process.resourcesPath, 'hub-nsis-install'), 'utf8') === 'local.aiprojecthub.desktop'
      && existsSync(join(dirname(app.getPath('exe')), 'Uninstall AI Project Hub.exe'));
  } catch { /* An unpacked or portable build has no installation marker. */ }
  if (process.platform !== 'win32') reason = 'unsupported-platform';
  else if (!app.isPackaged) reason = 'development';
  else if (process.env.PORTABLE_EXECUTABLE_DIR) reason = 'portable';
  else if (!installed) reason = 'unpacked';
  else if (dataDir.toLowerCase() !== resolve(defaultDataDirectory()).toLowerCase()) reason = 'custom-data-dir';
  updater = new UpdateController({
    currentVersion: APP_VERSION, source, unavailable: reason,
    ...(source && !reason ? { adapter: new NsisUpdater() } : {}),
    changed: (state: UpdateState) => {
      if (window && !window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.updateState, state);
      else if (disposed && state.status === 'error') { dialog.showErrorBox(t('updateFailed'), state.error || t('error')); app.quit(); }
    },
    requestClose: () => {
      setImmediate(() => {
        if (updater.installationPending && !requestExit('update')) updater.cancelInstall();
      });
    },
  });
}

function createMainWindow(): Promise<void> {
  if (creatingWindow) return creatingWindow;
  if (!runtime || lifecycle.exiting || window && !window.isDestroyed()) return Promise.resolve();
  const origin = runtime.origin;
  creatingWindow = (async () => {
    // Recovery uses the same backend but a fresh, equally restricted renderer session.
    const isolatedSession = session.fromPartition(`hub-${randomUUID()}`);
    await isolatedSession.setProxy({ mode: 'direct' });
    if (lifecycle.exiting) return;
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const owner = new BrowserWindow({
      width: Math.min(1380, workArea.width), height: Math.min(920, workArea.height), minWidth: 760, minHeight: 580,
      title: 'AI Project Hub', backgroundColor: '#F5F7FB', show: false, icon: join(app.getAppPath(), 'icon.png'),
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'), session: isolatedSession,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        webviewTag: false, spellcheck: false, devTools: !app.isPackaged,
      },
    });
    window = owner;
    const contents = owner.webContents;
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = window === owner && !owner.isDestroyed() && details.webContentsId === contents.id && (isAppUrl(details.url, origin) || details.url.startsWith(`blob:${origin}/`) || details.url.startsWith('data:'));
      callback({ cancel: !allowed });
    });
    isolatedSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      if (window !== owner || owner.isDestroyed() || details.webContentsId !== contents.id || !isAppUrl(details.url, origin)) { callback({ cancel: true }); return; }
      // The renderer never receives the key; it is not stored in a URL or cookie.
      callback({ requestHeaders: { ...details.requestHeaders, [DESKTOP_KEY_HEADER]: desktopSecret } });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (!isMainDocumentUrl(url, origin)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!isMainDocumentUrl(url, origin)) event.preventDefault(); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('render-process-gone', () => {
      // A crashed renderer cannot answer beforeunload; the existing intent decides recover vs exit.
      if (window === owner) owner.destroy();
    });
    contents.on('will-prevent-unload', event => {
      if (window !== owner || owner.isDestroyed()) return;
      const choice = dialog.showMessageBoxSync(owner, {
        type: 'warning', title: t('unsaved'), message: t('closeQuestion'),
        detail: t('closeDetail'), buttons: [t('continueEditing'), t('discardClose')], defaultId: 0, cancelId: 0, noLink: true,
      });
      // Electron's event is inverted: preventing will-prevent-unload allows closing.
      if (choice === 1) event.preventDefault();
      else {
        lifecycle.cancelClose();
        updater.cancelInstall();
        revealWindow(owner);
      }
    });
    owner.on('close', event => {
      lifecycle.setTrayAvailable(!!tray && !tray.isDestroyed());
      if (lifecycle.windowClose() === 'hide') { event.preventDefault(); owner.hide(); }
    });
    owner.on('show', reportActivity);
    owner.on('hide', reportActivity);
    owner.on('minimize', reportActivity);
    owner.on('restore', reportActivity);
    owner.once('ready-to-show', () => { if (!lifecycle.exiting && window === owner) owner.show(); });
    owner.on('closed', () => {
      if (window === owner) window = null;
      reportActivity();
      // No IPC handlers are installed here: the single bridge always validates the current window.
      isolatedSession.webRequest.onBeforeRequest(null);
      isolatedSession.webRequest.onBeforeSendHeaders(null);
    });
    reportActivity();
    try { await owner.loadURL(origin + '/'); }
    catch (error) { if (!lifecycle.exiting && !owner.isDestroyed()) throw error; }
  })().finally(() => { creatingWindow = undefined; });
  return creatingWindow;
}

async function start() {
  await app.whenReady();
  if (lifecycle.exiting) return;
  desktopSecret = randomBytes(32).toString('hex');
  startingRuntime = createHubRuntime({ dataDir, assetDirectory: join(app.getAppPath(), 'dist'), port: 0, mode: 'desktop', desktopSecret,
    deviceOptions: { codec: createCredentialCodec(safeStorage, process.platform, () => locale) },
    appOptions: { onSettingsChanged: settings => { locale = settings.locale; rebuildMenu(); } } });
  runtime = await startingRuntime;
  if (lifecycle.exiting) { await finishShutdown(); return; }
  locale = runtime.store.getSettings().locale;
  configureUpdater();
  // App-scoped handlers must not be registered again when recovering a lost window.
  installNativeBridge();
  rebuildMenu();
  createTray();
  powerMonitor.on('resume', () => { if (!lifecycle.exiting) runtime?.resumed(); });
  await createMainWindow();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', event => {
    if (disposed) return;
    event.preventDefault();
    // This is an explicit exit, unlike X. A canceled beforeunload leaves the backend alive.
    requestExit('quit');
  });
  app.on('window-all-closed', () => {
    if (lifecycle.allWindowsClosed() === 'shutdown') void finishShutdown();
    else {
      // Destruction/crashes are not permission to stop the runtime. Recreate a secured window.
      void (creatingWindow ?? Promise.resolve()).then(() => createMainWindow()).catch(startupFailed);
    }
  });
  void start().catch(startupFailed);
}
