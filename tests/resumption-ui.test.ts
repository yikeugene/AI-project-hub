import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate, type Locale } from '../shared/i18n';
import { coreMessages } from '../shared/locales/core';
import { EMPTY_MEMORY, getStatusLabels, type Project, type Task } from '../shared/types';
import { ResumeCard } from '../src/components/ResumeCard';
import { formatDate } from '../src/hooks';
import { I18nProvider } from '../src/i18n';
import { resumptionMessages } from '../src/locales/resumption';
import { PersonalFocusPanel } from '../src/panels/PersonalFocusPanel';
import { QuickWrapUpPanel } from '../src/panels/QuickWrapUpPanel';

const project: Project = {
  id: 'project-a', name: 'User project 原文', path: 'C:\\work\\a', description: 'Recorded purpose 原文', category: '',
  status: 'active', priority: 'normal', stage: '', nextAction: 'My explicit next step 原文', revision: 3,
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-10-20T12:34:00Z',
  memory: { ...EMPTY_MEMORY, status: 'Current progress 原文', blockers: 'Recorded blocker 原文' }, memoryUpdatedAt: '2026-10-19T15:41:00Z', checkpointAt: null,
  git: null, gitError: null, lastCheckedAt: '2026-10-20T14:11:00Z',
};
const task: Task = { id: 'task-a', projectId: project.id, title: 'Task suggestion must not win', detail: '', status: 'doing', priority: 'high', revision: 1, createdAt: project.createdAt, updatedAt: project.updatedAt };
const render = (content: ReactNode, locale: Locale = 'en') => renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: content }));
const message = (key: keyof typeof resumptionMessages.en, locale: Locale = 'en', params?: Record<string, string | number>) => translate(resumptionMessages, locale, key, params);
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[character]!);
const buttonTag = (markup: string, label: string) => [...markup.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`aria-label="${escapeHtml(label)}"`));
const callbacks = { onOpen: () => {}, onWrapUp: () => {}, onRemove: () => {}, onMove: () => {}, onBrowse: () => {} };
const editorCallbacks = { onChange: async () => {}, onDirtyChange: () => {}, onBusyChange: () => {} };
afterEach(() => vi.restoreAllMocks());

describe('resumption catalog', () => {
  it('keeps both languages and their interpolation parameters in exact parity', () => {
    expect(Object.keys(resumptionMessages.en).sort()).toEqual(Object.keys(resumptionMessages['zh-TW']).sort());
    for (const key of Object.keys(resumptionMessages.en) as (keyof typeof resumptionMessages.en)[]) {
      const params = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
      expect(params(resumptionMessages.en[key]), key).toEqual(params(resumptionMessages['zh-TW'][key]));
    }
    for (const key of ['focusTitle', 'focusSubtitle', 'focusAdd', 'focusRemove', 'focusAddLabel', 'focusRemoveLabel', 'focusBusy', 'wrapUpTab', 'wrapUpAction', 'wrapUpSaved', 'discardWrapUp', 'resolveWrapUp'] as const) {
      expect(resumptionMessages.en[key]).toBeTruthy(); expect(resumptionMessages['zh-TW'][key]).toBeTruthy();
    }
    expect(resumptionMessages['zh-TW'].focusTitle).toContain('聚焦');
    expect(resumptionMessages['zh-TW'].wrapUpTab).toBe('快速收工');
    expect(resumptionMessages['zh-TW'].nextStep).toBe('下次第一步');
  });
});

