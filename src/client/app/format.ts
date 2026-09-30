import type { AgentRuntimeEvent, EventType } from "../../shared/events";
import type { Mission, MissionStatus, StepStatus } from "../../shared/types";

export function timeOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

const LABELS: Partial<Record<EventType, string>> = {
  MISSION_CREATED: "misión",
  PLAN_CREATED: "plan",
  GIT_FETCH: "git",
  GIT_BRANCH: "git",
  GIT_WORKTREE: "git",
  GIT_DIFF: "diff",
  GIT_COMMIT: "commit",
  GIT_PUSH: "push",
  PR_CREATED: "PR",
  SESSION_STARTED: "sesión",
  SESSION_CONNECTED: "sesión",
  AGENT_STARTED: "inicio",
  AGENT_MESSAGE: "mensaje",
  AGENT_STATUS: "estado",
  SEARCH_STARTED: "busca",
  SEARCH_FINISHED: "busca",
  FILE_READ: "lee",
  FILE_CHANGED: "edita",
  TOOL_STARTED: "tool",
  TOOL_FINISHED: "tool",
  COMMAND_STARTED: "cmd",
  COMMAND_OUTPUT: "salida",
  COMMAND_FINISHED: "cmd",
  TEST_STARTED: "test",
  TEST_OUTPUT: "test",
  TEST_FINISHED: "test",
  HANDOFF: "handoff",
  HANDOFF_CREATED: "handoff",
  MEETING_STARTED: "reunión",
  AGENT_JOINED_MEETING: "reunión",
  MESSAGE_SENT: "mensaje",
  MEETING_FINISHED: "reunión",
  AGENT_WAITING: "espera",
  AGENT_BLOCKED: "bloqueo",
  AGENT_FINISHED: "listo",
  AGENT_ERROR: "error",
};

export function typeLabel(t: EventType): string {
  return LABELS[t] ?? t.toLowerCase();
}

export function eventTone(e: AgentRuntimeEvent): "ok" | "err" | "warn" | "run" | "info" {
  if (e.status === "error" || e.type === "AGENT_ERROR" || e.type === "AGENT_BLOCKED") return "err";
  if (e.status === "warning") return "warn";
  if (e.status === "success") return "ok";
  if (e.status === "running") return "run";
  return "info";
}

export const MISSION_STATUS: Record<MissionStatus, string> = {
  created: "Creada",
  preparing: "Preparando worktree",
  planning: "Planificando",
  running: "En curso",
  qa: "QA",
  committing: "Commit",
  done: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
};

export const STEP_STATUS: Record<StepStatus, string> = {
  pending: "pendiente",
  running: "trabajando",
  waiting: "esperando",
  done: "listo",
  failed: "falló",
  skipped: "omitido",
  cancelled: "cancelado",
};

export function isLive(s: MissionStatus): boolean {
  return ["created", "preparing", "planning", "running", "qa", "committing"].includes(s);
}

/** Repositorio(s) de la misión para mostrar: "lrd-back + lrd-front" en misiones de varios repos. */
export function repoLabel(m: Mission): string {
  return m.repos?.length > 1 ? m.repos.map((r) => r.repositoryId).join(" + ") : m.repositoryId;
}

/** Ramas entregadas: una por repo en misiones de varios repos. */
export function branchesOf(m: Mission): { repo: string | null; branch: string; sha: string | null }[] {
  if (m.repos?.length > 1) return m.repos.filter((r) => r.branch).map((r) => ({ repo: r.repositoryId, branch: r.branch!, sha: r.commitSha }));
  return m.branch ? [{ repo: null, branch: m.branch, sha: m.commitSha }] : [];
}
