import { useEffect, useState } from 'react';
import { ArrowRight, CircleCheck, FolderKanban, FolderSearch, Monitor, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Project } from '../shared/types';
import type { Locale } from '../shared/i18n';
import { isStale } from '../shared/insights';
import { api, deviceApi } from './api';
import { canUseNetwork } from './device-ui';
import { useAction, useDevices, useWorkspace } from './hooks';
import { useI18n, useT } from './i18n';
import { shellCatalog, type ShellKey, type ShellMessage } from './locales/shell';
import { ProjectDetail } from './components/ProjectDetail';
import { ProjectForm } from './components/ProjectForm';
import { ProjectTable } from './components/ProjectTable';
import { ScanDialog } from './components/ScanDialog';
import { navigation, Sidebar, type View } from './components/Sidebar';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Loading } from './components/ui';
import { MessageComposer, type ComposeTarget } from './components/MessageComposer';
import { FocusPanel } from './panels/FocusPanel';
import { HandoffCenter } from './panels/HandoffPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { DeviceSettings } from './panels/DeviceSettings';
import { InboxPanel } from './panels/InboxPanel';
import { RemoteProjectsPanel } from './panels/RemoteProjectsPanel';
import { TasksPanel } from './panels/TasksPanel';

const pageText: Record<View, { title: ShellKey; description: ShellKey }> = {
  dashboard: { title: 'page.dashboard.title', description: 'page.dashboard.description' },
  projects: { title: 'page.projects.title', description: 'page.projects.description' },
  tasks: { title: 'page.tasks.title', description: 'page.tasks.description' },
  handoff: { title: 'page.handoff.title', description: 'page.handoff.description' },
  settings: { title: 'page.settings.title', description: 'page.settings.description' },
  remote: { title: 'page.remote.title', description: 'page.remote.description' },
  inbox: { title: 'page.inbox.title', description: 'page.inbox.description' },
  sent: { title: 'page.sent.title', description: 'page.sent.description' },
};
interface Route { view: View; deviceId?: string }
export default function App() {
  const { workspace, loading, error, reload, lastLoaded, updateLocale, localeBusy } = useWorkspace();
  const { locale, setLocale } = useI18n();
  const t = useT(shellCatalog);
  const savedLocale = workspace?.settings.locale;
  useEffect(() => { if (savedLocale) setLocale(savedLocale); }, [savedLocale, setLocale]);
  const devices = useDevices();
  const [route, setRoute] = useState<Route>({ view: 'dashboard' });
  const { view } = route;
  const [addProject, setAddProject] = useState(false);
  const [scan, setScan] = useState(false);
  const [selected, setSelected] = useState<Project | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [deviceDirty, setDeviceDirty] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [handoffDirty, setHandoffDirty] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [composition, setComposition] = useState<{ target: ComposeTarget; networkId: string | null } | null>(null);
  const [composerDirty, setComposerDirty] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<Route | null>(null);
  const refresh = useAction(); const cloud = useAction(); const language = useAction();
  const [refreshMessage, setRefreshMessage] = useState<ShellMessage | null>(null);
  const [sentMessage, setSentMessage] = useState<ShellMessage | null>(null);
  const projects = workspace?.projects ?? [];
  const tasks = workspace?.tasks ?? [];
  const deviceView = view === 'remote' || view === 'inbox' || view === 'sent';
  const remoteDevice = devices.state?.paired ? devices.state.devices.find(device => device.id === route.deviceId && device.id !== devices.state?.localDevice.id && !device.revokedAt) : undefined;
  const routeBusy = composerBusy || cloud.busy || (view === 'settings' && (settingsBusy || deviceBusy)) || (view === 'handoff' && handoffBusy) || ((view === 'inbox' || view === 'sent') && inboxBusy);
  const closeComposer = () => { setComposition(null); setComposerDirty(false); setComposerBusy(false); };
  const applyRoute = (next: Route) => {
    closeComposer(); setSettingsDirty(false); setDeviceDirty(false); setHandoffDirty(false); setInboxBusy(false); setSentMessage(null);
    setRoute(next); window.scrollTo({ top: 0 });
  };
  const navigate = (next: Route) => {
    if ((next.view === view && next.deviceId === route.deviceId) || routeBusy) return;
    if (composerDirty || (view === 'settings' && (settingsDirty || deviceDirty)) || (view === 'handoff' && handoffDirty)) { setPendingRoute(next); return; }
    applyRoute(next);
  };
  const openProject = (id: string) => { const project = projects.find(p => p.id === id); if (project) setSelected(project); };
  const compose = (target: ComposeTarget) => { if (routeBusy || composition || !devices.state) return; setSentMessage(null); setComposition({ target, networkId: devices.state.networkId }); };
  const manualRefresh = async () => {
    setRefreshMessage(null);
    const response = await refresh.run(async () => { const result = await api.refresh(); await reload(); return result; });
    if (response.ok) setRefreshMessage({ key: 'app.refreshed', params: { count: response.value.refreshed } });
  };
  const switchLocale = async (target: Locale) => {
    if (!workspace || localeBusy || language.busy || target === locale) return;
    const result = await language.run(() => updateLocale(target));
    if (result.ok) setLocale(target);
  };
  const selectedProject = selected ? projects.find(p => p.id === selected.id) ?? selected : null;
  const categories = [...new Set(projects.map(p => p.category).filter(Boolean))];
  const currentNavigation = navigation.find(n => n.id === view);
  return <div className="app-shell"><a href="#main-content" className="skip-link">{t('app.skip')}</a><Sidebar view={view} onNavigate={next => navigate({ view: next })} projectCount={projects.length} taskCount={tasks.filter(task => task.status !== 'done').length} devices={devices.state} selectedDeviceId={route.deviceId} onDevice={id => navigate({ view: 'remote', deviceId: id })} />
    <div className="workspace-shell"><header className="topbar"><div className="breadcrumbs"><span>{view === 'remote' ? remoteDevice?.name || t('app.remoteDevice') : devices.state?.localDevice.name || t('app.personalWorkspace')}</span><span className="breadcrumb-slash">/</span><strong>{view === 'remote' ? t('app.readOnlySummary') : currentNavigation && t(currentNavigation.labelKey)}</strong></div><div className="topbar-right"><div className="language-toggle" role="group" aria-label={t('app.language')} aria-busy={localeBusy || language.busy}><button type="button" lang="en" aria-pressed={locale === 'en'} disabled={!workspace || localeBusy || language.busy} onClick={() => { void switchLocale('en'); }}>{t('app.english')}</button><button type="button" lang="zh-TW" aria-pressed={locale === 'zh-TW'} disabled={!workspace || localeBusy || language.busy} onClick={() => { void switchLocale('zh-TW'); }}>{t('app.traditionalChinese')}</button></div><span className="connection-status"><span className={`local-status-dot ${error ? 'disconnected' : ''}`} />{t(error ? 'app.disconnected' : workspace ? 'app.connected' : 'app.connecting')}</span><span className="topbar-divider" />{deviceView ? <button className="refresh-button" disabled={!canUseNetwork(devices.state) || !devices.state?.enabled || routeBusy} onClick={() => { void cloud.run(() => devices.update(deviceApi.sync)); }} title={t('app.syncHint')}><RefreshCw size={15} className={cloud.busy ? 'spin' : ''} /><span>{t(cloud.busy ? 'app.syncing' : 'app.syncDevices')}</span></button> : <button className="refresh-button" disabled={!workspace || refresh.busy || routeBusy} onClick={() => { void manualRefresh(); }} title={lastLoaded ? t('app.refreshHint', { time: lastLoaded.toLocaleTimeString(locale) }) : t('app.refreshDefaultHint')}><RefreshCw size={15} className={refresh.busy ? 'spin' : ''} /><span>{t(refresh.busy ? 'app.refreshing' : 'app.refresh')}</span></button>}</div></header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading"><div><div className="page-date">{new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</div><h1>{t(pageText[view].title)}</h1><p>{t(pageText[view].description)}</p></div>{(view === 'dashboard' || view === 'projects') && <div className="page-actions"><Button icon={FolderSearch} onClick={() => setScan(true)} disabled={!workspace}>{t('app.scanProjects')}</Button><Button variant="primary" icon={Plus} onClick={() => setAddProject(true)} disabled={!workspace}>{t('app.addProject')}</Button></div>}</div>
        <ErrorNotice message={language.error} onDismiss={() => language.setError('')} />
        {error && <div className="workspace-error"><ErrorNotice message={error} /><Button onClick={() => { void reload(); }}>{t('app.reconnect')}</Button></div>}
        {!deviceView && <><ErrorNotice message={refresh.error} onDismiss={() => refresh.setError('')} />{refreshMessage && <p className="refresh-message" role="status"><CircleCheck size={14} />{t(refreshMessage.key, refreshMessage.params)}<button className="text-button" onClick={() => setRefreshMessage(null)}>{t('common.close')}</button></p>}</>}
        {deviceView ? <><ErrorNotice message={devices.error} onDismiss={() => { void devices.reload(); }} /><ErrorNotice message={cloud.error} onDismiss={() => cloud.setError('')} />{sentMessage && <p className="inline-success" role="status"><CircleCheck size={15} />{t(sentMessage.key, sentMessage.params)}</p>}{!devices.state ? <section className="panel">{devices.loading ? <Loading label={t('app.loadingDevices')} /> : <EmptyState icon={Monitor} title={t('app.devicesUnavailable')} description={t('app.devicesUnavailableDescription')}><Button onClick={() => { void devices.reload(); }}>{t('app.retryDevices')}</Button></EmptyState>}</section> : view === 'remote' ? remoteDevice ? <RemoteProjectsPanel key={`${devices.state.networkId}:${remoteDevice.id}`} device={remoteDevice} state={devices.state} onCompose={compose} /> : <section className="panel"><EmptyState icon={Monitor} title={t('app.deviceMissing')} description={t('app.deviceMissingDescription')} /></section> : <InboxPanel key={`${devices.state.networkId}:${view}`} box={view === 'sent' ? 'sent' : 'inbox'} state={devices.state} projects={projects} onCompose={compose} onChange={async () => { await Promise.all([reload(), devices.reload()]); }} onBusyChange={setInboxBusy} />}</> : loading ? <div className="panel"><Loading /></div> : !workspace ? <section className="panel service-unavailable"><FolderKanban size={34} strokeWidth={1.4} /><h2>{t('app.workspaceUnavailable')}</h2><p>{t('app.workspaceUnavailableDescription')}</p><Button variant="primary" icon={RefreshCw} onClick={() => { void reload(); }}>{t('app.reconnect')}</Button></section> : <>
          {view === 'dashboard' && <><dl className="number-strip" aria-label={t('app.overview')}><div><dt>{t('app.trackedProjects')}</dt><dd>{projects.filter(p => p.status !== 'archived').length}<span>{t('app.projectUnit')}</span></dd></div><div><dt><span className="metric-dot active-dot" />{t('app.active')}</dt><dd>{projects.filter(p => p.status === 'active').length}</dd></div><div><dt>{t('app.openTasks')}</dt><dd>{tasks.filter(task => task.status !== 'done').length}</dd></div><div><dt>{t('app.staleCommits')}<span className="metric-note">{t('app.days', { count: workspace.settings.staleDays })}</span></dt><dd>{projects.filter(p => p.status !== 'archived' && p.status !== 'completed' && isStale(p, workspace.settings.staleDays)).length}</dd></div></dl><div className="dashboard-grid"><ProjectTable projects={projects} tasks={tasks} staleDays={workspace.settings.staleDays} onOpen={openProject} onAdd={() => setAddProject(true)} onScan={() => setScan(true)} /><FocusPanel projects={projects} tasks={tasks} staleDays={workspace.settings.staleDays} onOpen={openProject} /></div><div className="workbench-footer"><span><ShieldCheck size={15} />{t('app.localFirst')}</span><button className="text-button" onClick={() => navigate({ view: 'handoff' })}>{t('app.aboutHandoff')}<ArrowRight size={14} /></button></div></>}
          {view === 'projects' && <ProjectTable fullView projects={projects} tasks={tasks} staleDays={workspace.settings.staleDays} onOpen={openProject} onAdd={() => setAddProject(true)} onScan={() => setScan(true)} />}
          {view === 'tasks' && <TasksPanel projects={projects} tasks={tasks} onChange={reload} onOpenProject={openProject} />}
          {view === 'handoff' && <HandoffCenter projects={projects} tasks={tasks} desktopApps={workspace.environment.desktopApps} onChange={reload} onDirtyChange={setHandoffDirty} onBusyChange={setHandoffBusy} />}
          {view === 'settings' && <><SettingsPanel workspace={workspace} onChange={reload} onDirtyChange={setSettingsDirty} onBusyChange={setSettingsBusy} /><DeviceSettings devices={devices} projects={projects} onDirtyChange={setDeviceDirty} onBusyChange={setDeviceBusy} /></>}
        </>}
      </main>
    </div>
    {workspace && addProject && <ProjectForm categories={categories} onClose={() => setAddProject(false)} onSaved={reload} />}
    {workspace && scan && <ScanDialog roots={workspace.settings.scanRoots} projects={projects} onClose={() => setScan(false)} onImported={reload} />}
    {workspace && selectedProject && <ProjectDetail key={selectedProject.id} project={selectedProject} projects={projects} tasks={tasks} capabilities={workspace.environment.capabilities} desktopApps={workspace.environment.desktopApps} onClose={() => setSelected(null)} onChange={reload} />}
    {composition && devices.state && <MessageComposer target={composition.target} state={composition.networkId === devices.state.networkId ? devices.state : { ...devices.state, paired: false }} onClose={closeComposer} onDirtyChange={setComposerDirty} onBusyChange={setComposerBusy} onSent={async () => { await devices.reload(); setSentMessage({ key: 'app.messageQueued' }); }} />}
    {pendingRoute && <ConfirmDialog title={t(composerDirty ? 'app.unsentDraft' : view === 'handoff' ? 'app.unimportedJson' : 'app.unsavedSettings')} confirmLabel={t('app.discardAndLeave')} danger onClose={() => setPendingRoute(null)} onConfirm={() => { applyRoute(pendingRoute); setPendingRoute(null); }}><p>{t(composerDirty ? 'app.discardMessage' : view === 'handoff' ? 'app.discardHandoff' : 'app.discardSettings')}</p></ConfirmDialog>}
  </div>;
}
