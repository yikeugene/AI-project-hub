import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, History, Plus, RefreshCw, Save } from 'lucide-react';
import { LocalizedError } from '../../shared/i18n';
import type { Project } from '../../shared/types';
import { activeWorkHold, canCompleteWork, emptyWorkBrief, isWorkBriefReady, workHoldSchema, type WorkAction, type WorkBrief, type WorkCheck, type WorkEvent, type WorkItem, type WorkItemDetail, type WorkPreview } from '../../shared/work-items';
import { ApiError, workItemApi } from '../api';
import { copyText, formatDate, useAction, useBeforeUnload, useNow } from '../hooks';
import { useLocale, useT } from '../i18n';
import { workItemMessages } from '../locales/work-items';
import { canAdoptWorkPoll, commitWorkRequest, currentWorkCheck, hasFailedWorkCheck, prepareWorkAction, prepareWorkCreate, sameWorkBrief, validWorkDraft, workEventLabel, workNextAction, type PendingWorkRequest } from '../work-items';
import { Button, ConfirmDialog, ErrorNotice, Field, Modal, Notice } from './ui';

const noop = () => {};
export interface WorkItemEditorProps {
  projects: Project[];
  item?: WorkItem;
  projectId?: string;
  sourceWorkItemId?: string;
  onClose: () => void;
  onSaved: (item: WorkItem) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onNewFrom?: (item: WorkItem) => void;
}
type FormMode = 'progress' | 'reviewStart' | 'self' | 'partner' | 'hold' | 'revise';
type RevisionKind = Extract<WorkAction, { type: 'revise' }>['kind'];
const makeForm = (item: WorkItem | null, revisionKind: RevisionKind = 'scope') => ({
  progress: item?.progress ?? '', nextAction: item?.nextAction ?? '', note: '',
  source: 'message' as Exclude<WorkCheck['source'], 'self'>, outcome: 'pass' as WorkCheck['outcome'],
  kind: 'waiting' as 'deferred' | 'waiting' | 'paused', until: '', reason: '', resumeAction: '', revisionKind,
});

/** This is the single manual brief-editing surface, also available for future adopted candidates. */
export function WorkBriefFields({ brief, onChange, disabled = false }: { brief: WorkBrief; onChange: (brief: WorkBrief) => void; disabled?: boolean }) {
  const t = useT(workItemMessages);
  const set = (key: keyof WorkBrief, value: string | string[]) => onChange({ ...brief, [key]: value });
  return <div className="work-brief-fields form-stack">
    <p className="field-hint">{t('draftHint')}</p>
    <Field label={t('titleField')}><input value={brief.title} maxLength={160} disabled={disabled} onChange={event => set('title', event.target.value)} /></Field>
    <Field label={t('goal')}><textarea value={brief.goal} maxLength={2000} rows={3} disabled={disabled} placeholder={t('goalPlaceholder')} onChange={event => set('goal', event.target.value)} /></Field>
    <Field label={t('firstCheck')}><textarea value={brief.firstCheck} maxLength={2000} rows={2} disabled={disabled} placeholder={t('firstCheckPlaceholder')} onChange={event => set('firstCheck', event.target.value)} /></Field>
    <details className="work-brief-details">
      <summary>{t('briefDetails')}</summary>
      <div className="form-stack">
        <Field label={t('nonGoals')} hint={t('nonGoalsHint')}><textarea value={brief.nonGoals} maxLength={2000} rows={2} disabled={disabled} onChange={event => set('nonGoals', event.target.value)} /></Field>
        <Field label={t('acceptance')} hint={t('acceptanceHint')}><textarea value={brief.acceptanceCriteria.join('\n')} rows={4} maxLength={5010} disabled={disabled} onChange={event => set('acceptanceCriteria', event.target.value === '' ? [] : event.target.value.split('\n'))} /></Field>
      </div>
    </details>
  </div>;
}

