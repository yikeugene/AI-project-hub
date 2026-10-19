import { ArrowUpRight, CircleHelp, Compass, CornerDownRight, Flag, NotebookPen } from 'lucide-react';
import { getFocusItems } from '../../shared/insights';
import type { Project, Task } from '../../shared/types';
import { PriorityBadge } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { focusMessages } from '../locales/panels-focus';

export function FocusPanel({ projects, tasks, staleDays, onOpen }: { projects: Project[]; tasks: Task[]; staleDays: number; onOpen: (id: string) => void }) {
  const locale = useLocale();
  const t = useT(focusMessages);
  const items = getFocusItems(projects, tasks, staleDays, undefined, locale).slice(0, 4);
  return <aside className="focus-column"><section className="panel focus-panel"><header className="focus-heading"><span className="focus-symbol"><Compass size={20} strokeWidth={1.7} /></span><div><h2>{t('title')}</h2><p>{t('subtitle')}</p></div></header>
    {items.length ? <div className="focus-list">{items.map((item, index) => <article key={item.project.id} className={`focus-item ${index === 0 ? 'focus-leading' : ''}`}><div className="focus-project"><span>{item.project.name}</span><PriorityBadge priority={item.task?.priority ?? item.project.priority} /></div><button className="focus-action text-button" onClick={() => onOpen(item.project.id)}>{item.action}<ArrowUpRight size={17} /></button><div className="focus-source"><CornerDownRight size={13} />{item.task ? t('taskSource') : t('nextActionSource')}</div><details className="focus-reasons"><summary>{t('why')}<span>{t('score', { score: item.score })}</span></summary><ul>{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details></article>)}</div> : <div className="focus-empty"><div className="focus-crosshair" aria-hidden="true"><Flag size={24} strokeWidth={1.5} /></div><h3>{t('emptyTitle')}</h3><p>{t('emptyDescription')}</p><span className="quiet-pill"><span className="status-dot" />{t('awaitingAction')}</span></div>}
    <details className="focus-rules"><summary><CircleHelp size={15} />{t('ranking')}</summary><p>{t('localRules')}</p><ul><li>{t('priorityRule')}</li><li>{t('activeRule')}</li><li>{t('excludedProjects')}</li><li>{t('excludedTasks')}</li><li>{t('staleRule')}</li></ul><p>{t('explanation')}</p></details>
  </section><div className="context-note"><NotebookPen size={17} strokeWidth={1.6} /><div><strong>{t('contextTitle')}</strong><p>{t('contextDescription')}</p></div></div></aside>;
}
