import type { Workspace, Project, Task, Settings, ScanResult, HandoffPreview, SharedStatePreview, ProjectMemory, LaunchAction, TaskStatus, Priority, ProjectStatus, HandoffTarget, DesktopApp } from '../shared/types';
import type { ApplyProposalInput, CachedSnapshot, ComposeMessageInput, DeviceState, Invitation, MessageView, PairInput, ProposalPreview, SharedPreview, SharePolicy } from '../shared/devices';

import { DEFAULT_LOCALE, LocalizedError, translate, type Locale, type MessageParams } from '../shared/i18n';
import { isErrorCode, translateError } from '../shared/messages';
import { clientMessages } from './locales/client';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public params: MessageParams = {}) { super(message); this.name = 'ApiError'; }
}
let token = '';
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Hub-Token': token } : {}) },
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
export type HandoffAgent = HandoffTarget;
const projectUrl = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const api = {
  workspace: async () => { const result = await request<Workspace>('/workspace'); token = result.csrfToken; return result; },
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
const deviceUrl = (id: string) => `/devices/${encodeURIComponent(id)}`;
const messageUrl = (id: string) => `/messages/${encodeURIComponent(id)}`;
export const deviceApi = {
  state: () => request<DeviceState>('/devices'),
  rename: (name: string) => request<DeviceState>('/devices/local', 'PATCH', { name }),
  pair: (input: PairInput) => request<DeviceState>('/devices/pair', 'POST', input),
  retryPair: () => request<DeviceState>('/devices/pair/retry', 'POST', {}),
  connection: (enabled: boolean) => request<DeviceState>('/devices/connection', 'POST', { enabled }),
  disconnect: () => request<DeviceState>('/devices/disconnect', 'POST', { confirm: true }),
  invitation: () => request<Invitation>('/devices/invitation', 'POST', {}),
  revoke: (id: string) => request<DeviceState>(`${deviceUrl(id)}/revoke`, 'POST', { confirm: true }),
  sync: () => request<DeviceState>('/devices/sync', 'POST', {}),
  sharing: (projectId: string) => request<SharedPreview>(`/devices/sharing/${encodeURIComponent(projectId)}`),
  previewSharing: (projectId: string, input: Pick<SharePolicy, 'enabled' | 'memoryFields'>) => request<SharedPreview>(`/devices/sharing/${encodeURIComponent(projectId)}/preview`, 'POST', input),
  saveSharing: (projectId: string, input: Pick<SharePolicy, 'enabled' | 'memoryFields'>) => request<SharedPreview>(`/devices/sharing/${encodeURIComponent(projectId)}`, 'PUT', input),
  projects: (id: string) => request<CachedSnapshot[]>(`${deviceUrl(id)}/projects`),
  messages: (box: 'inbox' | 'sent') => request<MessageView[]>(`/messages?box=${box}`),
  send: (input: ComposeMessageInput) => request<MessageView>('/messages', 'POST', input),
  preview: (id: string) => request<ProposalPreview>(`${messageUrl(id)}/preview`, 'POST', {}),
  accept: (id: string, input: ApplyProposalInput) => request<MessageView>(`${messageUrl(id)}/accept`, 'POST', input),
  reject: (id: string) => request<MessageView>(`${messageUrl(id)}/reject`, 'POST', { confirm: true }),
  read: (id: string) => request<MessageView>(`${messageUrl(id)}/read`, 'POST', {}),
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
