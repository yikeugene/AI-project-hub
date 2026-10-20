import { z } from 'zod';
import { MEMORY_FIELDS, PRIORITIES, PROJECT_STATUSES, TASK_STATUSES } from '../shared/types.js';
import { DEFAULT_LOCALE, LOCALES, type Locale, type MessageParams } from '../shared/i18n.js';
import { translateError, type ErrorCode } from '../shared/messages.js';

const text = (max: number) => z.string().max(max);
export const revisionSchema = z.number().int().positive();
export const memorySchema = z.object(Object.fromEntries(MEMORY_FIELDS.map(key => [key, text(20000)])) as Record<typeof MEMORY_FIELDS[number], z.ZodString>).strict();
export const projectFields = {
  name: text(120).trim().min(1), description: text(2000), category: text(80),
  status: z.enum(PROJECT_STATUSES), priority: z.enum(PRIORITIES), stage: text(160), nextAction: text(2000),
};
export const createProjectSchema = z.object({ ...projectFields, path: text(4096).min(1) }).partial().required({ path: true }).strict();
export const updateProjectSchema = z.object(projectFields).partial().extend({ revision: revisionSchema }).strict();
export const wrapUpProjectSchema = z.object({
  revision: revisionSchema, status: text(20000), blockers: text(20000),
  nextAction: text(2000).refine(value => value.trim().length > 0),
}).strict();
export const workspaceFocusSchema = z.object({ revision: revisionSchema, projectIds: z.array(z.string().uuid()) }).strict();
export const taskFields = { title: text(500).trim().min(1), detail: text(10000), status: z.enum(TASK_STATUSES), priority: z.enum(PRIORITIES) };
export const createTaskSchema = z.object(taskFields).partial().required({ title: true }).strict();
export const updateTaskSchema = z.object(taskFields).partial().extend({ revision: revisionSchema }).strict();
export const settingsSchema = z.object({
  scanRoots: z.array(text(4096).min(1)).max(30).optional(),
  staleDays: z.number().int().min(1).max(365).optional(),
  refreshSeconds: z.number().int().refine(n => n === 0 || (n >= 30 && n <= 3600), { message: 'Refresh interval must be 0 or 30–3600 seconds.', params: { errorCode: 'validation.refreshSeconds' } }).optional(),
  locale: z.enum(LOCALES).optional(),
}).strict();
export const sharedStateSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.string().uuid(), projectName: text(120),
  exportedAt: z.string().datetime(), memory: memorySchema, nextAction: text(2000),
}).strict();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type WrapUpProjectInput = z.infer<typeof wrapUpProjectSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: ErrorCode, public params?: MessageParams) { super(message); this.name = 'HttpError'; }
}

/** Keep a useful English Error.message for non-HTTP callers; resolve UI text at the boundary. */
export function appError(status: number, code: ErrorCode, params?: MessageParams): HttpError {
  return new HttpError(status, translateError(code, DEFAULT_LOCALE, params), code, params);
}
export function errorResponse(code: ErrorCode, locale: Locale, params?: MessageParams) {
  return { error: translateError(code, locale, params), code, ...(params ? { params } : {}) };
}
export function errorMessage(error: unknown, locale: Locale): string {
  return error instanceof HttpError && error.code ? translateError(error.code, locale, error.params)
    : error instanceof Error ? error.message : translateError('request.failed', locale);
}

/** Localize app-owned validation, not user text or arbitrary third-party messages. */
export function validationDetails(error: z.ZodError, locale: Locale): string {
  return error.issues.map(issue => {
    let message: string;
    switch (issue.code) {
      case 'invalid_type': message = translateError(issue.received === 'undefined' ? 'validation.required' : 'validation.type', locale, { type: issue.expected }); break;
      case 'invalid_enum_value': message = translateError('validation.enum', locale, { values: issue.options.join(', ') }); break;
      case 'too_small': message = translateError('validation.small', locale, { minimum: String(issue.minimum) }); break;
      case 'too_big': message = translateError('validation.big', locale, { maximum: String(issue.maximum) }); break;
      case 'unrecognized_keys': message = translateError('validation.keys', locale, { keys: issue.keys.join(', ') }); break;
      case 'custom': message = translateError(issue.params?.errorCode === 'validation.refreshSeconds' ? 'validation.refreshSeconds' : 'validation.invalid', locale); break;
      default: message = translateError('validation.invalid', locale);
    }
    return `${issue.path.join('.')} ${message}`.trim();
  }).join('; ');
}
