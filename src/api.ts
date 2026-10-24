import type { Workspace, WorkspaceFocus, Project, Task, Settings, ScanResult, HandoffPreview, SharedStatePreview, ProjectMemory, LaunchAction, TaskStatus, Priority, ProjectStatus, HandoffTarget, DesktopApp } from '../shared/types';
import { PROFILE_HEADER } from '../shared/devices';
import type { ApplyProposalInput, CachedSnapshot, ComposeMessageInput, DeviceState, GroupShareInput, GroupSharingPreview, Invitation, MessageView, PairInput, ProposalPreview, SharedPreview, SharePolicy, SharedWorkspaceItem, SharedWorkspaceState, SummaryDownload } from '../shared/devices';
import type { GitApproval, GitAuditEvent, GitDetails, GitDiff, GitDiffInput, GitOperation, GitPreview, GitRequestView } from '../shared/git';
import type { DeviceRole, GovernanceState, StatusSharingPolicy, StatusSharingPreview } from '../shared/governance';
import type { MarkdownImportApplyInput, MarkdownImportPreview } from '../shared/markdown-import';
import type { AppObservationPolicy, AppObservationPreview, AppObservationState } from '../shared/app-observation';

import { DEFAULT_LOCALE, LocalizedError, translate, type Locale, type MessageParams } from '../shared/i18n';
import { isErrorCode, translateError } from '../shared/messages';
import { clientMessages } from './locales/client';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public params: MessageParams = {}) { super(message); this.name = 'ApiError'; }
}
let token = '';
async function request<T>(path: string, method = 'GET', body?: unknown, profileId?: string | null): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Hub-Token': token } : {}), ...(profileId ? { [PROFILE_HEADER]: profileId } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new ApiError(clientMessages.en.connection, 0, 'client.connection'); }
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiError(clientMessages.en.response, response.status, 'client.response'); }
  if (!response.ok) {
    const details = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const message = typeof details.error === 'string' ? details.error : translate(clientMessages, DEFAULT_LOCALE, 'request', { status: response.status });
    const code = typeof details.code === 'string' ? details.code : typeof details.error === 'string' ? undefined : 'client.request';
    const params = details.params && typeof details.params === 'object'
      ? Object.fromEntries(Object.entries(details.params).filter(([, value]) => typeof value === 'string' || typeof value === 'number')) as MessageParams
      : { status: response.status };
    throw new ApiError(message, response.status, code, params);
  }
  return data as T;
}
export interface ProjectInput { path: string; name: string; description: string; category: string; status: ProjectStatus; priority: Priority; stage: string; nextAction: string }
export interface TaskInput { title: string; detail: string; status: TaskStatus; priority: Priority }
export interface WrapUpInput { revision: number; status: string; blockers: string; nextAction: string }
export type HandoffAgent = HandoffTarget;
const projectUrl = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const api = {
  workspace: async () => { const result = await request<Workspace>('/workspace'); token = result.csrfToken; return result; },
  saveFocus: (revision: number, projectIds: string[]) => request<WorkspaceFocus>('/workspace/focus', 'PUT', { revision, projectIds }),
  wrapUpProject: (id: string, input: WrapUpInput) => request<Project>(`${projectUrl(id)}/wrap-up`, 'POST', input),
  createProject: (input: ProjectInput) => { const { name, ...rest } = input; return request<Project>('/projects', 'POST', { ...rest, ...(name.trim() ? { name: name.trim() } : {}) }); },
  updateProject: (id: string, revision: number, input: Omit<ProjectInput, 'path'>) => request<Project>(projectUrl(id), 'PATCH', { ...input, revision }),
  removeProject: (project: Project) => request<{ ok: true }>(projectUrl(project.id), 'DELETE', { revision: project.revision, confirm: true }),
  scan: (path: string, depth: number) => request<ScanResult>('/scan', 'POST', { path, depth }),
  importProjects: (paths: string[]) => request<{ added: number; skipped: number; errors: string[] }>('/scan/import', 'POST', { paths }),
  refresh: () => request<{ refreshed: number }>('/refresh', 'POST', {}),
  refreshProject: (id: string) => request<Project>(`${projectUrl(id)}/refresh`, 'POST', {}),
  saveMemory: (id: string, revision: number, memory: ProjectMemory) => request<Project>(`${projectUrl(id)}/memory`, 'PUT', { revision, memory }),
  createTask: (id: string, input: TaskInput) => request<Task>(`${projectUrl(id)}/tasks`, 'POST', input),
  updateTask: (task: Task, input: Partial<TaskInput>) => request<Task>(`/tasks/${encodeURIComponent(task.id)}`, 'PATCH', { revision: task.revision, ...input }),
  removeTask: (task: Task) => request<{ ok: true }>(`/tasks/${encodeURIComponent(task.id)}`, 'DELETE', { revision: task.revision }),
  handoff: (id: string, agent: HandoffAgent) => request<HandoffPreview>(`${projectUrl(id)}/handoff?agent=${agent}`),
  exportHandoff: (id: string, agent: HandoffAgent) => request<{ directory: string; files: string[]; stateCreated: boolean }>(`${projectUrl(id)}/handoff/export`, 'POST', { agent, confirm: true }),
  sharedState: (id: string) => request<SharedStatePreview>(`${projectUrl(id)}/shared-state`),
  importSharedState: (id: string, revision: number, hash: string) => request<Project>(`${projectUrl(id)}/shared-state/import`, 'POST', { revision, hash, confirm: true }),
  previewPastedState: (id: string, text: string) => request<SharedStatePreview>(`${projectUrl(id)}/shared-state/paste/preview`, 'POST', { text }),
  importPastedState: (id: string, text: string, hash: string, revision: number) => request<Project>(`${projectUrl(id)}/shared-state/paste/import`, 'POST', { text, hash, revision, confirm: true }),
  openDesktopApp: (app: DesktopApp) => request<{ ok: true }>(`/desktop-apps/${app}/open`, 'POST', {}),
  open: (id: string, action: LaunchAction) => request<{ ok: true }>(`${projectUrl(id)}/open`, 'POST', { action }),
  settings: (settings: Partial<Settings>) => request<Settings>('/settings', 'PATCH', settings),
};
export const markdownApi = {
  preview: (text: string) => request<MarkdownImportPreview>('/markdown-import/preview', 'POST', { text }),
  apply: (input: MarkdownImportApplyInput) => request<Project>('/markdown-import/apply', 'POST', input),
};
const deviceUrl = (id: string) => `/devices/${encodeURIComponent(id)}`;
const messageUrl = (id: string) => `/messages/${encodeURIComponent(id)}`;
export const deviceApi = {
  state: (profileId?: string) => request<DeviceState>('/devices', 'GET', undefined, profileId),
  rename: (name: string) => request<DeviceState>('/devices/local', 'PATCH', { name }),
  pair: (input: PairInput) => request<DeviceState>('/devices/pair', 'POST', input),
  retryPair: (profileId: string) => request<DeviceState>('/devices/pair/retry', 'POST', {}, profileId),
  connection: (profileId: string, enabled: boolean) => request<DeviceState>('/devices/connection', 'POST', { enabled }, profileId),
  disconnect: (profileId: string) => request<DeviceState>('/devices/disconnect', 'POST', { confirm: true }, profileId),
  invitation: (profileId: string) => request<Invitation>('/devices/invitation', 'POST', {}, profileId),
  revoke: (profileId: string, id: string) => request<DeviceState>(`${deviceUrl(id)}/revoke`, 'POST', { confirm: true }, profileId),
  sync: (profileId: string) => request<DeviceState>('/devices/sync', 'POST', {}, profileId),
  selectGroup: (profileId: string) => request<DeviceState>('/devices/groups/select', 'POST', { profileId }),
  labelGroup: (profileId: string, label: string) => request<DeviceState>(`/devices/groups/${encodeURIComponent(profileId)}`, 'PATCH', { label }),
  syncAll: () => request<DeviceState>('/devices/sync-all', 'POST', {}),
  workspace: () => request<SharedWorkspaceState>('/shared-workspace'),
  downloadSummary: (item: Pick<SharedWorkspaceItem, 'profileId' | 'ownerDeviceId' | 'projectId' | 'version'>) => request<SummaryDownload>('/shared-workspace/download', 'POST', { profileId: item.profileId, ownerDeviceId: item.ownerDeviceId, projectId: item.projectId, version: item.version }),
  groupSharing: (projectId: string) => request<GroupSharingPreview>(`/devices/group-sharing/${encodeURIComponent(projectId)}`),
  previewGroupSharing: (projectId: string, policies: GroupShareInput[]) => request<GroupSharingPreview>(`/devices/group-sharing/${encodeURIComponent(projectId)}/preview`, 'POST', { policies }),
  saveGroupSharing: (projectId: string, policies: GroupShareInput[], digest: string) => request<GroupSharingPreview>(`/devices/group-sharing/${encodeURIComponent(projectId)}`, 'PUT', { policies, digest, confirm: true }),
  sharing: (profileId: string, projectId: string) => request<SharedPreview>(`/devices/sharing/${encodeURIComponent(projectId)}`, 'GET', undefined, profileId),
  previewSharing: (profileId: string, projectId: string, input: Pick<SharePolicy, 'enabled' | 'memoryFields'>) => request<SharedPreview>(`/devices/sharing/${encodeURIComponent(projectId)}/preview`, 'POST', input, profileId),
  saveSharing: (profileId: string, projectId: string, input: Pick<SharePolicy, 'enabled' | 'memoryFields'>) => request<SharedPreview>(`/devices/sharing/${encodeURIComponent(projectId)}`, 'PUT', input, profileId),
  projects: (profileId: string, id: string) => request<CachedSnapshot[]>(`${deviceUrl(id)}/projects`, 'GET', undefined, profileId),
  messages: (profileId: string, box: 'inbox' | 'sent') => request<MessageView[]>(`/messages?box=${box}`, 'GET', undefined, profileId),
  send: (profileId: string, input: ComposeMessageInput) => request<MessageView>('/messages', 'POST', input, profileId),
  preview: (profileId: string, id: string) => request<ProposalPreview>(`${messageUrl(id)}/preview`, 'POST', {}, profileId),
  accept: (profileId: string, id: string, input: ApplyProposalInput) => request<MessageView>(`${messageUrl(id)}/accept`, 'POST', input, profileId),
  reject: (profileId: string, id: string) => request<MessageView>(`${messageUrl(id)}/reject`, 'POST', { confirm: true }, profileId),
  read: (profileId: string, id: string) => request<MessageView>(`${messageUrl(id)}/read`, 'POST', {}, profileId),
};

