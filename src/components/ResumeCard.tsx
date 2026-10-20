import { ArrowRight, Clock3, NotebookPen } from 'lucide-react';
import { getResumeSummary } from '../../shared/insights';
import type { Project, Task } from '../../shared/types';
import { formatDate } from '../hooks';
import { useLocale, useT } from '../i18n';
import { resumptionMessages } from '../locales/resumption';
import { Button } from './ui';

interface ResumeCardProps {
  project: Project;
  tasks: Task[];
  compact?: boolean;
  onWrapUp?: () => void;
  onMemory?: () => void;
}

/** Derived only from the workspace snapshot. Rendering a card never reads the repository. */
export function ResumeCard({ project, tasks, compact = false, onWrapUp, onMemory }: ResumeCardProps) {
  const locale = useLocale();
  const t = useT(resumptionMessages);
  const summary = getResumeSummary(project, tasks, locale);
  const purpose = project.memory.overview.trim() ? project.memory.overview : project.description;
  const hasBlockers = !!project.memory.blockers.trim();
  const nextSource = summary.nextActionSource === 'recorded' ? 'nextRecorded' : summary.nextActionSource === 'suggested' ? 'nextSuggested' : 'nextEmpty';
  const checkpointMeta = <div className="resume-meta">
    <span className="resume-source">{t(project.checkpointAt ? 'checkpointSource' : 'memorySource')}</span>
    {project.checkpointAt
      ? <span>{t('checkpointDate', { date: formatDate(project.checkpointAt, true, locale) })}</span>
      : project.memoryUpdatedAt && <span>{t('memoryDate', { date: formatDate(project.memoryUpdatedAt, true, locale) })}</span>}
  </div>;

  return <section className={`resume-card${compact ? ' resume-card-compact' : ''}`} aria-label={t('resumeLabel', { name: project.name })}>
    {!compact && <>
      <div className="resume-purpose"><h3>{t('purpose')}</h3><p className="preserve-lines">{purpose.trim() ? purpose : t('purposeEmpty')}</p></div>
      <div className="resume-checkpoint">
        <div className="resume-title"><Clock3 size={18} aria-hidden="true" /><h3>{t('checkpoint')}</h3></div>
        <p className="preserve-lines">{summary.checkpoint}</p>
        {checkpointMeta}
      </div>
    </>}
    <div className="resume-next">
      {!compact && <span className="next-icon"><ArrowRight size={20} aria-hidden="true" /></span>}
      <div className="resume-next-content"><h3>{t('nextStep')}</h3><p className="preserve-lines">{summary.nextAction}</p><span className="resume-source">{t(nextSource)}</span></div>
    </div>
    {compact && checkpointMeta}
    {(!compact || hasBlockers) && <div className={`resume-blockers${compact ? '' : ` detail-section${hasBlockers ? ' blockers-note' : ''}`}`}>
      <h3>{t('blockers')}</h3><p className="preserve-lines">{hasBlockers ? project.memory.blockers : t('blockersEmpty')}</p>
    </div>}
    {!compact && <div className="resume-facts detail-section"><h3>{t('facts')}</h3><ul className="fact-list">{summary.facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></div>}
    {(onWrapUp || onMemory) && <div className="resume-actions">
      {onWrapUp && <Button variant="primary" icon={NotebookPen} onClick={onWrapUp}>{t('wrapUpAction')}</Button>}
      {onMemory && <Button variant="ghost" onClick={onMemory}>{t('memoryAction')}</Button>}
    </div>}
  </section>;
}
