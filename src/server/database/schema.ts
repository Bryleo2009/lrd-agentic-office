import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  github: text("github").notNull(),
  cloneUrl: text("clone_url").notNull(),
  localPath: text("local_path"),
  lastFetchAt: text("last_fetch_at"),
});

export const branches = sqliteTable("branches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repositoryId: text("repository_id").notNull(),
  missionId: text("mission_id"),
  name: text("name").notNull(),
  base: text("base").notNull(),
  worktree: text("worktree"),
  createdAt: text("created_at").notNull(),
});

export const missions = sqliteTable("missions", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  repositoryId: text("repository_id").notNull(),
  repoSelection: text("repo_selection").notNull().default("manual"),
  allowMcp: integer("allow_mcp", { mode: "boolean" }).notNull().default(false),
  mcpServers: text("mcp_servers").notNull().default("[]"),
  baseBranch: text("base_branch").notNull(),
  engine: text("engine").notNull(),
  provider: text("provider").notNull(),
  area: text("area").notNull(),
  branch: text("branch"),
  worktree: text("worktree"),
  status: text("status").notNull(),
  error: text("error"),
  commitSha: text("commit_sha"),
  pushed: integer("pushed", { mode: "boolean" }).notNull().default(false),
  prUrl: text("pr_url"),
  summary: text("summary"),
  planSource: text("plan_source"),
  repos: text("repos").notNull().default("[]"),
  ci: text("ci").notNull().default("[]"),
  checklist: text("checklist").notNull().default("[]"),
  questions: text("questions").notNull().default("[]"),
  taskKind: text("task_kind").notNull().default("general"),
  lessonIds: text("lesson_ids").notNull().default("[]"),
  delivery: text("delivery"),
  usage: text("usage"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const missionSteps = sqliteTable("mission_steps", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull(),
  agentId: text("agent_id").notNull(),
  title: text("title").notNull(),
  task: text("task").notNull(),
  dependsOn: text("depends_on").notNull(), // JSON
  writes: integer("writes", { mode: "boolean" }).notNull().default(false),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  provider: text("provider"),
  sessionId: text("session_id"),
  result: text("result"),
  error: text("error"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  position: integer("position").notNull().default(0),
  repositoryId: text("repository_id"),
  usage: text("usage"),
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: text("mission_id").notNull(),
  agentId: text("agent_id").notNull(),
  provider: text("provider").notNull(),
  cliSessionId: text("cli_session_id"),
  cwd: text("cwd").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runtimeEvents = sqliteTable("runtime_events", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  missionId: text("mission_id"),
  agentId: text("agent_id"),
  provider: text("provider"),
  sessionId: text("session_id"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  detail: text("detail"),
  tool: text("tool"),
  command: text("command"),
  file: text("file"),
  status: text("status"),
  metadata: text("metadata"), // JSON
});

export const handoffs = sqliteTable("handoffs", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull(),
  fromAgent: text("from_agent").notNull(),
  toAgent: text("to_agent").notNull(),
  title: text("title").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
});

export const deliveries = sqliteTable("deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: text("mission_id").notNull(),
  kind: text("kind").notNull(), // commit | push | pr
  ref: text("ref").notNull(),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
});
