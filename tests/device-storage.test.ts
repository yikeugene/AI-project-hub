import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.js';
import { createCredentialCodec } from '../desktop/credentials.js';

const directories: string[] = [];
const filename = () => { const dir = mkdtempSync(join(tmpdir(), 'hub-device-migration-')); directories.push(dir); return join(dir, 'hub.sqlite'); };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const governanceTables = ['git_audit', 'git_operations', 'git_approval_inbox', 'governance_profiles'];
const deviceTables = ['device_outbox', 'device_messages', 'remote_snapshots', 'project_publications', 'project_shares', 'paired_devices', 'relay_profiles', 'device_installation'];
function legacyVersion(file: string, version: 1 | 2) {
  const db = new DatabaseSync(file);
  const tables = version === 1 ? [...governanceTables, ...deviceTables] : governanceTables;
  db.exec(tables.map(table => `DROP TABLE ${table};`).join('\n') + `\nPRAGMA user_version=${version};`); db.close();
}

describe('additive device storage migration', () => {
  it.each([1, 2] as const)('creates v3 and upgrades v%i without changing local records', version => {
    const file = filename(); let store = new Store(file);
    const project = store.createProject({ path: '/do-not-change', name: 'Keep existing project' });
    const task = store.createTask(project.id, { title: 'Keep existing task' });
    store.updateSettings({ staleDays: 42 });
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(3); store.close();
    legacyVersion(file, version); store = new Store(file);
    try {
      expect(store.getProject(project.id)).toEqual(project); expect(store.getTask(task.id)).toEqual(task);
      expect(store.getSettings().staleDays).toBe(42); expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
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
  it('rejects unknown newer versions and releases the connection', () => {
    const file = filename(), db = new DatabaseSync(file); db.exec('PRAGMA user_version=4'); db.close();
    expect(() => new Store(file)).toThrow(/version is newer/);
    const reopened = new DatabaseSync(file); expect(reopened.prepare('PRAGMA user_version').get()!.user_version).toBe(4); reopened.close();
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
