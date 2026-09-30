import type { AgentId, Provider } from "./types";

export const EVENT_TYPES = [
  "MISSION_CREATED",
  "MISSION_UPDATED",
  "PLAN_CREATED",
  "GIT_FETCH",
  "GIT_BRANCH",
  "GIT_WORKTREE",
  "SESSION_STARTED",
  "SESSION_CONNECTED",
  "AGENT_STARTED",
  "AGENT_MESSAGE",
  "AGENT_STATUS",
  "SEARCH_STARTED",
  "SEARCH_FINISHED",
  "FILE_READ",
  "FILE_CHANGED",
  "TOOL_STARTED",
  "TOOL_FINISHED",
  "COMMAND_STARTED",
  "COMMAND_OUTPUT",
  "COMMAND_FINISHED",
  "TEST_STARTED",
  "TEST_OUTPUT",
  "TEST_FINISHED",
  "GIT_DIFF",
  "GIT_COMMIT",
  "GIT_PUSH",
  "PR_CREATED",
  "HANDOFF",
  "HANDOFF_CREATED",
  "MEETING_STARTED",
  "AGENT_JOINED_MEETING",
  "MESSAGE_SENT",
  "MEETING_FINISHED",
  "AGENT_WAITING",
  "AGENT_BLOCKED",
  "AGENT_FINISHED",
  "AGENT_ERROR",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventStatus = "info" | "running" | "success" | "error" | "warning";

export interface AgentRuntimeEvent {
  id: string;
  timestamp: string;
  missionId: string | null;
  agentId: AgentId | null;
  provider: Provider | "system" | "git" | "github" | "qa" | null;
  sessionId: string | null;
  type: EventType;
  title: string;
  detail?: string | null;
  tool?: string | null;
  command?: string | null;
  file?: string | null;
  status?: EventStatus | null;
  metadata?: Record<string, unknown> | null;
}

/** Evento sin los campos que asigna el bus. */
export type RuntimeEventInput = Omit<AgentRuntimeEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};
