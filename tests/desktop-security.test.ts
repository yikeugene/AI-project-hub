import { describe, expect, it } from 'vitest';
import { clipboardInput, isAppUrl, isMainDocumentUrl, MAX_NATIVE_TEXT_BYTES, saveTextInput } from '../desktop/security.js';

describe('narrow native bridge policy', () => {
  const origin = 'http://127.0.0.1:54321';
  it('matches an exact origin, not URL prefixes or credentials', () => {
    expect(isAppUrl(origin + '/api/workspace', origin)).toBe(true);
    for (const value of ['http://127.0.0.1:54322/', 'http://127.0.0.1:54321.evil.example/', 'https://127.0.0.1:54321/', 'file:///etc/passwd', 'http://user@127.0.0.1:54321/', 'javascript:alert(1)']) expect(isAppUrl(value, origin)).toBe(false);
  });
  it('admits only the main application document for privileged IPC', () => {
    expect(isMainDocumentUrl(origin + '/', origin)).toBe(true);
    expect(isMainDocumentUrl(origin + '/#projects', origin)).toBe(true);
    expect(isMainDocumentUrl(origin + '/api/workspace', origin)).toBe(false);
    expect(isMainDocumentUrl(origin + '/?redirect=evil', origin)).toBe(false);
  });
  it('bounds UTF-8 text and rejects filenames containing paths or executable extensions', () => {
    expect(clipboardInput.safeParse('中'.repeat(300_000)).success).toBe(true);
    expect(clipboardInput.safeParse('中'.repeat(400_000)).success).toBe(false);
    expect(clipboardInput.safeParse('x'.repeat(MAX_NATIVE_TEXT_BYTES + 1)).success).toBe(false);
    expect(saveTextInput.parse({ filename: '交接.md', text: 'checkpoint' }).filename).toBe('交接.md');
    for (const filename of ['../escape.md', 'C:\\file.md', 'run.exe', 'file.md:stream', 'a\n.md', 'sub/file.json']) expect(saveTextInput.safeParse({ filename, text: '' }).success).toBe(false);
    expect(saveTextInput.safeParse({ filename: 'safe.json', text: '{}', command: 'no' }).success).toBe(false);
  });
});