export function WorkBriefView({ brief }: { brief: WorkBrief }) {
  const t = useT(workItemMessages);
  return <div className="work-brief-view">
    <dl><div><dt>{t('goal')}</dt><dd className="preserve-lines">{brief.goal || t('emptyField')}</dd></div>
      <div className="work-first-check"><dt>{t('firstCheck')}</dt><dd className="preserve-lines">{brief.firstCheck || t('emptyField')}</dd></div>
      <div><dt>{t('nonGoals')}</dt><dd className="preserve-lines">{brief.nonGoals || t('noneExcluded')}</dd></div></dl>
    <h4>{t('acceptance')}</h4>{brief.acceptanceCriteria.length ? <ul>{brief.acceptanceCriteria.map((criterion, index) => <li key={index} className="preserve-lines">{criterion || t('emptyField')}</li>)}</ul> : <p className="muted">{t('emptyField')}</p>}
  </div>;
}

export function WorkCheckView({ item, role }: { item: WorkItem; role: WorkCheck['role'] }) {
  const t = useT(workItemMessages); const locale = useLocale();
  const check = currentWorkCheck(item, role);
  return <div className={`work-check ${check ? `work-check-${check.outcome}` : ''}`}>
    <h4>{t(role)}</h4><strong>{t(check?.outcome ?? 'noCheck')}</strong>
    {check && <><p className="preserve-lines">{check.note}</p><span className="field-hint">{t(`source_${check.source}`)} · {t('recordedCheck', { date: formatDate(check.recordedAt, true, locale) })}</span></>}
    {role === 'partner' && <p className="field-hint">{t('partnerProxy')}</p>}
  </div>;
}

