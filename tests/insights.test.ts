import { describe, expect, it } from 'vitest';
import { Store } from '../server/db.js';
import { activityAt, getFocusItems, getResumeSummary, isStale } from '../shared/insights.js';
import { EMPTY_MEMORY, MEMORY_FIELDS, MEMORY_LABELS, STATUS_LABELS, PRIORITY_LABELS, TASK_LABELS, getMemoryLabels, getStatusLabels, getPriorityLabels, getTaskLabels } from '../shared/types.js';
import { coreMessages } from '../shared/locales/core.js';
import { errorMessages, translateError } from '../shared/messages.js';

describe('transparent focus suggestions', () => {
  it('changes generated text, never scores, enums or user-authored checkpoints and actions', () => {
    const s = new Store(':memory:');
    try {
      const created = s.createProject({ path: '/locale', name: '項目', nextAction: 'User next {score}' });
      const p = s.saveMemory(created.id, created.revision, { ...EMPTY_MEMORY, status: 'User checkpoint 原樣', blockers: 'Existing blocker' });
      const english = getFocusItems([p], [], 14, 0);
      const chinese = getFocusItems([p], [], 14, 0, 'zh-TW');
      expect(english[0].score).toBe(chinese[0].score);
      expect(english[0].action).toBe('User next {score}'); expect(chinese[0].action).toBe(english[0].action);
      expect(english[0].reasons).toContain('Project priority +20'); expect(chinese[0].reasons).toContain('項目優先級 +20');
      expect(getResumeSummary(p, []).checkpoint).toBe(p.memory.status);
      expect(getResumeSummary(p, [], 'zh-TW').checkpoint).toBe(p.memory.status);
      expect(getResumeSummary(p, [], 'zh-TW').facts).toContain('尚未取得 Git 觀測。');
      expect(getFocusItems([p], [], 14, 0)[0].reasons).toEqual(english[0].reasons);
    } finally { s.close(); }
  });
  it('keeps compatibility maps English and both catalogs complete with matching parameters', () => {
    expect(MEMORY_LABELS).toEqual(getMemoryLabels('en')); expect(STATUS_LABELS).toEqual(getStatusLabels('en'));
    expect(PRIORITY_LABELS).toEqual(getPriorityLabels('en')); expect(TASK_LABELS).toEqual(getTaskLabels('en'));
    expect(Object.keys(getMemoryLabels('zh-TW'))).toEqual([...MEMORY_FIELDS]);
    expect(getMemoryLabels('zh-TW').status).toBe('目前開發狀態'); expect(getStatusLabels('zh-TW').active).toBe('進行中');
    expect(getTaskLabels('zh-TW').todo).toBe('待處理'); expect(getPriorityLabels('zh-TW').high).toBe('高優先');
    for (const catalog of [coreMessages, errorMessages]) {
      expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog['zh-TW']).sort());
      for (const key of Object.keys(catalog.en)) {
        const en = (catalog.en as Record<string, string>)[key], zh = (catalog['zh-TW'] as Record<string, string>)[key];
        expect([...en.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort()).toEqual([...zh.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort());
      }
    }
    expect(translateError('path.missing', 'zh-TW', { path: '/user/{detail}/原樣' })).toBe('資料夾不存在：/user/{detail}/原樣');
  });
  it('excludes paused, completed, archived, blocked and backlog-only work', () => {
    const s = new Store(':memory:');
    try {
      for (const status of ['paused', 'completed', 'archived', 'active'] as const) {
        const p = s.createProject({ path: '/' + status, name: status, status });
        s.createTask(p.id, { title: status, status: status === 'active' ? 'blocked' : 'todo' });
      }
      const backlog = s.createProject({ path: '/backlog', name: 'backlog' }); s.createTask(backlog.id, { title: 'later', priority: 'backlog' });
      expect(getFocusItems(s.listProjects(), s.listTasks())).toEqual([]);
    } finally { s.close(); }
  });
  it('ranks by explicit priorities and exposes every scoring component', () => {
    const s = new Store(':memory:');
    try {
      const a = s.createProject({ path: '/a', name: 'A', priority: 'high' });
      const b = s.createProject({ path: '/b', name: 'B', priority: 'normal' });
      s.createTask(a.id, { title: 'continue', priority: 'high', status: 'doing' }); s.createTask(b.id, { title: 'other' });
      const focus = getFocusItems(s.listProjects(), s.listTasks());
      expect(focus[0].project.id).toBe(a.id); expect(focus[0].score).toBe(95); expect(focus[0].reasons).toContain('Task already in progress +5');
      expect(getResumeSummary(a, s.listTasks()).nextAction).toBe('continue');
    } finally { s.close(); }
  });
  it('never invents activity or progress from Hub edits', () => {
    const s = new Store(':memory:');
    try {
      const p = s.createProject({ path: '/a', name: 'A' });
      expect(activityAt(p)).toBeNull(); expect(isStale(p, 14)).toBe(false);
      expect(getResumeSummary(p, []).facts).toContain('No Git observation yet.');
      expect(getFocusItems([p], [])).toHaveLength(0);
    } finally { s.close(); }
  });
});