const gitRequestUrl = (id: string) => `/git/requests/${encodeURIComponent(id)}`;
export const gitApi = {
  details: (id: string) => request<GitDetails>(`${projectUrl(id)}/git/details`),
  diff: (id: string, input: GitDiffInput) => request<GitDiff>(`${projectUrl(id)}/git/diff`, 'POST', input),
  preview: (profileId: string, id: string, operation: GitOperation) => request<GitPreview>(`${projectUrl(id)}/git/preview`, 'POST', { operation }, profileId),
  submit: (profileId: string, previewId: string, reviewerDeviceId: string, digest: string) => request<GitRequestView>('/git/requests', 'POST', { previewId, reviewerDeviceId, digest, confirm: true }, profileId),
  requests: (profileId: string | null, id: string) => request<GitRequestView[]>(`${projectUrl(id)}/git/requests`, 'GET', undefined, profileId),
  execute: (profileId: string, id: string, digest: string) => request<GitRequestView>(`${gitRequestUrl(id)}/execute`, 'POST', { digest, confirm: true }, profileId),
  cancel: (profileId: string, id: string, digest: string) => request<GitRequestView>(`${gitRequestUrl(id)}/cancel`, 'POST', { digest, confirm: true }, profileId),
  audit: (profileId: string | null, id: string) => request<GitAuditEvent[]>(`${gitRequestUrl(id)}/audit`, 'GET', undefined, profileId),
  acknowledge: (profileId: string | null, id: string) => request<GitRequestView>(`${gitRequestUrl(id)}/acknowledge`, 'POST', { confirm: true }, profileId),
  approvals: (profileId: string | null) => request<GitApproval[]>('/git/approvals', 'GET', undefined, profileId),
  decide: (profileId: string, id: string, digest: string, decision: 'approved' | 'rejected', reason: string) => request<GitApproval>(`/git/approvals/${encodeURIComponent(id)}/decision`, 'POST', { digest, decision, reason, confirm: true }, profileId),
};
export const governanceApi = {
  state: (profileId: string | null) => request<GovernanceState>('/governance', 'GET', undefined, profileId),
  refresh: (profileId: string) => request<GovernanceState>('/governance/refresh', 'POST', { confirm: true }, profileId),
  role: (profileId: string, deviceId: string, role: DeviceRole) => request<GovernanceState>(`/governance/roles/${encodeURIComponent(deviceId)}`, 'PATCH', { role, confirm: true }, profileId),
  previewSharing: (profileId: string, policy: StatusSharingPolicy) => request<StatusSharingPreview>('/governance/sharing/preview', 'POST', { policy }, profileId),
  saveSharing: (profileId: string, policy: StatusSharingPolicy, digest: string) => request<GovernanceState>('/governance/sharing', 'POST', { policy, digest, confirm: true }, profileId),
};