/** The parent keeps this mounted for one editing session. Polls and locale changes never key it. */
export function WorkItemEditor({ projects, item, projectId: initialProjectId, sourceWorkItemId, onClose, onSaved, onDirtyChange = noop, onBusyChange = noop, onNewFrom }: WorkItemEditorProps) {
  const t = useT(workItemMessages); const locale = useLocale(); const now = useNow();
  const [base, setBase] = useState<WorkItem | null>(item ?? null);
  const [projectId, setProjectId] = useState(item?.projectId ?? initialProjectId ?? '');
  const [brief, setBrief] = useState<WorkBrief>(() => structuredClone(item?.brief ?? emptyWorkBrief()));
  const [mode, setMode] = useState<FormMode | null>(null);
  const [form, setForm] = useState(() => makeForm(item ?? null));
  const [formBase, setFormBase] = useState(form);
  const [preview, setPreview] = useState<WorkPreview | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<PendingWorkRequest | null>(null);
  const [conflict, setConflict] = useState(false);
  const [comparison, setComparison] = useState<WorkItemDetail | null>(null);
  const [history, setHistory] = useState<WorkEvent[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [discard, setDiscard] = useState<'leave' | 'replace' | 'form' | null>(null);
  const [completing, setCompleting] = useState(false);
  const action = useAction(base?.id ?? projectId); const reading = useAction(base?.id); const copying = useAction(base?.id);
  const busy = action.busy || reading.busy || copying.busy;
  const briefDirty = !sameWorkBrief(brief, base?.brief ?? emptyWorkBrief());
  const formDirty = mode !== null && JSON.stringify(form) !== JSON.stringify(formBase);
  const dirty = briefDirty || formDirty || !!pending;
  const locked = busy || !!pending || conflict;
  const activeHold = base ? activeWorkHold(base, now) : null;
  const failed = base ? hasFailedWorkCheck(base) : false;
  const stable = !locked && !briefDirty && !formDirty && mode === null;
  const canTransition = stable && !activeHold;
  const changedElsewhere = !!base && !!item && item.id === base.id && item.revision > base.revision;
  const previewCurrent = !!base && !!preview && preview.revision === base.revision && preview.version === base.version;
  const alive = useRef(true); const running = useRef(false); const historySequence = useRef(0);
  const callbacks = useRef({ onDirtyChange, onBusyChange }); callbacks.current = { onDirtyChange, onBusyChange };
  useBeforeUnload(dirty || busy);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    // An open preview/form is a snapshot too. Do not move its base revision under it.
    if (base && canAdoptWorkPoll(base, item, dirty || busy || conflict || !!preview || mode !== null)) {
      setBase(item); setBrief(structuredClone(item.brief)); setSaved(false);
    }
  }, [item, base, dirty, busy, conflict, preview, mode]);

  const adopt = (latest: WorkItem) => {
    setBase(latest); setProjectId(latest.projectId); setBrief(structuredClone(latest.brief));
    setMode(null); setForm(makeForm(latest)); setFormBase(makeForm(latest));
    setPreview(null); setCopied(false); setPending(null); setConflict(false); setComparison(null);
    reading.setError(''); copying.setError('');
  };
  const readHistory = async (id: string) => {
    const sequence = ++historySequence.current;
    const detail = await workItemApi.get(id);
    if (alive.current && sequence === historySequence.current) setHistory(detail.events);
    return detail;
  };
  const refreshSaved = async (latest: WorkItem) => {
    if (!alive.current) return;
    await Promise.all([onSaved(latest), readHistory(latest.id)]);
  };
  const execute = async (request: PendingWorkRequest) => {
    if (running.current || busy) return;
    running.current = true; setPending(request); setSaved(false); setRefreshFailed(false);
    await action.run(async () => {
      try {
        const result = await commitWorkRequest(request, mutation => {
          if (!alive.current) return;
          // A replay receipt may be old; the response item is the authoritative latest revision.
          adopt(mutation.item); setSaved(true);
        }, refreshSaved);
        if (alive.current) setRefreshFailed(result.refreshFailed);
      } catch (error) {
        if (alive.current && error instanceof ApiError) {
          if (error.status === 409) setConflict(true);
          // An explicit rejection did not commit; let the user correct the form.
          // Timeouts and transport failures remain uncertain and retain the exact retry.
          else if (error.status >= 400 && error.status < 500 && error.status !== 408) setPending(null);
        }
        throw error;
      }
    });
    running.current = false;
  };
  const mutate = (value: WorkAction) => { if (base && !locked) void execute(prepareWorkAction(base, value)); };
  const saveDraft = () => {
    if (locked || !projects.some(project => project.id === projectId)) return;
    if (!validWorkDraft(brief)) { action.setError(new LocalizedError(workItemMessages, 'invalidDraft')); return; }
    if (base) mutate({ type: 'saveDraft', brief }); else void execute(prepareWorkCreate(projectId, brief, sourceWorkItemId));
  };
  const close = () => { if (!busy) { if (dirty) setDiscard('leave'); else onClose(); } };
  const openForm = (next: FormMode, revisionKind: RevisionKind = 'scope') => {
    if (!stable || !base) return;
    const initial = makeForm(base, revisionKind); setForm(initial); setFormBase(initial); setMode(next); action.setError('');
  };
  const closeForm = () => { if (locked) return; if (formDirty) setDiscard('form'); else setMode(null); };
  const updateForm = <K extends keyof typeof form>(key: K, value: typeof form[K]) => { if (!locked) { setForm(current => ({ ...current, [key]: value })); setSaved(false); } };
  const submitForm = () => {
    if (!base || locked || !mode) return;
    const nonempty = (value: string) => !!value.trim() && value.length <= 2000;
    if (mode === 'progress') {
      if (!nonempty(form.nextAction) || form.progress.length > 2000) { action.setError(new LocalizedError(workItemMessages, 'invalidNote')); return; }
      mutate({ type: 'saveProgress', progress: form.progress, nextAction: form.nextAction });
    } else if (mode === 'reviewStart') mutate({ type: 'startReview', resultNote: form.note });
    else if (mode === 'self' || mode === 'partner') {
      if (!nonempty(form.note) || !base.currentSubmissionId || failed || currentWorkCheck(base, mode)) { action.setError(new LocalizedError(workItemMessages, 'invalidNote')); return; }
      mutate({ type: 'recordCheck', role: mode, outcome: form.outcome, note: form.note, source: mode === 'self' ? 'self' : form.source, version: base.version, submissionId: base.currentSubmissionId });
    } else if (mode === 'revise') {
      if (!nonempty(form.reason)) { action.setError(new LocalizedError(workItemMessages, 'invalidNote')); return; }
      mutate({ type: 'revise', kind: form.revisionKind, reason: form.reason });
    } else {
      const date = form.until ? new Date(form.until) : null;
      const parsed = workHoldSchema.safeParse({ kind: form.kind, reason: form.reason, resumeAction: form.resumeAction, until: date && Number.isFinite(date.getTime()) ? date.toISOString() : null });
      if (!parsed.success || (form.until && (!date || !Number.isFinite(date.getTime()))) || (form.kind === 'deferred' && date && date.getTime() <= Date.now())) { action.setError(new LocalizedError(workItemMessages, 'invalidHold')); return; }
      mutate({ type: 'setHold', hold: parsed.data });
    }
  };
  const loadPreview = async () => {
    if (!base || base.phase !== 'ready' || !canTransition) return;
    setCopied(false);
    await reading.run(async () => {
      const result = await workItemApi.brief(base.id);
      if (!alive.current) return;
      if (result.revision !== base.revision || result.version !== base.version) { setConflict(true); throw new LocalizedError(workItemMessages, 'previewStale'); }
      setPreview(result);
    });
  };
  const compare = async () => {
    if (!base || busy) return;
    await reading.run(async () => { const detail = await readHistory(base.id); if (alive.current) setComparison(detail); });
  };
  const replace = async () => {
    if (!base || busy) return;
    await reading.run(async () => {
      const latest = await readHistory(base.id);
      if (!alive.current) return;
      adopt(latest.item); setHistory(latest.events); setSaved(false); setDiscard(null); setRefreshFailed(false); action.setError(''); copying.setError('');
    });
  };
  const title = base?.brief.title || t(base ? 'untitled' : 'newTitle');
  const project = projects.find(candidate => candidate.id === projectId);
  return <>
    <Modal title={title} description={project?.name ?? t('subtitle')} onClose={close} wide className="work-item-editor">
      <div className="modal-body" aria-busy={busy || undefined}>
        <div className="work-editor-meta"><div>{base && <><span className={`badge work-phase-${base.phase}`}>{t(`phase_${base.phase}`)}</span><span>{t('version', { version: base.version })}</span><span>{t('revision', { revision: base.revision })}</span></>}</div><span className={`save-state${dirty ? ' is-dirty' : ''}`} role="status">{dirty ? t('unsaved') : saved ? t('saved') : ''}</span></div>
        <ErrorNotice message={action.error} /><ErrorNotice message={reading.error} /><ErrorNotice message={copying.error} />
        {refreshFailed && <Notice warning>{t('savedRefreshFailed')} <Button disabled={busy} onClick={() => { if (base) void reading.run(async () => { await refreshSaved(base); if (alive.current) setRefreshFailed(false); }); }}>{t('refreshOnly')}</Button></Notice>}
        {changedElsewhere && <Notice warning>{t('changedElsewhere')}</Notice>}
        {conflict ? <Notice warning>{t('conflict')}</Notice> : pending && <Notice warning>{t('pending')}</Notice>}
        {(pending || conflict || changedElsewhere) && <div className="work-actions">
          {pending && !conflict && <Button disabled={busy} onClick={() => { void execute(pending); }}>{t('retry')}</Button>}
          {base && <Button disabled={busy} onClick={() => { void compare(); }}>{t('reload')}</Button>}
        </div>}
        {!base && <Field label={t('project')} required><select value={projectId} disabled={locked || !!initialProjectId} onChange={event => setProjectId(event.target.value)}><option value="">{t('chooseProject')}</option>{projects.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></Field>}
        {(base?.sourceWorkItemId || sourceWorkItemId) && <p className="field-hint">{t('sourceItem')}</p>}
        {base?.hold && <section className="work-hold-summary" aria-label={t('holdTitle')}><strong>{t(`hold_${base.hold.kind}`)}</strong><p className="preserve-lines">{base.hold.reason}</p><p className="preserve-lines"><b>{t('resumeAction')}</b> {base.hold.resumeAction}</p>{base.hold.until && <p>{t('until')}: {formatDate(base.hold.until, true, locale)}</p>}<p className="field-hint">{t(activeHold ? 'heldHint' : 'holdExpired')}</p><Button disabled={!stable} onClick={() => mutate({ type: 'resume' })}>{t('resume')}</Button></section>}
        <div className="work-editor-grid">
          <section className="work-editor-brief" aria-label={t('originalBrief')}>
            {!base || base.phase === 'draft' ? <>
              <WorkBriefFields brief={brief} disabled={locked || mode !== null} onChange={value => { setBrief(value); setSaved(false); }} />
              {(brief.acceptanceCriteria.length > 10 || brief.acceptanceCriteria.some(value => value.length > 500)) && <ErrorNotice message={t('invalidCriteria')} />}
              <div className="work-actions"><Button variant="primary" icon={Save} disabled={locked || mode !== null || !validWorkDraft(brief) || !projectId || (!!base && !briefDirty)} onClick={saveDraft}>{t('saveDraft')}</Button>
                {base && <Button disabled={!canTransition || !isWorkBriefReady(brief)} onClick={() => mutate({ type: 'confirm' })}>{t('confirm')}</Button>}</div><p className="field-hint">{t('confirmHint')}</p>
            </> : <><h3>{t('originalBrief')}</h3><WorkBriefView brief={base.brief} /></>}
          </section>
          {base && <aside className="work-resume-notes"><h3>{t('nextAction')}</h3><p className="work-next-action preserve-lines">{workNextAction(base, locale, now)}</p><h4>{t('progress')}</h4><p className="preserve-lines">{base.progress || t('emptyField')}</p><Button icon={Save} disabled={!stable || base.phase === 'done'} onClick={() => openForm('progress')}>{t('wrapUp')}</Button><p className="field-hint">{t('progressHint')}</p></aside>}
        </div>
        {base && mode === null && <div className="work-stage-actions">
          {base.phase === 'ready' && <><Button variant="primary" icon={FileText} disabled={!canTransition} onClick={() => { void loadPreview(); }}>{t('preview')}</Button><Button disabled={!canTransition} onClick={() => openForm('reviewStart')}>{t('manualReview')}</Button></>}
          {base.phase === 'awaiting_return' && <Button variant="primary" disabled={!canTransition} onClick={() => openForm('reviewStart')}>{t('startReview')}</Button>}
        </div>}
        {preview && <section className="work-preview" aria-label={t('previewTitle')}><h3>{t('previewTitle')}</h3><p>{t('previewHint')}</p><textarea aria-label={t('previewTitle')} className="work-preview-text" readOnly rows={12} value={preview.markdown} /><div className="work-actions">
          <Button icon={Copy} disabled={locked || !previewCurrent || mode !== null || briefDirty} onClick={() => { void copying.run(async () => { await copyText(preview.markdown); if (alive.current) setCopied(true); }); }}>{t('copy')}</Button>
          <Button variant="primary" disabled={!canTransition || !previewCurrent || base?.phase !== 'ready'} onClick={() => { if (previewCurrent) mutate({ type: 'dispatch', previewHash: preview.hash }); }}>{t('dispatch')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setPreview(null); setCopied(false); }}>{t('close')}</Button>
        </div>{copied && <p className="inline-success" role="status">{t('copied')}</p>}{copying.error && <Notice warning>{t('copyFallback')}</Notice>}<p className="field-hint">{t('dispatchHint')}</p></section>}
        {base && (base.phase === 'review' || base.phase === 'done') && <section className="work-review" aria-label={t('reviewTitle')}><h3>{t('reviewTitle')}</h3><p className="field-hint">{t('reviewHint')}</p><div className="work-checks">{(['self', 'partner'] as const).map(role => <div key={role}><WorkCheckView item={base} role={role} />{base.phase === 'review' && !currentWorkCheck(base, role) && <Button disabled={!canTransition || failed || !base.currentSubmissionId} onClick={() => openForm(role)}>{t(role)}: {t('recordCheck')}</Button>}</div>)}</div>
          {failed && <Notice warning>{t('failureHint')}</Notice>}
          {base.phase === 'review' && <><div className="work-actions"><Button variant="primary" icon={Check} disabled={!canTransition || !canCompleteWork(base, now)} onClick={() => setCompleting(true)}>{t('complete')}</Button>{failed && <Button disabled={!canTransition} onClick={() => openForm('revise', 'rework')}>{t('rework')}</Button>}</div><p className="field-hint">{t('completionGate')}</p></>}
        </section>}
        {base && mode && <form className="work-action-form form-stack" onSubmit={event => { event.preventDefault(); submitForm(); }}>
          <h3>{t(mode === 'progress' ? 'wrapUp' : mode === 'reviewStart' ? (base.phase === 'ready' ? 'manualReview' : 'startReview') : mode === 'hold' ? 'holdTitle' : mode === 'revise' ? 'reviseTitle' : mode)}</h3>
          {mode === 'progress' ? <><Field label={t('progress')}><textarea value={form.progress} maxLength={2000} rows={3} disabled={locked} onChange={event => updateForm('progress', event.target.value)} /></Field><Field label={t('nextAction')} required><textarea value={form.nextAction} required maxLength={2000} rows={2} disabled={locked} onChange={event => updateForm('nextAction', event.target.value)} /></Field><p className="field-hint">{t('progressHint')}</p></> : mode === 'reviewStart' ? <Field label={t('resultNote')} hint={t('resultHint')}><textarea value={form.note} maxLength={2000} rows={3} disabled={locked} onChange={event => updateForm('note', event.target.value)} /></Field> : mode === 'self' || mode === 'partner' ? <>
            {mode === 'partner' && <><Notice>{t('partnerProxy')}</Notice><Field label={t('source')} required><select value={form.source} disabled={locked} onChange={event => updateForm('source', event.target.value as typeof form.source)}>{(['message', 'call', 'in_person', 'other'] as const).map(source => <option key={source} value={source}>{t(`source_${source}`)}</option>)}</select></Field></>}
            <Field label={t('outcome')} required><select value={form.outcome} disabled={locked} onChange={event => updateForm('outcome', event.target.value as typeof form.outcome)}><option value="pass">{t('pass')}</option><option value="fail">{t('fail')}</option></select></Field><Field label={t('checkNote')} required><textarea value={form.note} required maxLength={2000} rows={3} disabled={locked} onChange={event => updateForm('note', event.target.value)} /></Field><p className="field-hint">{t('checkFrozen')}</p>
          </> : mode === 'revise' ? <><Notice>{t('reviseHint')}</Notice><p>{t(form.revisionKind === 'scope' ? 'revise' : form.revisionKind === 'rework' ? 'rework' : 'reopen')}</p><Field label={t('reason')} required><textarea value={form.reason} required maxLength={2000} rows={3} disabled={locked} onChange={event => updateForm('reason', event.target.value)} /></Field></> : <>
            <p className="field-hint">{t('holdHint')}</p><Field label={t('holdKind')}><select value={form.kind} disabled={locked} onChange={event => updateForm('kind', event.target.value as typeof form.kind)}>{(['deferred', 'waiting', 'paused'] as const).map(kind => <option key={kind} value={kind}>{t(`hold_${kind}`)}</option>)}</select></Field>
            <Field label={t('holdReason')} required><textarea value={form.reason} required maxLength={2000} rows={2} disabled={locked} onChange={event => updateForm('reason', event.target.value)} /></Field><Field label={t('resumeAction')} required><textarea value={form.resumeAction} required maxLength={2000} rows={2} disabled={locked} onChange={event => updateForm('resumeAction', event.target.value)} /></Field><Field label={t('until')} required={form.kind === 'deferred'}><input type="datetime-local" value={form.until} required={form.kind === 'deferred'} disabled={locked} onChange={event => updateForm('until', event.target.value)} /></Field>
          </>}
          <div className="work-actions"><Button type="submit" variant="primary" disabled={locked || ((mode === 'self' || mode === 'partner') && failed)}>{t(mode === 'progress' ? 'saveProgress' : mode === 'reviewStart' ? 'startReview' : mode === 'revise' ? 'reviseTitle' : mode === 'hold' ? 'saveHold' : 'recordCheck')}</Button><Button disabled={locked} onClick={closeForm}>{t('back')}</Button></div>
        </form>}
        {base && <details className="work-secondary-actions"><summary>{t('hold')} / {t('reviseTitle')}</summary><div className="work-actions">
          {base.phase !== 'done' && <Button disabled={!stable || !!base.hold} onClick={() => openForm('hold')}>{t('hold')}</Button>}
          {base.phase !== 'draft' && base.phase !== 'done' && <Button disabled={!canTransition || failed} onClick={() => openForm('revise', 'scope')}>{t('revise')}</Button>}
          {(base.phase === 'awaiting_return' || base.phase === 'review') && <Button disabled={!canTransition} onClick={() => openForm('revise', 'rework')}>{t('rework')}</Button>}
          {base.phase === 'done' && <Button disabled={!canTransition} onClick={() => openForm('revise', 'reopen')}>{t('reopen')}</Button>}
          {onNewFrom && <Button icon={Plus} disabled={!stable} onClick={() => onNewFrom(base)}>{t('newIdea')}</Button>}
        </div></details>}
        {comparison && <section className="work-comparison"><h3>{t('reloadTitle')}</h3><p>{t('revision', { revision: comparison.item.revision })} · {t('version', { version: comparison.item.version })} · {t(`phase_${comparison.item.phase}`)}</p><h4>{t('titleField')}</h4><p className="preserve-lines">{comparison.item.brief.title || t('untitled')}</p><WorkBriefView brief={comparison.item.brief} /><h4>{t('progress')}</h4><p className="preserve-lines">{comparison.item.progress || t('emptyField')}</p><h4>{t('nextAction')}</h4><p className="preserve-lines">{comparison.item.nextAction || t('emptyField')}</p>{comparison.item.hold && <><h4>{t(`hold_${comparison.item.hold.kind}`)}</h4><p className="preserve-lines">{comparison.item.hold.reason}</p><p className="preserve-lines">{comparison.item.hold.resumeAction}</p></>}{(comparison.item.phase === 'review' || comparison.item.phase === 'done') && <div className="work-checks"><WorkCheckView item={comparison.item} role="self" /><WorkCheckView item={comparison.item} role="partner" /></div>}<Button disabled={busy} onClick={() => { reading.setError(''); setDiscard('replace'); }}>{t('replace')}</Button></section>}
        {base && <details className="work-history"><summary><History size={15} aria-hidden="true" />{t('history')}</summary><p className="field-hint">{t('historyHint')}</p><Button icon={RefreshCw} disabled={busy} onClick={() => { void reading.run(() => readHistory(base.id)); }}>{t('loadHistory')}</Button>{history ? <ol>{[...history].reverse().map(event => <li key={event.id}><details><summary>{t(workEventLabel(event.type))} — {t('version', { version: event.version })} — {formatDate(event.at, true, locale)}</summary><pre aria-label={t('snapshot')}>{typeof event.payload.markdown === 'string' ? event.payload.markdown : JSON.stringify(event.payload, null, 2)}</pre></details></li>)}</ol> : <p className="field-hint">{t('noHistory')}</p>}</details>}
      </div>
      <footer className="modal-footer"><Button disabled={busy} onClick={close}>{t('close')}</Button></footer>
    </Modal>
    {discard && <ConfirmDialog title={t(discard === 'replace' ? 'replaceTitle' : 'dirtyTitle')} confirmLabel={t(discard === 'replace' ? 'replace' : 'discard')} danger busy={reading.busy} error={discard === 'replace' ? reading.error : undefined} onClose={() => setDiscard(null)} onConfirm={() => { if (discard === 'replace') void replace(); else if (discard === 'form') { setForm(formBase); setMode(null); setDiscard(null); } else onClose(); }}><p>{t(discard === 'replace' ? 'replaceDescription' : 'dirtyDescription')}</p></ConfirmDialog>}
    {completing && base && <ConfirmDialog title={t('completeTitle')} confirmLabel={t('complete')} busy={action.busy} confirmDisabled={!canTransition || !canCompleteWork(base, now)} onClose={() => setCompleting(false)} onConfirm={() => { setCompleting(false); mutate({ type: 'complete' }); }}><p>{t('completeHint')}</p><WorkCheckView item={base} role="self" /><WorkCheckView item={base} role="partner" /></ConfirmDialog>}
  </>;
}
