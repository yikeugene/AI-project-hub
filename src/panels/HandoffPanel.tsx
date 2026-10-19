import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, Check, Copy, Download, FileText, FolderOutput, MessageSquare, RefreshCw } from 'lucide-react';
import { DESKTOP_APP_LABELS, MEMORY_FIELDS, getMemoryLabels, type DesktopApp, type DesktopCapabilities, type HandoffPreview, type Project, type SharedStatePreview, type Task } from '../../shared/types';
import { api, errorMessage, type HandoffAgent } from '../api';
import { copyText, desktopBridge, downloadText, formatDate, useAction, useBeforeUnload } from '../hooks';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Loading, Notice, SectionHeading } from '../components/ui';
import { LocalizedError } from '../../shared/i18n';
import { useLocale, useT } from '../i18n';
import { handoffMessages } from '../locales/panels-handoff';
import { ChangePreview } from '../components/ChangePreview';

type ImportPreview = {
  preview: SharedStatePreview;
  projectId: string;
  revision: number;
  before: Pick<Project, 'memory' | 'nextAction'>;
} & ({ kind: 'paste'; text: string } | { kind: 'file' });
const importFields = [...MEMORY_FIELDS, 'nextAction'] as const;
const beforeValue = (snapshot: ImportPreview, key: typeof importFields[number]) => key === 'nextAction' ? snapshot.before.nextAction : snapshot.before.memory[key];
const afterValue = (snapshot: ImportPreview, key: typeof importFields[number]) => key === 'nextAction' ? snapshot.preview.state.nextAction : snapshot.preview.state.memory[key];
const changedCount = (snapshot: ImportPreview) => importFields.filter(key => beforeValue(snapshot, key) !== afterValue(snapshot, key)).length;

