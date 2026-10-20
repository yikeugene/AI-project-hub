import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.js';
import { createCredentialCodec } from '../desktop/credentials.js';
import { randomUUID } from 'node:crypto';
import { DeviceStore } from '../server/device-store.js';

const directories: string[] = [];
const filename = () => { const dir = mkdtempSync(join(tmpdir(), 'hub-device-migration-')); directories.push(dir); return join(dir, 'hub.sqlite'); };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const governanceTables = ['git_audit', 'git_operations', 'git_approval_inbox', 'governance_profiles'];
const deviceTables = ['device_outbox', 'device_messages', 'remote_snapshots', 'project_publications', 'project_shares', 'paired_devices', 'relay_profiles', 'device_installation'];
function legacyVersion(file: string, version: 1 | 2 | 3) {
  const db = new DatabaseSync(file);
  const tables = version === 1 ? [...governanceTables, ...deviceTables] : version === 2 ? governanceTables : [];
  if (version > 1) db.exec('ALTER TABLE relay_profiles DROP COLUMN attached; ALTER TABLE relay_profiles DROP COLUMN label; ALTER TABLE project_publications DROP COLUMN published_at;');
  db.exec(tables.map(table => `DROP TABLE ${table};`).join('\n') + `\nPRAGMA user_version=${version};`); db.close();
}

describe('additive device storage migration', () => {
  it.each([1, 2, 3] as const)('creates v4 and upgrades v%i without changing local records', version => {
    const file = filename(); let store = new Store(file);
    const project = store.createProject({ path: '/do-not-change', name: 'Keep existing project' });
    const task = store.createTask(project.id, { title: 'Keep existing task' });
    store.updateSettings({ staleDays: 42 });
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(4); store.close();
    legacyVersion(file, version); store = new Store(file);
    try {
      expect(store.getProject(project.id)).toEqual(project); expect(store.getTask(task.id)).toEqual(task);
      expect(store.getSettings().staleDays).toBe(42); expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM relay_profiles').get()!.n).toBe(0);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get()!.n).toBe(0);
    } finally { store.close(); }
  });
  it('rolls back a failed v1 migration and does not leave half-created tables', () => {
    const file = filename(); const initial = new Store(file); initial.close(); legacyVersion(file, 1);
    let db = new DatabaseSync(file); db.exec('CREATE TABLE paired_devices(incompatible TEXT)'); db.close();
    expect(() => new Store(file)).toThrow();
    db = new DatabaseSync(file);
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='relay_profiles'").get()).toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='device_installation'").get()).toBeUndefined();
    } finally { db.close(); }
  });
  it('rolls back a failed v2 governance upgrade without losing existing projects', () => {
    const file = filename(); const initial = new Store(file);
    const project = initial.createProject({ path: '/preserved', name: 'Preserved' }); initial.close(); legacyVersion(file, 2);
    let db = new DatabaseSync(file); db.exec('CREATE TABLE git_operations(incompatible TEXT)'); db.close();
    expect(() => new Store(file)).toThrow(); db = new DatabaseSync(file);
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
      expect(db.prepare('SELECT name FROM projects WHERE id=?').get(project.id)!.name).toBe('Preserved');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='governance_profiles'").get()).toBeUndefined();
    } finally { db.close(); }
  });
  it.each(['idle', 'disabled', 'revoked', 'locked', 'pending'] as const)('retains only the attached v3 %s membership without changing credentials or history', status => {
    const file = filename(); let store = new Store(file); let devices = new DeviceStore(store);
    const configuration = { url: 'https://migration.example.supabase.co', publishableKey: 'publishable-key-for-test' };
    const history = devices.addProfile(configuration, randomUUID(), Buffer.from('historical-secret'));
    devices.detach(history.id);
    const active = devices.addProfile(configuration, randomUUID(), Buffer.from('opaque-credential'));
    const project = store.createProject({ path: '/existing', name: 'Already shared' });
    devices.setPolicy(active.id, { projectId: project.id, enabled: true, memoryFields: ['status'] });
    devices.queue(active.id, 'saved-job', 'rename', { name: 'Original' });
    store.db.prepare('INSERT INTO governance_profiles(profile_id,status_version,status_payload,status_sent_version) VALUES(?,7,?,6)').run(active.id, '{"preserved":true}');
    const operation = randomUUID();
    store.db.prepare(`INSERT INTO git_operations(id,project_id,profile_id,network_id,device_id,repository_key,preview_json,plan_json,state,updated_at)
      VALUES(?,?,?,?,?,?,'{}','{}','unknown',?)`).run(operation, project.id, active.id, randomUUID(), active.deviceId, 'physical-repository-fence', devices.now());
    store.db.prepare("UPDATE relay_profiles SET network_id=?,pairing_pending=?,enabled=?,connection=? WHERE id=?")
      .run(status === 'pending' ? null : randomUUID(), Number(status === 'pending'), Number(status === 'idle' || status === 'locked'), status === 'pending' ? 'error' : status, active.id);
    const before = devices.profile(active.id)!;
    const publications = store.db.prepare('SELECT profile_id,project_id,version,sent_version,payload FROM project_publications').all();
    const jobs = store.db.prepare('SELECT * FROM device_outbox').all(), journal = store.db.prepare('SELECT * FROM git_operations').all();
    store.close(); legacyVersion(file, 3); store = new Store(file); devices = new DeviceStore(store);
    try {
      expect(devices.profiles().map(profile => profile.id)).toEqual([active.id]);
      expect(devices.profile(active.id)).toMatchObject({ ...before, attached: true });
      expect(devices.profile(history.id)).toMatchObject({ attached: false, enabled: false });
      expect(devices.profile(history.id)!.credentials.byteLength).toBe(0);
      expect(devices.installation().activeProfile).toBe(active.id);
      expect(devices.policy(active.id, project.id).memoryFields).toEqual(['status']);
      expect(store.db.prepare('SELECT profile_id,project_id,version,sent_version,payload FROM project_publications').all()).toEqual(publications);
      expect(store.db.prepare('SELECT * FROM device_outbox').all()).toEqual(jobs);
      expect(store.db.prepare('SELECT * FROM git_operations').all()).toEqual(journal);
      expect(store.db.prepare('SELECT status_version FROM governance_profiles WHERE profile_id=?').get(active.id)!.status_version).toBe(7);
    } finally { store.close(); }
  });
  it('does not resurrect historical profiles when v3 has no active profile', () => {
    const file = filename(); let store = new Store(file); const devices = new DeviceStore(store);
    const profile = devices.addProfile({ url: 'https://migration.example', publishableKey: 'key-for-migration-test' }, randomUUID(), Buffer.from('old'));
    devices.detach(profile.id); store.close(); legacyVersion(file, 3); store = new Store(file);
    try { expect(new DeviceStore(store).profiles()).toEqual([]); } finally { store.close(); }
  });
  it('rolls back every additive v4 change when the final schema step fails', () => {
    const file = filename(); const initial = new Store(file); initial.close(); legacyVersion(file, 3);
    let db = new DatabaseSync(file); db.exec('ALTER TABLE project_publications ADD COLUMN published_at TEXT'); db.close();
    expect(() => new Store(file)).toThrow(); db = new DatabaseSync(file);
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
      const columns = db.prepare('PRAGMA table_info(relay_profiles)').all().map(row => row.name);
      expect(columns).not.toContain('attached'); expect(columns).not.toContain('label');
    } finally { db.close(); }
  });
  it('rejects unknown newer versions and releases the connection', () => {
    const file = filename(), db = new DatabaseSync(file); db.exec('PRAGMA user_version=5'); db.close();
    expect(() => new Store(file)).toThrow(/version is newer/);
    const reopened = new DatabaseSync(file); expect(reopened.prepare('PRAGMA user_version').get()!.user_version).toBe(5); reopened.close();
  });
});

