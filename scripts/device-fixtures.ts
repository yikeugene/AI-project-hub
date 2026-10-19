import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { DeviceStore, payloadHash } from '../server/device-store.js';
import type { MessagePayload } from '../shared/devices.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDeviceIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const contained = (parent: string, child: string) => { const path = relative(parent, child); return !!path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };

/** Test-only, explicit existing .local database. No default data path and no usable cloud credential. */
export function seedDeviceFixtures(dataDir: string, appClosed: boolean) {
  if (!appClosed) throw new Error('Close the app first, then pass --app-closed explicitly.');
  const localRoot = join(root, '.local');
  const requested = resolve(dataDir);
  if (!contained(localRoot, requested)) throw new Error('Device fixtures only accept an explicit database directory strictly inside this project’s .local folder.');
  if (!existsSync(localRoot) || lstatSync(localRoot).isSymbolicLink() || !contained(realpathSync(root), realpathSync(localRoot)) || !existsSync(requested) || !contained(realpathSync(localRoot), realpathSync(requested))) throw new Error('The isolated .local directory must already exist and cannot resolve outside the project’s real .local folder.');
  const filename = join(requested, 'hub.sqlite');
  if (!existsSync(filename) || !lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink() || !contained(realpathSync(requested), realpathSync(filename))) throw new Error('An existing non-symlink isolated hub.sqlite is required.');
  const store = new Store(filename);
  let repository: DeviceStore | undefined;
  let profileId: string | undefined;
  try {
    if (Number((store.db.prepare('SELECT COUNT(*) AS count FROM relay_profiles').get() as { count: number }).count) !== 0) throw new Error('Refusing to overwrite any existing device pairing profile, including a detached one.');
    const project = store.listProjects()[0];
    if (!project) throw new Error('Create at least one local project through the real app before seeding the device fixture.');
    repository = new DeviceStore(store);
    const installation = repository.installation();
    const unusableCiphertext = Buffer.from('unusable-test-ciphertext');
    const profile = repository.addProfile({ url: 'https://local-relay-test.supabase.co', publishableKey: 'sb_publishable_isolated_fixture_not_a_real_key' }, installation.id, unusableCiphertext);
    profileId = profile.id;
    const now = Date.now();
    const at = new Date(now).toISOString();
    repository.finishPairing(profile.id, randomUUID(), unusableCiphertext, { id: installation.id, name: installation.name, lastSeenAt: at, revokedAt: null });
    repository.setEnabled(profile.id, false);
    repository.cacheDevices(profile.id, fixtureDeviceIds.map(id => ({ id, name: '測試設備（同名）', lastSeenAt: new Date(now - 3_600_000).toISOString(), revokedAt: null })));
    fixtureDeviceIds.forEach((id, index) => repository!.cacheSnapshot(profile.id, {
      ownerDeviceId: id, projectId: project.id, version: index + 4, publishedAt: new Date(now - (index + 1) * 120_000).toISOString(),
      project: { name: index === 0 ? '遠端唯讀驗證專案' : '另一台設備的同 ID 專案', status: 'active', priority: 'normal', stage: '隔離驗證', nextAction: '只能在資料所屬電腦修改。', revision: 27 + index, memory: { status: '這是隔離測試快取，不是本機專案。' } },
    }));
    repository.setPolicy(profile.id, { projectId: project.id, enabled: true, memoryFields: ['status'] });
    const paired = repository.profile(profile.id)!;
    const addMessage = (id: string, payload: MessagePayload, offset: number) => {
      const text = JSON.stringify(payload);
      repository!.ingest(paired, { id, fromDeviceId: fixtureDeviceIds[0], toDeviceId: installation.id, payload: text, hash: payloadHash(text), createdAt: new Date(now + offset).toISOString(), expiresAt: new Date(now + 7 * 86_400_000).toISOString(), receivedAt: null, result: null });
    };
    const textMessageId = '55555555-5555-4555-8555-555555555555';
    const proposalId = '66666666-6666-4666-8666-666666666666';
    addMessage(textMessageId, { schemaVersion: 1, kind: 'message', text: '這是一則可離線標記已讀的隔離測試訊息。' }, -2000);
    addMessage(proposalId, { schemaVersion: 1, kind: 'proposal', text: '請在本機檢查這份隔離變更請求。', projectId: project.id, baseRevision: project.revision, changes: { nextAction: '隔離遠端請求，尚未套用。', memory: { status: '隔離的建議狀態，必須本機確認。' } } }, -1000);
    return { dataDir: requested, projectId: project.id, deviceIds: fixtureDeviceIds, textMessageId, proposalId, enabled: false, usableCredentials: false };
  } finally {
    if (repository && profileId) repository.setEnabled(profileId, false);
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== '--data-dir' || args[2] !== '--app-closed') throw new Error('Usage: tsx scripts/device-fixtures.ts --data-dir <existing project/.local/isolated-directory> --app-closed');
    console.log(JSON.stringify(seedDeviceFixtures(args[1], true), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
