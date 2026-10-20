import { AlertTriangle, Clock3, Monitor } from 'lucide-react';
import type { RemoteDeviceStatus, SharedProjectStatus } from '../../shared/governance';
import { isStatusFresh } from '../git-ui';
import { formatDate, useNow } from '../hooks';
import { useLocale, useT } from '../i18n';
import { governanceMessages } from '../locales/panels-governance';
import { Notice } from './ui';

export function StatusReceipt({ receivedAt }: { receivedAt: string }) {
  const t = useT(governanceMessages); const locale = useLocale(); const now = useNow();
  const fresh = isStatusFresh(receivedAt, now); const Icon = fresh ? Clock3 : AlertTriangle;
  return <div className="status-receipt"><span className={`status-freshness ${fresh ? '' : 'status-outdated'}`}><Icon size={14} aria-hidden="true" />{t(fresh ? 'recent' : 'stale')}</span><time dateTime={receivedAt}>{t('received', { date: formatDate(receivedAt, true, locale) })}</time>{!fresh && <p className="field-hint">{t('staleHint')}</p>}</div>;
}
export function RemoteDeviceActivity({ status }: { status: RemoteDeviceStatus | undefined }) {
  const t = useT(governanceMessages); const locale = useLocale();
  const activity = status?.activity;
  return <section className="remote-device-activity"><h3><Monitor size={16} aria-hidden="true" />{t('remoteTitle')}</h3>
    {status && <StatusReceipt receivedAt={status.receivedAt} />}
    {!activity ? <p className="field-hint">{t('remoteMissing')}</p> : <><dl className="status-text-list"><div><dt>{t('mode')}</dt><dd>{t(activity.mode)}</dd></div><div><dt>{t('syncLabel')}</dt><dd>{t(activity.sync)}</dd></div><div><dt>{t('lastSync')}</dt><dd>{formatDate(activity.lastSyncAt, true, locale)}</dd></div></dl>
      <h4>{t('operations')}</h4><p className="field-hint">{t('operationsHint')}</p>{activity.operations.length ? <ul className="status-operation-list">{activity.operations.map((operation, index) => <li key={`${operation.at}:${index}`}><Clock3 size={14} aria-hidden="true" /><span>{t('operationAt', { kind: t(operation.kind === 'git' ? 'gitOperation' : operation.kind), state: t(operation.state), date: formatDate(operation.at, true, locale) })}</span></li>)}</ul> : <p className="field-hint">{t('noOperations')}</p>}
    </>}
  </section>;
}
export function RemoteProjectStatus({ project, receivedAt }: { project: SharedProjectStatus | undefined; receivedAt: string | undefined }) {
  const t = useT(governanceMessages); const locale = useLocale(); const now = useNow();
  return <section className="remote-project-status">
    {receivedAt && <StatusReceipt receivedAt={receivedAt} />}
    <h3>{t('gitTitle')}</h3>{!project?.git ? <p className="field-hint">{t('gitNotShared')}</p> : project.git.unavailable ? <Notice warning>{t('gitUnavailable')}</Notice> : <><dl className="status-text-list"><div><dt>{t('branch')}</dt><dd>{project.git.branch ?? t('noBranch')}</dd></div><div><dt>{t('changedCount')}</dt><dd>{project.git.changedCount}</dd></div><div><dt>{t('stagedCount')}</dt><dd>{project.git.stagedCount}</dd></div><div><dt>{t('conflictCount')}</dt><dd>{project.git.conflictCount}</dd></div></dl><p className="field-hint">{t('observed', { date: formatDate(project.git.observedAt, true, locale) })}</p>{!isStatusFresh(project.git.observedAt ?? '', now) && <Notice warning>{t('gitOutdated')}</Notice>}</>}
    <h3>{t('tasksTitle')}</h3><p className="field-hint">{t('tasksHint')}</p>{project?.tasks ? <dl className="status-text-list">{(['todo', 'doing', 'blocked', 'done'] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd>{project.tasks![key]}</dd></div>)}</dl> : <p className="field-hint">{t('tasksNotShared')}</p>}
  </section>;
}
