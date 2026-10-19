import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LaunchAction } from '../shared/types.ts';
import { findTrustedExecutable, trustedPathDirectories } from '../server/commands.ts';
import { AGENT_POWERSHELL_COMMAND, createLauncher, executeLaunch, type LaunchPlan } from '../server/launcher.ts';

// Even accidental use of the default executor cannot open an application in this test file.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

let temporary: string;
let project: string;
beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'ai-project-hub-launcher-'));
  project = path.join(temporary, "project & 'quotes' $(noop) 專案");
  await mkdir(project);
});
afterEach(async () => {
  vi.clearAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
const WINDOWS_TOOLS: Record<string, string> = {
  'explorer.exe': 'C:\\Windows\\explorer.exe',
  'Code.exe': 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'claude.exe': 'C:\\Tools\\claude.exe',
  'codex.cmd': 'C:\\Trusted Tools\\codex.cmd',
};
function mockLauncher(tools = WINDOWS_TOOLS) {
  const locate = vi.fn<typeof findTrustedExecutable>(async (names) => names.map((name) => tools[name]).find(Boolean) ?? null);
  const execute = vi.fn<(plan: LaunchPlan) => Promise<void>>(async () => undefined);
  const launcher = createLauncher({ platform: 'win32', locate, execute, env: {
    SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files', PATH: '.;relative;C:\\Trusted Tools', ELECTRON_RUN_AS_NODE: '1',
  } });
  return { ...launcher, locate, execute };
}

describe('whitelisted launch plans', () => {
  it('opens folders using native Explorer and a single literal path argument', async () => {
    const launcher = mockLauncher();
    await launcher.openProject(project, 'folder');
    expect(launcher.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      executable: WINDOWS_TOOLS['explorer.exe'], args: [await realpath(project)], cwd: await realpath(project),
    }));
    expect(spawn).not.toHaveBeenCalled();
  });
  it('uses native Code.exe rather than shelling through code.cmd', async () => {
    const launcher = mockLauncher();
    const plan = await launcher.planLaunch(project, 'vscode');
    expect(plan).toMatchObject({ executable: WINDOWS_TOOLS['Code.exe'], args: ['--new-window', '--', await realpath(project)] });
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(launcher.locate.mock.calls.flatMap(([names]) => names)).not.toContain('code.cmd');
    expect(launcher.locate.mock.calls.find(([names]) => names.includes('Code.exe'))?.[1]?.extraDirectories)
      .toContain('C:\\Users\\test\\AppData\\Local\\Programs\\Microsoft VS Code');
  });
  it.each(['claude', 'codex'] as const)('uses a fixed PowerShell command and cwd for %s, never interpolating the project path', async (action) => {
    const launcher = mockLauncher();
    const plan = await launcher.planLaunch(project, action);
    expect(plan.executable).toBe(WINDOWS_TOOLS['powershell.exe']);
    expect(plan.args).toEqual(['-NoLogo', '-NoProfile', '-NoExit', '-Command', AGENT_POWERSHELL_COMMAND]);
    expect(plan.args.join(' ')).not.toContain(project);
    expect(plan.cwd).toBe(await realpath(project));
    expect(plan.env.AI_PROJECT_HUB_COMMAND).toBe(action === 'claude' ? WINDOWS_TOOLS['claude.exe'] : WINDOWS_TOOLS['codex.cmd']);
    expect(plan.env.PATH).toBe('C:\\Trusted Tools');
    expect(plan.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(plan.env.COMSPEC).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launcher.execute).not.toHaveBeenCalled();
  });
  it('reports unavailable capabilities and refuses to launch an absent application', async () => {
    const launcher = mockLauncher({ 'explorer.exe': WINDOWS_TOOLS['explorer.exe'] });
    expect(await launcher.getCapabilities()).toEqual({ folder: true, vscode: false, claude: false, codex: false });
    await expect(launcher.openProject(project, 'claude')).rejects.toThrow(/Claude Code is not available/);
    await expect(launcher.openProject(project, 'vscode')).rejects.toThrow(/Visual Studio Code is not available/);
    expect(launcher.execute).not.toHaveBeenCalled();
  });
  it('requires PowerShell as well as the agent executable', async () => {
    const launcher = mockLauncher({ 'claude.exe': WINDOWS_TOOLS['claude.exe'], 'codex.cmd': WINDOWS_TOOLS['codex.cmd'] });
    expect(await launcher.getCapabilities()).toEqual({ folder: false, vscode: false, claude: false, codex: false });
    await expect(launcher.openProject(project, 'codex')).rejects.toThrow(/PowerShell/);
  });
  it('rejects unknown actions and invalid directories before execution', async () => {
    const launcher = mockLauncher();
    await expect(launcher.openProject(project, 'powershell -Command bad' as LaunchAction)).rejects.toThrow(/Unsupported launch action/);
    await expect(launcher.openProject('relative', 'folder')).rejects.toThrow(/absolute local directory/);
    await expect(launcher.openProject(path.join(temporary, 'missing'), 'folder')).rejects.toThrow(/does not exist/);
    expect(launcher.execute).not.toHaveBeenCalled();
    expect(launcher.locate).not.toHaveBeenCalled();
  });
  it('excludes the canonical project directory during command discovery and surfaces execution failures', async () => {
    const launcher = mockLauncher();
    launcher.execute.mockRejectedValueOnce(new Error('cannot spawn'));
    await expect(launcher.openProject(project, 'folder')).rejects.toThrow(/cannot spawn/);
    expect(launcher.locate.mock.calls.every(([, options]) => options?.excludeDirectory === project)).toBe(true);
  });
  it('supports a native Linux folder opener but does not advertise unimplemented agent terminals', async () => {
    const execute = vi.fn(async () => undefined);
    const launcher = createLauncher({ platform: 'linux', env: { PATH: '/usr/bin' }, execute,
      locate: async (names) => names[0] === 'xdg-open' ? '/usr/bin/xdg-open' : null,
    });
    expect(await launcher.getCapabilities()).toEqual({ folder: true, vscode: false, claude: false, codex: false });
    await launcher.openProject(project, 'folder');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ executable: '/usr/bin/xdg-open', args: [await realpath(project)] }));
  });
});

