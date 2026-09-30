import { customAlphabet } from "nanoid";
import type { AgentRuntimeEvent } from "../../shared/events";
import fs from "node:fs";
import path from "node:path";
import { isToolMcp, MULTI_REPO_SEP, NO_REPO, type AgentId, type EngineChoice, type Mission, type MissionRepo, type MissionStep, type Provider, type RepositoryConfig } from "../../shared/types";
import { config, loadRepositories, paths } from "../config";
import * as repo from "../database/repo";
import { eventBus } from "../events/AgentEventBus";
import { gitManager, GitError, isProtected, slugify } from "../integrations/git/GitWorktreeManager";
import { github } from "../integrations/github/GitHubAdapter";
import { MissionDagExecutor } from "../missions/MissionDagExecutor";
import { buildPlannerPrompt, deliveryPrefs, inferArea, inferRepo, isAnalysisOnly, mcpRules, parsePlan, rulesPlan, type MissionPlan } from "../missions/MissionPlanner";
import { detectQa, runShell } from "../missions/qa";
import type { ExecutorEvent, PermissionProfile } from "../runtime/AgentExecutor";
import { firstLine } from "../runtime/parsers/common";
import { commandExitReason } from "../runtime/humanize";
import { runtime } from "../runtime/RuntimeDetector";
import { messageBus, type Handoff } from "./AgentMessageBus";
import { sessions } from "./AgentSession";
import { profile as getAgent, team } from "../settings";