export function HandoffPanel({ project, tasks, desktopApps, memoryDirty = false, memoryBusy = false, onChange, onDirtyChange, onBusyChange }: {
  project: Project; tasks: Task[]; desktopApps: DesktopCapabilities; memoryDirty?: boolean; memoryBusy?: boolean;
  onChange: () => Promise<void>; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const locale = useLocale(); const t = useT(handoffMessages);
  const [agent, setAgent] = useState<HandoffAgent>('claude-desktop');
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState<{ key: 'copied' | 'copiedAndOpened'; app?: string } | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<'downloadSaved' | 'downloadRequested' | 'downloadCancelled' | ''>('');
  const [exportConfirm, setExportConfirm] = useState(false);
  const [exportResult, setExportResult] = useState<{ directory: string; files: string[]; stateCreated: boolean } | null>(null);
  const [text, setText] = useState('');
  const [acceptedText, setAcceptedText] = useState('');
  const [shared, setShared] = useState<ImportPreview | null>(null);
  const [importConfirm, setImportConfirm] = useState<ImportPreview | null>(null);
  const [imported, setImported] = useState(false);
  const [previewInvalidated, setPreviewInvalidated] = useState(false);
  const [readKind, setReadKind] = useState<'paste' | 'file'>('paste');
  const previewSequence = useRef(0);
  const pasteId = useId();
  const exportAction = useAction(); const copyAction = useAction(); const sharedAction = useAction(); const importAction = useAction(); const downloadAction = useAction();
  const dirty = text.length > 0 && text !== acceptedText;
  const operationBusy = importAction.busy || exportAction.busy || copyAction.busy || downloadAction.busy;
  const memoryBlocked = memoryDirty || memoryBusy;
  const desktopApp: DesktopApp | null = agent === 'claude-desktop' ? 'claude' : agent === 'chatgpt-desktop' ? 'chatgpt' : null;
  const taskVersion = tasks.filter(t => t.projectId === project.id).map(t => `${t.id}:${t.revision}`).join('|');
  useBeforeUnload(dirty || operationBusy);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(operationBusy); }, [operationBusy, onBusyChange]);
  useEffect(() => () => { previewSequence.current++; }, []);
  useEffect(() => {
    let current = true;
    setLoading(true); setPreviewError(''); setPreview(null); setCopied(false); setCopyMessage(null); setDownloadMessage('');
    api.handoff(project.id, agent).then(data => { if (current) setPreview(data); }).catch(error => { if (current) setPreviewError(errorMessage(error, locale)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [project.id, project.revision, taskVersion, agent, generation, locale]);

  const changeText = (value: string) => {
    previewSequence.current++;
    if (shared?.kind === 'paste' || sharedAction.busy) setPreviewInvalidated(true);
    setText(value); setImported(false); setImportConfirm(null);
    setShared(current => current?.kind === 'paste' ? null : current);
    sharedAction.setError(''); importAction.setError('');
  };
  const readShared = async (kind: 'paste' | 'file') => {
    if (memoryBlocked || sharedAction.busy || operationBusy) return;
    // Bind the response to the exact input and project revision BEFORE the request.
    const captured = { projectId: project.id, revision: project.revision, before: { memory: project.memory, nextAction: project.nextAction } };
    const capturedText = text;
    const requestId = ++previewSequence.current;
    setReadKind(kind); setImported(false); setShared(null); setImportConfirm(null); setPreviewInvalidated(false);
    const result = await sharedAction.run(() => kind === 'paste' ? api.previewPastedState(captured.projectId, capturedText) : api.sharedState(captured.projectId));
    // Editing while the request is in flight must never reinstate an obsolete preview.
    if (result.ok && requestId === previewSequence.current) setShared(kind === 'paste' ? { ...captured, kind, text: capturedText, preview: result.value } : { ...captured, kind, preview: result.value });
  };
  const copy = async (openApp: boolean) => {
    if (!preview) return;
    const markdown = preview.markdown;
    const app = openApp ? desktopApp : null;
    setCopied(false); setCopyMessage(null);
    await copyAction.run(async () => {
      await copyText(markdown);
      setCopied(true);
      setCopyMessage({ key: 'copied' });
      if (app) {
        await api.openDesktopApp(app);
        setCopyMessage({ key: 'copiedAndOpened', app: DESKTOP_APP_LABELS[app] });
      }
    });
  };
  const download = async () => {
    if (!preview) return;
    const captured = preview;
    setDownloadMessage('');
    const result = await downloadAction.run(() => downloadText(captured.markdown, captured.filename));
    if (result.ok) setDownloadMessage(result.value ? (desktopBridge() ? 'downloadSaved' : 'downloadRequested') : 'downloadCancelled');
  };
  const importState = async () => {
    const captured = importConfirm;
    if (!captured) return;
    await importAction.run(async () => {
      if (memoryBlocked) throw new LocalizedError(handoffMessages, 'importMemoryBlocked');
      if (captured !== shared || captured.projectId !== project.id || captured.revision !== project.revision || (captured.kind === 'paste' && captured.text !== text)) throw new LocalizedError(handoffMessages, 'importChanged');
      if (captured.kind === 'paste') await api.importPastedState(captured.projectId, captured.text, captured.preview.hash, captured.revision);
      else await api.importSharedState(captured.projectId, captured.revision, captured.preview.hash);
      if (captured.kind === 'paste') setAcceptedText(captured.text);
      setShared(null); setImported(true); setImportConfirm(null);
      await onChange();
    });
  };
  const closePreview = () => { previewSequence.current++; setShared(null); setImportConfirm(null); };
  const renderDiff = (snapshot: ImportPreview) => <SharedStateDiff snapshot={snapshot} stale={snapshot.revision !== project.revision} blocked={memoryBlocked || operationBusy} onClose={closePreview} onConfirm={() => { importAction.setError(''); setImportConfirm(snapshot); }} />;

  return <div className="handoff-panel"><SectionHeading title={t('title')} subtitle={t('subtitle')} />
    <div className="handoff-flow"><span><FileText size={16} />{t('reviewStep')}</span><span className="flow-line" /><span><MessageSquare size={16} />{t('pasteStep')}</span><span className="flow-line" /><span><ArrowLeftRight size={16} />{t('importStep')}</span></div>
    {memoryDirty && <Notice warning>{t('memoryDirty')}</Notice>}
    <div className="handoff-toolbar"><label className="inline-field"><span>{t('target')}</span><select value={agent} onChange={e => { setAgent(e.target.value as HandoffAgent); copyAction.setError(''); }} aria-label={t('target')} disabled={operationBusy}><optgroup label={t('desktopApps')}><option value="claude-desktop">Claude Desktop</option><option value="chatgpt-desktop">ChatGPT Desktop</option></optgroup><optgroup label={t('advancedTargets')}><option value="generic">{t('generic')}</option><option value="claude">{t('claudeCli')}</option><option value="codex">{t('codexCli')}</option></optgroup></select></label><Button variant="ghost" icon={RefreshCw} busy={loading} disabled={operationBusy} onClick={() => setGeneration(n => n + 1)}>{t('regenerate')}</Button></div>
    <ErrorNotice message={previewError} />
    <div className="markdown-preview"><div className="preview-caption"><span><FileText size={15} />{preview?.filename || t('previewTitle')}</span><span>Markdown</span></div>{loading ? <Loading label={t('loading')} /> : preview ? <pre tabIndex={0} aria-label={t('previewLabel')}>{preview.markdown}</pre> : <p className="quiet-empty">{t('previewFailed')}</p>}</div>
    <div className="handoff-actions">{desktopApp && <Button variant="primary" icon={MessageSquare} disabled={!preview || !desktopApps[desktopApp] || operationBusy} busy={copyAction.busy} onClick={() => { void copy(true); }}>{t('copyOpen', { app: DESKTOP_APP_LABELS[desktopApp] })}</Button>}<Button variant={desktopApp ? 'secondary' : 'primary'} icon={copied ? Check : Copy} disabled={!preview || operationBusy} onClick={() => { void copy(false); }}>{copied ? t('copyAgain') : t('copyOnly')}</Button></div>
    {desktopApp && !desktopApps[desktopApp] && <p className="field-hint">{t('notDetected', { app: DESKTOP_APP_LABELS[desktopApp] })}</p>}
    {copyMessage && <p className="inline-success" role="status"><Check size={16} />{t(copyMessage.key, { app: copyMessage.app ?? '' })}</p>}
    <ErrorNotice message={copyAction.error ? copied ? t('openFailed', { error: copyAction.error }) : copyAction.error : ''} />
    <p className="field-hint handoff-boundary">{t('boundary')}</p>

    <section className="shared-state-section paste-state-section"><SectionHeading title={t('returnTitle')} subtitle={t('returnSubtitle')} />
      <label className="field" htmlFor={pasteId}><span className="field-label">{t('jsonLabel')}</span><textarea id={pasteId} aria-label={t('jsonLabel')} className="json-input" value={text} onChange={e => changeText(e.target.value)} rows={7} spellCheck={false} autoComplete="off" disabled={importAction.busy} placeholder={t('jsonPlaceholder')} aria-describedby={`${pasteId}-hint`} /></label>
      <p id={`${pasteId}-hint`} className="field-hint">{t('jsonHint')}</p>
      <div className="paste-actions"><span className="field-hint" role="status">{previewInvalidated ? t('previewInvalidated') : dirty ? t('pasteUnsaved') : t('pasteSafe')}</span><Button icon={ArrowLeftRight} busy={sharedAction.busy} disabled={!text.trim() || memoryBlocked || operationBusy} onClick={() => { void readShared('paste'); }}>{t('previewImport')}</Button></div>
      {readKind === 'paste' && <ErrorNotice message={sharedAction.error} />}{!importConfirm && <ErrorNotice message={importAction.error} />}
      {imported && <p className="inline-success" role="status"><Check size={16} />{t('imported')}</p>}
      {shared?.kind === 'paste' && renderDiff(shared)}
    </section>

    <details className="advanced-handoff"><summary>{t('advanced')}</summary><div className="advanced-handoff-body">
      <p className="muted">{t('advancedHint')}</p>
      <div className="handoff-actions"><Button icon={Download} disabled={!preview || operationBusy} busy={downloadAction.busy} onClick={() => { void download(); }}>{t('download')}</Button><Button icon={FolderOutput} disabled={!preview || memoryBlocked || operationBusy} onClick={() => { exportAction.setError(''); setExportConfirm(true); }}>{t('export')}</Button><Button icon={ArrowLeftRight} busy={sharedAction.busy} disabled={memoryBlocked || operationBusy} onClick={() => { void readShared('file'); }}>{t('readShared')}</Button></div>
      {downloadMessage && <p className="field-hint" role="status">{t(downloadMessage)}</p>}<ErrorNotice message={downloadAction.error} />{readKind === 'file' && <ErrorNotice message={sharedAction.error} />}
      <p className="field-hint">{t('readSharedHint')}</p>
      {exportResult && <div className="export-result" role="status"><strong><Check size={16} />{t('exported')}</strong><p className="path-text">{exportResult.directory}</p><ul>{exportResult.files.map(file => <li key={file} className="path-text">{file}</li>)}</ul><p>{exportResult.stateCreated ? t('stateCreated') : t('statePreserved')}</p></div>}
      {shared?.kind === 'file' && renderDiff(shared)}
    </div></details>
    {exportConfirm && <ConfirmDialog title={t('exportTitle')} confirmLabel={t('exportConfirm')} onClose={() => setExportConfirm(false)} busy={exportAction.busy} confirmDisabled={memoryBlocked} error={exportAction.error} onConfirm={() => { void exportAction.run(async () => { if (memoryBlocked) throw new LocalizedError(handoffMessages, 'exportMemoryBlocked'); const result = await api.exportHandoff(project.id, agent); setExportResult(result); setExportConfirm(false); }); }}><p>{t('exportBeforeName')}<strong>{project.name}</strong>{t('exportBeforeFolder')}<code>.ai-project-hub</code>{t('exportAfterFolder')}<code>state.json</code>{t('exportAfterState')}</p><Notice warning>{t('exportWarning')}</Notice><p className="path-text">{project.path}</p></ConfirmDialog>}
    {importConfirm && <ConfirmDialog title={importConfirm.kind === 'paste' ? t('importPasteTitle') : t('importFileTitle')} confirmLabel={t('importConfirm')} onClose={() => setImportConfirm(null)} busy={importAction.busy} confirmDisabled={memoryBlocked || importConfirm.revision !== project.revision || importConfirm !== shared} error={importAction.error} onConfirm={() => { void importState(); }}><p>{t('importBeforeName')}<strong>{project.name}</strong>{t('importAfterName')}</p><Notice>{importConfirm.kind === 'paste' ? t('pasteFingerprint') : t('fileFingerprint')}{' '}{t('revisionCheck', { revision: importConfirm.revision })}</Notice>{importConfirm.revision !== project.revision && <Notice warning>{t('importStale')}</Notice>}{memoryBlocked && <Notice warning>{t('memoryBlocked')}</Notice>}</ConfirmDialog>}
  </div>;
}

function SharedStateDiff({ snapshot, stale, blocked, onClose, onConfirm }: { snapshot: ImportPreview; stale: boolean; blocked: boolean; onClose: () => void; onConfirm: () => void }) {
  const locale = useLocale(); const t = useT(handoffMessages); const memoryLabels = getMemoryLabels(locale);
  const count = changedCount(snapshot);
  return <div className="shared-preview"><div className="shared-preview-heading"><strong>{t('diffTitle')} <span className="count-label">{t('differentFields', { count })}</span></strong><span className="muted">{t('exportTime', { date: formatDate(snapshot.preview.state.exportedAt, true, locale) })}</span></div><p className="path-text shared-source">{t('sourceRevision', { source: snapshot.kind === 'paste' ? t('pastedSource') : snapshot.preview.source, revision: snapshot.revision })}</p>
    {stale && <Notice warning>{t('diffStale')}</Notice>}
    <ChangePreview changes={importFields.map(key => ({ key, label: key === 'nextAction' ? t('projectNextAction') : memoryLabels[key], before: beforeValue(snapshot, key), after: afterValue(snapshot, key) }))} /><div className="shared-footer"><Button disabled={blocked} onClick={onClose}>{t('closePreview')}</Button><Button variant="primary" icon={ArrowDownToLine} disabled={blocked || stale || !count} onClick={onConfirm}>{t('confirmContent')}</Button></div>
  </div>;
}

export function HandoffCenter({ projects, tasks, desktopApps, onChange, onDirtyChange, onBusyChange }: { projects: Project[]; tasks: Task[]; desktopApps: DesktopCapabilities; onChange: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const t = useT(handoffMessages);
  const [selectedId, setSelectedId] = useState(projects[0]?.id ?? '');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const project = projects.find(p => p.id === selectedId) ?? projects[0];
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const selectProject = (id: string) => { if (id === project?.id || busy) return; if (dirty) setPendingId(id); else setSelectedId(id); };
  if (!project) return <section className="panel"><EmptyState icon={ArrowLeftRight} title={t('emptyTitle')} description={t('emptyDescription')} /></section>;
  return <><div className="handoff-center"><aside className="handoff-projects panel"><h2>{t('chooseProject')}</h2>{projects.map(p => <button key={p.id} className={`handoff-project ${project.id === p.id ? 'selected' : ''}`} disabled={busy} onClick={() => selectProject(p.id)}><span className="project-monogram">{p.name.slice(0, 1).toLocaleUpperCase()}</span><span><strong>{p.name}</strong><small>{p.category || t('uncategorized')}</small></span></button>)}</aside><section className="panel handoff-main"><div className="handoff-project-title"><strong>{project.name}</strong><span className="path-text">{project.path}</span></div><HandoffPanel key={project.id} project={project} tasks={tasks} desktopApps={desktopApps} onChange={onChange} onDirtyChange={setDirty} onBusyChange={setBusy} /></section></div>
    {pendingId && <ConfirmDialog title={t('switchTitle')} confirmLabel={t('switchConfirm')} danger onClose={() => setPendingId(null)} onConfirm={() => { setSelectedId(pendingId); setDirty(false); setPendingId(null); }}><p>{t('switchDescription')}</p></ConfirmDialog>}
  </>;
}
