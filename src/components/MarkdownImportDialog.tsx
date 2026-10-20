import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, FileInput, RefreshCw } from 'lucide-react';
import { LocalizedError } from '../../shared/i18n';
import { MAX_MARKDOWN_BYTES, type MarkdownImportApplyInput, type MarkdownImportPreview } from '../../shared/markdown-import';
import { getMemoryLabels } from '../../shared/types';
import { errorMessage, markdownApi } from '../api';
import { useAction, useBeforeUnload } from '../hooks';
import { useLocale, useT } from '../i18n';
import { markdownImportMessages } from '../locales/markdown-import';
import { createMarkdownInputGuard, markdownTextBytes, readMarkdownFile } from '../markdown-ui';
import { ChangePreview } from './ChangePreview';
import { Button, ConfirmDialog, ErrorNotice, Field, Modal, Notice } from './ui';

type Snapshot = { text: string; version: number; preview: MarkdownImportPreview };
type Confirmation = { snapshot: Snapshot; input: MarkdownImportApplyInput };
type Operation = { kind: 'read' | 'preview' | 'apply' | 'refresh'; version: number };

export function MarkdownImportDialog({ onClose, onImported, onDirtyChange, onBusyChange }: {
  onClose: () => void; onImported: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const t = useT(markdownImportMessages); const locale = useLocale(); const inputId = useId();
  const [text, setText] = useState('');
  const [acceptedText, setAcceptedText] = useState('');
  const [fileInfo, setFileInfo] = useState<{ name: string; bytes: number; edited: boolean } | null>(null);
  const [inputVersion, setInputVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [discard, setDiscard] = useState(false);
  const [applied, setApplied] = useState<{ name: string } | null>(null);
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const guard = useRef(createMarkdownInputGuard());
  const alive = useRef(true);
  const operation = useRef<Operation | null>(null);
  const previewAction = useAction(inputVersion); const applyAction = useAction(inputVersion); const refreshAction = useAction();
  const bytes = useMemo(() => markdownTextBytes(text), [text]);
  const oversized = bytes > MAX_MARKDOWN_BYTES;
  const dirty = text !== acceptedText;
  const busy = reading || previewAction.busy || applyAction.busy || refreshAction.busy;
  const locked = applyAction.busy || refreshAction.busy;
  useBeforeUnload(dirty || busy);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; guard.current.advance(); onDirtyChange(false); onBusyChange(false); };
  }, [onDirtyChange, onBusyChange]);

  const invalidate = () => {
    const version = guard.current.advance();
    setInputVersion(version); setSnapshot(null); setConfirmation(null);
    setInvalidated(!!snapshot || previewAction.busy || invalidated);
    setReadError(null); previewAction.setError(null); applyAction.setError(null);
    return version;
  };
  const changeText = (value: string) => {
    if (operation.current?.kind === 'apply' || operation.current?.kind === 'refresh') return;
    invalidate();
    // An input edit supersedes a pending file read, even if its promise cannot be cancelled.
    if (operation.current?.kind === 'read') { operation.current = null; setReading(false); }
    setText(value); setFileInfo(previous => previous ? { ...previous, edited: true } : null);
    setApplied(null); setRefreshNeeded(false); refreshAction.setError(null);
  };
  const selectFile = async (file: File | undefined) => {
    // A cancelled native picker must not erase the draft or invalidate its preview.
    if (!file || (operation.current && operation.current.kind !== 'read')) return;
    const version = invalidate();
    const active: Operation = { kind: 'read', version }; operation.current = active; setReading(true);
    try {
      const source = await readMarkdownFile(file);
      if (!alive.current || !guard.current.isCurrent(version)) return;
      setText(source); setFileInfo({ name: file.name, bytes: markdownTextBytes(source), edited: false });
      setApplied(null); setRefreshNeeded(false); refreshAction.setError(null);
    } catch (error) {
      if (alive.current && guard.current.isCurrent(version)) setReadError(error);
    } finally {
      if (operation.current === active) { operation.current = null; if (alive.current) setReading(false); }
    }
  };
  const preview = async () => {
    if (operation.current || !text.trim() || oversized || (applied && !dirty)) return;
    const capturedText = text; const version = guard.current.advance();
    const active: Operation = { kind: 'preview', version }; operation.current = active;
    setSnapshot(null); setConfirmation(null); setInvalidated(false); setReadError(null); applyAction.setError(null);
    const result = await previewAction.run(() => markdownApi.preview(capturedText));
    if (alive.current && guard.current.isCurrent(version) && result.ok) setSnapshot({ text: capturedText, version, preview: result.value });
    if (operation.current === active) operation.current = null;
  };
  const requestConfirmation = () => {
    if (operation.current || !snapshot?.preview.canApply || snapshot.text !== text || !guard.current.isCurrent(snapshot.version)) return;
    const { projectId, revision, hash, digest } = snapshot.preview;
    setConfirmation({ snapshot, input: { text: snapshot.text, projectId, revision, hash, digest, confirm: true } });
  };
  const refreshCommitted = async () => {
    const result = await refreshAction.run(onImported);
    if (alive.current) setRefreshNeeded(!result.ok);
  };
  const apply = async () => {
    const captured = confirmation;
    if (operation.current || !captured) return;
    const active: Operation = { kind: 'apply', version: captured.snapshot.version }; operation.current = active;
    const result = await applyAction.run(async () => {
      if (captured.snapshot !== snapshot || captured.input.text !== text || !guard.current.isCurrent(captured.snapshot.version)) throw new LocalizedError(markdownImportMessages, 'changedError');
      return markdownApi.apply(captured.input);
    });
    if (!alive.current) { operation.current = null; return; }
    setConfirmation(null); setSnapshot(null);
    if (result.ok) {
      // The write has committed. Clear dirty state BEFORE running any fallible refresh callback.
      setAcceptedText(captured.input.text); onDirtyChange(false);
      setApplied({ name: result.value.name }); setInvalidated(false); setRefreshNeeded(false);
      await refreshCommitted();
    } else {
      guard.current.advance(); setInvalidated(true);
    }
    if (operation.current === active) operation.current = null;
  };
  const retryRefresh = async () => {
    if (operation.current || !applied) return;
    const active: Operation = { kind: 'refresh', version: inputVersion }; operation.current = active;
    await refreshCommitted();
    if (operation.current === active) operation.current = null;
  };
  const close = () => { if (operation.current || busy) return; if (dirty) setDiscard(true); else onClose(); };

  return <><Modal title={t('open')} description={t('description')} wide className="markdown-import-dialog" onClose={close}>
    <div className="modal-body markdown-import-body">
      <Notice>{t('formatHint')}</Notice>
      <Field label={t('file')} hint={t('fileHint')}><input type="file" className="markdown-import-file" accept=".md,.markdown" autoFocus disabled={locked || previewAction.busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void selectFile(file); }} /></Field>
      {fileInfo && <p className="field-hint markdown-import-file-info">{t('selectedFile', { name: fileInfo.name, bytes: fileInfo.bytes.toLocaleString(locale) })}{fileInfo.edited && <span>{t('editedFile')}</span>}</p>}
      {reading && <p className="field-hint" role="status">{t('reading')}</p>}
      <label className="field" htmlFor={inputId}><span className="field-label">{t('text')}</span><textarea id={inputId} className="markdown-import-input" value={text} rows={9} spellCheck={false} autoComplete="off" disabled={locked} aria-describedby={`${inputId}-size`} aria-invalid={oversized || undefined} placeholder={t('placeholder')} onChange={event => changeText(event.target.value)} /></label>
      <div className="markdown-import-toolbar"><span id={`${inputId}-size`} className="field-hint">{t('textSize', { bytes: bytes.toLocaleString(locale), max: MAX_MARKDOWN_BYTES.toLocaleString(locale) })}</span><Button className="markdown-import-preview-button" icon={FileInput} busy={previewAction.busy} disabled={busy || !text.trim() || oversized || !!applied && !dirty} onClick={() => { void preview(); }}>{t('preview')}</Button></div>
      <p className="field-hint" role="status">{invalidated ? t('previewChanged') : t('draftHint')}</p>
      <ErrorNotice message={oversized ? t('tooLarge') : errorMessage(readError, locale)} />
      <ErrorNotice message={previewAction.error} />
      {!confirmation && <ErrorNotice message={applyAction.error} />}
      {applied && <section className="markdown-import-success" aria-live="polite"><p className="inline-success" role="status"><Check size={16} aria-hidden="true" />{t('success', { name: applied.name })}</p>
        {refreshNeeded ? <><Notice warning>{t('refreshFailed')}</Notice><ErrorNotice message={refreshAction.error} /><Button className="markdown-import-refresh" icon={RefreshCw} busy={refreshAction.busy} onClick={() => { void retryRefresh(); }}>{t('retryRefresh')}</Button></> : !refreshAction.busy && <p className="field-hint">{t('refreshed')}</p>}
      </section>}
      {snapshot && <MarkdownImportPreviewView preview={snapshot.preview} />}
    </div>
    <footer className="modal-footer"><Button disabled={busy} onClick={close}>{t(applied ? 'close' : 'cancel')}</Button><Button className="markdown-import-confirm-button" variant="primary" disabled={busy || !snapshot?.preview.canApply} onClick={requestConfirmation}>{t('review')}</Button></footer>
  </Modal>
    {confirmation && <ConfirmDialog title={t('confirmTitle')} confirmLabel={t('confirm')} busy={applyAction.busy || refreshAction.busy} error={applyAction.error} onClose={() => setConfirmation(null)} onConfirm={() => { void apply(); }}>
      <p>{t('confirmDescription', { name: confirmation.snapshot.preview.projectName, count: confirmation.snapshot.preview.changes.length })}</p><p className="device-id">{confirmation.input.projectId}</p>
      <Notice>{t('confirmBinding', { revision: confirmation.input.revision })}</Notice><p>{t('unchanged')}</p>
      {!!confirmation.snapshot.preview.sharing.length && <Notice warning>{t('sharingHint')}</Notice>}
    </ConfirmDialog>}
    {discard && <ConfirmDialog title={t('discardTitle')} confirmLabel={t('discard')} danger onClose={() => setDiscard(false)} onConfirm={onClose}><p>{t('discardDescription')}</p></ConfirmDialog>}
  </>;
}

