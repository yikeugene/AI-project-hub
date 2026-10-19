import { useState, type FormEvent } from 'react';
import { Check, CheckCircle2, FolderOpen, FolderSearch, GitBranch, Import, Search } from 'lucide-react';
import type { Project, ScanResult } from '../../shared/types';
import { api } from '../api';
import { useAction } from '../hooks';
import { useT } from '../i18n';
import { shellCatalog } from '../locales/shell';
import { Button, EmptyState, ErrorNotice, Field, Modal, Notice } from './ui';
const pathKey = (path: string) => /^[a-z]:/i.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path;

export function ScanDialog({ roots, projects, onClose, onImported }: { roots: string[]; projects: Project[]; onClose: () => void; onImported: () => Promise<void> }) {
  const t = useT(shellCatalog);
  const [path, setPath] = useState(roots[0] ?? '');
  const [depth, setDepth] = useState(3);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState<{ added: number; skipped: number; errors: string[] } | null>(null);
  const scan = useAction(); const importing = useAction(); const choosing = useAction();
  const changePath = (value: string) => { setPath(value); setResult(null); setImported(null); setSelected(new Set()); };
  const chooseDirectory = async () => {
    const bridge = window.hubDesktop;
    if (!bridge) return;
    const response = await choosing.run(() => bridge.chooseDirectory());
    if (response.ok && response.value !== null) changePath(response.value);
  };
  const existing = new Set(projects.map(p => pathKey(p.path)));
  const available = result?.candidates.filter(c => !existing.has(pathKey(c.path))) ?? [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (scan.busy || importing.busy || choosing.busy) return;
    setImported(null); setResult(null); setSelected(new Set());
    const response = await scan.run(() => api.scan(path.trim(), depth));
    if (response.ok) { setResult(response.value); setSelected(new Set(response.value.candidates.filter(c => !existing.has(pathKey(c.path))).slice(0, 100).map(c => c.path))); await onImported(); }
  };
  const importSelected = async () => {
    const response = await importing.run(async () => { const data = await api.importProjects([...selected]); await onImported(); return data; });
    if (response.ok) { setImported(response.value); setSelected(new Set()); }
  };
  const busy = scan.busy || importing.busy || choosing.busy;
  return <Modal title={t('scan.title')} description={t('scan.description')} onClose={() => { if (!busy) onClose(); }} wide>
    <div className="modal-body form-stack">
      <form className="scan-form" onSubmit={event => { void submit(event); }}>
        <div className="path-picker"><Field label={t('scan.folder')} required hint={t('scan.folderHint')}><input maxLength={4096} value={path} onChange={event => changePath(event.target.value)} placeholder="C:\Users\you\Projects" required list="scan-root-history" spellCheck={false} disabled={busy} /><datalist id="scan-root-history">{roots.map(root => <option key={root} value={root} />)}</datalist></Field>{window.hubDesktop && <Button icon={FolderOpen} disabled={scan.busy || importing.busy} busy={choosing.busy} onClick={() => { void chooseDirectory(); }}>{t('common.chooseFolder')}</Button>}</div>
        <div className="scan-options"><Field label={t('scan.depth')}><select value={depth} onChange={e => setDepth(Number(e.target.value))} disabled={busy}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{t('scan.levels', { count: n })}</option>)}</select></Field><Button type="submit" icon={Search} variant="primary" busy={scan.busy} disabled={importing.busy || choosing.busy}>{t('scan.start')}</Button></div>
      </form>
      <ErrorNotice message={scan.error || importing.error} /><ErrorNotice message={choosing.error} />
      {imported && <div className="import-result" role="status"><CheckCircle2 size={21} /><div><strong>{t('scan.added', { count: imported.added })}</strong><p>{imported.skipped > 0 ? t('scan.skipped', { count: imported.skipped }) : t('scan.saved')}</p>{imported.errors.map((error, i) => <ErrorNotice key={i} message={error} />)}</div></div>}
      {result ? <>
        {result.warnings.length > 0 && <Notice warning><strong>{t('scan.incomplete')}</strong><ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></Notice>}
        {result.truncated && <Notice warning>{t('scan.truncated')}</Notice>}
        <div className="scan-results-heading"><div><strong>{t('scan.found', { count: result.candidates.length })}</strong><span className="muted">{t('scan.visited', { count: result.visited })}</span></div>{available.length > 0 && <Button variant="ghost" onClick={() => setSelected(selected.size ? new Set() : new Set(available.slice(0, 100).map(c => c.path)))}>{t(selected.size ? 'scan.deselect' : 'scan.selectAvailable')}</Button>}</div>
        {result.candidates.length ? <div className="scan-results">{result.candidates.map(candidate => {
          const exists = existing.has(pathKey(candidate.path));
          return <label key={candidate.path} className={`scan-candidate ${exists ? 'already-added' : ''}`}><input type="checkbox" checked={selected.has(candidate.path)} disabled={exists || busy || (!selected.has(candidate.path) && selected.size >= 100)} onChange={e => setSelected(current => { const next = new Set(current); if (e.target.checked) next.add(candidate.path); else next.delete(candidate.path); return next; })} /><div className="candidate-icon">{candidate.kind === 'git' ? <GitBranch size={18} /> : <FolderSearch size={18} />}</div><div className="candidate-info"><strong>{candidate.name}</strong><span className="path-text">{candidate.path}</span><span className="candidate-markers">{candidate.markers.join(' / ')}</span></div>{exists && <span className="added-label"><Check size={13} />{t('scan.alreadyAdded')}</span>}</label>;
        })}</div> : <EmptyState compact icon={FolderSearch} title={t('scan.empty')} description={t('scan.emptyDescription')} />}
        {available.length > 100 && <p className="field-hint">{t('scan.limit')}</p>}
      </> : !scan.busy && <div className="scan-intro"><FolderSearch size={34} strokeWidth={1.3} /><div><h3>{t('scan.intro')}</h3><p className="preserve-lines">{t('scan.introDescription')}</p></div></div>}
      {scan.busy && <p className="muted" role="status">{t('scan.scanning')}</p>}
    </div>
    <footer className="modal-footer"><span className="footer-note">{selected.size > 0 ? t('scan.selected', { count: selected.size }) : t('scan.localOnly')}</span><Button onClick={onClose} disabled={busy}>{t(imported ? 'scan.done' : 'common.cancel')}</Button><Button variant="primary" icon={Import} onClick={() => { void importSelected(); }} disabled={!selected.size || scan.busy || choosing.busy} busy={importing.busy}>{t('scan.import')}</Button></footer>
  </Modal>;
}
