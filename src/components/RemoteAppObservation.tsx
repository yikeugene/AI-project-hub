import { AlertTriangle, Clock3, Monitor } from 'lucide-react';
import type { RemoteAppObservation as RemoteObservation } from '../../shared/app-observation';
import { isStatusFresh } from '../git-ui';
import { formatDate, useNow } from '../hooks';
import { useLocale, useT } from '../i18n';
import { appObservationMessages } from '../locales/app-observation';

/** Names are inert React text. A recent receipt alone never makes an old observation current. */
export function RemoteAppObservation({ status }: { status: RemoteObservation | undefined }) {
  const t = useT(appObservationMessages); const locale = useLocale(); const now = useNow();
  const observation = status?.observation;
  const hasName = observation?.name != null;
  const fresh = !!status && !!observation && isStatusFresh(observation.observedAt, now) && isStatusFresh(status.receivedAt, now);
  const Icon = fresh ? Clock3 : AlertTriangle;
  return <section className="remote-app-observation">
    <h3><Monitor size={16} aria-hidden="true" />{t('remoteTitle')}</h3>
    {!status ? <p className="field-hint">{t('remoteMissing')}</p> : <>
      {!observation ? <p className="field-hint">{t('remoteWithdrawn')}</p> : !hasName ? <p className="field-hint">{t('remoteUnavailable')}</p> : <div className="status-receipt"><span className={`status-freshness ${fresh ? '' : 'status-outdated'}`}><Icon size={14} aria-hidden="true" />{t(fresh ? 'recent' : 'stale')}</span>{!fresh && <p className="field-hint">{t('staleHint')}</p>}</div>}
      <dl className="status-text-list">
        {hasName && <div><dt>{t('nameLabel')}</dt><dd>{observation!.name}</dd></div>}
        {observation && <div><dt>{t('observedLabel')}</dt><dd><time dateTime={observation.observedAt}>{formatDate(observation.observedAt, true, locale)}</time></dd></div>}
        <div><dt>{t('receivedLabel')}</dt><dd><time dateTime={status.receivedAt}>{formatDate(status.receivedAt, true, locale)}</time></dd></div>
      </dl>
    </>}
  </section>;
}
