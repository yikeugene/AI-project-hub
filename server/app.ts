import express, { type ErrorRequestHandler, type Request } from 'express';
import { basename } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store } from './db.js';
import { canonicalDirectory, scanProjects } from './discovery.js';
import { readGitSnapshot } from './git.js';
import { getCapabilities, openProject } from './launcher.js';
import { buildHandoff, exportHandoff, MAX_STATE_BYTES, previewPastedSharedState, previewSharedState } from './handoff.js';
import { getDesktopCapabilities, openDesktopApp } from './desktop-apps.js';
import { APP_VERSION, DESKTOP_APPS, HANDOFF_TARGETS } from '../shared/types.js';
import { createProjectSchema, createTaskSchema, HttpError, appError, errorMessage, errorResponse, validationDetails, memorySchema, revisionSchema, settingsSchema, updateProjectSchema, updateTaskSchema, workspaceFocusSchema, wrapUpProjectSchema } from './validation.js';
import type { Capabilities, DesktopApp, DesktopCapabilities, GitSnapshot, LaunchAction, Settings } from '../shared/types.js';
import { coreTranslator } from '../shared/locales/core.js';
import { RelayError } from './relay.js';
import { syncError } from './sync.js';
import { deviceRouter, type DeviceService } from './devices.js';
import { gitRouter } from './git-router.js';
import type { GitApprovalService } from './git-approvals.js';
import type { GovernanceService } from './governance.js';

export interface AppOptions {
  store: Store; dataDir: string;
  deviceService?: DeviceService;
  gitService?: GitApprovalService;
  governanceService?: GovernanceService;
  onActivity?: (kind: 'scan', state: 'running' | 'succeeded' | 'failed') => void;
  readGit?: (path: string) => Promise<GitSnapshot>;
  capabilities?: () => Promise<Capabilities>;
  launch?: (path: string, action: LaunchAction) => Promise<void>;
  mode?: 'web' | 'desktop';
  desktopCapabilities?: () => Promise<DesktopCapabilities>;
  openDesktopApp?: (app: DesktopApp) => Promise<void>;
  onSettingsChanged?: (settings: Settings) => void;
}

