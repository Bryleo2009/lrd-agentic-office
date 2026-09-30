import type { WorkflowRun } from "../integrations/github/GitHubAdapter";

/** Resultado de esperar GitHub Actions para un commit. */
export type CiState = "success" | "failure" | "none" | "unavailable" | "timeout" | "cancelled";

export interface CiWaitResult {
  state: CiState;
  runs: WorkflowRun[];
  failed: WorkflowRun[];
  detail: string;
}

export interface CiSource {
  runsFor(repo: string, branch: string, sha: string): Promise<WorkflowRun[]>;
}

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/**
 * Espera a que terminen TODAS las ejecuciones de GitHub Actions de `sha` en `branch`.
 * - Si en `appearMs` no aparece ninguna: "none" (la rama no dispara workflows; p. ej. filtros de ramas).
 * - Si `gh` falla (no instalado / sin sesión): "unavailable".
 * Llama a onProgress cuando cambia el resumen, para mostrarlo en la oficina.
 */
export async function waitForCi(
  src: CiSource,
  o: { repo: string; branch: string; sha: string; appearMs: number; timeoutMs: number; pollMs: number },
  hooks: { isCancelled: () => boolean; onProgress?: (text: string) => void; sleep?: (ms: number) => Promise<void> } = { isCancelled: () => false },
): Promise<CiWaitResult> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  let last = "";
  for (;;) {
    if (hooks.isCancelled()) return { state: "cancelled", runs: [], failed: [], detail: "Cancelada" };
    let runs: WorkflowRun[];
    try {
      runs = await src.runsFor(o.repo, o.branch, o.sha);
    } catch (e) {
      return { state: "unavailable", runs: [], failed: [], detail: (e as Error).message };
    }
    const elapsed = Date.now() - t0;
    if (!runs.length) {
      if (elapsed >= o.appearMs)
        return { state: "none", runs, failed: [], detail: `Ningún workflow de GitHub Actions se ejecutó para ${o.branch} en ${Math.round(o.appearMs / 1000)} s (revisa los filtros "on: push: branches" del workflow).` };
    } else {
      const pending = runs.filter((r) => r.status !== "completed");
      const failed = runs.filter((r) => r.status === "completed" && FAILED.has(r.conclusion ?? ""));
      const summary = runs.map((r) => `${r.workflowName}: ${r.status === "completed" ? r.conclusion : r.status}`).join(" · ");
      if (summary !== last) {
        last = summary;
        hooks.onProgress?.(summary);
      }
      if (!pending.length)
        return failed.length
          ? { state: "failure", runs, failed, detail: failed.map((r) => `${r.workflowName} (${r.conclusion})`).join(", ") }
          : { state: "success", runs, failed: [], detail: summary };
    }
    if (elapsed >= o.timeoutMs) return { state: "timeout", runs, failed: [], detail: `GitHub Actions no terminó en ${Math.round(o.timeoutMs / 60000)} min.` };
    await sleep(o.pollMs);
  }
}
