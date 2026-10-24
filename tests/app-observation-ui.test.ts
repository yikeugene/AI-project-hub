import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROFILE_HEADER, type DeviceRecord, type DeviceState } from '../shared/devices';
import type { AppObservationPreview, AppObservationState, RemoteAppObservation as RemoteObservation } from '../shared/app-observation';
import { RemoteAppObservation } from '../src/components/RemoteAppObservation';
import { appObservationMessages } from '../src/locales/app-observation';
import { api, appObservationApi } from '../src/api';
import type { AppObservationController } from '../src/hooks';
import { I18nProvider } from '../src/i18n';
import { AppObservationSettings, AppObservationSharingPreview } from '../src/panels/AppObservationSettings';
import { DeviceSettings } from '../src/panels/DeviceSettings';
import { RemoteProjectsPanel } from '../src/panels/RemoteProjectsPanel';
import type { GovernanceController } from '../src/hooks';
import type { RemoteDeviceStatus } from '../shared/governance';
import { governanceMessages } from '../src/locales/panels-governance';

const resources = vi.hoisted(() => ({ observation: null as AppObservationState | null, scopes: [] as Array<string | null> }));
vi.mock('../src/hooks', async importOriginal => ({
  ...await importOriginal<typeof import('../src/hooks')>(),
  useAppObservation: (profileId: string | null) => { resources.scopes.push(profileId); return { state: resources.observation, loading: false, error: '', reload: async () => {}, update: (operation: () => Promise<AppObservationState>) => operation() }; },
  useDeviceResource: () => ({ data: [], loading: false, error: '', reload: async () => {} }),
}));

const profileId = '66666666-6666-4666-8666-666666666666';
const localId = '11111111-1111-4111-8111-111111111111';
const networkId = '44444444-4444-4444-8444-444444444444';
const devices: DeviceState = {
  installationId: localId, profileId, groups: [{ id: profileId, label: 'Test group', url: 'https://unused.invalid', networkId, deviceId: localId, enabled: true, paired: true, pairingPending: false, connection: 'online', lastSyncAt: null, lastError: null }],
  localDevice: { id: localId, name: 'Local' }, desktopAvailable: true, enabled: true, paired: true, pairingPending: false, connection: 'online', configuration: null,
  networkId, devices: [], sharing: [], lastSyncAt: null, lastError: null, queuedCount: 0, inboxCount: 0,
};
const state: AppObservationState = { profileId, policy: { enabled: false }, revision: 0, collectorAvailable: true, sessionAvailable: true, capability: 'supported', pendingWithdrawal: false, local: null, statuses: [], problem: null };
const controller = (overrides: Partial<AppObservationState> = {}): AppObservationController => ({ state: { ...state, ...overrides }, loading: false, error: '', reload: async () => {}, update: operation => operation() });
const noop = () => {};
const render = (content: ReactNode, locale: 'en' | 'zh-TW' = 'en') => renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: content }));
const card = (observation = controller(), device = devices, locale: 'en' | 'zh-TW' = 'en') => render(createElement(AppObservationSettings, { observation, devices: device, blocked: false, onDirtyChange: noop, onBusyChange: noop }), locale);
const button = (html: string, label: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(text => text.includes(label));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resources.observation = null; resources.scopes = []; });

const governance: GovernanceController = {
  state: { available: true, policy: { protocol: 2, networkId, deviceId: localId, role: 'admin', epoch: 1, roles: [{ deviceId: localId, role: 'admin' }] }, error: null, sharing: { activity: true, projects: [] }, statuses: [] },
  loading: false, error: '', reload: async () => {}, update: operation => operation(),
};

describe('independent foreground application consent', () => {
  it('defaults off with an explicit separate permission and accurate privacy before collecting anything', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const html = card(controller({ local: { name: 'NOT-A-PREVIEW-SAMPLE', observedAt: '2026-10-24T10:00:00.000Z' } }));
    expect(html).toContain('Share the application currently in use (Windows)');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('Off by default');
    expect(html).toContain('separate from HelpTool');
    expect(html).toContain('name'); expect(html).toContain('observedAt');
    expect(html).toContain('does not collect');
    for (const privacy of ['window titles', 'URLs', 'document names', 'paths', 'PIDs', 'input', 'background process lists', 'usage history', 'cloud provider', 'all active members', 'HelpTool itself']) expect(html).toContain(privacy);
    expect(html).not.toContain('NOT-A-PREVIEW-SAMPLE'); expect(html).not.toContain('2026-10-24T10:00:00.000Z');
    const refresh = button(html, 'Check support / refresh status');
    expect(refresh).toBeDefined(); expect(refresh).not.toContain('disabled=');
    expect(fetch).not.toHaveBeenCalled();
    const chinese = card(controller(), devices, 'zh-TW');
    expect(chinese).toContain('分享目前使用中的應用程式（Windows）');
    expect(chinese).toContain('預設關閉'); expect(chinese).toContain('雲端服務提供者');
  });
});

