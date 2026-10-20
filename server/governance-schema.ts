export const GOVERNANCE_MIGRATION = `
  CREATE TABLE governance_profiles (
    profile_id TEXT PRIMARY KEY REFERENCES relay_profiles(id),
    policy_json TEXT, error_code TEXT,
    sharing_json TEXT NOT NULL DEFAULT '{"activity":false,"projects":[]}',
    status_version INTEGER NOT NULL DEFAULT 0,
    status_payload TEXT, status_sent_version INTEGER NOT NULL DEFAULT 0,
    statuses_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE git_operations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES relay_profiles(id), network_id TEXT NOT NULL, device_id TEXT NOT NULL,
    repository_key TEXT NOT NULL, preview_json TEXT NOT NULL, plan_json TEXT NOT NULL,
    state TEXT NOT NULL, submission_json TEXT, approval_json TEXT, execution_id TEXT,
    result_json TEXT, error_code TEXT, report_pending INTEGER NOT NULL DEFAULT 0,
    fence_acknowledged INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  );
  CREATE INDEX git_operations_project ON git_operations(profile_id,project_id,updated_at);
  CREATE INDEX git_operations_fence ON git_operations(repository_key,state,fence_acknowledged);
  CREATE TABLE git_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES git_operations(id),
    state TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE TABLE git_approval_inbox (
    profile_id TEXT NOT NULL REFERENCES relay_profiles(id), id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(profile_id,id)
  );
  PRAGMA user_version = 3;
`;
