import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import { Store } from './db.js';
import { createApp, type AppOptions } from './app.js';
import { DeviceService, type DeviceOptions } from './devices.js';
import { AppObservationService, type AppObservationOptions } from './app-observation.js';
import { appError, errorResponse } from './validation.js';
import { coreTranslator } from '../shared/locales/core.js';
import { GovernanceService } from './governance.js';
import { GitApprovalService, type GitEngine } from './git-approvals.js';

export const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
export const DESKTOP_KEY_HEADER = 'x-hub-desktop-key';

export function defaultDataDirectory(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'AIProjectHub');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'AIProjectHub');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ai-project-hub');
}

export interface RuntimeOptions {
  dataDir?: string;
  assetDirectory: string;
  port?: number;
  mode?: 'web' | 'desktop';
  desktopSecret?: string;
  enablePolling?: boolean;
  appOptions?: Omit<AppOptions, 'store' | 'dataDir' | 'mode' | 'deviceService' | 'gitService' | 'governanceService' | 'appObservationService'>;
  appObservationOptions?: AppObservationOptions;
  deviceOptions?: Omit<DeviceOptions, 'mode'> & { enablePolling?: boolean };
  gitEngine?: Partial<GitEngine>;
  /** Development-only middleware; desktop builds never import Vite. */
  configureDevelopment?: (app: Express, server: Server) => Promise<(() => Promise<void>) | void>;
}

/** Owns one database, one listener and one refresh scheduler; no import-time side effects. */
export async function createHubRuntime(options: RuntimeOptions) {
  const mode = options.mode ?? 'web';
  if (mode === 'desktop' && !/^[a-f0-9]{64}$/.test(options.desktopSecret ?? '')) throw appError(400, 'runtime.secret');
  const port = options.port ?? (mode === 'desktop' ? 0 : 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw appError(400, 'runtime.port');
  const assets = resolve(options.assetDirectory);
  if (!options.configureDevelopment && !existsSync(join(assets, 'index.html'))) throw appError(400, 'runtime.assets');
  const dataDir = resolve(options.dataDir || process.env.HUB_DATA_DIR || defaultDataDirectory());
  const store = new Store(join(dataDir, 'hub.sqlite'));
  const outer = express();
  outer.disable('x-powered-by');
  if (mode === 'desktop') {
    const expected = Buffer.from(options.desktopSecret!);
    outer.use((req, res, next) => {
      const supplied = req.headers[DESKTOP_KEY_HEADER];
      res.setHeader('Cache-Control', 'no-store');
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), expected)) {
        res.status(401).json(errorResponse('runtime.desktopOnly', store.getSettings().locale)); return;
      }
      next();
    });
  }
  const devices = new DeviceService(store, { ...options.deviceOptions, mode });
  const governance = new GovernanceService(store, devices);
  const appObservation = new AppObservationService(store, devices, options.appObservationOptions);
  const git = new GitApprovalService(store, devices, governance, options.gitEngine);
  governance.onRefresh((client, context) => git.sync(client, context));
  devices.onSynced(async profileId => {
    // Optional observation traffic is tracked independently and must not delay existing governance/Git work.
    void appObservation.refresh(profileId).catch(() => {});
    await governance.refresh(profileId);
  });
  const { app, refreshAll, waitForIdle } = createApp({ ...options.appOptions, store, dataDir, mode, deviceService: devices,
    gitService: git, governanceService: governance, appObservationService: appObservation,
    onActivity: (kind, state) => { governance.record(kind, state); options.appOptions?.onActivity?.(kind, state); } });
  outer.use(app);
  const server = createServer(outer);
  let disposeDevelopment: (() => Promise<void>) | void = undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  try {
    if (options.configureDevelopment) disposeDevelopment = await options.configureDevelopment(app, server);
    else {
      app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', PRODUCTION_CSP); next(); });
      app.use(express.static(assets, { index: false }));
      app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: assets }));
    }
    await new Promise<void>((done, fail) => {
      const failed = (error: Error) => { server.off('listening', ready); fail(error); };
      const ready = () => { server.off('error', failed); done(); };
      server.once('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
    });
  } catch (error) {
    await appObservation.stop();
    await git.stop();
    await governance.stop();
    await devices.stop();
    await disposeDevelopment?.();
    store.close();
    throw error;
  }
  if (options.deviceOptions?.enablePolling !== false) devices.start();
  const actualPort = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${actualPort}`;
  if (options.enablePolling !== false) {
    void refreshAll().catch(error => console.error(coreTranslator(store.getSettings().locale)('runtime.initialRefresh'), error.message));
    let lastRefresh = Date.now();
    timer = setInterval(() => {
      if (closing) return;
      const seconds = store.getSettings().refreshSeconds;
      if (seconds > 0 && Date.now() - lastRefresh >= seconds * 1000) {
        lastRefresh = Date.now(); void refreshAll().catch(error => console.error(coreTranslator(store.getSettings().locale)('runtime.backgroundRefresh'), error.message));
      }
    }, 5000);
    timer.unref();
  }
  function stop(): Promise<void> {
    if (closing) return closing;
    if (timer) clearInterval(timer);
    closing = (async () => {
      // server.close drains all HTTP work, not only Git observations.
      const drained = new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
      await appObservation.stop();
      await git.stop();
      await governance.stop();
      await devices.stop();
      await disposeDevelopment?.();
      await drained;
      await waitForIdle();
      store.close();
    })();
    return closing;
  }
  function setActivityMode(mode: 'foreground' | 'background') { if (!closing) governance.setActivityMode(mode); }
  function resumed() {
    if (closing) return;
    void devices.syncAll().catch(() => {});
    void refreshAll().catch(() => {});
  }
  function setAppObservationSessionAvailable(available: boolean) { if (!closing) appObservation.setSessionAvailable(available); }
  return { origin, port: actualPort, dataDir, store, devices, governance, appObservation, git, refreshAll, setActivityMode, setAppObservationSessionAvailable, resumed, stop };
}
export type HubRuntime = Awaited<ReturnType<typeof createHubRuntime>>;