export const appObservationApi = {
  state: (profileId: string | null) => request<AppObservationState>('/app-observation', 'GET', undefined, profileId),
  refresh: (profileId: string) => request<AppObservationState>('/app-observation/refresh', 'POST', { confirm: true }, profileId),
  previewSharing: (profileId: string, policy: AppObservationPolicy) => request<AppObservationPreview>('/app-observation/sharing/preview', 'POST', { policy }, profileId),
  saveSharing: (profileId: string, policy: AppObservationPolicy, digest: string) => request<AppObservationState>('/app-observation/sharing', 'POST', { policy, digest, confirm: true }, profileId),
};

export function errorMessage(error: unknown, locale: Locale = DEFAULT_LOCALE): string {
  if (error == null || error === '') return '';
  if (error instanceof LocalizedError) return error.localize(locale);
  let message = error instanceof Error ? error.message : typeof error === 'string' ? error : translate(clientMessages, locale, 'incomplete');
  if (error instanceof ApiError) {
    if (error.code?.startsWith('client.')) {
      const key = error.code.slice(7) as keyof typeof clientMessages.en;
      if (Object.hasOwn(clientMessages.en, key)) message = translate(clientMessages, locale, key, error.params);
    } else if (isErrorCode(error.code)) message = translateError(error.code, locale, error.params);
    if (error.status === 409) return `${translate(clientMessages, locale, 'conflict')}${message ? ` (${message})` : ''}`;
  }
  return message;
}
