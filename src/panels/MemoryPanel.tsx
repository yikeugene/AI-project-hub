import { useEffect, useState } from 'react';
import { Copy, Download, FileInput, RotateCcw, Save } from 'lucide-react';
import { MEMORY_FIELDS, getMemoryLabels, type Project, type ProjectMemory } from '../../shared/types';
import { buildMemoryFillPrompt, formatMemoryMarkdown } from '../../shared/memory-markdown';
import { api } from '../api';
import { desktopBridge, downloadText, formatDate, useAction, useBeforeUnload } from '../hooks';
import { MarkdownPromptDialog } from '../components/MarkdownPromptDialog';
import { MemoryMarkdownImportDialog } from '../components/MemoryMarkdownImportDialog';
import { Button, ConfirmDialog, ErrorNotice, Field, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { memoryMessages } from '../locales/panels-memory';
import { memoryMarkdownMessages } from '../locales/memory-markdown';

/** English compatibility export. Rendered labels must use getMemoryLabels(locale). */
export const memoryLabels = getMemoryLabels('en');
const placeholderKeys = {
  overview: 'overviewPlaceholder', status: 'statusPlaceholder', architecture: 'architecturePlaceholder',
  completed: 'completedPlaceholder', pending: 'pendingPlaceholder', blockers: 'blockersPlaceholder',
  decisions: 'decisionsPlaceholder', nextActions: 'nextActionsPlaceholder', notes: 'notesPlaceholder',
} as const;
export function MemoryPanel({ project, onChange, onDirtyChange, onBusyChange, blockedMessage, importBlocked = false }: { project: Project; onChange: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; blockedMessage?: string; importBlocked?: boolean }) {
  const locale = useLocale(); const t = useT(memoryMessages); const m = useT(memoryMarkdownMessages); const labels = getMemoryLabels(locale);
  const [base, setBase] = useState({ memory: project.memory, revision: project.revision });
  const [draft, setDraft] = useState<ProjectMemory>(project.memory);
  const [discard, setDiscard] = useState(false); const [saved, setSaved] = useState(false);
  const [importing, setImporting] = useState(false); const [importDirty, setImportDirty] = useState(false); const [importBusy, setImportBusy] = useState(false);
  const [imported, setImported] = useState(false); const [copyBusy, setCopyBusy] = useState(false);
  const [prompt, setPrompt] = useState<{ text: string; binding: string } | null>(null);
  const action = useAction(); const downloading = useAction(); const prompting = useAction();
  const [downloadMessage, setDownloadMessage] = useState<'savedDraft' | 'downloadRequested' | 'saveCancelled' | ''>('');
  const dirty = imported || JSON.stringify(base.memory) !== JSON.stringify(draft);
  const busy = action.busy || downloading.busy || prompting.busy || copyBusy || importBusy;
  const binding = JSON.stringify([project.id, project.name, base.revision, project.revision, ...MEMORY_FIELDS.map(field => draft[field])]);
  const document = () => formatMemoryMarkdown({ projectId: project.id, projectName: project.name, revision: base.revision }, draft, locale);
  const filename = `project-memory-${project.id.slice(0, 8)}.md`;
  const download = async () => {
    setDownloadMessage('');
    const result = await downloading.run(async () => downloadText(document(), filename));
    if (result.ok) setDownloadMessage(result.value ? (desktopBridge() ? 'savedDraft' : 'downloadRequested') : 'saveCancelled');
  };
  const preparePrompt = async () => {
    const captured = binding;
    const result = await prompting.run(async () => buildMemoryFillPrompt(document(), locale));
    if (result.ok) setPrompt({ text: result.value, binding: captured });
  };
  const changedElsewhere = dirty && project.revision !== base.revision;
  useBeforeUnload(dirty || importDirty || busy);
  useEffect(() => { onDirtyChange(dirty || importDirty); }, [dirty, importDirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    if (!dirty && project.revision >= base.revision) { setBase({ memory: project.memory, revision: project.revision }); setDraft(project.memory); }
  }, [project.memory, project.revision, dirty, base.revision]);
  const save = async () => {
    if (blockedMessage || busy || importing || prompt) return;
    const response = await action.run(() => api.saveMemory(project.id, base.revision, draft));
    if (response.ok) { setDraft(response.value.memory); setBase({ memory: response.value.memory, revision: response.value.revision }); setSaved(true); setImported(false); }
    await onChange();
  };
  return <section className="memory-panel"><SectionHeading title={t('title')} subtitle={t('subtitle')}><span className={`save-state ${dirty ? 'is-dirty' : ''}`} role="status">{dirty ? t('unsaved') : saved ? t('saved') : t('synced')}</span></SectionHeading>
    <div className="memory-toolbar"><span>{t('revision', { revision: base.revision })}<span className="toolbar-divider" />{project.memoryUpdatedAt ? t('lastSaved', { date: formatDate(project.memoryUpdatedAt, true, locale) }) : t('notCreated')}</span><div>
      <Button className="memory-prompt-open" variant="ghost" icon={Copy} busy={prompting.busy} disabled={busy} onClick={() => { void preparePrompt(); }}>{m('promptOpen')}</Button>
      <Button className="memory-import-open" icon={FileInput} disabled={busy || !!blockedMessage || importBlocked} onClick={() => setImporting(true)}>{m('importOpen')}</Button>
      <Button variant="ghost" icon={Download} busy={downloading.busy} disabled={busy} onClick={() => { void download(); }}>{t('downloadDraft')}</Button>
      <Button icon={RotateCcw} disabled={!dirty || busy} onClick={() => setDiscard(true)}>{t('discard')}</Button><Button className="memory-save" variant="primary" icon={Save} busy={action.busy} disabled={!dirty || busy || !!blockedMessage} onClick={() => { void save(); }}>{t('save')}</Button>
    </div></div>
    <ErrorNotice message={action.error} /><ErrorNotice message={downloading.error} /><ErrorNotice message={prompting.error} />
    {downloadMessage && <p className="field-hint" role="status">{t(downloadMessage)}</p>}
    {imported && <Notice>{m('applied')}</Notice>}
    {blockedMessage && <Notice warning>{blockedMessage}</Notice>}
    {changedElsewhere && <Notice warning>{t('changedElsewhere')}</Notice>}
    <div className="memory-fields">{MEMORY_FIELDS.map((key, index) => <div className={`memory-field memory-field-${key}`} key={key}><Field label={labels[key]}><textarea maxLength={20000} aria-label={labels[key]} value={draft[key]} placeholder={t(placeholderKeys[key])} rows={index < 2 ? 4 : 5} disabled={busy || !!blockedMessage} onChange={e => { setDraft(current => ({ ...current, [key]: e.target.value })); setSaved(false); }} /></Field></div>)}</div>
    <p className="field-hint">{t('privacy')} {m('sharing')}</p>
    {prompt && <MarkdownPromptDialog text={prompt.text} filename={filename} isCurrent={() => prompt.binding === binding} notice={m('promptNotice')} unavailableMessage={m('promptStale')} onClose={() => setPrompt(null)} onBusyChange={setCopyBusy} />}
    {importing && <MemoryMarkdownImportDialog projectId={project.id} projectName={project.name} revision={base.revision} draft={draft} binding={binding} blocked={!!blockedMessage || importBlocked || action.busy} onApply={memory => { setDraft(memory); setSaved(false); setImported(true); action.setError(null); }} onClose={() => { setImporting(false); setImportDirty(false); setImportBusy(false); }} onDirtyChange={setImportDirty} onBusyChange={setImportBusy} />}
    {discard && <ConfirmDialog title={t('discardTitle')} confirmLabel={t('discardConfirm')} danger onClose={() => setDiscard(false)} onConfirm={() => { setDraft(project.memory); setBase({ memory: project.memory, revision: project.revision }); setSaved(false); setImported(false); action.setError(''); setDiscard(false); }}><p>{t('discardDescription')}</p></ConfirmDialog>}
  </section>;
}
