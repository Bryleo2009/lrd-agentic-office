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

export async function cleanupOld(opts: { days?: number; dryRun?: boolean; isActive: (missionId: string) => boolean }): Promise<CleanupReport> {
  const days = opts.days ?? config.retentionDays;
  const dryRun = !!opts.dryRun;
  const report: CleanupReport = { dryRun, days, removed: [], kept: [], freedMb: 0 };
  if (days <= 0) return report;
  const limit = Date.now() - days * DAY;
  let prune = false;

  // 1) Worktrees
  const wtDirs = fs.existsSync(paths.worktrees) ? fs.readdirSync(paths.worktrees) : [];
  for (const id of wtDirs) {
    const dir = path.join(paths.worktrees, id);
    const m = repo.getMission(id);
    if (opts.isActive(id) || (m && !TERMINAL.has(m.status))) continue;
    if (lastTouch(m, dir) > limit) continue;
    let removedAll = true;
    for (const w of worktreesOf(m, dir)) {
      const dirty = await run("git", ["status", "--porcelain"], { cwd: w.wt, timeoutMs: 30_000 }).catch(() => null);
      if (dirty && dirty.code === 0 && dirty.stdout.trim()) {
        report.kept.push({ path: w.wt, reason: "tiene cambios sin commit" });
        removedAll = false;
        continue;
      }
      if (w.commitSha && !w.pushed) {
        report.kept.push({ path: w.wt, reason: "tiene un commit que no se publicó" });
        removedAll = false;
        continue;
      }
      const size = dirSize(w.wt);
      report.removed.push({ path: w.wt, missionId: m?.id ?? null, kind: "worktree", mb: mb(size) });
      report.freedMb += mb(size);
      if (!dryRun) {
        await run("git", ["worktree", "remove", "--force", w.wt], { cwd: w.wt, timeoutMs: 60_000 }).catch(() => undefined);
        fs.rmSync(w.wt, { recursive: true, force: true });
        prune = true;
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
    report.removed.push({ path: dir, missionId: m?.id ?? null, kind: "runs", mb: mb(size) });
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