describe('resume card', () => {
  it('prioritizes manual intent, shows sources and distinguishes memory-saved time in both languages', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(ResumeCard, { project, tasks: [task], onWrapUp: () => {}, onMemory: () => {} }), locale);
      for (const key of ['purpose', 'checkpoint', 'nextStep', 'nextRecorded', 'memorySource', 'blockers', 'facts', 'wrapUpAction', 'memoryAction'] as const) expect(markup).toContain(escapeHtml(message(key, locale)));
      for (const value of [project.description, project.memory.status, project.memory.blockers, project.nextAction]) expect(markup).toContain(value);
      expect(markup).not.toContain(task.title);
      expect(markup).toContain(message('memoryDate', locale, { date: formatDate(project.memoryUpdatedAt, true, locale) }));
      expect(markup).not.toContain(message('checkpointDate', locale, { date: formatDate(project.memoryUpdatedAt, true, locale) }));
      expect(markup).not.toContain(formatDate(project.updatedAt, true, locale));
      expect(markup).not.toContain(formatDate(project.lastCheckedAt, true, locale));
      expect(markup.indexOf('resume-blockers')).toBeLessThan(markup.indexOf('resume-facts'));
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('labels a task fallback as a suggestion and omits full facts in compact mode', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(ResumeCard, { project: { ...project, nextAction: '' }, tasks: [task], compact: true }), locale);
      expect(markup).toContain(task.title);
      expect(markup).toContain(escapeHtml(message('nextSuggested', locale)));
      expect(markup).toContain('resume-card-compact');
      expect(markup).not.toContain('resume-facts');
      expect(markup).not.toContain('resume-purpose');
      expect(markup).not.toContain('resume-actions');
      expect(markup).toContain(project.memory.blockers);
    }
  });
  it('does not present older notes as the progress of an explicit empty checkpoint', () => {
    const wrapped = { ...project, checkpointAt: '2026-10-20T16:00:00Z', memory: { ...project.memory, status: '  ', notes: 'Old notes must stay out' } };
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(ResumeCard, { project: wrapped, tasks: [] }), locale);
      expect(markup).toContain(coreMessages[locale]['resume.checkpointUnfilled']);
      expect(markup).toContain(message('checkpointDate', locale, { date: formatDate(wrapped.checkpointAt, true, locale) }));
      expect(markup).not.toContain(wrapped.memory.notes);
      expect(markup).not.toContain(message('memorySource', locale));
      expect(markup).not.toContain(message('memoryDate', locale, { date: formatDate(wrapped.memoryUpdatedAt, true, locale) }));
    }
  });
  it('uses honest empty states rather than claiming no past wrap-up or no real-world blockers', () => {
    const empty = { ...project, description: '', nextAction: '', checkpointAt: null, memoryUpdatedAt: null, memory: { ...EMPTY_MEMORY } };
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(ResumeCard, { project: empty, tasks: [] }), locale);
      for (const key of ['purposeEmpty', 'memorySource', 'nextEmpty', 'blockersEmpty'] as const) expect(markup).toContain(message(key, locale));
      expect(markup).toContain(coreMessages[locale]['resume.checkpoint']);
      expect(markup).not.toMatch(/never wrapped|never worked|從未收工/i);
    }
  });
  it('preserves and escapes long user-authored content in both languages', () => {
    const long = 'User <script>not executable</script> {date}\n' + '未換行'.repeat(900);
    const authored = { ...project, name: long, nextAction: long, memory: { ...project.memory, overview: long, status: long, blockers: long } };
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(ResumeCard, { project: authored, tasks: [] }), locale);
      expect(markup).not.toContain('<script>');
      expect(markup).toContain(escapeHtml(long));
      expect(markup.match(/class="preserve-lines"/g)?.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('personal focus panel', () => {
  it('starts empty with bilingual selection guidance and a browse action, not automatic recommendations', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(PersonalFocusPanel, { projects: [project], tasks: [task], focus: { projectIds: [], revision: 1 }, busy: false, ...callbacks }), locale);
      for (const key of ['focusTitle', 'focusSubtitle', 'focusEmptyTitle', 'focusEmptyDescription', 'focusBrowse'] as const) expect(markup).toContain(message(key, locale));
      expect(markup).not.toContain('personal-focus-row');
      expect(markup).not.toContain(task.title);
    }
  });
  it('keeps manual order and all selected projects, including paused and archived, with accessible controls', () => {
    const projects = Array.from({ length: 6 }, (_, index): Project => ({ ...project, id: `project-${index}`, name: `Project ${index}`, status: index === 0 ? 'paused' : index === 5 ? 'archived' : 'active' }));
    const order = [5, 0, 4, 1, 3, 2];
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(PersonalFocusPanel, { projects, tasks: [], focus: { projectIds: order.map(index => projects[index].id), revision: 2 }, busy: false, ...callbacks }), locale);
      expect(markup.match(/class="focus-item personal-focus-row"/g)).toHaveLength(6);
      expect(markup).toContain(getStatusLabels(locale).paused);
      expect(markup).toContain(getStatusLabels(locale).archived);
      const positions = order.map(index => markup.indexOf(`aria-label="${escapeHtml(message('focusOpenLabel', locale, { name: projects[index].name }))}"`));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(buttonTag(markup, message('focusMoveUp', locale, { name: projects[5].name }))).toContain('disabled=""');
      expect(buttonTag(markup, message('focusMoveDown', locale, { name: projects[2].name }))).toContain('disabled=""');
      expect(buttonTag(markup, message('focusMoveUp', locale, { name: projects[0].name }))).not.toContain('disabled');
      expect(buttonTag(markup, message('focusRemoveLabel', locale, { name: projects[0].name }))).toBeTruthy();
      expect(buttonTag(markup, message('focusWrapUpLabel', locale, { name: projects[0].name }))).toBeTruthy();
    }
  });
  it('locks focus controls during mutations and exposes errors without losing rows', () => {
    const markup = render(createElement(PersonalFocusPanel, { projects: [project], tasks: [], focus: { projectIds: [project.id], revision: 3 }, busy: true, error: 'Conflict detail 原文', ...callbacks }));
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(message('focusBusy'));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Conflict detail 原文');
    expect(markup).toContain('personal-focus-row');
    for (const match of markup.matchAll(/<button\b[^>]*>/g)) expect(match[0]).toContain('disabled=""');
  });
});

