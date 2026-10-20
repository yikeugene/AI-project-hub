import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { LocalizedError } from '../../shared/i18n';
import type { Project } from '../../shared/types';
import { api } from '../api';
import { Button, ConfirmDialog, ErrorNotice, Field, Notice, SectionHeading } from '../components/ui';
import { formatDate, useAction, useBeforeUnload } from '../hooks';
import { useLocale, useT } from '../i18n';
import { resumptionMessages } from '../locales/resumption';

interface QuickWrapUpPanelProps {
  project: Project;
  onChange: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  blocked?: boolean;
  onSaved?: () => void;
}
interface WrapUpDraft { status: string; blockers: string; nextAction: string }
const readDraft = (project: Project): WrapUpDraft => ({ status: project.memory.status, blockers: project.memory.blockers, nextAction: project.nextAction });
const readBase = (project: Project) => ({ values: readDraft(project), revision: project.revision, checkpointAt: project.checkpointAt });

/** Project identity resets the editor; language, polling and a hidden tab do not. */
export function QuickWrapUpPanel(props: QuickWrapUpPanelProps) {
  return <QuickWrapUpEditor key={props.project.id} {...props} />;
}

function QuickWrapUpEditor({ project, onChange, onDirtyChange, onBusyChange, blocked = false, onSaved }: QuickWrapUpPanelProps) {
  const locale = useLocale(); const t = useT(resumptionMessages);
  const [base, setBase] = useState(() => readBase(project));
  const [draft, setDraft] = useState(() => readDraft(project));
  const [discard, setDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<'wrapUpRefreshFailed' | 'wrapUpReloadRefreshFailed' | ''>('');
  const action = useAction(project.id); const discarding = useAction(project.id);
  const busy = action.busy || discarding.busy;
  const dirty = draft.status !== base.values.status || draft.blockers !== base.values.blockers || draft.nextAction !== base.values.nextAction;
  const invalidNext = !draft.nextAction.trim() || draft.nextAction.length > 2000;
  const invalidMemory = draft.status.length > 20000 || draft.blockers.length > 20000;
  const changedElsewhere = dirty && project.revision > base.revision;
  const alive = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  useBeforeUnload(dirty);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    // A lagging poll must not replace the successful mutation response or an unsaved draft.
    if (!dirty && !busy && project.revision >= base.revision) {
      if (project.revision > base.revision) setSaved(false);
      setBase(readBase(project)); setDraft(readDraft(project));
    }
  }, [project.revision, project.checkpointAt, project.memory.status, project.memory.blockers, project.nextAction, dirty, busy, base.revision]);

  const update = (key: keyof WrapUpDraft, value: string) => {
    if (blocked || busy) return;
    setDraft(current => ({ ...current, [key]: value })); setSaved(false); setRefreshNotice('');
  };
  const save = async () => {
    if (blocked || busy) return;
    const snapshot = { ...draft }; const revision = base.revision;
    setSaved(false); setRefreshNotice('');
    const response = await action.run(async () => {
      if (!snapshot.nextAction.trim() || snapshot.nextAction.length > 2000) throw new LocalizedError(resumptionMessages, 'wrapUpInvalidNext');
      if (snapshot.status.length > 20000 || snapshot.blockers.length > 20000) throw new LocalizedError(resumptionMessages, 'wrapUpInvalidMemory');
      // Preserve authored whitespace. The original base revision is never silently advanced on failure.
      const updated = await api.wrapUpProject(project.id, { revision, ...snapshot });
      if (!alive.current) return false;
      setDraft(readDraft(updated)); setBase(readBase(updated)); setSaved(true);
      try { await onChange(); }
      catch { if (alive.current) setRefreshNotice('wrapUpRefreshFailed'); }
      return true;
    });
    if (response.ok && response.value && alive.current) onSaved?.();
  };
  const discardDraft = async () => {
    if (busy) return;
    await discarding.run(async () => {
      // Read authoritative content only after explicit confirmation; do not infer it from an old poll.
      const workspace = await api.workspace();
      const latest = workspace.projects.find(candidate => candidate.id === project.id);
      if (!latest || latest.revision < base.revision) throw new LocalizedError(resumptionMessages, 'wrapUpReloadFailed');
      if (!alive.current) return;
      setDraft(readDraft(latest)); setBase(readBase(latest)); setSaved(false); setRefreshNotice('');
      action.setError(''); setDiscard(false);
      try { await onChange(); }
      catch { if (alive.current) setRefreshNotice('wrapUpReloadRefreshFailed'); }
    });
  };

  return <section className="quick-wrap-up-panel">
    <SectionHeading title={t('wrapUpTab')} subtitle={t('wrapUpSubtitle')}><span className={`save-state${dirty ? ' is-dirty' : ''}`} role="status">{dirty ? t('wrapUpUnsaved') : saved ? t('wrapUpSaved') : t('wrapUpReady')}</span></SectionHeading>
    {blocked && <Notice warning>{t('wrapUpBlocked')}</Notice>}
    <ErrorNotice message={action.error} />
    {refreshNotice && <Notice warning>{t(refreshNotice)}</Notice>}
    {changedElsewhere && <Notice warning>{t('wrapUpChangedElsewhere')}</Notice>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="wrap-up-toolbar memory-toolbar"><span>{t('wrapUpRevision', { revision: base.revision })}{base.checkpointAt && <><span className="toolbar-divider" />{t('checkpointDate', { date: formatDate(base.checkpointAt, true, locale) })}</>}</span><div>
        <Button icon={RotateCcw} disabled={!dirty || busy} onClick={() => { discarding.setError(''); setDiscard(true); }}>{t('discardWrapUp')}</Button>
        <Button type="submit" variant="primary" icon={Save} busy={action.busy} disabled={blocked || discarding.busy || invalidNext || invalidMemory}>{t('wrapUpSave')}</Button>
      </div></div>
      <div className="wrap-up-fields">
        <div className="wrap-up-field-status"><Field label={t('wrapUpStatus')}><textarea aria-label={t('wrapUpStatus')} value={draft.status} maxLength={20000} rows={4} disabled={blocked || busy} placeholder={t('statusPlaceholder')} onChange={event => update('status', event.target.value)} /></Field></div>
        <div className="wrap-up-field-blockers"><Field label={t('wrapUpBlockers')}><textarea aria-label={t('wrapUpBlockers')} value={draft.blockers} maxLength={20000} rows={3} disabled={blocked || busy} placeholder={t('blockersPlaceholder')} onChange={event => update('blockers', event.target.value)} /></Field></div>
        <div className="wrap-up-field-next-action"><Field label={t('wrapUpNextAction')} required hint={t('nextActionHint')}><textarea aria-label={t('wrapUpNextAction')} aria-invalid={invalidNext || undefined} value={draft.nextAction} required maxLength={2000} rows={3} disabled={blocked || busy} placeholder={t('nextActionPlaceholder')} onChange={event => update('nextAction', event.target.value)} /></Field></div>
      </div>
      {invalidMemory && <ErrorNotice message={t('wrapUpInvalidMemory')} />}
      <p className="field-hint">{t('wrapUpReconfirm')}</p>
      <Notice>{t('wrapUpSharing')}</Notice>
    </form>
    {discard && <ConfirmDialog title={t('wrapUpDiscardTitle')} confirmLabel={t('wrapUpDiscardConfirm')} danger busy={discarding.busy} error={discarding.error} onClose={() => setDiscard(false)} onConfirm={() => { void discardDraft(); }}><p>{t('wrapUpDiscardDescription')}</p></ConfirmDialog>}
  </section>;
}