describe('application consent availability and preview', () => {
  it('uses backend collector eligibility rather than the browser platform and leaves withdrawal available', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT', platform: 'Win32' });
    const unsupported = { collectorAvailable: false, sessionAvailable: false, capability: 'unsupported' as const, problem: 'upgrade-required' as const };
    expect(card(controller(unsupported)).match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain('disabled=""');
    for (const connection of ['disabled', 'error', 'locked'] as const) {
      const html = card(controller({ ...unsupported, policy: { enabled: true }, pendingWithdrawal: true }), { ...devices, enabled: false, connection, desktopAvailable: false });
      const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
      expect(checkbox).toContain('checked=""'); expect(checkbox).not.toContain('disabled=');
      expect(html).toContain('SQL migration'); expect(html).toContain('no name is collected');
      expect(html).toContain('not a credential-lock status');
      expect(html).toContain('Withdrawal is pending');
      expect(button(html, 'Check support / refresh status')).toContain('disabled=""');
    }
    vi.stubGlobal('navigator', { userAgent: 'Not Windows', platform: 'other' });
    expect(card().match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain('disabled=');
  });
  it('allows explicit online support and withdrawal checks without source eligibility or saved opt-in', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => state })); vi.stubGlobal('fetch', fetch);
    for (const capability of ['unknown', 'unsupported', 'supported'] as const) {
      const observation = controller({ capability, policy: { enabled: false }, collectorAvailable: false, sessionAvailable: false, pendingWithdrawal: true, problem: capability === 'unsupported' ? 'upgrade-required' : null });
      for (const locale of ['en', 'zh-TW'] as const) {
        const html = card(observation, devices, locale);
        const refresh = button(html, appObservationMessages[locale].refresh);
        expect(refresh).toBeDefined(); expect(refresh).not.toContain('disabled=');
        expect(html).toContain(appObservationMessages[locale].refreshHint);
        expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain('disabled=""');
      }
    }
    expect(fetch).not.toHaveBeenCalled();
    await appObservationApi.refresh(profileId);
    expect(fetch).toHaveBeenCalledWith('/api/app-observation/refresh', expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true }), headers: expect.objectContaining({ [PROFILE_HEADER]: profileId }) }));
  });
  it('keeps support checks disabled for offline, paused, unpaired, mismatched or busy contexts', () => {
    for (const changes of [{ enabled: false }, { connection: 'error' as const }, { connection: 'locked' as const }, { connection: 'revoked' as const }, { desktopAvailable: false }, { paired: false }, { pairingPending: true }, { profileId: null }]) {
      expect(button(card(controller(), { ...devices, ...changes }), appObservationMessages.en.refresh)).toContain('disabled=""');
    }
    expect(button(card(controller({ profileId: 'other-profile' })), appObservationMessages.en.refresh)).toContain('disabled=""');
    const blocked = render(createElement(AppObservationSettings, { observation: controller(), devices, blocked: true, onDirtyChange: noop, onBusyChange: noop }));
    expect(button(blocked, appObservationMessages.en.refresh)).toContain('disabled=""');
  });
  it('explains transient collector or session failures even when the platform helper remains available', () => {
    expect(card(controller({ problem: 'collector-unavailable' }))).toContain(appObservationMessages.en.collectorUnavailable);
    expect(card(controller({ problem: 'session-unavailable' }))).toContain(appObservationMessages.en.sessionUnavailable);
  });
  it('disables mismatched or unpaired consent without showing another group’s policy or raw errors', () => {
    const mismatch = card(controller({ profileId: 'different-group', policy: { enabled: true } }));
    expect(mismatch).not.toContain('checked=""');
    expect(button(mismatch, 'Preview application sharing')).toContain('disabled=""');
    const missing = card(controller(), { ...devices, profileId: null, paired: false });
    expect(missing).toContain('Select a paired management group');
    expect(button(missing, 'Preview application sharing')).toContain('disabled=""');
    const failed = card({ ...controller(), error: 'PRIVATE-DIAGNOSTIC-APPLICATION-NAME' });
    expect(failed).toContain('Could not read the local application-sharing state');
    expect(failed).not.toContain('PRIVATE-DIAGNOSTIC-APPLICATION-NAME');
  });
  it('shows only field explanations, the independent decision and its digest in a preview', () => {
    const preview: AppObservationPreview = { policy: { enabled: true }, revision: 4, digest: 'd'.repeat(64), fields: ['name', 'observedAt'] };
    for (const locale of ['en', 'zh-TW'] as const) {
      const html = render(createElement(AppObservationSharingPreview, { preview }), locale);
      expect(html).toContain('name'); expect(html).toContain('observedAt');
      expect(html).toContain(preview.digest);
      expect(html).toContain(appObservationMessages[locale].fieldsHint);
      expect(html).toContain(appObservationMessages[locale].previewEnable);
      expect(html).not.toMatch(/dateTime=|<time|activity|projects/);
      const withdrawn = render(createElement(AppObservationSharingPreview, { preview: { ...preview, policy: { enabled: false } } }), locale);
      expect(withdrawn).toContain(appObservationMessages[locale].previewDisable);
    }
  });
});

