import fs from "node:fs";
import path from "node:path";
import type { CleanupReport, Mission } from "../shared/types";
import { config, loadRepositories, paths } from "./config";
import * as repo from "./database/repo";
import { gitManager } from "./integrations/git/GitWorktreeManager";
import { run } from "./runtime/processUtils";

/**
 * Limpieza de carpetas viejas: worktrees y logs crudos (runs/) de misiones terminadas hace más de
 * RETENTION_DAYS días. Nunca borra una misión en curso, un worktree con cambios sin commit ni uno
 * con commits que no se publicaron (se informan como "conservados"). Las ramas no se tocan.
 */

const TERMINAL = new Set<Mission["status"]>(["done", "failed", "cancelled"]);
const DAY = 86_400_000;

function dirSize(p: string, budget = { n: 60_000 }): number {
  let total = 0;
  const stack = [p];
  while (stack.length && budget.n-- > 0) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e));
      } catch {
        /* sin permiso */
      }
    } else total += st.size;
  }
  return total;
}
const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;

function lastTouch(m: Mission | null, dir: string): number {
  if (m) return new Date(m.updatedAt).getTime();
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Worktrees de una misión (uno por repo) con su estado de entrega. */
function worktreesOf(m: Mission | null, dir: string): { wt: string; pushed: boolean; commitSha: string | null }[] {
  let subs: string[] = [];
  try {
    subs = fs.readdirSync(dir).map((s) => path.join(dir, s));
  } catch {
    return [];
  }
  return subs.map((wt) => {
    const r = m?.repos.find((x) => x.worktree && path.resolve(x.worktree) === path.resolve(wt));
    const single = m && !m.repos.length && m.worktree && path.resolve(m.worktree) === path.resolve(wt);
    return { wt, pushed: r ? r.pushed : single ? m!.pushed : true, commitSha: r ? r.commitSha : single ? m!.commitSha : null };
  });
}

const git = (args: string[], cwd: string) => run("git", args, { cwd, timeoutMs: 120_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }) as { code: number; stdout: string; stderr: string });
/** Margen tras terminar una misión antes de borrar su carpeta por estar integrada (por si la quieres ajustar por chat). */
const MERGED_GRACE_MS = 60 * 60_000;

/**
 * ¿El trabajo de este worktree ya está en alguna de esas ramas (origin/<rama>)? Cubre merge normal (HEAD es
 * ancestro), rebase (git cherry: todos sus commits ya están, por contenido) y squash (los archivos que tocó la
 * misión están idénticos en la rama). Devuelve la rama o null.
 */
export async function mergedInto(wt: string, branches: string[]): Promise<string | null> {
  for (const b of [...new Set(branches)]) {
    const ref = `refs/remotes/origin/${b}`;
    if ((await git(["rev-parse", "--verify", "--quiet", ref], wt)).code !== 0) continue;
    if ((await git(["merge-base", "--is-ancestor", "HEAD", ref], wt)).code === 0) return b;
    const cherry = await git(["cherry", ref, "HEAD"], wt);
    if (cherry.code === 0 && cherry.stdout.split(/\r?\n/).filter(Boolean).every((l) => l.startsWith("-"))) return b;
    const mb = await git(["merge-base", "HEAD", ref], wt);
    if (mb.code !== 0) continue;
    const files = (await git(["diff", "--name-only", mb.stdout.trim(), "HEAD"], wt)).stdout.split(/\r?\n/).filter(Boolean);
    if (files.length && files.length <= 400 && (await git(["diff", "--quiet", "HEAD", ref, "--", ...files], wt)).code === 0) return b;
  }
  return null;
}

/** Repositorio y ramas de un worktree (worktrees/<misión>/<shortName>). */
function worktreeInfo(m: Mission | null, wt: string) {
  const short = path.basename(wt);
  const cfg = loadRepositories().repositories.find((r) => r.shortName === short) ?? null;
  const entry = m?.repos.find((x) => x.repositoryId === cfg?.id);
  const base = entry?.baseBranch ?? (m && !m.repos.length ? m.baseBranch : null);
  const branch = entry?.branch ?? (m && !m.repos.length ? m.branch : null);
  return { cfg, base, branch };
}

