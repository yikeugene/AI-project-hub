import { useEffect, useState, type FormEvent } from 'react';
import { Check, Code2, Database, FolderSearch, HardDrive, MessageSquare, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { DESKTOP_APPS, DESKTOP_APP_LABELS, type Settings, type Workspace } from '../../shared/types';
import { LocalizedError } from '../../shared/i18n';
import { api } from '../api';
import { useT } from '../i18n';
import { settingsMessages } from '../locales/panels-settings';
import { useAction, useBeforeUnload } from '../hooks';
import { Button, ErrorNotice, Field, SectionHeading } from '../components/ui';
import { UpdatePanel } from '../components/UpdatePanel';

export function SettingsPanel({ workspace, onChange, onDirtyChange, onBusyChange }: { workspace: Workspace; onChange: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const t = useT(settingsMessages);
  const [initial, setInitial] = useState(workspace.settings);
  const [roots, setRoots] = useState(workspace.settings.scanRoots.join('\n'));
  const [staleDays, setStaleDays] = useState(String(workspace.settings.staleDays));
  const [refreshSeconds, setRefreshSeconds] = useState(String(workspace.settings.refreshSeconds));
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const dirty = roots !== initial.scanRoots.join('\n') || staleDays !== String(initial.staleDays) || refreshSeconds !== String(initial.refreshSeconds);
  useBeforeUnload(dirty || action.busy);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(action.busy); }, [action.busy, onBusyChange]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaved(false);
    const refresh = Number(refreshSeconds);
    if (refresh !== 0 && refresh < 30) { action.setError(new LocalizedError(settingsMessages, 'refreshRange')); return; }
    const settings: Pick<Settings, 'scanRoots' | 'staleDays' | 'refreshSeconds'> = { scanRoots: [...new Set(roots.split('\n').map(root => root.trim()).filter(Boolean))], staleDays: Number(staleDays), refreshSeconds: refresh };
    const result = await action.run(async () => { const updated = await api.settings(settings); await onChange(); return updated; });
    if (result.ok) { setInitial(result.value); setRoots(result.value.scanRoots.join('\n')); setStaleDays(String(result.value.staleDays)); setRefreshSeconds(String(result.value.refreshSeconds)); setSaved(true); }
  };
  const capabilities = workspace.environment.capabilities;
  return <div className="settings-layout"><form className="panel settings-form" onSubmit={event => { void submit(event); }}><SectionHeading title={t('title')} subtitle={t('subtitle')} />
    <div className="settings-section"><div className="settings-section-heading"><FolderSearch size={19} /><div><h3>{t('discovery')}</h3><p>{t('discoveryDescription')}</p></div></div><Field label={t('scanRoots')} hint={t('scanRootsHint')}><textarea disabled={action.busy} value={roots} rows={5} spellCheck={false} onChange={e => { setRoots(e.target.value); setSaved(false); }} placeholder={'C:\\Projects\nC:\\Users\\you\\Documents'} /></Field></div>
    <div className="settings-section"><div className="settings-section-heading"><RefreshCw size={19} /><div><h3>{t('refreshTitle')}</h3><p>{t('refreshDescription')}</p></div></div><div className="form-grid"><Field label={t('staleLabel')} hint={t('staleHint')}><div className="input-unit"><input disabled={action.busy} required type="number" min={1} max={365} step={1} value={staleDays} onChange={e => { setStaleDays(e.target.value); setSaved(false); }} /><span>{t('days')}</span></div></Field><Field label={t('refreshLabel')} hint={t('refreshHint')}><div className="input-unit"><input disabled={action.busy} required type="number" min={0} max={3600} step={1} value={refreshSeconds} onChange={e => { setRefreshSeconds(e.target.value); setSaved(false); }} /><span>{t('seconds')}</span></div></Field></div><p className="field-hint">{t('workspaceRefreshHint')}</p></div>
    <ErrorNotice message={action.error} /><div className="settings-save"><span role="status" className={saved ? 'inline-success' : 'muted'}>{saved ? <><Check size={15} />{t('saved')}</> : dirty ? t('unsaved') : t('synced')}</span><Button type="submit" variant="primary" icon={Save} busy={action.busy} disabled={!dirty}>{t('save')}</Button></div>
  </form><aside className="settings-aside">
    <UpdatePanel version={workspace.environment.version} />
    <section className="panel local-environment"><h2><HardDrive size={18} />{t('environment')}</h2><dl><div><dt>{t('application')}</dt><dd>AI Project Hub <span className="muted">v{workspace.environment.version}</span></dd></div><div><dt>{t('mode')}</dt><dd>{workspace.environment.mode === 'desktop' ? t('desktopMode') : t('browserMode')}</dd></div><div><dt>{t('platform')}</dt><dd>{workspace.environment.platform}</dd></div><div><dt>{t('dataLocation')}</dt><dd className="path-text">{workspace.environment.dataDir}</dd></div></dl><div className="local-db-note"><Database size={16} /><span>{t('localDatabase')}</span></div></section>
    <section className="panel capability-panel"><h2><MessageSquare size={18} />{t('desktopApps')}</h2>{DESKTOP_APPS.map(app => <div className="capability-row" key={app}><span>{DESKTOP_APP_LABELS[app]}</span><span className={workspace.environment.desktopApps[app] ? 'capability-yes' : 'muted'}>{workspace.environment.desktopApps[app] ? <><Check size={13} />{t('detected')}</> : t('notDetected')}</span></div>)}<p className="field-hint">{t('desktopAppsHint')}</p></section>
    <section className="panel capability-panel"><h2><Code2 size={18} />{t('localTools')}</h2>{([{ key: 'folder', name: t('fileManager') }, { key: 'vscode', name: 'VS Code' }] as const).map(tool => <div className="capability-row" key={tool.key}><span>{tool.name}</span><span className={capabilities[tool.key] ? 'capability-yes' : 'muted'}>{capabilities[tool.key] ? <><Check size={13} />{t('available')}</> : t('notDetected')}</span></div>)}<p className="field-hint">{t('vscodeHint')}</p><details className="advanced-tools"><summary>{t('advancedTools')}</summary>{([{ key: 'claude', name: 'Claude Code CLI' }, { key: 'codex', name: 'Codex CLI' }] as const).map(tool => <div className="capability-row" key={tool.key}><span>{tool.name}</span><span className={capabilities[tool.key] ? 'capability-yes' : 'muted'}>{capabilities[tool.key] ? <><Check size={13} />{t('available')}</> : t('notDetected')}</span></div>)}<p className="field-hint">{t('cliHint')}</p></details></section>
    <div className="privacy-note"><ShieldCheck size={21} /><div><strong>{t('privacyTitle')}</strong><p>{t('privacyDescription')}</p></div></div>
  </aside></div>;
}