describe('OS-backed desktop credential codec', () => {
  it('uses an explicit current locale for its app-owned availability error', () => {
    let locale: 'en' | 'zh-TW' = 'en';
    const storage = { isEncryptionAvailable: () => false, encryptString: vi.fn(() => Buffer.from('unused')), decryptString: vi.fn(() => 'unused') };
    const codec = createCredentialCodec(storage, 'win32', () => locale);
    expect(() => codec.encrypt('token')).toThrow('Secure credential storage is unavailable.');
    locale = 'zh-TW';
    expect(() => codec.encrypt('token')).toThrow(/不可用/); expect(() => codec.decrypt(Buffer.from('opaque'))).toThrow(/不可用/);
    expect(storage.encryptString).not.toHaveBeenCalled(); expect(storage.decryptString).not.toHaveBeenCalled();
  });
  it('uses the injected safeStorage only while secure storage is available', () => {
    let ready = false;
    const storage = { isEncryptionAvailable: () => ready, encryptString: vi.fn((text: string) => Buffer.from(`cipher:${text}`)), decryptString: vi.fn((bytes: Buffer) => bytes.toString().slice(7)) };
    const codec = createCredentialCodec(storage, 'win32');
    expect(codec.available()).toBe(false); expect(() => codec.encrypt('token')).toThrow(/unavailable/); expect(storage.encryptString).not.toHaveBeenCalled();
    ready = true; const encrypted = codec.encrypt('token');
    expect(codec.decrypt(encrypted)).toBe('token'); expect(storage.encryptString).toHaveBeenCalledOnce();
    ready = false; expect(() => codec.decrypt(encrypted)).toThrow(/unavailable/);
  });
  it('refuses Linux basic_text rather than silently storing recoverable credentials', () => {
    const codec = createCredentialCodec({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw new Error('must not run'); }, decryptString: () => '' }, 'linux');
    expect(codec.available()).toBe(false); expect(() => codec.encrypt('secret')).toThrow(/unavailable/);
  });
  it('propagates encryption failures instead of falling back to plaintext', () => {
    const codec = createCredentialCodec({ isEncryptionAvailable: () => true, encryptString: () => { throw new Error('DPAPI unavailable'); }, decryptString: () => { throw new Error('wrong account'); } });
    expect(() => codec.encrypt('token')).toThrow(/DPAPI/); expect(() => codec.decrypt(Buffer.from('opaque'))).toThrow(/account/);
  });
});
