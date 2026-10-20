import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, deviceApi, gitApi, governanceApi } from '../src/api.js';
import { PROFILE_HEADER, type SharedWorkspaceItem } from '../shared/devices.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
afterEach(() => { vi.unstubAllGlobals(); });

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(url === '/api/workspace' ? { csrfToken: 'test-csrf' } : {});
  }));
  return calls;
}

describe('explicit group scope in the renderer API', () => {
  it('keeps independently captured groups on concurrent requests and preserves CSRF', async () => {
    const calls = capture();
    await api.workspace();
    await Promise.all([deviceApi.messages(a, 'inbox'), deviceApi.send(b, { toDeviceId: a, payload: { schemaVersion: 1, kind: 'message', text: 'Group B only' } })]);
    expect(new Headers(calls[1].init.headers).get(PROFILE_HEADER)).toBe(a);
    expect(new Headers(calls[2].init.headers).get(PROFILE_HEADER)).toBe(b);
    expect(new Headers(calls[2].init.headers).get('X-Hub-Token')).toBe('test-csrf');
    expect(calls[2].init.credentials).toBe('same-origin');
    expect(calls[2].init.cache).toBe('no-store');
  });
  it('pins governance and Git authorization while leaving local recovery explicitly unscoped', async () => {
    const calls = capture();
    await governanceApi.refresh(a);
    await gitApi.decide(b, 'request', 'digest', 'approved', 'Reviewed in B');
    await gitApi.requests(null, 'project');
    await gitApi.acknowledge(null, 'recovery-request');
    expect(calls.map(call => new Headers(call.init.headers).get(PROFILE_HEADER))).toEqual([a, b, null, null]);
  });
  it('sends the complete selected policy set and digest without implicit all-group expansion', async () => {
    const calls = capture();
    const policies = [{ profileId: a, enabled: true, memoryFields: ['status'] as const }, { profileId: b, enabled: false, memoryFields: [] as const }]
      .map(policy => ({ ...policy, memoryFields: [...policy.memoryFields] }));
    await deviceApi.saveGroupSharing('project', policies, 'reviewed-digest');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ policies, digest: 'reviewed-digest', confirm: true });
    expect(new Headers(calls[0].init.headers).has(PROFILE_HEADER)).toBe(false);
  });
  it('requests a fresh download by identity/version, never posts the cached summary body', async () => {
    const calls = capture();
    const item = { profileId: a, ownerDeviceId: b, projectId: 'project', version: 7, project: { notes: 'must not be sent' }, groupLabel: 'local label' } as unknown as SharedWorkspaceItem;
    await deviceApi.downloadSummary(item);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ profileId: a, ownerDeviceId: b, projectId: 'project', version: 7 });
    expect(calls[0].url).toBe('/api/shared-workspace/download');
  });
});
