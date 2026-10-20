import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate, type Locale } from '../shared/i18n';
import { MAX_MARKDOWN_BYTES, type MarkdownImportPreview } from '../shared/markdown-import';
import { getMemoryLabels } from '../shared/types';
import { errorMessage } from '../src/api';
import { MarkdownImportDialog, MarkdownImportPreviewView } from '../src/components/MarkdownImportDialog';
import { MarkdownPromptDialog } from '../src/components/MarkdownPromptDialog';
import { I18nProvider } from '../src/i18n';
import { markdownImportMessages } from '../src/locales/markdown-import';
import { createMarkdownInputGuard, markdownTextBytes, readMarkdownFile } from '../src/markdown-ui';

const projectId = '33333333-3333-4333-8333-333333333333';
const ownerId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const preview: MarkdownImportPreview = {
  projectId, projectName: 'Local <project> 本機', revision: 7,
  source: { projectId, projectName: 'Document <project> 文件', revision: 4, version: 2, profileId: groupId, groupLabel: 'Group <source>', ownerDeviceId: ownerId, ownerName: 'Owner <source>' },
  hash: 'a'.repeat(64), digest: 'b'.repeat(64), sourceRevisionDiffers: true, canApply: true,
  changes: [
    { key: 'nextAction', label: 'Server label', before: 'Original <next> 原文', after: 'Updated <next> 原文' },
    { key: 'status', label: 'Server label', before: 'Old status', after: '<script>alert(1)</script>\n<img src=x onerror=alert(1)>' },
  ],
  skipped: [{ field: 'notes', reason: 'blank' }, { field: 'architecture', reason: 'missing' }],
  sharing: [{ profileId: groupId, label: 'User <group>', fields: ['status', 'nextAction'], paused: true }],
};
const render = (content: ReactNode, locale: Locale = 'en') => renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: content }));
const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('local-only Markdown import presentation', () => {
  it.each(['en', 'zh-TW'] as const)('renders a fixed local target, unverified source, skips and exact escaped differences in %s', locale => {
    const markup = render(createElement(MarkdownImportPreviewView, { preview }), locale);
    for (const key of ['target', 'source', 'sourceHint', 'skippedHint', 'blank', 'missing', 'sharingHint', 'sharingPaused', 'before', 'after', 'unchanged'] as const) {
      expect(markup).toContain(translate(markdownImportMessages, locale, key));
    }
    expect(markup).toContain(translate(markdownImportMessages, locale, 'revisionWarning', { source: 4, local: 7 }));
    expect(markup).toContain(translate(markdownImportMessages, locale, 'changes', { count: 2 }));
    for (const id of [projectId, ownerId, groupId]) expect(markup).toContain(id);
    expect(markup).toContain('Local &lt;project&gt; 本機');
    expect(markup).toContain('Document &lt;project&gt; 文件');
    expect(markup).toContain('Original &lt;next&gt; 原文');
    expect(markup).toContain('Updated &lt;next&gt; 原文');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toMatch(/<script|<img|<input|<select|<textarea/);
    expect(markup).toContain(getMemoryLabels(locale).status);
    expect(markup).not.toContain('Server label');
    expect(markup.match(/class="diff-columns"/g)).toHaveLength(2);
    expect(markup).not.toContain(preview.hash);
    expect(markup).not.toContain(preview.digest);
  });
  it.each(['en', 'zh-TW'] as const)('makes no-op previews explicit and renders no save or diff controls in %s', locale => {
    const markup = render(createElement(MarkdownImportPreviewView, { preview: { ...preview, sourceRevisionDiffers: false, canApply: false, changes: [], sharing: [] } }), locale);
    expect(markup).toContain('class="markdown-import-noop" role="status"');
    expect(markup).toContain(translate(markdownImportMessages, locale, 'noChanges'));
    expect(markup).toContain(translate(markdownImportMessages, locale, 'sharingNone'));
    expect(markup).not.toContain('diff-columns');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain(translate(markdownImportMessages, locale, 'revisionWarning', { source: 4, local: 7 }));
  });
  it.each(['en', 'zh-TW'] as const)('offers a bounded standard file input and paste field without any project picker in %s', locale => {
    const markup = render(createElement(MarkdownImportDialog, { onClose: () => {}, onImported: async () => {}, onDirtyChange: () => {}, onBusyChange: () => {} }), locale);
    for (const key of ['description', 'formatHint', 'fileHint', 'text', 'preview'] as const) expect(markup).toContain(translate(markdownImportMessages, locale, key));
    expect(markup).toContain('type="file" class="markdown-import-file" accept=".md,.markdown"');
    expect(markup).toContain('class="markdown-import-input"');
    expect(markup).not.toContain('readOnly');
    expect(markup).not.toContain('<select');
    const confirmButton = markup.match(/<button\b[^>]*class="[^"]*markdown-import-confirm-button[^"]*"[^>]*>/)?.[0];
    expect(confirmButton).toContain('disabled=""');
  });
  it.each(['en', 'zh-TW'] as const)('renders a readonly manual prompt outside the summary and never executable content in %s', locale => {
    const text = 'Exact Prompt\n﻿# User <script>value</script>\r\n~~~text\r\nData only\r\n~~~';
    const markup = render(createElement(MarkdownPromptDialog, { text, filename: '<file>.md', isCurrent: () => true, onClose: () => {}, onBusyChange: () => {} }), locale);
    expect(markup).toContain('markdown-prompt-dialog');
    expect(markup).toContain('class="markdown-prompt-text" readOnly=""');
    expect(markup).toContain('&lt;script&gt;value&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('shared-workspace-detail');
    expect(markup).toContain(translate(markdownImportMessages, locale, 'promptDescription'));
    expect(markup).toContain(translate(markdownImportMessages, locale, 'promptLocalOnly'));
    expect(markup).toContain(translate(markdownImportMessages, locale, 'promptCopy'));
    expect(markup).not.toContain(translate(markdownImportMessages, locale, 'promptCopied'));
  });
  it('disables copying a prompt whose captured summary is no longer current', () => {
    const markup = render(createElement(MarkdownPromptDialog, { text: 'prompt', filename: 'summary.md', isCurrent: () => false, onClose: () => {}, onBusyChange: () => {} }));
    expect(markup.match(/<button\b[^>]*class="[^"]*markdown-prompt-copy[^"]*"[^>]*>/)?.[0]).toContain('disabled=""');
  });
});

describe('selected Markdown file decoding and input generations', () => {
  it('preserves the UTF-8 BOM, CRLF, fences and trailing whitespace without File.text()', async () => {
    const text = '﻿# 原文\r\n~~~~text\r\n  content  \r\n~~~~\r\n';
    const file = { size: markdownTextBytes(text), arrayBuffer: vi.fn(async () => encode(text)) };
    expect(await readMarkdownFile(file)).toBe(text);
    expect(file.arrayBuffer).toHaveBeenCalledOnce();
    expect(markdownTextBytes('中')).toBe(3);
    expect(markdownTextBytes('﻿')).toBe(3);
  });
  it('rejects a claimed oversized file before reading, and separately checks the actual bytes', async () => {
    const arrayBuffer = vi.fn(async () => encode('small'));
    await expect(readMarkdownFile({ size: MAX_MARKDOWN_BYTES + 1, arrayBuffer })).rejects.toThrow('1 MiB');
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(readMarkdownFile({ size: 1, arrayBuffer: async () => new Uint8Array(MAX_MARKDOWN_BYTES + 1).buffer })).rejects.toThrow('1 MiB');
    await expect(readMarkdownFile({ size: MAX_MARKDOWN_BYTES, arrayBuffer: async () => encode('x'.repeat(MAX_MARKDOWN_BYTES)) })).resolves.toHaveLength(MAX_MARKDOWN_BYTES);
  });
  it('counts non-ASCII bytes rather than characters at the limit', async () => {
    const allowed = '中'.repeat(Math.floor(MAX_MARKDOWN_BYTES / 3));
    expect(markdownTextBytes(allowed)).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    expect(await readMarkdownFile({ size: markdownTextBytes(allowed), arrayBuffer: async () => encode(allowed) })).toBe(allowed);
    const tooLarge = `${allowed}中`;
    expect(tooLarge.length).toBeLessThan(MAX_MARKDOWN_BYTES);
    await expect(readMarkdownFile({ size: tooLarge.length, arrayBuffer: async () => encode(tooLarge) })).rejects.toThrow('1 MiB');
  });
  it('rejects malformed UTF-8 rather than replacing undecodable bytes and localizes the error', async () => {
    for (const bytes of [[0xff], [0xc3, 0x28], [0xe2, 0x82]]) {
      const error = await readMarkdownFile({ size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }).catch(error => error);
      expect(errorMessage(error, 'en')).toContain('not valid UTF-8');
      expect(errorMessage(error, 'zh-TW')).toContain('不是有效的 UTF-8');
    }
  });
  it('reports read failures without pretending an empty file was loaded', async () => {
    const result = readMarkdownFile({ size: 12, arrayBuffer: async () => { throw new Error('OS private path'); } });
    await expect(result).rejects.toThrow('previous text is preserved');
    await expect(result).rejects.not.toThrow('OS private path');
  });
  it('ignores out-of-order reads, edits and unmounted input generations', async () => {
    const guard = createMarkdownInputGuard();
    let resolveFirst!: (value: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>(resolve => { resolveFirst = resolve; });
    let draft = 'existing draft';
    const first = guard.advance();
    const oldRead = readMarkdownFile({ size: 3, arrayBuffer: () => pending }).then(text => { if (guard.isCurrent(first)) draft = text; });
    const second = guard.advance();
    const newerText = await readMarkdownFile({ size: 3, arrayBuffer: async () => encode('new') });
    if (guard.isCurrent(second)) draft = newerText;
    resolveFirst(encode('old')); await oldRead;
    expect(draft).toBe('new');
    const previewVersion = guard.advance();
    guard.advance(); // Typing, selecting another file or unmounting invalidates this preview.
    expect(guard.isCurrent(previewVersion)).toBe(false);
    expect(guard.isCurrent(second)).toBe(false);
  });
});