describe('trusted executable discovery', () => {
  it('ignores empty and relative PATH entries and never accepts project-local executables', async () => {
    const trusted = path.join(temporary, 'trusted');
    await mkdir(trusted);
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    await writeFile(path.join(project, name), 'not executable code');
    const target = path.join(trusted, name);
    await writeFile(target, 'not executable code');
    await chmod(target, 0o755);
    const env = { Path: ['', '.', 'relative', project, trusted].join(path.delimiter) };
    expect(await findTrustedExecutable([name], { env, excludeDirectory: project })).toBe(await realpath(target));
    expect(await findTrustedExecutable([name], { env: { PATH: ['', '.', project].join(path.delimiter) }, excludeDirectory: project })).toBeNull();
  });
  it('accepts quoted absolute Windows PATH entries, not UNC/device or relative search roots', () => {
    expect(trustedPathDirectories({ Path: ';.;relative;"C:\\Program Files\\Tool";\\\\server\\share;\\\\?\\C:\\bad' }, 'win32'))
      .toEqual(['C:\\Program Files\\Tool']);
  });
  it.runIf(process.platform === 'win32')('discovers the native VS Code install and does not treat a lone code.cmd shim as available', async () => {
    const local = path.join(temporary, 'local');
    const install = path.join(local, 'Programs', 'Microsoft VS Code');
    await mkdir(path.join(install, 'bin'), { recursive: true });
    const native = path.join(install, 'Code.exe');
    await writeFile(native, 'test fixture: never executed');
    await writeFile(path.join(install, 'bin', 'code.cmd'), 'test fixture: never executed');
    const execute = vi.fn(async () => undefined);
    const launcher = createLauncher({ env: { LOCALAPPDATA: local, PATH: path.join(install, 'bin') }, execute });
    expect((await launcher.getCapabilities()).vscode).toBe(true);
    await launcher.openProject(project, 'vscode');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ executable: await realpath(native) }));
    await rm(native);
    expect((await launcher.getCapabilities()).vscode).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('native spawn adapter (mocked; no applications open)', () => {
  it('uses shell:false, detached execution, explicit cwd, and only resolves after spawn', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const plan: LaunchPlan = { executable: WINDOWS_TOOLS['explorer.exe'], args: [project], cwd: project, env: {} };
    const launched = executeLaunch(plan);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(plan.executable, plan.args, {
      cwd: project, env: {}, shell: false, windowsHide: false, detached: true, stdio: 'ignore',
    });
    child.emit('spawn');
    await launched;
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it('rejects native spawn errors without claiming a successful launch', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const launched = executeLaunch({ executable: 'missing', args: [], cwd: project, env: {} });
    child.emit('error', new Error('ENOENT'));
    await expect(launched).rejects.toThrow(/Cannot launch application: ENOENT/);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
