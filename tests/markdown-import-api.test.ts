import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { DeviceService } from '../server/devices.js';
import { formatSharedSummary, type SharedSummarySource } from '../shared/shared-summary.js';
import { MAX_MARKDOWN_BYTES, type MarkdownImportApplyInput, type MarkdownImportPreview } from '../shared/markdown-import.js';
import { MEMORY_FIELDS, getMemoryLabels, type Project } from '../shared/types.js';
import type { MemoryField, SharedProject } from '../shared/devices.js';

let server: Server, store: Store, devices: DeviceService, dir: string, base: string, token: string;
const relayFactory = vi.fn(() => { throw new Error('Markdown import must not connect to a relay'); });
const readGit = vi.fn(async () => { throw new Error('Markdown import must not inspect project directories'); });
const source: Omit<SharedSummarySource, 'projectId'> = {
  profileId: randomUUID(), groupLabel: 'Former source group (unverified)', ownerDeviceId: randomUUID(), ownerName: 'Other device (unverified)',
  version: 7, pending: false, publishedAt: '2025-01-02T03:04:05.000Z', receivedAt: null, lastSyncAt: null,
};
const rawHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
async function api(path: string, body?: unknown, headers: Record<string, string> = {}, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function rawApi(path: string, body: string, headers: Record<string, string> = {}, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token, ...headers }, body });
  return { status: response.status, data: await response.json() };
}
async function closeServer() {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function startApp(withDevices = true) {
  const { app } = createApp({ store, dataDir: dir, ...(withDevices ? { deviceService: devices } : {}), readGit,
    capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }),
    desktopCapabilities: async () => ({ claude: false, chatgpt: false }) });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  token = (await api('/workspace', undefined, {}, 'GET')).data.csrfToken;
}
function localProject(path = join(dir, randomUUID())) {
  const created = store.createProject({ path, name: 'Actual local project', description: 'Local description', category: 'Local category',
    status: 'paused', priority: 'high', stage: 'Local stage', nextAction: 'Keep local next action' });
  return store.saveMemory(created.id, created.revision, Object.fromEntries(MEMORY_FIELDS.map(field => [field, `Keep local ${field}`])) as Project['memory']);
}
function markdown(project: Project, patch: Partial<SharedProject> = {}, metadata: Partial<SharedSummarySource> = {}) {
  return formatSharedSummary({ name: 'Untrusted source title', status: 'completed', priority: 'low', stage: 'Untrusted source stage',
    nextAction: 'Imported next action', memory: { status: 'Imported memory status' }, revision: project.revision, ...patch },
  { ...source, projectId: project.id, ...metadata }).text;
}
async function preview(text: string) {
  const response = await api('/markdown-import/preview', { text });
  expect(response.status).toBe(200);
  return response.data as MarkdownImportPreview;
}
function applyBody(text: string, review: MarkdownImportPreview): MarkdownImportApplyInput {
  return { text, projectId: review.projectId, hash: review.hash, revision: review.revision, digest: review.digest, confirm: true };
}
function databaseRows() {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()]));
}
function totalChanges() { return Number(store.db.prepare('SELECT total_changes() AS n').get()!.n); }
function addGroup(label = 'Current local group', enabled = true) {
  const deviceId = randomUUID();
  const profile = devices.repository.addProfile({ url: 'https://never-contact.invalid', publishableKey: 'not-a-real-key' }, deviceId, new Uint8Array(), label);
  devices.repository.finishPairing(profile.id, randomUUID(), new Uint8Array(), { id: deviceId, name: 'Local device', lastSeenAt: '2025-01-01T00:00:00.000Z', revokedAt: null });
  devices.repository.setEnabled(profile.id, enabled);
  return profile.id;
}
function share(profileId: string, projectId: string, memoryFields: MemoryField[], enabled = true) {
  devices.repository.setPolicy(profileId, { projectId, enabled, memoryFields });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-markdown-import-'));
  store = new Store(':memory:');
  relayFactory.mockClear(); readGit.mockClear();
  devices = new DeviceService(store, { relayFactory });
  await startApp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeServer(); await devices.stop(); store.close();
  await rm(dir, { recursive: true, force: true });
  expect(relayFactory).not.toHaveBeenCalled(); expect(readGit).not.toHaveBeenCalled();
});

