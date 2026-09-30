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
CREATE TABLE IF NOT EXISTS library_docs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, mission_id TEXT, agent_id TEXT,
  repository_id TEXT, source_key TEXT UNIQUE, tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_library_created ON library_docs(created_at);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  detail TEXT, created_at TEXT NOT NULL);
`);

// Columnas agregadas en versiones posteriores
const cols = (sqlite.prepare("PRAGMA table_info(missions)").all() as { name: string }[]).map((c) => c.name);
if (!cols.includes("repo_selection")) sqlite.exec("ALTER TABLE missions ADD COLUMN repo_selection TEXT NOT NULL DEFAULT 'manual'");
if (!cols.includes("mcp_servers")) sqlite.exec("ALTER TABLE missions ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]'");
if (!cols.includes("allow_mcp")) sqlite.exec("ALTER TABLE missions ADD COLUMN allow_mcp INTEGER NOT NULL DEFAULT 0");
if (!cols.includes("repos")) sqlite.exec("ALTER TABLE missions ADD COLUMN repos TEXT NOT NULL DEFAULT '[]'");
const stepCols = (sqlite.prepare("PRAGMA table_info(mission_steps)").all() as { name: string }[]).map((c) => c.name);
if (!stepCols.includes("repository_id")) sqlite.exec("ALTER TABLE mission_steps ADD COLUMN repository_id TEXT");

if (!cols.includes("ci")) sqlite.exec("ALTER TABLE missions ADD COLUMN ci TEXT NOT NULL DEFAULT '[]'");
if (!cols.includes("checklist")) sqlite.exec("ALTER TABLE missions ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]'");
if (!cols.includes("questions")) sqlite.exec("ALTER TABLE missions ADD COLUMN questions TEXT NOT NULL DEFAULT '[]'");
if (!cols.includes("task_kind")) sqlite.exec("ALTER TABLE missions ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'general'");
if (!cols.includes("lesson_ids")) sqlite.exec("ALTER TABLE missions ADD COLUMN lesson_ids TEXT NOT NULL DEFAULT '[]'");
if (!cols.includes("resumes")) sqlite.exec("ALTER TABLE missions ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0");

// Las misiones que quedaron a medias por un reinicio del servidor NO se dan por fallidas aquí:
// el orquestador las retoma al arrancar (AgentOrchestrator.resumeInterrupted).

export const db = drizzle(sqlite, { schema });
export { schema };
