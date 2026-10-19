import { appError } from './validation.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Capabilities, LaunchAction } from '../shared/types.ts';
import { canonicalDirectory } from './discovery.ts';
import { environmentValue, findTrustedExecutable, isWithinDirectory, trustedPathDirectories } from './commands.ts';

export interface LaunchPlan { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export interface LauncherDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  locate?: typeof findTrustedExecutable;
  execute?: (plan: LaunchPlan) => Promise<void>;
}
const ACTIONS = new Set<LaunchAction>(['folder', 'vscode', 'claude', 'codex']);
const LABELS: Record<LaunchAction, string> = { folder: 'File manager', vscode: 'Visual Studio Code', claude: 'Claude Code', codex: 'Codex' };
// No project path or user-provided text is ever interpolated into PowerShell source.
export const AGENT_POWERSHELL_COMMAND = '& $env:AI_PROJECT_HUB_COMMAND';

export function executeLaunch(plan: LaunchPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd, env: plan.env, shell: false, windowsHide: false,
      detached: true, stdio: 'ignore',
    });
    child.once('error', (error) => reject(appError(400, 'launch.failed', { detail: error.message })));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Dependency injection keeps launch tests from opening windows or running installed agents. */
export function createLauncher(dependencies: LauncherDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const locate = dependencies.locate ?? findTrustedExecutable;
  const execute = dependencies.execute ?? executeLaunch;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const systemRoot = environmentValue(env, 'SystemRoot') ?? 'C:\\Windows';

  const resolveTools = async (directory?: string) => {
    const lookup = (names: string[], extraDirectories: string[] = []) => locate(names, {
      platform, env, extraDirectories, excludeDirectory: directory,
    });
    if (platform !== 'win32') {
      const [folder, vscode] = await Promise.all([
        lookup(platform === 'darwin' ? ['open'] : ['xdg-open'], platform === 'darwin' ? ['/usr/bin'] : []),
        lookup(['code']),
      ]);
      // Terminal launch adapters are deliberately Windows-only for this MVP.
      return { folder, vscode, shell: null, claude: null, codex: null };
    }
    const installations = ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'].flatMap((key) => {
      const base = environmentValue(env, key);
      return base ? [paths.join(base, key === 'LOCALAPPDATA' ? 'Programs/Microsoft VS Code' : 'Microsoft VS Code')] : [];
    });
    // Portable VS Code commonly adds only its bin folder (containing code.cmd) to PATH.
    const portableParents = trustedPathDirectories(env, platform)
      .filter((entry) => paths.basename(entry).toLowerCase() === 'bin').map((entry) => paths.dirname(entry));
    const [folder, vscode, shell, claude, codex] = await Promise.all([
      lookup(['explorer.exe'], [systemRoot]),
      lookup(['Code.exe'], [...installations, ...portableParents]),
      lookup(['powershell.exe'], [paths.join(systemRoot, 'System32/WindowsPowerShell/v1.0')]),
      lookup(['claude.exe', 'claude.cmd']),
      lookup(['codex.exe', 'codex.cmd']),
    ]);
    return { folder, vscode, shell, claude, codex };
  };

  const getCapabilities = async (): Promise<Capabilities> => {
    const tools = await resolveTools();
    return { folder: Boolean(tools.folder), vscode: Boolean(tools.vscode), claude: Boolean(tools.shell && tools.claude), codex: Boolean(tools.shell && tools.codex) };
  };

  const planLaunch = async (input: string, action: LaunchAction): Promise<LaunchPlan> => {
    if (!ACTIONS.has(action)) throw appError(400, 'launch.unsupported');
    const directory = await canonicalDirectory(input);
    const tools = await resolveTools(directory);
    const executable = tools[action];
    if (!executable || ((action === 'claude' || action === 'codex') && !tools.shell)) {
      throw appError(400, action === 'claude' || action === 'codex' ? 'launch.agentUnavailable' : 'launch.unavailable', { app: LABELS[action] });
    }
    const launchEnv: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (!/^(PATH|AI_PROJECT_HUB_COMMAND|ELECTRON_RUN_AS_NODE|NoDefaultCurrentDirectoryInExePath|COMSPEC)$/i.test(key)) launchEnv[key] = value;
    }
    launchEnv.PATH = trustedPathDirectories(env, platform).filter((entry) => !isWithinDirectory(entry, directory, platform)).join(paths.delimiter);
    if (platform === 'win32') {
      launchEnv.NoDefaultCurrentDirectoryInExePath = '1';
      launchEnv.COMSPEC = paths.join(systemRoot, 'System32/cmd.exe');
    }
    if (action === 'claude' || action === 'codex') {
      launchEnv.AI_PROJECT_HUB_COMMAND = executable;
      return {
        executable: tools.shell!, args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', AGENT_POWERSHELL_COMMAND],
        cwd: directory, env: launchEnv,
      };
    }
    const args = action === 'vscode' ? ['--new-window', '--', directory]
      : platform === 'darwin' ? ['--', directory] : [directory];
    return { executable, args, cwd: directory, env: launchEnv };
  };

  const openProject = async (input: string, action: LaunchAction): Promise<void> => {
    await execute(await planLaunch(input, action));
  };
  return { getCapabilities, planLaunch, openProject };
}

const launcher = createLauncher();
export const getCapabilities = launcher.getCapabilities;
export const openProject = launcher.openProject;
