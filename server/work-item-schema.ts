export const WORK_ITEM_MIGRATION = `
  CREATE TABLE work_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
    phase TEXT NOT NULL CHECK(phase IN ('draft','ready','awaiting_return','review','done')),
    brief_json TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '',
    hold_json TEXT, submission_id TEXT, checks_json TEXT NOT NULL,
    source_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX work_items_project ON work_items(project_id);
  CREATE TABLE work_item_events (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    command_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    type TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL,
    at TEXT NOT NULL, result_revision INTEGER NOT NULL
  );
  CREATE INDEX work_item_events_item ON work_item_events(item_id, result_revision);
  PRAGMA user_version = 7;
`;
