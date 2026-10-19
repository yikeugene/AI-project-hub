import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type { DesktopApp } from '../shared/types.js';
import { findTrustedExecutable, runCommand } from '../server/commands.js';
import { type LaunchPlan } from '../server/launcher.js';
import { createDesktopApps, DESKTOP_DISCOVERY_CACHE_MS, START_APPS_COMMAND, type DesktopAppDependencies } from '../server/desktop-apps.js';

// No test, including default process adapters, may query/open actual installed applications.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

const ROOT = 'C:\\Windows';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const EXPLORER = 'C:\\Windows\\explorer.exe';
const REGISTRATIONS = [
  { Name: 'Claude', AppID: 'Fixture.Claude_example123!Chat' },
  { Name: 'ChatGPT', AppID: 'Fixture.Chat_example456!Desktop' },
];
const TOOLS: Record<string, string> = { 'powershell.exe': POWERSHELL, 'explorer.exe': EXPLORER };
function fixture(output: unknown = REGISTRATIONS, overrides: DesktopAppDependencies = {}) {
  const locate = vi.fn<typeof findTrustedExecutable>(async (names) => TOOLS[names[0]] ?? null);
  const run = vi.fn<typeof runCommand>(async () => ({ code: 0, stdout: JSON.stringify(output), stderr: '' }));
  const execute = vi.fn<(plan: LaunchPlan) => Promise<void>>(async () => undefined);
  const apps = createDesktopApps({ platform: 'win32', env: {
    SystemRoot: ROOT, Path: '.;relative;C:\\UntrustedTools', PSModulePath: 'C:\\UntrustedModules',
    ELECTRON_RUN_AS_NODE: '1', AI_PROJECT_HUB_COMMAND: 'arbitrary command',
  }, locate, run, execute, ...overrides });
  return { ...apps, locate, run, execute };
}

