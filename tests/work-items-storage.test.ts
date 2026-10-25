import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.js';
import { WorkItems } from '../server/work-items.js';
import { DeviceStore } from '../server/device-store.js';
import { buildHandoff } from '../server/handoff.js';
import { activeWorkHold, type WorkItem, type WorkAction, type WorkBrief } from '../shared/work-items.js';

const stores = new Set<Store>(), dirs: string[] = [];
const brief: WorkBrief = { title: 'Login validation', goal: 'Show an error for invalid email', nonGoals: 'Do not redesign login', acceptanceCriteria: ['Invalid email shows an error', 'Valid email still works'], firstCheck: 'Enter an invalid email' };
const opened = (file = ':memory:') => { const store = new Store(file); stores.add(store); return store; };
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'hub-work-items-')); dirs.push(dir); return join(dir, 'hub.sqlite'); };
const setup = (store = opened(), clock?: () => string) => {
  const project = store.createProject({ path: '/work', name: 'Work' });
  const service = new WorkItems(store, clock);
  const item = service.createDraft(project.id, { commandId: randomUUID(), brief }).item;
  return { store, project, service, item };
};
const act = (service: WorkItems, item: WorkItem, action: WorkAction) => service.apply(item.id, { commandId: randomUUID(), expectedRevision: item.revision, action }).item;
const ready = (service: WorkItems, item: WorkItem) => act(service, item, { type: 'confirm' });
const send = (service: WorkItems, item: WorkItem) => act(service, item, { type: 'dispatch', previewHash: service.preview(item.id).hash });
const check = (service: WorkItems, item: WorkItem, role: 'self' | 'partner', outcome: 'pass' | 'fail' = 'pass') => act(service, item, {
  type: 'recordCheck', role, outcome, note: 'Checked the invalid and valid inputs', source: role === 'self' ? 'self' : 'in_person', version: item.version, submissionId: item.currentSubmissionId!,
});
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('work item lifecycle', () => {
  it('keeps preview and copy read-only, and only explicit dispatch creates a frozen snapshot', () => {
    const { service, item } = setup();
    expect(() => service.preview(item.id)).toThrow();
    const confirmed = ready(service, item), preview = service.preview(item.id);
    expect(preview.markdown).toContain(brief.firstCheck);
    expect(service.get(item.id)).toEqual(confirmed);
    const sent = send(service, confirmed);
    expect(sent).toMatchObject({ phase: 'awaiting_return', version: 1 });
    const event = service.detail(item.id).events.find(event => event.type === 'dispatch')!;
    expect(event.payload).toMatchObject({ markdown: preview.markdown, brief, submissionId: sent.currentSubmissionId });
    const progress = act(service, sent, { type: 'saveProgress', progress: 'Returned from another project', nextAction: 'Inspect the form' });
    expect(progress.phase).toBe('awaiting_return');
    expect(service.detail(item.id).events.find(entry => entry.type === 'dispatch')!.payload).toEqual(event.payload);
  });
  it('allows a one-line draft but requires complete acceptance before confirmation', () => {
    const { service, project } = setup();
    let item = service.createDraft(project.id, { commandId: randomUUID(), brief: { ...brief, title: '', acceptanceCriteria: [], firstCheck: '' } }).item;
    expect(() => ready(service, item)).toThrow(/title/);
    expect(service.get(item.id).revision).toBe(1);
    item = act(service, item, { type: 'saveDraft', brief });
    item = ready(service, item);
    expect(() => act(service, item, { type: 'saveDraft', brief: { ...brief, goal: 'Changed' } })).toThrow(/current stage/);
  });
  it('requires both reviewers on the current result and a separate completion action', () => {
    let { service, item } = setup();
    item = send(service, ready(service, item));
    expect(() => act(service, item, { type: 'complete' })).toThrow();
    item = act(service, item, { type: 'startReview', resultNote: 'Changes returned by Codex' });
    expect(() => act(service, item, { type: 'complete' })).toThrow(/Both/);
    item = check(service, item, 'self');
    expect(() => act(service, item, { type: 'complete' })).toThrow(/Both/);
    item = check(service, item, 'partner');
    expect(item.phase).toBe('review');
    expect(item.checks.partner).toMatchObject({ source: 'in_person', recordedBy: 'local-user' });
    item = act(service, item, { type: 'complete' });
    expect(item.phase).toBe('done');
  });
  it('supports manually prepared results without inventing a Codex handoff', () => {
    let { service, item } = setup();
    item = act(service, ready(service, item), { type: 'startReview', resultNote: 'Implemented manually' });
    expect(item.currentSubmissionId).toBeTruthy();
    expect(service.detail(item.id).events.filter(event => event.type === 'dispatch')).toEqual([]);
    expect(service.detail(item.id).events.at(-1)!.payload.source).toBe('manual');
    item = check(service, check(service, item, 'self'), 'partner');
    expect(act(service, item, { type: 'complete' }).phase).toBe('done');
  });
  it('preserves failed evidence and starts one new version for correction and re-dispatch', () => {
    let { service, item } = setup();
    item = act(service, send(service, ready(service, item)), { type: 'startReview', resultNote: '' });
    const oldSubmission = item.currentSubmissionId!;
    item = check(service, item, 'self', 'fail');
    expect(() => check(service, item, 'self')).toThrow(/already recorded/);
    item = check(service, item, 'partner');
    expect(() => act(service, item, { type: 'complete' })).toThrow(/Both/);
    item = act(service, item, { type: 'revise', kind: 'rework', reason: 'Fix the missing error' });
    expect(item).toMatchObject({ phase: 'ready', version: 2, currentSubmissionId: null, checks: { self: null, partner: null } });
    item = send(service, item);
    expect(item.version).toBe(2); expect(item.currentSubmissionId).not.toBe(oldSubmission);
    item = act(service, item, { type: 'startReview', resultNote: 'Fixed result' });
    expect(() => act(service, item, { type: 'recordCheck', role: 'self', outcome: 'pass', note: 'Old check', source: 'self', version: 1, submissionId: oldSubmission })).toThrow(/different result/);
    expect(service.detail(item.id).events.filter(event => event.type === 'recordCheck')).toHaveLength(2);
  });
  it('changes confirmed scope only through a new draft version and invalidates completion on reopening', () => {
    let { service, item } = setup();
    item = act(service, ready(service, item), { type: 'revise', kind: 'scope', reason: 'Use a smaller goal' });
    expect(item).toMatchObject({ phase: 'draft', version: 2 });
    item = ready(service, act(service, item, { type: 'saveDraft', brief: { ...brief, goal: 'Only required-field validation' } }));
    item = act(service, item, { type: 'startReview', resultNote: '' });
    item = act(service, check(service, check(service, item, 'self'), 'partner'), { type: 'complete' });
    const reopened = act(service, item, { type: 'revise', kind: 'reopen', reason: 'A new defect was reported' });
    expect(reopened).toMatchObject({ phase: 'ready', version: 3, checks: { self: null, partner: null } });
  });
  it('validates actual verification source and rejects direct status changes or unknown actions', () => {
    let { service, item } = setup();
    item = act(service, ready(service, item), { type: 'startReview', resultNote: '' });
    for (const [role, source] of [['partner', 'self'], ['self', 'message']] as const) {
      expect(() => act(service, item, { type: 'recordCheck', role, source, outcome: 'pass', note: 'Checked', version: item.version, submissionId: item.currentSubmissionId! })).toThrow(/source|Record your own/);
    }
    expect(() => service.apply(item.id, { commandId: randomUUID(), expectedRevision: item.revision, action: { type: 'complete', phase: 'done' } } as never)).toThrow();
  });
  it('keeps waiting and deferred work in the original phase and uses expiry only for availability', () => {
    let now = '2026-10-25T10:00:00.000Z';
    let { service, item } = setup(opened(), () => now);
    item = send(service, ready(service, item));
    item = act(service, item, { type: 'setHold', hold: { kind: 'waiting', reason: 'Waiting for approval', resumeAction: 'Ask the reviewer', until: null } });
    expect(item.phase).toBe('awaiting_return');
    expect(() => act(service, item, { type: 'startReview', resultNote: '' })).toThrow(/Resume/);
    item = act(service, item, { type: 'resume' });
    item = act(service, item, { type: 'setHold', hold: { kind: 'deferred', reason: 'After class', resumeAction: 'Check the result', until: '2026-10-25T12:00:00.000Z' } });
    expect(activeWorkHold(item, Date.parse(now))).toBeTruthy();
    now = '2026-10-25T13:00:00.000Z';
    expect(activeWorkHold(item, Date.parse(now))).toBeNull();
    expect(service.get(item.id)).toEqual(item);
    item = act(service, item, { type: 'startReview', resultNote: '' });
    expect(item.phase).toBe('review');
    expect(() => act(service, item, { type: 'setHold', hold: { kind: 'deferred', reason: 'Past', resumeAction: 'Check', until: '2026-10-25T12:00:00.000Z' } })).toThrow(/future/);
  });
});

