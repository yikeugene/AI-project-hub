import { useState } from 'react';
import { Code2, FolderOpen, MessageSquare, Terminal } from 'lucide-react';
import { DESKTOP_APPS, DESKTOP_APP_LABELS, type Capabilities, type DesktopApp, type DesktopCapabilities, type LaunchAction, type Project } from '../../shared/types';
import { api } from '../api';
import { useAction } from '../hooks';
import { useT } from '../i18n';
import { shellCatalog } from '../locales/shell';
import { Button, ConfirmDialog, ErrorNotice, Notice } from './ui';

const localActions = [{ action: 'folder', labelKey: 'quick.folder', icon: FolderOpen }, { action: 'vscode', labelKey: 'quick.vscode', icon: Code2 }] as const;
const cliActions = [{ action: 'claude', labelKey: 'quick.claude' }, { action: 'codex', labelKey: 'quick.codex' }] as const;
const actionKeys = { folder: 'quick.folder', vscode: 'quick.vscode', claude: 'quick.claude', codex: 'quick.codex' } as const;
export function QuickActions({ project, capabilities, desktopApps }: { project: Project; capabilities: Capabilities; desktopApps: DesktopCapabilities }) {
  const t = useT(shellCatalog);
  const [confirm, setConfirm] = useState<'claude' | 'codex' | null>(null);
  const [message, setMessage] = useState<{ target: LaunchAction } | { app: DesktopApp } | null>(null);
  const action = useAction();
  const launch = async (target: LaunchAction) => {
    setMessage(null);
    const result = await action.run(() => api.open(project.id, target));
    if (result.ok) { setConfirm(null); setMessage({ target }); }
  };
  const openDesktop = async (app: DesktopApp) => {
    setMessage(null);
    const result = await action.run(() => api.openDesktopApp(app));
    if (result.ok) setMessage({ app });
  };
  return <div className="quick-actions-wrap">
    <div className="quick-actions">{localActions.map(item => <Button key={item.action} icon={item.icon} disabled={!capabilities[item.action] || action.busy} title={t(capabilities[item.action] ? 'quick.openLocal' : 'quick.localUnavailable', { app: t(item.labelKey) })} onClick={() => { void launch(item.action); }}>{t(item.labelKey)}</Button>)}{DESKTOP_APPS.map(app => <Button key={app} icon={MessageSquare} disabled={!desktopApps[app] || action.busy} title={t(desktopApps[app] ? 'quick.openDesktop' : 'quick.desktopUnavailable', { app: DESKTOP_APP_LABELS[app] })} onClick={() => { void openDesktop(app); }}>{DESKTOP_APP_LABELS[app]}</Button>)}</div>
    <p className="field-hint">{t('quick.desktopHint')}</p>
    <details className="advanced-tools"><summary>{t('quick.advanced')}</summary><div className="quick-actions">{cliActions.map(item => <Button key={item.action} icon={Terminal} disabled={!capabilities[item.action] || action.busy} title={t(capabilities[item.action] ? 'quick.openCli' : 'quick.cliUnavailable', { app: t(item.labelKey) })} onClick={() => { action.setError(''); setMessage(null); setConfirm(item.action); }}>{t(item.labelKey)}</Button>)}</div><p className="field-hint">{t('quick.cliHint')}</p></details>
    {message && <p className="inline-success" role="status">{'target' in message ? t('quick.launched', { app: t(actionKeys[message.target]) }) : t('quick.desktopLaunched', { app: DESKTOP_APP_LABELS[message.app] })}</p>}{!confirm && <ErrorNotice message={action.error} />}
    {confirm && <ConfirmDialog title={t('quick.confirmTitle', { app: t(actionKeys[confirm]) })} confirmLabel={t('quick.confirm')} onClose={() => setConfirm(null)} busy={action.busy} error={action.error} onConfirm={() => { void launch(confirm); }}><p>{t('quick.confirmDescription')}</p><p className="path-text">{project.path}</p><Notice warning>{t('quick.warning')}</Notice><p className="muted">{t('quick.handoffHint')}</p></ConfirmDialog>}
  </div>;
}
