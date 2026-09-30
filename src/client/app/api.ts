import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId, EngineChoice, Mission, RuntimeStatus } from "../../shared/types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  createMission: (b: { prompt: string; repositoryId: string; baseBranch: string; engine: EngineChoice }) =>
    req<Mission>("/api/missions", { method: "POST", body: JSON.stringify(b) }),
  cancelMission: (id: string) => req<{ ok: true }>(`/api/missions/${id}/cancel`, { method: "POST", body: "{}" }),
  chat: (agentId: AgentId, message: string, missionId?: string | null) =>
    req<{ ok: true }>(`/api/agents/${agentId}/chat`, { method: "POST", body: JSON.stringify({ message, missionId }) }),
  agentEvents: (agentId: AgentId) => req<AgentRuntimeEvent[]>(`/api/agents/${agentId}/events`),
  event: (id: string) => req<AgentRuntimeEvent>(`/api/events/${id}`),
  runtime: (force = false) => req<RuntimeStatus[]>(`/api/runtime${force ? "?force=1" : ""}`),
};
