import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CachedSnapshot, DeviceRecord, DeviceState } from '../shared/devices';
import { api, deviceApi, errorMessage } from '../src/api';
import { canUseNetwork, decisionLabels, deliveryLabels, devicePresence, getConnectionLabels, getDecisionLabels, getDeliveryLabels, isNetworkOnline, proposalChanges, snapshotKey } from '../src/device-ui';
import { LocalizedError } from '../shared/i18n';
import { I18nProvider } from '../src/i18n';
import { DeviceSettings } from '../src/panels/DeviceSettings';
import { Sidebar } from '../src/components/Sidebar';
import type { DeviceController } from '../src/hooks';

const owner = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const now = Date.parse('2026-10-19T10:00:00.000Z');
const record: DeviceRecord = { id: owner, name: '同名電腦', lastSeenAt: new Date(now - 60_000).toISOString(), revokedAt: null };
const state: DeviceState = {
  localDevice: { id: recipient, name: '本機設備' }, desktopAvailable: true, enabled: false, paired: false, pairingPending: false,
  connection: 'disabled', configuration: null, networkId: null, devices: [], sharing: [], lastSyncAt: null, lastError: null, queuedCount: 0, inboxCount: 0,
};
const snapshot: CachedSnapshot = {
  ownerDeviceId: owner, projectId, version: 8, publishedAt: '2026-10-19T09:58:00.000Z', receivedAt: '2026-10-19T09:59:00.000Z',
  project: { name: '共享專案', status: 'active', priority: 'normal', stage: '驗證', nextAction: '原本下一步', revision: 17, memory: { status: '原本狀態', notes: '' } },
};
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
    expect(canUseNetwork({ ...state, paired: true })).toBe(true); // Offline compose may queue locally.
    expect(isNetworkOnline({ ...state, paired: true })).toBe(false);
    const online = { ...state, paired: true, enabled: true, connection: 'online' as const };
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
  it('uses relative protected device APIs and preserves preview/accept hash and revision', async () => {
    const requests: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url === '/api/workspace' ? { csrfToken: 'local-token' } : {} };
    }));
    await api.workspace();
    await deviceApi.previewSharing(projectId, { enabled: true, memoryFields: ['status'] });
    await deviceApi.saveSharing(projectId, { enabled: true, memoryFields: ['status'] });
    await deviceApi.accept('message/id', { hash: 'a'.repeat(64), revision: 17, confirm: true });
    await deviceApi.send({ toDeviceId: owner, payload: { schemaVersion: 1, kind: 'proposal', projectId, baseRevision: 17, text: '', changes: { nextAction: '新一步' } } });
    expect(requests.map(item => item.url)).toEqual(['/api/workspace', `/api/devices/sharing/${projectId}/preview`, `/api/devices/sharing/${projectId}`, '/api/messages/message%2Fid/accept', '/api/messages']);
    expect(requests.slice(1).every(item => (item.options.headers as Record<string, string>)['X-Hub-Token'] === 'local-token')).toBe(true);
    expect(requests.every(item => item.options.credentials === 'same-origin')).toBe(true);
    expect(JSON.parse(requests[3].options.body as string)).toEqual({ hash: 'a'.repeat(64), revision: 17, confirm: true });
    expect(JSON.parse(requests[2].options.body as string)).toEqual({ enabled: true, memoryFields: ['status'] });
  });
});
