import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdateController } from '../desktop/updater';
import { isNewerStable, releaseUrl, type UpdateState, type UpdateUnavailableReason } from '../shared/updates';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowDowngrade = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => {});
  downloadUpdate = vi.fn(async () => {});
  quitAndInstall = vi.fn();
}
function setup(unavailable?: UpdateUnavailableReason, configured = true) {
  const adapter = new FakeUpdater();
  const changed = vi.fn<(state: UpdateState) => void>();
  const requestClose = vi.fn();
  const controller = new UpdateController({ currentVersion: '0.3.0', source: configured ? { owner: 'example', repo: 'hub' } : null, unavailable, adapter, changed, requestClose });
  return { adapter, controller, changed, requestClose };
}
async function downloaded() {
  const context = setup();
  context.adapter.checkForUpdates.mockImplementation(async () => { context.adapter.emit('update-available', { version: '0.4.0' }); });
  context.adapter.downloadUpdate.mockImplementation(async () => { context.adapter.emit('update-downloaded', { version: '0.4.0' }); });
  await context.controller.check();
  await context.controller.download();
  return context;
}

describe('release boundaries', () => {
  it('builds only fixed HTTPS GitHub release URLs', () => {
    expect(releaseUrl({ owner: 'example-user', repo: 'AI.Project-Hub' })).toBe('https://github.com/example-user/AI.Project-Hub/releases/latest');
    for (const source of [null, { owner: '', repo: 'hub' }, { owner: 'evil/x', repo: 'hub' }, { owner: 'user', repo: '..' }, { owner: 'user', repo: 'hub?redirect=x' }]) expect(releaseUrl(source)).toBeNull();
  });
  it('accepts only newer stable semantic versions', () => {
    expect(isNewerStable('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerStable('1.0.0+build.1', '0.9.9')).toBe(true);
    for (const version of ['0.3.0', '0.2.9', '0.4.0-beta.1', 'v0.4.0', '04.0.0', 'bad', '999999999999999999.0.0']) expect(isNewerStable(version, '0.3.0')).toBe(false);
  });
});

describe('manual desktop updates', () => {
  it('never contacts a provider or installs without configuration', async () => {
    const { controller, adapter, requestClose } = setup(undefined, false);
    expect(controller.snapshot()).toMatchObject({ status: 'unavailable', reason: 'unconfigured', releaseUrl: null });
    await controller.check(); await controller.download(); controller.requestInstall();
    expect(controller.installAfterShutdown()).toBe(false);
    expect(adapter.checkForUpdates).not.toHaveBeenCalled(); expect(adapter.downloadUpdate).not.toHaveBeenCalled(); expect(requestClose).not.toHaveBeenCalled();
  });
  it.each(['portable', 'unpacked', 'custom-data-dir', 'development', 'unsupported-platform'] as const)('does not install in %s mode', async reason => {
    const { controller, adapter } = setup(reason);
    await controller.check(); await controller.download(); controller.requestInstall();
    expect(controller.snapshot()).toMatchObject({ status: 'unavailable', reason });
    expect(adapter.checkForUpdates).not.toHaveBeenCalled(); expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });
  it('disables automatic download and quit installation immediately', () => {
    const { adapter } = setup();
    expect(adapter.autoDownload).toBe(false); expect(adapter.autoInstallOnAppQuit).toBe(false);
    expect(adapter.allowDowngrade).toBe(false); expect(adapter.allowPrerelease).toBe(false);
  });
  it('reports current and rejects non-newer provider versions', async () => {
    for (const version of ['0.3.0', '0.2.0', '0.4.0-beta.1']) {
      const { controller, adapter } = setup();
      adapter.checkForUpdates.mockImplementation(async () => { adapter.emit('update-available', { version }); });
      await controller.check();
      expect(controller.snapshot().status).toBe('current');
      await controller.download(); expect(adapter.downloadUpdate).not.toHaveBeenCalled();
    }
  });
  it('requires separate user actions, clamps progress and rejects a mismatched download', async () => {
    const { controller, adapter } = setup();
    adapter.checkForUpdates.mockImplementation(async () => { adapter.emit('update-available', { version: '0.4.0' }); });
    await controller.check(); expect(controller.snapshot().status).toBe('available');
    expect(adapter.downloadUpdate).not.toHaveBeenCalled();
    await controller.download();
    adapter.emit('download-progress', { percent: 120 }); expect(controller.snapshot().progress).toBe(100);
    adapter.emit('update-downloaded', { version: '0.2.0' }); expect(controller.snapshot().status).toBe('downloading');
    adapter.emit('update-downloaded', { version: '0.4.0' }); expect(controller.snapshot().status).toBe('downloaded');
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });
  it('ignores concurrent checks and downloads', async () => {
    const { controller, adapter } = setup();
    let release!: () => void;
    adapter.checkForUpdates.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const checking = controller.check();
    await controller.check(); expect(adapter.checkForUpdates).toHaveBeenCalledTimes(1);
    adapter.emit('update-available', { version: '0.4.0' }); release(); await checking;
    adapter.downloadUpdate.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const downloading = controller.download();
    await controller.download(); expect(adapter.downloadUpdate).toHaveBeenCalledTimes(1);
    release(); await downloading;
  });
  it('clears install intent on canceled close; ordinary shutdown does not install', async () => {
    const { controller, adapter, requestClose } = await downloaded();
    controller.requestInstall(); controller.requestInstall();
    expect(requestClose).toHaveBeenCalledTimes(1); expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    controller.cancelInstall();
    expect(controller.installAfterShutdown()).toBe(false); expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    expect(controller.snapshot().status).toBe('downloaded');
  });
  it('installs only once after explicit confirmation and the shutdown step', async () => {
    const { controller, adapter } = await downloaded();
    expect(controller.installAfterShutdown()).toBe(false);
    controller.requestInstall();
    expect(controller.installAfterShutdown()).toBe(true);
    expect(controller.installAfterShutdown()).toBe(false);
    expect(adapter.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });
  it('handles offline/checksum failures without allowing installation and can retry', async () => {
    const { controller, adapter } = setup();
    adapter.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await controller.check(); expect(controller.snapshot()).toMatchObject({ status: 'error', error: 'offline' });
    adapter.checkForUpdates.mockImplementation(async () => { adapter.emit('update-available', { version: '0.4.0' }); });
    await controller.check();
    adapter.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'));
    await controller.download(); controller.requestInstall();
    expect(controller.snapshot().status).toBe('error'); expect(controller.installAfterShutdown()).toBe(false);
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });
  it('reports installation exceptions and uses increasing state revisions', async () => {
    const { controller, adapter, changed } = await downloaded();
    adapter.quitAndInstall.mockImplementation(() => { throw new Error('installer unavailable'); });
    controller.requestInstall(); expect(controller.installAfterShutdown()).toBe(false);
    expect(controller.snapshot()).toMatchObject({ status: 'error', error: 'installer unavailable' });
    const revisions = changed.mock.calls.map(([state]) => state.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  });
});
