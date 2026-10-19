import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppOptions } from '../server/app.js';
import { Store } from '../server/db.js';
import { MAX_STATE_BYTES } from '../server/handoff.js';
import { APP_VERSION, EMPTY_MEMORY, HANDOFF_TARGETS } from '../shared/types.js';

let server: Server, store: Store, dir: string, base: string, token: string;
const launch = vi.fn(async () => {});
const openDesktopApp = vi.fn(async () => {});
async function api(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function startApp(overrides: Partial<AppOptions> = {}) {
  const { app } = createApp({ store, dataDir: dir, capabilities: async () => ({ folder: true, vscode: false, claude: false, codex: false }), launch,
    desktopCapabilities: async () => ({ claude: true, chatgpt: false }), openDesktopApp,
    readGit: async () => ({ isRepo: false, branch: null, head: null, branches: [], commits: [], changes: [], changedCount: 0, untrackedCount: 0, stagedCount: 0, conflictCount: 0, lastCommitAt: null, observedAt: new Date().toISOString() }), ...overrides });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  token = (await api('/workspace')).data.csrfToken;
}
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'hub-api-'))); store = new Store(':memory:'); launch.mockReset(); openDesktopApp.mockReset();
  await startApp();
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); await rm(dir, { recursive: true, force: true }); });

