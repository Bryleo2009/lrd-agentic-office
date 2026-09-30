import { run, tail } from "../../runtime/processUtils";

/** Adaptador GitHub vía `gh` (credenciales gestionadas por gh, nunca por esta app). */
export class GitHubAdapter {
  async status(): Promise<{ installed: boolean; authenticated: boolean; user: string | null; detail: string }> {
    const v = await run("gh", ["--version"], { timeoutMs: 10000 });
    if (v.code !== 0) return { installed: false, authenticated: false, user: null, detail: "gh no instalado" };
    const a = await run("gh", ["auth", "status"], { timeoutMs: 15000 });
    const out = `${a.stdout}\n${a.stderr}`;
    const m = out.match(/account\s+(\S+)/i) ?? out.match(/Logged in to \S+ as (\S+)/i);
    return { installed: true, authenticated: a.code === 0, user: m ? m[1] : null, detail: out.trim().split(/\r?\n/).slice(0, 3).join(" ") };
  }

  async createPr(cwd: string, opts: { base: string; head: string; title: string; body: string }): Promise<string> {
    const r = await run("gh", ["pr", "create", "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body], {
      cwd,
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new Error(`gh pr create falló: ${tail(`${r.stderr}\n${r.stdout}`, 1500)}`);
    const url = r.stdout.trim().split(/\s+/).find((s) => s.startsWith("https://"));
    return url ?? r.stdout.trim();
  }
}

export const github = new GitHubAdapter();
