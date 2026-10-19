import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const executable = join(root, 'release', `AI-Project-Hub-${version}-portable-x64.exe`);
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'portable-smoke-'));
const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise(done => socket.close(done));
const windows = process.env.SystemRoot || 'C:\\Windows';
const env = { ...process.env, HUB_DATA_DIR: join(work, 'data') };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
env.PATH = `${join(windows, 'System32')};${windows}`;
let child, browser;
let exited = true;
let exit = Promise.resolve();
const errors = [];

async function launch(locale) {
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--data-dir', env.HUB_DATA_DIR], { env, stdio: 'ignore' });
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
    try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'portable app should expose its test-only debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page = context.pages()[0];
  if (!page) page = await context.waitForEvent('page');
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: locale === 'en' ? 'Development workspace' : '開發工作台', exact: true }).waitFor();
  await page.waitForFunction(expected => document.documentElement.lang === expected && !document.querySelector('.language-toggle button')?.disabled, locale);
  return page;
}
async function close(page) {
  const origin = new URL(page.url()).origin;
  await page.evaluate(() => window.close()).catch(() => {});
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Portable app did not exit after close.')), 15000); timer.unref(); });
  await Promise.race([exit, timeout]);
  await assert.rejects(fetch(origin));
  await browser?.close().catch(() => {}); browser = undefined;
}

try {
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
  assert.equal(updater.status, 'unavailable'); assert.equal(updater.reason, 'unconfigured'); assert.equal(updater.releaseUrl, null);
  await page.screenshot({ path: join(work, 'portable-window-en.png') });

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
  await roots.fill(originalRoots);
  await page.locator('.main-nav').getByRole('button', { name: '開發工作台', exact: true }).click();
  await page.screenshot({ path: join(work, 'portable-window-zh-TW.png') });
  await close(page);

  page = await launch('zh-TW');
  const reopened = await page.evaluate(async () => (await fetch('/api/workspace')).json());
  assert.equal(reopened.settings.locale, 'zh-TW');
  assert.equal(reopened.environment.dataDir, env.HUB_DATA_DIR);
  assert.equal(await page.title(), 'AI Project Hub — 開發工作台');
  assert.equal(await page.locator('.language-toggle button[lang="zh-TW"]').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: join(work, 'portable-reopened-zh-TW.png') });
  await close(page);
  assert.deepEqual(errors, []);
  await writeFile(join(work, 'report.json'), JSON.stringify({ result: 'passed', executable, isolatedDataDir: env.HUB_DATA_DIR, systemNodeOnPath: false, version: workspace.environment.version, checks: ['portable extraction and native window', 'isolated data', 'session-key protection', 'English defaults and metadata', 'allowlisted bridge and unconfigured updater', 'saved language toggle without settings draft loss', 'Traditional Chinese persists after a full restart', 'clean close and listener release', 'no renderer errors'] }, null, 2));
  console.log('Portable executable smoke test passed:', work);
} finally {
  await browser?.close().catch(() => {});
  if (!exited && child?.pid) await new Promise(resolve => execFile(join(windows, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}
