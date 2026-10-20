import { AlertTriangle, Ban, CheckCircle2, Clock3, FileCode2, Loader2, ShieldCheck } from 'lucide-react';
import type { GitReviewSummary, LocalGitState } from '../../shared/git';
import { formatDate } from '../hooks';
import { useLocale, useT } from '../i18n';
import { gitMessages } from '../locales/panels-git';

export function GitStateBadge({ state }: { state: LocalGitState | 'consumed' }) {
  const t = useT(gitMessages);
  const Icon = state === 'succeeded' ? CheckCircle2 : state === 'approved' ? ShieldCheck
    : state === 'executing' || state === 'consuming' ? Loader2
    : state === 'unknown' || state === 'partial' || state === 'stale' || state === 'failed' ? AlertTriangle
    : state === 'rejected' || state === 'cancelled' || state === 'expired' ? Ban : Clock3;
  return <span className={`git-state git-state-${state}`}><Icon size={14} aria-hidden="true" />{t(state)}</span>;
}

/** Only the explicit relay DTO is rendered here; no local plan, path, or diff can leak in. */
export function GitReview({ summary, digest, expiresAt }: { summary: GitReviewSummary; digest: string; expiresAt: string }) {
  const t = useT(gitMessages); const locale = useLocale();
  return <div className="git-review">
    <dl className="git-metadata">
      <div><dt>{t('summaryProject')}</dt><dd>{summary.projectName}</dd></div>
      <div><dt>{t('summaryAction')}</dt><dd>{t(summary.kind)}</dd></div>
      <div><dt>{t('branch')}</dt><dd>{summary.branch ?? t('detachedHead')}</dd></div>
      <div><dt>{t('changes')}</dt><dd>{t('summaryCounts', { changed: summary.changedCount, staged: summary.stagedCount })}</dd></div>
      {summary.head !== null && <div><dt>{t('summaryHead')}</dt><dd><code>{summary.head}</code></dd></div>}
      {summary.target !== null && <div><dt>{t('summaryTarget')}</dt><dd><code>{summary.target}</code></dd></div>}
      {summary.remoteUrl !== null && <div><dt>{t('summaryRemote')}</dt><dd>{summary.remoteUrl}</dd></div>}
      {summary.targetRef !== null && <div><dt>{t('summaryRef')}</dt><dd><code>{summary.targetRef}</code></dd></div>}
      {(summary.authorName !== null || summary.authorEmail !== null) && <div><dt>{t('summaryAuthor')}</dt><dd>{summary.authorName} &lt;{summary.authorEmail}&gt;</dd></div>}
      {summary.message !== null && <div><dt>{t('summaryMessage')}</dt><dd className="preserve-lines">{summary.message}</dd></div>}
    </dl>
    <h4><FileCode2 size={15} aria-hidden="true" />{t('summaryPaths')}</h4>
    {summary.paths.length ? <ul className="git-review-paths">{summary.paths.map((path, index) => <li key={`${index}:${path}`}><code className="preserve-lines">{path}</code></li>)}</ul> : <p className="field-hint">{t('noPaths')}</p>}
    <p className="field-hint">{t('expires', { date: formatDate(expiresAt, true, locale) })}</p>
    <dl className="git-metadata"><div><dt>{t('digest')}</dt><dd><code>{digest}</code></dd></div></dl>
  </div>;
}
