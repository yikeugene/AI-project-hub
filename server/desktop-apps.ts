import { appError } from './validation.js';
import path from 'node:path';
import { DESKTOP_APPS, DESKTOP_APP_LABELS, type DesktopApp, type DesktopCapabilities } from '../shared/types.js';
import { environmentValue, findTrustedExecutable, isLocalAbsolutePath, runCommand } from './commands.js';
import { executeLaunch, type LaunchPlan } from './launcher.js';

// Fixed source only: no paths, app IDs, project data or request values are interpolated.
// Import the Windows module from PowerShell's own system directory, not a user module path.
export const START_APPS_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [Console]::OutputEncoding',
  "Import-Module (Join-Path $PSHOME 'Modules\\StartLayout\\StartLayout.psd1') -ErrorAction Stop",
  "ConvertTo-Json -InputObject @(StartLayout\\Get-StartApps | Where-Object { $_.Name -ceq 'Claude' -or $_.Name -ceq 'ChatGPT' } | Select-Object Name, AppID) -Compress",
].join('; ');
export const DESKTOP_DISCOVERY_CACHE_MS = 30_000;
const DISCOVERY_MAX_BYTES = 64 * 1024;
const DISPLAY_NAMES: Record<DesktopApp, string> = { claude: 'Claude', chatgpt: 'ChatGPT' };
type AppIds = Record<DesktopApp, string | null>;
type Discovery = { ids: AppIds; explorer: string | null };
const unavailable = (): Discovery => ({ ids: { claude: null, chatgpt: null }, explorer: null });

export interface DesktopAppDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  locate?: typeof findTrustedExecutable;
  run?: typeof runCommand;
  execute?: (plan: LaunchPlan) => Promise<void>;
  now?: () => number;
}

/** AppUserModel IDs only; never a path, URL, argument list or shell expression. */
function validAppId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:![A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value);
}

function readAppIds(stdout: string): AppIds {
  const ids: AppIds = { claude: null, chatgpt: null };
  if (Buffer.byteLength(stdout, 'utf8') > DISCOVERY_MAX_BYTES) return ids;
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  // The fixed script always emits an array, including zero or one match.
  if (!Array.isArray(parsed)) return ids;
  for (const app of DESKTOP_APPS) {
    const matches = parsed.filter((entry: unknown): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && 'Name' in entry && entry.Name === DISPLAY_NAMES[app]);
    // Even duplicate exact-name registrations are ambiguous: never guess which to open.
    if (matches.length === 1 && validAppId(matches[0].AppID)) ids[app] = matches[0].AppID;
  }
  return ids;
}

/** Native Windows chat applications only; the existing CLI launcher is independent. */
export function createDesktopApps(dependencies: DesktopAppDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const locate = dependencies.locate ?? findTrustedExecutable;
  const run = dependencies.run ?? runCommand;
  const execute = dependencies.execute ?? executeLaunch;
  const now = dependencies.now ?? Date.now;
  const root = environmentValue(env, 'SystemRoot') ?? 'C:\\Windows';
  const systemRoot = isLocalAbsolutePath(root, 'win32') ? path.win32.normalize(root) : null;
  const powershellDirectory = systemRoot ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0') : null;
  const processEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^(PATH|PSModulePath|AI_PROJECT_HUB_COMMAND|ELECTRON_RUN_AS_NODE|NoDefaultCurrentDirectoryInExePath|COMSPEC)$/i.test(key)) processEnv[key] = value;
  }
  if (systemRoot && powershellDirectory) {
    processEnv.PATH = [path.win32.join(systemRoot, 'System32'), systemRoot].join(';');
    processEnv.PSModulePath = path.win32.join(powershellDirectory, 'Modules');
    processEnv.NoDefaultCurrentDirectoryInExePath = '1';
    processEnv.COMSPEC = path.win32.join(systemRoot, 'System32', 'cmd.exe');
  }

  let cache: { value: Discovery; expires: number } | null = null;
  let pending: Promise<Discovery> | null = null;
  async function discover(): Promise<Discovery> {
    if (platform !== 'win32' || !systemRoot || !powershellDirectory) return unavailable();
    if (cache && now() < cache.expires) return cache.value;
    if (pending) return pending;
    pending = (async () => {
      // Native system binaries only. No PATH search and no cwd/project executable fallback.
      const systemTool = async (name: string, directory: string) => {
        const executable = await locate([name], { platform, env: { PATH: '' }, extraDirectories: [directory] });
        const expected = path.win32.join(directory, name);
        return executable && isLocalAbsolutePath(executable, platform)
          && path.win32.normalize(executable).toLowerCase() === expected.toLowerCase() ? executable : null;
      };
      const [powershell, explorer] = await Promise.all([
        systemTool('powershell.exe', powershellDirectory), systemTool('explorer.exe', systemRoot),
      ]);
      if (!powershell || !explorer) return unavailable();
      const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', START_APPS_COMMAND], {
        cwd: systemRoot, env: processEnv, timeoutMs: 5_000, maxOutputBytes: DISCOVERY_MAX_BYTES,
      });
      if (result.code !== 0) return unavailable();
      return { ids: readAppIds(result.stdout), explorer };
    })().catch(() => unavailable()).then((value) => {
      // Cache absent/failed discovery too, so refreshes cannot keep spawning PowerShell.
      cache = { value, expires: now() + DESKTOP_DISCOVERY_CACHE_MS };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  }

  async function getDesktopCapabilities(): Promise<DesktopCapabilities> {
    const { ids, explorer } = await discover();
    return { claude: Boolean(explorer && ids.claude), chatgpt: Boolean(explorer && ids.chatgpt) };
  }

  async function openDesktopApp(app: DesktopApp): Promise<void> {
    if (!DESKTOP_APPS.includes(app)) throw appError(400, 'launch.desktopUnsupported');
    if (platform !== 'win32') throw appError(400, 'launch.windowsOnly');
    const { ids, explorer } = await discover();
    if (!systemRoot || !explorer || !ids[app]) {
      throw appError(400, 'launch.desktopUnavailable', { app: DESKTOP_APP_LABELS[app] });
    }
    // Explorer accepts ONE literal AppsFolder argument. No clipboard, prompt or cwd transfer.
    await execute({ executable: explorer, args: [`shell:AppsFolder\\${ids[app]}`], cwd: systemRoot, env: { ...processEnv } });
  }
  return { getDesktopCapabilities, openDesktopApp };
}

const desktopApps = createDesktopApps();
export const getDesktopCapabilities = desktopApps.getDesktopCapabilities;
export const openDesktopApp = desktopApps.openDesktopApp;
