import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { DeviceStore } from '../server/device-store.js';
import { buildHandoff, previewPastedSharedState } from '../server/handoff.js';
import { sharedProjectSchema } from '../shared/devices.js';
import { EMPTY_MEMORY, PROJECT_STATUSES, type Project } from '../shared/types.js';

const stores = new Set<Store>(), dirs: string[] = [];
const openStore = (file = ':memory:') => { const store = new Store(file); stores.add(store); return store; };
const databaseFile = () => { const dir = mkdtempSync(join(tmpdir(), 'hub-resumption-')); dirs.push(dir); return join(dir, 'hub.sqlite'); };
const wrapUp = (store: Store, project: Project) => store.wrapUpProject(project.id, { revision: project.revision, status: 'Stopped after tests', blockers: 'Waiting for review', nextAction: 'Review the failing test' });
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('private ordered workspace focus', () => {
  it('defaults to an empty singleton and persists order and checkpoints across reopening', () => {
    const file = databaseFile(); let store = openStore(file);
    expect(store.getFocus()).toEqual({ projectIds: [], revision: 1 });
    expect(() => store.db.prepare('INSERT INTO workspace_focus(id) VALUES(2)').run()).toThrow();
    const first = wrapUp(store, store.createProject({ path: '/first', name: 'First' }));
    const second = store.createProject({ path: '/second', name: 'Second' });
    const focus = store.saveFocus(1, [second.id, first.id]);
    store.close(); stores.delete(store); store = openStore(file);
    expect(store.getFocus()).toEqual(focus);
    expect(store.getProject(first.id)).toEqual(first);
    expect(store.getProject(second.id)).toEqual(second);
  });
  it('allows more than three projects and every lifecycle, without touching project or task state', () => {
    const store = openStore();
    const projects = PROJECT_STATUSES.map(status => store.createProject({ path: `/${status}`, name: status, status }));
    const task = store.createTask(projects[0].id, { title: 'Unchanged task' });
    const ids = projects.map(project => project.id).reverse();
    const focus = store.saveFocus(1, ids);
    expect(focus).toEqual({ projectIds: ids, revision: 2 });
    expect(store.saveFocus(focus.revision, ids)).toEqual(focus);
    const reordered = store.saveFocus(focus.revision, [...ids.slice(1), ids[0]]);
    expect(reordered).toEqual({ projectIds: [...ids.slice(1), ids[0]], revision: 3 });
    expect(store.saveFocus(reordered.revision, [])).toEqual({ projectIds: [], revision: 4 });
    for (const project of projects) expect(store.getProject(project.id)).toEqual(project);
    expect(store.getTask(task.id)).toEqual(task);
  });
  it('uses independent compare-and-swap across connections, even for a no-op', () => {
    const file = databaseFile(), first = openStore(file), second = openStore(file);
    const project = first.createProject({ path: '/cas', name: 'CAS' });
    const stale = second.getFocus();
    const saved = first.saveFocus(stale.revision, [project.id]);
    expect(() => second.saveFocus(stale.revision, [project.id])).toThrow(/another tab/);
    expect(() => second.saveFocus(stale.revision, [])).toThrow(/another tab/);
    expect(second.getFocus()).toEqual(saved);
    const renamed = second.updateProject(project.id, { revision: project.revision, name: 'Project revision is independent' });
    expect(first.getFocus()).toEqual(saved);
    expect(first.saveFocus(saved.revision, [])).toEqual({ projectIds: [], revision: saved.revision + 1 });
    expect(first.getProject(project.id)).toEqual(renamed);
  });
  it('rejects malformed, duplicate, unknown and remote-only IDs without partial writes', () => {
    const store = openStore(), project = store.createProject({ path: '/local', name: 'Local' });
    const saved = store.saveFocus(1, [project.id]);
    for (const ids of [[''], ['not-a-uuid'], [42], null]) {
      expect(() => store.saveFocus(saved.revision, ids as string[])).toThrow();
      expect(store.getFocus()).toEqual(saved);
    }
    for (const revision of [0, -1, 1.5, NaN]) expect(() => store.saveFocus(revision, [])).toThrow();
    expect(() => store.saveFocus(saved.revision, [project.id, project.id])).toThrow(/only once/);
    expect(() => store.saveFocus(saved.revision, [project.id, randomUUID()])).toThrow(/this computer/);
    const devices = new DeviceStore(store), owner = randomUUID(), remoteId = randomUUID();
    const profile = devices.addProfile({ url: 'https://focus.example', publishableKey: 'test-public-key' }, randomUUID(), Buffer.from('opaque'));
    devices.cacheDevices(profile.id, [{ id: owner, name: 'Remote owner', lastSeenAt: devices.now(), revokedAt: null }]);
    devices.cacheSnapshot(profile.id, { ownerDeviceId: owner, projectId: remoteId, version: 1, publishedAt: devices.now(),
      project: { name: 'Remote only', status: 'active', priority: 'normal', stage: '', nextAction: '', revision: 1, memory: {} } });
    expect(devices.snapshots(profile.id, owner)).toHaveLength(1);
    expect(() => store.saveFocus(saved.revision, [remoteId])).toThrow(/this computer/);
    expect(store.getFocus()).toEqual(saved); expect(store.getProject(project.id)).toEqual(project);
  });
  it('cleans deleted members atomically, retains order, and increments focus only for members', () => {
    const store = openStore(), projects = ['first', 'middle', 'last', 'outside'].map(name => store.createProject({ path: `/${name}`, name }));
    const [first, middle, last, outside] = projects;
    const task = store.createTask(middle.id, { title: 'Cascade only after commit' });
    const focus = store.saveFocus(1, [last.id, middle.id, first.id]);
    expect(() => store.deleteProject(middle.id, 99)).toThrow(/another tab/);
    expect(store.getFocus()).toEqual(focus);
    store.db.exec("CREATE TRIGGER fail_focus_cleanup BEFORE UPDATE ON workspace_focus BEGIN SELECT RAISE(ABORT, 'injected focus failure'); END;");
    expect(() => store.deleteProject(middle.id, middle.revision)).toThrow(/injected focus failure/);
    expect(store.getProject(middle.id)).toEqual(middle); expect(store.getTask(task.id)).toEqual(task);
    expect(store.getFocus()).toEqual(focus);
    store.db.exec('DROP TRIGGER fail_focus_cleanup');
    store.deleteProject(middle.id, middle.revision);
    const cleaned = { projectIds: [last.id, first.id], revision: focus.revision + 1 };
    expect(store.getFocus()).toEqual(cleaned); expect(store.listTasks()).toEqual([]);
    expect(() => store.saveFocus(focus.revision, focus.projectIds)).toThrow(/another tab/);
    expect(() => store.saveFocus(cleaned.revision, focus.projectIds)).toThrow(/this computer/);
    store.deleteProject(outside.id, outside.revision); expect(store.getFocus()).toEqual(cleaned);
    expect(store.getProject(first.id)).toEqual(first); expect(store.getProject(last.id)).toEqual(last);
  });
});

