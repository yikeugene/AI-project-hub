import { useEffect, useState } from 'react';
import { Download, RotateCcw, Save } from 'lucide-react';
import { MEMORY_FIELDS, getMemoryLabels, type Project, type ProjectMemory } from '../../shared/types';
import { api } from '../api';
import { desktopBridge, downloadText, formatDate, useAction, useBeforeUnload } from '../hooks';
import { Button, ConfirmDialog, ErrorNotice, Field, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { memoryMessages } from '../locales/panels-memory';

/** English compatibility export. Rendered labels must use getMemoryLabels(locale). */
export const memoryLabels = getMemoryLabels('en');
const placeholderKeys = {
  overview: 'overviewPlaceholder', status: 'statusPlaceholder', architecture: 'architecturePlaceholder',
  completed: 'completedPlaceholder', pending: 'pendingPlaceholder', blockers: 'blockersPlaceholder',
  decisions: 'decisionsPlaceholder', nextActions: 'nextActionsPlaceholder', notes: 'notesPlaceholder',
} as const;
export function MemoryPanel({ project, onChange, onDirtyChange, onBusyChange, blockedMessage }: { project: Project; onChange: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; blockedMessage?: string }) {
  const locale = useLocale(); const t = useT(memoryMessages); const labels = getMemoryLabels(locale);
  const [base, setBase] = useState({ memory: project.memory, revision: project.revision });
  const [draft, setDraft] = useState<ProjectMemory>(project.memory);
  const [discard, setDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const action = useAction(); const downloading = useAction();
  const [downloadMessage, setDownloadMessage] = useState<'savedDraft' | 'downloadRequested' | 'saveCancelled' | ''>('');
  const download = async () => {
    setDownloadMessage('');
    const text = `# ${t('draftHeading', { name: project.name })}\n\n${MEMORY_FIELDS.map(key => `## ${labels[key]}\n\n${draft[key] || t('notFilled')}`).join('\n\n')}\n`;
    const result = await downloading.run(() => downloadText(text, 'project-memory-draft.md'));
    if (result.ok) setDownloadMessage(result.value ? (desktopBridge() ? 'savedDraft' : 'downloadRequested') : 'saveCancelled');
  };
  const dirty = JSON.stringify(base.memory) !== JSON.stringify(draft);
  const changedElsewhere = dirty && project.revision !== base.revision;
  useBeforeUnload(dirty);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  useEffect(() => {
    if (!dirty && project.revision >= base.revision) { setBase({ memory: project.memory, revision: project.revision }); setDraft(project.memory); }
  }, [project.memory, project.revision, dirty, base.revision]);
  const save = async () => {
    if (blockedMessage) return;
    const response = await action.run(() => api.saveMemory(project.id, base.revision, draft));
    if (response.ok) { setDraft(response.value.memory); setBase({ memory: response.value.memory, revision: response.value.revision }); setSaved(true); }
    await onChange();
  };
  return <section className="memory-panel"><SectionHeading title={t('title')} subtitle={t('subtitle')}><span className={`save-state ${dirty ? 'is-dirty' : ''}`} role="status">{dirty ? t('unsaved') : saved ? t('saved') : t('synced')}</span></SectionHeading>
    <div className="memory-toolbar"><span>{t('revision', { revision: base.revision })}<span className="toolbar-divider" />{project.memoryUpdatedAt ? t('lastSaved', { date: formatDate(project.memoryUpdatedAt, true, locale) }) : t('notCreated')}</span><div><Button variant="ghost" icon={Download} busy={downloading.busy} onClick={() => { void download(); }}>{t('downloadDraft')}</Button><Button icon={RotateCcw} disabled={!dirty || action.busy} onClick={() => setDiscard(true)}>{t('discard')}</Button><Button variant="primary" icon={Save} busy={action.busy} disabled={!dirty || !!blockedMessage} onClick={() => { void save(); }}>{t('save')}</Button></div></div>
    <ErrorNotice message={action.error} /><ErrorNotice message={downloading.error} />
    {downloadMessage && <p className="field-hint" role="status">{t(downloadMessage)}</p>}
    {blockedMessage && <Notice warning>{blockedMessage}</Notice>}
    {changedElsewhere && <Notice warning>{t('changedElsewhere')}</Notice>}
    <div className="memory-fields">{MEMORY_FIELDS.map((key, index) => <div className={`memory-field memory-field-${key}`} key={key}><Field label={labels[key]}><textarea maxLength={20000} aria-label={labels[key]} value={draft[key]} placeholder={t(placeholderKeys[key])} rows={index < 2 ? 4 : 5} disabled={action.busy || !!blockedMessage} onChange={e => { setDraft(current => ({ ...current, [key]: e.target.value })); setSaved(false); }} /></Field></div>)}</div>
    <p className="field-hint">{t('privacy')}</p>
    {discard && <ConfirmDialog title={t('discardTitle')} confirmLabel={t('discardConfirm')} danger onClose={() => setDiscard(false)} onConfirm={() => { setDraft(project.memory); setBase({ memory: project.memory, revision: project.revision }); setSaved(false); action.setError(''); setDiscard(false); }}><p>{t('discardDescription')}</p></ConfirmDialog>}
  </section>;
}
