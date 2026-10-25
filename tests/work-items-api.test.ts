import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { WorkBrief, WorkItem } from '../shared/work-items.js';

let store: Store, server: Server, base: string, token: string, projectId: string;
const brief: WorkBrief = { title: 'Small result', goal: 'Validate email', nonGoals: '', acceptanceCriteria: ['Shows an error'], firstCheck: 'Enter invalid email' };
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const result = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: result.status, data: await result.json() };
}
beforeEach(async () => {
  store = new Store(':memory:'); projectId = store.createProject({ path: '/local-work-items', name: 'Local' }).id;
  const { app } = createApp({ store, dataDir: '/unused', capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) });
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  token = (await request('/workspace')).data.csrfToken;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); });
const create = () => request(`/projects/${projectId}/work-items`, 'POST', { commandId: randomUUID(), brief });

describe('local-only work item HTTP interface', () => {
  it('creates, lists, previews and explicitly dispatches without modifying the old workspace contract', async () => {
    const before = (await request('/workspace')).data;
    const created = await create(); expect(created.status).toBe(200);
    let item: WorkItem = created.data.item;
    expect((await request(`/work-items?projectId=${projectId}`)).data.items).toEqual([item]);
    expect((await request(`/work-items/${item.id}`)).data.events).toHaveLength(1);
    expect((await request(`/work-items/${item.id}/brief`)).status).toBe(409);
    item = (await request(`/work-items/${item.id}/actions`, 'POST', { commandId: randomUUID(), expectedRevision: item.revision, action: { type: 'confirm' } })).data.item;
    const preview = await request(`/work-items/${item.id}/brief`);
    expect(preview.status).toBe(200); expect(preview.data.markdown).toContain(brief.firstCheck);
    expect((await request(`/work-items/${item.id}`)).data.item.phase).toBe('ready');
    const command = { commandId: randomUUID(), expectedRevision: item.revision, action: { type: 'dispatch', previewHash: preview.data.hash } };
    const sent = await request(`/work-items/${item.id}/actions`, 'POST', command);
    expect(sent.data.item.phase).toBe('awaiting_return');
    const retry = await request(`/work-items/${item.id}/actions`, 'POST', command);
    expect(retry.data.receipt.replayed).toBe(true); expect(retry.data.item).toEqual(sent.data.item);
    const after = (await request('/workspace')).data;
    expect(after.projects).toEqual(before.projects); expect(after.tasks).toEqual(before.tasks);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });
  it('rejects missing CSRF, cross-origin requests, direct completion and extra fields', async () => {
    const body = { commandId: randomUUID(), brief };
    expect((await request(`/projects/${projectId}/work-items`, 'POST', body, { 'X-Hub-Token': '' })).status).toBe(403);
    expect((await request(`/projects/${projectId}/work-items`, 'POST', body, { Origin: 'https://outside.example' })).status).toBe(403);
    expect((await request(`/projects/${projectId}/work-items`, 'POST', { ...body, status: 'done' })).status).toBe(400);
    const item: WorkItem = (await create()).data.item;
    expect((await request(`/work-items/${item.id}`, 'PATCH', { phase: 'done' })).status).toBe(404);
    expect((await request(`/work-items/${item.id}/actions`, 'POST', { commandId: randomUUID(), expectedRevision: item.revision, action: { type: 'complete' } })).status).toBe(409);
    expect((await request('/work-items?includeSecrets=true')).status).toBe(400);
    expect((await request('/work-items/not-a-uuid')).status).toBe(400);
    expect((await request(`/projects/${randomUUID()}/work-items`, 'POST', body)).status).toBe(404);
  });
  it('returns localized safe conflicts and leaves the user-authored content untouched', async () => {
    const item: WorkItem = (await create()).data.item;
    store.updateSettings({ locale: 'zh-TW' });
    const result = await request(`/work-items/${item.id}/actions`, 'POST', { commandId: randomUUID(), expectedRevision: item.revision + 1, action: { type: 'confirm' } });
    expect(result.status).toBe(409); expect(result.data.code).toBe('revision.stale'); expect(result.data.error).toContain('重新載入');
    expect((await request(`/work-items/${item.id}`)).data.item).toEqual(item);
  });
});
