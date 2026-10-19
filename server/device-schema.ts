export const DEVICE_MIGRATION = `
CREATE TABLE device_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, name TEXT NOT NULL,
  active_profile TEXT
);
CREATE TABLE relay_profiles (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, publishable_key TEXT NOT NULL, device_id TEXT NOT NULL,
  network_id TEXT, credentials BLOB NOT NULL, pairing_pending INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0, connection TEXT NOT NULL DEFAULT 'disabled',
  last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE paired_devices (
  profile_id TEXT NOT NULL REFERENCES relay_profiles(id), id TEXT NOT NULL, name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY(profile_id,id)
);
CREATE TABLE project_shares (
  profile_id TEXT NOT NULL REFERENCES relay_profiles(id), project_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, memory_fields TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(profile_id,project_id)
);
CREATE TABLE project_publications (
  profile_id TEXT NOT NULL REFERENCES relay_profiles(id), project_id TEXT NOT NULL,
  version INTEGER NOT NULL, sent_version INTEGER NOT NULL DEFAULT 0, payload TEXT,
  PRIMARY KEY(profile_id,project_id)
);
CREATE TABLE remote_snapshots (
  profile_id TEXT NOT NULL REFERENCES relay_profiles(id), owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
  version INTEGER NOT NULL, payload TEXT, published_at TEXT NOT NULL, received_at TEXT NOT NULL,
  PRIMARY KEY(profile_id,owner_id,project_id)
);
CREATE TABLE device_messages (
  profile_id TEXT NOT NULL REFERENCES relay_profiles(id), id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbox','sent')), from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  payload TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  received_at TEXT, result TEXT, delivery TEXT NOT NULL, error TEXT, status_checked_at TEXT,
  PRIMARY KEY(profile_id,id)
);
CREATE INDEX device_messages_box ON device_messages(profile_id,direction,created_at);
CREATE TABLE device_outbox (
  profile_id TEXT NOT NULL REFERENCES relay_profiles(id), id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('send','ack','decision','rename')), payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT,
  PRIMARY KEY(profile_id,id)
);
PRAGMA user_version = 2;
`;
