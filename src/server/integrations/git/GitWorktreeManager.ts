import fs from "node:fs";
import path from "node:path";
import type { RepositoryConfig } from "../../../shared/types";
import { loadRepositories, paths } from "../../config";
import { run, tail } from "../../runtime/processUtils";
import { repoLocalPath } from "../../settings";

export class GitError extends Error {
  constructor(message: string, public readonly output: string) {
    super(message);
  }
}

async function git(args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  const r = await run("git", args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.code !== 0) throw new GitError(`git ${args.join(" ")} falló${r.error ? `: ${r.error}` : ""}`, tail(`${r.stderr}\n${r.stdout}`.trim(), 3000));
  return r.stdout.trim();
}

export function isProtected(branch: string): boolean {
  const { protectedBranches } = loadRepositories();
  return protectedBranches.includes(branch.replace(/^origin\//, ""));
}

function assertNotProtected(branch: string): void {
  if (isProtected(branch)) throw new GitError(`Operación bloqueada: ${branch} es una rama protegida`, "");
}

export function slugify(s: string, max = 32): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .filter((w) => w.length > 2 && !STOP.has(w))
      .slice(0, 5)
      .join("-")
      .slice(0, max)
      .replace(/-+$/, "") || "mission"
  );
}
const STOP = new Set(["por", "que", "the", "los", "las", "del", "una", "uno", "con", "para", "revisa", "esta", "este", "and", "prepara"]);

export class GitWorktreeManager {
  /** Tu clon local (Ajustes) si está configurado; si no, un clon gestionado en el workspace. */
  repoPath(repo: RepositoryConfig): string {
    return repoLocalPath(repo.id) ?? path.join(paths.repos, repo.id);
  }

  isUserRepo(repo: RepositoryConfig): boolean {
    return repoLocalPath(repo.id) !== null;
  }

  /** Clona si no existe. Con ruta local nunca clona: usa tu repositorio tal cual (no toca tu rama ni tus cambios). */
  async ensureClone(repo: RepositoryConfig): Promise<string> {
    const local = repoLocalPath(repo.id);
    if (local) {
      if (!fs.existsSync(local)) throw new GitError(`La ruta local de ${repo.name} no existe: ${local}`, "");
      await git(["rev-parse", "--git-dir"], local);
      return local;
    }
    const p = this.repoPath(repo);
    if (fs.existsSync(path.join(p, ".git")) || fs.existsSync(path.join(p, "HEAD"))) return p;
    fs.mkdirSync(paths.repos, { recursive: true });
    await git(["clone", "--no-checkout", repo.cloneUrl, p], paths.repos, 15 * 60_000);
    return p;
  }

  async fetch(repo: RepositoryConfig): Promise<void> {
    // En tu repo local no se hace --prune para no alterar tus referencias remotas.
    await git(this.isUserRepo(repo) ? ["fetch", "origin"] : ["fetch", "origin", "--prune"], this.repoPath(repo), 10 * 60_000);
  }

  async remoteBranchExists(repo: RepositoryConfig, branch: string): Promise<boolean> {
    try {
      await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], this.repoPath(repo));
      return true;
    } catch {
      return false;
    }
  }

  async listRemoteBranches(repo: RepositoryConfig): Promise<string[]> {
    const out = await git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], this.repoPath(repo));
    return out.split(/\r?\n/).map((l) => l.replace(/^origin\//, "")).filter((l) => l && l !== "HEAD" && l !== "origin");
  }

  /** Crea rama agentic/... desde origin/<base> en un worktree aislado. Nunca toca la rama base. */
  async createWorktree(repo: RepositoryConfig, missionId: string, base: string, branch: string): Promise<string> {
    if (!branch.startsWith("agentic/")) throw new GitError("Las ramas de misión deben empezar con agentic/", "");
    assertNotProtected(branch);
    const wt = path.join(paths.worktrees, missionId, repo.shortName);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await git(["worktree", "add", "-b", branch, wt, `origin/${base}`], this.repoPath(repo));
    // No rastrear la rama base: evita pushes accidentales hacia ella.
    await git(["branch", "--unset-upstream", branch], wt).catch(() => undefined);
    return wt;
  }

  async currentBranch(wt: string): Promise<string> {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], wt);
  }

  async status(wt: string): Promise<string> {
    return git(["status", "--porcelain"], wt);
  }

  async diffStat(wt: string): Promise<{ stat: string; files: string[]; patch: string }> {
    await git(["add", "-A", "--intent-to-add", "."], wt).catch(() => undefined);
    const stat = await git(["diff", "--stat"], wt);
    const names = await git(["diff", "--name-only"], wt);
    const patch = await git(["diff"], wt);
    return { stat, files: names.split(/\r?\n/).filter(Boolean), patch };
  }

  async commit(wt: string, message: string): Promise<string | null> {
    const branch = await this.currentBranch(wt);
    assertNotProtected(branch);
    if (!branch.startsWith("agentic/")) throw new GitError(`Commit bloqueado: rama inesperada ${branch}`, "");
    await git(["add", "-A"], wt);
    const staged = await git(["diff", "--cached", "--name-only"], wt);
    if (!staged.trim()) return null;
    const args = ["commit", "-m", message];
    // Identidad por defecto si el usuario no tiene git config global.
    const hasName = await run("git", ["config", "user.name"], { cwd: wt });
    if (hasName.code !== 0 || !hasName.stdout.trim()) args.unshift("-c", "user.name=LRD Agentic Office", "-c", "user.email=agentic-office@localhost");
    await git(args, wt);
    return git(["rev-parse", "HEAD"], wt);
  }

  async push(wt: string): Promise<string> {
    const branch = await this.currentBranch(wt);
    assertNotProtected(branch);
    if (!branch.startsWith("agentic/")) throw new GitError(`Push bloqueado: rama inesperada ${branch}`, "");
    await git(["push", "-u", "origin", `${branch}:${branch}`], wt, 5 * 60_000);
    return branch;
  }
}

export const gitManager = new GitWorktreeManager();