const missionIdGen = customAlphabet("0123456789ABCDEF", 5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ejecuta `fn` sobre cada elemento con como máximo `limit` a la vez; conserva el orden de resultados. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface CreateMissionInput {
  prompt: string;
  /** Id, "auto" (lo decide el sistema) o "none" (sin repositorio: análisis/datos). Opcional. */
  repositoryId?: string | null;
  /** Opcional: por defecto la rama base configurada del repo. */
  baseBranch?: string | null;
  engine?: EngineChoice;
  /** Permitir datos reales vía MCP (sólo lectura). */
  allowMcp?: boolean;
  /** Qué servidores MCP habilitar (por defecto, los que son fuentes de datos). */
  mcpServers?: string[];
}

/** Repositorio en el que trabaja la misión, con su worktree. */
interface WorkRepo {
  cfg: RepositoryConfig;
  base: string;
  wt: string;
}

interface MissionRuntime {
  cancelled: boolean;
  /** Comandos de QA en curso (pueden ser varios en paralelo): se matan al cancelar. */
  qaSignals: Set<{ cancelled: boolean; kill?: () => void }>;
  /** Último agente que editó cada repositorio (recibe las fallas de QA de ese repo). */
  lastWriter: Map<string, AgentId>;
  repos: Map<string, WorkRepo>;
  /** Pasos que se cortaron por un reinicio del servidor y se vuelven a ejecutar. */
  restarted: Set<string>;
}

const newRuntime = (): MissionRuntime => ({ cancelled: false, qaSignals: new Set(), lastWriter: new Map(), repos: new Map(), restarted: new Set() });

export class MissionError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

/**
 * Ciclo de vida completo de una misión real:
 * git fetch → worktree + rama agentic → plan (Atlas) → DAG de agentes → QA real (Vega)
 * → revisión (Atlas) → commit → push/PR (sólo con flags).
 */
export class AgentOrchestrator {
  private active = new Map<string, MissionRuntime>();

  /** Nombres de servidores MCP habilitados en el motor dado. */
  private mcpNames(provider: Provider): string[] {
    return (runtime.snapshot().find((s) => s.provider === provider)?.mcpServers ?? []).filter((m) => m.enabled).map((m) => m.name);
  }

  private repoConfig(id: string): RepositoryConfig {
    const r = loadRepositories().repositories.find((x) => x.id === id);
    if (!r) throw new MissionError(`Repositorio desconocido: ${id}`);
    if (!r.enabled) throw new MissionError(`Repositorio ${id} deshabilitado en config/repositories.json`);
    return r;
  }

  private emit(missionId: string, agentId: AgentId | null, e: Omit<Parameters<typeof eventBus.publish>[0], "missionId" | "agentId">) {
    return eventBus.publish({ ...e, missionId, agentId });
  }

  private pushMission(id: string): Mission | null {
    const m = repo.getMission(id);
    if (m) eventBus.broadcast({ kind: "mission", mission: m });
    return m;
  }

  private setMission(id: string, patch: Parameters<typeof repo.updateMission>[1]): void {
    repo.updateMission(id, patch);
    this.pushMission(id);
  }

  private setStep(missionId: string, step: MissionStep, patch: Partial<MissionStep>): void {
    Object.assign(step, patch);
    repo.updateStep(step.id, patch);
    this.pushMission(missionId);
  }

  isAgentBusy(agentId: AgentId): boolean {
    for (const [mid] of this.active) {
      const m = repo.getMission(mid);
      if (m?.steps.some((s) => s.agentId === agentId && s.status === "running")) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  async createMission(input: CreateMissionInput): Promise<Mission> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new MissionError("La misión está vacía");
    const engine: EngineChoice = input.engine ?? "auto";
    await runtime.detect();
    const provider = runtime.resolve(engine);
    if (!runtime.isUsable(provider)) {
      const st = runtime.snapshot().find((s) => s.provider === provider);
      throw new MissionError(`${st?.label ?? provider} no disponible: ${st?.message ?? "sin detalle"}. No se usará API como alternativa.`, 409);
    }
    const mcp = this.mcpNames(provider);
    const wanted = Array.isArray(input.mcpServers) ? input.mcpServers.filter((n) => mcp.includes(n)) : mcp.filter((n) => !isToolMcp(n));
    const mcpServers = input.allowMcp ? wanted : [];
    const allowMcp = mcpServers.length > 0;
    const requested = (input.repositoryId ?? "").trim();
    const repoSelection: Mission["repoSelection"] = requested && requested !== "auto" ? "manual" : "auto";
    let repoReason = "";
    let repoId = requested;
    if (repoSelection === "auto") {
      const pick = inferRepo(prompt, loadRepositories().repositories, allowMcp);
      repoId = pick.id;
      repoReason = pick.reason;
    }
    const rs = repoId === NO_REPO ? [] : [...new Set(repoId.split(MULTI_REPO_SEP).map((x) => x.trim()).filter(Boolean))].map((x) => this.repoConfig(x));
    const r = rs[0] ?? null;
    // Una rama base elegida aplica a todos los repos (debe estar permitida en cada uno); si no, la de cada repo.
    const baseFor = (x: RepositoryConfig) => input.baseBranch || x.defaultBase;
    for (const x of rs) if (!x.allowedBases.includes(baseFor(x))) throw new MissionError(`Rama base no permitida en ${x.name}: ${baseFor(x)}`);
    const base = r ? baseFor(r) : "";
    const repos: MissionRepo[] =
      rs.length > 1 ? rs.map((x) => ({ repositoryId: x.id, baseBranch: baseFor(x), worktree: null, branch: null, commitSha: null, pushed: false, prUrl: null })) : [];
    const id = missionIdGen();
    const area = inferArea(prompt, r);
    const now = new Date().toISOString();
    const mission: Mission = {
      id,
      prompt,
      repositoryId: r?.id ?? NO_REPO,
      repoSelection,
      allowMcp,
      mcpServers,
      baseBranch: base,
      engine,
      provider,
      area,
      // La rama se crea solo si hay cambios al final de la misión (ver commit).
      branch: null,
      worktree: null,
      status: "created",
      error: null,
      commitSha: null,
      pushed: false,
      prUrl: null,
      summary: null,
      planSource: null,
      repos,
      createdAt: now,
      updatedAt: now,
      steps: [],
    };
    repo.insertMission(mission);
    this.emit(id, "atlas", { provider: "system", sessionId: null, type: "MISSION_CREATED", title: `Nueva misión ${id}`, detail: prompt, status: "info", metadata: { repositoryId: r?.id ?? NO_REPO, base, provider, repoSelection, allowMcp } });
    if (repoSelection === "auto")
      this.emit(id, "atlas", {
        provider: "system",
        sessionId: null,
        type: "AGENT_STATUS",
        title: rs.length > 1 ? `Repositorios elegidos: ${rs.map((x) => x.name).join(" + ")} (en paralelo)` : r ? `Repositorio elegido: ${r.name} (${base})` : "Misión sin repositorio (análisis / datos)",
        detail: `Selección automática: ${repoReason}.`,
        status: "info",
      });
    if (allowMcp) this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Datos reales vía MCP: ${mcpServers.join(", ")} (sólo lectura)`, status: "warning" });
    this.pushMission(id);
    const rt = newRuntime();
    this.active.set(id, rt);
    void this.run(id, rs, rt).finally(() => this.active.delete(id));
    return repo.getMission(id)!;
  }

  /**
   * Al arrancar el servidor: retoma las misiones que quedaron en curso. Los pasos terminados se
   * conservan y los que se cortaron se repiten. Tras varios reinicios seguidos se da por fallida
   * (evita un bucle si es la propia misión la que tumba el servidor).
   */
  async resumeInterrupted(): Promise<string[]> {
    const ids = repo.interruptedMissionIds().filter((id) => !this.active.has(id));
    if (!ids.length) return [];
    await runtime.detect().catch(() => undefined);
    const resumed: string[] = [];
    for (const id of ids) {
      const m = repo.getMission(id);
      if (!m) continue;
      const n = repo.bumpResume(id);
      if (n > config.maxResumes) {
        this.setMission(id, { status: "failed", error: `La misión se interrumpió ${n} veces por reinicios del servidor; no se retoma automáticamente.` });
        for (const s of m.steps) if (s.status === "pending" || s.status === "running") this.setStep(id, s, { status: "cancelled" });
        this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_BLOCKED", title: "Misión detenida: demasiados reinicios", detail: "Vuelve a lanzarla cuando el servidor esté estable.", status: "error", metadata: { missionFailed: true } });
        continue;
      }
      let rs: RepositoryConfig[];
      try {
        const repoIds = m.repos.length ? m.repos.map((r) => r.repositoryId) : m.repositoryId === NO_REPO ? [] : [m.repositoryId];
        rs = repoIds.map((r) => this.repoConfig(r));
      } catch (e) {
        this.setMission(id, { status: "failed", error: `No se pudo retomar: ${(e as Error).message}` });
        continue;
      }
      this.emit(id, "atlas", {
        provider: "system",
        sessionId: null,
        type: "AGENT_STATUS",
        title: "Retomando la misión tras reiniciar el servidor",
        detail: `Intento ${n} de ${config.maxResumes}. Lo que el equipo ya terminó se conserva.`,
        status: "info",
        metadata: { resumed: true },
      });
      const rt = newRuntime();
      this.active.set(id, rt);
      void this.run(id, rs, rt).finally(() => this.active.delete(id));
      resumed.push(id);
    }
    return resumed;
  }

  async cancelMission(id: string): Promise<void> {
    const rt = this.active.get(id);
    if (!rt) throw new MissionError("La misión no está en ejecución", 404);
    rt.cancelled = true;
    for (const s of rt.qaSignals) {
      s.cancelled = true;
      s.kill?.();
    }
    await sessions.cancelMission(id);
    this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: "Misión cancelada por el usuario", status: "warning" });
  }

  // ------------------------------------------------------------------
  private async run(id: string, rs: RepositoryConfig[], rt: MissionRuntime): Promise<void> {
    const mission = repo.getMission(id)!;
    try {
      if (!rs.length) return await this.runWithoutRepo(id, mission, rt);
      const multi = rs.length > 1;
      const baseOf = (r: RepositoryConfig) => mission.repos.find((x) => x.repositoryId === r.id)?.baseBranch ?? mission.baseBranch;

      // 1) Git: fetch + worktree por repositorio (en paralelo; sin ramas todavía)
      this.setMission(id, { status: "preparing" });
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "AGENT_STARTED", title: multi ? `Preparando ${rs.length} espacios de trabajo (${rs.map((r) => r.name).join(" + ")})` : "Preparando espacio de trabajo", status: "running" });
      await Promise.all(
        rs.map(async (r) => {
          const base = baseOf(r);
          const repoPath = await gitManager.ensureClone(r);
          repo.upsertRepository({ id: r.id, name: r.name, github: r.github, cloneUrl: r.cloneUrl, localPath: repoPath });
          this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_FETCH", title: `git fetch origin (${r.name})`, command: "git fetch origin --prune", status: "running" });
          await gitManager.fetch(r);
          repo.upsertRepository({ id: r.id, name: r.name, github: r.github, cloneUrl: r.cloneUrl, localPath: repoPath, lastFetchAt: new Date().toISOString() });
          if (!(await gitManager.remoteBranchExists(r, base))) throw new GitError(`La rama base origin/${base} no existe en ${r.github}`, "");
          const wt = await gitManager.createWorktree(r, id, base);
          rt.repos.set(r.id, { cfg: r, base, wt });
          this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_WORKTREE", title: `Worktree aislado listo${multi ? ` · ${r.name}` : ""} (sin rama)`, detail: `${wt}\nCopia de origin/${base}; la rama solo se crea si hay cambios.`, status: "success", metadata: { worktree: wt, base, repositoryId: r.id } });
        }),
      );
      const primary = rt.repos.get(rs[0].id)!;
      this.setMission(id, { worktree: primary.wt, ...(multi ? { repos: mission.repos.map((x) => ({ ...x, worktree: rt.repos.get(x.repositoryId)?.wt ?? null })) } : {}) });
      if (rt.cancelled) throw new MissionError("Cancelada");

      // 2) Plan real con Atlas (o el que ya existía, si la misión se retoma) → 3) pasos del DAG
      const steps = await this.prepareSteps(id, mission, rs, primary.wt, rt);
      if (rt.cancelled) throw new MissionError("Cancelada");

      const dag = new MissionDagExecutor(steps, {
        isCancelled: () => rt.cancelled,
        onSkip: (s, reason) => this.setStep(id, s, { status: "skipped", error: reason }),
        run: (s) => this.runStep(id, s, steps, rt),
      });
      const { failed } = await dag.execute();
      if (rt.cancelled) throw new MissionError("Cancelada");
      if (failed.length) {
        const f = failed[0];
        throw new MissionError(`${getAgent(f.agentId).name} no pudo completar "${f.title}": ${f.error ?? "error"}`);
      }

      // 4) Rama + commit + publicación por repositorio (orquestador, nunca la IA). Sin cambios → sin rama.
      this.setMission(id, { status: "committing" });
      const prefs = deliveryPrefs(mission.prompt);
      const results: MissionRepo[] = [];
      for (const r of rs) results.push(await this.deliverRepo(id, mission, rt.repos.get(r.id)!, steps, rt, prefs, multi));
      const main = results.find((x) => x.commitSha) ?? results[0];
      this.setMission(id, {
        branch: main.branch,
        commitSha: main.commitSha,
        pushed: main.pushed,
        prUrl: main.prUrl,
        ...(multi ? { repos: results } : {}),
      });
      if (!results.some((x) => x.commitSha)) this.emit(id, "atlas", { provider: "git", sessionId: null, type: "AGENT_STATUS", title: "Sin cambios: no se crea rama ni commit", status: "info" });

      this.setMission(id, { status: "done" });
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_FINISHED", title: `Misión ${id} completada`, detail: repo.getMission(id)?.summary ?? null, status: "success", metadata: { missionDone: true, sha: main.commitSha, branch: main.branch } });
    } catch (e) {
      const err = e as Error;
      const cancelled = rt.cancelled;
      const detail = err instanceof GitError && err.output ? `${err.message}\n${err.output}` : err.message;
      this.setMission(id, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "Cancelada por el usuario" : detail });
      const m = repo.getMission(id);
      for (const s of m?.steps ?? []) if (s.status === "pending" || s.status === "running") this.setStep(id, s, { status: "cancelled" });
      this.emit(id, "atlas", {
        provider: "system",
        sessionId: null,
        type: cancelled ? "AGENT_STATUS" : "AGENT_BLOCKED",
        title: cancelled ? "Misión cancelada" : `Misión bloqueada: ${firstLine(err.message, 90)}`,
        detail,
        status: cancelled ? "warning" : "error",
        metadata: { missionFailed: !cancelled },
      });
    }
  }

  /** Commit + rama nueva + publicación de UN repositorio de la misión (si tiene cambios). */
  private async deliverRepo(id: string, mission: Mission, w: WorkRepo, steps: MissionStep[], rt: MissionRuntime, prefs: { publish: boolean; directToBase: boolean }, multi: boolean): Promise<MissionRepo> {
    const out: MissionRepo = { repositoryId: w.cfg.id, baseBranch: w.base, worktree: w.wt, branch: null, commitSha: null, pushed: false, prUrl: null };
    const status = await gitManager.status(w.wt);
    // Si la misión se retoma, puede que la rama o el commit ya existan (el reinicio fue a mitad de la entrega).
    const current = await gitManager.currentBranch(w.wt).catch(() => "HEAD");
    const onBranch = current.startsWith("agentic/");
    const pending = !status.trim() && (onBranch || (await gitManager.aheadOf(w.wt, w.base)) > 0);
    if (!status.trim() && !pending) {
      if (multi) this.emit(id, "atlas", { provider: "git", sessionId: null, type: "AGENT_STATUS", title: `${w.cfg.name}: sin cambios, no se crea rama`, status: "info" });
      return out;
    }
    const tag = multi ? ` (${w.cfg.name})` : "";
    const direct = !onBranch && prefs.directToBase && !isProtected(w.base);
    if (prefs.directToBase && !direct && !onBranch)
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `${w.base} está protegida${tag}: se usa una rama nueva`, status: "warning" });
    const branch = onBranch ? current : direct ? w.base : `agentic/${mission.area}/${slugify(mission.prompt)}-${id}`;
    if (!direct && !onBranch) {
      await gitManager.createBranch(w.wt, branch);
      repo.insertBranch({ repositoryId: w.cfg.id, missionId: id, name: branch, base: w.base, worktree: w.wt });
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_BRANCH", title: `Rama ${branch}${tag}`, detail: `desde origin/${w.base}`, status: "success", metadata: { branch, base: w.base, repositoryId: w.cfg.id } });
    }
    out.branch = branch;
    const mine = steps.filter((s) => s.writes && s.status === "done" && (s.repositoryId ?? w.cfg.id) === w.cfg.id);
    const agents = [...new Set(mine.map((s) => getAgent(s.agentId).name))];
    const msg = `${mission.area}: ${firstLine(mission.prompt, 60)}\n\nMisión ${id} · LRD Agentic Office\nAgentes: ${agents.join(", ") || "—"}\nMotor: ${mission.provider}\nBase: ${w.base}`;
    const sha = status.trim() ? await gitManager.commit(w.wt, msg, direct ? branch : undefined) : await gitManager.headSha(w.wt);
    if (!sha) return out;
    out.commitSha = sha;
    repo.insertDelivery({ missionId: id, kind: "commit", ref: sha });
    const writer = rt.lastWriter.get(w.cfg.id) ?? (w.cfg.kind === "frontend" ? "mica" : "diego");
    this.emit(id, writer, { provider: "git", sessionId: null, type: "GIT_COMMIT", title: `Commit ${sha.slice(0, 7)}${tag}`, detail: msg, status: "success", metadata: { sha, branch, repositoryId: w.cfg.id } });

    if (!(config.githubPushEnabled && prefs.publish)) {
      const why = prefs.publish ? "GITHUB_PUSH_ENABLED=false" : "la misión pidió no publicar";
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Rama sin publicar${tag} (${why})`, detail: `Rama local: ${branch}`, status: "info" });
      return out;
    }
    await gitManager.push(w.wt, direct ? branch : undefined);
    out.pushed = true;
    repo.insertDelivery({ missionId: id, kind: "push", ref: `${w.cfg.id}:${branch}` });
    this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_PUSH", title: `Rama publicada${tag}: ${branch}`, detail: direct ? null : `Lista para evaluación contra ${w.base}`, status: "success", metadata: { branch, repositoryId: w.cfg.id } });
    if (config.githubPrEnabled && !direct) {
      const summary = repo.getMission(id)?.summary ?? "";
      const url = await github.createPr(w.wt, {
        base: w.base,
        head: branch,
        title: `[agentic] ${firstLine(mission.prompt, 70)}`,
        body: `${summary}\n\n---\nMisión \`${id}\` generada por LRD Agentic Office (${mission.provider}).`,
      });
      out.prUrl = url;
      repo.insertDelivery({ missionId: id, kind: "pr", ref: url });
      const num = url.match(/\/pull\/(\d+)/)?.[1];
      this.emit(id, "atlas", { provider: "github", sessionId: null, type: "PR_CREATED", title: `${num ? `PR #${num} creado` : "PR creado"}${tag}`, detail: url, status: "success", metadata: { url, repositoryId: w.cfg.id } });
    }
    return out;
  }

  /** Misión sin repositorio: análisis / datos (MCP). Sin git, sin QA, sin commit. */
  private async runWithoutRepo(id: string, mission: Mission, rt: MissionRuntime): Promise<void> {
    const cwd = path.join(paths.runs, id, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const steps = await this.prepareSteps(id, mission, [], cwd, rt, true);
    const dag = new MissionDagExecutor(steps, {
      isCancelled: () => rt.cancelled,
      onSkip: (s, reason) => this.setStep(id, s, { status: "skipped", error: reason }),
      run: (s) => this.runStep(id, s, steps, rt, cwd),
    });
    const { failed } = await dag.execute();
    if (rt.cancelled) throw new MissionError("Cancelada");
    if (failed.length) throw new MissionError(`${getAgent(failed[0].agentId).name} no pudo completar "${failed[0].title}": ${failed[0].error ?? "error"}`);
    this.setMission(id, { status: "done" });
    this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_FINISHED", title: `Misión ${id} completada`, detail: repo.getMission(id)?.summary ?? null, status: "success", metadata: { missionDone: true } });
  }

  /**
   * Plan + pasos de la misión. Si la misión se retoma tras un reinicio, reutiliza lo que ya había:
   * pasos terminados se conservan; los que quedaron a medias vuelven a "pendiente" y se repiten.
   */
  private async prepareSteps(id: string, mission: Mission, rs: RepositoryConfig[], cwd: string, rt: MissionRuntime, noRepo = false): Promise<MissionStep[]> {
    const existing = repo.getMission(id)?.steps ?? [];
    const rest = existing.filter((s) => s.kind !== "plan");
    if (rest.length) {
      for (const s of rest) {
        if (s.status === "running" || s.status === "cancelled") {
          rt.restarted.add(s.id);
          this.setStep(id, s, { status: "pending", error: null });
        }
        if (s.writes && s.status === "done") rt.lastWriter.set(s.repositoryId ?? rs[0]?.id ?? "", s.agentId);
      }
      this.setMission(id, { status: "running" });
      const done = rest.filter((s) => s.status === "done").length;
      this.emit(id, "atlas", {
        provider: "system",
        sessionId: null,
        type: "AGENT_STATUS",
        title: `Retomando la misión: ${done} paso(s) ya terminados, ${rest.length - done} por hacer`,
        detail: rest.map((s) => `• ${getAgent(s.agentId).name}: ${s.title} — ${s.status === "done" ? "hecho" : rt.restarted.has(s.id) ? "se repite (quedó a medias)" : "pendiente"}`).join("\n"),
        status: "info",
      });
      return rest;
    }

    this.setMission(id, { status: "planning" });
    let planStep = existing.find((s) => s.kind === "plan");
    if (!planStep) {
      planStep = this.newStep(id, "plan", "atlas", "Planificar misión", mission.prompt, [], false, "plan");
      repo.addStep(planStep, 0);
    }
    // Si Atlas ya había planificado antes del reinicio, se reutiliza su plan.
    let plan = planStep.status === "done" && planStep.result ? parsePlan(planStep.result, mission.prompt, rs) : null;
    if (!plan) plan = await this.plan(id, rs, cwd, mission, planStep, rt);
    if (rt.cancelled) throw new MissionError("Cancelada");
    if (noRepo) {
      plan.deliverable = "analysis";
      for (const s of plan.steps) s.writes = false;
    }
    const steps = this.materializePlan(id, plan, mission, rs);
    steps.forEach((s, i) => repo.addStep(s, i + 1));
    this.setMission(id, { status: "running", planSource: plan.source });
    const multi = rs.length > 1;
    const repoTag = (s: MissionStep) => (multi && s.repositoryId ? ` [${rs.find((x) => x.id === s.repositoryId)?.shortName ?? s.repositoryId}]` : "");
    this.emit(id, "atlas", {
      provider: plan.source === "ai" ? mission.provider : "system",
      sessionId: null,
      type: "PLAN_CREATED",
      title: `Plan: ${steps.filter((s) => s.kind === "agent").map((s) => `${getAgent(s.agentId).name}${repoTag(s)}`).join(" → ")}`,
      detail: steps.map((s) => `• ${getAgent(s.agentId).name}${repoTag(s)}: ${s.title}${s.dependsOn.length ? ` (tras ${s.dependsOn.join(", ")})` : ""}`).join("\n"),
      status: "success",
      metadata: { source: plan.source, note: plan.note ?? null, noRepo, steps: steps.map((s) => ({ id: s.id, agent: s.agentId, title: s.title, dependsOn: s.dependsOn, kind: s.kind, repositoryId: s.repositoryId ?? null })) },
    });
    return steps;
  }

  private newStep(missionId: string, id: string, agentId: AgentId, title: string, task: string, dependsOn: string[], writes: boolean, kind: MissionStep["kind"], repositoryId: string | null = null): MissionStep {
    return { id: `${missionId}-${id}`, missionId, agentId, title, task, dependsOn: dependsOn.map((d) => `${missionId}-${d}`), writes, kind, status: "pending", provider: null, sessionId: null, result: null, error: null, startedAt: null, finishedAt: null, repositoryId };
  }

  private materializePlan(missionId: string, plan: MissionPlan, mission: Mission, rs: RepositoryConfig[]): MissionStep[] {
    const multi = rs.length > 1;
    const steps = plan.steps.map((s) => this.newStep(missionId, s.id, s.agent, s.title, s.task, s.dependsOn, s.writes, "agent", multi ? s.repo ?? rs[0].id : null));
    const short = (s: MissionStep) => s.id.replace(`${missionId}-`, "");
    const leaves = steps.filter((s) => !steps.some((o) => o.dependsOn.includes(s.id))).map(short);
    // QA por cada repositorio con cambios: los de repos distintos corren en paralelo.
    const writeRepos = [...new Set(steps.filter((s) => s.writes).map((s) => s.repositoryId ?? null))];
    if (writeRepos.length) {
      const qaIds: string[] = [];
      for (const rid of writeRepos) {
        const cfg = rs.find((x) => x.id === rid);
        const qid = multi && cfg ? `qa-${cfg.shortName}` : "qa";
        const own = steps.filter((s) => s.kind === "agent" && (s.repositoryId ?? null) === rid).map(short);
        qaIds.push(qid);
        steps.push(this.newStep(missionId, qid, "vega", multi && cfg ? `QA ${cfg.name}: build y pruebas` : "QA: build y pruebas reales", "Ejecutar build/tests del repositorio", own, false, "qa", rid));
      }
      const untouched = leaves.filter((l) => !writeRepos.includes(steps.find((s) => short(s) === l)?.repositoryId ?? null));
      steps.push(this.newStep(missionId, "review", "atlas", "Revisión final del diff", mission.prompt, [...qaIds, ...untouched], false, "review"));
    } else {
      steps.push(this.newStep(missionId, "review", "atlas", "Consolidar hallazgos", mission.prompt, leaves, false, "review"));
    }
    return steps;
  }

  // ------------------------------------------------------------------
  private async plan(id: string, rs: RepositoryConfig[], wt: string, mission: Mission, step: MissionStep, rt: MissionRuntime): Promise<MissionPlan> {
    const r = rs[0] ?? null;
    const multi = rs.length > 1 ? rs.map((x) => ({ repo: x, base: rt.repos.get(x.id)?.base ?? mission.baseBranch, worktree: rt.repos.get(x.id)?.wt ?? "" })) : [];
    const provider = runtime.forAgent("atlas", mission.provider, mission.engine);
    this.setStep(id, step, { status: "running", provider, startedAt: new Date().toISOString() });
    this.emit(id, "atlas", { provider, sessionId: null, type: "AGENT_STATUS", title: "Planificando la misión", status: "running", metadata: { visual: "THINKING" } });
    const res = await this.runAgent(id, "atlas", provider, wt, "read-only", buildPlannerPrompt(mission.prompt, r, mission.baseBranch, team(), mission.mcpServers, multi), "Planificar", rt, step);
    if (!res.ok) {
      this.setStep(id, step, { status: "failed", error: res.error, finishedAt: new Date().toISOString() });
      throw new MissionError(`Atlas no pudo planificar: ${res.error}`);
    }
    let plan = parsePlan(res.text, mission.prompt, rs);
    if (!plan) {
      plan = rulesPlan(mission.prompt, r, mission.area, rs);
      plan.note = "Atlas no devolvió un JSON de plan válido; se aplicó el plan base por reglas.";
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: "Plan base por reglas", detail: plan.note, status: "warning" });
    }
    this.setStep(id, step, { status: "done", result: res.text.slice(0, 8000), finishedAt: new Date().toISOString() });
    return plan;
  }

  /** Ejecuta un paso del DAG según su tipo. */
  /** Worktree del paso: el de su repositorio (o el principal). */
  private workOf(rt: MissionRuntime, step: MissionStep): WorkRepo | null {
    if (step.repositoryId && rt.repos.has(step.repositoryId)) return rt.repos.get(step.repositoryId)!;
    return rt.repos.values().next().value ?? null;
  }

  private async runStep(id: string, step: MissionStep, all: MissionStep[], rt: MissionRuntime, noRepoCwd?: string): Promise<void> {
    if (rt.cancelled) return;
    const w = this.workOf(rt, step);
    const wt = w?.wt ?? noRepoCwd!;
    // Entregar handoffs reales de las dependencias
    await this.deliverHandoffs(id, step, all);
    if (step.kind === "qa" && w) return this.runQaStep(id, w, step, rt);
    if (step.kind === "review") return this.runReviewStep(id, wt, step, all, rt);

    const mission = repo.getMission(id)!;
    const provider = runtime.forAgent(step.agentId, mission.provider, mission.engine);
    this.setStep(id, step, { status: "running", provider, startedAt: new Date().toISOString() });
    const inbound = messageBus.take(id, step.agentId);
    const prompt = this.agentPrompt(mission, step, inbound, w, rt);
    const res = await this.runAgent(id, step.agentId, provider, wt, step.writes ? "workspace-write" : "read-only", prompt, step.title, rt, step);
    if (res.ok) {
      if (step.writes && w) rt.lastWriter.set(w.cfg.id, step.agentId);
      this.setStep(id, step, { status: "done", result: res.text.slice(0, 20000), finishedAt: new Date().toISOString() });
    } else {
      this.setStep(id, step, { status: "failed", error: res.error, finishedAt: new Date().toISOString() });
    }
  }

  private async deliverHandoffs(id: string, step: MissionStep, all: MissionStep[]): Promise<void> {
    const deps = all.filter((d) => step.dependsOn.includes(d.id) && d.status === "done" && d.result);
    const fromOthers = deps.filter((d) => d.agentId !== step.agentId);
    if (!fromOthers.length) {
      // mismo agente: el contexto ya vive en su sesión; aún así se inyecta en el prompt
      for (const d of deps) messageBus.handoff(id, d.agentId, step.agentId, summaryLine(d.result!), d.result!);
      return;
    }
    const senders = [...new Set(fromOthers.map((d) => d.agentId))];
    if (senders.length >= 2 || step.kind === "review") {
      const participants = [...new Set([...senders, step.agentId])];
      const meetingId = messageBus.meeting(id, participants, `Reunión: ${step.title}`);
      await sleep(config.visualPacingMs * 2); // tiempo para que caminen a la sala
      for (const d of fromOthers) {
        eventBus.publish({ missionId: id, agentId: d.agentId, provider: "system", sessionId: null, type: "MESSAGE_SENT", title: summaryLine(d.result!), detail: d.result!.slice(0, 4000), status: "info", metadata: { meetingId, to: step.agentId } });
        messageBus.handoff(id, d.agentId, step.agentId, summaryLine(d.result!), d.result!, meetingId);
        await sleep(config.visualPacingMs * 0.5);
      }
      messageBus.endMeeting(id, meetingId, participants);
      await sleep(800);
    } else {
      for (const d of fromOthers) messageBus.handoff(id, d.agentId, step.agentId, summaryLine(d.result!), d.result!);
      await sleep(config.visualPacingMs);
    }
    for (const d of deps.filter((x) => x.agentId === step.agentId)) messageBus.handoff(id, d.agentId, step.agentId, summaryLine(d.result!), d.result!);
  }

  private agentPrompt(m: Mission, step: MissionStep, inbound: Handoff[], w: WorkRepo | null, rt: MissionRuntime): string {
    const others = w ? [...rt.repos.values()].filter((x) => x.cfg.id !== w.cfg.id) : [];
    const where =
      m.repositoryId === NO_REPO || !w
        ? "Misión sin repositorio (análisis / datos)."
        : `Repositorio: ${w.cfg.name} (${w.cfg.kind ?? "otro"}) · trabajas sobre una copia aislada de ${w.base}; si hay cambios, el orquestador crea una rama nueva y la publica.${
            others.length ? `\nEsta misión se trabaja en paralelo también en ${others.map((x) => x.cfg.name).join(", ")} (otro compañero se encarga): tú solo trabajas en ${w.cfg.name}. Respeta el contrato acordado en la tarea.` : ""
          }`;
    const a = getAgent(step.agentId);
    const ctx = inbound.length
      ? `\n\nContexto real entregado por tu equipo:\n${inbound.map((h) => `--- De ${getAgent(h.from).name} ---\n${h.payload.slice(0, 12000)}`).join("\n\n")}`
      : "";
    const check = w?.cfg.checkCommand;
    const writes = step.writes
      ? `Puedes modificar archivos del repositorio para cumplir la tarea. Haz cambios mínimos y correctos. ${check ? `Para verificar, el repositorio tiene su propio chequeo: \`${check}\` (es el mismo que corre QA); ejecútalo o la parte relevante.` : "Si hay un comando rápido de verificación, ejecútalo."}`
      : "NO modifiques archivos: solo investiga y reporta con evidencia (rutas, líneas, fragmentos breves).";
    return `${a.systemBrief}

Misión global del equipo: ${m.prompt}
${where}${m.allowMcp ? mcpRules(m.mcpServers) : ""}

Tu tarea (${step.title}):
${step.task}
${ctx}

${writes}${
      rt.restarted.has(step.id)
        ? "\n\nNota: este paso se interrumpió porque el servidor de la oficina se reinició, y ahora se retoma. Puede haber cambios parciales tuyos en la carpeta: revisa `git status` y `git diff`, y continúa desde ahí sin duplicar trabajo."
        : ""
    }
No hagas git commit/push ni cambies de rama: el orquestador controla Git.
Termina tu respuesta con una línea que empiece exactamente con "RESUMEN:" seguida de una frase corta (máx. 12 palabras) de lo que encontraste o hiciste.`;
  }

  /** Ejecuta un agente real y publica sus eventos. */
  private async runAgent(
    missionId: string,
    agentId: AgentId,
    provider: Provider,
    cwd: string,
    permission: PermissionProfile,
    prompt: string,
    title: string,
    rt: MissionRuntime,
    step?: MissionStep,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    let entry;
    try {
      entry = await sessions.getOrCreate({ missionId, agentId, provider, cwd, permission, mcpAllow: repo.getMission(missionId)?.mcpServers ?? [] });
    } catch (e) {
      const msg = (e as Error).message;
      this.emit(missionId, agentId, { provider, sessionId: null, type: "AGENT_BLOCKED", title: `${getAgent(agentId).name} no pudo empezar`, detail: msg, status: "error" });
      return { ok: false, error: msg };
    }
    const exec = runtime.get(provider);
    entry.busy = true;
    sessions.sync(entry, "running");
    this.emit(missionId, agentId, { provider, sessionId: entry.session.cliSessionId, type: "AGENT_STARTED", title: `${getAgent(agentId).name}: ${title}`, status: "running", metadata: { stepId: step?.id ?? null, permission } });
    const iter = entry.session.hasTurn ? exec.sendMessage(entry.session, prompt) : exec.executeTask(entry.session, { prompt, title });
    let finalText = "";
    let error: string | null = null;
    try {
      for await (const ev of iter) {
        this.publishExecutorEvent(missionId, agentId, provider, entry.session.cliSessionId, ev, step);
        if (ev.type === "SESSION_CONNECTED" || ev.type === "SESSION_STARTED") sessions.sync(entry, "running");
        if (ev.type === "AGENT_FINISHED") finalText = ev.finalText ?? ev.detail ?? "";
        if (ev.type === "AGENT_ERROR") {
          const hint = (ev.metadata as { hint?: string } | undefined)?.hint;
          error = hint ? `${ev.title}. ${hint}` : `${ev.title}${ev.detail ? `: ${ev.detail}` : ""}`;
        }
      }
    } catch (e) {
      error = (e as Error).message;
      this.emit(missionId, agentId, { provider, sessionId: entry.session.cliSessionId, type: "AGENT_ERROR", title: "Error interno de la oficina al ejecutar al agente", detail: error, status: "error" });
    } finally {
      entry.busy = false;
      if (step) this.setStep(missionId, step, { sessionId: entry.session.cliSessionId });
    }
    sessions.sync(entry, error ? "error" : "idle");
    if (rt.cancelled) return { ok: false, error: "Cancelada" };
    if (error) {
      this.emit(missionId, agentId, { provider, sessionId: entry.session.cliSessionId, type: "AGENT_BLOCKED", title: `${getAgent(agentId).name} no pudo continuar`, detail: error, status: "error" });
      return { ok: false, error };
    }
    return { ok: true, text: finalText };
  }

  private publishExecutorEvent(missionId: string | null, agentId: AgentId, provider: Provider, sessionId: string | null, ev: ExecutorEvent, step?: MissionStep): AgentRuntimeEvent {
    const { finalText, ...rest } = ev;
    // AGENT_FINISHED de un paso intermedio no es el fin de la misión.
    return eventBus.publish({ ...rest, missionId, agentId, provider, sessionId, metadata: { ...(rest.metadata ?? {}), stepId: step?.id ?? null } });
  }

  // ------------------------------------------------------------------
  private async runQaStep(id: string, w: WorkRepo, step: MissionStep, rt: MissionRuntime): Promise<void> {
    const { cfg: r, wt } = w;
    const multi = rt.repos.size > 1;
    const tag = multi ? ` · ${r.name}` : "";
    this.setStep(id, step, { status: "running", provider: null, startedAt: new Date().toISOString() });
    this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_STARTED", title: `Vega: QA real${tag}`, status: "running", metadata: { stepId: step.id, repositoryId: r.id } });
    const diff = await gitManager.diffStat(wt);
    this.emit(id, "vega", { provider: "git", sessionId: null, type: "GIT_DIFF", title: `${diff.files.length} archivo(s) cambiados${tag}`, detail: diff.stat, status: "info", metadata: { files: diff.files, repositoryId: r.id } });

    let attempt = 0;
    for (;;) {
      const qa = detectQa(wt, r);
      if (!qa.commands.length) {
        this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_STATUS", title: `${qa.note ?? "Sin comandos de QA"}${tag}`, status: "warning" });
        this.setStep(id, step, { status: "done", result: qa.note ?? "Sin QA", finishedAt: new Date().toISOString() });
        return;
      }
      for (const cmd of qa.setup) {
        const res = await this.qaCommand(id, wt, cmd, rt, false);
        if (rt.cancelled) return;
        if (res.exitCode !== 0) {
          this.setStep(id, step, { status: "failed", error: `Falló la instalación (${cmd}): ${res.summary}`, finishedAt: new Date().toISOString() });
          return;
        }
      }
      // Etapas en orden; dentro de cada etapa, comandos a la vez (hasta QA_PARALLEL carriles).
      // Se corren todas las etapas y se reportan TODAS las fallas juntas.
      const maxLanes = Math.max(...qa.stages.map((s) => Math.min(config.qaParallel, s.length)));
      if (maxLanes > 1 || qa.stages.length > 1)
        this.emit(id, "vega", {
          provider: "qa",
          sessionId: null,
          type: "AGENT_STATUS",
          title: `QA${tag}: ${qa.commands.length} comandos en ${qa.stages.length} etapa(s), hasta ${maxLanes} a la vez`,
          detail: qa.stages.map((s, i) => `Etapa ${i + 1}${s.length > 1 ? " (en paralelo)" : ""}:\n${s.map((c) => `  • ${c}`).join("\n")}`).join("\n"),
          status: "info",
          metadata: { lanes: maxLanes, stages: qa.stages.length },
        });
      const results = [];
      for (const stage of qa.stages) {
        const lanes = Math.max(1, Math.min(config.qaParallel, stage.length));
        results.push(...(await mapLimit(stage, lanes, (cmd, i) => this.qaCommand(id, wt, cmd, rt, true, lanes > 1 ? (i % lanes) + 1 : undefined))));
        if (rt.cancelled) return;
      }
      const failures = results.filter((res) => res.exitCode !== 0).map((res) => ({ cmd: res.command, out: res.output.slice(-8000) }));
      if (!failures.length) {
        this.setStep(id, step, { status: "done", result: `QA OK: ${qa.commands.join(" · ")}`, finishedAt: new Date().toISOString() });
        this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_FINISHED", title: `Build y pruebas en verde${tag}`, status: "success", metadata: { stepId: step.id } });
        return;
      }
      const failedCmds = failures.map((f) => f.cmd).join(", ");
      const writer = rt.lastWriter.get(r.id);
      if (attempt >= config.qaFixIterations || !writer) {
        this.setStep(id, step, { status: "failed", error: `QA falló${tag}: ${failedCmds}`, finishedAt: new Date().toISOString() });
        this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_BLOCKED", title: `QA falló${tag}: ${failedCmds}`, detail: failures.map((f) => `$ ${f.cmd}\n${f.out.slice(-3000)}`).join("\n\n"), status: "error" });
        return;
      }
      attempt++;
      // Ciclo real de corrección: Vega entrega TODAS las fallas al último agente que escribió en este repo.
      const report = failures.map((f) => `El comando \`${f.cmd}\` falló. Salida (final):\n${f.out}`).join("\n\n");
      messageBus.handoff(id, "vega", writer, `${failures.length > 1 ? `${failures.length} comandos fallaron` : `${failures[0].cmd} falló`}`, report);
      await sleep(config.visualPacingMs);
      const m = repo.getMission(id)!;
      const provider = runtime.forAgent(writer, m.provider, m.engine);
      const fix = await this.runAgent(
        id,
        writer,
        provider,
        wt,
        "workspace-write",
        `${getAgent(writer).systemBrief}\nQA (Vega) reporta fallas reales tras tus cambios en ${r.name}. Corrígelas todas con el cambio mínimo.\n\n${messageBus
          .take(id, writer)
          .map((h) => h.payload)
          .join("\n\n")}\n\nNo hagas git commit/push. Termina con "RESUMEN:" y una frase corta.`,
        "Corregir falla de QA",
        rt,
      );
      if (!fix.ok) {
        this.setStep(id, step, { status: "failed", error: `No se pudo corregir: ${fix.error}`, finishedAt: new Date().toISOString() });
        return;
      }
      messageBus.handoff(id, writer, "vega", summaryLine(fix.text), fix.text);
      await sleep(config.visualPacingMs);
      messageBus.take(id, "vega");
    }
  }

  private async qaCommand(id: string, wt: string, cmd: string, rt: MissionRuntime, isTest: boolean, lane?: number) {
    const label = lane ? `Carril ${lane} · ` : "";
    this.emit(id, "vega", { provider: "qa", sessionId: null, type: isTest ? "TEST_STARTED" : "COMMAND_STARTED", title: `${label}$ ${cmd}`, command: cmd, status: "running", metadata: { lane: lane ?? null } });
    let buf = "";
    let last = 0;
    const signal: { cancelled: boolean; kill?: () => void } = { cancelled: rt.cancelled };
    rt.qaSignals.add(signal);
    const res = await runShell(
      cmd,
      wt,
      (chunk) => {
        buf += chunk;
        if (Date.now() - last > 700) {
          last = Date.now();
          const lastLine = buf.trim().split(/\r?\n/).pop() ?? "";
          this.emit(id, "vega", { provider: "qa", sessionId: null, type: isTest ? "TEST_OUTPUT" : "COMMAND_OUTPUT", title: firstLine(lastLine, 120) || "…", command: cmd, detail: buf.slice(-6000), status: "running", metadata: { lane: lane ?? null } });
        }
      },
      { signal, timeoutMs: 30 * 60_000 },
    ).finally(() => rt.qaSignals.delete(signal));
    const ok = res.exitCode === 0;
    this.emit(id, "vega", {
      provider: "qa",
      sessionId: null,
      type: isTest ? "TEST_FINISHED" : "COMMAND_FINISHED",
      title: label + (ok ? (isTest ? `${cmd} ✓` : `${cmd} listo`) : res.exitCode === 1 && isTest ? `${cmd}: algunas pruebas fallaron` : `${cmd} falló: ${commandExitReason(res.exitCode)}`),
      command: cmd,
      detail: `${res.summary}\n\n${res.output.slice(-12000)}`,
      status: ok ? "success" : "error",
      metadata: { exitCode: res.exitCode, durationMs: res.durationMs, summary: res.summary, lane: lane ?? null },
    });
    return res;
  }

  private async runReviewStep(id: string, wt: string, step: MissionStep, all: MissionStep[], rt: MissionRuntime): Promise<void> {
    const mission = repo.getMission(id)!;
    this.setStep(id, step, { status: "running", startedAt: new Date().toISOString() });
    // Diff de cada repositorio de la misión (back + front en misiones de varios repos).
    const multi = rt.repos.size > 1;
    const diffs = mission.repositoryId === NO_REPO ? [] : await Promise.all([...rt.repos.values()].map(async (w) => ({ w, d: await gitManager.diffStat(w.wt) })));
    const diff = {
      files: diffs.flatMap(({ w, d }) => d.files.map((f) => (multi ? `${w.cfg.shortName}/${f}` : f))),
      stat: diffs.filter(({ d }) => d.stat).map(({ w, d }) => (multi ? `### ${w.cfg.name}\n${d.stat}` : d.stat)).join("\n\n"),
      patch: multi ? diffs.filter(({ d }) => d.patch).map(({ w, d }) => `### ${w.cfg.name}\n${d.patch.slice(0, 15000)}`).join("\n\n") : "",
    };
    if (diff.files.length)
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_DIFF", title: `Diff final: ${diff.files.length} archivo(s)${multi ? ` en ${diffs.filter(({ d }) => d.files.length).length} repos` : ""}`, detail: diff.stat, status: "info", metadata: { files: diff.files } });
    const findings = all.filter((s) => s.kind === "agent" && s.result).map((s) => `## ${getAgent(s.agentId).name} — ${s.title}\n${s.result}`).join("\n\n");
    const inbound = messageBus.take(id, "atlas");
    let summary = findings || "Sin resultados de agentes.";
    if (config.atlasReviewEnabled) {
      const provider = runtime.forAgent("atlas", mission.provider, mission.engine);
      const analysis = !diff.files.length || isAnalysisOnly(mission.prompt);
      const prompt = `Eres Atlas, lead. Revisa el resultado real del equipo para la misión: "${mission.prompt}".
${analysis ? "Consolida los hallazgos en una respuesta final clara para el usuario (causa, evidencia, recomendación)." : "Revisa el diff del worktree (puedes usar git diff) y valida que resuelve la misión sin efectos colaterales. Resume qué cambió y riesgos."}

Resultados de los agentes:
${findings.slice(0, 30000)}
${inbound.length ? `\nEntregas recibidas: ${inbound.map((h) => `${getAgent(h.from).name}: ${h.title}`).join("; ")}` : ""}
${diff.stat ? `\ngit diff --stat:\n${diff.stat}` : ""}${diff.patch ? `\n\nCambios (la misión abarca varios repositorios; tu carpeta es solo el primero, aquí tienes el diff de todos):\n${diff.patch.slice(0, 30000)}` : ""}

No modifiques archivos. Responde en español, conciso (máx. 15 líneas). Termina con "RESUMEN:" y una frase corta.`;
      const res = await this.runAgent(id, "atlas", provider, wt, "read-only", prompt, step.title, rt, step);
      if (res.ok) summary = res.text;
      else {
        this.setStep(id, step, { status: "failed", error: res.error, finishedAt: new Date().toISOString() });
        return;
      }
    }
    this.setStep(id, step, { status: "done", result: summary.slice(0, 20000), finishedAt: new Date().toISOString() });
    this.setMission(id, { summary: summary.slice(0, 20000) });
  }

  // ------------------------------------------------------------------
  /** Chat real con la sesión del agente. */
  async chat(agentId: AgentId, message: string, missionId?: string | null, engine: EngineChoice = "auto"): Promise<void> {
    if (this.isAgentBusy(agentId)) throw new MissionError(`${getAgent(agentId).name} está ejecutando un paso de misión. Espera a que termine.`, 409);
    const missions = repo.listMissions(20);
    const mission = (missionId ? repo.getMission(missionId) : null) ?? missions.find((m) => m.steps.some((s) => s.agentId === agentId)) ?? null;
    await runtime.detect();
    const prior = mission ? sessions.get(mission.id, agentId) : sessions.get(null, agentId);
    // Motor: el elegido en el chat > el preferido del empleado > el de su misión > el por defecto.
    const pref = getAgent(agentId).engine;
    const provider: Provider =
      engine === "codex" || engine === "claude"
        ? engine
        : prior?.session.provider ?? (pref && runtime.isUsable(pref) ? pref : mission ? runtime.forAgent(agentId, mission.provider, mission.engine) : runtime.resolve("auto"));
    const existing = prior && prior.session.provider === provider ? prior : undefined;
    if (!runtime.isUsable(provider)) {
      const st = runtime.snapshot().find((s) => s.provider === provider);
      throw new MissionError(`${st?.label ?? provider} no disponible: ${st?.message ?? ""}`, 409);
    }
    const noRepoCwd = mission && mission.repositoryId === NO_REPO ? path.join(paths.runs, mission.id, "workspace") : null;
    if (noRepoCwd) fs.mkdirSync(noRepoCwd, { recursive: true });
    const cwd = mission?.worktree ?? noRepoCwd ?? existing?.session.config.cwd ?? paths.runs;
    const mid = mission?.id ?? null;
    const entry = existing ?? (await sessions.getOrCreate({ missionId: mid, agentId, provider, cwd, permission: "read-only", mcpAllow: mission?.mcpServers ?? [] }));
    if (entry.busy) throw new MissionError(`${getAgent(agentId).name} está respondiendo otro mensaje`, 409);
    entry.session.config.permission = "read-only";

    let prompt = message;
    if (!entry.session.hasTurn) {
      const a = getAgent(agentId);
      prompt = `${a.systemBrief}\nEl usuario te habla directamente por el chat de la oficina. Responde en español, breve y basado en evidencia. No modifiques archivos.\n\n${this.missionContext(mission, agentId)}\n\nMensaje del usuario: ${message}`;
    }
    const exec = runtime.get(provider);
    entry.busy = true;
    eventBus.publish({ missionId: mid, agentId, provider: "system", sessionId: entry.session.cliSessionId, type: "MESSAGE_SENT", title: `Tú → ${getAgent(agentId).name}: ${firstLine(message, 80)}`, detail: message, status: "info", metadata: { chat: true, fromUser: true } });
    void (async () => {
      let err: string | undefined;
      try {
        const iter = entry.session.hasTurn ? exec.sendMessage(entry.session, prompt) : exec.executeTask(entry.session, { prompt, title: "chat" });
        for await (const ev of iter) {
          const pub = this.publishExecutorEvent(mid, agentId, provider, entry.session.cliSessionId, { ...ev, metadata: { ...(ev.metadata ?? {}), chat: true } });
          if (ev.type === "AGENT_MESSAGE") eventBus.broadcast({ kind: "chat", agentId, missionId: mid, delta: ev.detail ?? ev.title, done: false });
          if (ev.type === "AGENT_ERROR") err = `${ev.title}${ev.detail ? `: ${ev.detail}` : ""}`;
          void pub;
        }
      } catch (e) {
        err = (e as Error).message;
      } finally {
        entry.busy = false;
        sessions.sync(entry, err ? "error" : "idle");
        eventBus.broadcast({ kind: "chat", agentId, missionId: mid, delta: "", done: true, error: err });
      }
    })();
  }

  /** Reconstruye contexto seguro de la misión (cuando el CLI no tiene la sesión). */
  missionContext(m: Mission | null, agentId: AgentId): string {
    if (!m) return "No hay misiones previas en las que hayas participado.";
    const hs = messageBus.history(m.id).filter((h) => h.to === agentId || h.from === agentId);
    const mine = m.steps.filter((s) => s.agentId === agentId && s.result);
    return `Contexto de la misión ${m.id} (${m.status}): ${m.prompt}
Repositorio ${m.repositoryId}, rama ${m.branch ?? "-"} (base ${m.baseBranch}). Worktree actual = directorio de trabajo.
${mine.length ? `Tus resultados:\n${mine.map((s) => `- ${s.title}: ${s.result!.slice(0, 3000)}`).join("\n")}` : ""}
${hs.length ? `Handoffs:\n${hs.map((h) => `- ${getAgent(h.from).name} → ${getAgent(h.to).name}: ${h.title}`).join("\n")}` : ""}
${m.summary ? `Resumen de Atlas: ${m.summary.slice(0, 2000)}` : ""}`;
  }
}

function summaryLine(text: string): string {
  const m = text.match(/RESUMEN:\s*(.+)/i);
  return firstLine(m ? m[1] : text, 90);
}

export const orchestrator = new AgentOrchestrator();
