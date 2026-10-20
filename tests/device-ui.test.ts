import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CachedSnapshot, DeviceGroup, DeviceRecord, DeviceState, GroupSharingPreview, SharedWorkspaceItem } from '../shared/devices';
import { MEMORY_FIELDS } from '../shared/types';
import { api, deviceApi, errorMessage } from '../src/api';
import { canUseNetwork, canonicalGroupPolicies, decisionLabels, deliveryLabels, devicePresence, getConnectionLabels, getDecisionLabels, getDeliveryLabels, groupSharePolicies, isNetworkOnline, proposalChanges, sharedWorkspaceKey, snapshotKey, workspaceItems } from '../src/device-ui';
import { LocalizedError } from '../shared/i18n';
import { I18nProvider } from '../src/i18n';
import { DeviceSettings } from '../src/panels/DeviceSettings';
import { Sidebar } from '../src/components/Sidebar';
import { downloadText, type DeviceController } from '../src/hooks';
import { SharedSummaryDetail, SharedWorkspaceView } from '../src/panels/SharedWorkspacePanel';
import { MemoryShareFields } from '../src/panels/GroupSharingSettings';

const owner = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const now = Date.parse('2026-10-19T10:00:00.000Z');
const record: DeviceRecord = { id: owner, name: '同名電腦', lastSeenAt: new Date(now - 60_000).toISOString(), revokedAt: null };
const state: DeviceState = {
  installationId: recipient, profileId: null, groups: [],
  localDevice: { id: recipient, name: '本機設備' }, desktopAvailable: true, enabled: false, paired: false, pairingPending: false,
  connection: 'disabled', configuration: null, networkId: null, devices: [], sharing: [], lastSyncAt: null, lastError: null, queuedCount: 0, inboxCount: 0,
};
const snapshot: CachedSnapshot = {
  ownerDeviceId: owner, projectId, version: 8, publishedAt: '2026-10-19T09:58:00.000Z', receivedAt: '2026-10-19T09:59:00.000Z',
  project: { name: '共享專案', status: 'active', priority: 'normal', stage: '驗證', nextAction: '原本下一步', revision: 17, memory: { status: '原本狀態', notes: '' } },
};
const groupA: DeviceGroup = { id: 'aaaa1111-1111-4111-8111-111111111111', label: 'Same group', url: 'https://a.supabase.co', networkId: owner, deviceId: recipient, enabled: false, paired: true, pairingPending: false, connection: 'disabled', lastSyncAt: snapshot.receivedAt, lastError: null };
const groupB: DeviceGroup = { ...groupA, id: 'bbbb2222-2222-4222-8222-222222222222', deviceId: owner, url: 'https://b.supabase.co' };
const sharedItem: SharedWorkspaceItem = { profileId: groupA.id, groupLabel: groupA.label, ownerDeviceId: owner, ownerName: 'Same owner', projectId, version: snapshot.version, project: snapshot.project!, owned: false, pending: false, publishedAt: snapshot.publishedAt, receivedAt: snapshot.receivedAt, lastSyncAt: groupA.lastSyncAt };
afterEach(() => vi.unstubAllGlobals());