describe('Windows desktop chat app discovery', () => {
  it('uses only exact registered display names and discovers IDs instead of assuming CLI names', async () => {
    const apps = fixture();
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: true, chatgpt: true });
    expect(apps.run).toHaveBeenCalledExactlyOnceWith(POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', START_APPS_COMMAND],
      expect.objectContaining({ cwd: ROOT, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }));
    expect(START_APPS_COMMAND).toContain("$_.Name -ceq 'Claude'");
    expect(START_APPS_COMMAND).toContain("$_.Name -ceq 'ChatGPT'");
    expect(START_APPS_COMMAND).toContain('UTF8Encoding');
    expect(START_APPS_COMMAND).toContain("Join-Path $PSHOME 'Modules\\StartLayout\\StartLayout.psd1'");
    expect(START_APPS_COMMAND).not.toContain(REGISTRATIONS[0].AppID);
    expect(START_APPS_COMMAND).not.toContain(REGISTRATIONS[1].AppID);
    expect(apps.locate.mock.calls.map(([names]) => names)).toEqual([['powershell.exe'], ['explorer.exe']]);
    expect(apps.execute).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });
  it('locates only native system binaries, never PATH shims or project binaries', async () => {
    const apps = fixture();
    await apps.getDesktopCapabilities();
    expect(apps.locate.mock.calls).toEqual([
      [['powershell.exe'], { platform: 'win32', env: { PATH: '' }, extraDirectories: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0'] }],
      [['explorer.exe'], { platform: 'win32', env: { PATH: '' }, extraDirectories: [ROOT] }],
    ]);
    const options = apps.run.mock.calls[0][2];
    expect(options.env).toMatchObject({
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      NoDefaultCurrentDirectoryInExePath: '1', COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(options.env?.Path).toBeUndefined();
    expect(options.env?.AI_PROJECT_HUB_COMMAND).toBeUndefined();
    expect(options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
  it.each(['powershell.exe', 'explorer.exe'])('requires %s from its expected native location', async (missing) => {
    for (const value of [null, 'C:\\UntrustedTools\\' + missing, '.\\' + missing, '\\\\server\\share\\' + missing]) {
      const apps = fixture(REGISTRATIONS, { locate: async (names) => names[0] === missing ? value : TOOLS[names[0]] });
      expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
      await expect(apps.openDesktopApp('claude')).rejects.toThrow(/unavailable/);
      expect(apps.run).not.toHaveBeenCalled(); expect(apps.execute).not.toHaveBeenCalled();
    }
  });
  it.each(['.', 'relative', '\\\\server\\Windows', '\\\\?\\C:\\Windows', 'C:\\Windows\0bad'])('rejects untrusted system roots (%s)', async (root) => {
    const apps = fixture(REGISTRATIONS, { env: { SystemRoot: root } });
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
    await expect(apps.openDesktopApp('chatgpt')).rejects.toThrow(/unavailable/);
    expect(apps.locate).not.toHaveBeenCalled(); expect(apps.run).not.toHaveBeenCalled();
  });
  it('does not match CLI, beta, case-folded or partial display names', async () => {
    const apps = fixture(['claude', 'Chatgpt', 'Claude Code', 'ChatGPT Beta', 'Codex', 'Other Claude'].map(Name => ({ Name, AppID: 'Fixture.App!Main' })));
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
    await expect(apps.openDesktopApp('claude')).rejects.toThrow(/no unique, valid Windows Start app registration/);
    expect(apps.execute).not.toHaveBeenCalled();
  });
  it.each([true, false])('rejects ambiguous exact matches even when IDs are identical (%s)', async (identical) => {
    const apps = fixture([...REGISTRATIONS, { ...REGISTRATIONS[0], AppID: identical ? REGISTRATIONS[0].AppID : 'Other.Claude_fixture!App' }]);
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: true });
    await expect(apps.openDesktopApp('claude')).rejects.toThrow(/unavailable/);
    expect(apps.execute).not.toHaveBeenCalled();
  });
  it.each([
    '', ' App!Main', 'App!Main ', 'App!A B', 'App!Main\n', 'App!Main\0', 'App!"Main',
    'App!Main;calc.exe', 'App!Main&calc.exe', 'App!$(calc)', 'App!Main/other', 'App!Main\\other',
    'shell:AppsFolder\\Other', 'C:\\Windows\\calc.exe', '..', '-flag', 'App!!Main', '中.App!Main', 'x'.repeat(129), null, 123,
  ])('rejects invalid OS-returned AppIDs (%s)', async (AppID) => {
    const apps = fixture([{ Name: 'Claude', AppID }, REGISTRATIONS[1]]);
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: true });
    await expect(apps.openDesktopApp('claude')).rejects.toThrow(/unavailable/);
    expect(apps.execute).not.toHaveBeenCalled();
  });
  it('supports a safe registered desktop AppUserModel ID without a package suffix', async () => {
    const apps = fixture([{ Name: 'Claude', AppID: 'Fixture.Desktop.Claude' }]);
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: true, chatgpt: false });
    await apps.openDesktopApp('claude');
    expect(apps.execute).toHaveBeenCalledWith(expect.objectContaining({ args: ['shell:AppsFolder\\Fixture.Desktop.Claude'] }));
  });
  it.each(['linux', 'darwin'] as const)('returns unavailable and does not launch processes on %s', async (platform) => {
    const apps = fixture(REGISTRATIONS, { platform });
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
    await expect(apps.openDesktopApp('chatgpt')).rejects.toThrow(/only on native Windows/);
    expect(apps.locate).not.toHaveBeenCalled(); expect(apps.run).not.toHaveBeenCalled(); expect(apps.execute).not.toHaveBeenCalled();
  });
  it.each(['', 'not JSON', '{}', 'null', '"App!Main"', '[{}]', 'x'.repeat(64 * 1024 + 1)])('fails closed for malformed or oversized discovery output', async (stdout) => {
    const apps = fixture(REGISTRATIONS, { run: async () => ({ stdout, stderr: '', code: 0 }) });
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
    await expect(apps.openDesktopApp('chatgpt')).rejects.toThrow(/unavailable/);
    expect(apps.execute).not.toHaveBeenCalled();
  });
  it('handles a UTF-8 BOM in bounded PowerShell output', async () => {
    const apps = fixture(REGISTRATIONS, { run: async () => ({ stdout: '\uFEFF' + JSON.stringify(REGISTRATIONS), stderr: '', code: 0 }) });
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: true, chatgpt: true });
  });
  it('caches concurrent lookups and refreshes after the short TTL', async () => {
    let clock = 1_000;
    const apps = fixture(REGISTRATIONS, { now: () => clock });
    expect(await Promise.all([apps.getDesktopCapabilities(), apps.getDesktopCapabilities()])).toEqual([
      { claude: true, chatgpt: true }, { claude: true, chatgpt: true },
    ]);
    await apps.openDesktopApp('claude');
    expect(apps.run).toHaveBeenCalledTimes(1);
    clock += DESKTOP_DISCOVERY_CACHE_MS - 1;
    await apps.getDesktopCapabilities();
    expect(apps.run).toHaveBeenCalledTimes(1);
    clock++;
    apps.run.mockResolvedValueOnce({ code: 0, stdout: '[]', stderr: '' });
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
    expect(apps.run).toHaveBeenCalledTimes(2);
  });
  it('also caches failed/absent discovery and recovers after expiry', async () => {
    let clock = 0;
    const apps = fixture(REGISTRATIONS, { now: () => clock });
    apps.run.mockRejectedValueOnce(new Error('timed out'));
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
    await expect(apps.openDesktopApp('claude')).rejects.toThrow(/unavailable/);
    expect(apps.run).toHaveBeenCalledTimes(1);
    clock = DESKTOP_DISCOVERY_CACHE_MS;
    apps.run.mockResolvedValueOnce({ code: 1, stdout: JSON.stringify(REGISTRATIONS), stderr: 'query failed' });
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: false, chatgpt: false });
    clock += DESKTOP_DISCOVERY_CACHE_MS;
    expect(await apps.getDesktopCapabilities()).toEqual({ claude: true, chatgpt: true });
    expect(apps.run).toHaveBeenCalledTimes(3);
  });
});

