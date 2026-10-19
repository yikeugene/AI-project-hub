import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHubRuntime, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import { Store } from '../server/db.js';
import type { GitSnapshot } from '../shared/types.js';

let directory: string, assets: string;
const runtimes: HubRuntime[] = [];
const quietOptions = { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-runtime-')); assets = join(directory, 'assets'); await mkdir(assets);
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>Runtime fixture</title>');
  await writeFile(join(assets, 'app.js'), 'console.log("fixture")');
});
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); await rm(directory, { recursive: true, force: true }); });
async function start(secret?: string) {
  const runtime = await createHubRuntime({ dataDir: join(directory, 'data'), assetDirectory: assets, mode: secret ? 'desktop' : 'web', desktopSecret: secret, port: 0, enablePolling: false, appOptions: quietOptions });
  runtimes.push(runtime); return runtime;
}

describe('desktop-owned runtime', () => {
  it('forwards saved language to the native callback and isolates locale per runtime', async () => {
    const secret = randomBytes(32).toString('hex'), onSettingsChanged = vi.fn();
    const a = await createHubRuntime({ dataDir: join(directory, 'localized'), assetDirectory: assets, mode: 'desktop', desktopSecret: secret, port: 0,
      enablePolling: false, deviceOptions: { enablePolling: false }, appOptions: { ...quietOptions, onSettingsChanged } });
    runtimes.push(a);
    const b = await start();
    const headers = { [DESKTOP_KEY_HEADER]: secret };
    const workspace = await (await fetch(a.origin + '/api/workspace', { headers })).json();
    const response = await fetch(a.origin + '/api/settings', { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken }, body: JSON.stringify({ locale: 'zh-TW' }) });
    const settings = await response.json();
    expect(response.status).toBe(200); expect(onSettingsChanged).toHaveBeenCalledExactlyOnceWith(settings);
    expect((await (await fetch(a.origin + '/api/workspace')).json()).error).toBe('此服務只供 AI Project Hub 桌面視窗使用。');
    expect((await (await fetch(b.origin + '/api/missing')).json()).error).toBe('API not found.');
    expect(b.store.getSettings().locale).toBe('en');
    await a.stop();
    const reopened = await createHubRuntime({ dataDir: a.dataDir, assetDirectory: assets, mode: 'desktop', desktopSecret: secret, port: 0,
      enablePolling: false, deviceOptions: { enablePolling: false }, appOptions: quietOptions });
    runtimes.push(reopened);
    expect(reopened.store.getSettings().locale).toBe('zh-TW');
    expect((await (await fetch(reopened.origin + '/api/workspace')).json()).error).toBe('此服務只供 AI Project Hub 桌面視窗使用。');
  });
  it('requires a strong desktop key and never silently downgrades to public web mode', async () => {
    await expect(createHubRuntime({ dataDir: directory, assetDirectory: assets, mode: 'desktop' })).rejects.toThrow(/secret/);
    await expect(createHubRuntime({ dataDir: directory, assetDirectory: assets, mode: 'desktop', desktopSecret: 'weak' })).rejects.toThrow(/secret/);
  });
  it('authenticates HTML, static assets and API, while preserving CSRF/Origin checks', async () => {
    const secret = randomBytes(32).toString('hex'), runtime = await start(secret);
    for (const path of ['/', '/app.js', '/api/workspace']) expect((await fetch(runtime.origin + path)).status).toBe(401);
    expect((await fetch(runtime.origin + '/', { headers: { [DESKTOP_KEY_HEADER]: 'G'.repeat(64) } })).status).toBe(401);
    const headers = { [DESKTOP_KEY_HEADER]: secret };
    const page = await fetch(runtime.origin, { headers }); expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    const workspace = await (await fetch(runtime.origin + '/api/workspace', { headers })).json();
    expect(workspace.environment.mode).toBe('desktop');
    expect(JSON.stringify(workspace)).not.toContain(secret);
    const url = runtime.origin + '/API/settings';
    expect((await fetch(url, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"staleDays":99}' })).status).toBe(403);
    expect((await fetch(runtime.origin + '/api/workspace', { headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
    const saved = await fetch(url, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken, Origin: runtime.origin }, body: '{"staleDays":21}' });
    expect(saved.status).toBe(200); expect(runtime.store.getSettings().staleDays).toBe(21);
  });
  it('preserves database location and settings across runtime restart and closes the listener', async () => {
    const a = await start(); a.store.updateSettings({ staleDays: 30, locale: 'zh-TW' }); const oldOrigin = a.origin;
    await a.stop(); await a.stop();
    await expect(fetch(oldOrigin + '/api/workspace')).rejects.toThrow();
    const b = await start(); expect(b.dataDir).toBe(join(directory, 'data')); expect(b.store.getSettings().staleDays).toBe(30);
    const workspace = await (await fetch(b.origin + '/api/workspace')).json(); expect(workspace.environment.mode).toBe('web');
    expect(workspace.settings.locale).toBe('zh-TW');
  });
  it('drains an in-flight API write before closing SQLite', async () => {
    let release!: (snapshot: GitSnapshot) => void;
    let started!: () => void;
    const observed = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<GitSnapshot>(resolve => { release = resolve; });
    const runtime = await createHubRuntime({ dataDir: join(directory, 'data'), assetDirectory: assets, port: 0, enablePolling: false,
      appOptions: { ...quietOptions, readGit: () => { started(); return gate; } } });
    runtimes.push(runtime);
    const workspace = await (await fetch(runtime.origin + '/api/workspace')).json();
    const pending = fetch(runtime.origin + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken }, body: JSON.stringify({ path: directory, name: 'Before quit' }) });
    await observed;
    let closed = false; const closing = runtime.stop().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 15)); expect(closed).toBe(false);
    release({ isRepo: false, branch: null, head: null, branches: [], commits: [], changes: [], changedCount: 0, untrackedCount: 0, stagedCount: 0, conflictCount: 0, lastCommitAt: null, observedAt: new Date().toISOString() });
    expect((await pending).status).toBe(201); await closing;
    const reopened = new Store(join(directory, 'data', 'hub.sqlite'));
    try { expect(reopened.listProjects()[0].name).toBe('Before quit'); } finally { reopened.close(); }
  });
});
