import type { ChangeEntry } from '../../shared/devices';
import { useT } from '../i18n';
import { shellCatalog } from '../locales/shell';

/** Presentational only: callers retain their own captured hash, revision and confirmation rules. */
export function ChangePreview({ changes, beforeLabel, afterLabel }: { changes: ChangeEntry[]; beforeLabel?: string; afterLabel?: string }) {
  const t = useT(shellCatalog);
  return <div className="shared-diffs">{changes.map(change => <details key={change.key} open={change.before !== change.after}><summary>{change.label}<span>{t(change.before === change.after ? 'diff.same' : 'diff.changed')}</span></summary><div className="diff-columns"><div><span className="diff-label">{beforeLabel ?? t('diff.before')}</span><pre>{change.before || t('common.blank')}</pre></div><div><span className="diff-label">{afterLabel ?? t('diff.after')}</span><pre>{change.after || t('common.blank')}</pre></div></div></details>)}</div>;
}