describe('last reported foreground application', () => {
  it('shows names as inert text and checks source and receipt freshness independently', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const date = (offset: number) => new Date(now + offset).toISOString();
    const status: RemoteObservation = { protocol: 1, sequence: 1, deviceId: localId, receivedAt: date(-1000), observation: { name: '<img src=x onerror=alert(1)> & 原文', observedAt: date(-1000) } };
    for (const locale of ['en', 'zh-TW'] as const) {
      const html = render(createElement(RemoteAppObservation, { status }), locale);
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; 原文');
      expect(html).not.toMatch(/<img|<a\b|<button|href=|dangerouslySetInnerHTML/);
      expect(html).toContain(appObservationMessages[locale].remoteTitle);
      expect(html).toContain(appObservationMessages[locale].recent);
      expect(html).toContain(appObservationMessages[locale].observedLabel);
      expect(html).toContain(appObservationMessages[locale].receivedLabel);
      for (const [observedAt, receivedAt] of [[date(-120000), date(-1000)], [date(-1000), date(-120000)], [date(30001), date(-1000)], [date(-1000), date(30001)], ['invalid', date(-1000)], [date(-1000), 'invalid']]) {
        const stale = render(createElement(RemoteAppObservation, { status: { ...status, receivedAt, observation: { ...status.observation!, observedAt } } }), locale);
        expect(stale).toContain(appObservationMessages[locale].stale);
        expect(stale).not.toContain(appObservationMessages[locale].recent);
      }
      const boundary = render(createElement(RemoteAppObservation, { status: { ...status, receivedAt: date(30000), observation: { name: 'HelpTool', observedAt: date(-119999) } } }), locale);
      expect(boundary).toContain(appObservationMessages[locale].recent);
    }
  });
  it('never displays a name for a missing, withdrawn or unavailable report', () => {
    const base: RemoteObservation = { protocol: 1, sequence: 2, deviceId: localId, receivedAt: '2026-10-24T10:00:00.000Z', observation: null };
    for (const locale of ['en', 'zh-TW'] as const) {
      for (const [status, key] of [[undefined, 'remoteMissing'], [base, 'remoteWithdrawn'], [{ ...base, observation: { name: null, observedAt: base.receivedAt } }, 'remoteUnavailable']] as const) {
        const html = render(createElement(RemoteAppObservation, { status }), locale);
        expect(html).toContain(appObservationMessages[locale][key]);
        expect(html).not.toContain(appObservationMessages[locale].nameLabel);
        expect(html).not.toContain(appObservationMessages[locale].recent);
      }
    }
  });
});

