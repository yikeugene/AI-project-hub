import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Archive, Check, CheckCircle2, CircleDashed, Loader2, Pause, Play, X, type LucideIcon } from 'lucide-react';
import { getStatusLabels, getPriorityLabels, getTaskLabels, type Priority, type ProjectStatus, type TaskStatus } from '../../shared/types';
import { useLocale, useT } from '../i18n';
import { shellCatalog } from '../locales/shell';

export function Button({ children, variant = 'secondary', icon: Icon, busy, className = '', disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: LucideIcon; busy?: boolean }) {
  return <button type="button" {...props} disabled={disabled || busy} className={`button button-${variant} ${className}`} aria-busy={busy || undefined}>{busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : Icon ? <Icon size={16} aria-hidden="true" /> : null}{children}</button>;
}
export function IconButton({ icon: Icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return <button type="button" {...props} className={`icon-button ${props.className || ''}`} aria-label={label} title={label}><Icon size={17} aria-hidden="true" /></button>;
}
export function ErrorNotice({ message, onDismiss }: { message?: string; onDismiss?: () => void }) {
  const t = useT(shellCatalog);
  if (!message) return null;
  return <div className="notice notice-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div>{message}</div>{onDismiss && <IconButton icon={X} label={t('common.closeError')} onClick={onDismiss} />}</div>;
}
export function Notice({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return <div className={`notice ${warning ? 'notice-warning' : 'notice-info'}`}>{warning ? <AlertTriangle size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}<div>{children}</div></div>;
}
export function EmptyState({ icon: Icon, title, description, children, compact = false }: { icon: LucideIcon; title: string; description: string; children?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'empty-compact' : ''}`}><div className="empty-symbol"><Icon size={25} strokeWidth={1.5} aria-hidden="true" /></div><h3>{title}</h3><p>{description}</p>{children && <div className="empty-actions">{children}</div>}</div>;
}
const statusIcons: Record<ProjectStatus, LucideIcon> = { active: Play, paused: Pause, planning: CircleDashed, completed: CheckCircle2, archived: Archive };
export function StatusBadge({ status }: { status: ProjectStatus }) {
  const locale = useLocale();
  const Icon = statusIcons[status];
  return <span className={`badge status-${status}`}><Icon size={11} aria-hidden="true" />{getStatusLabels(locale)[status]}</span>;
}
export function PriorityBadge({ priority }: { priority: Priority }) {
  const locale = useLocale();
  return <span className={`priority priority-${priority}`}><span className="priority-bars" aria-hidden="true"><i /><i /><i /></span>{getPriorityLabels(locale)[priority]}</span>;
}
export function TaskBadge({ status }: { status: TaskStatus }) {
  const locale = useLocale();
  return <span className={`badge task-${status}`}>{status === 'done' ? <Check size={12} aria-hidden="true" /> : <span className="status-dot" />}{getTaskLabels(locale)[status]}</span>;
}
export function Modal({ title, description, children, onClose, wide = false, className = '' }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string }) {
  const t = useT(shellCatalog);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(); const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''} ${className}`} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="modal-header"><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><IconButton icon={X} label={t('common.closeTitle', { title })} onClick={onClose} /></header>
    {children}
  </dialog>;
}
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose, busy, confirmDisabled = false, error, danger = false }: { title: string; children: ReactNode; confirmLabel?: string; onConfirm: () => void; onClose: () => void; busy?: boolean; confirmDisabled?: boolean; error?: string; danger?: boolean }) {
  const t = useT(shellCatalog);
  return <Modal title={title} onClose={() => { if (!busy) onClose(); }} className="confirm-dialog"><div className="modal-body"><div className="confirm-content">{children}</div><ErrorNotice message={error} /></div><footer className="modal-footer"><Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel ?? t('common.confirm')}</Button></footer></Modal>;
}
export function SectionHeading({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{children && <div className="section-actions">{children}</div>}</div>;
}
export function Field({ label, children, hint, required = false }: { label: string; children: ReactNode; hint?: string; required?: boolean }) {
  const t = useT(shellCatalog);
  return <label className="field"><span className="field-label">{label}{required && <span className="required" aria-label={t('common.required')}> *</span>}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export function Loading({ label }: { label?: string }) {
  const t = useT(shellCatalog);
  return <div className="loading" role="status"><Loader2 className="spin" size={22} aria-hidden="true" /><span>{label ?? t('common.loading')}</span></div>;
}
