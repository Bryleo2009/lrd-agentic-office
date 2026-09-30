import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { paths, ensureWorkspace } from "../config";
import * as schema from "./schema";

ensureWorkspace();

export const sqlite = new Database(paths.db);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");

// Migración idempotente (sin herramientas externas).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, github TEXT NOT NULL, clone_url TEXT NOT NULL,
  local_path TEXT, last_fetch_at TEXT);
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL, mission_id TEXT, name TEXT NOT NULL,
  base TEXT NOT NULL, worktree TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repository_id TEXT NOT NULL, base_branch TEXT NOT NULL,
  engine TEXT NOT NULL, provider TEXT NOT NULL, area TEXT NOT NULL, branch TEXT, worktree TEXT,
  status TEXT NOT NULL, error TEXT, commit_sha TEXT, pushed INTEGER NOT NULL DEFAULT 0, pr_url TEXT,
  summary TEXT, plan_source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mission_steps (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL, task TEXT NOT NULL,
  depends_on TEXT NOT NULL, writes INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, status TEXT NOT NULL,
  provider TEXT, session_id TEXT, result TEXT, error TEXT, started_at TEXT, finished_at TEXT,
  position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, agent_id TEXT NOT NULL, provider TEXT NOT NULL,
  cli_session_id TEXT, cwd TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, mission_id TEXT, agent_id TEXT, provider TEXT, session_id TEXT,
  type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, tool TEXT, command TEXT, file TEXT, status TEXT, metadata TEXT);
CREATE INDEX IF NOT EXISTS idx_events_mission ON runtime_events(mission_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_agent ON runtime_events(agent_id, timestamp);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
  title TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  detail TEXT, created_at TEXT NOT NULL);
`);

// Misiones que quedaron a medias por un reinicio del servidor: se marcan como fallidas (error real, no éxito).
sqlite
  .prepare(
    `UPDATE missions SET status='failed', error=COALESCE(error,'El servidor se reinició durante la misión'), updated_at=?
     WHERE status IN ('created','preparing','planning','running','qa','committing')`,
  )
  .run(new Date().toISOString());
sqlite
  .prepare(`UPDATE mission_steps SET status='cancelled' WHERE status IN ('pending','running','waiting')`)
  .run();

export const db = drizzle(sqlite, { schema });
export { schema };
