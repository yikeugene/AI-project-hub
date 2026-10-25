import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import releaseSource from './release-source.cjs';
import { verifyMarkdownImport } from './markdown-import-smoke.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executableFlag = process.argv.indexOf('--executable');
const executableOverride = executableFlag < 0 ? undefined : process.argv[executableFlag + 1];
if (executableFlag >= 0 && (!executableOverride || !isAbsolute(executableOverride))) throw new Error('--executable requires an absolute executable path.');
const executable = executableOverride ?? join(root, 'release', 'win-unpacked', 'AI Project Hub.exe');
if (!existsSync(executable)) throw new Error('Executable not found. Run npm run pack:desktop first or pass --executable with an existing absolute path.');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'desktop-smoke-'));
const dataDir = join(work, 'data');
const projectPath = join(work, '桌面測試 Project'); await mkdir(projectPath);
await writeFile(join(projectPath, 'README.md'), '# Disposable native UI fixture\n');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
// The automation uses host Node, but the launched application must not need it on PATH.
if (process.platform === 'win32') {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  const windows = process.env.SystemRoot || 'C:\\Windows';
  env.PATH = `${join(windows, 'System32')};${windows}`;
}
let desktop;
const errors = [];
const report = { work, executable, checks: [], skippedChecks: [] };
const allowUnavailableClipboard = process.argv.includes('--allow-unavailable-clipboard');
const checked = message => { report.checks.push(message); console.log('PASS:', message); };
async function launch(locale = 'en') {
  desktop = await _electron.launch({ executablePath: executable, args: ['--data-dir', dataDir], env, timeout: 45000 });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: locale === 'en' ? 'Pick up your work' : '接回手上的工作', exact: true }).waitFor();
  await page.waitForFunction(expected => document.documentElement.lang === expected && !document.querySelector('.language-toggle button')?.disabled, locale);
  // Test-only observation of genuine Tray instances/menus. No production IPC or debug switch.
  await desktop.evaluate(({ Tray }) => {
    const setContextMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.__smokeTray = this; globalThis.__smokeTrayMenu = menu;
      return setContextMenu.call(this, menu);
    };
  });
  return page;
}
async function quitDesktop() {
  const closing = desktop.waitForEvent('close');
  void closing.catch(() => {});
  await desktop.evaluate(({ Menu }) => {
    const quit = Menu.getApplicationMenu()?.getMenuItemById('quit');
    if (!quit) throw new Error('Native File / Quit menu item is missing.');
    quit.click();
  });
  await closing;
  desktop = undefined;
}
async function waitForNative(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await desktop.evaluate(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Native lifecycle did not reach the expected state.');
}
async function scopedRead(page, profileId, path) {
  assert.ok(profileId, `A captured group is required for ${path}`);
  const response = await page.evaluate(async ({ profileId, path }) => {
    const result = await fetch(path, { headers: { 'X-Hub-Profile-Id': profileId } });
    return { status: result.status, data: await result.json() };
  }, { profileId, path });
  assert.equal(response.status, 200, `Scoped GET ${path}: ${JSON.stringify(response.data)}`);
  return response.data;
}
async function switchLanguage(page, locale) {
  await page.locator('.language-toggle').getByRole('button', { name: locale === 'en' ? 'English' : '繁體中文', exact: true }).click();
  await page.waitForFunction(expected => document.documentElement.lang === expected && !document.querySelector('.language-toggle button')?.disabled, locale);
  assert.equal(await page.locator(`.language-toggle button[lang="${locale}"]`).getAttribute('aria-pressed'), 'true');
  assert.equal((await page.evaluate(async () => (await fetch('/api/workspace')).json())).settings.locale, locale);
}
async function assertNativeLanguage(locale) {
  const labels = await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(item => item.label));
  assert.deepEqual(labels, locale === 'en' ? ['File', 'Edit', 'View', 'Help'] : ['檔案', '編輯', '檢視', '說明']);
  const trayLabels = await desktop.evaluate(() => globalThis.__smokeTrayMenu?.items.filter(item => item.type !== 'separator').map(item => item.label));
  // The observer is installed after launch; subsequent language saves rebuild the real tray menu.
  if (trayLabels) assert.deepEqual(trayLabels, locale === 'en' ? ['Open AI Project Hub', 'Quit AI Project Hub'] : ['開啟 AI Project Hub', '完全退出 AI Project Hub']);
}
async function captureLanguageLayout(page, locale) {
  await page.screenshot({ path: join(work, `desktop-initial-${locale}.png`) });
  const original = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      toggle: [...document.querySelectorAll('.language-toggle button')].map(button => { const box = button.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }),
      chrome: ['.topbar', '.main-nav'].map(selector => { const node = document.querySelector(selector); return { selector, width: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: getComputedStyle(node).overflowX }; }),
    }));
    assert.ok(layout.document <= layout.viewport + 1, `${locale} narrow document must not overflow horizontally`);
    assert.equal(layout.toggle.length, 2);
    for (const button of layout.toggle) assert.ok(button.width > 0 && button.left >= 0 && button.right <= layout.viewport + 1, `${locale} language buttons must stay visible`);
    for (const area of layout.chrome) {
      // Narrow navigation intentionally scrolls; the page/header must not overflow.
      if (area.selector === '.main-nav' && area.scrollWidth > area.width + 1) {
        assert.ok(['auto', 'scroll'].includes(area.overflowX), `${locale} narrow navigation must remain scrollable`);
        const reachable = await page.locator('.main-nav').evaluate(node => {
          node.scrollLeft = node.scrollWidth;
          const last = node.querySelector('.nav-item:last-child').getBoundingClientRect();
          const bounds = node.getBoundingClientRect();
          const visible = last.left >= bounds.left - 1 && last.right <= bounds.right + 1;
          node.scrollLeft = 0;
          return visible;
        });
        assert.ok(reachable, `${locale} last navigation item must be reachable by scrolling`);
      } else assert.ok(area.scrollWidth <= area.width + 1, `${locale} ${area.selector} must not clip translated text`);
    }
    await page.screenshot({ path: join(work, `desktop-narrow-${locale}.png`) });
  } finally { await page.setViewportSize(original); }
  checked(`${locale} desktop and 390px layouts keep both language controls visible without horizontal overflow`);
}
try {
  let page = await launch();
  const runtime = await desktop.evaluate(({ BrowserWindow, app }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version; db.close();
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { electron: process.versions.electron, node: process.versions.node, sqlite, sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, packaged: app.isPackaged };
  });
  assert.equal(runtime.packaged, true); assert.equal(runtime.sandbox, true); assert.equal(runtime.contextIsolation, true); assert.equal(runtime.nodeIntegration, false);
  report.runtime = runtime; checked('Packaged Electron imports and queries its own node:sqlite; renderer sandbox enabled');
  const vaultCheck = await desktop.evaluate(({ safeStorage }) => {
    const text = 'Disposable HelpTool credential verification';
    const encrypted = safeStorage.encryptString(text);
    return { available: safeStorage.isEncryptionAvailable(), cipher: encrypted.toString('base64'), opaque: !encrypted.includes(Buffer.from(text)), roundTrip: safeStorage.decryptString(encrypted) === text };
  });
  assert.equal(vaultCheck.available, true); assert.equal(vaultCheck.opaque, true); assert.equal(vaultCheck.roundTrip, true);
  checked('Packaged Electron encrypts and decrypts disposable credentials with actual OS safeStorage');
  const bridge = await page.evaluate(() => ({ methods: Object.keys(window.hubDesktop ?? {}), process: typeof window.process, require: typeof window.require }));
  assert.deepEqual(bridge.methods.sort(), ['chooseDirectory', 'saveText', 'writeClipboard', 'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'openReleases', 'onUpdateState'].sort()); assert.equal(bridge.process, 'undefined'); assert.equal(bridge.require, 'undefined');
  checked('Renderer exposes only the allowlisted native and updater bridge methods, with no Node access');
  let origin = new URL(page.url()).origin;
  assert.equal((await fetch(origin + '/api/workspace')).status, 401); assert.equal((await fetch(origin)).status, 401);
  checked('An ordinary local client cannot read native API or assets without the session secret');
  const initial = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.equal(initial.environment.mode, 'desktop'); assert.equal(initial.projects.length, 0); assert.equal(initial.settings.locale, 'en'); report.desktopApps = initial.environment.desktopApps;
  assert.equal(await page.title(), 'AI Project Hub — Development workspace');
  await assertNativeLanguage('en');
  checked('Fresh native workspace defaults to English, including document metadata and native menus');
  await captureLanguageLayout(page, 'en');
  const initialUpdate = await page.evaluate(() => window.hubDesktop.getUpdateState());
  const source = releaseSource.getReleaseSource();
  const releaseUrl = source ? `https://github.com/${source.owner}/${source.repo}/releases/latest` : null;
  const packagedMode = await desktop.evaluate(({ app }) => {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable';
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const installed = fs.existsSync(path.join(process.resourcesPath, 'hub-nsis-install'))
      && fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall AI Project Hub.exe'));
    return installed ? 'custom-data-dir' : 'unpacked';
  });
  assert.deepEqual(initialUpdate, { status: 'unavailable', reason: source ? packagedMode : 'unconfigured', currentVersion: initial.environment.version, releaseUrl, revision: 0 });
  await desktop.evaluate(({ shell }) => {
    globalThis.__smokeOriginalOpenExternal = shell.openExternal;
    globalThis.__smokeExternalCalls = [];
    shell.openExternal = async url => { globalThis.__smokeExternalCalls.push(url); };
  });
  try {
    const inertUpdates = await page.evaluate(async () => {
      const ignoredUrl = 'https://updates.example.invalid/not-a-configured-source';
      const check = await window.hubDesktop.checkForUpdates(ignoredUrl);
      const download = await window.hubDesktop.downloadUpdate(ignoredUrl);
      const install = await window.hubDesktop.installUpdate(ignoredUrl);
      await window.hubDesktop.openReleases(ignoredUrl);
      return { check, download, install };
    });
    for (const value of Object.values(inertUpdates)) assert.deepEqual(value, initialUpdate);
    assert.deepEqual(await desktop.evaluate(() => globalThis.__smokeExternalCalls), releaseUrl ? [releaseUrl] : []);
    assert.equal(page.isClosed(), false);
  } finally { await desktop.evaluate(({ shell }) => { shell.openExternal = globalThis.__smokeOriginalOpenExternal; delete globalThis.__smokeOriginalOpenExternal; delete globalThis.__smokeExternalCalls; }); }
  checked('Isolated updater actions are inert; release navigation uses only the configured URL and never closes the app');
  await desktop.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (_owner, options) => { globalThis.__smokeOpenOptions = options; return { canceled: true, filePaths: [] }; };
    dialog.showSaveDialog = async (_owner, options) => { globalThis.__smokeSaveOptions = options; return { canceled: true }; };
  });
  assert.equal(await page.evaluate(() => window.hubDesktop.chooseDirectory()), null);
  assert.equal(await page.evaluate(() => window.hubDesktop.saveText({ filename: 'language-test.txt', text: 'not written' })), false);
  const englishDialogs = await desktop.evaluate(() => ({ open: globalThis.__smokeOpenOptions, save: globalThis.__smokeSaveOptions }));
  assert.equal(englishDialogs.open.title, 'Choose a local project folder');
  assert.equal(englishDialogs.save.title, 'Save handoff document');
  assert.equal(englishDialogs.save.filters[0].name, 'Text document');
  checked('Native folder and save dialogs use English on a fresh profile; canceled dialogs write no files');
  const initialDevices = await page.evaluate(async () => (await fetch('/api/devices')).json());
  assert.equal(initialDevices.desktopAvailable, true); assert.equal(initialDevices.enabled, false); assert.equal(initialDevices.paired, false); assert.deepEqual(initialDevices.sharing, []);
  assert.equal(initialDevices.profileId, null); assert.deepEqual(initialDevices.groups, []); assert.equal(initialDevices.installationId, initialDevices.localDevice.id);
  const deviceGuard = await page.evaluate(async () => (await fetch('/api/devices/local', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'must-not-save' }) })).status);
  assert.equal(deviceGuard, 403); checked('Device cloud integration defaults off and device mutations retain the local request-token guard');
  await switchLanguage(page, 'zh-TW');
  await page.getByRole('heading', { name: '接回手上的工作', exact: true }).waitFor();
  assert.equal(await page.title(), 'AI Project Hub — 開發工作台');
  await assertNativeLanguage('zh-TW');
  checked('Saved language toggle switches renderer, metadata, and native menus to Traditional Chinese without restarting');
  await captureLanguageLayout(page, 'zh-TW');
  await page.locator('.main-nav').getByRole('button', { name: '工作台設定', exact: true }).click();
  const deviceName = page.locator('.device-name-form input');
  await deviceName.waitFor();
  assert.equal(await page.locator('form form').count(), 0);
  assert.equal(await page.locator('form.settings-form').count(), 1); assert.equal(await page.locator('form.device-name-form').count(), 1); assert.equal(await page.locator('form.pairing-form').count(), 1);
  const savedDeviceName = '桌面驗證設備';
  await deviceName.fill(savedDeviceName);
  await page.getByRole('button', { name: '儲存設備名稱', exact: true }).click();
  await page.getByText('本機設備名稱已儲存。', { exact: true }).waitFor();
  assert.equal((await page.evaluate(async () => (await fetch('/api/devices')).json())).localDevice.name, savedDeviceName);
  const localPreference = page.locator('.settings-form textarea');
  const originalRoots = await localPreference.inputValue();
  await localPreference.fill('C:\\Isolated Unsaved Settings');
  await deviceName.fill('Language switch 設備草稿');
  const savedPreferences = (await page.evaluate(async () => (await fetch('/api/workspace')).json())).settings;
  await switchLanguage(page, 'en');
  await assertNativeLanguage('en');
  assert.equal(await localPreference.inputValue(), 'C:\\Isolated Unsaved Settings');
  assert.equal(await deviceName.inputValue(), 'Language switch 設備草稿');
  await page.getByRole('heading', { name: 'Workspace settings', exact: true }).waitFor();
  await switchLanguage(page, 'zh-TW');
  await assertNativeLanguage('zh-TW');
  assert.equal(await localPreference.inputValue(), 'C:\\Isolated Unsaved Settings');
  assert.equal(await deviceName.inputValue(), 'Language switch 設備草稿');
  const afterLanguage = (await page.evaluate(async () => (await fetch('/api/workspace')).json())).settings;
  assert.deepEqual(afterLanguage, { ...savedPreferences, locale: 'zh-TW' });
  assert.equal((await page.evaluate(async () => (await fetch('/api/devices')).json())).localDevice.name, savedDeviceName);
  await deviceName.fill(savedDeviceName);
  checked('Switching both languages keeps unsaved settings/device drafts and saves only the locale preference');
  await page.locator('.main-nav').getByRole('button', { name: '收件匣', exact: true }).click();
  const settingsGuard = page.getByRole('dialog', { name: '設定尚未儲存', exact: true });
  await settingsGuard.waitFor(); await settingsGuard.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await localPreference.inputValue(), 'C:\\Isolated Unsaved Settings');
  await localPreference.fill(originalRoots);
  await deviceName.fill('尚未儲存的設備名稱');
  await page.locator('.main-nav').getByRole('button', { name: '收件匣', exact: true }).click();
  await settingsGuard.waitFor(); await settingsGuard.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await deviceName.inputValue(), '尚未儲存的設備名稱');
  await deviceName.fill(savedDeviceName);
  checked('Local preferences and device forms are independent, persist names, and both retain navigation draft guards');
  await page.locator('.main-nav').getByRole('button', { name: /^專案總覽/ }).click();

  // Only native dialog selections are stubbed; production IPC validation and file writes still execute.
  await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async (_owner, options) => { globalThis.__smokeOpenOptions = options; return { canceled: false, filePaths: [path] }; }; }, projectPath);
  await page.getByRole('button', { name: '新增專案', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增本機專案', exact: true });
  await form.getByRole('button', { name: '選擇資料夾', exact: true }).click();
  await page.waitForFunction(path => document.querySelector('dialog[open] input[maxlength="4096"]')?.value === path, projectPath);
  assert.equal(await form.locator('input[maxlength="4096"]').inputValue(), projectPath);
  assert.equal(await desktop.evaluate(() => globalThis.__smokeOpenOptions.title), '選擇本機專案資料夾');
  await form.getByPlaceholder('這個專案叫什麼名字？').fill('Desktop Round Trip');
  await form.getByRole('button', { name: '加入工作台', exact: true }).click();
  await page.getByRole('button', { name: '開啟專案：Desktop Round Trip', exact: true }).click();
  checked('Native folder-picker IPC populates Unicode/space path and UI creates the project');

  await page.locator('.detail-tabs').getByRole('button', { name: 'AI 交接', exact: true }).click();
  const handoff = page.locator('.project-detail .handoff-panel');
  assert.equal(await handoff.getByLabel('交接對象').inputValue(), 'claude-desktop');
  await handoff.getByLabel('交接對象').selectOption('chatgpt-desktop');
  await page.waitForFunction(() => document.querySelector('[aria-label="交接 Markdown 預覽"]')?.textContent?.includes('交接對象：ChatGPT Desktop'));
  await handoff.getByRole('button', { name: '只複製交接內容', exact: true }).click();
  await handoff.getByText('交接內容已複製。請在對話中自行貼上、檢查，再按下傳送。', { exact: true }).waitFor();
  const expectedMarkdown = (await handoff.getByLabel('交接 Markdown 預覽', { exact: true }).textContent() ?? '').replace(/\r\n/g, '\n');
  let copied = '', clipboardVerified = false;
  for (let attempt = 0; attempt < 2 && !clipboardVerified; attempt++) {
    if (attempt) {
      console.log('NOTE: Clipboard did not return the current fixture; retrying the real copy button once.');
      await handoff.getByRole('button', { name: '再次複製交接內容', exact: true }).click();
      await handoff.getByText('交接內容已複製。請在對話中自行貼上、檢查，再按下傳送。', { exact: true }).waitFor();
    }
    for (let read = 0; read < 20 && !clipboardVerified; read++) {
      copied = (await desktop.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n');
      clipboardVerified = copied === expectedMarkdown;
      if (!clipboardVerified) await page.waitForTimeout(50);
    }
  }
  if (!clipboardVerified && allowUnavailableClipboard) {
    const osClipboardWorks = await desktop.evaluate(async ({ clipboard }) => {
      const probe = `Disposable HelpTool direct OS clipboard probe ${Date.now()}-${Math.random()}`;
      await clipboard.writeText(probe);
      return (await clipboard.readText()) === probe;
    });
    if (!osClipboardWorks) {
      report.skippedChecks.push('Native clipboard readback: direct OS write/read also failed; no success is claimed.');
      console.warn('SKIP: Native clipboard readback is unavailable in this host session; continuing only because --allow-unavailable-clipboard was explicit.');
      copied = expectedMarkdown;
    }
  }
  assert.ok(copied === expectedMarkdown && copied.includes('交接對象：ChatGPT Desktop'), 'Native clipboard must match this exact fixture, not a previous project; actual clipboard text is not logged.');
  if (!report.skippedChecks.length) checked('Desktop target prompt copies through native clipboard without opening or sending to a chat app');
  else checked('Desktop handoff preview contains the expected fixture context; unavailable OS clipboard readback is excluded');

  const template = copied.split('## JSON 回傳範本\n')[1].trim();
  const state = JSON.parse(template.replace(/^```json\s*\n/i, '').replace(/\n```$/, ''));
  state.memory.status = '桌面版往返驗證完成；這是隔離測試資料。'; state.nextAction = '確認桌面交接可繼續使用';
  const text = '```json\n' + JSON.stringify(state, null, 2) + '\n```';
  await handoff.getByLabel('AI 回傳的 JSON', { exact: true }).fill(text);
  await handoff.getByRole('button', { name: '預覽匯入差異', exact: true }).click();
  await handoff.getByRole('button', { name: '確認匯入內容', exact: true }).waitFor();
  await handoff.getByLabel('AI 回傳的 JSON', { exact: true }).fill(text + '\n');
  await handoff.locator('.shared-preview').waitFor({ state: 'detached' });
  await handoff.getByRole('button', { name: '預覽匯入差異', exact: true }).click();
  await handoff.getByRole('button', { name: '確認匯入內容', exact: true }).click();
  await page.getByRole('dialog', { name: '匯入 AI 回傳的脈絡？', exact: true }).getByRole('button', { name: '匯入記憶與下一步', exact: true }).click();
  await handoff.getByText('記憶與下一步行動已匯入，工作台內容已更新。', { exact: true }).waitFor();
  let workspace = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.equal(workspace.projects[0].memory.status, state.memory.status); assert.equal(workspace.projects[0].nextAction, state.nextAction);
  checked('Paste preview invalidates on edit; explicit confirmed import updates only reviewed state');
  await page.screenshot({ path: join(work, 'desktop-handoff.png') });

  const savedPath = join(work, 'native-handoff.md');
  await desktop.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async (_owner, options) => { globalThis.__smokeSaveOptions = options; return { canceled: false, filePath: path }; }; }, savedPath);
  await handoff.locator('.advanced-handoff > summary').click();
  await handoff.getByRole('button', { name: '下載 Markdown', exact: true }).click();
  await handoff.getByText('Markdown 已另存。', { exact: true }).waitFor();
  assert.match(await readFile(savedPath, 'utf8'), /^# Desktop Round Trip — 工作交接/);
  assert.equal(await desktop.evaluate(() => globalThis.__smokeSaveOptions.title), '儲存交接文件');
  checked('Native save IPC uses the selected language and writes the user-selected Markdown file (dialog selection stubbed)');

  await page.locator('.detail-tabs').getByRole('button', { name: '專案記憶', exact: true }).click();
  await page.getByRole('textbox', { name: '目前開發狀態', exact: true }).fill('尚未儲存的桌面草稿');
  const originalWindow = await desktop.evaluate(({ BrowserWindow }) => ({ id: BrowserWindow.getAllWindows()[0].id, renderer: BrowserWindow.getAllWindows()[0].webContents.id }));
  await desktop.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBoxSync = (_owner, options) => { globalThis.__smokeCloseOptions = options; return 0; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await waitForNative(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1 && !BrowserWindow.getAllWindows()[0].isVisible());
  assert.equal(page.isClosed(), false);
  assert.equal(await desktop.evaluate(() => globalThis.__smokeCloseOptions), undefined);
  assert.equal(await page.getByRole('textbox', { name: '目前開發狀態', exact: true }).inputValue(), '尚未儲存的桌面草稿');
  assert.equal(await page.evaluate(async () => (await fetch('/api/workspace')).status), 200);
  assert.equal((await fetch(origin + '/api/workspace')).status, 401);
  checked('X hides the original dirty renderer without a discard prompt; backend remains available only to the trusted session');
  await desktop.evaluate(() => {
    const open = globalThis.__smokeTrayMenu?.getMenuItemById('open');
    if (!open || globalThis.__smokeTray.isDestroyed()) throw new Error('Working tray Open callback is missing.');
    open.click();
  });
  await waitForNative(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible());
  assert.deepEqual(await desktop.evaluate(({ BrowserWindow }) => ({ id: BrowserWindow.getAllWindows()[0].id, renderer: BrowserWindow.getAllWindows()[0].webContents.id })), originalWindow);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const secondInstance = spawnSync(executable, ['--data-dir', dataDir], { env, stdio: 'ignore', timeout: 30000 });
  assert.equal(secondInstance.status, 0, secondInstance.error?.message);
  await waitForNative(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible());
  assert.deepEqual(await desktop.evaluate(({ BrowserWindow }) => ({ id: BrowserWindow.getAllWindows()[0].id, renderer: BrowserWindow.getAllWindows()[0].webContents.id })), originalWindow);
  checked('Localized tray Open and a second process restore the original window/renderer, preserving its draft');
  await desktop.evaluate(({ BrowserWindow, Menu }) => {
    BrowserWindow.getAllWindows()[0].close();
    Menu.getApplicationMenu().getMenuItemById('quit').click();
  });
  await waitForNative(() => !!globalThis.__smokeCloseOptions);
  const closeOptions = await desktop.evaluate(() => globalThis.__smokeCloseOptions);
  assert.equal(closeOptions.title, '還有尚未儲存的內容');
  assert.deepEqual(closeOptions.buttons, ['繼續編輯', '捨棄變更並關閉']);
  assert.equal(await page.getByRole('textbox', { name: '目前開發狀態', exact: true }).inputValue(), '尚未儲存的桌面草稿');
  assert.equal(await page.evaluate(async () => (await fetch('/api/workspace')).status), 200);
  await waitForNative(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible());
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitForNative(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible());
  await desktop.evaluate(() => globalThis.__smokeTray.emit('click'));
  await waitForNative(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible());
  await page.getByRole('textbox', { name: '目前開發狀態', exact: true }).fill(state.memory.status);
  checked('Canceled File Quit restores access, preserves drafts/backend, resets X to hide, and tray click restores it again');
  await page.getByRole('button', { name: '關閉Desktop Round Trip', exact: true }).click();
  await page.screenshot({ path: join(work, 'desktop-dashboard.png') });
  await quitDesktop();
  await assert.rejects(fetch(origin + '/api/workspace')); checked('Explicit native File Quit drains the desktop runtime and releases its listener');

  // Append real cache records only while this disposable app is CLOSED; no route interception or production bypass.
  const seeded = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'device-fixtures.ts'), '--data-dir', dataDir, '--app-closed'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  const fixture = JSON.parse(seeded.stdout);
  assert.equal(fixture.enabled, false); assert.equal(fixture.usableCredentials, false);
  report.deviceFixture = fixture;
  page = await launch('zh-TW');
  await assertNativeLanguage('zh-TW');
  assert.equal((await page.evaluate(async () => (await fetch('/api/workspace')).json())).settings.locale, 'zh-TW');
  assert.equal(await page.title(), 'AI Project Hub — 開發工作台');
  checked('Saved Traditional Chinese preference survives a full restart, including native menus and document metadata');
  const recoveredCredential = await desktop.evaluate(({ safeStorage }, cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')), vaultCheck.cipher);
  assert.equal(recoveredCredential, 'Disposable HelpTool credential verification');
  checked('OS-encrypted disposable credentials decrypt after the packaged application restarts');
  workspace = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.equal(workspace.projects.length, 1); assert.equal(workspace.projects[0].memory.status, state.memory.status);
  // This installation-level read deliberately captures the seeded management group once.
  // All subsequent group-specific reads/mutations bind that immutable profile ID.
  const reopenedDevices = await page.evaluate(async () => (await fetch('/api/devices')).json());
  assert.equal(reopenedDevices.localDevice.name, savedDeviceName); assert.equal(reopenedDevices.enabled, false);
  assert.equal(reopenedDevices.installationId, initialDevices.installationId); assert.equal(reopenedDevices.groups.length, 1);
  const fixtureGroup = reopenedDevices.groups[0], profileId = fixtureGroup.id;
  assert.equal(reopenedDevices.profileId, profileId); assert.equal(fixtureGroup.paired, true); assert.equal(fixtureGroup.enabled, false);
  assert.equal((await scopedRead(page, profileId, '/api/devices')).profileId, profileId);
  await desktop.evaluate(() => {
    // Test-only network guard: cached browsing must not contact a relay or any cloud service.
    globalThis.__smokeCacheNetwork = [];
    globalThis.fetch = async input => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      globalThis.__smokeCacheNetwork.push(`${url.origin}${url.pathname}`);
      throw new Error('Unexpected network request denied by isolated cached-workspace smoke.');
    };
  });
  checked('The packaged application reopens SQLite with saved local memory, installation identity, device name, and one explicitly captured paused group');
  const firstPeer = page.locator(`.device-nav-item[title*="${fixture.deviceIds[0]}"]`);
  const secondPeer = page.locator(`.device-nav-item[title*="${fixture.deviceIds[1]}"]`);
  await firstPeer.click();
  await page.getByRole('heading', { name: '遠端唯讀驗證專案', exact: true }).waitFor();
  assert.equal(await page.locator('.project-detail').count(), 0);
  assert.equal(await page.getByRole('button', { name: '新增專案', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '掃描專案', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '更新狀態', exact: true }).count(), 0);
  assert.equal(await page.locator('.remote-project-detail input, .remote-project-detail textarea, .remote-project-detail .quick-actions').count(), 0);
  assert.equal((await page.locator('.remote-projects-panel').textContent()).includes(projectPath), false);
  const remoteCache = await scopedRead(page, profileId, `/api/devices/${fixture.deviceIds[0]}/projects`);
  assert.equal(remoteCache[0].projectId, workspace.projects[0].id); assert.equal(remoteCache[0].ownerDeviceId, fixture.deviceIds[0]);
  await secondPeer.click();
  await page.getByRole('heading', { name: '另一台設備的同 ID 專案', exact: true }).waitFor();
  await firstPeer.click();
  await page.getByRole('heading', { name: '遠端唯讀驗證專案', exact: true }).waitFor();
  checked('Real cached remote summaries remain read-only and isolated despite duplicate device names and colliding local project IDs');
  await page.getByRole('button', { name: '提出變更請求', exact: true }).click();
  const composer = page.getByRole('dialog', { name: '提出變更請求', exact: true });
  await composer.getByLabel('提議修改下一步行動', { exact: true }).check();
  await composer.getByRole('textbox', { name: '建議的下一步行動', exact: true }).fill('隔離煙霧測試的下一步建議');
  await composer.getByRole('button', { name: '關閉提出變更請求', exact: true }).click();
  const draftGuard = page.getByRole('dialog', { name: '訊息草稿尚未送出', exact: true });
  await draftGuard.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await composer.getByRole('textbox', { name: '建議的下一步行動', exact: true }).inputValue(), '隔離煙霧測試的下一步建議');
  await composer.getByRole('button', { name: '預覽變更請求', exact: true }).click();
  await page.getByRole('dialog', { name: '確認送出內容', exact: true }).getByRole('button', { name: '確認送出', exact: true }).click();
  await composer.waitFor({ state: 'detached' });
  const sent = await scopedRead(page, profileId, '/api/messages?box=sent');
  assert.equal(sent.length, 1); assert.equal(sent[0].delivery, 'queued'); assert.equal(sent[0].result, null);
  assert.equal(sent[0].payload.baseRevision, remoteCache[0].project.revision);
  assert.deepEqual(sent[0].payload.changes, { nextAction: '隔離煙霧測試的下一步建議' });
  await page.locator('.main-nav').getByRole('button', { name: '已送出', exact: true }).click();
  await page.locator('.message-detail').getByText('待送出', { exact: true }).waitFor();
  checked('Remote proposal composer preserves drafts, binds snapshot revision, and queues only selected changes without claiming execution');
  await page.locator('.main-nav').getByRole('button', { name: /^收件匣/ }).click();
  await page.getByRole('button', { name: '預覽本機差異', exact: true }).click();
  await page.locator('.proposal-preview').waitFor();
  assert.equal(await page.getByRole('button', { name: '接受這份變更', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '拒絕請求', exact: true }).click();
  await page.getByRole('dialog', { name: '拒絕這份變更請求？', exact: true }).getByRole('button', { name: '確認拒絕', exact: true }).click();
  await page.getByRole('dialog', { name: '拒絕這份變更請求？', exact: true }).waitFor({ state: 'detached' });
  await page.locator('.message-list-item').filter({ hasText: '這是一則可離線標記已讀的隔離測試訊息。' }).click();
  await page.getByRole('button', { name: '標記為已讀', exact: true }).click();
  await page.getByRole('button', { name: '標記為已讀', exact: true }).waitFor({ state: 'detached' });
  const inbox = await scopedRead(page, profileId, '/api/messages?box=inbox');
  assert.equal(inbox.find(item => item.id === fixture.proposalId).result.status, 'rejected');
  assert.equal(inbox.find(item => item.id === fixture.textMessageId).result.status, 'read');
  const unchanged = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.deepEqual(unchanged.projects[0].memory, workspace.projects[0].memory); assert.equal(unchanged.projects[0].revision, workspace.projects[0].revision); assert.equal(unchanged.projects.length, 1);
  checked('Inbox previews local diffs, blocks offline acceptance, and persists offline reject/read decisions without mutating projects');
  await page.screenshot({ path: join(work, 'desktop-device-inbox.png') });

  const sharedCache = await page.evaluate(async () => {
    const response = await fetch('/api/shared-workspace');
    if (!response.ok) throw new Error(`Shared workspace read failed: ${response.status}`);
    return response.json();
  });
  assert.deepEqual(sharedCache.groups.map(group => group.id), [profileId]); assert.equal(sharedCache.items.length, 3);
  assert.equal(new Set(sharedCache.items.map(item => JSON.stringify([item.profileId, item.ownerDeviceId, item.projectId]))).size, 3);
  assert.ok(sharedCache.items.every(item => item.profileId === profileId && item.projectId === fixture.projectId));
  const ownSummary = sharedCache.items.find(item => item.owned);
  const remoteSummary = sharedCache.items.find(item => item.ownerDeviceId === fixture.deviceIds[0]);
  const otherSummary = sharedCache.items.find(item => item.ownerDeviceId === fixture.deviceIds[1]);
  assert.ok(ownSummary); assert.ok(remoteSummary); assert.ok(otherSummary); assert.equal(ownSummary.ownerDeviceId, fixtureGroup.deviceId);
  assert.equal(ownSummary.pending, true); assert.equal(ownSummary.publishedAt, null);
  assert.deepEqual(remoteSummary.project, remoteCache[0].project); assert.equal(remoteSummary.version, remoteCache[0].version);
  await page.locator('.main-nav').getByRole('button', { name: '共享工作區', exact: true }).click();
  const sharedPanel = page.locator('.shared-workspace-panel'), sharedDetail = sharedPanel.locator('.shared-workspace-detail');
  const summaryRows = sharedPanel.locator('.remote-project-item');
  await summaryRows.first().waitFor(); assert.equal(await summaryRows.count(), sharedCache.items.length);
  // A group label may itself contain an owner's ID prefix. Match the exact
  // owner display and fixture project name, never arbitrary text across the row.
  const summaryRow = item => summaryRows.filter({ has: page.getByText(`${item.ownerName} (${item.ownerDeviceId.slice(0, 8)})`, { exact: true }) })
    .filter({ has: page.getByText(item.project.name, { exact: true }) });
  const ownRow = summaryRow(ownSummary);
  assert.equal(await ownRow.count(), 1);
  await ownRow.click();
  await sharedDetail.getByRole('heading', { name: ownSummary.project.name, exact: true }).waitFor();
  await sharedDetail.getByText('待同步，尚未發布', { exact: true }).waitFor();
  await sharedDetail.getByText('尚未發布', { exact: true }).waitFor();
  const remoteRow = summaryRow(remoteSummary);
  assert.equal(await remoteRow.count(), 1);
  assert.equal(await remoteRow.locator('span').first().textContent(), `${fixtureGroup.label}（${profileId.slice(0, 8)}）`);
  await remoteRow.click();
  await sharedDetail.getByRole('heading', { name: remoteSummary.project.name, exact: true }).waitFor();
  assert.equal((await sharedDetail.locator('.readonly-label').textContent()).trim(), '唯讀摘要');
  await sharedDetail.getByText(`本機群組 ID：${profileId}`, { exact: true }).waitFor();
  await sharedDetail.getByText(`擁有設備 ID：${remoteSummary.ownerDeviceId}`, { exact: true }).waitFor();
  const sourceLabels = await sharedDetail.locator('.shared-source-meta').evaluate(node => Object.fromEntries([...node.querySelectorAll(':scope > div')].map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])));
  assert.ok(sourceLabels['群組'].includes(fixtureGroup.label)); assert.ok(sourceLabels['擁有設備'].includes(remoteSummary.ownerName));
  assert.equal(sourceLabels['專案 ID'], remoteSummary.projectId);
  await sharedDetail.getByText(`${remoteSummary.version} / ${remoteSummary.project.revision}`, { exact: true }).waitFor();
  await sharedDetail.getByText('遠端摘要快取', { exact: true }).waitFor();
  await sharedDetail.getByText('這是本機最後取得的摘要，不是即時畫面。群組暫停或離線時，其他地方可能已有較新內容。', { exact: true }).waitFor();
  assert.equal(await sharedDetail.locator('input, textarea, select, [contenteditable="true"], .quick-actions').count(), 0);
  assert.deepEqual((await sharedDetail.getByRole('button').allTextContents()).sort(), ['AI 填寫 Prompt', '下載 Markdown'].sort());
  assert.equal(await page.locator('.project-detail').count(), 0);
  for (const name of ['新增專案', '掃描專案', '更新狀態', '提出變更請求', '確認匯入內容']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '同步所有群組', exact: true }).isDisabled(), true);
  assert.equal((await sharedPanel.textContent()).includes(projectPath), false);
  assert.equal(await sharedDetail.locator('.remote-memory h4').count(), 1);
  assert.equal(await sharedDetail.locator('.remote-memory h4').textContent(), '目前開發狀態');
  const otherRow = summaryRow(otherSummary);
  assert.equal(await otherRow.count(), 1); await otherRow.click();
  await sharedDetail.getByRole('heading', { name: '另一台設備的同 ID 專案', exact: true }).waitFor();
  await sharedDetail.getByText(`擁有設備 ID：${fixture.deviceIds[1]}`, { exact: true }).waitFor();
  const groupFilter = sharedPanel.locator('.shared-workspace-filters select');
  assert.equal(await groupFilter.count(), 1);
  await sharedPanel.getByText('依群組篩選', { exact: true }).waitFor();
  await groupFilter.selectOption(profileId);
  await sharedPanel.getByRole('searchbox', { name: '搜尋共享摘要', exact: true }).fill('no-match-isolated-shared-smoke');
  await sharedPanel.getByRole('heading', { name: '沒有符合條件的摘要', exact: true }).waitFor();
  await sharedPanel.getByRole('button', { name: '清除篩選', exact: true }).click();
  await remoteRow.click();
  // Deliberately inspect the management selection; aggregate filters must not change it.
  assert.equal((await page.evaluate(async () => (await fetch('/api/devices')).json())).profileId, profileId);
  await switchLanguage(page, 'en');
  await sharedPanel.getByRole('heading', { name: 'Shared workspace', exact: true }).waitFor();
  await sharedPanel.getByText('Filter by group', { exact: true }).waitFor();
  assert.equal(await groupFilter.inputValue(), '');
  assert.equal(await sharedPanel.getByRole('searchbox', { name: 'Search shared summaries', exact: true }).inputValue(), '');
  assert.equal((await sharedDetail.locator('.readonly-label').textContent()).trim(), 'Read-only summary');
  await sharedDetail.getByText(`Local group ID: ${profileId}`, { exact: true }).waitFor();
  await sharedDetail.getByRole('button', { name: 'Download Markdown', exact: true }).waitFor();
  await switchLanguage(page, 'zh-TW');
  checked('Shared workspace shows distinct source/group/owner/version labels, pending-own versus cached-remote status, safe read-only details, and bilingual filters without changing the management group');

  const summaryPath = join(work, 'native-shared-summary.md'), canceledSummaryPath = join(work, 'canceled-shared-summary.md');
  await desktop.evaluate(({ dialog }, path) => {
    globalThis.__smokeSharedSaveCalls = 0;
    dialog.showSaveDialog = async (_owner, options) => { globalThis.__smokeSharedSaveCalls++; globalThis.__smokeSaveOptions = options; return { canceled: false, filePath: path }; };
  }, summaryPath);
  const downloadKey = { profileId, ownerDeviceId: remoteSummary.ownerDeviceId, projectId: remoteSummary.projectId, version: remoteSummary.version };
  const waitForSummaryDownload = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/shared-workspace/download' && response.request().method() === 'POST');
  const summaryResponsePending = waitForSummaryDownload();
  await sharedDetail.getByRole('button', { name: '下載 Markdown', exact: true }).click();
  const summaryResponse = await summaryResponsePending;
  assert.equal(summaryResponse.status(), 200); assert.deepEqual(summaryResponse.request().postDataJSON(), downloadKey);
  const downloaded = await summaryResponse.json();
  await sharedDetail.getByText('Markdown 已儲存。', { exact: true }).waitFor();
  const savedSummary = await readFile(summaryPath, 'utf8');
  assert.equal(savedSummary, downloaded.text); assert.match(downloaded.filename, /^[^<>:"/\\|?*\x00-\x1f]+\.md$/);
  assert.match(savedSummary, /^# 遠端唯讀驗證專案\n/);
  assert.ok(savedSummary.includes(`(${profileId})`) && savedSummary.includes(`(${remoteSummary.ownerDeviceId})`));
  assert.ok(savedSummary.includes(`- 專案識別碼: ${remoteSummary.projectId}\n`) && savedSummary.includes(`- 共享版本: ${remoteSummary.version}\n`));
  assert.ok(savedSummary.includes(remoteSummary.project.memory.status));
  assert.deepEqual(savedSummary.split('\n').filter(line => line.startsWith('### ')), ['### 目前開發狀態']);
  for (const privateText of [projectPath, state.memory.status, state.nextAction, 'JSON 回傳範本', 'unusable-test-ciphertext']) assert.equal(savedSummary.includes(privateText), false);
  const summaryDialog = await desktop.evaluate(() => globalThis.__smokeSaveOptions);
  assert.equal(summaryDialog.title, '儲存交接文件'); assert.equal(summaryDialog.defaultPath.endsWith(downloaded.filename), true);
  assert.deepEqual(summaryDialog.filters, [{ name: 'Markdown', extensions: ['md'] }]);
  checked('Shared workspace revalidates the exact group/owner/project/version and saves only the allowlisted cached Markdown plus source metadata via genuine native IPC/file writing');
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async (_owner, options) => { globalThis.__smokeSharedSaveCalls++; globalThis.__smokeSaveOptions = options; return { canceled: true, filePath: path }; };
  }, canceledSummaryPath);
  const canceledResponsePending = waitForSummaryDownload();
  await sharedDetail.getByRole('button', { name: '下載 Markdown', exact: true }).click();
  const canceledResponse = await canceledResponsePending;
  assert.equal(canceledResponse.status(), 200); assert.deepEqual(canceledResponse.request().postDataJSON(), downloadKey);
  await waitForNative(() => globalThis.__smokeSharedSaveCalls === 2);
  await page.waitForFunction(() => {
    const detail = document.querySelector('.shared-workspace-detail');
    return detail && !detail.querySelector('button')?.disabled && !detail.querySelector('.inline-success');
  });
  assert.equal(existsSync(canceledSummaryPath), false); assert.equal(await readFile(summaryPath, 'utf8'), savedSummary);
  assert.equal(await sharedDetail.getByText('Markdown 已儲存。', { exact: true }).count(), 0);
  assert.equal(await sharedPanel.getByRole('alert').count(), 0);
  const afterDownloads = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.equal(afterDownloads.projects.length, 1); assert.equal(afterDownloads.projects[0].revision, workspace.projects[0].revision);
  assert.deepEqual(afterDownloads.projects[0].memory, workspace.projects[0].memory);
  assert.deepEqual(await desktop.evaluate(() => globalThis.__smokeCacheNetwork), []);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(work, 'desktop-shared-workspace.png'), fullPage: true });
  checked('Canceling a second native shared-summary save creates no file or stale success message, preserves the earlier file/local project, and requires no live sync or usable relay credentials');

  await verifyMarkdownImport({ page, desktop, work, ownRow, ownSummary, checked });
  workspace = await page.evaluate(async () => (await fetch('/api/workspace')).json());

  await page.locator('.main-nav').getByRole('button', { name: '工作台設定', exact: true }).click();
  const sharingSettings = page.locator('.sharing-settings');
  const groupChoiceName = `共享至 ${fixtureGroup.label}（${profileId.slice(0, 8)}）`;
  const groupPolicy = sharingSettings.locator('.group-sharing-policy').filter({ has: page.getByRole('checkbox', { name: groupChoiceName, exact: true }) });
  const shareCheckbox = groupPolicy.getByRole('checkbox', { name: groupChoiceName, exact: true });
  await shareCheckbox.waitFor(); assert.equal(await groupPolicy.count(), 1); assert.equal(await shareCheckbox.isChecked(), true);
  await groupPolicy.locator('.group-memory-selection > summary').click();
  await sharingSettings.getByRole('button', { name: '預覽分享內容', exact: true }).click();
  const groupPreview = sharingSettings.locator('.group-preview').filter({ has: page.locator('h4').filter({ hasText: `${fixtureGroup.label}（${profileId.slice(0, 8)}）— ` }) });
  const sharingObject = groupPreview.getByLabel('即將分享的完整摘要', { exact: true });
  await sharingObject.waitFor();
  const outgoing = JSON.parse(await sharingObject.textContent());
  assert.deepEqual(Object.keys(outgoing.memory), ['status']); assert.equal('path' in outgoing, false); assert.equal('git' in outgoing, false);
  assert.equal(await page.locator('form form').count(), 0);
  checked('Sharing preview comes from the real local API, excludes paths/Git/unselected memory, and remains a separate form surface');
  const selectAll = groupPolicy.locator('.memory-share-fields').getByRole('checkbox', { name: '全選', exact: true });
  const memoryCheckboxes = groupPolicy.locator('.memory-share-fields .check-field:not(.memory-share-all) input');
  const memoryFieldCount = Object.keys(workspace.projects[0].memory).length;
  assert.equal(await memoryCheckboxes.count(), memoryFieldCount);
  assert.equal(await selectAll.isChecked(), false);
  assert.equal(await selectAll.evaluate(input => input.indeterminate), true);
  await selectAll.check();
  assert.equal(await memoryCheckboxes.evaluateAll(inputs => inputs.every(input => input.checked)), true);
  assert.equal(await selectAll.evaluate(input => input.indeterminate), false);
  assert.equal(await sharingObject.count(), 0);
  await sharingSettings.getByRole('button', { name: '預覽分享內容', exact: true }).click();
  await sharingObject.waitFor();
  assert.deepEqual(Object.keys(JSON.parse(await sharingObject.textContent()).memory).sort(), Object.keys(workspace.projects[0].memory).sort());
  await selectAll.uncheck();
  assert.equal(await memoryCheckboxes.evaluateAll(inputs => inputs.every(input => !input.checked)), true);
  assert.equal(await selectAll.evaluate(input => input.indeterminate), false);
  assert.equal(await sharingObject.count(), 0);
  await sharingSettings.getByRole('button', { name: '預覽分享內容', exact: true }).click();
  await sharingObject.waitFor();
  assert.deepEqual(JSON.parse(await sharingObject.textContent()).memory, {});
  for (let index = 0; index < memoryFieldCount; index++) await memoryCheckboxes.nth(index).check();
  assert.equal(await selectAll.isChecked(), true);
  assert.equal(await selectAll.evaluate(input => input.indeterminate), false);
  await memoryCheckboxes.first().uncheck();
  assert.equal(await selectAll.isChecked(), false);
  assert.equal(await selectAll.evaluate(input => input.indeterminate), true);
  // Deselecting an existing target is a draft-only confirmation, not an immediate withdrawal.
  const deselectGroup = page.getByRole('dialog', { name: '移除此共享對象？', exact: true });
  await shareCheckbox.click();
  await deselectGroup.waitFor(); assert.equal(await shareCheckbox.isChecked(), true);
  await deselectGroup.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await shareCheckbox.isChecked(), true); assert.equal(await selectAll.isEnabled(), true);
  await shareCheckbox.click();
  await deselectGroup.getByRole('button', { name: '取消勾選群組', exact: true }).click();
  await deselectGroup.waitFor({ state: 'detached' });
  assert.equal(await shareCheckbox.isChecked(), false); assert.equal(await selectAll.isDisabled(), true);
  const unchangedSharing = await scopedRead(page, profileId, `/api/devices/sharing/${workspace.projects[0].id}`);
  assert.equal(unchangedSharing.policy.enabled, true); assert.deepEqual(unchangedSharing.policy.memoryFields, ['status']);
  await shareCheckbox.check();
  await selectAll.check(); await selectAll.uncheck();
  await groupPolicy.locator('.memory-share-fields').getByRole('checkbox', { name: '目前開發狀態', exact: true }).check();
  checked('Per-group sharing select-all selects/clears fields, tracks tri-state/individual selection, invalidates previews, and leaves saved policy unchanged through canceled/confirmed draft deselection');
  const oversized = await page.evaluate(async profileId => {
    const workspace = await (await fetch('/api/workspace')).json(), project = workspace.projects[0];
    const headers = { 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken };
    const fields = ['overview', 'status', 'architecture', 'completed', 'pending'];
    const shared = await fetch(`/api/devices/sharing/${project.id}`, { method: 'PUT', headers: { ...headers, 'X-Hub-Profile-Id': profileId }, body: JSON.stringify({ enabled: true, memoryFields: fields }) });
    const memory = { ...project.memory, ...Object.fromEntries(fields.map(field => [field, '漢'.repeat(20000)])) };
    const saved = await fetch(`/api/projects/${project.id}/memory`, { method: 'PUT', headers, body: JSON.stringify({ revision: project.revision, memory }) });
    return { sharingStatus: shared.status, saveStatus: saved.status, projectId: project.id };
  }, profileId);
  assert.equal(oversized.sharingStatus, 200); assert.equal(oversized.saveStatus, 200);
  await page.reload();
  await page.locator('.main-nav').getByRole('button', { name: '工作台設定', exact: true }).click();
  await groupPolicy.locator('.notice').filter({ hasText: '摘要超過 256 KiB' }).waitFor();
  assert.equal(await shareCheckbox.isEnabled(), true); await shareCheckbox.click();
  await deselectGroup.getByRole('button', { name: '取消勾選群組', exact: true }).click();
  await deselectGroup.waitFor({ state: 'detached' });
  await sharingSettings.getByRole('button', { name: '預覽分享內容', exact: true }).click();
  await sharingObject.waitFor(); assert.equal(JSON.parse(await sharingObject.textContent()), null);
  await sharingSettings.locator('.group-preview h4').filter({ hasText: '從此群組撤回' }).waitFor();
  await sharingSettings.getByRole('button', { name: '確認分享設定', exact: true }).click();
  const confirmGroups = page.getByRole('dialog', { name: '儲存這些群組的共享選擇？', exact: true });
  await confirmGroups.waitFor(); assert.ok((await confirmGroups.textContent()).includes(profileId.slice(0, 8)));
  const savedGroupsPending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/devices/group-sharing/${oversized.projectId}` && response.request().method() === 'PUT');
  await confirmGroups.getByRole('button', { name: '儲存已預覽的群組選擇', exact: true }).click();
  const savedGroups = await savedGroupsPending;
  assert.equal(savedGroups.status(), 200);
  const savedChoices = savedGroups.request().postDataJSON();
  assert.equal(savedChoices.confirm, true); assert.match(savedChoices.digest, /^[a-f0-9]{64}$/);
  assert.equal(savedChoices.policies.length, 1); assert.equal(savedChoices.policies[0].profileId, profileId); assert.equal(savedChoices.policies[0].enabled, false);
  await confirmGroups.waitFor({ state: 'detached' });
  const withdrawn = await scopedRead(page, profileId, `/api/devices/sharing/${oversized.projectId}`);
  assert.equal(withdrawn.policy.enabled, false); assert.equal(withdrawn.error, null);
  assert.deepEqual(await desktop.evaluate(() => globalThis.__smokeCacheNetwork), []);
  checked('Oversized later edits retain working per-group controls and withdraw only the previewed explicit target through digest-bound batch confirmation, without live sync');
  origin = new URL(page.url()).origin;
  const recoveredWindow = desktop.waitForEvent('window');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy());
  page = await recoveredWindow;
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '接回手上的工作', exact: true }).waitFor();
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal((await fetch(origin + '/api/workspace')).status, 401);
  assert.equal(await page.evaluate(async () => (await fetch('/api/workspace')).status), 200);
  assert.equal((await page.evaluate(() => window.hubDesktop.getUpdateState())).status, 'unavailable');
  const recovered = await desktop.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { windows: BrowserWindow.getAllWindows().length, sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
  });
  assert.deepEqual(recovered, { windows: 1, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  checked('Unexpected window destruction recovers one sandboxed window on the existing runtime with a working trusted bridge');
  assert.deepEqual(errors, []); checked('No renderer page errors during native flows');
  await quitDesktop();
  await assert.rejects(fetch(origin + '/api/workspace'));
  report.result = report.skippedChecks.length ? 'passed-with-environment-limitations' : 'passed'; await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (desktop) {
    const windows = desktop.windows();
    if (windows[0] && !windows[0].isClosed()) await windows[0].screenshot({ path: join(work, 'failure.png') }).catch(() => {});
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
  }
  console.error('Native verification failed. Artifacts:', work);
  throw error;
} finally { if (desktop) await quitDesktop().catch(async () => { await desktop?.close().catch(() => {}); }); }
