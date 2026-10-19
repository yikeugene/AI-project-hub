import { FileCode2, GitBranch, GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { createTranslator, type Locale } from '../../shared/i18n';
import type { Project } from '../../shared/types';
import { api } from '../api';
import { formatDate, useAction } from '../hooks';
import { Button, EmptyState, ErrorNotice, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { gitMessages } from '../locales/panels-git';

const changeLabel = (index: string, worktree: string, locale: Locale) => {
  const t = createTranslator(gitMessages, locale);
  if (index === '?' || worktree === '?') return t('untracked');
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) return t('conflict');
  const labels: Record<string, string> = { M: t('modified'), A: t('added'), D: t('deleted'), R: t('renamed'), C: t('copied'), T: t('typeChanged') };
  return [index.trim() ? t('stagedChange', { change: labels[index] ?? index }) : '', worktree.trim() ? labels[worktree] ?? worktree : ''].filter(Boolean).join(' / ') || t('changed');
};
export function GitPanel({ project, onChange }: { project: Project; onChange: () => Promise<void> }) {
  const locale = useLocale(); const t = useT(gitMessages);
  const action = useAction(); const git = project.git;
  return <section className="git-panel"><SectionHeading title={t('title')} subtitle={project.lastCheckedAt ? t('lastChecked', { date: formatDate(project.lastCheckedAt, true, locale) }) : t('notChecked')}><Button icon={RefreshCw} busy={action.busy} onClick={() => { void action.run(async () => { await api.refreshProject(project.id); await onChange(); }); }}>{t('refresh')}</Button></SectionHeading><ErrorNotice message={action.error || project.gitError || ''} />
    {!git ? <EmptyState compact icon={GitBranch} title={t('unavailableTitle')} description={t('unavailableDescription')} /> : !git.isRepo ? <EmptyState compact icon={GitBranch} title={t('notRepoTitle')} description={t('notRepoDescription')} /> : <>
      <div className="git-summary"><div className="git-branch"><GitBranch size={20} /><div><span className="muted">{t('branch')}</span><strong>{git.branch || t('detachedHead')}</strong></div></div><dl><div><dt>{t('changes')}</dt><dd>{git.changedCount}</dd></div><div><dt>{t('untracked')}</dt><dd>{git.untrackedCount}</dd></div><div><dt>{t('staged')}</dt><dd>{git.stagedCount}</dd></div><div><dt>{t('conflict')}</dt><dd>{git.conflictCount}</dd></div></dl></div>
      {git.conflictCount > 0 && <Notice warning>{t('conflictNotice', { count: git.conflictCount })}</Notice>}
      <section className="detail-section"><h3><FileCode2 size={17} />{t('worktreeChanges')} <span className="count-label">{git.changes.length}</span></h3>{git.changes.length ? <div className="git-changes">{git.changes.map((change, i) => <div className="git-change" key={`${change.path}-${i}`}><code className="change-code">{change.index}{change.worktree}</code><span className="path-text">{change.path}</span><span className="muted">{changeLabel(change.index, change.worktree, locale)}</span></div>)}</div> : <p className="quiet-empty">{t('cleanWorktree')}</p>}</section>
      <section className="detail-section"><h3><GitCommitHorizontal size={17} />{t('recentCommits')}</h3><p className="field-hint">{t('commitTimeHint')}</p>{git.commits.length ? <div className="commit-list">{git.commits.map(commit => <div className="commit-row" key={commit.hash}><GitCommitHorizontal size={16} /><code title={commit.hash}>{commit.shortHash}</code><strong>{commit.subject}</strong><time dateTime={commit.date}>{formatDate(commit.date, true, locale)}</time></div>)}</div> : <p className="quiet-empty">{t('noCommits')}</p>}</section>
      {git.branches.length > 0 && <section className="detail-section"><h3>{t('localBranches')}</h3><div className="branch-list">{git.branches.map(branch => <span className={`branch-chip ${branch === git.branch ? 'current' : ''}`} key={branch}><GitBranch size={13} />{branch}</span>)}</div></section>}
      <p className="field-hint">{t('readonlyHint')}</p>
    </>}
  </section>;
}