describe('independent settings and remote panel integration', () => {
  it('keeps application consent off when legacy activity is enabled and confines missing migration to this feature', () => {
    resources.observation = { ...state, capability: 'unsupported', problem: 'upgrade-required' };
    const deviceController = { state: devices, loading: false, error: '', reload: async () => {}, update: (operation: () => Promise<DeviceState>) => operation() };
    const html = render(createElement(DeviceSettings, { devices: deviceController, governance, projects: [], onDirtyChange: noop, onBusyChange: noop }));
    expect(html).toContain('app-observation-settings');
    expect(html.split('app-observation-settings')[1].split('</section>')[0]).not.toContain('checked=""');
    expect(html.split('status-sharing-settings')[1].split('</section>')[0]).toContain('checked=""');
    expect(html).toContain('SQL migration');
    expect(html).not.toContain(governanceMessages.en.unavailable);
    expect(button(html, governanceMessages.en.assignMember)).not.toContain('disabled=');
    expect(resources.scopes).toContain(profileId);
  });
  it('shows missing, application-only and HelpTool-only reports independently, including on an ineligible source', () => {
    const at = '2026-10-24T10:00:00.000Z'; vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at));
    const remoteId = '22222222-2222-4222-8222-222222222222';
    const device: DeviceRecord = { id: remoteId, name: 'Remote device', lastSeenAt: at, revokedAt: null };
    const remoteState = { ...devices, desktopAvailable: false, devices: [device] };
    const content = (statuses: RemoteDeviceStatus[] = [], current = remoteState, target = device) => createElement(RemoteProjectsPanel, { device: target, state: current, governance: { ...governance, state: { ...governance.state!, statuses } }, onCompose: noop });
    resources.observation = { ...state, collectorAvailable: false, policy: { enabled: false } };
    const missing = render(content());
    expect(missing).toContain(appObservationMessages.en.remoteMissing);
    expect(missing).toContain(governanceMessages.en.remoteMissing);
    resources.observation = { ...resources.observation, statuses: [{ protocol: 1, sequence: 1, deviceId: remoteId, receivedAt: at, observation: { name: 'Peer App Only', observedAt: at } }] };
    const appOnly = render(content());
    expect(appOnly).toContain('Peer App Only'); expect(appOnly).toContain(governanceMessages.en.remoteMissing);
    const hub: RemoteDeviceStatus = { deviceId: remoteId, version: 1, receivedAt: at, activity: { mode: 'foreground', sync: 'online', lastSyncAt: at, operations: [] }, projects: [] };
    resources.observation = { ...state, statuses: [] };
    const hubOnly = render(content([hub]));
    expect(hubOnly).toContain('Last reported HelpTool status');
    expect(hubOnly).toContain(governanceMessages.en.foreground);
    expect(hubOnly).toContain(appObservationMessages.en.remoteMissing);
    resources.observation = { ...state, profileId: 'other-profile', statuses: [{ protocol: 1, sequence: 1, deviceId: remoteId, receivedAt: at, observation: { name: 'WRONG-GROUP-NAME', observedAt: at } }] };
    expect(render(content())).not.toContain('WRONG-GROUP-NAME');
    resources.observation = { ...resources.observation, profileId, statuses: [{ ...resources.observation.statuses[0], observation: { name: 'REVOKED-NAME', observedAt: at } }] };
    expect(render(content([], remoteState, { ...device, revokedAt: at }))).not.toContain('REVOKED-NAME');
    expect(resources.scopes.every(scope => scope === profileId)).toBe(true);
  });
});

describe('independent application observation API', () => {
  it('scopes every request explicitly and separates a pure preview from confirmed saving and refresh', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url === '/api/workspace' ? { csrfToken: 'local-csrf' } : {} };
    }));
    await api.workspace();
    await appObservationApi.state('group-a');
    await appObservationApi.state(null);
    await appObservationApi.previewSharing('group-b', { enabled: true });
    await appObservationApi.saveSharing('group-b', { enabled: true }, 'preview-digest');
    await appObservationApi.refresh('group-b');
    expect(calls.map(call => call.url)).toEqual(['/api/workspace', '/api/app-observation', '/api/app-observation', '/api/app-observation/sharing/preview', '/api/app-observation/sharing', '/api/app-observation/refresh']);
    expect(calls.slice(1).map(call => call.options.method)).toEqual(['GET', 'GET', 'POST', 'POST', 'POST']);
    expect(calls[1].options.body).toBeUndefined();
    expect(calls[2].options.body).toBeUndefined();
    expect((calls[1].options.headers as Record<string, string>)[PROFILE_HEADER]).toBe('group-a');
    expect(calls[2].options.headers).not.toHaveProperty(PROFILE_HEADER);
    expect(calls.slice(3).every(call => (call.options.headers as Record<string, string>)[PROFILE_HEADER] === 'group-b')).toBe(true);
    expect(JSON.parse(calls[3].options.body as string)).toEqual({ policy: { enabled: true } });
    expect(JSON.parse(calls[4].options.body as string)).toEqual({ policy: { enabled: true }, digest: 'preview-digest', confirm: true });
    expect(JSON.parse(calls[5].options.body as string)).toEqual({ confirm: true });
    expect(calls.every(call => call.options.credentials === 'same-origin' && call.options.cache === 'no-store')).toBe(true);
    expect(calls.slice(1).every(call => (call.options.headers as Record<string, string>)['X-Hub-Token'] === 'local-csrf')).toBe(true);
  });
});
