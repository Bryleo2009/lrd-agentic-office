import { config } from "../../config";
import { run, tail } from "../../runtime/processUtils";

export interface WorkflowRun {
  databaseId: number;
  status: string; // queued | in_progress | completed …
  conclusion: string | null; // success | failure | cancelled | skipped | neutral …
  workflowName: string;
  headSha: string;
  url: string;
}

/** Adaptador GitHub vía `gh` (credenciales gestionadas por gh, nunca por esta app). */
export class GitHubAdapter {
  async status(): Promise<{ installed: boolean; authenticated: boolean; user: string | null; detail: string }> {
    const v = await run(config.ghCommand, ["--version"], { timeoutMs: 10000 });
    if (v.code !== 0) return { installed: false, authenticated: false, user: null, detail: "gh no instalado" };
    const a = await run(config.ghCommand, ["auth", "status"], { timeoutMs: 15000 });
    const out = `${a.stdout}\n${a.stderr}`;
    const m = out.match(/account\s+(\S+)/i) ?? out.match(/Logged in to \S+ as (\S+)/i);
    return { installed: true, authenticated: a.code === 0, user: m ? m[1] : null, detail: out.trim().split(/\r?\n/).slice(0, 3).join(" ") };
  }

  /** Ejecuciones de GitHub Actions de un commit en una rama. */
  async runsFor(repo: string, branch: string, sha: string): Promise<WorkflowRun[]> {
    const r = await run(config.ghCommand, ["run", "list", "-R", repo, "--branch", branch, "--limit", "30", "--json", "databaseId,status,conclusion,workflowName,headSha,url"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`gh run list falló: ${tail(`${r.stderr}\n${r.stdout}`, 800)}`);
    const all = JSON.parse(r.stdout || "[]") as WorkflowRun[];
    return all.filter((x) => x.headSha === sha);
  }

  /** Log de los jobs que fallaron (final). */
  async failedLog(repo: string, runId: number): Promise<string> {
    const r = await run(config.ghCommand, ["run", "view", String(runId), "-R", repo, "--log-failed"], { timeoutMs: 120_000 });
    return tail(`${r.stdout}\n${r.stderr}`.trim(), 14000);
  }

  /** Conclusión de la última ejecución terminada de un workflow en una rama (p. ej. la base). */
  async lastConclusion(repo: string, branch: string, workflowName: string): Promise<string | null> {
    const r = await run(config.ghCommand, ["run", "list", "-R", repo, "--branch", branch, "--workflow", workflowName, "--status", "completed", "--limit", "1", "--json", "conclusion"], { timeoutMs: 60_000 });
    if (r.code !== 0) return null;
    try {
      return (JSON.parse(r.stdout || "[]") as { conclusion: string | null }[])[0]?.conclusion ?? null;
    } catch {
      return null;
    }
  }

  async createPr(cwd: string, opts: { base: string; head: string; title: string; body: string }): Promise<string> {
    const r = await run(config.ghCommand, ["pr", "create", "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body], {
      cwd,
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new Error(`gh pr create falló: ${tail(`${r.stderr}\n${r.stdout}`, 1500)}`);
    const url = r.stdout.trim().split(/\s+/).find((s) => s.startsWith("https://"));
    return url ?? r.stdout.trim();
  }
}

export const github = new GitHubAdapter();