describe('atomic explicit wrap-up and honest checkpoint dates', () => {
  it('updates exactly three source fields in one project write, preserving all other memory and tasks', () => {
    const store = openStore();
    const created = store.createProject({ path: '/wrap', name: 'Wrap', status: 'paused', priority: 'high', stage: 'Review' });
    const memory = { overview: 'Purpose', status: 'Old stop', architecture: 'Architecture', completed: 'Completed', pending: 'Pending', blockers: 'Old blocker', decisions: 'Decisions', nextActions: 'Other future actions', notes: 'Notes' };
    const project = store.saveMemory(created.id, created.revision, memory);
    const task = store.createTask(project.id, { title: 'Keep task', status: 'blocked' });
    store.db.exec('CREATE TABLE writes(n INTEGER); CREATE TRIGGER count_project_writes AFTER UPDATE ON projects BEGIN INSERT INTO writes VALUES(1); END;');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    const result = store.wrapUpProject(project.id, { revision: project.revision, status: '', blockers: '', nextAction: '  First concrete step  ' });
    expect(result).toEqual({ ...project, memory: { ...memory, status: '', blockers: '' }, nextAction: '  First concrete step  ', revision: project.revision + 1,
      checkpointAt: '2026-01-02T03:04:05.000Z', memoryUpdatedAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z' });
    expect(store.getTask(task.id)).toEqual(task);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM writes').get()!.n).toBe(1);
    vi.setSystemTime(new Date('2026-01-03T03:04:05.000Z'));
    const reconfirmed = store.wrapUpProject(result.id, { revision: result.revision, status: '', blockers: '', nextAction: result.nextAction });
    expect(reconfirmed.checkpointAt).toBe('2026-01-03T03:04:05.000Z');
    expect(reconfirmed.revision).toBe(result.revision + 1); expect(reconfirmed.memory).toEqual(result.memory);
  });
  it('rejects stale and invalid wrap-ups without altering a confirmed checkpoint', () => {
    const store = openStore(), project = wrapUp(store, store.createProject({ path: '/invalid', name: 'Invalid' }));
    const input = { revision: project.revision, status: 'Different', blockers: '', nextAction: 'Next' };
    expect(() => store.wrapUpProject(project.id, { ...input, revision: project.revision - 1 })).toThrow(/another tab/);
    for (const nextAction of ['', ' \n\t ', 'x'.repeat(2001)]) expect(() => store.wrapUpProject(project.id, { ...input, nextAction })).toThrow();
    for (const field of ['status', 'blockers'] as const) expect(() => store.wrapUpProject(project.id, { ...input, [field]: 'x'.repeat(20001) })).toThrow();
    expect(store.getProject(project.id)).toEqual(project);
  });
  it('rolls back every wrap-up field if the single UPDATE fails', () => {
    const store = openStore(), project = wrapUp(store, store.createProject({ path: '/atomic', name: 'Atomic' }));
    store.db.exec("CREATE TRIGGER fail_wrap_up AFTER UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'injected wrap-up failure'); END;");
    expect(() => store.wrapUpProject(project.id, { revision: project.revision, status: 'New', blockers: '', nextAction: 'New step' })).toThrow(/injected wrap-up failure/);
    expect(store.getProject(project.id)).toEqual(project);
  });
  it.each(['projectNextAction', 'status', 'blockers', 'importNextAction'] as const)('invalidates only when a confirmed source changes through %s', field => {
    const store = openStore(), project = wrapUp(store, store.createProject({ path: '/invalidation', name: 'Invalidation' }));
    let changed: Project;
    if (field === 'projectNextAction') changed = store.updateProject(project.id, { revision: project.revision, nextAction: 'Changed next step' });
    else changed = store.saveMemory(project.id, project.revision,
      field === 'importNextAction' ? project.memory : { ...project.memory, [field]: '' }, field === 'importNextAction' ? 'Imported next step' : undefined);
    expect(changed.checkpointAt).toBeNull(); expect(changed.revision).toBe(project.revision + 1);
  });
  it('keeps checkpoints on unchanged sources, unrelated edits, tasks, Git and focus changes', () => {
    const store = openStore(), checkpoint = wrapUp(store, store.createProject({ path: '/honest', name: 'Honest' }));
    let project = store.updateProject(checkpoint.id, { revision: checkpoint.revision, nextAction: checkpoint.nextAction, name: 'Renamed', status: 'archived', priority: 'low', description: 'Description', stage: 'Stage' });
    expect(project.checkpointAt).toBe(checkpoint.checkpointAt);
    project = store.saveMemory(project.id, project.revision, { ...project.memory, notes: 'New notes', overview: 'Purpose', nextActions: 'Future candidates' }, project.nextAction);
    expect(project.checkpointAt).toBe(checkpoint.checkpointAt);
    store.saveObservation(project.id, null, 'offline');
    const task = store.createTask(project.id, { title: 'Task' }); store.updateTask(task.id, { revision: task.revision, status: 'done' });
    store.saveFocus(1, [project.id]);
    expect(store.getProject(project.id)).toEqual({ ...project, gitError: 'offline', lastCheckedAt: store.getProject(project.id).lastCheckedAt });
    expect(() => store.updateProject(project.id, { revision: checkpoint.revision, nextAction: 'Stale' })).toThrow(/another tab/);
    expect(() => store.saveMemory(project.id, checkpoint.revision, EMPTY_MEMORY)).toThrow(/another tab/);
    expect(store.getProject(project.id).checkpointAt).toBe(checkpoint.checkpointAt);
  });
  it.each(['memory', 'project'] as const)('participates in an existing proposal transaction for %s without a nested BEGIN', kind => {
    const store = openStore(), project = wrapUp(store, store.createProject({ path: '/proposal', name: 'Proposal' }));
    const mutate = () => kind === 'memory'
      ? store.saveMemory(project.id, project.revision, { ...project.memory, status: 'New status' })
      : store.updateProject(project.id, { revision: project.revision, nextAction: 'New next step' });
    expect(() => store.transaction(() => { expect(mutate().checkpointAt).toBeNull(); throw new Error('injected decision failure'); })).toThrow(/injected decision failure/);
    expect(store.getProject(project.id)).toEqual(project);
    expect(store.transaction(mutate).checkpointAt).toBeNull();
  });
});

describe('resumption metadata stays local', () => {
  it('does not extend handoff or cloud DTOs, and focus changes do not republish summaries', () => {
    const store = openStore(), created = store.createProject({ path: '/private', name: 'Shared text only' });
    const withNotes = store.saveMemory(created.id, created.revision, { ...EMPTY_MEMORY, notes: 'PRIVATE_NOTES' });
    const project = wrapUp(store, withNotes), devices = new DeviceStore(store);
    const profile = devices.addProfile({ url: 'https://resumption.example', publishableKey: 'test-public-key' }, randomUUID(), Buffer.from('opaque'));
    devices.setPolicy(profile.id, { projectId: project.id, enabled: true, memoryFields: ['status', 'blockers'] });
    const before = devices.publications(profile.id);
    store.saveFocus(1, [project.id]); devices.reconcilePublications(profile.id);
    expect(devices.publications(profile.id)).toEqual(before);
    const shared = before[0].project!;
    expect(shared).toEqual({ name: project.name, status: project.status, priority: project.priority, stage: project.stage, nextAction: project.nextAction,
      revision: project.revision, memory: { status: project.memory.status, blockers: project.memory.blockers } });
    expect(JSON.stringify(before)).not.toMatch(/checkpointAt|checkpoint_at|focus|projectIds|PRIVATE_NOTES/);
    const handoff = buildHandoff(project, []);
    expect(Object.keys(handoff.state).sort()).toEqual(['schemaVersion', 'projectId', 'projectName', 'exportedAt', 'memory', 'nextAction'].sort());
    expect(JSON.stringify(handoff.state)).not.toMatch(/checkpointAt|checkpoint_at|focus|projectIds/);
    for (const extra of [{ checkpointAt: project.checkpointAt }, { focus: store.getFocus() }]) {
      expect(() => previewPastedSharedState(project, JSON.stringify({ ...handoff.state, ...extra }))).toThrow(/format/);
      expect(sharedProjectSchema.safeParse({ ...shared, ...extra }).success).toBe(false);
    }
  });
});
