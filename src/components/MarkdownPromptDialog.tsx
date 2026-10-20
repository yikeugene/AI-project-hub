import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { LocalizedError } from '../../shared/i18n';
import { copyText, useAction, useBeforeUnload } from '../hooks';
import { useT } from '../i18n';
import { markdownImportMessages } from '../locales/markdown-import';
import { Button, ErrorNotice, Field, Modal, Notice } from './ui';

export function MarkdownPromptDialog({ text, filename, isCurrent, onClose, onBusyChange }: {
  text: string; filename: string; isCurrent: () => boolean; onClose: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const t = useT(markdownImportMessages); const action = useAction(text);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true); const copying = useRef(false);
  const current = useRef(isCurrent); current.current = isCurrent;
  useBeforeUnload(action.busy);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusyChange(false); }; }, [onBusyChange]);
  const copy = async () => {
    if (copying.current) return;
    copying.current = true; setCopied(false);
    const result = await action.run(async () => {
      if (!current.current()) throw new LocalizedError(markdownImportMessages, 'promptUnavailable');
      await copyText(text);
    });
    if (alive.current && current.current() && result.ok) setCopied(true);
    copying.current = false;
  };
  const close = () => { if (!copying.current) onClose(); };
  return <Modal title={t('promptTitle')} description={t('promptDescription')} wide className="markdown-prompt-dialog" onClose={close}>
    <div className="modal-body"><Notice>{t('promptLocalOnly')}</Notice><p className="field-hint markdown-prompt-source">{t('promptSource', { filename })}</p>
      <Field label={t('promptText')}><textarea className="markdown-prompt-text" value={text} readOnly rows={16} spellCheck={false} autoFocus /></Field>
      <ErrorNotice message={action.error} />{copied && <p className="inline-success" role="status"><Check size={16} aria-hidden="true" />{t('promptCopied')}</p>}
    </div>
    <footer className="modal-footer"><Button disabled={action.busy} onClick={close}>{t('close')}</Button><Button className="markdown-prompt-copy" variant="primary" icon={copied ? Check : Copy} busy={action.busy} disabled={!isCurrent()} onClick={() => { void copy(); }}>{t('promptCopy')}</Button></footer>
  </Modal>;
}
