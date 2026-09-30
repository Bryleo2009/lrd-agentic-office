import type { AgentRuntimeEvent } from "./events";

export type Provider = "codex" | "claude";
export type EngineChoice = "auto" | Provider;

export type AgentId = "atlas" | "diego" | "mica" | "nora" | "vega" | "rafa" | "piero" | "fiona";

export type Department = "CONTROL" | "INGENIERIA" | "QA" | "OPERACIONES";

export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: string;
  department: Department;
  /** Área usada en el nombre de rama agentic/<area>/... */
  area: string;
  tagline: string;
  responsibilities: string[];
  /** Instrucciones de rol que se anteponen a cada tarea real. */
  systemBrief: string;
  color: string;
}

export interface RuntimeStatus {
  provider: Provider;
  label: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  authenticated: boolean | null;
  authDetail: string | null;
  /** Flags detectados en el --help de la versión instalada. */
  capabilities: Record<string, boolean>;
  message: string;
  checkedAt: string;
}

export type MissionStatus =
  | "created"
  | "preparing"
  | "planning"
  | "running"
  | "qa"
  | "committing"
  | "done"
  | "failed"
  | "cancelled";

export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped" | "cancelled";

export interface MissionStep {
  id: string;
  missionId: string;
  agentId: AgentId;
  title: string;
  task: string;
  dependsOn: string[];
  writes: boolean;
  kind: "plan" | "agent" | "qa" | "review";
  status: StepStatus;
  provider: Provider | null;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Mission {
  id: string;
  prompt: string;
  repositoryId: string;
  baseBranch: string;
  engine: EngineChoice;
  provider: Provider;
  area: string;
  branch: string | null;
  worktree: string | null;
  status: MissionStatus;
  error: string | null;
  commitSha: string | null;
  pushed: boolean;
  prUrl: string | null;
  summary: string | null;
  planSource: "ai" | "rules" | null;
  createdAt: string;
  updatedAt: string;
  steps: MissionStep[];
}

export interface RepositoryConfig {
  id: string;
  name: string;
  github: string;
  cloneUrl: string;
  shortName: string;
  enabled: boolean;
  allowedBases: string[];
  defaultBase: string;
  /** Comandos de QA explícitos. Si faltan, se autodetectan. */
  qaCommands?: string[];
  installCommand?: string | null;
  kind?: "frontend" | "backend" | "other";
}

export interface AgentSessionInfo {
  missionId: string;
  agentId: AgentId;
  provider: Provider;
  sessionId: string | null;
  cwd: string;
  status: "starting" | "running" | "idle" | "closed" | "error";
  startedAt: string;
}

export interface PublicConfig {
  aiProviderMode: string;
  aiEngineDefault: Provider;
  allowPaidApiFallback: boolean;
  githubPushEnabled: boolean;
  githubPrEnabled: boolean;
  protectedBranches: string[];
  workspaceRoot: string;
  agentEngines: Partial<Record<AgentId, Provider>>;
}

export interface Snapshot {
  runtime: RuntimeStatus[];
  missions: Mission[];
  repositories: RepositoryConfig[];
  config: PublicConfig;
  recentEvents: AgentRuntimeEvent[];
  sessions: AgentSessionInfo[];
}

export type WsServerMessage =
  | { kind: "hello"; snapshot: Snapshot }
  | { kind: "event"; event: AgentRuntimeEvent }
  | { kind: "mission"; mission: Mission }
  | { kind: "runtime"; runtime: RuntimeStatus[] }
  | { kind: "session"; session: AgentSessionInfo }
  | { kind: "chat"; agentId: AgentId; missionId: string | null; delta: string; done: boolean; error?: string };