describe('quick wrap-up editor', () => {
  it('prefills exactly the three canonical fields and permits a clean checkpoint reconfirmation', () => {
    const authored = { ...project, memory: { ...project.memory, notes: 'Must not prefill notes', nextActions: 'Must not prefill memory nextActions' }, nextAction: '  User first step 原文  ' };
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(QuickWrapUpPanel, { project: authored, ...editorCallbacks }), locale);
      expect(markup.match(/<textarea\b/g)).toHaveLength(3);
      expect(markup.match(/maxLength="20000"/g)).toHaveLength(2);
      expect(markup.match(/maxLength="2000"/g)).toHaveLength(1);
      for (const key of ['wrapUpStatus', 'wrapUpBlockers', 'wrapUpNextAction'] as const) expect(markup).toContain(`aria-label="${escapeHtml(message(key, locale))}"`);
      for (const value of [authored.memory.status, authored.memory.blockers, authored.nextAction]) expect(markup).toContain(value);
      expect(markup).not.toContain(authored.memory.notes);
      expect(markup).not.toContain(authored.memory.nextActions);
      expect(markup.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled');
      expect(markup).toContain(escapeHtml(message('wrapUpReconfirm', locale)));
      expect(markup).toContain(escapeHtml(message('wrapUpSharing', locale)));
    }
  });
  it('requires a nonblank next step within the limit without requiring progress or blockers', () => {
    for (const [nextAction, valid] of [['   \n ', false], ['a'.repeat(2001), false], ['a'.repeat(2000), true], ['one step', true]] as const) {
      const markup = render(createElement(QuickWrapUpPanel, { project: { ...project, memory: { ...EMPTY_MEMORY }, nextAction }, ...editorCallbacks }));
      const saveTag = markup.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0];
      expect(saveTag).toBeTruthy();
      expect(saveTag!.includes('disabled=""')).toBe(!valid);
      expect(markup.match(/<textarea\b[^>]*required=""[^>]*>/g)).toHaveLength(1);
    }
  });
  it('disables editing and saving when another editor has a draft and explains how to resolve it', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(createElement(QuickWrapUpPanel, { project, blocked: true, ...editorCallbacks }), locale);
      expect(markup).toContain(escapeHtml(message('wrapUpBlocked', locale)));
      for (const match of markup.matchAll(/<textarea\b[^>]*>/g)) expect(match[0]).toContain('disabled=""');
      expect(markup.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
    }
  });
});
