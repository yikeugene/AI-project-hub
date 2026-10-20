import { ArrowDown, ArrowUp, Compass, NotebookPen, X } from 'lucide-react';
import type { Project, Task, WorkspaceFocus } from '../../shared/types';
import { ResumeCard } from '../components/ResumeCard';
import { Button, ErrorNotice, IconButton, StatusBadge } from '../components/ui';
import { useT } from '../i18n';
import { resumptionMessages } from '../locales/resumption';

interface PersonalFocusPanelProps {
  projects: Project[];
  tasks: Task[];
  focus: WorkspaceFocus;
  busy: boolean;
  error?: string;
  onOpen: (id: string) => void;
  onWrapUp: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onBrowse: () => void;
}

export function PersonalFocusPanel({ projects, tasks, focus, busy, error, onOpen, onWrapUp, onRemove, onMove, onBrowse }: PersonalFocusPanelProps) {
  const t = useT(resumptionMessages);
  const byId = new Map(projects.map(project => [project.id, project]));
  // Selection and order belong to the user, independent of filters, lifecycle and ranking.
  const selected = focus.projectIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  return <section className="panel personal-focus-panel" aria-label={t('focusTitle')} aria-busy={busy}>
    <header className="focus-heading"><span className="focus-symbol"><Compass size={20} strokeWidth={1.7} aria-hidden="true" /></span><div><h2>{t('focusTitle')}</h2><p>{t('focusSubtitle')}</p></div></header>
    <ErrorNotice message={error} />
    {busy && <p className="focus-busy field-hint" role="status">{t('focusBusy')}</p>}
    {selected.length ? <>
      <ol className="focus-list personal-focus-list">{selected.map((project, index) => <li className="focus-item personal-focus-row" key={project.id}>
        <div className="focus-project"><button type="button" className="text-button focus-project-name preserve-lines" aria-label={t('focusOpenLabel', { name: project.name })} onClick={() => onOpen(project.id)} disabled={busy}>{project.name}</button><StatusBadge status={project.status} /></div>
        <ResumeCard project={project} tasks={tasks} compact />
        <div className="focus-row-actions">
          <Button variant="ghost" icon={NotebookPen} aria-label={t('focusWrapUpLabel', { name: project.name })} disabled={busy} onClick={() => onWrapUp(project.id)}>{t('wrapUpAction')}</Button>
          <div className="focus-order-actions" role="group" aria-label={t('focusOrder', { name: project.name })}>
            <IconButton icon={ArrowUp} label={t('focusMoveUp', { name: project.name })} disabled={busy || index === 0} onClick={() => onMove(project.id, 'up')} />
            <IconButton icon={ArrowDown} label={t('focusMoveDown', { name: project.name })} disabled={busy || index === selected.length - 1} onClick={() => onMove(project.id, 'down')} />
            <IconButton icon={X} label={t('focusRemoveLabel', { name: project.name })} disabled={busy} onClick={() => onRemove(project.id)} />
          </div>
        </div>
      </li>)}</ol>
      <Button variant="ghost" disabled={busy} onClick={onBrowse}>{t('focusBrowse')}</Button>
    </> : <div className="focus-empty"><h3>{t('focusEmptyTitle')}</h3><p>{t('focusEmptyDescription')}</p><Button disabled={busy} onClick={onBrowse}>{t('focusBrowse')}</Button></div>}
  </section>;
}