describe('durability, retries and local-only data', () => {
  it('replays exact create and action requests once, returning the latest item and the original receipt', () => {
    const store = opened(), project = store.createProject({ path: '/retry', name: 'Retry' }), service = new WorkItems(store);
    const input = { commandId: randomUUID(), brief }, first = service.createDraft(project.id, input);
    expect(service.createDraft(project.id, input).item.id).toBe(first.item.id); expect(service.list()).toHaveLength(1);
    const command = { commandId: randomUUID(), expectedRevision: first.item.revision, action: { type: 'confirm' as const } };
    const confirmed = service.apply(first.item.id, command);
    const progressed = act(service, confirmed.item, { type: 'saveProgress', progress: 'Ready', nextAction: 'Send the prompt' });
    const replay = service.apply(first.item.id, command);
    expect(replay.item).toEqual(progressed); expect(replay.receipt).toEqual({ ...confirmed.receipt, replayed: true });
    expect(service.detail(first.item.id).events).toHaveLength(3);
    expect(() => service.apply(first.item.id, { ...command, action: { type: 'complete' } })).toThrow(/operation ID/);
    expect(() => service.createDraft(project.id, { ...input, brief: { ...brief, goal: 'Different' } })).toThrow(/operation ID/);
  });
  it('rejects stale revisions, including stale dispatch previews, without partial events', () => {
    const path = file(), store = opened(path), { service, item } = setup(store), other = new WorkItems(opened(path));
    const confirmed = ready(service, item), preview = other.preview(item.id);
    const latest = act(service, confirmed, { type: 'saveProgress', progress: 'More context', nextAction: 'Read it' });
    const before = service.detail(item.id);
    expect(() => act(other, confirmed, { type: 'dispatch', previewHash: preview.hash })).toThrow(/another tab/);
    expect(() => act(other, latest, { type: 'dispatch', previewHash: preview.hash })).toThrow(/after preview/);
    expect(service.detail(item.id)).toEqual(before);
  });
  it('restores pending work after restart without replaying dispatch', () => {
    const path = file(), store = opened(path), { service, item } = setup(store), pending = send(service, ready(service, item));
    const history = service.detail(item.id).events;
    store.close(); stores.delete(store);
    const reopened = new WorkItems(opened(path));
    expect(reopened.get(item.id)).toEqual(pending); expect(reopened.detail(item.id).events).toEqual(history);
  });
  it('keeps new records independent of legacy tasks, checkpoints, summaries and handoffs', () => {
    const { store, project, service, item } = setup();
    const task = store.createTask(project.id, { title: 'Old task' });
    const snapshot = store.wrapUpProject(project.id, { revision: project.revision, status: 'Legacy checkpoint', blockers: '', nextAction: 'Legacy next step' });
    const devices = new DeviceStore(store);
    const profile = devices.addProfile({ url: 'https://work-items.example', publishableKey: 'public-test-key' }, randomUUID(), Buffer.from('opaque'));
    devices.setPolicy(profile.id, { projectId: project.id, enabled: true, memoryFields: ['status'] });
    const publications = devices.publications(profile.id), handoff = buildHandoff(snapshot, [task]);
    act(service, send(service, ready(service, item)), { type: 'saveProgress', progress: 'PRIVATE_WORK_ITEM', nextAction: 'PRIVATE_NEXT_ACTION' });
    devices.reconcilePublications(profile.id);
    expect(store.getProject(project.id)).toEqual(snapshot); expect(store.getTask(task.id)).toEqual(task);
    expect(devices.publications(profile.id)).toEqual(publications);
    const { exportedAt: _beforeTime, ...beforeState } = handoff.state;
    const { exportedAt: _afterTime, ...afterState } = buildHandoff(snapshot, [task]).state;
    expect(afterState).toEqual(beforeState);
    expect(JSON.stringify(publications)).not.toMatch(/PRIVATE_WORK_ITEM|Login validation/);
    const paused = store.updateProject(project.id, { revision: snapshot.revision, status: 'archived' });
    expect(service.list(paused.id)).toHaveLength(1);
  });
  it('keeps new ideas separate and cascades records only on explicit project removal', () => {
    const { store, project, service, item } = setup();
    const sent = send(service, ready(service, item));
    const idea = service.createDraft(project.id, { commandId: randomUUID(), brief: { ...brief, title: 'New idea' }, sourceWorkItemId: item.id }).item;
    expect(service.get(item.id)).toEqual(sent); expect(idea.phase).toBe('draft');
    const other = store.createProject({ path: '/other', name: 'Other' });
    expect(() => service.createDraft(other.id, { commandId: randomUUID(), brief, sourceWorkItemId: item.id })).toThrow(/same local project/);
    store.deleteProject(project.id, project.revision);
    expect(service.list()).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM work_item_events').get()!.n).toBe(0);
  });
  it('migrates v6 additively and rolls back a failed new migration', () => {
    const path = file(), store = opened(path), project = store.createProject({ path: '/legacy', name: 'Legacy' }), task = store.createTask(project.id, { title: 'Keep this' });
    store.db.exec('DROP TABLE work_item_events; DROP TABLE work_items; PRAGMA user_version=6;');
    store.close(); stores.delete(store);
    const migrated = opened(path);
    expect(migrated.getProject(project.id)).toEqual(project); expect(migrated.getTask(task.id)).toEqual(task);
    expect(migrated.db.prepare('PRAGMA user_version').get()!.user_version).toBe(7);
    migrated.db.exec('DROP TABLE work_item_events; DROP TABLE work_items; CREATE TABLE work_item_events(marker TEXT); PRAGMA user_version=6;');
    migrated.close(); stores.delete(migrated);
    expect(() => new Store(path)).toThrow();
    const db = new DatabaseSync(path);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(6);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='work_items'").get()).toBeUndefined();
    expect(db.prepare('SELECT title FROM tasks').get()!.title).toBe(task.title); db.close();
  });
});