describe('local Markdown import preview and atomic apply', () => {
  it('previews using only local reads, including stale publications and read-only project files', async () => {
    const path = join(dir, 'project'); await mkdir(join(path, '.ai-project-hub'), { recursive: true });
    const file = join(path, '.ai-project-hub', 'state.json'); await writeFile(file, '{"keep":"untouched"}'); await chmod(file, 0o444);
    try {
      let project = localProject(path);
      const group = addGroup(); share(group, project.id, ['status']);
      devices.repository.queue(group, 'existing-outbox', 'rename', { name: 'Keep queued data' });
      // Leave the publication behind the local revision. Aggregate getters would write here.
      project = store.saveMemory(project.id, project.revision, { ...project.memory, notes: 'Local unpublished edit' });
      const never = () => { throw new Error('Import called a stateful aggregate'); };
      const state = vi.spyOn(devices, 'state').mockImplementation(never);
      const aggregate = vi.spyOn(devices, 'sharedWorkspace').mockImplementation(never);
      const own = vi.spyOn(devices.repository, 'ownSnapshots').mockImplementation(never);
      const reconcile = vi.spyOn(devices.repository, 'reconcilePublications').mockImplementation(never);
      const before = databaseRows(), changes = totalChanges(), fileBefore = await stat(file);
      const text = markdown(project, { revision: 1 });
      const reviewed = await preview(text);
      expect(reviewed).toMatchObject({ projectId: project.id, projectName: project.name, revision: project.revision, hash: rawHash(text),
        source: { projectId: project.id, projectName: 'Untrusted source title', revision: 1, profileId: source.profileId, ownerDeviceId: source.ownerDeviceId },
        sourceRevisionDiffers: true, canApply: true, sharing: [{ profileId: group, label: 'Current local group', fields: ['nextAction', 'status'], paused: false }] });
      expect(reviewed.changes).toEqual([
        { key: 'nextAction', label: 'Next action', before: project.nextAction, after: 'Imported next action' },
        { key: 'status', label: getMemoryLabels().status, before: project.memory.status, after: 'Imported memory status' },
      ]);
      expect(reviewed.skipped).toContainEqual({ field: 'notes', reason: 'missing' });
      expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
      expect((await stat(file)).mtimeMs).toBe(fileBefore.mtimeMs);
      expect(await readFile(file, 'utf8')).toBe('{"keep":"untouched"}');
      expect(await readdir(path)).toEqual(['.ai-project-hub']);
      for (const spy of [state, aggregate, own, reconcile]) expect(spy).not.toHaveBeenCalled();
    } finally { await chmod(file, 0o644); }
  });

  it('changes only supplied nonblank memory and nextAction, exactly once, without syncing or creating files', async () => {
    const path = join(dir, 'project'); await mkdir(path); await writeFile(join(path, 'keep.txt'), 'Do not change files');
    const project = localProject(path), task = store.createTask(project.id, { title: 'Existing local task' });
    const group = addGroup(); share(group, project.id, ['status']);
    const text = markdown(project, { memory: { status: '  New status\nwith deliberate spaces  ', notes: ' \t\n ' } });
    const reviewed = await preview(text), before = databaseRows(), changes = totalChanges();
    expect(reviewed.skipped).toContainEqual({ field: 'notes', reason: 'blank' });
    const save = vi.spyOn(store, 'saveMemory'), transaction = vi.spyOn(store, 'transaction');
    const response = await api('/markdown-import/apply', applyBody(text, reviewed));
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ...project, revision: project.revision + 1, nextAction: 'Imported next action',
      memory: { ...project.memory, status: '  New status\nwith deliberate spaces  ' }, updatedAt: expect.any(String), memoryUpdatedAt: expect.any(String) });
    expect(save).toHaveBeenCalledTimes(1); expect(transaction).toHaveBeenCalledTimes(1); expect(totalChanges()).toBe(changes + 1);
    expect(store.getTask(task.id)).toEqual(task);
    const after = databaseRows();
    expect({ ...after, projects: before.projects }).toEqual(before);
    expect(await readdir(path)).toEqual(['keep.txt']); expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('Do not change files');
    expect(await api('/markdown-import/apply', applyBody(text, reviewed))).toMatchObject({ status: 409, data: { code: 'markdown.changed' } });
    expect(save).toHaveBeenCalledTimes(1); expect(totalChanges()).toBe(changes + 1);
  });

  it('works offline without a DeviceService, group, selected profile, or an existing project directory', async () => {
    await closeServer(); await startApp(false);
    const project = localProject(join(dir, 'missing-offline-drive', 'project'));
    const text = markdown(project);
    const reviewed = await preview(text);
    expect(reviewed.sharing).toEqual([]);
    expect((await api('/markdown-import/apply', applyBody(text, reviewed))).status).toBe(200);
    expect(await readdir(dir)).toEqual([]);
  });

  it('treats source groups and owner names as unverified provenance, including a group already left', async () => {
    const project = localProject(), former = addGroup('Former group'), current = addGroup('Other group');
    share(former, project.id, ['status']); share(current, project.id, ['notes']);
    devices.repository.detach(former);
    const text = markdown(project, { revision: 1 }, { profileId: former, ownerDeviceId: randomUUID(), groupLabel: 'Untrusted destination label' });
    const reviewed = await preview(text);
    expect(reviewed.source.profileId).toBe(former); expect(reviewed.sourceRevisionDiffers).toBe(true);
    expect(reviewed.sharing.map(group => group.profileId)).toEqual([current]);
    const response = await api('/markdown-import/apply', applyBody(text, reviewed), { 'X-Hub-Profile-Id': randomUUID() });
    expect(response.status).toBe(200); expect(response.data.id).toBe(project.id);
    expect(devices.repository.profile(former)!.attached).toBe(false);
  });

  it('requires an existing exact local UUID and never falls back to a title, folder, or remote snapshot', async () => {
    const project = localProject(), missing = randomUUID();
    const before = databaseRows(), changes = totalChanges();
    const text = markdown(project, { name: project.name }, { projectId: missing });
    expect(await api('/markdown-import/preview', { text })).toMatchObject({ status: 404, data: { code: 'markdown.targetMissing' } });
    expect(await api('/markdown-import/apply', { text, projectId: missing, hash: rawHash(text), revision: project.revision, digest: '0'.repeat(64), confirm: true }))
      .toMatchObject({ status: 404, data: { code: 'markdown.targetMissing' } });
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });

  it('rejects a document/request target mismatch even when both UUIDs identify local projects', async () => {
    const first = localProject(), second = localProject(), text = markdown(first), reviewed = await preview(text);
    const before = databaseRows(), changes = totalChanges();
    for (const body of [
      { ...applyBody(text, reviewed), projectId: second.id },
      { ...applyBody(markdown(second), reviewed), hash: rawHash(markdown(second)) },
    ]) expect(await api('/markdown-import/apply', body)).toMatchObject({ status: 409, data: { code: 'markdown.targetMismatch' } });
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });

  it('requires explicit confirmation and strict request schemas on both endpoints', async () => {
    const project = localProject(), text = markdown(project), reviewed = await preview(text), body = applyBody(text, reviewed);
    const { confirm: _confirm, ...noConfirm } = body;
    const before = databaseRows(), changes = totalChanges();
    for (const invalid of [noConfirm, { ...body, confirm: false }, { ...body, confirm: 'true' }, { ...body, path: project.path },
      { ...body, projectId: 'not-a-uuid' }, { ...body, revision: 0 }, { ...body, revision: '2' }, { ...body, hash: 'not-a-hash' }, { ...body, digest: 'bad' }]) {
      expect(await api('/markdown-import/apply', invalid)).toMatchObject({ status: 400, data: { code: 'validation.failed' } });
    }
    for (const invalid of [{}, { text: 42 }, { text, projectId: project.id }, { text, profileId: source.profileId }, { text, path: project.path }]) {
      expect(await api('/markdown-import/preview', invalid)).toMatchObject({ status: 400, data: { code: 'validation.failed' } });
    }
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });

  it('binds exact raw UTF-8 including whitespace, BOM, CRLF and a whole-document wrapper', async () => {
    const project = localProject(), text = markdown(project), reviewed = await preview(text), body = applyBody(text, reviewed);
    const before = databaseRows(), changes = totalChanges();
    for (const changed of [text + '\n', '﻿' + text, text.replaceAll('\n', '\r\n'), `\`\`\`markdown\n${text}\`\`\`\n`]) {
      const next = await preview(changed);
      expect(next.hash).toBe(rawHash(changed)); expect(next.hash).not.toBe(reviewed.hash);
      expect(next.changes).toEqual(reviewed.changes);
      for (const input of [{ ...body, text: changed }, { ...body, text: changed, hash: next.hash }]) {
        expect(await api('/markdown-import/apply', input)).toMatchObject({ status: 409, data: { code: 'markdown.changed' } });
      }
    }
    for (const input of [{ ...body, hash: '0'.repeat(64) }, { ...body, digest: '0'.repeat(64) }]) {
      expect(await api('/markdown-import/apply', input)).toMatchObject({ status: 409, data: { code: 'markdown.changed' } });
    }
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });

  it('rejects a stale current revision and a target removed after preview without changing other data', async () => {
    const project = localProject(), text = markdown(project), reviewed = await preview(text);
    const newer = store.saveMemory(project.id, project.revision, { ...project.memory, notes: 'Newer local edit' });
    const before = databaseRows(), changes = totalChanges();
    expect(await api('/markdown-import/apply', applyBody(text, reviewed))).toMatchObject({ status: 409, data: { code: 'markdown.changed' } });
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
    store.deleteProject(project.id, newer.revision);
    expect(await api('/markdown-import/apply', applyBody(text, reviewed))).toMatchObject({ status: 404, data: { code: 'markdown.targetMissing' } });
    expect(store.listProjects()).toEqual([]);
  });

  it.each(['blank', 'unchanged'] as const)('does not write or bump revision for %s input', async kind => {
    const project = localProject();
    const text = markdown(project, kind === 'blank'
      ? { nextAction: ' \n\t ', memory: Object.fromEntries(MEMORY_FIELDS.map(field => [field, ' \t\n '])) }
      : { nextAction: project.nextAction, memory: project.memory });
    const before = databaseRows(), changes = totalChanges(), reviewed = await preview(text);
    expect(reviewed.canApply).toBe(false); expect(reviewed.changes).toEqual([]);
    if (kind === 'blank') expect(reviewed.skipped).toHaveLength(10);
    expect(await api('/markdown-import/apply', applyBody(text, reviewed))).toMatchObject({ status: 409, data: { code: 'markdown.noChanges' } });
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });

  it('rolls back the entire single transaction if the one memory save fails after updating', async () => {
    const project = localProject(), text = markdown(project), reviewed = await preview(text), before = databaseRows();
    const save = store.saveMemory.bind(store);
    vi.spyOn(store, 'saveMemory').mockImplementation((...args) => { save(...args); throw new Error('Injected persistence failure'); });
    const transaction = vi.spyOn(store, 'transaction');
    expect((await api('/markdown-import/apply', applyBody(text, reviewed))).status).toBe(400);
    expect(transaction).toHaveBeenCalledTimes(1); expect(databaseRows()).toEqual(before);
  });

  it('validates the merged complete memory with the existing schema before writing', async () => {
    let project = localProject();
    project = store.saveMemory(project.id, project.revision, { ...project.memory, notes: 'x'.repeat(20001) });
    const text = markdown(project), reviewed = await preview(text), before = databaseRows(), changes = totalChanges();
    expect(await api('/markdown-import/apply', applyBody(text, reviewed))).toMatchObject({ status: 400, data: { code: 'validation.failed' } });
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });
});

