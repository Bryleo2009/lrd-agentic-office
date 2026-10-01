import type { EngineUsage, Provider, UsageMetrics } from "../shared/types";
import { sqlite } from "./database/db";
import { addUsage, emptyUsage } from "./usage";

/**
 * Métricas de uso por motor (Codex / Claude Code) a partir de lo que realmente pasó: pasos ejecutados,
 * su duración y resultado, límites de uso alcanzados y misiones de las que fue el motor principal.
 */
export function usageMetrics(days = 30): UsageMetrics {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const steps = sqlite
    .prepare(`SELECT provider, kind, status, started_at AS startedAt, finished_at AS finishedAt FROM mission_steps WHERE provider IS NOT NULL AND started_at >= ?`)
    .all(since) as { provider: Provider; kind: string; status: string; startedAt: string | null; finishedAt: string | null }[];
  const switches = sqlite
    .prepare(`SELECT metadata FROM runtime_events WHERE type = 'AGENT_STATUS' AND timestamp >= ? AND metadata LIKE '%engineSwitch%'`)
    .all(since) as { metadata: string }[];
  const missions = sqlite.prepare(`SELECT provider, status, questions, usage FROM missions WHERE created_at >= ?`).all(since) as { provider: Provider; status: string; questions: string | null; usage: string | null }[];
  const tokensOf = (p: Provider) =>
    missions.reduce((acc, m) => {
      try {
        const u = m.usage ? JSON.parse(m.usage)?.byProvider?.[p] : null;
        return u ? addUsage(acc, u) : acc;
      } catch {
        return acc;
      }
    }, emptyUsage());

  const engines: EngineUsage[] = (["codex", "claude"] as Provider[]).map((provider) => {
    const mine = steps.filter((s) => s.provider === provider);
    const ms = mine.reduce((acc, s) => (s.startedAt && s.finishedAt ? acc + Math.max(0, new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) : acc), 0);
    const timed = mine.filter((s) => s.startedAt && s.finishedAt).length;
    const byKind: Record<string, number> = {};
    for (const s of mine) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    return {
      provider,
      tokens: tokensOf(provider),
      steps: mine.length,
      done: mine.filter((s) => s.status === "done").length,
      failed: mine.filter((s) => s.status === "failed").length,
      minutes: Math.round(ms / 6000) / 10,
      avgStepMin: timed ? Math.round(ms / timed / 6000) / 10 : 0,
      saturations: switches.filter((e) => {
        try {
          return JSON.parse(e.metadata)?.engineSwitch?.from === provider;
        } catch {
          return false;
        }
      }).length,
      missions: missions.filter((m) => m.provider === provider).length,
      byKind,
    };
  });

  let questions = 0;
  let approvals = 0;
  for (const m of missions) {
    try {
      for (const q of JSON.parse(m.questions ?? "[]") as { kind: string }[]) q.kind === "approval" ? approvals++ : questions++;
    } catch {
      /* columna vieja */
    }
  }
  return {
    days,
    since,
    engines,
    missions: {
      total: missions.length,
      done: missions.filter((m) => m.status === "done").length,
      failed: missions.filter((m) => m.status === "failed").length,
      cancelled: missions.filter((m) => m.status === "cancelled").length,
      questions,
      approvals,
    },
  };
}