export async function cleanupOld(opts: { days?: number; dryRun?: boolean; isActive: (missionId: string) => boolean; merged?: boolean; graceMs?: number }): Promise<CleanupReport> {
  const days = opts.days ?? config.retentionDays;
  const merged = opts.merged ?? config.cleanupMerged;
  const dryRun = !!opts.dryRun;
  const report: CleanupReport = { dryRun, days, removed: [], kept: [], freedMb: 0 };
  if (days <= 0 && !merged) return report;
  const limit = days > 0 ? Date.now() - days * DAY : -Infinity;
  const { protectedBranches } = loadRepositories();
  const fetched = new Map<string, boolean>();
  let prune = false;

  // 1) Worktrees: los que ya están en una rama principal (a cualquier edad) y los muy viejos.
  const wtDirs = fs.existsSync(paths.worktrees) ? fs.readdirSync(paths.worktrees) : [];
  for (const id of wtDirs) {
    const dir = path.join(paths.worktrees, id);
    const m = repo.getMission(id);
    if (opts.isActive(id) || (m && !TERMINAL.has(m.status))) continue;
    const touched = lastTouch(m, dir);
    const old = touched <= limit;
    const canMerge = merged && touched <= Date.now() - (opts.graceMs ?? MERGED_GRACE_MS);
    if (!old && !canMerge) continue;
    let removedAll = true;
    for (const w of worktreesOf(m, dir)) {
      const dirty = await git(["status", "--porcelain"], w.wt);
      if (dirty.code === 0 && dirty.stdout.trim()) {
        if (old) report.kept.push({ path: w.wt, reason: "tiene cambios sin commit" });
        removedAll = false;
        continue;
      }
      // ¿Ya está en una rama principal? (la base de la misión, las protegidas y las bases permitidas del repo)
      const info = worktreeInfo(m, w.wt);
      let inBranch: string | null = null;
      if (canMerge && info.cfg) {
        if (!fetched.has(info.cfg.id)) fetched.set(info.cfg.id, await gitManager.fetch(info.cfg).then(() => true, () => false));
        inBranch = await mergedInto(w.wt, [...(info.base ? [info.base] : []), ...protectedBranches, ...info.cfg.allowedBases]);
      }
      if (!inBranch && !(old && (!w.commitSha || w.pushed))) {
        if (old) report.kept.push({ path: w.wt, reason: w.commitSha && !w.pushed ? "tiene un commit que no se publicó" : "aún no está en una rama principal" });
        removedAll = false;
        continue;
      }
      const size = dirSize(w.wt);
      const reason = inBranch ? `ya está en ${inBranch}` : `más de ${days} días`;
      report.removed.push({ path: w.wt, missionId: m?.id ?? null, kind: "worktree", mb: mb(size), reason });
      report.freedMb += mb(size);
      if (!dryRun) {
        const repoPath = info.cfg ? gitManager.repoPath(info.cfg) : null;
        await git(["worktree", "remove", "--force", w.wt], repoPath && fs.existsSync(repoPath) ? repoPath : w.wt);
        fs.rmSync(w.wt, { recursive: true, force: true });
        prune = true;
        // La rama local agentic/… ya integrada (y publicada: GitHub la conserva) también sobra.
        if (inBranch && repoPath && info.branch?.startsWith("agentic/") && w.pushed) await git(["branch", "-D", info.branch], repoPath);
      }
    }
    if (!dryRun && removedAll) fs.rmSync(dir, { recursive: true, force: true });
  }

  // 2) Logs crudos de los agentes (runs/<misión>)
  const runDirs = fs.existsSync(paths.runs) ? fs.readdirSync(paths.runs) : [];
  for (const id of runDirs) {
    const dir = path.join(paths.runs, id);
    const m = repo.getMission(id);
    if (opts.isActive(id) || (m && !TERMINAL.has(m.status))) continue;
    if (lastTouch(m, dir) > limit) continue;
    const size = dirSize(dir);
    report.removed.push({ path: dir, missionId: m?.id ?? null, kind: "runs", mb: mb(size), reason: `más de ${days} días` });
    report.freedMb += mb(size);
    if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
  }

  // 3) Git olvida los worktrees borrados (en cada repo que exista en esta PC).
  if (prune)
    for (const r of loadRepositories().repositories) {
      const p = gitManager.repoPath(r);
      if (fs.existsSync(p)) await run("git", ["worktree", "prune"], { cwd: p, timeoutMs: 60_000 }).catch(() => undefined);
    }
  report.freedMb = Math.round(report.freedMb * 10) / 10;
  return report;
}
