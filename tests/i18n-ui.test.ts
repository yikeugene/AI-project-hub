import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_LOCALE, LocalizedError, normalizeLocale, translate, type Locale, type MessageCatalog } from '../shared/i18n';
import { EMPTY_MEMORY, getMemoryLabels, getPriorityLabels, getStatusLabels, getTaskLabels, type Project } from '../shared/types';
import App from '../src/App';
import { ApiError, errorMessage } from '../src/api';
import { ChangePreview } from '../src/components/ChangePreview';
import { ProjectForm } from '../src/components/ProjectForm';
import { ProjectTable } from '../src/components/ProjectTable';
import { Field, Loading, PriorityBadge, StatusBadge, TaskBadge } from '../src/components/ui';
import { formatDate, relativeDate } from '../src/hooks';
import { I18nProvider } from '../src/i18n';
import { shellCatalog, type ShellMessage } from '../src/locales/shell';

const catalogModules = import.meta.glob(['../src/locales/*.ts', '../shared/locales/*.ts', '../shared/messages.ts'], { eager: true });
const render = (content: ReactNode, locale?: Locale) => renderToStaticMarkup(locale ? createElement(I18nProvider, { initialLocale: locale, children: content }) : content);
const project: Project = {
  id: '33333333-3333-4333-8333-333333333333', name: '保留 User project', path: 'C:\\工作\\unchanged-repo', description: 'User prose 原文', category: '',
  status: 'active', priority: 'normal', stage: 'User stage', nextAction: 'User next action 原文', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', revision: 1,
  memory: { ...EMPTY_MEMORY }, memoryUpdatedAt: null, git: null, gitError: null, lastCheckedAt: null,
};
afterEach(() => vi.unstubAllGlobals());

describe('bilingual UI catalogs', () => {
  it('defaults to English and normalizes unsupported settings without guessing a browser language', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    for (const value of [undefined, null, '', 'en-US', 'zh', 'zh-CN', 'zh-Hant', 'fr', {}, 1]) expect(normalizeLocale(value)).toBe('en');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('zh-TW')).toBe('zh-TW');
  });
  it('keeps every UI/shared catalog key and interpolation parameter in parity', () => {
    let catalogCount = 0;
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
    for (const [file, module] of Object.entries(catalogModules)) {
      for (const [name, value] of Object.entries(module as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || !('en' in value) || !('zh-TW' in value)) continue;
        const catalog = value as MessageCatalog;
        catalogCount++;
        expect(Object.keys(catalog['zh-TW']).sort(), `${file}:${name} keys`).toEqual(Object.keys(catalog.en).sort());
        for (const key of Object.keys(catalog.en)) {
          expect(typeof catalog.en[key], `${file}:${key} English`).toBe('string');
          expect(typeof catalog['zh-TW'][key], `${file}:${key} Chinese`).toBe('string');
          expect(placeholders(catalog['zh-TW'][key]), `${file}:${key} parameters`).toEqual(placeholders(catalog.en[key]));
        }
      }
    }
    expect(catalogCount).toBeGreaterThanOrEqual(3);
    expect(catalogModules['../src/locales/shell.ts']).toBeDefined();
  });
  it('interpolates values literally and falls back to the English message for an incomplete runtime catalog', () => {
    const catalog: MessageCatalog<'message'> = { en: { message: 'Keep {value}; {missing}' }, 'zh-TW': { message: '保留 {value}；{missing}' } };
    const value = '$& <script>not markup</script> {next}';
    expect(translate(catalog, 'zh-TW', 'message', { value })).toBe(`保留 ${value}；{missing}`);
    const incomplete = { en: { message: 'English fallback {value}' }, 'zh-TW': {} } as MessageCatalog<'message'>;
    expect(translate(incomplete, 'zh-TW', 'message', { value: 7 })).toBe('English fallback 7');
  });
  it('retranslates stored errors and notification descriptors without changing their identity or parameters', () => {
    const error = new LocalizedError(shellCatalog, 'composer.invalidMessage');
    const english = errorMessage(error);
    expect(english).toBe('Enter a message between 1 and 10,000 characters.');
    expect(errorMessage(error, 'zh-TW')).toBe('請輸入 1 至 10,000 字的訊息。');
    expect(errorMessage(error, 'en')).toBe(english);
    expect(error.message).toBe(english);
    const notification: ShellMessage = { key: 'app.refreshed', params: { count: 2 } };
    expect(translate(shellCatalog, 'en', notification.key, notification.params)).toContain('2');
    expect(translate(shellCatalog, 'zh-TW', notification.key, notification.params)).toBe('已重新讀取 2 個專案。');
    expect(notification).toEqual({ key: 'app.refreshed', params: { count: 2 } });
    const apiError = new ApiError('English request fallback', 503, 'client.request', { status: 503 });
    expect(errorMessage(apiError, 'en')).toContain('Request failed (503)');
    expect(errorMessage(apiError, 'zh-TW')).toContain('請求失敗（503）');
    expect(errorMessage(new Error('External diagnostics 保留原文'), 'en')).toBe('External diagnostics 保留原文');
  });
});

