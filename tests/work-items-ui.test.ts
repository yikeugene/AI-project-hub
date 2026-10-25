import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate, type Locale } from '../shared/i18n';
import { EMPTY_MEMORY, type Project } from '../shared/types';
import { activeWorkHold, canCompleteWork, emptyWorkBrief, isWorkBriefReady, type WorkCheck, type WorkItem } from '../shared/work-items';
import { WorkBriefFields, WorkBriefView, WorkCheckView, WorkItemEditor } from '../src/components/WorkItemEditor';
import { RemoveProjectDialog } from '../src/components/ProjectForm';
import { Sidebar, navigation } from '../src/components/Sidebar';
import { WorkItemsList } from '../src/panels/WorkItemsPanel';
import { copyText } from '../src/hooks';
import { I18nProvider } from '../src/i18n';
import { workItemMessages } from '../src/locales/work-items';
import { canAdoptWorkPoll, currentWorkCheck, groupWorkItems, hasFailedWorkCheck, validWorkDraft, workBucket, workNextAction } from '../src/work-items';

const now = Date.parse('2026-10-25T10:00:00Z');
const project: Project = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Local project 原文', path: 'C:\\work\\local', description: '', category: '',
  status: 'active', priority: 'normal', stage: '', nextAction: 'Project memory must stay separate', revision: 1,
  createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z', memory: { ...EMPTY_MEMORY },
  memoryUpdatedAt: null, checkpointAt: null, git: null, gitError: null, lastCheckedAt: null,
};
const item: WorkItem = {
  id: '22222222-2222-4222-8222-222222222222', projectId: project.id, revision: 4, version: 2, phase: 'ready',
  brief: { title: 'Ship one small fix 原文', goal: 'Goal <script>literal</script>', nonGoals: 'No new UI', acceptanceCriteria: ['Run the focused test', 'Check narrow screen'], firstCheck: 'Open the failing scenario 原文' },
  progress: 'Saved progress 原文', nextAction: 'Try the return path 原文', hold: null, currentSubmissionId: '33333333-3333-4333-8333-333333333333',
  checks: { self: null, partner: null }, sourceWorkItemId: null, createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z',
};
const check = (role: WorkCheck['role'], outcome: WorkCheck['outcome'] = 'pass'): WorkCheck => ({ role, outcome, note: `${role} actual check 原文`, source: role === 'self' ? 'self' : 'call', version: item.version, submissionId: item.currentSubmissionId!, recordedAt: item.updatedAt, recordedBy: 'local-user' });
const render = (element: ReactNode, locale: Locale = 'en') => renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: element }));
const text = (key: keyof typeof workItemMessages.en, locale: Locale = 'en') => translate(workItemMessages, locale, key);
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[character]!);
const button = (html: string, label: string) => [...html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/g)].find(match => match[2].replace(/<[^>]*>/g, '') === escape(label))?.[1];
const editor = (value: WorkItem, locale: Locale = 'en') => render(createElement(WorkItemEditor, { projects: [project], item: value, onClose: () => {}, onSaved: async () => {} }), locale);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('work-item labels and scope presentation (SSR only)', () => {
  it('keeps bilingual keys and interpolation parameters aligned', () => {
    expect(Object.keys(workItemMessages.en).sort()).toEqual(Object.keys(workItemMessages['zh-TW']).sort());
    const params = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
    for (const key of Object.keys(workItemMessages.en) as (keyof typeof workItemMessages.en)[]) {
      expect(workItemMessages['zh-TW'][key]).toBeTruthy();
      expect(params(workItemMessages.en[key]), key).toEqual(params(workItemMessages['zh-TW'][key]));
    }
  });

  it.each(['en', 'zh-TW'] as const)('shows the original goal and first check as escaped text in %s', locale => {
    const html = render(createElement(WorkBriefView, { brief: item.brief }), locale);
    for (const key of ['goal', 'firstCheck', 'acceptance', 'nonGoals'] as const) expect(html).toContain(text(key, locale));
    for (const value of [item.brief.goal, item.brief.firstCheck, item.brief.nonGoals, ...item.brief.acceptanceCriteria]) expect(html).toContain(escape(value));
    expect(html).not.toContain('<script>'); expect(html).not.toContain('dangerouslySetInnerHTML');
    expect(html).not.toContain('<textarea');
  });

  it('starts with a title or goal and leaves scope expansion optional until confirmation', () => {
    expect(validWorkDraft(emptyWorkBrief())).toBe(false);
    expect(validWorkDraft({ ...emptyWorkBrief(), goal: 'One sentence is enough' })).toBe(true);
    expect(isWorkBriefReady({ ...emptyWorkBrief(), goal: 'One sentence is enough' })).toBe(false);
    expect(validWorkDraft({ ...item.brief, acceptanceCriteria: Array(11).fill('check') })).toBe(false);
    expect(validWorkDraft({ ...item.brief, acceptanceCriteria: ['a'.repeat(501)] })).toBe(false);
    const html = render(createElement(WorkBriefFields, { brief: emptyWorkBrief(), onChange: () => {} }));
    expect(html).toContain('maxLength="160"'); expect(html).toContain('maxLength="5010"');
    expect(html.indexOf(text('firstCheck'))).toBeLessThan(html.indexOf('<details'));
    expect(html).not.toContain('required=""');
  });

  it.each(['en', 'zh-TW'] as const)('offers manual execution without pretending to dispatch AI in %s', locale => {
    const fetch = vi.spyOn(globalThis, 'fetch'); const html = editor(item, locale);
    expect(button(html, text('preview', locale))).not.toContain('disabled');
    expect(button(html, text('manualReview', locale))).not.toContain('disabled');
    expect(button(html, text('dispatch', locale))).toBeUndefined(); // Requires an actual server preview first.
    expect(html).toContain(item.brief.firstCheck); expect(html).toContain(item.progress); expect(html).toContain(item.nextAction);
    expect(html).not.toContain(project.nextAction); expect(html).not.toContain('OAuth'); expect(fetch).not.toHaveBeenCalled();
  });

  it('only offers return checking after dispatch, not another direct handoff', () => {
    const html = editor({ ...item, phase: 'awaiting_return' });
    expect(button(html, text('startReview'))).not.toContain('disabled');
    expect(button(html, text('preview'))).toBeUndefined(); expect(button(html, text('dispatch'))).toBeUndefined();
    expect(html).toContain(text('rework'));
  });

  it.each(['en', 'zh-TW'] as const)('labels partner reporting honestly and exposes completed checks in %s', locale => {
    const checked = { ...item, checks: { self: check('self'), partner: check('partner') } };
    const html = render(createElement(WorkCheckView, { item: checked, role: 'partner' }), locale);
    expect(html).toContain(escape(text('partnerProxy', locale))); expect(html).toContain(text('source_call', locale));
    expect(html).toContain('partner actual check 原文'); expect(html).toContain(text('pass', locale));
  });

  it('requires both current passes and a deliberate completion action', () => {
    const review: WorkItem = { ...item, phase: 'review', checks: { self: check('self'), partner: check('partner') } };
    expect(button(editor(review), text('complete'))).not.toContain('disabled');
    for (const invalid of [
      { ...review, checks: { self: null, partner: check('partner') } },
      { ...review, checks: { self: check('self'), partner: { ...check('partner'), version: 1 } } },
      { ...review, checks: { self: check('self'), partner: { ...check('partner'), submissionId: 'old' } } },
      { ...review, hold: { kind: 'waiting' as const, reason: 'Wait for device', resumeAction: 'Ask owner', until: null } },
    ]) {
      expect(canCompleteWork(invalid, now)).toBe(false);
      expect(button(editor(invalid), text('complete'))).toContain('disabled');
    }
  });

  it('never offers a way to overwrite a failed check with a pass', () => {
    const failed: WorkItem = { ...item, phase: 'review', checks: { self: check('self', 'fail'), partner: null } };
    const html = editor(failed);
    expect(hasFailedWorkCheck(failed)).toBe(true); expect(html).toContain(text('failureHint'));
    expect(button(html, text('complete'))).toContain('disabled');
    expect(button(html, `${text('partner')}: ${text('recordCheck')}`)).toContain('disabled');
    expect(button(html, `${text('self')}: ${text('recordCheck')}`)).toBeUndefined();
    expect(button(html, text('rework'))).not.toContain('disabled');
  });

  it.each(['en', 'zh-TW'] as const)('keeps every old sidebar entry and warns about cascading work-item deletion in %s', locale => {
    const html = render(createElement(Sidebar, { view: 'dashboard', onNavigate: () => {}, projectCount: 1, taskCount: 2, devices: null, onDevice: () => {} }), locale);
    expect(html).toContain(text('primaryNav', locale)); expect(html).toContain(text('secondaryNav', locale));
    expect(html.match(/class="nav-item /g)).toHaveLength(navigation.length);
    const deletion = render(createElement(RemoveProjectDialog, { project, onClose: () => {}, onRemoved: async () => {} }), locale);
    expect(deletion).toContain(escape(text('removeWarning', locale)));
  });
});

describe('work list grouping and revision guards', () => {
  it('keeps held and completed outcomes, with paused/archived parents still visible', () => {
    const archived = { ...project, id: 'archived-parent', name: 'Archived project', status: 'archived' as const };
    const paused = { ...project, status: 'paused' as const };
    const values: WorkItem[] = [
      { ...item, id: 'draft', phase: 'draft' },
      { ...item, id: 'return', projectId: archived.id, phase: 'awaiting_return' },
      { ...item, id: 'held', hold: { kind: 'paused', reason: 'Travel', resumeAction: 'Open test', until: null } },
      { ...item, id: 'done', projectId: archived.id, phase: 'done' },
    ];
    const grouped = groupWorkItems(values, '', [project.id], now);
    expect(Object.values(grouped).flat()).toHaveLength(4);
    expect(grouped.returning[0].id).toBe('return'); expect(grouped.held[0].id).toBe('held'); expect(grouped.completed[0].id).toBe('done');
    const html = render(createElement(WorkItemsList, { items: values, projects: [paused, archived], onOpen: () => {}, now }));
    expect(html.match(/class="work-item-row"/g)).toHaveLength(4);
    expect(html).toContain('Archived project'); expect(html).toContain('status-paused'); expect(html).toContain('status-archived');
    expect(html).toContain(item.brief.firstCheck); expect(html).toContain(item.nextAction);
    expect(Object.values(groupWorkItems(values, archived.id, [], now)).flat().map(value => value.id).sort()).toEqual(['done', 'return']);
  });

  it('moves an expired deferral back into its original phase bucket without modifying data', () => {
    const deferred: WorkItem = { ...item, phase: 'awaiting_return', hold: { kind: 'deferred', reason: 'Later', resumeAction: 'Read result', until: new Date(now + 1000).toISOString() } };
    const before = structuredClone(deferred);
    expect(workBucket(deferred, now)).toBe('held'); expect(workNextAction(deferred, 'en', now)).toBe('Read result');
    expect(workBucket(deferred, now + 1001)).toBe('returning'); expect(activeWorkHold(deferred, now + 1001)).toBeNull();
    expect(deferred).toEqual(before);
  });

  it('puts failed review rounds in actionable work, not completed or forgotten reviews', () => {
    const failed: WorkItem = { ...item, phase: 'review', checks: { self: check('self', 'fail'), partner: check('partner') } };
    expect(workBucket(failed, now)).toBe('actionable'); expect(workNextAction(failed, 'en', now)).toBe(text('next_rework'));
    expect(currentWorkCheck({ ...failed, version: 3 }, 'self')).toBeNull();
  });

  it('does not adopt polling snapshots while guarded and rejects old or different identities', () => {
    const latest = { ...item, revision: 9, brief: { ...item.brief, goal: 'Remote update' } };
    expect(canAdoptWorkPoll(item, latest, true)).toBe(false);
    expect(canAdoptWorkPoll(item, latest, false)).toBe(true);
    expect(canAdoptWorkPoll(latest, item, false)).toBe(false);
    expect(canAdoptWorkPoll(item, { ...latest, id: 'different-item' }, false)).toBe(false);
    expect(item.revision).toBe(4); expect(item.brief.goal).toBe('Goal <script>literal</script>');
  });

  it('copies exact preview text through the native bridge without mutating a phase', async () => {
    const writeClipboard = vi.fn(async () => {}); const fetch = vi.spyOn(globalThis, 'fetch');
    vi.stubGlobal('window', { hubDesktop: { writeClipboard } });
    const text = '# Task 原文\r\n  Exact whitespace  \n'; const before = structuredClone(item);
    await copyText(text);
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(text); expect(fetch).not.toHaveBeenCalled(); expect(item).toEqual(before);
  });
});
