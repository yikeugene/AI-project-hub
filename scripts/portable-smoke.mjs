import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import releaseSource from './release-source.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const executableFlag = process.argv.indexOf('--executable');
const executableOverride = executableFlag < 0 ? undefined : process.argv[executableFlag + 1];
if (executableFlag >= 0 && (!executableOverride || !isAbsolute(executableOverride))) throw new Error('--executable requires an absolute executable path.');
const executable = executableOverride ?? join(root, 'release', `AI-Project-Hub-${version}-portable-x64.exe`);
if (!existsSync(executable)) throw new Error('Portable executable not found. Build a portable package first or pass --executable with an existing absolute path.');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'portable-smoke-'));
async function freePort() {
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise(done => socket.close(done));
  return port;
}
const [port, inspectorPort] = await Promise.all([freePort(), freePort()]);
const windows = process.env.SystemRoot || 'C:\\Windows';
const env = { ...process.env, HUB_DATA_DIR: join(work, 'data') };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
env.PATH = `${join(windows, 'System32')};${windows}`;
let child, browser;
let exited = true;
let exit = Promise.resolve();
const errors = [];
const report = { result: 'running', executable, isolatedDataDir: env.HUB_DATA_DIR, systemNodeOnPath: false, version, checks: [] };
const checked = message => { report.checks.push(message); console.log('PASS:', message); };
async function bounded(promise, message, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function killOwnProcessTree(pid) {
  await bounded(new Promise(resolve => execFile(join(windows, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve())), 'Timed out cleaning up the isolated portable process tree.', 12000);
}

async function launch(locale) {
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectorPort}`, '--data-dir', env.HUB_DATA_DIR], { env, stdio: 'ignore' });
  exited = false;
  exit = new Promise((resolve, reject) => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', error => { exited = true; reject(error); });
  });
  // Attach a rejection handler immediately; startup still reports any error below.
  void exit.catch(() => {});
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (exited) { await exit; throw new Error('Portable wrapper exited before the window was ready.'); }
    try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'portable app should expose its test-only debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const context = browser.contexts()[0];
  let page = context.pages()[0];
  if (!page) page = await context.waitForEvent('page', { timeout: 30000 });
  const evaluatePage = page.evaluate.bind(page);
  page.evaluate = (...args) => bounded(evaluatePage(...args), 'Portable renderer/protocol request did not answer within 15 seconds.');
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: locale === 'en' ? 'Development workspace' : '開發工作台', exact: true }).waitFor();
  await page.waitForFunction(expected => document.documentElement.lang === expected && !document.querySelector('.language-toggle button')?.disabled, locale);
  return page;
}
async function nativeEvaluate(expression) {
  // Like Playwright's Electron driver, use a test-launch-only, loopback Node inspector.
  // Chromium keyboard shortcuts and renderer window.close() are not equivalent to native menu/X actions.
  const targets = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const target = targets.find(item => item.webSocketDebuggerUrl);
  assert.ok(target, 'portable test launch must expose its main-process inspector');
  return new Promise((resolve, reject) => {
    const connection = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); connection.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('Main-process inspector did not answer the native action within 10 seconds.')), 10000);
    connection.addEventListener('open', () => connection.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true },
    })));
    connection.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      const error = message.error || message.result?.exceptionDetails;
      done(error ? new Error(`Native action failed: ${JSON.stringify(error)}`) : undefined, message.result?.result?.value);
    });
    connection.addEventListener('error', () => done(new Error('Main-process inspector connection failed.')));
    connection.addEventListener('close', () => done(new Error('Main-process inspector closed before answering the native action.')));
  });
}

async function nativeQuit(discardFixtureDraft = false) {
  await nativeEvaluate(`(() => { const { Menu, dialog } = require('electron'); ${discardFixtureDraft ? 'dialog.showMessageBoxSync = () => 1;' : ''} const quit = Menu.getApplicationMenu()?.getMenuItemById('quit'); if (!quit) throw new Error('Native File / Quit menu is missing'); setImmediate(() => quit.click()); return true; })()`);
}
async function close(page) {
  const origin = new URL(page.url()).origin;
  await nativeQuit();
  await bounded(exit, 'Portable app did not exit through File / Quit.');
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(5000) }));
  await bounded(browser?.close(), 'Browser debugger did not disconnect after native quit.', 5000).catch(() => {}); browser = undefined;
}

async function hideAndRestore(page) {
  const origin = new URL(page.url()).origin;
  const windowState = `(() => { const windows = require('electron').BrowserWindow.getAllWindows(); const owner = windows[0]; return { count: windows.length, id: owner.id, renderer: owner.webContents.id, visible: owner.isVisible() }; })()`;
  const original = await nativeEvaluate(windowState);
  // BrowserWindow.close models native X. Renderer window.close runs Chromium beforeunload first.
  await nativeEvaluate(`require('electron').BrowserWindow.getAllWindows()[0].close()`);
  // A debugger-attached page can report visible while its native window is hidden.
  assert.deepEqual(await nativeEvaluate(windowState), { ...original, visible: false });
  assert.equal(page.isClosed(), false); assert.equal(exited, false);
  assert.equal(await page.evaluate(async () => (await fetch('/api/workspace')).status), 200);
  assert.equal((await fetch(origin)).status, 401);
  // Launch the real portable wrapper again with the same profile; its single-instance signal restores the original renderer.
  const second = spawn(executable, ['--data-dir', env.HUB_DATA_DIR], { env, stdio: 'ignore', windowsHide: true });
  let secondExited = false;
  try {
    await bounded(new Promise((resolve, reject) => {
      second.once('error', reject);
      second.once('exit', code => { secondExited = true; code === 0 ? resolve() : reject(new Error(`Second portable instance exited ${code}.`)); });
    }), 'Second portable wrapper did not finish its single-instance handoff.', 45000);
  } finally { if (!secondExited && second.pid) await killOwnProcessTree(second.pid); }
  await bounded((async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const restored = await nativeEvaluate(windowState);
      if (restored.visible) { assert.deepEqual(restored, { ...original, visible: true }); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Second portable instance did not restore the original native window.');
  })(), 'Second portable instance did not restore the original native window.', 10000);
}

async function run() {
  let page = await launch('en');
  const workspace = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.equal(workspace.environment.mode, 'desktop');
  assert.equal(workspace.environment.version, version);
  assert.equal(workspace.environment.dataDir, env.HUB_DATA_DIR);
  assert.equal(workspace.projects.length, 0);
  assert.equal(workspace.settings.locale, 'en');
  assert.equal(await page.title(), 'AI Project Hub — Development workspace');
  assert.equal(await page.locator('.language-toggle button[lang="en"]').getAttribute('aria-pressed'), 'true');
  const origin = new URL(page.url()).origin;
  assert.equal((await fetch(origin)).status, 401);
  const bridge = await page.evaluate(() => ({ methods: Object.keys(window.hubDesktop ?? {}).sort(), process: typeof window.process, require: typeof window.require }));
  assert.deepEqual(bridge.methods, ['chooseDirectory', 'saveText', 'writeClipboard', 'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'openReleases', 'onUpdateState'].sort());
  assert.equal(bridge.process, 'undefined'); assert.equal(bridge.require, 'undefined');
  const updater = await page.evaluate(() => window.hubDesktop.getUpdateState());
  const source = releaseSource.getReleaseSource();
  assert.equal(updater.status, 'unavailable');
  assert.equal(updater.reason, source ? 'portable' : 'unconfigured');
  assert.equal(updater.releaseUrl, source ? `https://github.com/${source.owner}/${source.repo}/releases/latest` : null);
  await page.screenshot({ path: join(work, 'portable-window-en.png') });
  checked('Portable extraction, isolated data, English UI, session protection and unchanged native bridge');
  const observation = await page.evaluate(async () => (await fetch('/api/app-observation')).json());
  assert.equal(observation.policy.enabled, false); assert.equal(observation.local, null); assert.deepEqual(observation.statuses, []);
  assert.equal(observation.collectorAvailable, true, 'The extracted package must contain its trusted native collector.');
  const helper = await nativeEvaluate(`(() => { const fs = require('node:fs'), path = require('node:path'); const file = path.join(process.resourcesPath, 'app-observation', 'foreground-app.exe'); return { resources: process.resourcesPath, present: fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink() }; })()`);
  assert.equal(helper.present, true); report.appObservationResources = helper.resources;
  checked('Portable extraction includes the owned foreground helper while app sharing stays off and exposes no observed names');

  await page.locator('.main-nav').getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const roots = page.locator('.settings-form textarea');
  const originalRoots = await roots.inputValue();
  await roots.fill('C:\\Portable Unsaved Draft');
  await page.locator('.language-toggle').getByRole('button', { name: '繁體中文', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-TW' && !document.querySelector('.language-toggle button')?.disabled);
  await page.getByRole('heading', { name: '工作台設定', exact: true }).waitFor();
  assert.equal(await roots.inputValue(), 'C:\\Portable Unsaved Draft');
  const switched = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.deepEqual(switched.settings, { ...workspace.settings, locale: 'zh-TW' });
  await hideAndRestore(page);
  assert.equal(await roots.inputValue(), 'C:\\Portable Unsaved Draft');
  checked('Native X hides without discarding the localized draft/backend; second portable instance restores it');
  await roots.fill(originalRoots);
  await page.locator('.main-nav').getByRole('button', { name: '開發工作台', exact: true }).click();
  await page.screenshot({ path: join(work, 'portable-window-zh-TW.png') });
  await close(page);
  checked('Genuine native File/Quit exits the portable wrapper and releases the internal listener');

  page = await launch('zh-TW');
  const reopened = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.equal(reopened.settings.locale, 'zh-TW');
  assert.equal(reopened.environment.dataDir, env.HUB_DATA_DIR);
  assert.equal(await page.title(), 'AI Project Hub — 開發工作台');
  assert.equal(await page.locator('.language-toggle button[lang="zh-TW"]').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: join(work, 'portable-reopened-zh-TW.png') });
  await close(page);
  assert.deepEqual(errors, []);
  checked('Traditional Chinese survives restart; second native Quit succeeds with no renderer errors');
  report.result = 'passed';
}
try {
  await bounded(run(), 'Portable smoke exceeded its three-minute overall deadline.', 180000);
} catch (error) {
  report.result = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (!exited) {
    await nativeQuit(true).catch(error => { report.cleanupError = error.message; });
    await bounded(exit, 'Portable cleanup quit did not finish.', 5000).catch(() => {});
  }
  await bounded(browser?.close(), 'Browser debugger cleanup did not finish.', 5000).catch(() => {});
  if (!exited && child?.pid) { report.forcedCleanup = true; await killOwnProcessTree(child.pid); }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Portable executable smoke ${report.result}:`, work);
}