export function validLocalRequest(req: Pick<Request, 'headers' | 'socket'>): boolean {
  const port = req.socket.localPort;
  const host = req.headers.host;
  if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

export function createApp(options: AppOptions) {
  const { store } = options;
  const locale = () => store.getSettings().locale;
  const app = express();
  app.disable('x-powered-by');
  const token = randomBytes(32).toString('hex');
  app.use((req, res, next) => {
    if (!validLocalRequest(req)) return res.status(403).json(errorResponse('request.localOnly', locale()));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (/^\/api(?:\/|$)/i.test(req.path)) res.setHeader('Cache-Control', 'no-store');
    // Enforce on every mutation, independent of Express's case-insensitive routing.
    if (!['GET', 'HEAD'].includes(req.method)) {
      const supplied = req.headers['x-hub-token'];
      if (!req.is('application/json') || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)))
        return res.status(403).json(errorResponse('request.csrf', locale()));
    }
    next();
  });
  // A <=1 MiB pasted string may expand up to sixfold in its JSON request envelope.
  // Keep all other routes at their existing limit; the pure parser bounds decoded UTF-8 text.
  app.use('/api/projects/:id/shared-state/paste', express.json({ limit: MAX_STATE_BYTES * 6 + 1024 }));
  app.use('/api/desktop-apps/:app/open', express.json({ limit: '1mb', verify: (_req, _res, bytes) => {
    // express.json otherwise normalizes an empty body to {}, which is not a JSON request.
    if (!bytes.length) throw appError(400, 'request.emptyObject');
  } }));
  app.use(express.json({ limit: '1mb' }));
  const inFlight = new Map<string, Promise<void>>();
  const waiting: (() => void)[] = [];
  let active = 0, scanning = false, bulk: Promise<number> | null = null;
  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await fn(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  function observe(id: string): Promise<void> {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const promise = withSlot(async () => {
      const project = store.getProject(id);
      try { store.saveObservation(id, await (options.readGit ?? readGitSnapshot)(project.path), null); }
      catch (error) { store.saveObservation(id, null, errorMessage(error, locale())); }
    }).finally(() => inFlight.delete(id));
    inFlight.set(id, promise);
    return promise;
  }
  function refreshAll(): Promise<number> {
    if (bulk) return bulk;
    const projects = store.listProjects().filter(p => p.status !== 'archived');
    bulk = Promise.allSettled(projects.map(p => observe(p.id))).then(() => projects.length).finally(() => { bulk = null; });
    return bulk;
  }
  const idOf = (req: Request): string => z.string().uuid().parse(req.params.id);
  const confirmed = z.object({ confirm: z.literal(true) });
  const agentSchema = z.enum(HANDOFF_TARGETS).default('generic');
  const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
  const pasteSchema = z.object({ text: z.string().max(MAX_STATE_BYTES) }).strict();

  app.get('/api/workspace', async (_req, res) => {
    res.json({ projects: store.listProjects(), tasks: store.listTasks(), settings: store.getSettings(), focus: store.getFocus(), csrfToken: token,
      environment: { platform: process.platform, dataDir: options.dataDir, capabilities: await (options.capabilities ?? getCapabilities)(), version: APP_VERSION,
        mode: options.mode ?? 'web', desktopApps: await (options.desktopCapabilities ?? getDesktopCapabilities)() } });
  });
  app.put('/api/workspace/focus', (req, res) => {
    const input = workspaceFocusSchema.parse(req.body);
    res.json(store.saveFocus(input.revision, input.projectIds));
  });
  app.post('/api/desktop-apps/:app/open', async (req, res) => {
    const desktopApp = z.enum(DESKTOP_APPS).parse(req.params.app);
    z.object({}).strict().parse(req.body);
    await (options.openDesktopApp ?? openDesktopApp)(desktopApp);
    res.json({ ok: true });
  });
  app.post('/api/projects', async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    const path = await canonicalDirectory(input.path);
    const project = store.createProject({ ...input, path, name: input.name || (basename(path) || path).slice(0, 120) });
    await observe(project.id);
    res.status(201).json(store.getProject(project.id));
  });
  app.patch('/api/projects/:id', (req, res) => res.json(store.updateProject(idOf(req), updateProjectSchema.parse(req.body))));
  app.delete('/api/projects/:id', (req, res) => {
    const input = confirmed.extend({ revision: revisionSchema }).strict().parse(req.body);
    store.deleteProject(idOf(req), input.revision); res.json({ ok: true });
  });
  app.post('/api/scan', async (req, res) => {
    const input = z.object({ path: z.string().min(1).max(4096), depth: z.number().int().min(0).max(8).optional() }).strict().parse(req.body);
    if (scanning) throw appError(409, 'scan.busy');
    scanning = true; options.onActivity?.('scan', 'running');
    try {
      const path = await canonicalDirectory(input.path);
      const result = await scanProjects(path, { depth: input.depth }, locale());
      const roots = store.getSettings().scanRoots;
      store.updateSettings({ scanRoots: [...new Set([path, ...roots])].slice(0, 30) });
      options.onActivity?.('scan', 'succeeded'); res.json(result);
    } catch (error) { options.onActivity?.('scan', 'failed'); throw error; }
    finally { scanning = false; }
  });
  app.post('/api/scan/import', async (req, res) => {
    const { paths } = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(100) }).strict().parse(req.body);
    const ids: string[] = [], errors: string[] = [];
    let skipped = 0;
    for (const input of paths) {
      try {
        const path = await canonicalDirectory(input);
        if (store.findByPath(path)) { skipped++; continue; }
        ids.push(store.createProject({ path, name: (basename(path) || path).slice(0, 120) }).id);
      } catch (error) { errors.push(`${input}: ${errorMessage(error, locale())}`); }
    }
    await Promise.allSettled(ids.map(observe));
    res.json({ added: ids.length, skipped, errors });
  });
  app.post('/api/refresh', async (_req, res) => res.json({ refreshed: await refreshAll() }));
  app.post('/api/projects/:id/refresh', async (req, res) => {
    const id = idOf(req); store.getProject(id); await observe(id); res.json(store.getProject(id));
  });
  app.put('/api/projects/:id/memory', (req, res) => {
    const input = z.object({ revision: revisionSchema, memory: memorySchema }).strict().parse(req.body);
    res.json(store.saveMemory(idOf(req), input.revision, input.memory));
  });
  app.post('/api/projects/:id/wrap-up', (req, res) => res.json(store.wrapUpProject(idOf(req), wrapUpProjectSchema.parse(req.body))));
  app.post('/api/projects/:id/tasks', (req, res) => res.status(201).json(store.createTask(idOf(req), createTaskSchema.parse(req.body))));
  app.patch('/api/tasks/:id', (req, res) => res.json(store.updateTask(idOf(req), updateTaskSchema.parse(req.body))));
  app.delete('/api/tasks/:id', (req, res) => {
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(req.body);
    store.deleteTask(idOf(req), revision); res.json({ ok: true });
  });
  app.get('/api/projects/:id/handoff', (req, res) => {
    res.json(buildHandoff(store.getProject(idOf(req)), store.listTasks(), agentSchema.parse(req.query.agent), locale()));
  });
  app.post('/api/projects/:id/handoff/export', async (req, res) => {
    const input = confirmed.extend({ agent: agentSchema }).strict().parse(req.body);
    res.json(await exportHandoff(store.getProject(idOf(req)), store.listTasks(), input.agent, locale()));
  });
  app.get('/api/projects/:id/shared-state', async (req, res) => res.json(await previewSharedState(store.getProject(idOf(req)))));
  app.post('/api/projects/:id/shared-state/import', async (req, res) => {
    const input = confirmed.extend({ revision: revisionSchema, hash: hashSchema }).strict().parse(req.body);
    const id = idOf(req);
    const preview = await previewSharedState(store.getProject(id));
    if (preview.hash !== input.hash) throw appError(409, 'handoff.fileChanged');
    res.json(store.saveMemory(id, input.revision, preview.state.memory, preview.state.nextAction));
  });
  app.post('/api/projects/:id/shared-state/paste/preview', (req, res) => {
    const { text } = pasteSchema.parse(req.body);
    res.json(previewPastedSharedState(store.getProject(idOf(req)), text, locale()));
  });
  app.post('/api/projects/:id/shared-state/paste/import', (req, res) => {
    const input = pasteSchema.extend({ revision: revisionSchema, hash: hashSchema, confirm: z.literal(true) }).strict().parse(req.body);
    const id = idOf(req);
    const preview = previewPastedSharedState(store.getProject(id), input.text, locale());
    if (preview.hash !== input.hash) throw appError(409, 'handoff.pasteChanged');
    res.json(store.saveMemory(id, input.revision, preview.state.memory, preview.state.nextAction));
  });
  app.post('/api/projects/:id/open', async (req, res) => {
    const { action } = z.object({ action: z.enum(['folder', 'vscode', 'claude', 'codex']) }).strict().parse(req.body);
    const project = store.getProject(idOf(req));
    const path = await canonicalDirectory(project.path);
    if (path !== project.path) throw appError(409, 'project.pathChanged');
    await (options.launch ?? openProject)(path, action); res.json({ ok: true });
  });
  app.patch('/api/settings', async (req, res) => {
    const input = settingsSchema.parse(req.body);
    if (input.scanRoots) input.scanRoots = [...new Set(await Promise.all(input.scanRoots.map(canonicalDirectory)))];
    const settings = store.updateSettings(input);
    // Persistence has already succeeded. A native menu refresh must not turn this into
    // a failed save or encourage the renderer to roll its selected language back.
    try { await options.onSettingsChanged?.({ ...settings, scanRoots: [...settings.scanRoots] }); }
    catch (error) { console.warn(coreTranslator(settings.locale)('runtime.settingsCallback'), error); }
    res.json(settings);
  });
  if (options.deviceService) app.use('/api', deviceRouter(options.deviceService));
  if (options.gitService && options.governanceService) app.use('/api', gitRouter(options.gitService, options.governanceService));
  app.use('/api', (_req, res) => { res.status(404).json(errorResponse('request.notFound', locale())); });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    const language = locale();
    if (error instanceof z.ZodError) { res.status(400).json(errorResponse('validation.failed', language, { details: validationDetails(error, language) })); return; }
    if (error instanceof HttpError && error.code) { res.status(error.status).json(errorResponse(error.code, language, error.params)); return; }
    if (error instanceof RelayError) { const safe = syncError(error, language); res.status(400).json(errorResponse(safe.messageCode, language)); return; }
    if (error?.type === 'entity.too.large') { res.status(413).json(errorResponse('request.tooLarge', language)); return; }
    if (error?.type === 'entity.parse.failed') { res.status(400).json(errorResponse('request.invalidJson', language)); return; }
    const status = error instanceof HttpError ? error.status : 400;
    // External OS/Git/tool details remain raw, never guessed or string-replaced.
    res.status(status).json(error instanceof Error ? { error: error.message } : errorResponse('request.failed', language));
  };
  app.use(errorHandler);
  return { app, refreshAll, waitForIdle: () => Promise.allSettled([...inFlight.values()]) };
}
