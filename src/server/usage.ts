import type { MissionUsage, Provider, TokenUsage } from "../shared/types";

export const emptyUsage = (): TokenUsage => ({ input: 0, cached: 0, output: 0, calls: 0 });

/**
 * Consumo de un turno, tal como lo informa cada motor:
 * - Codex (turn.completed.usage): input_tokens (incluye los de caché), cached_input_tokens, output_tokens.
 * - Claude Code (result.usage): input_tokens + cache_creation_input_tokens + cache_read_input_tokens, output_tokens,
 *   y total_cost_usd (equivalente en API).
 */
export function normalizeUsage(provider: Provider, meta: Record<string, unknown> | null | undefined): TokenUsage | null {
  const u = (meta?.usage ?? null) as Record<string, number> | null;
  if (!u || typeof u !== "object") return null;
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? u[k] : 0);
  const out =
    provider === "codex"
      ? { input: n("input_tokens"), cached: n("cached_input_tokens"), output: n("output_tokens"), calls: 1 }
      : { input: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"), cached: n("cache_read_input_tokens"), output: n("output_tokens"), calls: 1 };
  if (!out.input && !out.output) return null;
  const cost = typeof meta?.costUsd === "number" ? (meta.costUsd as number) : undefined;
  return cost !== undefined ? { ...out, costUsd: cost } : out;
}

export function addUsage(a: TokenUsage | null | undefined, b: TokenUsage): TokenUsage {
  const base = a ?? emptyUsage();
  const cost = (base.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    input: base.input + b.input,
    cached: base.cached + b.cached,
    output: base.output + b.output,
    calls: base.calls + b.calls,
    ...(base.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: Math.round(cost * 10000) / 10000 } : {}),
  };
}

export function addMissionUsage(m: MissionUsage | null | undefined, provider: Provider, u: TokenUsage): MissionUsage {
  return {
    total: addUsage(m?.total, u),
    byProvider: { ...(m?.byProvider ?? {}), [provider]: addUsage(m?.byProvider?.[provider], u) },
  };
}

/** "1,2 M", "45 k", "830". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
  if (n >= 1000) return `${Math.round(n / 1000)} k`;
  return String(n);
}