describe('same-origin local API', () => {
  it('saves locale-only patches without overwriting settings and notifies native code after persistence', async () => {
    expect((await api('/workspace')).data.settings.locale).toBe('en');
    store.updateSettings({ scanRoots: [dir], staleDays: 42, refreshSeconds: 180 });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const onSettingsChanged = vi.fn((settings) => { expect(store.getSettings()).toEqual(settings); });
    await startApp({ onSettingsChanged });
    const result = await api('/settings', 'PATCH', { locale: 'zh-TW' });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ scanRoots: [dir], staleDays: 42, refreshSeconds: 180, locale: 'zh-TW' });
    expect(onSettingsChanged).toHaveBeenCalledExactlyOnceWith(result.data);
    for (const locale of ['en-US', 'zh-CN', 'EN', '', null, 1, ['en'], { locale: 'en' }]) {
      const invalid = await api('/settings', 'PATCH', { locale });
      expect(invalid.status).toBe(400); expect(invalid.data.code).toBe('validation.failed');
    }
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(store.getSettings()).toEqual(result.data);
    expect((await api('/settings', 'PATCH', { refreshSeconds: 0 })).data).toEqual({ ...result.data, refreshSeconds: 0 });
  });
  it('keeps the successful save response when a native settings callback fails', async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await startApp({ onSettingsChanged: () => { throw new Error('native menu unavailable'); } });
      const result = await api('/settings', 'PATCH', { locale: 'zh-TW' });
      expect(result.status).toBe(200); expect(result.data.locale).toBe('zh-TW');
      expect(store.getSettings().locale).toBe('zh-TW'); expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });
  it('resolves coded errors in the saved locale and preserves unknown external details', async () => {
    const english = await api('/missing-api');
    expect(english).toEqual({ status: 404, data: { error: 'API not found.', code: 'request.notFound' } });
    await api('/settings', 'PATCH', { locale: 'zh-TW' });
    const chinese = await api('/missing-api');
    expect(chinese).toEqual({ status: 404, data: { error: '找不到此 API。', code: english.data.code } });
    const guard = await api('/settings', 'PATCH', { locale: 'en' }, { 'X-Hub-Token': 'bad' });
    expect(guard.status).toBe(403); expect(guard.data.code).toBe('request.csrf'); expect(guard.data.error).toContain('安全驗證失敗');
    expect(store.getSettings().locale).toBe('zh-TW');
    openDesktopApp.mockRejectedValueOnce(new Error('OS diagnostic stays verbatim: 錯誤 0x42'));
    expect((await api('/desktop-apps/claude/open', 'POST', {})).data).toEqual({ error: 'OS diagnostic stays verbatim: 錯誤 0x42' });
  });
  it('generates bilingual handoffs from saved locale without changing user content or state keys', async () => {
    const { data: project } = await api('/projects', 'POST', { path: dir, name: '原樣 project', nextAction: 'User-authored 下一步' });
    const english = (await api(`/projects/${project.id}/handoff?agent=claude-desktop`)).data;
    expect(english.markdown).toContain('## How to take over');
    await api('/settings', 'PATCH', { locale: 'zh-TW' });
    const chinese = (await api(`/projects/${project.id}/handoff?agent=claude-desktop`)).data;
    expect(chinese.markdown).toContain('## 接手方式');
    expect(chinese.state).toEqual({ ...english.state, exportedAt: chinese.state.exportedAt });
    expect(chinese.state.nextAction).toBe('User-authored 下一步');
    expect(store.getProject(project.id)).toEqual(project);
    const text = JSON.stringify(english.state);
    const preview = (await api(`/projects/${project.id}/shared-state/paste/preview`, 'POST', { text })).data;
    expect(preview.source).toBe('貼上的 JSON'); expect(preview.state).toEqual(english.state);
    expect(preview.hash).toBe(createHash('sha256').update(text).digest('hex'));
    const exported = await api(`/projects/${project.id}/handoff/export`, 'POST', { confirm: true, agent: 'generic' });
    expect(await readFile(exported.data.files[0], 'utf8')).toContain('## 接手方式');
    await api('/settings', 'PATCH', { locale: 'en' });
    const englishPreview = (await api(`/projects/${project.id}/shared-state/paste/preview`, 'POST', { text })).data;
    expect(englishPreview.source).toBe('Pasted JSON'); expect(englishPreview.hash).toBe(preview.hash);
  });
  it('reports v0.2 web mode and independent desktop/CLI capabilities', async () => {
    const { data } = await api('/workspace');
    expect(data.environment).toEqual({ platform: process.platform, dataDir: dir, version: APP_VERSION, mode: 'web',
      capabilities: { folder: true, vscode: false, claude: false, codex: false }, desktopApps: { claude: true, chatgpt: false } });
    expect(launch).not.toHaveBeenCalled(); expect(openDesktopApp).not.toHaveBeenCalled();
  });
  it('accepts native mode and desktop capability injection', async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await startApp({ mode: 'desktop', desktopCapabilities: async () => ({ claude: false, chatgpt: true }) });
    expect((await api('/workspace')).data.environment).toMatchObject({ mode: 'desktop', desktopApps: { claude: false, chatgpt: true } });
  });
  it('opens only allowlisted desktop apps with an empty body and no project or cwd', async () => {
    for (const app of ['claude', 'chatgpt']) expect((await api(`/desktop-apps/${app}/open`, 'POST', {})).data).toEqual({ ok: true });
    expect(openDesktopApp.mock.calls).toEqual([['claude'], ['chatgpt']]);
    openDesktopApp.mockClear();
    for (const app of ['codex', 'Claude', 'ChatGPT', 'powershell', 'chatgpt-desktop', 'shell:AppsFolder']) {
      expect((await api(`/desktop-apps/${app}/open`, 'POST', {})).status).toBe(400);
    }
    for (const body of [undefined, null, [], { path: dir }, { command: 'calc.exe' }, { appId: 'Other.App!App' }]) {
      expect((await api('/desktop-apps/claude/open', 'POST', body)).status).toBe(400);
    }
    expect(openDesktopApp).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    expect(store.listProjects()).toHaveLength(0);
  });
  it('does not report a successful desktop launch after a native failure', async () => {
    openDesktopApp.mockRejectedValueOnce(new Error('Claude Desktop unavailable'));
    const result = await api('/desktop-apps/claude/open', 'POST', {});
    expect(result.status).toBe(400); expect(result.data).toEqual({ error: 'Claude Desktop unavailable' });
  });
  it('blocks hostile Origins, cross-site requests, wrong tokens and non-JSON mutations', async () => {
    expect((await api('/workspace', 'GET', undefined, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('/workspace', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await api('/projects', 'POST', { path: dir }, { 'X-Hub-Token': 'wrong' })).status).toBe(403);
    expect((await api('/projects', 'POST', { path: dir }, { 'Content-Type': 'text/plain' })).status).toBe(403);
    expect(store.listProjects()).toHaveLength(0);
  });
  it('requires mutation tokens for mixed-case API routes too', async () => {
    for (const prefix of ['API', 'Api', 'aPi']) {
      const response = await fetch(`${base}/${prefix}/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staleDays: 99 }) });
      expect(response.status).toBe(403);
    }
    expect(store.getSettings().staleDays).toBe(14);
  });
  it('rejects DNS-rebinding Host headers', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(base + '/api/workspace', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(status).toBe(403);
  });
  it('runs project/task/memory flow with validation, conflict protection and no disk deletion', async () => {
    await writeFile(join(dir, 'keep.txt'), 'keep this file');
    const added = await api('/projects', 'POST', { path: dir, name: '測試項目' }); expect(added.status).toBe(201);
    const id = added.data.id;
    expect((await api('/projects', 'POST', { path: dir })).status).toBe(409);
    expect((await api(`/projects/${id}`, 'PATCH', { revision: 1, path: '/not-allowed' })).status).toBe(400);
    const task = await api(`/projects/${id}/tasks`, 'POST', { title: '驗證資料', priority: 'high' }); expect(task.status).toBe(201);
    expect((await api(`/tasks/${task.data.id}`, 'PATCH', { revision: 1, status: 'done' })).data.status).toBe('done');
    expect((await api(`/tasks/${task.data.id}`, 'PATCH', { revision: 1, status: 'todo' })).status).toBe(409);
    const saved = await api(`/projects/${id}/memory`, 'PUT', { revision: 1, memory: { ...EMPTY_MEMORY, status: 'Ready to resume' } }); expect(saved.data.revision).toBe(2);
    expect((await api(`/projects/${id}/memory`, 'PUT', { revision: 1, memory: EMPTY_MEMORY })).status).toBe(409);
    expect((await api(`/projects/${id}`, 'DELETE', { revision: 2, confirm: false })).status).toBe(400);
    expect((await api(`/projects/${id}`, 'DELETE', { revision: 2, confirm: true })).status).toBe(200);
    expect(await readFile(join(dir, 'keep.txt'), 'utf8')).toBe('keep this file'); expect(store.listTasks()).toHaveLength(0);
  });
  it('previews and imports agent memory only after hash and revision confirmation', async () => {
    const { data: p } = await api('/projects', 'POST', { path: dir });
    expect((await api(`/projects/${p.id}/handoff/export`, 'POST', { agent: 'codex' })).status).toBe(400);
    expect((await api(`/projects/${p.id}/handoff/export`, 'POST', { agent: 'codex', confirm: true })).status).toBe(200);
    const { data: initial } = await api(`/projects/${p.id}/shared-state`);
    await writeFile(initial.source, JSON.stringify({ ...initial.state, memory: { ...EMPTY_MEMORY, status: 'Updated by agent' }, nextAction: 'Verify integration' }));
    expect((await api(`/projects/${p.id}/shared-state/import`, 'POST', { revision: 1, hash: initial.hash, confirm: true })).status).toBe(409);
    const { data: reviewed } = await api(`/projects/${p.id}/shared-state`);
    const applied = await api(`/projects/${p.id}/shared-state/import`, 'POST', { revision: 1, hash: reviewed.hash, confirm: true });
    expect(applied.data.memory.status).toBe('Updated by agent'); expect(applied.data.nextAction).toBe('Verify integration');
    expect(applied.data.status).toBe('active'); expect(applied.data.path).toBe(dir);
  });
  it('accepts all central handoff targets and retains the generic default', async () => {
    const { data: p } = await api('/projects', 'POST', { path: dir });
    for (const agent of HANDOFF_TARGETS) {
      const preview = await api(`/projects/${p.id}/handoff?agent=${agent}`);
      expect(preview.status).toBe(200);
      expect((await api(`/projects/${p.id}/handoff/export`, 'POST', { agent, confirm: true })).status).toBe(200);
    }
    expect((await api(`/projects/${p.id}/handoff`)).data.markdown).toContain('Target: The next AI agent');
    expect((await api(`/projects/${p.id}/handoff/export`, 'POST', { confirm: true })).status).toBe(200);
    expect((await api(`/projects/${p.id}/handoff?agent=other`)).status).toBe(400);
    expect((await api(`/projects/${p.id}/handoff/export`, 'POST', { agent: 'other', confirm: true })).status).toBe(400);
  });
  it('previews pasted fenced JSON without mutation, then imports only memory and nextAction', async () => {
    await writeFile(join(dir, 'keep.txt'), 'never change project files');
    const { data: p } = await api('/projects', 'POST', { path: dir, name: 'Original', description: 'Keep description', stage: 'Review', priority: 'high' });
    const { data: handoff } = await api(`/projects/${p.id}/handoff?agent=claude-desktop`);
    const state = { ...handoff.state, projectName: 'Do not rename project', memory: { ...EMPTY_MEMORY, status: 'Chat checkpoint' }, nextAction: 'Review changes' };
    const text = `\n\`\`\`JSON\r\n${JSON.stringify(state, null, 2)}\r\n\`\`\`\n`;
    const { data: task } = await api(`/projects/${p.id}/tasks`, 'POST', { title: 'Do not change tasks' });
    const { status, data: reviewed } = await api(`/projects/${p.id}/shared-state/paste/preview`, 'POST', { text });
    expect(status).toBe(200); expect(reviewed.source).toBe('Pasted JSON');
    expect(reviewed.hash).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(store.getProject(p.id)).toEqual(p);
    expect((await api(`/projects/${p.id}/shared-state/paste/import`, 'POST', { text, hash: reviewed.hash, revision: p.revision, confirm: false })).status).toBe(400);
    const applied = await api(`/projects/${p.id}/shared-state/paste/import`, 'POST', { text, hash: reviewed.hash, revision: p.revision, confirm: true });
    expect(applied.status).toBe(200);
    expect(applied.data).toMatchObject({ memory: state.memory, nextAction: state.nextAction, revision: p.revision + 1,
      name: p.name, path: p.path, status: p.status, description: p.description, priority: p.priority, stage: p.stage, git: p.git });
    expect(store.getTask(task.id)).toEqual(task);
    expect(await readdir(dir)).toEqual(['keep.txt']);
    expect(await readFile(join(dir, 'keep.txt'), 'utf8')).toBe('never change project files');
  });
  it('checks exact pasted bytes and revision again before saving, including whitespace/fence changes', async () => {
    const { data: p } = await api('/projects', 'POST', { path: dir });
    const { data: handoff } = await api(`/projects/${p.id}/handoff`);
    const text = JSON.stringify(handoff.state);
    const { data: preview } = await api(`/projects/${p.id}/shared-state/paste/preview`, 'POST', { text });
    const importBody = { text, hash: preview.hash, revision: p.revision, confirm: true };
    for (const changed of [text + ' ', `\`\`\`json\n${text}\n\`\`\``, text.replace('"memory":', '"memory": ')]) {
      expect((await api(`/projects/${p.id}/shared-state/paste/import`, 'POST', { ...importBody, text: changed })).status).toBe(409);
    }
    expect((await api(`/projects/${p.id}/shared-state/paste/import`, 'POST', { ...importBody, hash: '0'.repeat(64) })).status).toBe(409);
    await api(`/projects/${p.id}/memory`, 'PUT', { revision: p.revision, memory: { ...EMPTY_MEMORY, notes: 'Newer local draft' } });
    expect((await api(`/projects/${p.id}/shared-state/paste/import`, 'POST', importBody)).status).toBe(409);
    expect(store.getProject(p.id).memory.notes).toBe('Newer local draft');
    expect(await readdir(dir)).toEqual([]);
  });
  it('rejects invalid pasted schemas and identities on both preview and import', async () => {
    const { data: p } = await api('/projects', 'POST', { path: dir });
    const { data: handoff } = await api(`/projects/${p.id}/handoff`);
    const invalid: [string, number][] = [
      ['not json', 400],
      [JSON.stringify({ ...handoff.state, path: 'must not change' }), 400],
      [JSON.stringify({ ...handoff.state, memory: { ...EMPTY_MEMORY, command: 'never run' } }), 400],
      [JSON.stringify({ ...handoff.state, memory: {} }), 400],
      [JSON.stringify({ ...handoff.state, nextAction: 123 }), 400],
      [JSON.stringify({ ...handoff.state, projectId: '00000000-0000-4000-8000-000000000000' }), 409],
      ['中'.repeat(Math.ceil(MAX_STATE_BYTES / 3)), 400],
    ];
    for (const [text, expected] of invalid) {
      expect((await api(`/projects/${p.id}/shared-state/paste/preview`, 'POST', { text })).status).toBe(expected);
      expect((await api(`/projects/${p.id}/shared-state/paste/import`, 'POST', { text, hash: createHash('sha256').update(text).digest('hex'), revision: 1, confirm: true })).status).toBe(expected);
    }
    for (const body of [{}, { text: 7 }, { text: '{}', command: 'no' }]) {
      expect((await api(`/projects/${p.id}/shared-state/paste/preview`, 'POST', body)).status).toBe(400);
    }
    const text = JSON.stringify(handoff.state), hash = createHash('sha256').update(text).digest('hex');
    for (const patch of [{ revision: 0 }, { hash: 'not a hash' }, { confirm: undefined }, { unexpected: true }]) {
      expect((await api(`/projects/${p.id}/shared-state/paste/import`, 'POST', { text, hash, revision: 1, confirm: true, ...patch })).status).toBe(400);
    }
    expect(store.getProject(p.id)).toEqual(p);
    expect(await readdir(dir)).toEqual([]);
  });
  it('accepts a full 1 MiB text within its larger JSON envelope, but retains other route limits', async () => {
    const { data: p } = await api('/projects', 'POST', { path: dir });
    const { data: handoff } = await api(`/projects/${p.id}/handoff`);
    const json = JSON.stringify(handoff.state);
    const text = json + '\t'.repeat(MAX_STATE_BYTES - Buffer.byteLength(json));
    expect(Buffer.byteLength(text)).toBe(MAX_STATE_BYTES);
    const result = await api(`/projects/${p.id}/shared-state/paste/preview`, 'POST', { text });
    expect(result.status).toBe(200);
    expect((await api(`/projects/${p.id}/shared-state/paste/preview`, 'POST', { text: text + ' ' })).status).toBe(400);
    expect((await api('/settings', 'PATCH', { text })).status).toBe(413);
  });
  it('applies same-origin, JSON and token guards to both paste and desktop app mutations', async () => {
    const { data: p } = await api('/projects', 'POST', { path: dir });
    for (const [path, body] of [
      ['/desktop-apps/claude/open', {}],
      [`/projects/${p.id}/shared-state/paste/preview`, { text: '{}' }],
      [`/projects/${p.id}/shared-state/paste/import`, { text: '{}' }],
    ] as const) {
      const deniedHeaders: Record<string, string>[] = [{ 'X-Hub-Token': 'wrong' }, { Origin: 'https://evil.example' }, { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'cross-site' }];
      for (const headers of deniedHeaders) {
        expect((await api(path, 'POST', body, headers)).status).toBe(403);
      }
    }
    expect(openDesktopApp).not.toHaveBeenCalled();
    expect(store.getProject(p.id)).toEqual(p);
  });
  it('scans without registering until import and deduplicates selected paths', async () => {
    const child = join(dir, '中文 project'); await mkdir(child); await writeFile(join(child, 'package.json'), '{}');
    const scan = await api('/scan', 'POST', { path: dir, depth: 2 });
    expect(scan.status).toBe(200); expect(scan.data.candidates).toHaveLength(1);
    expect(store.listProjects()).toHaveLength(0); expect(store.getSettings().scanRoots).toContain(dir);
    const imported = await api('/scan/import', 'POST', { paths: [child, child] });
    expect(imported.data).toMatchObject({ added: 1, skipped: 1, errors: [] });
    expect(store.listProjects()[0].name).toBe('中文 project');
  });
  it('accepts only allowlisted quick actions and validates settings', async () => {
    const { data: p } = await api('/projects', 'POST', { path: dir });
    expect((await api(`/projects/${p.id}/open`, 'POST', { action: 'arbitrary command' })).status).toBe(400);
    expect(launch).not.toHaveBeenCalled();
    expect((await api(`/projects/${p.id}/open`, 'POST', { action: 'folder' })).status).toBe(200);
    expect(launch).toHaveBeenCalledWith(dir, 'folder');
    expect((await api('/settings', 'PATCH', { refreshSeconds: 1 })).status).toBe(400);
    expect((await api('/settings', 'PATCH', { refreshSeconds: 0, staleDays: 30 })).data.staleDays).toBe(30);
  });
});
