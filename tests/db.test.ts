import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { EMPTY_MEMORY } from '../shared/types.js';
import type { GitSnapshot } from '../shared/types.js';

const stores: Store[] = [], dirs: string[] = [];
const memoryStore = () => { const store = new Store(':memory:'); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('SQLite persistence and edit protection', () => {
  it('defaults fresh settings to English, independent of the host locale', () => {
    const store = memoryStore();
    expect(store.getSettings()).toEqual({ scanRoots: [], staleDays: 14, refreshSeconds: 60, locale: 'en' });
  });
  it.each([undefined, null, '', 'zh-CN', 'EN', 42, {}, ['zh-TW']])('normalizes a legacy or invalid saved locale (%j) without losing settings', locale => {
    const store = memoryStore();
    const saved = { scanRoots: ['/legacy'], staleDays: 28, refreshSeconds: 300, locale };
    const json = JSON.stringify(saved);
    store.db.prepare('INSERT INTO settings(id,value) VALUES(1,?)').run(json);
    expect(store.getSettings()).toEqual({ ...saved, locale: 'en' });
    expect(store.db.prepare('SELECT value FROM settings WHERE id=1').get()!.value).toBe(json);
    expect(store.updateSettings({ locale: 'zh-TW' })).toEqual({ ...saved, locale: 'zh-TW' });
    expect(store.updateSettings({ staleDays: 21 })).toEqual({ ...saved, staleDays: 21, locale: 'zh-TW' });
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(7);
  });
  it('persists projects, tasks, memory and settings across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-db-')); dirs.push(dir);
    const file = join(dir, 'hub.sqlite');
    let store = new Store(file);
    const p = store.createProject({ path: '/sample', name: '研究工具' });
    const t = store.createTask(p.id, { title: '補上測試', priority: 'high' });
    store.saveMemory(p.id, p.revision, { ...EMPTY_MEMORY, status: '資料層完成', decisions: '保持本機儲存' });
    store.updateSettings({ staleDays: 21, refreshSeconds: 120, scanRoots: ['/sample'] });
    store.updateSettings({ locale: 'zh-TW' }); store.close();
    store = new Store(file); stores.push(store);
    expect(store.getProject(p.id).memory.status).toBe('資料層完成');
    expect(store.getTask(t.id).priority).toBe('high');
    expect(store.getSettings()).toEqual({ scanRoots: ['/sample'], staleDays: 21, refreshSeconds: 120, locale: 'zh-TW' });
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(7);
  });
  it('rejects stale project, memory, task, and removal revisions', () => {
    const s = memoryStore(), p = s.createProject({ path: '/x', name: 'x' });
    s.updateProject(p.id, { revision: p.revision, name: 'renamed' });
    expect(() => s.saveMemory(p.id, p.revision, EMPTY_MEMORY)).toThrow(/another tab/);
    expect(() => s.deleteProject(p.id, p.revision)).toThrow(/another tab/);
    const t = s.createTask(p.id, { title: 'task' }); s.updateTask(t.id, { revision: 1, status: 'done' });
    expect(() => s.updateTask(t.id, { revision: 1, status: 'todo' })).toThrow(/another tab/);
    expect(() => s.deleteTask(t.id, 1)).toThrow(/another tab/);
  });
  it('keeps user state and previous successful observations on Git failure', () => {
    const s = memoryStore(), p = s.createProject({ path: '/x', name: 'x', status: 'paused' });
    const git: GitSnapshot = { isRepo: true, branch: 'main', head: 'abc', branches: ['main'], commits: [], changes: [], changedCount: 0, untrackedCount: 0, stagedCount: 0, conflictCount: 0, lastCommitAt: '2025-01-01T00:00:00Z', observedAt: new Date().toISOString() };
    s.saveObservation(p.id, git, null); s.saveObservation(p.id, null, 'offline');
    const after = s.getProject(p.id);
    expect(after.git).toEqual(git); expect(after.gitError).toBe('offline'); expect(after.status).toBe('paused');
    expect(after.updatedAt).toBe(p.updatedAt); expect(after.revision).toBe(p.revision);
  });
  it('deduplicates canonical paths and cascades only Hub task records', () => {
    const s = memoryStore(), p = s.createProject({ path: '/x', name: 'x' });
    s.createTask(p.id, { title: 'test' }); expect(() => s.createProject({ path: '/x', name: 'duplicate' })).toThrow(/already in Hub/);
    s.deleteProject(p.id, 1); expect(s.listTasks()).toEqual([]); expect(s.listProjects()).toEqual([]);
  });
});
