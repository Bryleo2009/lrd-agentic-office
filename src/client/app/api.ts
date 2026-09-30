import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId, AgentProfile, CleanupReport, EngineChoice, Lesson, Mission, MissionQuestion, RepositoryConfig, RuntimeStatus, UsageMetrics } from "../../shared/types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  createMission: (b: { prompt: string; repositoryId: string; baseBranch: string | null; engine: EngineChoice; allowMcp: boolean; mcpServers?: string[] }) =>
    req<Mission>("/api/missions", { method: "POST", body: JSON.stringify(b) }),
  cancelMission: (id: string) => req<{ ok: true }>(`/api/missions/${id}/cancel`, { method: "POST", body: "{}" }),
  chat: (agentId: AgentId, message: string, missionId?: string | null, engine: EngineChoice = "auto") =>
    req<{ ok: true }>(`/api/agents/${agentId}/chat`, { method: "POST", body: JSON.stringify({ message, missionId, engine }) }),
  agentEvents: (agentId: AgentId) => req<AgentRuntimeEvent[]>(`/api/agents/${agentId}/events`),
  event: (id: string) => req<AgentRuntimeEvent>(`/api/events/${id}`),
  updateProfile: (id: AgentId, patch: Partial<AgentProfile>) => req<AgentProfile>(`/api/team/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  resetProfile: (id: AgentId) => req<AgentProfile>(`/api/team/${id}/reset`, { method: "POST", body: "{}" }),
  setRepoPath: (id: string, path: string | null) =>
    req<{ status: { ok: boolean; message: string }; repositories: RepositoryConfig[] }>(`/api/repositories/${id}/local-path`, { method: "PUT", body: JSON.stringify({ path }) }),
  lessons: () => req<Lesson[]>("/api/lessons"),
  addLesson: (text: string, scope: string) => req<Lesson>("/api/lessons", { method: "POST", body: JSON.stringify({ text, scope }) }),
  deleteLesson: (id: string) => req<{ ok: boolean }>(`/api/lessons/${id}`, { method: "DELETE", body: "{}" }),
  answer: (missionId: string, questionId: string, answer: string) =>
    req<MissionQuestion>(`/api/missions/${missionId}/questions/${questionId}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  usage: (days = 30) => req<UsageMetrics>(`/api/metrics/usage?days=${days}`),
  cleanup: (dryRun: boolean) => req<CleanupReport>("/api/maintenance/cleanup", { method: "POST", body: JSON.stringify({ dryRun }) }),
  setMcpHidden: (name: string, hidden: boolean) => req<RuntimeStatus[]>(`/api/mcp/${encodeURIComponent(name)}/hidden`, { method: "PUT", body: JSON.stringify({ hidden }) }),
  runtime: (force = false) => req<RuntimeStatus[]>(`/api/runtime${force ? "?force=1" : ""}`),
};
