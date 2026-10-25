import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, workItemApi } from '../src/api';
import { PROFILE_HEADER } from '../shared/devices';
import { emptyWorkBrief, type WorkItem, type WorkMutation } from '../shared/work-items';
import { commitWorkRequest, prepareWorkAction, prepareWorkCreate, sendWorkRequest } from '../src/work-items';

const projectId = '11111111-1111-4111-8111-111111111111';
const item: WorkItem = {
  id: '22222222-2222-4222-8222-222222222222', projectId, revision: 4, version: 2, phase: 'ready',
  brief: { ...emptyWorkBrief(), title: 'Title', goal: '  原文\nKeep whitespace  ', acceptanceCriteria: ['Check result'], firstCheck: 'Open the result' },
  progress: '', nextAction: '', hold: null, currentSubmissionId: null, checks: { self: null, partner: null }, sourceWorkItemId: null,
  createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z',
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mutation = (revision = 5): WorkMutation => ({ item: { ...item, revision }, receipt: { commandId: '33333333-3333-4333-8333-333333333333', eventId: 'event-1', resultRevision: 5, replayed: false } });

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(url === '/api/workspace' ? { csrfToken: 'work-csrf' } : mutation());
  }));
  return calls;
}

describe('local-only work-item API contract', () => {
  it('uses encoded, narrow routes and keeps the original API CSRF behavior', async () => {
    const calls = capture(); await api.workspace();
    await workItemApi.list(); await workItemApi.list('project /?#'); await workItemApi.get('item /?#'); await workItemApi.brief('item /?#');
    const create = prepareWorkCreate(projectId, item.brief, item.id);
    await sendWorkRequest(create);
    const command = prepareWorkAction(item, { type: 'dispatch', previewHash: 'a'.repeat(64) });
    await sendWorkRequest(command);
    expect(calls.map(call => call.url)).toEqual([
      '/api/workspace', '/api/work-items', '/api/work-items?projectId=project%20%2F%3F%23',
      '/api/work-items/item%20%2F%3F%23', '/api/work-items/item%20%2F%3F%23/brief',
      `/api/projects/${projectId}/work-items`, `/api/work-items/${item.id}/actions`,
    ]);
    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('X-Hub-Token')).toBe('work-csrf'); expect(headers.has(PROFILE_HEADER)).toBe(false);
      expect(call.init.credentials).toBe('same-origin'); expect(call.init.cache).toBe('no-store');
    }
    expect(calls.slice(1, 5).every(call => call.init.method === 'GET' && call.init.body === undefined)).toBe(true);
    expect(JSON.parse(String(calls[5].init.body))).toEqual(create.input);
    expect(JSON.parse(String(calls[6].init.body))).toEqual(command.input);
    expect(JSON.parse(String(calls[6].init.body))).toMatchObject({ expectedRevision: 4, action: { type: 'dispatch', previewHash: 'a'.repeat(64) } });
    expect(calls[5].init.method).toBe('POST'); expect(calls[6].init.method).toBe('POST');
  });

  it('captures browser UUIDs and immutable create/action bodies for explicit retries', async () => {
    const brief = structuredClone(item.brief);
    const created = prepareWorkCreate(projectId, brief);
    brief.goal = 'later edits must not alter sent content';
    expect(created.input.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.kind === 'create' && created.input.brief.goal).toBe(item.brief.goal);
    const action = { type: 'saveDraft' as const, brief: structuredClone(item.brief) };
    const prepared = prepareWorkAction(item, action);
    action.brief.goal = 'changed after capture';
    expect(prepared.input.commandId).not.toBe(created.input.commandId);
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error('response lost after commit');
      return Response.json(mutation());
    });
    vi.stubGlobal('fetch', fetch);
    await expect(sendWorkRequest(prepared)).rejects.toMatchObject({ status: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    await sendWorkRequest(prepared);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[1]).action.brief.goal).toBe(item.brief.goal);
    expect(JSON.parse(bodies[1]).expectedRevision).toBe(4);
  });

  it('surfaces 409 once without retry, changing the command ID, or refreshing the base', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'Newer saved content', code: 'work.revision' }, { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const request = prepareWorkAction(item, { type: 'confirm' }); const snapshot = structuredClone(request);
    const committed = vi.fn(); const refresh = vi.fn();
    await expect(commitWorkRequest(request, committed, refresh)).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);
    expect(fetch).toHaveBeenCalledOnce(); expect(request).toEqual(snapshot);
    expect(committed).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(item.revision).toBe(4);
  });

  it('adopts the latest item, not an old replay receipt, before reporting refresh-only failure', async () => {
    const response = mutation(12); response.receipt.replayed = true; response.receipt.resultRevision = 5;
    const fetch = vi.fn(async () => Response.json(response)); vi.stubGlobal('fetch', fetch);
    let savedRevision = item.revision; const order: string[] = [];
    const result = await commitWorkRequest(prepareWorkAction(item, { type: 'dispatch', previewHash: 'a'.repeat(64) }), mutation => {
      savedRevision = mutation.item.revision; order.push('committed');
    }, async latest => { expect(latest.revision).toBe(12); order.push('refresh'); throw new Error('list read failed'); });
    expect(result).toEqual({ refreshFailed: true }); expect(savedRevision).toBe(12);
    expect(order).toEqual(['committed', 'refresh']); expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not issue a mutation when fetching a copy preview', async () => {
    const preview = { markdown: 'Exact 原文\r\n  trailing spaces  ', hash: 'b'.repeat(64), version: 2, revision: 4 };
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(preview)); vi.stubGlobal('fetch', fetch);
    expect(await workItemApi.brief(item.id)).toEqual(preview);
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].method).toBe('GET');
  });
});
