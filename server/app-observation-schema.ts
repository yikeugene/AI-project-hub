export const APP_OBSERVATION_MIGRATION = `
CREATE TABLE app_observation_profiles (
  profile_id TEXT PRIMARY KEY REFERENCES relay_profiles(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
  pending_withdrawal INTEGER CHECK(pending_withdrawal>0 AND pending_withdrawal<=sequence)
);
PRAGMA user_version = 6;
`;
