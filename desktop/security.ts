import { z } from 'zod';

export const MAX_NATIVE_TEXT_BYTES = 1024 * 1024;
const text = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= MAX_NATIVE_TEXT_BYTES, '內容不可超過 1 MB。');
export const clipboardInput = text;
export const saveTextInput = z.object({
  filename: z.string().min(1).max(180).regex(/^[^<>:"/\\|?*\x00-\x1f]+\.(md|json|txt)$/i, '只接受 Markdown、JSON 或文字檔名。'),
  text,
}).strict();

export function isAppUrl(url: string, origin: string): boolean {
  try { const parsed = new URL(url); return parsed.origin === origin && parsed.username === '' && parsed.password === ''; }
  catch { return false; }
}
export function isMainDocumentUrl(url: string, origin: string): boolean {
  try { const parsed = new URL(url); return isAppUrl(url, origin) && parsed.pathname === '/' && parsed.search === ''; }
  catch { return false; }
}
