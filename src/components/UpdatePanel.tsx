import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { desktopMessages } from '../../shared/locales/desktop';
import type { UpdateState, UpdateUnavailableReason } from '../../shared/updates';
import { desktopBridge, useAction } from '../hooks';
import { useLocale, useT } from '../i18n';
import { Button, ConfirmDialog, ErrorNotice, SectionHeading } from './ui';

const reasonKeys: Record<UpdateUnavailableReason, keyof typeof desktopMessages.en> = {
  unconfigured: 'unconfigured', development: 'development', portable: 'portable', unpacked: 'unpacked',
  'custom-data-dir': 'customData', 'unsupported-platform': 'unsupportedPlatform',
};
export function UpdatePanel({ version }: { version: string }) {
  const locale = useLocale();
  const t = useT(desktopMessages);
  const bridge = desktopBridge();
  const [state, setState] = useState<UpdateState | null>(null);
  const [confirm, setConfirm] = useState(false);
  const action = useAction();
  const { setError } = action;
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const accept = (next: UpdateState) => { if (alive) setState(previous => !previous || next.revision >= previous.revision ? next : previous); };
    const unsubscribe = bridge.onUpdateState(accept);
    void bridge.getUpdateState().then(accept).catch(error => { if (alive) setError(error); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge, setError]);
  const busy = action.busy || !!state && ['checking', 'downloading', 'installing'].includes(state.status);
  const apply = async (operation: () => Promise<UpdateState>) => {
    const result = await action.run(operation);
    if (result.ok) setState(previous => !previous || result.value.revision >= previous.revision ? result.value : previous);
  };
  const status = !bridge ? t('web') : !state ? t('idle') : state.status === 'unavailable'
    ? t(reasonKeys[state.reason ?? 'development'])
    : t(state.status, { version: state.latestVersion ?? '', progress: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(state.progress ?? 0) });
  return <section className="panel capability-panel software-updates">
    <SectionHeading title={t('updateTitle')} subtitle={t('updateIntro')} />
    <p>{t('currentVersion')}: <strong>{version}</strong></p>
    <p role="status">{status}</p>
    {state?.status === 'downloading' && <progress max={100} value={state.progress ?? 0} aria-label={t('download')} />}
    <ErrorNotice message={state?.error} /><ErrorNotice message={action.error} onDismiss={() => action.setError(null)} />
    <div className="section-actions">
      {bridge && state && ['idle', 'current', 'error', 'available'].includes(state.status) && <Button icon={RefreshCw} busy={action.busy} disabled={busy} onClick={() => { void apply(() => bridge.checkForUpdates()); }}>{t('check')}</Button>}
      {bridge && state?.status === 'available' && <Button variant="primary" icon={Download} disabled={busy} onClick={() => { void apply(() => bridge.downloadUpdate()); }}>{t('download')}</Button>}
      {bridge && state?.status === 'downloaded' && <Button variant="primary" disabled={busy} onClick={() => setConfirm(true)}>{t('install')}</Button>}
      {bridge && state?.releaseUrl && <Button icon={ExternalLink} disabled={busy} onClick={() => { void action.run(() => bridge.openReleases()); }}>{t('releases')}</Button>}
    </div>
    {confirm && bridge && <ConfirmDialog title={t('installTitle')} confirmLabel={t('install')} onClose={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void apply(() => bridge.installUpdate()); }}><p>{t('installWarning')}</p></ConfirmDialog>}
  </section>;
}