describe('desktop device UI boundaries', () => {
  it('uses heartbeat freshness, not fetch time, and labels revoked devices', () => {
    expect(devicePresence(record, now)).toBe('Recently online');
    expect(devicePresence({ ...record, lastSeenAt: new Date(now - 120_000).toISOString() }, now)).toBe('Offline / status not updated');
    expect(devicePresence({ ...record, lastSeenAt: 'invalid' }, now)).toBe('Offline / status not updated');
    expect(devicePresence({ ...record, lastSeenAt: new Date(now + 300_000).toISOString() }, now)).toBe('Offline / status not updated');
    expect(devicePresence({ ...record, revokedAt: new Date(now).toISOString() }, now)).toBe('Revoked');
    expect(devicePresence(record, now, 'zh-TW')).toBe('最近上線');
    expect(devicePresence({ ...record, lastSeenAt: 'invalid' }, now, 'zh-TW')).toBe('離線／狀態未更新');
    expect(devicePresence({ ...record, revokedAt: new Date(now).toISOString() }, now, 'zh-TW')).toBe('已撤銷');
  });
  it('requires desktop availability and a valid pairing for network controls, online only for fresh authorization', () => {
    expect(canUseNetwork(state)).toBe(false);
    expect(canUseNetwork({ ...state, paired: true })).toBe(false); // No implicit selected-profile fallback.
    expect(canUseNetwork({ ...state, profileId: recipient, paired: true })).toBe(true); // Offline compose may queue locally.
    expect(isNetworkOnline({ ...state, profileId: recipient, paired: true })).toBe(false);
    const online = { ...state, profileId: recipient, paired: true, enabled: true, connection: 'online' as const };
    expect(isNetworkOnline(online)).toBe(true);
    expect(canUseNetwork({ ...online, desktopAvailable: false })).toBe(false);
    expect(isNetworkOnline({ ...online, connection: 'error' })).toBe(false);
    expect(canUseNetwork({ ...online, connection: 'revoked' })).toBe(false);
    expect(canUseNetwork({ ...online, connection: 'locked' })).toBe(false);
  });
  it('keeps device ownership in remote snapshot identities', () => {
    expect(snapshotKey(snapshot)).not.toBe(snapshotKey({ ...snapshot, ownerDeviceId: recipient }));
  });
  it('sends only selected, changed and shared fields; unshared memory never becomes empty', () => {
    expect(proposalChanges(snapshot, undefined, {})).toEqual({});
    expect(proposalChanges(snapshot, snapshot.project!.nextAction, { status: '原本狀態', notes: '' })).toEqual({});
    expect(proposalChanges(snapshot, undefined, { architecture: '', overview: '未分享欄位', status: '新狀態' })).toEqual({ memory: { status: '新狀態' } });
    expect(proposalChanges(snapshot, '', { status: '' })).toEqual({ nextAction: '', memory: { status: '' } });
    expect(snapshot.project!.memory.status).toBe('原本狀態');
    expect(() => proposalChanges({ ...snapshot, project: null }, '', {})).toThrow('This summary has been withdrawn');
    try { proposalChanges({ ...snapshot, project: null }, '', {}, 'zh-TW'); }
    catch (error) {
      expect(error).toBeInstanceOf(LocalizedError);
      expect(errorMessage(error, 'zh-TW')).toContain('摘要已撤回');
      expect(errorMessage(error, 'en')).toContain('This summary has been withdrawn');
    }
  });
  it('distinguishes cloud submission, delivery and application results', () => {
    expect(deliveryLabels.submitted).toBe('Submitted to cloud');
    expect(deliveryLabels.received).toBe('Delivered');
    expect(decisionLabels.applied).toBe('Accepted and applied');
    expect(deliveryLabels.queued).not.toMatch(/executed|applied|delivered/i);
    expect(deliveryLabels.submitted).not.toMatch(/executed|applied|delivered/i);
    expect(getDeliveryLabels('zh-TW').submitted).toBe('已提交雲端');
    expect(getDeliveryLabels('zh-TW').received).toBe('已送達');
    expect(getDecisionLabels('zh-TW').applied).toBe('已接受並套用');
    expect(getConnectionLabels('en').disabled).toBe('Connection paused');
    expect(getConnectionLabels('zh-TW').disabled).toBe('連線已暫停');
    expect(getDeliveryLabels('zh-TW').queued).not.toMatch(/已執行|已套用|已送達/);
    expect(getDeliveryLabels('zh-TW').submitted).not.toMatch(/已執行|已套用|已送達/);
  });
  it('keeps name and pairing forms as siblings and disables browser cloud controls', () => {
    const controller: DeviceController = { state: { ...state, desktopAvailable: false }, loading: false, error: '', reload: async () => {}, update: async operation => operation() };
    const content = createElement(DeviceSettings, { devices: controller, projects: [], onDirtyChange: () => {}, onBusyChange: () => {} });
    const english = renderToStaticMarkup(content);
    expect(english).not.toContain('預設關閉');
    expect(english).toMatch(/device/i);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'zh-TW', children: content }));
    expect(markup).toContain('預設關閉');
    expect(markup).toContain('不是端對端加密');
    expect(markup).toContain('瀏覽器模式');
    const tags = [...markup.matchAll(/<\/?form\b[^>]*>/g)].map(match => match[0].startsWith('</') ? -1 : 1);
    let depth = 0;
    for (const change of tags) { depth += change; expect(depth).toBeLessThanOrEqual(1); }
    expect(depth).toBe(0);
    expect(tags).toEqual([1, -1, 1, -1]);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*?檢查並配對<\/button>/s);
  });
  it('renders duplicate names as separate identified remote devices without paths', () => {
    const other = { ...record, id: projectId };
    const content = createElement(Sidebar, { view: 'remote', onNavigate: () => {}, onDevice: () => {}, projectCount: 0, taskCount: 0, devices: { ...state, paired: true, devices: [record, other] }, selectedDeviceId: other.id });
    const markup = renderToStaticMarkup(content);
    expect(markup.match(/同名電腦/g)).toHaveLength(2);
    expect(markup).toContain('11111111');
    expect(markup).toContain('33333333');
    expect(markup).toContain('Remote read-only');
    expect(markup).toContain('本機設備');
    expect(markup).toContain('aria-label="Main navigation"');
    const chinese = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'zh-TW', children: content }));
    expect(chinese).toContain('遠端唯讀');
    expect(chinese.match(/同名電腦/g)).toHaveLength(2);
    expect(chinese).toContain('本機設備');
    expect(chinese).toContain('11111111');
    expect(chinese).toContain('33333333');
  });
  it('separates group, owner, and project identities without merging shared fields', () => {
    const otherGroup = { ...sharedItem, profileId: groupB.id, project: { ...sharedItem.project, memory: { decisions: 'Only group B sees this' } } };
    const otherOwner = { ...sharedItem, ownerDeviceId: recipient };
    expect(new Set([sharedItem, otherGroup, otherOwner].map(sharedWorkspaceKey)).size).toBe(3);
    expect(workspaceItems([sharedItem, otherGroup, otherOwner], [groupA, groupB], '', '')).toHaveLength(3);
    expect(workspaceItems([sharedItem, otherGroup], [groupA, groupB], groupB.id, '')).toEqual([otherGroup]);
    expect(workspaceItems([sharedItem, otherGroup], [groupA, groupB], '', 'only group b')).toEqual([otherGroup]);
    expect(workspaceItems([sharedItem, otherGroup], [groupA], '', '')).toEqual([sharedItem]);
    expect(workspaceItems([sharedItem, otherGroup], [groupA, { ...groupB, connection: 'revoked' }], '', '')).toEqual([sharedItem]);
    expect(sharedItem.project.memory).toEqual({ status: '原本狀態', notes: '' });
  });
  it('keeps full sharing target choices and memory fields independent; new groups stay unselected', () => {
    const current: GroupSharingPreview = { projectId, revision: 17, digest: 'd'.repeat(64), groups: [
      { group: groupA, preview: { projectId, policy: { projectId, enabled: true, memoryFields: ['status'] }, project: snapshot.project, bytes: 120 } },
      { group: groupB, preview: { projectId, policy: { projectId, enabled: false, memoryFields: [] }, project: null, bytes: 4 } },
    ] };
    const policies = groupSharePolicies(current);
    expect(policies).toEqual([{ profileId: groupA.id, enabled: true, memoryFields: ['status'] }, { profileId: groupB.id, enabled: false, memoryFields: [] }]);
    expect(canonicalGroupPolicies(policies)).toBe(canonicalGroupPolicies([...policies].reverse()));
    expect(canonicalGroupPolicies(policies.map(item => item.profileId === groupA.id ? { ...item, enabled: false } : item))).not.toBe(canonicalGroupPolicies(policies));
    expect(current.groups[0].preview.policy.enabled).toBe(true);
    const mixed = renderToStaticMarkup(createElement(MemoryShareFields, { fields: ['status'], disabled: false, onChange: () => {} }));
    expect(mixed).toContain('aria-checked="mixed"');
    expect(mixed.match(/type="checkbox"/g)).toHaveLength(MEMORY_FIELDS.length + 1);
    const full = renderToStaticMarkup(createElement(MemoryShareFields, { fields: [...MEMORY_FIELDS], disabled: true, onChange: () => {} }));
    expect(full).toContain('aria-checked="true"');
    expect(full).toContain('<fieldset class="memory-share-fields" disabled=""');
  });
  it('shows joined group identities, label editors and join-another form together', () => {
    const controller: DeviceController = { state: { ...state, profileId: groupA.id, groups: [groupA, groupB], paired: true }, loading: false, error: '', reload: async () => {}, update: async operation => operation() };
    const markup = renderToStaticMarkup(createElement(DeviceSettings, { devices: controller, projects: [], onDirtyChange: () => {}, onBusyChange: () => {} }));
    expect(markup).toContain('Join another group'); expect(markup).toContain('Current management group');
    expect(markup).toContain(groupA.id); expect(markup).toContain(groupB.id);
    expect(markup.match(/class="group-label-form"/g)).toHaveLength(2);
    expect(markup).toContain('Adding a group does not rename this computer.');
    let depth = 0;
    for (const match of markup.matchAll(/<\/?form\b[^>]*>/g)) { depth += match[0].startsWith('</') ? -1 : 1; expect(depth).toBeLessThanOrEqual(1); }
    expect(depth).toBe(0);
  });
  it('renders the shared workspace as readonly escaped summaries with real source and cached state', () => {
    const item = { ...sharedItem, project: { ...sharedItem.project, name: '<script>alert(1)</script>', memory: { notes: '<img src=x onerror=alert(1)>' } } };
    const markup = renderToStaticMarkup(createElement(SharedWorkspaceView, { data: { groups: [groupA, groupB], items: [item, { ...item, profileId: groupB.id }] }, selected: item, profileId: '', query: '', loading: false, error: '', onFilter: () => {}, onSearch: () => {}, onSelect: () => {}, onReload: async () => {}, onSettings: () => {}, onBusyChange: () => {} }));
    expect(markup).toContain('Download Markdown'); expect(markup).toContain('Read-only summary');
    expect(markup).toContain('Last group sync'); expect(markup).toContain('not a live view');
    expect(markup).toContain(groupA.id); expect(markup).toContain(owner); expect(markup).toContain(projectId);
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(markup).not.toContain('<script>'); expect(markup).not.toContain('<img src=x');
    expect(markup).not.toContain('Propose changes'); expect(markup).not.toContain('Edit project'); expect(markup).not.toContain('<textarea');
    expect(markup.match(/class="remote-project-item/g)).toHaveLength(2);
    const pending = renderToStaticMarkup(createElement(SharedSummaryDetail, { item: { ...sharedItem, owned: true, pending: true, publishedAt: null, receivedAt: null }, group: groupA }));
    expect(pending).toContain('Not published yet'); expect(pending).toContain('Pending sync'); expect(pending).toContain('not confirmation');
    const sent = renderToStaticMarkup(createElement(SharedSummaryDetail, { item: { ...sharedItem, owned: true, pending: false }, group: groupA }));
    expect(sent).toContain('Published to group'); expect(sent).not.toContain('Pending sync');
    const migrated = renderToStaticMarkup(createElement(SharedSummaryDetail, { item: { ...sharedItem, owned: true, pending: false, publishedAt: null }, group: groupA }));
    expect(migrated).toContain('Published to group'); expect(migrated).not.toContain('Not published yet');
    expect(migrated).not.toContain('Pending sync');
  });
  it('preserves native download cancellation and surfaces save failures', async () => {
    const saveText = vi.fn(async () => false);
    vi.stubGlobal('window', { hubDesktop: { saveText } });
    expect(await downloadText('Only shared text', 'summary.md')).toBe(false);
    expect(saveText).toHaveBeenCalledWith({ filename: 'summary.md', text: 'Only shared text' });
    saveText.mockRejectedValueOnce(new Error('Save failed'));
    await expect(downloadText('Only shared text', 'summary.md')).rejects.toThrow('Save failed');
  });
  it('sends complete group consent and exact source/version for fresh downloads', async () => {
    const requests: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => { requests.push({ url, options }); return { ok: true, json: async () => url === '/api/workspace' ? { csrfToken: 'local-token' } : {} }; }));
    await api.workspace();
    const policies = [{ profileId: groupA.id, enabled: true, memoryFields: ['status' as const] }, { profileId: groupB.id, enabled: false, memoryFields: [] }];
    await deviceApi.previewGroupSharing(projectId, policies);
    await deviceApi.saveGroupSharing(projectId, policies, 'd'.repeat(64));
    await deviceApi.downloadSummary(sharedItem);
    expect(JSON.parse(requests[1].options.body as string)).toEqual({ policies });
    expect(JSON.parse(requests[2].options.body as string)).toEqual({ policies, digest: 'd'.repeat(64), confirm: true });
    expect(JSON.parse(requests[3].options.body as string)).toEqual({ profileId: groupA.id, ownerDeviceId: owner, projectId, version: snapshot.version });
    expect(requests[3].url).toBe('/api/shared-workspace/download');
    expect(requests.slice(1).every(request => (request.options.headers as Record<string, string>)['X-Hub-Token'] === 'local-token')).toBe(true);
  });
  it('uses relative protected device APIs and preserves preview/accept hash and revision', async () => {
    const requests: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url === '/api/workspace' ? { csrfToken: 'local-token' } : {} };
    }));
    await api.workspace();
    await deviceApi.previewSharing(recipient, projectId, { enabled: true, memoryFields: ['status'] });
    await deviceApi.saveSharing(recipient, projectId, { enabled: true, memoryFields: ['status'] });
    await deviceApi.accept(recipient, 'message/id', { hash: 'a'.repeat(64), revision: 17, confirm: true });
    await deviceApi.send(recipient, { toDeviceId: owner, payload: { schemaVersion: 1, kind: 'proposal', projectId, baseRevision: 17, text: '', changes: { nextAction: '新一步' } } });
    expect(requests.map(item => item.url)).toEqual(['/api/workspace', `/api/devices/sharing/${projectId}/preview`, `/api/devices/sharing/${projectId}`, '/api/messages/message%2Fid/accept', '/api/messages']);
    expect(requests.slice(1).every(item => (item.options.headers as Record<string, string>)['X-Hub-Token'] === 'local-token')).toBe(true);
    expect(requests.slice(1).every(item => (item.options.headers as Record<string, string>)['X-Hub-Profile-Id'] === recipient)).toBe(true);
    expect(requests.every(item => item.options.credentials === 'same-origin')).toBe(true);
    expect(JSON.parse(requests[3].options.body as string)).toEqual({ hash: 'a'.repeat(64), revision: 17, confirm: true });
    expect(JSON.parse(requests[2].options.body as string)).toEqual({ enabled: true, memoryFields: ['status'] });
  });
});
