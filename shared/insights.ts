import type { FocusItem, Project, Task } from './types.js';
import { getStatusLabels } from './types.js';
import { DEFAULT_LOCALE, type Locale } from './i18n.js';
import { coreTranslator } from './locales/core.js';

/** Repository activity only. Editing Hub metadata or polling never moves this clock. */
export function activityAt(project: Project): string | null {
  return project.git?.lastCommitAt ?? null;
}
export function isStale(project: Project, days = 14, now: Date | number = Date.now()): boolean {
  const last = activityAt(project);
  return !!last && +new Date(now) - Date.parse(last) >= days * 86400000;
}
const priorityWeight = { high: 40, normal: 20, low: 5, backlog: 0 };

/** Explainable rules, not AI prediction or a completion estimate. */
export function getFocusItems(projects: Project[], tasks: Task[], staleDays = 14, now: Date | number = Date.now(), locale: Locale = DEFAULT_LOCALE): FocusItem[] {
  const t = coreTranslator(locale), statuses = getStatusLabels(locale);
  return projects.filter(p => p.status === 'active' || p.status === 'planning').flatMap(project => {
    const projectTasks = tasks.filter(t => t.projectId === project.id);
    const actionable = projectTasks.filter(t => (t.status === 'todo' || t.status === 'doing') && t.priority !== 'backlog')
      .sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority] || Number(b.status === 'doing') - Number(a.status === 'doing') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const task = actionable[0] ?? null;
    // Don't invent an action when the only recorded work is blocked or backlog.
    const action = task?.title || project.nextAction.trim() || project.memory.nextActions.trim();
    if (!action || (!task && project.priority === 'backlog')) return [];
    const base = priorityWeight[project.priority];
    const reasons = [t('focus.projectPriority', { score: base }), t('focus.status', { status: statuses[project.status], score: project.status === 'active' ? 10 : 0 })];
    let score = base + (project.status === 'active' ? 10 : 0);
    if (task) {
      score += priorityWeight[task.priority]; reasons.push(t('focus.taskPriority', { score: priorityWeight[task.priority] }));
      if (task.status === 'doing') { score += 5; reasons.push(t('focus.doing')); }
    } else reasons.push(t('focus.manual'));
    if (isStale(project, staleDays, now)) reasons.push(t('focus.stale', { days: staleDays }));
    if (projectTasks.some(task => task.status === 'blocked') || project.memory.blockers.trim()) reasons.push(t('focus.blockers'));
    if (project.gitError) reasons.push(t('focus.gitError'));
    return [{ project, task, action, reasons, score }];
  }).sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name) || a.project.id.localeCompare(b.project.id));
}

export function getResumeSummary(project: Project, tasks: Task[], locale: Locale = DEFAULT_LOCALE): { checkpoint: string; facts: string[]; nextAction: string } {
  const t = coreTranslator(locale);
  const checkpoint = project.memory.status || project.memory.notes || project.memory.overview || t('resume.checkpoint');
  const git = project.git;
  const facts: string[] = [];
  if (project.gitError) facts.push(t('resume.gitError', { detail: project.gitError }));
  if (!git) facts.push(t('resume.noGit'));
  else if (!git.isRepo) facts.push(t('resume.notRepo'));
  else {
    facts.push(t('resume.branch', { branch: git.branch ?? 'Detached HEAD', count: git.changedCount }));
    facts.push(git.commits[0] ? t('resume.commit', { subject: git.commits[0].subject }) : t('resume.noCommit'));
    facts.push(t('resume.observed', { time: git.observedAt }));
  }
  const open = tasks.filter(task => task.projectId === project.id && task.status !== 'done');
  facts.push(t('resume.tasks', { open: open.length, blocked: open.filter(task => task.status === 'blocked').length }));
  const focus = getFocusItems([project], tasks, undefined, undefined, locale)[0];
  return { checkpoint, facts, nextAction: focus?.action || project.nextAction || t('resume.noAction') };
}
