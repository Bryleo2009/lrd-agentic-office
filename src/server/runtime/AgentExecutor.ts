import type { ChildProcess } from "node:child_process";
import type { RuntimeEventInput } from "../../shared/events";
import type { AgentId, Provider, RuntimeStatus } from "../../shared/types";

export type PermissionProfile = "read-only" | "workspace-write";

export interface SessionConfig {
  missionId: string | null;
  agentId: AgentId;
  cwd: string;
  permission: PermissionProfile;
  /** Carpeta donde se guarda stdout crudo del CLI (auditoría). */
  runDir: string;
  timeoutMs: number;
  /** Permite usar los servidores MCP configurados en el CLI (datos reales). */
  allowMcp: boolean;
}

/** Metadata de sesión. Nunca contiene credenciales. */
export interface AgentSession {
  provider: Provider;
  config: SessionConfig;
  /** ID de sesión del CLI (thread_id de Codex o session_id de Claude). */
  cliSessionId: string | null;
  /** true cuando la sesión del CLI ya ejecutó al menos un turno y puede reanudarse. */
  hasTurn: boolean;
  process: ChildProcess | null;
  cancelled: boolean;
}

export interface AgentTask {
  prompt: string;
  /** Título legible para eventos. */
  title: string;
}

/** Evento emitido por un executor. El orquestador completa missionId/agentId. */
export type ExecutorEvent = Omit<RuntimeEventInput, "missionId" | "agentId" | "provider" | "sessionId"> & {
  /** Texto final del turno (sólo en AGENT_FINISHED). */
  finalText?: string;
};

export interface AgentExecutor {
  provider: Provider;
  checkAvailability(force?: boolean): Promise<RuntimeStatus>;
  startSession(config: SessionConfig): Promise<AgentSession>;
  executeTask(session: AgentSession, task: AgentTask): AsyncIterable<ExecutorEvent>;
  sendMessage(session: AgentSession, message: string): AsyncIterable<ExecutorEvent>;
  cancel(session: AgentSession): Promise<void>;
  resume(session: AgentSession): Promise<void>;
  close(session: AgentSession): Promise<void>;
}

export class ExecutorUnavailableError extends Error {}
