import { LocalizedError, type MessageParams } from './i18n.js';
import { errorMessages, type ErrorCode } from './messages.js';

export const MAX_MARKDOWN_BYTES = 1024 * 1024;
export class MarkdownImportError extends LocalizedError<ErrorCode> {
  constructor(readonly code: ErrorCode, params: MessageParams = {}) {
    super(errorMessages, code, params);
    this.name = 'MarkdownImportError';
  }
}
export function failMarkdown(code: ErrorCode): never { throw new MarkdownImportError(code); }
const blank = (value: string) => value.trim().length === 0;
const encoder = new TextEncoder();
export function checkMarkdownSize(text: string, code: 'markdown.large' | 'markdown.promptLarge' = 'markdown.large') {
  if (text.length > MAX_MARKDOWN_BYTES || encoder.encode(text).byteLength > MAX_MARKDOWN_BYTES) failMarkdown(code);
  if (/[\uD800-\uDFFF]/u.test(text)) failMarkdown('markdown.unicode');
}
export const markdownInline = (value: string) => value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
/** Reverse only the exporter's escaping, once. Never interpret HTML or Markdown. */
export function decodeMarkdownInline(value: string, maximum: number, minimum = 0): string {
  const decoded = value.replace(/\\([\\`*_{}\[\]()#+.!|~-])/g, '$1')
    .replace(/&(amp|lt|gt);/g, (_, entity: 'amp' | 'lt' | 'gt') => ({ amp: '&', lt: '<', gt: '>' })[entity]);
  if (decoded.length < minimum || decoded.length > maximum || /[\u0000-\u001f\u007f]/.test(decoded)) failMarkdown('markdown.invalid');
  return decoded;
}
function fenceFor(text: string, character: string) {
  let longest = 0, run = 0;
  for (const value of text) { run = value === character ? run + 1 : 0; longest = Math.max(longest, run); }
  return character.repeat(Math.max(3, longest + 1));
}
export function markdownBlock(value: string) {
  const normalized = value.replace(/\r\n?/g, '\n');
  const fence = fenceFor(normalized, '~');
  return `${fence}text\n${normalized}\n${fence}`;
}
export function frameMarkdownPrompt(instructions: string, markdown: string) {
  const fence = fenceFor(markdown, '`');
  const prompt = `${instructions}\n\n${fence}markdown\n${markdown}${markdown.endsWith('\n') ? '' : '\n'}${fence}\n`;
  checkMarkdownSize(prompt, 'markdown.promptLarge');
  return prompt;
}

/** Bounded, forward-only reader. Body text never enters the heading parser. */
export class MarkdownLines {
  private readonly lines: string[];
  private cursor = 0;
  private end: number;
  constructor(text: string) {
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    this.lines = withoutBom.replace(/\r\n?/g, '\n').split('\n');
    this.end = this.lines.length;
    while (this.cursor < this.end && blank(this.lines[this.cursor])) this.cursor++;
    while (this.end > this.cursor && blank(this.lines[this.end - 1])) this.end--;
    if (this.cursor === this.end) failMarkdown('markdown.invalid');
    if (this.lines[this.cursor].startsWith('```')) {
      const wrapper = /^(`{3,})(?:md|markdown)$/.exec(this.lines[this.cursor]);
      if (!wrapper || this.end - this.cursor < 3 || this.lines[this.end - 1] !== wrapper[1]) failMarkdown('markdown.fence');
      this.cursor++; this.end--;
      for (let index = this.cursor; index < this.end; index++) {
        const closing = /^ {0,3}(`{3,})[\t ]*$/.exec(this.lines[index]);
        if (closing && closing[1].length >= wrapper[1].length) failMarkdown('markdown.fence');
      }
    }
  }
  next(): string | undefined {
    while (this.cursor < this.end && blank(this.lines[this.cursor])) this.cursor++;
    return this.cursor < this.end ? this.lines[this.cursor++] : undefined;
  }
  body(maximum: number): string {
    const opening = this.next();
    if (opening === undefined || !/^~{3,}text$/.test(opening)) failMarkdown('markdown.fence');
    const fence = opening.slice(0, -4), start = this.cursor;
    let length = 0;
    while (this.cursor < this.end) {
      const line = this.lines[this.cursor++];
      if (line === fence) return this.lines.slice(start, this.cursor - 1).join('\n');
      if (line.includes(fence)) failMarkdown('markdown.fence');
      length += line.length + (this.cursor - 1 > start ? 1 : 0);
      if (length > maximum) failMarkdown('markdown.fieldLarge');
    }
    return failMarkdown('markdown.fence');
  }
}
