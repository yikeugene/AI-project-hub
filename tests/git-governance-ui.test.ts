import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROFILE_HEADER, type DeviceState } from '../shared/devices';
import type { GitApproval, GitRequestView, GitReviewSummary, LocalGitState } from '../shared/git';
import type { GovernanceState, RemoteDeviceStatus } from '../shared/governance';
import { EMPTY_MEMORY, type Project } from '../shared/types';
import { api, gitApi, governanceApi } from '../src/api';
import { GitReview, GitStateBadge } from '../src/components/GitReview';
import { RemoteDeviceActivity, RemoteProjectStatus, StatusReceipt } from '../src/components/RemoteStatus';
import { approvalDisplayState, canonicalSharing, gitDiagnosticKey, gitOperationStateKey, gitWriteBlockReason, hasCurrentGovernance, isStaged, isStatusFresh, isUnstaged, requestDisplayState } from '../src/git-ui';
import type { GovernanceController } from '../src/hooks';
import { I18nProvider } from '../src/i18n';
import { GitApprovalPanel } from '../src/panels/GitApprovalPanel';
import { GitPanel } from '../src/panels/GitPanel';
import { GitRequests } from '../src/panels/GitRequests';
import { GovernanceSettings } from '../src/panels/GovernanceSettings';
import { gitMessages } from '../src/locales/panels-git';
import { governanceMessages } from '../src/locales/panels-governance';

