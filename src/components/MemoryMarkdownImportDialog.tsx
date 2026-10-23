import { useEffect, useMemo, useRef, useState } from 'react';
import { FileInput } from 'lucide-react';
import { LocalizedError } from '../../shared/i18n';
import { MAX_MARKDOWN_BYTES } from '../../shared/markdown-text';
import { previewMemoryMarkdown } from '../../shared/memory-markdown';
import { getMemoryLabels, type ProjectMemory } from '../../shared/types';
import { errorMessage } from '../api';
import { useBeforeUnload } from '../hooks';
import { useLocale, useT } from '../i18n';
import { markdownImportMessages } from '../locales/markdown-import';
import { memoryMarkdownMessages } from '../locales/memory-markdown';
import { createMarkdownInputGuard, markdownTextBytes, readMarkdownFile } from '../markdown-ui';
import { ChangePreview } from './ChangePreview';
import { Button, ConfirmDialog, ErrorNotice, Field, Modal, Notice } from './ui';

type Preview = ReturnType<typeof previewMemoryMarkdown>;
type Snapshot = { preview: Preview; text: string; version: number; binding: string };
export function MemoryMarkdownImportDialog({ projectId, projectName, revision, draft, binding, blocked, onApply, onClose, onDirtyChange, onBusyChange }: {
  projectId: string; projectName: string; revision: number; draft: ProjectMemory; binding: string; blocked: boolean;
  onApply: (memory: ProjectMemory) => void; onClose: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const t = useT(memoryMarkdownMessages); const m = useT(markdownImportMessages); const locale = useLocale(); const labels = getMemoryLabels(locale);
  const [text, setText] = useState(''); const [filename, setFilename] = useState('');
  const [reading, setReading] = useState(false); const [error, setError] = useState<unknown>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [confirming, setConfirming] = useState(false); const [discard, setDiscard] = useState(false);
  const guard = useRef(createMarkdownInputGuard());
  const dirty = text !== ''; const bytes = useMemo(() => markdownTextBytes(text), [text]);
  const oversized = bytes > MAX_MARKDOWN_BYTES;
  const current = !!snapshot && snapshot.text === text && snapshot.binding === binding && guard.current.isCurrent(snapshot.version);
  useBeforeUnload(dirty || reading);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(reading); }, [reading, onBusyChange]);
  useEffect(() => () => { guard.current.advance(); onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  const invalidate = () => { setSnapshot(null); setConfirming(false); setError(null); return guard.current.advance(); };
  const changeText = (value: string) => { invalidate(); setReading(false); setText(value); setFilename(''); };
  const selectFile = async (file?: File) => {
    if (!file) return;
    const version = invalidate(); setReading(true);
    try {
      const value = await readMarkdownFile(file);
      if (guard.current.isCurrent(version)) { setText(value); setFilename(file.name); }
    } catch (cause) { if (guard.current.isCurrent(version)) setError(cause); }
    finally { if (guard.current.isCurrent(version)) setReading(false); }
  };
  const preview = () => {
    if (reading || oversized || blocked || !text.trim()) return;
    const version = invalidate();
    try { setSnapshot({ preview: previewMemoryMarkdown(text, projectId, draft), text, version, binding }); }
    catch (cause) { setError(cause); }
  };
  const apply = () => {
    if (reading || blocked) return;
    if (!snapshot || !current) { setError(new LocalizedError(memoryMarkdownMessages, 'changed')); setConfirming(false); return; }
    if (!snapshot.preview.changes.length) return;
    onApply({ ...draft, ...snapshot.preview.memory });
    onDirtyChange(false); onClose();
  };
  const close = () => { if (reading) return; if (dirty) setDiscard(true); else onClose(); };
  return <><Modal title={t('importOpen')} description={t('description')} wide className="memory-markdown-dialog" onClose={close}>
    <div className="modal-body markdown-import-body">
      <Notice>{t('formatHint')}</Notice><p>{t('target', { name: projectName })}</p><p className="field-hint device-id">{t('identity', { id: projectId, revision })}</p>
      <Field label={m('file')} hint={m('fileHint')}><input type="file" accept=".md,.markdown" autoFocus disabled={blocked} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void selectFile(file); }} /></Field>
      {filename && <p className="field-hint">{m('selectedFile', { name: filename, bytes })}</p>}{reading && <p role="status">{m('reading')}</p>}
      <Field label={m('text')}><textarea className="memory-markdown-input markdown-import-input" value={text} rows={9} spellCheck={false} disabled={blocked} aria-invalid={oversized || undefined} placeholder={t('placeholder')} onChange={event => changeText(event.target.value)} /></Field>
      <div className="markdown-import-toolbar"><span className="field-hint">{m('textSize', { bytes, max: MAX_MARKDOWN_BYTES })}</span><Button icon={FileInput} className="memory-markdown-preview" disabled={reading || oversized || blocked || !text.trim()} onClick={preview}>{m('preview')}</Button></div>
      <p className="field-hint">{t('draftHint')}</p><ErrorNotice message={oversized ? m('tooLarge') : errorMessage(error, locale)} />
      {snapshot && !current && <Notice warning>{t('changed')}</Notice>}
      {snapshot && current && <section aria-label={t('reviewTitle')}>
        {snapshot.preview.source.revision !== revision && <Notice warning>{t('revisionWarning', { source: snapshot.preview.source.revision, local: revision })}</Notice>}
        {!!snapshot.preview.skipped.length && <><h3>{m('skipped')}</h3><ul>{snapshot.preview.skipped.map(item => <li key={item.field}>{labels[item.field]} — {m(item.reason)}</li>)}</ul></>}
        {snapshot.preview.changes.length ? <ChangePreview changes={snapshot.preview.changes.map(change => ({ ...change, label: labels[change.key] }))} beforeLabel={t('currentDraft')} afterLabel={m('after')} /> : <Notice>{t('noChanges')}</Notice>}
      </section>}
      <p className="field-hint">{t('sharing')}</p>
    </div>
    <footer className="modal-footer"><Button disabled={reading} onClick={close}>{m('cancel')}</Button><Button className="memory-markdown-review" variant="primary" disabled={blocked || reading || !current || !snapshot?.preview.changes.length} onClick={() => setConfirming(true)}>{m('review')}</Button></footer>
  </Modal>
    {confirming && snapshot && <ConfirmDialog title={t('confirmTitle')} confirmLabel={t('apply')} confirmDisabled={blocked || reading || !current} onClose={() => setConfirming(false)} onConfirm={apply}>
      <p>{t('confirmDescription', { name: projectName, count: snapshot.preview.changes.length })}</p><Notice warning>{t('binding')}</Notice><p>{t('sharing')}</p>
    </ConfirmDialog>}
    {discard && <ConfirmDialog title={m('discardTitle')} confirmLabel={m('discard')} danger onClose={() => setDiscard(false)} onConfirm={onClose}><p>{t('discardDescription')}</p></ConfirmDialog>}
  </>;
}