describe('desktop launch request (no context transfer)', () => {
  it.each(['claude', 'chatgpt'] as const)('opens %s via native Explorer with one discovered literal argument', async (app) => {
    const apps = fixture();
    await apps.openDesktopApp(app);
    const id = REGISTRATIONS[app === 'claude' ? 0 : 1].AppID;
    expect(apps.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      executable: EXPLORER, args: [`shell:AppsFolder\\${id}`], cwd: ROOT,
    }));
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects arbitrary actions before discovery or launch', async () => {
    const apps = fixture();
    await expect(apps.openDesktopApp('powershell -Command anything' as DesktopApp)).rejects.toThrow(/Unsupported desktop application/);
    expect(apps.locate).not.toHaveBeenCalled(); expect(apps.run).not.toHaveBeenCalled(); expect(apps.execute).not.toHaveBeenCalled();
  });
  it('surfaces launch errors rather than claiming that a chat window opened', async () => {
    const apps = fixture();
    apps.execute.mockRejectedValueOnce(new Error('Cannot launch application: EACCES'));
    await expect(apps.openDesktopApp('claude')).rejects.toThrow(/EACCES/);
  });
  it('uses the real bounded shell:false discovery adapter with a mocked subprocess', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const apps = fixture(REGISTRATIONS, { run: runCommand });
    const promise = apps.getDesktopCapabilities();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledWith(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', START_APPS_COMMAND], expect.objectContaining({
      shell: false, windowsHide: true, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    child.stdout.write(JSON.stringify(REGISTRATIONS)); child.emit('close', 0, null);
    expect(await promise).toEqual({ claude: true, chatgpt: true });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('uses the native shell:false Explorer spawn adapter, with no actual application opening', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const apps = fixture(REGISTRATIONS, { execute: undefined });
    const promise = apps.openDesktopApp('chatgpt');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledWith(EXPLORER, [`shell:AppsFolder\\${REGISTRATIONS[1].AppID}`], expect.objectContaining({
      shell: false, cwd: ROOT, detached: true, stdio: 'ignore',
    }));
    child.emit('spawn'); await promise;
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
