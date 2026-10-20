import { LocalizedError } from '../shared/i18n';
import { MAX_MARKDOWN_BYTES } from '../shared/markdown-import';
import { markdownImportMessages } from './locales/markdown-import';

export const markdownTextBytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Read only the browser-selected File. Keep BOM and whitespace intact for the server's raw hash. */
export async function readMarkdownFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (file.size > MAX_MARKDOWN_BYTES) throw new LocalizedError(markdownImportMessages, 'tooLarge');
  let buffer: ArrayBuffer;
  try { buffer = await file.arrayBuffer(); }
  catch { throw new LocalizedError(markdownImportMessages, 'readFailed'); }
  if (buffer.byteLength > MAX_MARKDOWN_BYTES) throw new LocalizedError(markdownImportMessages, 'tooLarge');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new LocalizedError(markdownImportMessages, 'invalidUtf8'); }
  if (markdownTextBytes(text) > MAX_MARKDOWN_BYTES) throw new LocalizedError(markdownImportMessages, 'tooLarge');
  return text;
}

/** Reads and previews share an input generation; edits, new files and unmount invalidate old work. */
export function createMarkdownInputGuard() {
  let version = 0;
  return { advance: () => ++version, isCurrent: (captured: number) => version === captured };
}
