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

  /**
   * Worktree aislado en HEAD separado (detached) sobre origin/<base>: no crea ninguna rama.
   * La rama solo se crea si los agentes realmente modifican archivos (ver createBranch).
   */
  async createWorktree(repo: RepositoryConfig, missionId: string, base: string): Promise<string> {
    const wt = path.join(paths.worktrees, missionId, repo.shortName);
    // Misión retomada tras un reinicio: se reutiliza el worktree con el trabajo que ya tenía.
    if (fs.existsSync(wt)) {
      const ok = await git(["rev-parse", "--is-inside-work-tree"], wt).then(
        (v) => v === "true",
        () => false,
      );
      if (ok) return wt;
      fs.rmSync(wt, { recursive: true, force: true });
      await git(["worktree", "prune"], this.repoPath(repo)).catch(() => undefined);
    }
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await git(["worktree", "add", "--detach", wt, `origin/${base}`], this.repoPath(repo));
    return wt;
  }

  /** Commits del worktree que aún no están en origin/<base> (p. ej. un commit que no alcanzó a publicarse). */
  async aheadOf(wt: string, base: string): Promise<number> {
    const n = await git(["rev-list", "--count", `origin/${base}..HEAD`], wt).catch(() => "0");
    return Number(n) || 0;
  }

  async localBranchExists(wt: string, branch: string): Promise<boolean> {
    return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], wt).then(
      () => true,
      () => false,
    );
  }

  async headSha(wt: string): Promise<string> {
    return git(["rev-parse", "HEAD"], wt);
  }

  /** Crea la rama agentic/... en el worktree (con los cambios ya presentes). Nunca toca la rama base. */
  async createBranch(wt: string, branch: string): Promise<void> {
    if (!branch.startsWith("agentic/")) throw new GitError("Las ramas de misión deben empezar con agentic/", "");
    assertNotProtected(branch);
    await git(["switch", "-c", branch], wt);
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

  /** Todo lo que se publicaría respecto a origin/<base>: commits de la misión + cambios sin commit. */
  async diffFromBase(wt: string, base: string): Promise<{ files: string[]; patch: string }> {
    await git(["add", "-A", "--intent-to-add", "."], wt).catch(() => undefined);
    const names = await git(["diff", "--name-only", `origin/${base}`], wt).catch(() => "");
    const patch = await git(["diff", `origin/${base}`], wt).catch(() => "");
    return { files: names.split(/\r?\n/).filter(Boolean), patch };
  }

  /** `targetBranch` solo para commits directos sobre una rama base no protegida (HEAD separado). */
  async commit(wt: string, message: string, targetBranch?: string): Promise<string | null> {
    const branch = targetBranch ?? (await this.currentBranch(wt));
    assertNotProtected(branch);
    if (!targetBranch && !branch.startsWith("agentic/")) throw new GitError(`Commit bloqueado: rama inesperada ${branch}`, "");
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

  async push(wt: string, targetBranch?: string): Promise<string> {
    const branch = targetBranch ?? (await this.currentBranch(wt));
    assertNotProtected(branch);
    if (!targetBranch && !branch.startsWith("agentic/")) throw new GitError(`Push bloqueado: rama inesperada ${branch}`, "");
    // Directo en la rama base (pedido explícitamente): HEAD → base, solo fast-forward; nunca --force.
    const pushArgs = targetBranch ? ["push", "origin", `HEAD:refs/heads/${branch}`] : ["push", "-u", "origin", `${branch}:${branch}`];
    try {
      await git(pushArgs, wt, 5 * 60_000);
    } catch (e) {
      const out = e instanceof GitError ? `${e.message}\n${e.output}` : String(e);
      if (!/non-fast-forward|fetch first|\[rejected\]|updates were rejected/i.test(out)) throw e;
      // La rama remota avanzó (otro intento o alguien más publicó): se integran esos commits y se reintenta.
      // Nunca --force: si hay conflicto, se deja todo como estaba y se informa.
      await git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], wt, 5 * 60_000);
      const r = await run("git", ["-c", "user.name=LRD Agentic Office", "-c", "user.email=agentic-office@localhost", "rebase", `origin/${branch}`], { cwd: wt, timeoutMs: 120_000 });
      if (r.code !== 0) {
        await run("git", ["rebase", "--abort"], { cwd: wt, timeoutMs: 60_000 });
        throw new GitError(`No se pudo publicar ${branch}: la rama remota tiene cambios que chocan con los de la misión (conflicto al integrarlos)`, tail(`${r.stderr}\n${r.stdout}`, 2000));
      }
      await git(pushArgs, wt, 5 * 60_000);
    }
    return branch;
  }

  /** ¿Existe la rama en GitHub? (consulta real al remoto; las referencias locales pueden estar viejas) */
  async remoteHasBranch(wt: string, branch: string): Promise<boolean> {
    const out = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], wt, 60_000).catch(() => "");
    return out.trim().length > 0;
  }
}

export const gitManager = new GitWorktreeManager();
