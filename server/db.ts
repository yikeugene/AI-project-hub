import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EMPTY_MEMORY } from '../shared/types.js';
import { normalizeLocale } from '../shared/i18n.js';
import type { GitSnapshot, Project, ProjectMemory, Settings, Task, WorkspaceFocus } from '../shared/types.js';
import { appError, workspaceFocusSchema, wrapUpProjectSchema } from './validation.js';
import { DEVICE_MIGRATION, MULTI_GROUP_MIGRATION } from './device-schema.js';
import { GOVERNANCE_MIGRATION } from './governance-schema.js';
import { APP_OBSERVATION_MIGRATION } from './app-observation-schema.js';
import { WORK_ITEM_MIGRATION } from './work-item-schema.js';
import type { CreateProjectInput, UpdateProjectInput, WrapUpProjectInput, CreateTaskInput, UpdateTaskInput } from './validation.js';

type Row = Record<string, string | number | null>;
const now = () => new Date().toISOString();

function toProject(r: Row): Project {
  return {
    id: r.id as string, path: r.path as string, name: r.name as string,
    description: r.description as string, category: r.category as string,
    status: r.status as Project['status'], priority: r.priority as Project['priority'],
    stage: r.stage as string, nextAction: r.next_action as string,
    memory: JSON.parse(r.memory_json as string), revision: Number(r.revision),
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    memoryUpdatedAt: r.memory_updated_at as string | null, checkpointAt: r.checkpoint_at as string | null,
    git: r.git_json ? JSON.parse(r.git_json as string) : null,
    gitError: r.git_error as string | null, lastCheckedAt: r.last_checked_at as string | null,
  };
}
function toTask(r: Row): Task {
  return { id: r.id as string, projectId: r.project_id as string, title: r.title as string, detail: r.detail as string,
    status: r.status as Task['status'], priority: r.priority as Task['priority'], revision: Number(r.revision),
    createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 7) { this.db.close(); throw appError(400, 'database.newer'); }
    try {
    if (version === 0) this.db.exec(`
      BEGIN;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('active','paused','planning','completed','archived')),
        priority TEXT NOT NULL CHECK(priority IN ('high','normal','low','backlog')),
        stage TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '',
        memory_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, memory_updated_at TEXT,
        git_json TEXT, git_error TEXT, last_checked_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('todo','doing','blocked','done')),
        priority TEXT NOT NULL CHECK(priority IN ('high','normal','low','backlog')),
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX tasks_project ON tasks(project_id);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    if (version < 2) this.transaction(() => this.db.exec(DEVICE_MIGRATION));
    if (version < 3) this.transaction(() => this.db.exec(GOVERNANCE_MIGRATION));
    if (version < 4) this.transaction(() => this.db.exec(MULTI_GROUP_MIGRATION));
    if (version < 5) this.transaction(() => this.db.exec(`
      ALTER TABLE projects ADD COLUMN checkpoint_at TEXT;
      CREATE TABLE workspace_focus (
        id INTEGER PRIMARY KEY CHECK(id = 1), project_ids_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO workspace_focus(id) VALUES(1);
      PRAGMA user_version = 5;
    `));
    if (version < 6) this.transaction(() => this.db.exec(APP_OBSERVATION_MIGRATION));
    if (version < 7) this.transaction(() => this.db.exec(WORK_ITEM_MIGRATION));
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* A failed migration may already have rolled back. */ }
      this.db.close(); throw error;
    }
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('SQLite transactions must be synchronous.');
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  listProjects(): Project[] { return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC, id').all() as Row[]).map(toProject); }
  getProject(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw appError(404, 'project.notFound');
    return toProject(row);
  }
  findByPath(path: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Row | undefined;
    return row ? toProject(row) : null;
  }
  createProject(input: CreateProjectInput & { path: string; name: string }): Project {
    if (this.findByPath(input.path)) throw appError(409, 'project.duplicate');
    const id = randomUUID(), at = now();
    this.db.prepare(`INSERT INTO projects
      (id,path,name,description,category,status,priority,stage,next_action,memory_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.path, input.name, input.description ?? '', input.category ?? '', input.status ?? 'active',
      input.priority ?? 'normal', input.stage ?? '', input.nextAction ?? '', JSON.stringify(EMPTY_MEMORY), at, at);
    return this.getProject(id);
  }
  updateProject(id: string, input: UpdateProjectInput): Project {
    const old = this.getProject(id);
    this.checkRevision(old.revision, input.revision);
    const p = { ...old, ...input };
    const result = this.db.prepare(`UPDATE projects SET name=?,description=?,category=?,status=?,priority=?,stage=?,
      checkpoint_at=CASE WHEN next_action IS NOT ? THEN NULL ELSE checkpoint_at END,
      next_action=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?`)
      .run(p.name, p.description, p.category, p.status, p.priority, p.stage, p.nextAction, p.nextAction, now(), id, input.revision);
    this.requireChange(result.changes);
    return this.getProject(id);
  }
  saveMemory(id: string, revision: number, memory: ProjectMemory, nextAction?: string): Project {
    const project = this.getProject(id);
    this.checkRevision(project.revision, revision);
    const at = now(), action = nextAction ?? project.nextAction;
    // Keep invalidation in this UPDATE: device proposal acceptance already owns a transaction.
    const result = this.db.prepare(`UPDATE projects SET
      checkpoint_at=CASE WHEN json_extract(memory_json,'$.status') IS NOT ? OR json_extract(memory_json,'$.blockers') IS NOT ? OR next_action IS NOT ? THEN NULL ELSE checkpoint_at END,
      memory_json=?,next_action=?,memory_updated_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?`)
      .run(memory.status, memory.blockers, action, JSON.stringify(memory), action, at, at, id, revision);
    this.requireChange(result.changes);
    return this.getProject(id);
  }
  wrapUpProject(id: string, input: WrapUpProjectInput): Project {
    const { revision, status, blockers, nextAction } = wrapUpProjectSchema.parse(input);
    const project = this.getProject(id);
    this.checkRevision(project.revision, revision);
    const at = now(), memory = { ...project.memory, status, blockers };
    const result = this.db.prepare(`UPDATE projects SET memory_json=?,next_action=?,memory_updated_at=?,updated_at=?,checkpoint_at=?,revision=revision+1 WHERE id=? AND revision=?`)
      .run(JSON.stringify(memory), nextAction, at, at, at, id, revision);
    this.requireChange(result.changes);
    return this.getProject(id);
  }
  deleteProject(id: string, revision: number) {
    this.transaction(() => {
      this.checkRevision(this.getProject(id).revision, revision);
      this.requireChange(this.db.prepare('DELETE FROM projects WHERE id=? AND revision=?').run(id, revision).changes);
      const focus = this.getFocus(), projectIds = focus.projectIds.filter(projectId => projectId !== id);
      if (projectIds.length !== focus.projectIds.length) {
        this.requireChange(this.db.prepare('UPDATE workspace_focus SET project_ids_json=?,revision=revision+1 WHERE id=1 AND revision=?')
          .run(JSON.stringify(projectIds), focus.revision).changes);
      }
    });
  }
  saveObservation(id: string, snapshot: GitSnapshot | null, error: string | null) {
    // Observation updates never overwrite user fields, revision, or activity timestamps.
    this.db.prepare('UPDATE projects SET git_json=COALESCE(?,git_json),git_error=?,last_checked_at=? WHERE id=?')
      .run(snapshot ? JSON.stringify(snapshot) : null, error, now(), id);
  }
  listTasks(): Task[] { return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as Row[]).map(toTask); }
  getTask(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined;
    if (!row) throw appError(404, 'task.notFound');
    return toTask(row);
  }
  createTask(projectId: string, input: CreateTaskInput): Task {
    this.getProject(projectId);
    const id = randomUUID(), at = now();
    this.db.prepare('INSERT INTO tasks (id,project_id,title,detail,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, projectId, input.title, input.detail ?? '', input.status ?? 'todo', input.priority ?? 'normal', at, at);
    return this.getTask(id);
  }
  updateTask(id: string, input: UpdateTaskInput): Task {
    const old = this.getTask(id);
    this.checkRevision(old.revision, input.revision);
    const task = { ...old, ...input };
    const result = this.db.prepare('UPDATE tasks SET title=?,detail=?,status=?,priority=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?')
      .run(task.title, task.detail, task.status, task.priority, now(), id, input.revision);
    this.requireChange(result.changes);
    return this.getTask(id);
  }
  deleteTask(id: string, revision: number) {
    this.checkRevision(this.getTask(id).revision, revision);
    this.requireChange(this.db.prepare('DELETE FROM tasks WHERE id=? AND revision=?').run(id, revision).changes);
  }
  getFocus(): WorkspaceFocus {
    const row = this.db.prepare('SELECT project_ids_json,revision FROM workspace_focus WHERE id=1').get() as Row;
    return { projectIds: JSON.parse(row.project_ids_json as string), revision: Number(row.revision) };
  }
  saveFocus(revision: number, projectIds: string[]): WorkspaceFocus {
    const input = workspaceFocusSchema.parse({ revision, projectIds });
    if (new Set(input.projectIds).size !== input.projectIds.length) throw appError(400, 'focus.duplicate');
    return this.transaction(() => {
      const focus = this.getFocus();
      this.checkRevision(focus.revision, input.revision);
      const exists = this.db.prepare('SELECT id FROM projects WHERE id=?');
      for (const id of input.projectIds) if (!exists.get(id)) throw appError(400, 'focus.projectNotFound');
      if (focus.projectIds.length === input.projectIds.length && focus.projectIds.every((id, index) => id === input.projectIds[index])) return focus;
      this.requireChange(this.db.prepare('UPDATE workspace_focus SET project_ids_json=?,revision=revision+1 WHERE id=1 AND revision=?')
        .run(JSON.stringify(input.projectIds), input.revision).changes);
      return this.getFocus();
    });
  }
  getSettings(): Settings {
    const r = this.db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string } | undefined;
    const saved = r ? JSON.parse(r.value) : {};
    // Locale is an additive setting, not a database migration. Preserve legacy values.
    return { scanRoots: [], staleDays: 14, refreshSeconds: 60, ...saved, locale: normalizeLocale(saved?.locale) };
  }
  updateSettings(patch: Partial<Settings>): Settings {
    const settings = { ...this.getSettings(), ...patch };
    this.db.prepare('INSERT INTO settings (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(settings));
    return settings;
  }
  private requireChange(changes: number | bigint) {
    if (Number(changes) !== 1) throw appError(409, 'revision.changed');
  }
  private checkRevision(actual: number, expected: number) {
    if (actual !== expected) throw appError(409, 'revision.stale');
  }
}
