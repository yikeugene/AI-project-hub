import { DEFAULT_LOCALE, type Locale, type MessageCatalog } from './i18n.js';
import type { Priority, ProjectMemory, ProjectStatus, TaskStatus } from './types.js';

const memoryLabels = {
  en: { overview: 'Project overview', status: 'Current development status', architecture: 'Architecture and technology', completed: 'Completed features', pending: 'Tasks and plans', blockers: 'Known issues and blockers', decisions: 'Key technical decisions', nextActions: 'Next actions', notes: 'Work notes' },
  'zh-TW': { overview: '專案概覽', status: '目前開發狀態', architecture: '架構與技術', completed: '已完成功能', pending: '待辦與計劃', blockers: '已知問題與阻礙', decisions: '重要技術決策', nextActions: '接下來的行動', notes: '工作筆記' },
} satisfies MessageCatalog<keyof ProjectMemory>;
const statusLabels = {
  en: { active: 'Active', paused: 'Paused', planning: 'Planning', completed: 'Completed', archived: 'Archived' },
  'zh-TW': { active: '進行中', paused: '已暫停', planning: '規劃中', completed: '已完成', archived: '已封存' },
} satisfies MessageCatalog<ProjectStatus>;
const priorityLabels = {
  en: { high: 'High', normal: 'Normal', low: 'Low', backlog: 'Backlog' },
  'zh-TW': { high: '高優先', normal: '一般', low: '低優先', backlog: '待安排' },
} satisfies MessageCatalog<Priority>;
const taskLabels = {
  en: { todo: 'To do', doing: 'In progress', blocked: 'Blocked', done: 'Done' },
  'zh-TW': { todo: '待處理', doing: '進行中', blocked: '受阻', done: '已完成' },
} satisfies MessageCatalog<TaskStatus>;

export const getMemoryLabels = (locale: Locale = DEFAULT_LOCALE): Record<keyof ProjectMemory, string> => memoryLabels[locale];
export const getStatusLabels = (locale: Locale = DEFAULT_LOCALE): Record<ProjectStatus, string> => statusLabels[locale];
export const getPriorityLabels = (locale: Locale = DEFAULT_LOCALE): Record<Priority, string> => priorityLabels[locale];
export const getTaskLabels = (locale: Locale = DEFAULT_LOCALE): Record<TaskStatus, string> => taskLabels[locale];