/** A server-matched target, never a project picker. All source/diff values remain escaped text. */
export function MarkdownImportPreviewView({ preview }: { preview: MarkdownImportPreview }) {
  const t = useT(markdownImportMessages); const locale = useLocale();
  const fieldLabels: Record<string, string> = { ...getMemoryLabels(locale), nextAction: t('nextAction') };
  const { source } = preview;
  return <section className="markdown-import-preview" aria-label={t('previewTitle')}>
    <header className="markdown-import-target"><span className="field-hint">{t('target')}</span><h3>{preview.projectName}</h3><dl className="snapshot-meta"><div><dt>{t('projectId')}</dt><dd className="device-id">{preview.projectId}</dd></div><div><dt>{t('localRevision')}</dt><dd>{preview.revision}</dd></div></dl></header>
    <section className="markdown-import-source"><h3>{t('source')}</h3><p className="field-hint">{t('sourceHint')}</p><dl className="snapshot-meta"><div><dt>{t('sourceProject')}</dt><dd>{source.projectName}</dd></div><div><dt>{t('sourceRevision')}</dt><dd>{source.revision}</dd></div><div><dt>{t('sourceVersion')}</dt><dd>{source.version}</dd></div><div><dt>{t('sourceGroup')}</dt><dd>{source.groupLabel}<small className="device-id">{source.profileId}</small></dd></div><div><dt>{t('sourceOwner')}</dt><dd>{source.ownerName}<small className="device-id">{source.ownerDeviceId}</small></dd></div></dl></section>
    {preview.sourceRevisionDiffers && <Notice warning>{t('revisionWarning', { source: source.revision, local: preview.revision })}</Notice>}
    {!!preview.skipped.length && <section className="markdown-import-skipped"><h3>{t('skipped')}</h3><p className="field-hint">{t('skippedHint')}</p><ul>{preview.skipped.map(item => <li key={item.field}><span>{fieldLabels[item.field]}</span><span>{t(item.reason)}</span></li>)}</ul></section>}
    <section className="markdown-import-sharing"><h3>{t('sharing')}</h3>{preview.sharing.length ? <><Notice warning>{t('sharingHint')}</Notice><ul>{preview.sharing.map(item => <li key={item.profileId}><strong>{item.label}</strong><small className="device-id">{item.profileId}</small><span>{item.fields.map(field => fieldLabels[field]).join(' · ')}</span><span className="field-hint">{t(item.paused ? 'sharingPaused' : 'sharingActive')}</span></li>)}</ul></> : <p className="field-hint">{t('sharingNone')}</p>}</section>
    {preview.canApply ? <><h3>{t('changes', { count: preview.changes.length })}</h3><ChangePreview changes={preview.changes.map(change => ({ ...change, label: fieldLabels[change.key] ?? change.label }))} beforeLabel={t('before')} afterLabel={t('after')} /></> : <div className="markdown-import-noop" role="status"><Notice>{t('noChanges')}</Notice></div>}
    <p className="field-hint">{t('unchanged')}</p>
  </section>;
}
