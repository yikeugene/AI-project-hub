import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type WrapUpInput } from '../src/api.js';
import { PROFILE_HEADER } from '../shared/devices.js';

const projectId = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.unstubAllGlobals());

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(url === '/api/workspace' ? { csrfToken: 'resumption-csrf' } : {});
  }));
  return calls;
}

describe('local focus and wrap-up client contracts', () => {
  it('sends the ordered local IDs and independent revision with CSRF, never a group scope', async () => {
    const calls = capture();
    await api.workspace();
    const ids = [projectId, '22222222-2222-4222-8222-222222222222'];
    await api.saveFocus(7, ids);
    expect(calls[1].url).toBe('/api/workspace/focus');
    expect(calls[1].init.method).toBe('PUT');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ revision: 7, projectIds: ids });
    expect(new Headers(calls[1].init.headers).get('X-Hub-Token')).toBe('resumption-csrf');
    expect(new Headers(calls[1].init.headers).has(PROFILE_HEADER)).toBe(false);
    expect(calls[1].init.credentials).toBe('same-origin');
    expect(calls[1].init.cache).toBe('no-store');
    expect(ids).toEqual([projectId, '22222222-2222-4222-8222-222222222222']);
  });

  it('uses one narrow atomic request for wrap-up, preserving authored text and empty blockers', async () => {
    const calls = capture();
    await api.workspace();
    const input: WrapUpInput = { revision: 4, status: '保留 <literal>\n  indentation', blockers: '', nextAction: '  Open the failing test 原文  ' };
    await api.wrapUpProject(projectId, input);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`/api/projects/${projectId}/wrap-up`);
    expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init.body))).toEqual(input);
    expect(new Headers(calls[1].init.headers).get('X-Hub-Token')).toBe('resumption-csrf');
    expect(new Headers(calls[1].init.headers).has(PROFILE_HEADER)).toBe(false);
  });

  it('surfaces revision conflicts without retrying a stale write', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'Newer content', code: 'revision.stale' }, { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.wrapUpProject(projectId, { revision: 1, status: '', blockers: '', nextAction: 'Keep this draft' }))
      .rejects.toMatchObject({ status: 409, code: 'revision.stale' } satisfies Partial<ApiError>);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
