import packageJson from '../package.json' with { type: 'json' };
import type { Locale } from './i18n.js';
import { getMemoryLabels, getPriorityLabels, getStatusLabels, getTaskLabels } from './labels.js';
export { getMemoryLabels, getPriorityLabels, getStatusLabels, getTaskLabels } from './labels.js';

export const PROJECT_STATUSES = ['active', 'paused', 'planning', 'completed', 'archived'] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];
export const PRIORITIES = ['high', 'normal', 'low', 'backlog'] as const;
export type Priority = typeof PRIORITIES[number];
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const MEMORY_FIELDS = ['overview', 'status', 'architecture', 'completed', 'pending', 'blockers', 'decisions', 'nextActions', 'notes'] as const;
export type ProjectMemory = Record<typeof MEMORY_FIELDS[number], string>;
export const EMPTY_MEMORY: ProjectMemory = { overview: '', status: '', architecture: '', completed: '', pending: '', blockers: '', decisions: '', nextActions: '', notes: '' };
// Compatibility exports are always English; interactive surfaces use the locale getters.
export const MEMORY_LABELS = getMemoryLabels();
export const STATUS_LABELS = getStatusLabels();
export const PRIORITY_LABELS = getPriorityLabels();
export const TASK_LABELS = getTaskLabels();

export interface GitCommit { hash: string; shortHash: string; subject: string; date: string }
export interface GitChange { path: string; index: string; worktree: string }
export interface GitSnapshot {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  branches: string[];
  commits: GitCommit[];
  changes: GitChange[];
  changedCount: number;
  untrackedCount: number;
  stagedCount: number;
  conflictCount: number;
  lastCommitAt: string | null;
  observedAt: string;
}
export interface Project {
  id: string; name: string; path: string; description: string; category: string;
  status: ProjectStatus; priority: Priority; stage: string; nextAction: string;
  createdAt: string; updatedAt: string; revision: number;
  memory: ProjectMemory; memoryUpdatedAt: string | null;
  git: GitSnapshot | null; gitError: string | null; lastCheckedAt: string | null;
}
export interface Task {
  id: string; projectId: string; title: string; detail: string;
  status: TaskStatus; priority: Priority; revision: number;
  createdAt: string; updatedAt: string;
}
export interface ScanCandidate { path: string; name: string; kind: 'git' | 'project'; markers: string[] }
export interface ScanResult { candidates: ScanCandidate[]; warnings: string[]; truncated: boolean; visited: number }
export const APP_VERSION = packageJson.version;
export const HANDOFF_TARGETS = ['generic', 'claude', 'codex', 'claude-desktop', 'chatgpt-desktop'] as const;
export type HandoffTarget = typeof HANDOFF_TARGETS[number];
export const DESKTOP_APPS = ['claude', 'chatgpt'] as const;
export type DesktopApp = typeof DESKTOP_APPS[number];
export type DesktopCapabilities = Record<DesktopApp, boolean>;
export const DESKTOP_APP_LABELS: Record<DesktopApp, string> = { claude: 'Claude Desktop', chatgpt: 'ChatGPT Desktop' };
export type LaunchAction = 'folder' | 'vscode' | 'claude' | 'codex';
export type Capabilities = Record<LaunchAction, boolean>;
export interface Settings { scanRoots: string[]; staleDays: number; refreshSeconds: number; locale: Locale }
export interface Workspace {
  projects: Project[]; tasks: Task[]; settings: Settings; csrfToken: string;
  environment: { platform: string; dataDir: string; capabilities: Capabilities; version: string; mode: 'web' | 'desktop'; desktopApps: DesktopCapabilities };
}
export interface HandoffPreview { markdown: string; filename: string; state: SharedState }
export interface SharedState {
  schemaVersion: 1; projectId: string; projectName: string; exportedAt: string;
  memory: ProjectMemory; nextAction: string;
}
export interface SharedStatePreview { state: SharedState; hash: string; source: string }
export interface FocusItem { project: Project; task: Task | null; action: string; reasons: string[]; score: number }