describe('current sharing policy consent', () => {
  it('reports only actually changed shared fields, with paused groups and no source-group dependency', async () => {
    const project = localProject(), statusGroup = addGroup('Status group'), notesGroup = addGroup('Paused notes', false), offGroup = addGroup('Not shared');
    share(statusGroup, project.id, ['status']); share(notesGroup, project.id, ['notes']); share(offGroup, project.id, ['status', 'notes'], false);
    const text = markdown(project, { nextAction: project.nextAction, memory: { status: 'Changed status', notes: 'Changed notes', overview: project.memory.overview } });
    const reviewed = await preview(text);
    expect(reviewed.sharing).toEqual(expect.arrayContaining([
      { profileId: statusGroup, label: 'Status group', fields: ['status'], paused: false },
      { profileId: notesGroup, label: 'Paused notes', fields: ['notes'], paused: true },
    ]));
    expect(reviewed.sharing).toHaveLength(2);
    expect(reviewed.changes.map(change => change.key)).toEqual(['status', 'notes']);
  });

  it.each(['fields', 'withdraw', 'join', 'leave', 'pause', 'revoke'] as const)('refuses a %s policy/membership race with no import write', async race => {
    const project = localProject(), group = addGroup(); share(group, project.id, ['status']);
    const text = markdown(project), reviewed = await preview(text);
    if (race === 'fields') share(group, project.id, ['status', 'notes']);
    if (race === 'withdraw') share(group, project.id, ['status'], false);
    if (race === 'join') addGroup('New membership');
    if (race === 'leave') devices.repository.detach(group);
    if (race === 'pause') devices.repository.setEnabled(group, false);
    if (race === 'revoke') devices.repository.setConnection(group, 'revoked');
    const before = databaseRows(), changes = totalChanges();
    expect(await api('/markdown-import/apply', applyBody(text, reviewed))).toMatchObject({ status: 409, data: { code: 'markdown.changed' } });
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });

  it('keeps consent stable across locale, labels, active selection and volatile sync timestamps', async () => {
    const project = localProject(), group = addGroup('Old label'), other = addGroup('Other membership'); share(group, project.id, ['status']);
    const text = markdown(project), reviewed = await preview(text);
    devices.repository.labelProfile(group, 'New label');
    devices.repository.selectProfile(other);
    devices.repository.setConnection(group, 'online', null, true);
    store.updateSettings({ locale: 'zh-TW' });
    const updated = await preview(text);
    expect(updated.digest).toBe(reviewed.digest); expect(updated.hash).toBe(reviewed.hash);
    expect(updated.sharing[0].label).toBe('New label'); expect(updated.changes[0].label).toBe('下一步行動');
    expect(updated.changes[1].label).toBe(getMemoryLabels('zh-TW').status);
    expect((await api('/markdown-import/apply', applyBody(text, reviewed))).status).toBe(200);
  });
});

