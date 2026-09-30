import { customAlphabet } from "nanoid";
import type { AgentRuntimeEvent } from "../../shared/events";
import fs from "node:fs";
import path from "node:path";
import { isToolMcp, NO_REPO, type AgentId, type EngineChoice, type Mission, type MissionStep, type Provider, type RepositoryConfig } from "../../shared/types";
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

interface MissionRuntime {
  cancelled: boolean;
  qaSignal: { cancelled: boolean; kill?: () => void };
  lastWriter: AgentId | null;
}

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
    const r = repoId === NO_REPO ? null : this.repoConfig(repoId);
    const base = r ? input.baseBranch || r.defaultBase : "";
    if (r && !r.allowedBases.includes(base)) throw new MissionError(`Rama base no permitida: ${base}`);
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
        title: r ? `Repositorio elegido: ${r.name} (${base})` : "Misión sin repositorio (análisis / datos)",
        detail: `Selección automática: ${repoReason}.`,
        status: "info",
      });
    if (allowMcp) this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Datos reales vía MCP: ${mcpServers.join(", ")} (sólo lectura)`, status: "warning" });
    this.pushMission(id);
    const rt: MissionRuntime = { cancelled: false, qaSignal: { cancelled: false }, lastWriter: null };
    this.active.set(id, rt);
    void this.run(id, r, rt).finally(() => this.active.delete(id));
    return repo.getMission(id)!;
  }

  async cancelMission(id: string): Promise<void> {
    const rt = this.active.get(id);
    if (!rt) throw new MissionError("La misión no está en ejecución", 404);
    rt.cancelled = true;
    rt.qaSignal.cancelled = true;
    rt.qaSignal.kill?.();
    await sessions.cancelMission(id);
    this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: "Misión cancelada por el usuario", status: "warning" });
  }

  // ------------------------------------------------------------------
  private async run(id: string, r: RepositoryConfig | null, rt: MissionRuntime): Promise<void> {
    const mission = repo.getMission(id)!;
    try {
      if (!r) return await this.runWithoutRepo(id, mission, rt);
      // 1) Git: fetch + rama + worktree
      this.setMission(id, { status: "preparing" });
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "AGENT_STARTED", title: "Preparando espacio de trabajo", status: "running" });
      const repoPath = await gitManager.ensureClone(r);
      repo.upsertRepository({ id: r.id, name: r.name, github: r.github, cloneUrl: r.cloneUrl, localPath: repoPath });
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_FETCH", title: `git fetch origin (${r.name})`, command: "git fetch origin --prune", status: "running" });
      await gitManager.fetch(r);
      repo.upsertRepository({ id: r.id, name: r.name, github: r.github, cloneUrl: r.cloneUrl, localPath: repoPath, lastFetchAt: new Date().toISOString() });
      if (!(await gitManager.remoteBranchExists(r, mission.baseBranch)))
        throw new GitError(`La rama base origin/${mission.baseBranch} no existe en ${r.github}`, "");
      const wt = await gitManager.createWorktree(r, id, mission.baseBranch);
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_WORKTREE", title: "Worktree aislado listo (sin rama)", detail: `${wt}\nCopia de origin/${mission.baseBranch}; la rama solo se crea si hay cambios.`, status: "success", metadata: { worktree: wt, base: mission.baseBranch } });
      this.setMission(id, { worktree: wt });
      if (rt.cancelled) throw new MissionError("Cancelada");

      // 2) Plan real con Atlas
      this.setMission(id, { status: "planning" });
      const planStep: MissionStep = this.newStep(id, "plan", "atlas", "Planificar misión", mission.prompt, [], false, "plan");
      repo.addStep(planStep, 0);
      const plan = await this.plan(id, r, wt, mission, planStep, rt);
      if (rt.cancelled) throw new MissionError("Cancelada");

      // 3) Pasos del DAG
      const steps = this.materializePlan(id, plan, mission);
      steps.forEach((s, i) => repo.addStep(s, i + 1));
      this.setMission(id, { status: "running", planSource: plan.source });
      this.emit(id, "atlas", {
        provider: plan.source === "ai" ? mission.provider : "system",
        sessionId: null,
        type: "PLAN_CREATED",
        title: `Plan: ${steps.filter((s) => s.kind === "agent").map((s) => getAgent(s.agentId).name).join(" → ")}`,
        detail: steps.map((s) => `• ${getAgent(s.agentId).name}: ${s.title}${s.dependsOn.length ? ` (tras ${s.dependsOn.join(", ")})` : ""}`).join("\n"),
        status: "success",
        metadata: { source: plan.source, note: plan.note ?? null, steps: steps.map((s) => ({ id: s.id, agent: s.agentId, title: s.title, dependsOn: s.dependsOn, kind: s.kind })) },
      });

      const dag = new MissionDagExecutor(steps, {
        isCancelled: () => rt.cancelled,
        onSkip: (s, reason) => this.setStep(id, s, { status: "skipped", error: reason }),
        run: (s) => this.runStep(id, r, wt, s, steps, rt),
      });
      const { failed } = await dag.execute();
      if (rt.cancelled) throw new MissionError("Cancelada");
      if (failed.length) {
        const f = failed[0];
        throw new MissionError(`${getAgent(f.agentId).name} no pudo completar "${f.title}": ${f.error ?? "error"}`);
      }

      // 4) Rama + commit (orquestador, nunca la IA). Sin cambios → no se crea ninguna rama.
      this.setMission(id, { status: "committing" });
      const status = await gitManager.status(wt);
      const prefs = deliveryPrefs(mission.prompt);
      let sha: string | null = null;
      let branch: string | null = null;
      let direct = false;
      if (status.trim()) {
        direct = prefs.directToBase && !isProtected(mission.baseBranch);
        if (prefs.directToBase && !direct)
          this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `${mission.baseBranch} está protegida: se usa una rama nueva`, status: "warning" });
        branch = direct ? mission.baseBranch : `agentic/${mission.area}/${slugify(mission.prompt)}-${id}`;
        if (!direct) {
          await gitManager.createBranch(wt, branch);
          repo.insertBranch({ repositoryId: r.id, missionId: id, name: branch, base: mission.baseBranch, worktree: wt });
          this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_BRANCH", title: `Rama ${branch}`, detail: `desde origin/${mission.baseBranch}`, status: "success", metadata: { branch, base: mission.baseBranch } });
        }
        this.setMission(id, { branch });
        const agents = [...new Set(steps.filter((s) => s.writes && s.status === "done").map((s) => getAgent(s.agentId).name))];
        const msg = `${mission.area}: ${firstLine(mission.prompt, 60)}\n\nMisión ${id} · LRD Agentic Office\nAgentes: ${agents.join(", ") || "—"}\nMotor: ${mission.provider}\nBase: ${mission.baseBranch}`;
        sha = await gitManager.commit(wt, msg, direct ? branch : undefined);
        if (sha) {
          repo.insertDelivery({ missionId: id, kind: "commit", ref: sha });
          const writer = rt.lastWriter ?? "diego";
          this.emit(id, writer, { provider: "git", sessionId: null, type: "GIT_COMMIT", title: `Commit ${sha.slice(0, 7)}`, detail: msg, status: "success", metadata: { sha, branch } });
          this.setMission(id, { commitSha: sha });
        }
      } else {
        this.emit(id, "atlas", { provider: "git", sessionId: null, type: "AGENT_STATUS", title: "Sin cambios: no se crea rama ni commit", status: "info" });
      }

      // 5) Publicar la rama para evaluación (por defecto) / PR controlado por flag
      const publish = config.githubPushEnabled && prefs.publish;
      if (sha && branch && publish) {
        await gitManager.push(wt, direct ? branch : undefined);
        repo.insertDelivery({ missionId: id, kind: "push", ref: branch });
        this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_PUSH", title: `Rama publicada: ${branch}`, detail: direct ? null : `Lista para evaluación contra ${mission.baseBranch}`, status: "success", metadata: { branch } });
        this.setMission(id, { pushed: true });
        if (config.githubPrEnabled && !direct) {
          const summary = repo.getMission(id)?.summary ?? "";
          const url = await github.createPr(wt, {
            base: mission.baseBranch,
            head: branch,
            title: `[agentic] ${firstLine(mission.prompt, 70)}`,
            body: `${summary}\n\n---\nMisión \`${id}\` generada por LRD Agentic Office (${mission.provider}).`,
          });
          repo.insertDelivery({ missionId: id, kind: "pr", ref: url });
          const num = url.match(/\/pull\/(\d+)/)?.[1];
          this.emit(id, "atlas", { provider: "github", sessionId: null, type: "PR_CREATED", title: num ? `PR #${num} creado` : "PR creado", detail: url, status: "success", metadata: { url } });
          this.setMission(id, { prUrl: url });
        }
      } else if (sha) {
        const why = prefs.publish ? "GITHUB_PUSH_ENABLED=false" : "la misión pidió no publicar";
        this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Rama sin publicar (${why})`, detail: `Rama local: ${branch}`, status: "info" });
      }

      this.setMission(id, { status: "done" });
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_FINISHED", title: `Misión ${id} completada`, detail: repo.getMission(id)?.summary ?? null, status: "success", metadata: { missionDone: true, sha, branch } });
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

  /** Misión sin repositorio: análisis / datos (MCP). Sin git, sin QA, sin commit. */
  private async runWithoutRepo(id: string, mission: Mission, rt: MissionRuntime): Promise<void> {
    const cwd = path.join(paths.runs, id, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    this.setMission(id, { status: "planning" });
    const planStep = this.newStep(id, "plan", "atlas", "Planificar misión", mission.prompt, [], false, "plan");
    repo.addStep(planStep, 0);
    const plan = await this.plan(id, null, cwd, mission, planStep, rt);
    if (rt.cancelled) throw new MissionError("Cancelada");
    plan.deliverable = "analysis";
    for (const s of plan.steps) s.writes = false;
    const steps = this.materializePlan(id, plan, mission);
    steps.forEach((s, i) => repo.addStep(s, i + 1));
    this.setMission(id, { status: "running", planSource: plan.source });
    this.emit(id, "atlas", {
      provider: plan.source === "ai" ? mission.provider : "system",
      sessionId: null,
      type: "PLAN_CREATED",
      title: `Plan: ${steps.filter((s) => s.kind === "agent").map((s) => getAgent(s.agentId).name).join(" → ")}`,
      detail: steps.map((s) => `• ${getAgent(s.agentId).name}: ${s.title}`).join("\n"),
      status: "success",
      metadata: { source: plan.source, noRepo: true },
    });
    const dag = new MissionDagExecutor(steps, {
      isCancelled: () => rt.cancelled,
      onSkip: (s, reason) => this.setStep(id, s, { status: "skipped", error: reason }),
      run: (s) => this.runStep(id, null, cwd, s, steps, rt),
    });
    const { failed } = await dag.execute();
    if (rt.cancelled) throw new MissionError("Cancelada");
    if (failed.length) throw new MissionError(`${getAgent(failed[0].agentId).name} no pudo completar "${failed[0].title}": ${failed[0].error ?? "error"}`);
    this.setMission(id, { status: "done" });
    this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_FINISHED", title: `Misión ${id} completada`, detail: repo.getMission(id)?.summary ?? null, status: "success", metadata: { missionDone: true } });
  }

  private newStep(missionId: string, id: string, agentId: AgentId, title: string, task: string, dependsOn: string[], writes: boolean, kind: MissionStep["kind"]): MissionStep {
    return { id: `${missionId}-${id}`, missionId, agentId, title, task, dependsOn: dependsOn.map((d) => `${missionId}-${d}`), writes, kind, status: "pending", provider: null, sessionId: null, result: null, error: null, startedAt: null, finishedAt: null };
  }

  private materializePlan(missionId: string, plan: MissionPlan, mission: Mission): MissionStep[] {
    const steps = plan.steps.map((s) => this.newStep(missionId, s.id, s.agent, s.title, s.task, s.dependsOn, s.writes, "agent"));
    const anyWrites = steps.some((s) => s.writes);
    const leaves = steps.filter((s) => !steps.some((o) => o.dependsOn.includes(s.id))).map((s) => s.id.replace(`${missionId}-`, ""));
    if (anyWrites) {
      steps.push(this.newStep(missionId, "qa", "vega", "QA: build y pruebas reales", "Ejecutar build/tests del repositorio", leaves, false, "qa"));
      steps.push(this.newStep(missionId, "review", "atlas", "Revisión final del diff", mission.prompt, ["qa"], false, "review"));
    } else {
      steps.push(this.newStep(missionId, "review", "atlas", "Consolidar hallazgos", mission.prompt, leaves, false, "review"));
    }
    return steps;
  }

  // ------------------------------------------------------------------
  private async plan(id: string, r: RepositoryConfig | null, wt: string, mission: Mission, step: MissionStep, rt: MissionRuntime): Promise<MissionPlan> {
    const provider = runtime.forAgent("atlas", mission.provider, mission.engine);
    this.setStep(id, step, { status: "running", provider, startedAt: new Date().toISOString() });
    this.emit(id, "atlas", { provider, sessionId: null, type: "AGENT_STATUS", title: "Planificando la misión", status: "running", metadata: { visual: "THINKING" } });
    const res = await this.runAgent(id, "atlas", provider, wt, "read-only", buildPlannerPrompt(mission.prompt, r, mission.baseBranch, team(), mission.mcpServers), "Planificar", rt, step);
    if (!res.ok) {
      this.setStep(id, step, { status: "failed", error: res.error, finishedAt: new Date().toISOString() });
      throw new MissionError(`Atlas no pudo planificar: ${res.error}`);
    }
    let plan = parsePlan(res.text, mission.prompt);
    if (!plan) {
      plan = rulesPlan(mission.prompt, r, mission.area);
      plan.note = "Atlas no devolvió un JSON de plan válido; se aplicó el plan base por reglas.";
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: "Plan base por reglas", detail: plan.note, status: "warning" });
    }
    this.setStep(id, step, { status: "done", result: res.text.slice(0, 8000), finishedAt: new Date().toISOString() });
    return plan;
  }

  /** Ejecuta un paso del DAG según su tipo. */
  private async runStep(id: string, r: RepositoryConfig | null, wt: string, step: MissionStep, all: MissionStep[], rt: MissionRuntime): Promise<void> {
    if (rt.cancelled) return;
    // Entregar handoffs reales de las dependencias
    await this.deliverHandoffs(id, step, all);
    if (step.kind === "qa" && r) return this.runQaStep(id, r, wt, step, all, rt);
    if (step.kind === "review") return this.runReviewStep(id, wt, step, all, rt);

    const mission = repo.getMission(id)!;
    const provider = runtime.forAgent(step.agentId, mission.provider, mission.engine);
    this.setStep(id, step, { status: "running", provider, startedAt: new Date().toISOString() });
    const inbound = messageBus.take(id, step.agentId);
    const prompt = this.agentPrompt(mission, step, inbound);
    const res = await this.runAgent(id, step.agentId, provider, wt, step.writes ? "workspace-write" : "read-only", prompt, step.title, rt, step);
    if (res.ok) {
      if (step.writes) rt.lastWriter = step.agentId;
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

  private agentPrompt(m: Mission, step: MissionStep, inbound: Handoff[]): string {
    const a = getAgent(step.agentId);
    const ctx = inbound.length
      ? `\n\nContexto real entregado por tu equipo:\n${inbound.map((h) => `--- De ${getAgent(h.from).name} ---\n${h.payload.slice(0, 12000)}`).join("\n\n")}`
      : "";
    const writes = step.writes
      ? "Puedes modificar archivos del repositorio para cumplir la tarea. Haz cambios mínimos y correctos. Si hay un comando rápido de verificación, ejecútalo."
      : "NO modifiques archivos: solo investiga y reporta con evidencia (rutas, líneas, fragmentos breves).";
    return `${a.systemBrief}

Misión global del equipo: ${m.prompt}
${m.repositoryId === NO_REPO ? "Misión sin repositorio (análisis / datos)." : `Repositorio: ${m.repositoryId} · trabajas sobre una copia aislada de ${m.baseBranch}; si hay cambios, el orquestador crea una rama nueva y la publica.`}${m.allowMcp ? mcpRules(m.mcpServers) : ""}

Tu tarea (${step.title}):
${step.task}
${ctx}

${writes}
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
  private async runQaStep(id: string, r: RepositoryConfig, wt: string, step: MissionStep, all: MissionStep[], rt: MissionRuntime): Promise<void> {
    this.setStep(id, step, { status: "running", provider: null, startedAt: new Date().toISOString() });
    this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_STARTED", title: "Vega: QA real", status: "running", metadata: { stepId: step.id } });
    const diff = await gitManager.diffStat(wt);
    this.emit(id, "vega", { provider: "git", sessionId: null, type: "GIT_DIFF", title: `${diff.files.length} archivo(s) cambiados`, detail: diff.stat, status: "info", metadata: { files: diff.files } });

    let attempt = 0;
    for (;;) {
      const qa = detectQa(wt, r);
      if (!qa.commands.length) {
        this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_STATUS", title: qa.note ?? "Sin comandos de QA", status: "warning" });
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
      const failures: { cmd: string; out: string }[] = [];
      for (const cmd of qa.commands) {
        const res = await this.qaCommand(id, wt, cmd, rt, true);
        if (rt.cancelled) return;
        if (res.exitCode !== 0) {
          failures.push({ cmd, out: res.output.slice(-8000) });
          break;
        }
      }
      if (!failures.length) {
        this.setStep(id, step, { status: "done", result: `QA OK: ${qa.commands.join(" · ")}`, finishedAt: new Date().toISOString() });
        this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_FINISHED", title: "Build y pruebas en verde", status: "success", metadata: { stepId: step.id } });
        return;
      }
      const writer = rt.lastWriter;
      if (attempt >= config.qaFixIterations || !writer) {
        this.setStep(id, step, { status: "failed", error: `QA falló: ${failures[0].cmd}`, finishedAt: new Date().toISOString() });
        this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_BLOCKED", title: `QA falló: ${failures[0].cmd}`, detail: failures[0].out.slice(-3000), status: "error" });
        return;
      }
      attempt++;
      // Ciclo real de corrección: Vega entrega la falla al último agente que escribió.
      const report = `El comando \`${failures[0].cmd}\` falló. Salida (final):\n${failures[0].out}`;
      messageBus.handoff(id, "vega", writer, `${failures[0].cmd} falló`, report);
      await sleep(config.visualPacingMs);
      const m = repo.getMission(id)!;
      const provider = runtime.forAgent(writer, m.provider, m.engine);
      const fix = await this.runAgent(
        id,
        writer,
        provider,
        wt,
        "workspace-write",
        `${getAgent(writer).systemBrief}\nQA (Vega) reporta una falla real tras tus cambios. Corrígela con el cambio mínimo.\n\n${messageBus
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

  private async qaCommand(id: string, wt: string, cmd: string, rt: MissionRuntime, isTest: boolean) {
    this.emit(id, "vega", { provider: "qa", sessionId: null, type: isTest ? "TEST_STARTED" : "COMMAND_STARTED", title: `$ ${cmd}`, command: cmd, status: "running" });
    let buf = "";
    let last = 0;
    const res = await runShell(
      cmd,
      wt,
      (chunk) => {
        buf += chunk;
        if (Date.now() - last > 700) {
          last = Date.now();
          const lastLine = buf.trim().split(/\r?\n/).pop() ?? "";
          this.emit(id, "vega", { provider: "qa", sessionId: null, type: isTest ? "TEST_OUTPUT" : "COMMAND_OUTPUT", title: firstLine(lastLine, 120) || "…", command: cmd, detail: buf.slice(-6000), status: "running" });
        }
      },
      { signal: rt.qaSignal, timeoutMs: 30 * 60_000 },
    );
    const ok = res.exitCode === 0;
    this.emit(id, "vega", {
      provider: "qa",
      sessionId: null,
      type: isTest ? "TEST_FINISHED" : "COMMAND_FINISHED",
      title: ok ? (isTest ? `${cmd} ✓` : `${cmd} listo`) : res.exitCode === 1 && isTest ? `${cmd}: algunas pruebas fallaron` : `${cmd} falló: ${commandExitReason(res.exitCode)}`,
      command: cmd,
      detail: `${res.summary}\n\n${res.output.slice(-12000)}`,
      status: ok ? "success" : "error",
      metadata: { exitCode: res.exitCode, durationMs: res.durationMs, summary: res.summary },
    });
    return res;
  }

  private async runReviewStep(id: string, wt: string, step: MissionStep, all: MissionStep[], rt: MissionRuntime): Promise<void> {
    const mission = repo.getMission(id)!;
    this.setStep(id, step, { status: "running", startedAt: new Date().toISOString() });
    const diff = mission.repositoryId === NO_REPO ? { stat: "", files: [] as string[], patch: "" } : await gitManager.diffStat(wt);
    if (diff.files.length)
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_DIFF", title: `Diff final: ${diff.files.length} archivo(s)`, detail: diff.stat, status: "info", metadata: { files: diff.files } });
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
${diff.stat ? `\ngit diff --stat:\n${diff.stat}` : ""}

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
