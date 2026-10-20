import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, errorMessage, markdownApi } from '../src/api.js';
import type { MarkdownImportApplyInput } from '../shared/markdown-import.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('local Markdown import API client', () => {
  it('sends exact text and captured confirmation data without a cloud profile', async () => {
    const calls: { path: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      return Response.json(path === '/api/workspace' ? { csrfToken: 'test-local-token' } : {});
    }));
    await api.workspace();
    const text = '﻿# Original\r\n\r\n~~~text\r\n  Content  \r\n~~~\r\n';
    await markdownApi.preview(text);
    const input: MarkdownImportApplyInput = { text, projectId: '11111111-1111-4111-8111-111111111111', revision: 9, hash: 'a'.repeat(64), digest: 'b'.repeat(64), confirm: true };
    await markdownApi.apply(input);
    expect(calls[1].path).toBe('/api/markdown-import/preview');
    expect(JSON.parse(String(calls[1].options.body))).toEqual({ text });
    expect(calls[2].path).toBe('/api/markdown-import/apply');
    expect(JSON.parse(String(calls[2].options.body))).toEqual(input);
    for (const call of calls.slice(1)) {
      expect(call.options.method).toBe('POST');
      expect(call.options.credentials).toBe('same-origin');
      expect(call.options.cache).toBe('no-store');
      expect(new Headers(call.options.headers).get('X-Hub-Token')).toBe('test-local-token');
      expect(new Headers(call.options.headers).get('X-Hub-Profile-Id')).toBeNull();
    }
  });
  it('retains a machine-coded stale-preview error for localization', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Stale preview', code: 'markdown.changed' }, { status: 409 })));
    const error = await markdownApi.preview('changed document').catch(value => value);
    expect(error.status).toBe(409); expect(error.code).toBe('markdown.changed');
    expect(errorMessage(error, 'en')).not.toBe(errorMessage(error, 'zh-TW'));
    expect(errorMessage(error, 'zh-TW')).not.toContain('Stale preview');
  });
});