const resource = vi.hoisted(() => ({ data: [] as unknown[], loading: false, error: '', reload: vi.fn(async () => {}) }));
vi.mock('../src/hooks', async importOriginal => ({ ...await importOriginal<typeof import('../src/hooks')>(), useDeviceResource: () => resource }));
const localId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const networkId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const profileId = '66666666-6666-4666-8666-666666666666';
const now = Date.parse('2026-10-20T11:00:00.000Z');
const createdAt = new Date(now - 60_000).toISOString();
const expiresAt = new Date(now + 60_000).toISOString();
const digest = 'a'.repeat(64);
const summary: GitReviewSummary = {
  projectName: 'Project <script>unsafe</script>', kind: 'commit', paths: ['src/保留\n<script>.ts', 'file:(literal).txt'],
  branch: 'main', head: 'b'.repeat(40), target: null, remoteUrl: null, targetRef: 'refs/heads/main',
  changedCount: 2, stagedCount: 2, message: 'Keep <b>literal</b>\nCommit 原文', authorName: 'Author <one>', authorEmail: 'test@example.invalid',
};
const approval: GitApproval = { id: requestId, reviewerDeviceId: localId, fromDeviceId: localId, digest, summary, expiresAt, createdAt, state: 'pending', decidedAt: null, reason: null, approvedBy: null, approvedEpoch: null, executionId: null, consumedAt: null, result: null };
const request: GitRequestView = { preview: { id: requestId, projectId, operation: { kind: 'commit', message: summary.message!, authorName: summary.authorName!, authorEmail: summary.authorEmail! }, summary, digest, createdAt, expiresAt }, state: 'approved', approval: { ...approval, state: 'approved', approvedBy: localId }, result: null, error: null, fenceAcknowledged: false, updatedAt: createdAt };
const devices: DeviceState = {
  installationId: '77777777-7777-4777-8777-777777777777', profileId, groups: [{ id: profileId, label: 'Test group', url: 'https://test.supabase.co', networkId, deviceId: localId, enabled: true, paired: true, pairingPending: false, connection: 'online', lastSyncAt: createdAt, lastError: null }],
  localDevice: { id: localId, name: 'Same name' }, desktopAvailable: true, enabled: true, paired: true, pairingPending: false, connection: 'online', configuration: null,
  networkId, devices: [{ id: otherId, name: 'Same name', lastSeenAt: createdAt, revokedAt: null }], sharing: [], lastSyncAt: createdAt, lastError: null, queuedCount: 0, inboxCount: 0,
};
const state: GovernanceState = { available: true, policy: { protocol: 2, networkId, deviceId: localId, role: 'admin', epoch: 2, roles: [{ deviceId: localId, role: 'admin' }, { deviceId: otherId, role: 'member' }] }, error: null, sharing: { activity: false, projects: [] }, statuses: [] };
const governance: GovernanceController = { state, error: '', loading: false, reload: async () => {}, update: operation => operation() };
const project: Project = { id: projectId, name: 'Project', path: 'C:\\private-project', description: '', category: '', status: 'active', priority: 'normal', stage: '', nextAction: '', createdAt, updatedAt: createdAt, revision: 1, memory: { ...EMPTY_MEMORY }, memoryUpdatedAt: null, checkpointAt: null, git: null, gitError: null, lastCheckedAt: null };
const noop = () => {}; const noopAsync = async () => {};
const render = (content: ReactNode, locale: 'en' | 'zh-TW' = 'en') => renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: content }));
const button = (html: string, label: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(text => text.includes(label));
beforeEach(() => { resource.data = []; resource.loading = false; resource.error = ''; vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Git approval frontend boundaries', () => {
  it('keeps every lifecycle label distinct in both languages, including approved versus succeeded', () => {
    const states: Array<LocalGitState | 'consumed'> = ['prepared', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'stale', 'consuming', 'consumed', 'executing', 'succeeded', 'failed', 'partial', 'unknown'];
    for (const locale of ['en', 'zh-TW'] as const) {
      expect(new Set(states.map(key => gitMessages[locale][key])).size).toBe(states.length);
      for (const status of states) expect(render(createElement(GitStateBadge, { state: status }), locale)).toContain(gitMessages[locale][status]);
    }
    expect(approvalDisplayState({ ...approval, state: 'approved' }, now)).toBe('approved');
    expect(approvalDisplayState({ ...approval, expiresAt: createdAt }, now)).toBe('expired');
    expect(approvalDisplayState({ ...approval, state: 'consumed', expiresAt: createdAt }, now)).toBe('consumed');
    expect(approvalDisplayState({ ...approval, state: 'consumed', result: { status: 'unknown', code: 'uncertain', head: null } }, now)).toBe('unknown');
    expect(requestDisplayState('approved', createdAt, now)).toBe('expired');
    expect(requestDisplayState('executing', createdAt, now)).toBe('executing');
    expect(requestDisplayState('unknown', createdAt, now)).toBe('unknown');
  });
  it('requires matching backend network and device policy; a name never grants a role', () => {
    expect(hasCurrentGovernance(state, devices)).toBe(true);
    expect(hasCurrentGovernance({ ...state, available: false }, devices)).toBe(false);
    expect(hasCurrentGovernance({ ...state, error: 'Upgrade required' }, devices)).toBe(false);
    expect(hasCurrentGovernance({ ...state, policy: { ...state.policy!, networkId: otherId } }, devices)).toBe(false);
    expect(hasCurrentGovernance({ ...state, policy: { ...state.policy!, deviceId: otherId } }, devices)).toBe(false);
    expect(hasCurrentGovernance(state, { ...devices, paired: false })).toBe(false);
    expect(hasCurrentGovernance(null, devices)).toBe(false);
  });
  it('explains actual write prerequisites without changing authorization', () => {
    expect(gitWriteBlockReason(null, state, false, false)).toBe('writeChecking');
    expect(gitWriteBlockReason({ ...devices, desktopAvailable: false }, state, false, false)).toBe('writeDesktop');
    expect(gitWriteBlockReason({ ...devices, paired: false }, state, false, false)).toBe('writePairing');
    expect(gitWriteBlockReason({ ...devices, profileId: null }, state, false, false)).toBe('writePairing');
    expect(gitWriteBlockReason({ ...devices, enabled: false }, state, false, false)).toBe('writePaused');
    expect(gitWriteBlockReason({ ...devices, connection: 'error' }, state, false, false)).toBe('writeOffline');
    expect(gitWriteBlockReason({ ...devices, connection: 'revoked' }, state, false, false)).toBe('writeRevoked');
    expect(gitWriteBlockReason({ ...devices, connection: 'locked' }, state, false, false)).toBe('writeCredentials');
    expect(gitWriteBlockReason(devices, state, true, false)).toBe('writeChecking');
    expect(gitWriteBlockReason(devices, state, false, true)).toBe('writeGovernance');
    expect(gitWriteBlockReason(devices, { ...state, available: false }, false, false)).toBe('writeGovernance');
    expect(gitWriteBlockReason(devices, { ...state, policy: { ...state.policy!, roles: [] } }, false, false)).toBe('noReviewer');
    expect(gitWriteBlockReason(devices, state, false, false)).toBeNull();
    for (const locale of ['en', 'zh-TW'] as const) {
      const html = render(createElement(GitPanel, { project, devices: { ...devices, paired: false }, governance, active: true, onChange: noopAsync, onDirtyChange: noop, onBusyChange: noop }), locale);
      expect(html).toContain(gitMessages[locale].writePairing); expect(html).toContain(gitMessages[locale].writeRequirements);
    }
  });
  it('separates staged and unstaged paths without splitting or interpreting unusual file names', () => {
    const path = ':!x\n中文 file.txt';
    expect(isStaged({ path, index: 'M', worktree: 'M' })).toBe(true);
    expect(isUnstaged({ path, index: 'M', worktree: 'M' })).toBe(true);
    expect(isStaged({ path, index: '?', worktree: '?' })).toBe(false);
    expect(isUnstaged({ path, index: '?', worktree: '?' })).toBe(true);
    expect(isStaged({ path, index: 'U', worktree: 'U' })).toBe(false);
    expect(isUnstaged({ path, index: 'U', worktree: 'U' })).toBe(true);
    expect(isUnstaged({ path, index: 'R', worktree: ' ' })).toBe(false);
  });
  it('renders only exact review metadata as text, never extra private-plan or diff properties', () => {
    const extended = { ...summary, privatePath: 'C:\\secret', diff: 'SOURCE-CONTENT-NEVER-SENT', shell: 'injected command' };
    for (const locale of ['en', 'zh-TW'] as const) {
      const html = render(createElement(GitReview, { summary: extended, digest, expiresAt }), locale);
      expect(html).toContain('Project &lt;script&gt;unsafe&lt;/script&gt;');
      expect(html).toContain('src/保留\n&lt;script&gt;.ts');
      expect(html).toContain('Keep &lt;b&gt;literal&lt;/b&gt;');
      expect(html).toContain('Author &lt;one&gt;');
      expect(html).toContain(digest);
      expect(html).toContain(summary.head!);
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('C:\\secret');
      expect(html).not.toContain('SOURCE-CONTENT-NEVER-SENT');
      expect(html).not.toContain('injected command');
    }
  });
  it('shows self-approval as an independent decision, never an execution control', () => {
    resource.data = [approval];
    for (const locale of ['en', 'zh-TW'] as const) {
      const html = render(createElement(GitApprovalPanel, { devices, governance, onDirtyChange: noop, onBusyChange: noop }), locale);
      expect(html).toContain(gitMessages[locale].selfApproval);
      expect(button(html, gitMessages[locale].approve)).not.toContain('disabled=');
      expect(button(html, gitMessages[locale].reject)).not.toContain('disabled=');
      expect(button(html, gitMessages[locale].execute)).toBeUndefined();
      expect(html).toContain(localId);
    }
  });
  it('disables approval for another reviewer, member, expired record, read error or unavailable desktop', () => {
    const variants = [
      { record: { ...approval, reviewerDeviceId: otherId }, device: devices, controller: governance },
      { record: approval, device: devices, controller: { ...governance, state: { ...state, policy: { ...state.policy!, role: 'member' as const } } } },
      { record: { ...approval, expiresAt: createdAt }, device: devices, controller: governance },
      { record: approval, device: { ...devices, desktopAvailable: false }, controller: governance },
    ];
    for (const { record, device, controller } of variants) {
      resource.data = [record];
      const html = render(createElement(GitApprovalPanel, { devices: device, governance: controller, onDirtyChange: noop, onBusyChange: noop }));
      expect(button(html, gitMessages.en.approve)).toContain('disabled=""');
    }
    resource.data = [approval]; resource.error = 'Connection lost';
    const html = render(createElement(GitApprovalPanel, { devices, governance, onDirtyChange: noop, onBusyChange: noop }));
    expect(button(html, gitMessages.en.approve)).toContain('disabled=""');
  });
  it('exposes execution only for approved local requests and never offers retry for unknown results', () => {
    const props = { projectId, profileId, canManage: true, canExecute: true, canRecover: true, blocked: false, version: 0, onBusyChange: noop, onExecuted: noopAsync };
    resource.data = [request];
    expect(button(render(createElement(GitRequests, props)), gitMessages.en.execute)).not.toContain('disabled=');
    expect(button(render(createElement(GitRequests, { ...props, canExecute: false })), gitMessages.en.execute)).toContain('disabled=""');
    for (const status of ['pending', 'succeeded', 'failed', 'partial', 'unknown', 'stale', 'expired', 'consuming', 'executing'] as const) {
      resource.data = [{ ...request, state: status }];
      const html = render(createElement(GitRequests, props));
      expect(button(html, gitMessages.en.execute)).toBeUndefined();
      if (status === 'unknown') {
        expect(html).toContain(gitMessages.en.unknownWarning);
        expect(button(html, gitMessages.en.inspectUnknown)).toBeDefined();
      }
    }
    resource.data = [{ ...request, state: 'unknown', fenceAcknowledged: true }];
    const html = render(createElement(GitRequests, props));
    expect(html).toContain(gitMessages.en.unknown);
    expect(html).toContain(gitMessages.en.acknowledged);
    expect(button(html, gitMessages.en.inspectUnknown)).toBeUndefined();
    expect(button(html, gitMessages.en.execute)).toBeUndefined();
  });
  it.each(['unknown', 'partial'] as const)('allows desktop-local %s recovery without online management or membership', status => {
    const props = { projectId, canManage: false, canExecute: false, canRecover: true, blocked: false, version: 0, onBusyChange: noop, onExecuted: noopAsync };
    resource.data = [{ ...request, state: status, preview: { ...request.preview, expiresAt: createdAt } }];
    for (const scope of [null, profileId]) for (const locale of ['en', 'zh-TW'] as const) {
      const html = render(createElement(GitRequests, { ...props, profileId: scope }), locale);
      const recovery = button(html, gitMessages[locale].inspectUnknown);
      expect(recovery).toBeDefined(); expect(recovery).not.toContain('disabled=');
      expect(html).toContain(gitMessages[locale][status === 'unknown' ? 'unknownWarning' : 'partialWarning']);
      expect(button(html, gitMessages[locale].execute)).toBeUndefined();
      expect(button(html, gitMessages[locale].cancel)).toBeUndefined();
    }
    resource.data = [{ ...request, state: status, fenceAcknowledged: true }];
    const acknowledged = render(createElement(GitRequests, { ...props, profileId: null }));
    expect(acknowledged).toContain(gitMessages.en[status]);
    expect(acknowledged).toContain(gitMessages.en.acknowledged);
    expect(button(acknowledged, gitMessages.en.inspectUnknown)).toBeUndefined();
    expect(button(acknowledged, gitMessages.en.execute)).toBeUndefined();
  });
  it.each(['unknown', 'partial'] as const)('keeps %s recovery disabled without desktop capability, during work or after a read error', status => {
    const props = { projectId, profileId: null, canManage: false, canExecute: false, canRecover: true, blocked: false, version: 0, onBusyChange: noop, onExecuted: noopAsync };
    resource.data = [{ ...request, state: status }];
    for (const override of [{ canRecover: false }, { canRecover: false, canManage: true, canExecute: true }, { blocked: true }]) {
      const html = render(createElement(GitRequests, { ...props, ...override }));
      expect(button(html, gitMessages.en.inspectUnknown)).toContain('disabled=""');
    }
    resource.error = 'Recovery journal read failed';
    expect(button(render(createElement(GitRequests, props)), gitMessages.en.inspectUnknown)).toContain('disabled=""');
    resource.error = ''; resource.loading = true;
    expect(button(render(createElement(GitRequests, props)), gitMessages.en.inspectUnknown)).toBeUndefined();
  });
  it('never substitutes local recovery capability for execution or cancellation authority', () => {
    const props = { projectId, profileId, canManage: false, canExecute: true, canRecover: true, blocked: false, version: 0, onBusyChange: noop, onExecuted: noopAsync };
    for (const status of ['prepared', 'pending', 'approved'] as const) {
      resource.data = [{ ...request, state: status }];
      const html = render(createElement(GitRequests, props));
      expect(button(html, gitMessages.en.cancel)).toContain('disabled=""');
      if (status === 'approved') expect(button(html, gitMessages.en.execute)).toContain('disabled=""');
      expect(button(html, gitMessages.en.inspectUnknown)).toBeUndefined();
    }
    for (const status of ['succeeded', 'failed', 'cancelled', 'rejected', 'stale', 'expired', 'consuming', 'executing'] as const) {
      resource.data = [{ ...request, state: status }];
      expect(button(render(createElement(GitRequests, props)), gitMessages.en.inspectUnknown)).toBeUndefined();
    }
  });
  it('does not display a cached project Git snapshot as a fresh read before details load', () => {
    const cached = { ...project, git: { isRepo: true, branch: 'OLD-CACHED-BRANCH', head: null, branches: [], commits: [], changes: [], changedCount: 0, untrackedCount: 0, stagedCount: 0, conflictCount: 0, lastCommitAt: null, observedAt: createdAt } };
    const html = render(createElement(GitPanel, { project: cached, devices, governance, active: true, onChange: noopAsync, onDirtyChange: noop, onBusyChange: noop }));
    expect(html).toContain(gitMessages.en.loading);
    expect(html).not.toContain('OLD-CACHED-BRANCH');
  });
  it('maps fixed diagnostic codes without exposing unknown diagnostic text', () => {
    expect(gitDiagnosticKey('customHelpers')).toBe('reasonCustomHelpers');
    expect(gitDiagnosticKey('C:\\private stderr / token')).toBe('reasonUnsupported');
    expect(gitOperationStateKey('rebase-merge')).toBe('stateRebase');
    expect(gitOperationStateKey('private value')).toBe('stateOther');
  });
});

describe('optional status UI consent and freshness', () => {
  it('defaults new fields off and requires base project sharing before enabling project fields', () => {
    const html = render(createElement(GovernanceSettings, { governance, devices, projects: [project], blocked: false, onDirtyChange: noop, onBusyChange: noop, onChange: noopAsync }));
    expect(html).not.toContain('checked=""');
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toContain(governanceMessages.en.baseShareRequired);
    expect(html).toContain(governanceMessages.en.privacy);
    expect(html).not.toContain(project.path);
  });
  it.each(['paused', 'oversized'] as const)('keeps local consent editable when %s without enabling administrator actions', condition => {
    const local: DeviceState = { ...devices, enabled: condition !== 'paused', connection: condition === 'paused' ? 'disabled' : 'online',
      sharing: [{ projectId, enabled: true, memoryFields: [] }] };
    const unavailable: GovernanceController = { ...governance, state: { ...state, available: false,
      error: condition === 'oversized' ? 'Status exceeds 8 KiB' : null,
      sharing: { activity: true, projects: [{ projectId, git: true, tasks: true }] } } };
    const html = render(createElement(GovernanceSettings, { governance: unavailable, devices: local, projects: [project], blocked: false, onDirtyChange: noop, onBusyChange: noop, onChange: noopAsync }));
    const sharing = html.split('status-sharing-settings')[1].split('</section>')[0];
    expect(sharing).toContain('checked=""'); expect(sharing).not.toContain('disabled=""');
    expect(button(html, governanceMessages.en.assignAdmin)).toBeUndefined();
  });
  it('does not reuse local consent controls from a different network identity', () => {
    const wrongScope: GovernanceController = { ...governance, state: { ...state, policy: { ...state.policy!, networkId: otherId } } };
    const html = render(createElement(GovernanceSettings, { governance: wrongScope, devices: { ...devices, sharing: [{ projectId, enabled: true, memoryFields: [] }] }, projects: [project], blocked: false, onDirtyChange: noop, onBusyChange: noop, onChange: noopAsync }));
    expect(html.split('status-sharing-settings')[1].split('</section>')[0]).toContain('disabled=""');
  });
  it('normalizes consent by selected fields and identities, not transient publication timestamps', () => {
    const first = { activity: false, projects: [{ projectId: otherId, git: false, tasks: false }, { projectId, git: true, tasks: false }] };
    const second = { activity: false, projects: [{ projectId, tasks: false, git: true }] };
    expect(canonicalSharing(first)).toBe(canonicalSharing(second));
    expect(canonicalSharing({ ...second, activity: true })).not.toBe(canonicalSharing(second));
    expect(canonicalSharing({ ...second, projects: [{ projectId: otherId, tasks: false, git: true }] })).not.toBe(canonicalSharing(second));
  });
  it('labels cached remote data by relay receipt and separates task counts from recent app event history', () => {
    const status: RemoteDeviceStatus = { version: 1, deviceId: otherId, receivedAt: new Date(now - 300_000).toISOString(), activity: { mode: 'background', sync: 'online', lastSyncAt: createdAt, operations: [{ kind: 'git', state: 'running', at: createdAt }] }, projects: [{ projectId, name: 'Remote only', git: { branch: 'main', changedCount: 2, stagedCount: 1, conflictCount: 0, observedAt: new Date(now - 86_400_000).toISOString(), unavailable: false }, tasks: { todo: 1, doing: 5, blocked: 2, done: 3 } }] };
    for (const locale of ['en', 'zh-TW'] as const) {
      const html = render(createElement(RemoteDeviceActivity, { status }), locale);
      expect(html).toContain(governanceMessages[locale].stale);
      expect(html).toContain(governanceMessages[locale].background);
      expect(html).toContain(governanceMessages[locale].operationsHint);
      const projectHtml = render(createElement(RemoteProjectStatus, { project: status.projects[0], receivedAt: status.receivedAt }), locale);
      expect(projectHtml).toContain(governanceMessages[locale].tasksTitle);
      expect(projectHtml).toContain(governanceMessages[locale].tasksHint);
      expect(projectHtml).toContain(governanceMessages[locale].gitOutdated);
      expect(projectHtml).toContain(governanceMessages[locale].doing);
    }
  });
  it('does not call missing, failed, old or future-dated observations live or zero', () => {
    expect(isStatusFresh(createdAt, now)).toBe(true);
    expect(isStatusFresh(new Date(now - 120_000).toISOString(), now)).toBe(false);
    expect(isStatusFresh('invalid', now)).toBe(false);
    expect(isStatusFresh(new Date(now + 300_000).toISOString(), now)).toBe(false);
    const recent = render(createElement(StatusReceipt, { receivedAt: createdAt }));
    expect(recent).toContain(governanceMessages.en.recent);
    const missing = render(createElement(RemoteProjectStatus, { project: undefined, receivedAt: undefined }));
    expect(missing).toContain(governanceMessages.en.tasksNotShared);
    expect(missing).toContain(governanceMessages.en.gitNotShared);
    expect(missing).not.toContain('<dd>0</dd>');
    const unavailable = render(createElement(RemoteProjectStatus, { project: { projectId, name: 'Remote', git: { branch: null, changedCount: 0, stagedCount: 0, conflictCount: 0, observedAt: null, unavailable: true }, tasks: null }, receivedAt: createdAt }));
    expect(unavailable).toContain(governanceMessages.en.gitUnavailable);
    expect(unavailable).not.toContain('<dd>0</dd>');
  });
});

describe('typed same-origin Git and governance APIs', () => {
  it('sends immutable IDs and digests with separate explicit mutation confirmations', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url === '/api/workspace' ? { csrfToken: 'local-csrf' } : {} };
    }));
    await api.workspace();
    await gitApi.details('project/id');
    await gitApi.diff('project/id', { path: ':!file\n中文.ts', source: 'index' });
    await gitApi.preview(profileId, projectId, { kind: 'stage', paths: [':!file\n中文.ts'] });
    await gitApi.submit(profileId, requestId, otherId, digest);
    await gitApi.execute(profileId, 'request/id', digest);
    await gitApi.cancel(profileId, requestId, digest);
    await gitApi.acknowledge(profileId, requestId);
    await gitApi.audit(profileId, 'request/id');
    await gitApi.decide(profileId, 'approval/id', digest, 'approved', 'Exact request only');
    await gitApi.requests(profileId, projectId);
    await gitApi.approvals(profileId);
    const bodies = calls.map(call => call.options.body ? JSON.parse(call.options.body as string) : undefined);
    expect(calls[1].url).toBe('/api/projects/project%2Fid/git/details');
    expect(bodies[2]).toEqual({ path: ':!file\n中文.ts', source: 'index' });
    expect(bodies[3]).toEqual({ operation: { kind: 'stage', paths: [':!file\n中文.ts'] } });
    expect(bodies[4]).toEqual({ previewId: requestId, reviewerDeviceId: otherId, digest, confirm: true });
    expect(calls[5].url).toBe('/api/git/requests/request%2Fid/execute');
    expect(bodies[5]).toEqual({ digest, confirm: true });
    expect(bodies[6]).toEqual({ digest, confirm: true });
    expect(bodies[7]).toEqual({ confirm: true });
    expect(calls[8].url).toBe('/api/git/requests/request%2Fid/audit');
    expect(calls[9].url).toBe('/api/git/approvals/approval%2Fid/decision');
    expect(bodies[9]).toEqual({ digest, decision: 'approved', reason: 'Exact request only', confirm: true });
    expect(calls.slice(1).every(call => (call.options.headers as Record<string, string>)['X-Hub-Token'] === 'local-csrf')).toBe(true);
    expect(calls.slice(1, 3).every(call => !(PROFILE_HEADER in (call.options.headers as Record<string, string>)))).toBe(true);
    expect(calls.slice(3).every(call => (call.options.headers as Record<string, string>)[PROFILE_HEADER] === profileId)).toBe(true);
    expect(calls.every(call => call.options.credentials === 'same-origin' && call.options.cache === 'no-store')).toBe(true);
    // No API method accepts a shell, argv, repository path or mutable operation on execute.
    expect(bodies[5]).not.toHaveProperty('operation');
    expect(bodies[5]).not.toHaveProperty('path');
  });
  it('binds status sharing to preview policy/digest and confirms role changes independently', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; }));
    const policy = { activity: true, projects: [{ projectId, git: true, tasks: false }] };
    await governanceApi.state(profileId); await governanceApi.refresh(profileId); await governanceApi.role(profileId, 'device/id', 'admin');
    await governanceApi.previewSharing(profileId, policy); await governanceApi.saveSharing(profileId, policy, digest);
    expect(calls.map(call => call.url)).toEqual(['/api/governance', '/api/governance/refresh', '/api/governance/roles/device%2Fid', '/api/governance/sharing/preview', '/api/governance/sharing']);
    expect(JSON.parse(calls[1].options.body as string)).toEqual({ confirm: true });
    expect(JSON.parse(calls[2].options.body as string)).toEqual({ role: 'admin', confirm: true });
    expect(JSON.parse(calls[3].options.body as string)).toEqual({ policy });
    expect(JSON.parse(calls[4].options.body as string)).toEqual({ policy, digest, confirm: true });
    expect(JSON.parse(calls[4].options.body as string)).not.toHaveProperty('publication');
    expect(calls.every(call => (call.options.headers as Record<string, string>)[PROFILE_HEADER] === profileId)).toBe(true);
  });
  it('makes nullable recovery reads explicit and never borrows the last requested profile', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; }));
    await governanceApi.state(profileId);
    await governanceApi.state(null); await gitApi.requests(null, projectId); await gitApi.approvals(null);
    await gitApi.audit(null, requestId); await gitApi.acknowledge(null, requestId);
    expect((calls[0].options.headers as Record<string, string>)[PROFILE_HEADER]).toBe(profileId);
    expect(calls.slice(1).every(call => !(PROFILE_HEADER in (call.options.headers as Record<string, string>)))).toBe(true);
    await gitApi.requests(otherId, projectId);
    expect((calls.at(-1)!.options.headers as Record<string, string>)[PROFILE_HEADER]).toBe(otherId);
  });
});