describe('English default and Traditional Chinese rendering', () => {
  it('renders the shell and accessible pressed language controls in both languages before loading', () => {
    const english = render(createElement(App));
    expect(english).toContain('<h1>Development workspace</h1>');
    expect(english).toContain('aria-label="Interface language"');
    expect(english).toMatch(/lang="en" aria-pressed="true" disabled=""/);
    expect(english).toMatch(/lang="zh-TW" aria-pressed="false" disabled=""/);
    expect(english).toContain('Skip to main content');
    const chinese = render(createElement(App), 'zh-TW');
    expect(chinese).toContain('<h1>開發工作台</h1>');
    expect(chinese).toContain('aria-label="介面語言"');
    expect(chinese).toMatch(/lang="en" aria-pressed="false" disabled=""/);
    expect(chinese).toMatch(/lang="zh-TW" aria-pressed="true" disabled=""/);
    expect(chinese).toContain('跳至主要內容');
  });
  it('localizes badges, defaults, accessibility labels, and diff chrome, never diff values', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      expect(render(createElement(StatusBadge, { status: 'active' }), locale)).toContain(getStatusLabels(locale).active);
      expect(render(createElement(PriorityBadge, { priority: 'normal' }), locale)).toContain(getPriorityLabels(locale).normal);
      expect(render(createElement(TaskBadge, { status: 'doing' }), locale)).toContain(getTaskLabels(locale).doing);
      expect(render(createElement(Loading), locale)).toContain(translate(shellCatalog, locale, 'common.loading'));
      expect(render(createElement(Field, { label: 'User label', required: true, children: createElement('input') }), locale)).toContain(`aria-label="${translate(shellCatalog, locale, 'common.required')}"`);
      const diff = render(createElement(ChangePreview, { changes: [{ key: 'status', label: getMemoryLabels(locale).status, before: 'User <before> 原文', after: '' }] }), locale);
      expect(diff).toContain('User &lt;before&gt; 原文');
      expect(diff).toContain(translate(shellCatalog, locale, 'diff.changed'));
      expect(diff).toContain(translate(shellCatalog, locale, 'common.blank'));
    }
  });
  it('localizes form labels but preserves names, paths, categories, and enum values', () => {
    vi.stubGlobal('window', {});
    const content = createElement(ProjectForm, { project, categories: ['User category 原文'], onClose: () => {}, onSaved: async () => {} });
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(content, locale);
      expect(markup).toContain(translate(shellCatalog, locale, 'detail.edit'));
      expect(markup).toContain(translate(shellCatalog, locale, 'form.name'));
      expect(markup).toContain(project.name);
      expect(markup).toContain(project.path);
      expect(markup).toContain(project.nextAction);
      expect(markup).toContain('User category 原文');
      expect(markup).toContain('value="active" selected=""');
      expect(markup).toContain('value="normal" selected=""');
    }
  });
  it('keeps uncategorized, all, and user-named translated categories distinct and uses semantic missing commit state', () => {
    const projects = ['', 'Uncategorized', '未分類', 'all'].map((category, index) => ({ ...project, id: `${project.id}-${index}`, category }));
    const content = createElement(ProjectTable, { projects, tasks: [], staleDays: 14, onOpen: () => {}, onAdd: () => {}, onScan: () => {} });
    for (const locale of ['en', 'zh-TW'] as const) {
      const markup = render(content, locale);
      const categories = markup.match(/class="category-tabs"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
      expect(categories.match(/<button\b/g)).toHaveLength(5);
      expect(categories).toContain('Uncategorized');
      expect(categories).toContain('未分類');
      expect(categories).toContain('>all<span>1</span>');
      expect(markup).toContain(translate(shellCatalog, locale, 'table.noCommit'));
      expect(markup).toContain(project.name);
      expect(markup).toContain(project.path);
      expect(markup).toContain(project.nextAction);
    }
  });
  it('formats missing and invalid dates in the requested language without changing inputs', () => {
    expect(formatDate(null)).toBe('No record yet');
    expect(formatDate(null, true, 'zh-TW')).toBe('尚無紀錄');
    expect(formatDate('invalid', false, 'en')).toBe('Unknown date');
    expect(formatDate('invalid', false, 'zh-TW')).toBe('日期未知');
    expect(relativeDate(null)).toBe('No activity yet');
    expect(relativeDate(null, 'zh-TW')).toBe('尚無活動');
    expect(relativeDate(new Date().toISOString(), 'en')).toBe('today');
    expect(relativeDate(new Date().toISOString(), 'zh-TW')).toBe('今天');
  });
});