describe('Markdown API transport boundaries', () => {
  it('allows JSON Unicode escaping over 1 MiB on both text endpoints while retaining decoded UTF-8 bounds', async () => {
    const project = localProject();
    const text = markdown(project, { nextAction: 'a'.repeat(2000), memory: Object.fromEntries(MEMORY_FIELDS.map(field => [field, 'a'.repeat(20000)])) });
    const escaped = JSON.stringify({ text }).replaceAll('a', '\\u0061');
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_MARKDOWN_BYTES); expect(Buffer.byteLength(escaped)).toBeGreaterThan(MAX_MARKDOWN_BYTES);
    const reviewResponse = await rawApi('/markdown-import/preview', escaped);
    expect(reviewResponse.status).toBe(200);
    const body = JSON.stringify(applyBody(text, reviewResponse.data)).replaceAll('a', '\\u0061');
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_MARKDOWN_BYTES);
    expect((await rawApi('/markdown-import/apply', body)).status).toBe(200);
    expect(store.getProject(project.id).memory.notes).toHaveLength(20000);
  });

  it('accepts a fully Unicode-escaped maximum-size document on both endpoints', async () => {
    const project = localProject(), original = markdown(project);
    const text = original + '\n'.repeat(MAX_MARKDOWN_BYTES - Buffer.byteLength(original));
    const escaped = text.replace(/[\s\S]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const response = await rawApi('/markdown-import/preview', `{"text":"${escaped}"}`);
    expect(response.status).toBe(200); expect(response.data.hash).toBe(rawHash(text));
    const body = JSON.stringify(applyBody('', response.data)).replace('"text":""', `"text":"${escaped}"`);
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_MARKDOWN_BYTES * 6);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES * 6 + 1024);
    expect((await rawApi('/markdown-import/apply', body)).status).toBe(200);
    expect(store.getProject(project.id).revision).toBe(project.revision + 1);
  });

  it('enforces decoded 1 MiB rather than UTF-16 length and localizes parser errors', async () => {
    const project = localProject(), text = markdown(project), before = databaseRows(), changes = totalChanges();
    const exact = text + '\n'.repeat(MAX_MARKDOWN_BYTES - Buffer.byteLength(text));
    expect((await api('/markdown-import/preview', { text: exact })).status).toBe(200);
    for (const oversized of [exact + '\n', text + '界'.repeat(Math.ceil(MAX_MARKDOWN_BYTES / 3))]) {
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_MARKDOWN_BYTES);
      expect(await api('/markdown-import/preview', { text: oversized })).toMatchObject({ status: 413, data: { code: 'markdown.large' } });
      expect(await api('/markdown-import/apply', { text: oversized, projectId: project.id, revision: project.revision,
        hash: rawHash(oversized), digest: '0'.repeat(64), confirm: true })).toMatchObject({ status: 413, data: { code: 'markdown.large' } });
    }
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
    store.updateSettings({ locale: 'zh-TW' });
    const invalid = await api('/markdown-import/preview', { text: 'not an exported summary' });
    expect(invalid.status).toBe(400); expect(invalid.data.code).toBe('markdown.invalid'); expect(invalid.data.error).toMatch(/[㐀-鿿]/u);
  });

  it('bounds the escaped envelope and leaves all other routes at their original 1 MiB limit', async () => {
    const before = databaseRows(), changes = totalChanges();
    const oversized = JSON.stringify({ text: 'x'.repeat(MAX_MARKDOWN_BYTES * 6 + 1024) });
    for (const path of ['/markdown-import/preview', '/markdown-import/apply']) {
      expect(await rawApi(path, oversized)).toMatchObject({ status: 413, data: { code: 'request.tooLarge' } });
    }
    const otherBody = JSON.stringify({ text: 'x'.repeat(MAX_MARKDOWN_BYTES) });
    for (const [path, method] of [['/settings', 'PATCH'], ['/markdown-import/preview/extra', 'POST'], ['/markdown-import/other', 'POST']]) {
      expect(await rawApi(path, otherBody, {}, method)).toMatchObject({ status: 413, data: { code: 'request.tooLarge' } });
    }
    expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });

  it('preserves Origin, CSRF, cross-site, content-type and malformed-JSON protections', async () => {
    const project = localProject(), text = markdown(project), reviewed = await preview(text), before = databaseRows(), changes = totalChanges();
    const hostileHeaders: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' },
      { 'X-Hub-Token': '' }, { 'X-Hub-Token': 'bad' }, { 'Content-Type': 'text/plain' }];
    for (const [path, body] of [['/markdown-import/preview', { text }], ['/markdown-import/apply', applyBody(text, reviewed)]] as const) {
      for (const headers of hostileHeaders) expect((await api(path, body, headers)).status).toBe(403);
      expect(await rawApi(path, '{"text":')).toMatchObject({ status: 400, data: { code: 'request.invalidJson' } });
      expect((await rawApi(path, '')).status).toBe(400);
      expect((await api(path.toUpperCase(), body, { 'X-Hub-Token': '' })).status).toBe(403);
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(base + '/api/markdown-import/preview', { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json', 'X-Hub-Token': token } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject); request.end(JSON.stringify({ text }));
    });
    expect(status).toBe(403); expect(databaseRows()).toEqual(before); expect(totalChanges()).toBe(changes);
  });
});
