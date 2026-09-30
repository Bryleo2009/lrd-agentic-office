import { customAlphabet } from "nanoid";
import type { AgentRuntimeEvent } from "../../shared/events";
import fs from "node:fs";
import path from "node:path";
import { isToolMcp, MULTI_REPO_SEP, NO_REPO, type AgentId, type CiInfo, type EngineChoice, type Mission, type MissionQuestion, type MissionRepo, type MissionStatus, type MissionStep, type Provider, type RepositoryConfig } from "../../shared/types";
import { config, loadRepositories, paths } from "../config";
import * as repo from "../database/repo";
import { eventBus } from "../events/AgentEventBus";
import { gitManager, GitError, isProtected, slugify } from "../integrations/git/GitWorktreeManager";
import { github } from "../integrations/github/GitHubAdapter";
import { MissionDagExecutor } from "../missions/MissionDagExecutor";
import { addLesson, extractLessons, forgetToolFailures, lessonFromToolFailure, lessonsFor, lessonsPrompt, pickLessons, recordCorrection, recordOutcome } from "../missions/lessons";
import { guideFor, TASK_KIND_LABEL, taskKind } from "../missions/guides";
import { ASK_RULE, extractQuestion, pickOption, questionKey } from "../missions/questions";
import { migrationFiles, scanSecrets } from "../missions/secrets";
import { libraryPrompt, relatedDocs, saveDoc, type NewDoc } from "../library";
import { asksChange, buildPlannerPrompt, ciRunRef, deliveryPrefs, inferBase, mentionedBranches, isQuickLookup, requestedBranch, inferArea, inferRepo, isAnalysisOnly, mcpRules, parsePlan, rulesPlan, type MissionPlan } from "../missions/MissionPlanner";
import { applyChecklistMarks, checklistPrompt, extractChecklist, makeChecklist } from "../missions/checklist";
import { waitForCi } from "../missions/ci";
import { detectQa, runShell } from "../missions/qa";
import type { ExecutorEvent, PermissionProfile } from "../runtime/AgentExecutor";
import { firstLine } from "../runtime/parsers/common";
import { commandExitReason, explainGitError, saturationFrom } from "../runtime/humanize";
import { tail as tailText } from "../runtime/processUtils";
import { runtime } from "../runtime/RuntimeDetector";
import { messageBus, type Handoff } from "./AgentMessageBus";
import { sessions } from "./AgentSession";
import { profile as getAgent, team } from "../settings";

const missionIdGen = customAlphabet("0123456789ABCDEF", 5);
const questionIdGen = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);
/** Huella corta de un texto (claves estables de aprobaciones). */
const hash = (t: string) => {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
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
  /** Preguntas al usuario que están esperando respuesta (id → continuar). */
  waiters: Map<string, (answer: string | null) => void>;
  /** Estado de la misión antes de pausarse por una pregunta (se restaura al responder). */
  statusBeforeWait: MissionStatus | null;
}

const newRuntime = (): MissionRuntime => ({ cancelled: false, qaSignals: new Set(), lastWriter: new Map(), repos: new Map(), restarted: new Set(), waiters: new Map(), statusBeforeWait: null });
const TERMINAL: MissionStatus[] = ["done", "failed", "cancelled"];

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
    return (runtime.snapshot().find((s) => s.provider === provider)?.mcpServers ?? []).filter((m) => m.enabled && !m.hidden).map((m) => m.name);
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

  isActive(missionId: string): boolean {
    return this.active.has(missionId);
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
    const satBoth = (["codex", "claude"] as Provider[]).filter((p) => runtime.isUsable(p)).every((p) => runtime.saturationOf(p));
    if (satBoth && (runtime.isUsable("codex") || runtime.isUsable("claude"))) {
      const when = (["codex", "claude"] as Provider[])
        .map((p) => runtime.saturationOf(p))
        .filter(Boolean)
        .map((s) => new Date(s!.until).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }))
        .sort()[0];
      throw new MissionError(`Codex y Claude Code llegaron a su límite. El primero vuelve ~${when}; lanza la misión después.`, 409);
    }
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
    // Rama base: la elegida en el formulario; si no, la que pide el texto ("Parte desde release/fase3.1"); si no, la del repo.
    const baseFor = (x: RepositoryConfig) => input.baseBranch || inferBase(prompt, x) || x.defaultBase;
    const baseFromText = !input.baseBranch && rs.some((x) => inferBase(prompt, x));
    for (const x of rs) if (!x.allowedBases.includes(baseFor(x))) throw new MissionError(`Rama base no permitida en ${x.name}: ${baseFor(x)}`);
    const base = r ? baseFor(r) : "";
    const repos: MissionRepo[] =
      rs.length > 1 ? rs.map((x) => ({ repositoryId: x.id, baseBranch: baseFor(x), worktree: null, branch: null, commitSha: null, pushed: false, prUrl: null })) : [];
    const id = missionIdGen();
    const area = inferArea(prompt, r);
    const kind = taskKind(prompt, rs.length === 0);
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
      ci: [],
      checklist: [],
      questions: [],
      taskKind: kind,
      lessonIds: [],
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
    if (baseFromText) this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Rama base tomada de la misión: ${base}`, detail: "El texto de la misión indica desde qué rama partir.", status: "info" });
    const wantBranch = r ? requestedBranch(prompt) : null;
    if (wantBranch) this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Si hay cambios, la rama será ${wantBranch}`, detail: "Nombre pedido en la misión.", status: "info" });
    if (kind !== "general" && guideFor(kind))
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Guía de trabajo: ${TASK_KIND_LABEL[kind]}`, detail: `El equipo sigue la guía config/guides/${kind}.md para este tipo de tarea.`, status: "info", metadata: { guide: kind } });
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
      // Las preguntas de agentes que quedaron sin responder se vuelven a hacer al repetir el paso;
      // las aprobaciones pendientes se conservan (se vuelven a pedir con la misma clave).
      if (m.questions.some((q) => q.status === "open" && q.kind === "question"))
        this.setMission(id, { questions: m.questions.map((q) => (q.status === "open" && q.kind === "question" ? { ...q, status: "expired" as const } : q)) });
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
    for (const w of [...rt.waiters.values()]) w(null);
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
          let base = baseOf(r);
          const repoPath = await gitManager.ensureClone(r);
          repo.upsertRepository({ id: r.id, name: r.name, github: r.github, cloneUrl: r.cloneUrl, localPath: repoPath });
          this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_FETCH", title: `git fetch origin (${r.name})`, command: "git fetch origin --prune", status: "running" });
          await gitManager.fetch(r);
          repo.upsertRepository({ id: r.id, name: r.name, github: r.github, cloneUrl: r.cloneUrl, localPath: repoPath, lastFetchAt: new Date().toISOString() });
          // ¿La misión apunta a otra rama existente (la de un run de CI, o una nombrada en el texto)? Se parte de ella.
          const target = base === r.defaultBase ? await this.targetBranch(id, mission, r) : null;
          if (target && target !== base) {
            base = target;
            if (multi) mission.repos = mission.repos.map((x) => (x.repositoryId === r.id ? { ...x, baseBranch: base } : x));
            else mission.baseBranch = base;
            this.setMission(id, multi ? { repos: mission.repos } : { baseBranch: base });
          }
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

      // Los pasos "ci" (GitHub Actions) no son del DAG: se ejecutan tras publicar la rama.
      const dag = new MissionDagExecutor(steps.filter((s) => s.kind !== "ci"), {
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

      // 5) GitHub Actions: esperar a que quede en verde; si falla por los cambios de la misión, corregir y volver a publicar.
      const toCheck = results.filter((x) => x.pushed && x.commitSha && x.branch);
      if (config.ciWaitEnabled && toCheck.length) {
        this.setMission(id, { status: "ci" });
        const ci = await Promise.all(toCheck.map((x) => this.ciLoop(id, mission, rt.repos.get(x.repositoryId)!, x, steps, rt, multi)));
        if (rt.cancelled) throw new MissionError("Cancelada");
        const fixed = results.find((x) => x.commitSha) ?? results[0];
        this.setMission(id, { commitSha: fixed.commitSha, ...(multi ? { repos: results } : {}) });
        const red = ci.filter((c) => c.state === "failure" || c.state === "timeout");
        if (red.length) throw new MissionError(`GitHub Actions no quedó en verde: ${red.map((c) => `${multi ? `${c.repositoryId}: ` : ""}${c.detail}`).join("; ")}`);
      }

      this.setMission(id, { status: "done" });
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_FINISHED", title: `Misión ${id} completada`, detail: repo.getMission(id)?.summary ?? null, status: "success", metadata: { missionDone: true, sha: main.commitSha, branch: main.branch } });
    } catch (e) {
      const err = e as Error;
      const cancelled = rt.cancelled;
      const g = err instanceof GitError ? explainGitError(err.message, err.output) : null;
      const detail = err instanceof GitError ? `${g!.title}. ${g!.hint}\n\n${err.message}${err.output ? `\n${err.output}` : ""}` : err.message;
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
    } finally {
      this.closeMission(id);
    }
  }

  /**
   * Al terminar una misión: cierra las preguntas que quedaron abiertas y registra si las lecciones que
   * usó el equipo sirvieron (terminó bien) o no (falló). Así se mide qué lecciones ayudan de verdad.
   */
  private closeMission(id: string): void {
    const m = repo.getMission(id);
    if (!m || !TERMINAL.includes(m.status)) return;
    if (m.questions.some((q) => q.status === "open")) this.setMission(id, { questions: m.questions.map((q) => (q.status === "open" ? { ...q, status: "expired" as const } : q)) });
    if (m.status !== "cancelled") recordOutcome(m.lessonIds, id, m.status === "done");
    if (m.status !== "cancelled") this.documentMission(m);
  }

  // ------------------------------------------------------------------ biblioteca
  /** Guarda un documento en la biblioteca y lo muestra en la oficina ("documentar"). */
  private document(missionId: string, agentId: AgentId, d: NewDoc): void {
    try {
      const doc = saveDoc({ missionId, agentId, ...d });
      this.emit(missionId, agentId, { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Documentado en la biblioteca: ${firstLine(doc.title, 90)}`, status: "info", metadata: { library: doc.id } });
      eventBus.broadcast({ kind: "library", doc: { id: doc.id, kind: doc.kind, title: doc.title, missionId: doc.missionId } });
    } catch (e) {
      console.error("[lrd] No se pudo documentar en la biblioteca:", e);
    }
  }

  /** "Consultar": documentos de la biblioteca relacionados con la tarea, como texto para el prompt. */
  private libraryText(m: Mission, agentId: AgentId, text: string): string {
    const repoIds = m.repos.length ? m.repos.map((r) => r.repositoryId) : m.repositoryId === NO_REPO ? [] : [m.repositoryId];
    let docs;
    try {
      docs = relatedDocs(text, { repoIds, excludeMissionId: m.id });
    } catch {
      return "";
    }
    if (!docs.length) return "";
    this.emit(m.id, agentId, {
      provider: "system",
      sessionId: null,
      type: "AGENT_STATUS",
      title: `Consultó la biblioteca: ${docs.length} documento(s) relacionados`,
      detail: docs.map((d) => `• ${d.title} (${d.createdAt.slice(0, 10)})`).join("\n"),
      status: "info",
      metadata: { library: docs.map((d) => d.id) },
    });
    return libraryPrompt(docs);
  }

  /** Al terminar: resumen de la misión (o el incidente, si falló) en la biblioteca. */
  private documentMission(m: Mission): void {
    // Una consulta rápida de un dato puntual no es conocimiento reutilizable (y puede tener datos de clientes).
    if (m.taskKind === "data-lookup" && m.steps.every((s) => s.title === "Consulta rápida")) return;
    const repos = m.repos.length ? m.repos.map((r) => r.repositoryId) : m.repositoryId === NO_REPO ? [] : [m.repositoryId];
    const diff = repo.missionEvents(m.id).filter((e) => e.type === "GIT_DIFF").at(-1)?.detail ?? "";
    const deliveries = m.repos.length
      ? m.repos.filter((r) => r.branch).map((r) => `- ${r.repositoryId}: \`${r.branch}\` · commit ${r.commitSha?.slice(0, 7) ?? "—"}${r.pushed ? " (publicado)" : " (sin publicar)"}`)
      : m.branch
        ? [`- \`${m.branch}\` · commit ${m.commitSha?.slice(0, 7) ?? "—"}${m.pushed ? " (publicado)" : " (sin publicar)"}`]
        : [];
    const decisions = m.questions.filter((q) => q.status === "answered" && !q.key.startsWith("secret:"));
    const team = [...new Set(m.steps.filter((s) => s.kind === "agent").map((s) => `${getAgent(s.agentId).name}${s.provider ? ` (${s.provider === "codex" ? "Codex" : "Claude Code"})` : ""}`))];
    const failed = m.status === "failed";
    const body = [
      `**Pedido:** ${m.prompt}`,
      repos.length ? `**Repositorio:** ${repos.join(" + ")} (base ${m.repos.length ? m.repos.map((r) => r.baseBranch).join(", ") : m.baseBranch})` : "**Sin repositorio** (análisis / datos)",
      failed ? `**Qué falló:** ${m.error ?? "sin detalle"}` : `**Resultado:**\n${m.summary ?? "—"}`,
      deliveries.length ? `**Entrega:**\n${deliveries.join("\n")}` : "",
      m.ci?.length ? `**GitHub Actions:** ${m.ci.map((c) => `${c.repositoryId}: ${c.state}`).join(", ")}` : "",
      m.checklist?.length ? `**Checklist:**\n${m.checklist.map((i) => `- ${i.status === "done" ? "✓" : i.status === "failed" ? "✗" : i.status === "skipped" ? "–" : "○"} ${i.text}`).join("\n")}` : "",
      decisions.length ? `**Decisiones:**\n${decisions.map((q) => `- ${q.text} → ${q.answer}`).join("\n")}` : "",
      diff ? `**Archivos cambiados:**\n\`\`\`\n${diff.slice(0, 3000)}\n\`\`\`` : "",
      team.length ? `**Equipo:** ${team.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    this.document(m.id, "atlas", {
      kind: failed ? "incidente" : "mision",
      title: `${failed ? "Incidente" : "Misión"} #${m.id}: ${firstLine(m.prompt, 90)}`,
      body,
      repositoryId: repos[0] ?? null,
      tags: [...repos, m.area, m.taskKind],
      sourceKey: `mission:${m.id}`,
    });
  }

  /** Guarda el estado de GitHub Actions de un repo en la misión (para la oficina y el informe). */
  private saveCi(id: string, info: CiInfo): void {
    const cur = repo.getMission(id)?.ci ?? [];
    this.setMission(id, { ci: [...cur.filter((c) => c.repositoryId !== info.repositoryId), { ...info }] });
  }

  /**
   * Espera GitHub Actions de la rama publicada. Si falla y NO falla también en la rama base, Vega le
   * pasa el log al último desarrollador del repo, que corrige; se hace commit, se publica y se espera
   * de nuevo (hasta CI_FIX_ITERATIONS). Si la rama no dispara workflows o gh no está disponible, se
   * documenta claramente (nunca se declara verde sin una ejecución real en verde).
   */
  private async ciLoop(id: string, mission: Mission, w: WorkRepo, res: MissionRepo, steps: MissionStep[], rt: MissionRuntime, multi: boolean): Promise<CiInfo> {
    const tag = multi ? ` · ${w.cfg.name}` : "";
    const short = multi ? `ci-${w.cfg.shortName}` : "ci";
    let step = steps.find((s) => s.id === `${id}-${short}`);
    if (!step) {
      step = this.newStep(id, short, "vega", `GitHub Actions${tag}`, `Esperar GitHub Actions de ${res.branch}`, [], false, "ci", multi ? w.cfg.id : null);
      repo.addStep(step, 900 + steps.length);
      steps.push(step);
    }
    const info: CiInfo = { repositoryId: w.cfg.id, state: "pending", detail: "Esperando GitHub Actions…", url: null, sha: res.commitSha, attempts: 0 };
    this.setStep(id, step, { status: "running", startedAt: new Date().toISOString(), error: null });
    this.saveCi(id, info);
    this.emit(id, "vega", { provider: "github", sessionId: null, type: "AGENT_STARTED", title: `Vega: esperando GitHub Actions${tag}`, detail: `${w.cfg.github} · ${res.branch} · ${res.commitSha?.slice(0, 7)}`, status: "running", metadata: { stepId: step.id } });
    const finish = (state: CiInfo["state"], detail: string, stepStatus: "done" | "failed", tone: "success" | "warning" | "error") => {
      info.state = state;
      info.detail = detail;
      this.saveCi(id, info);
      this.setStep(id, step!, { status: stepStatus, result: detail, error: stepStatus === "failed" ? detail : null, finishedAt: new Date().toISOString() });
      this.emit(id, "vega", {
        provider: "github",
        sessionId: null,
        type: tone === "success" ? "AGENT_FINISHED" : tone === "error" ? "AGENT_BLOCKED" : "AGENT_STATUS",
        title: state === "success" ? `GitHub Actions en verde${tag}` : state === "none" ? `La rama no disparó GitHub Actions${tag}` : state === "unavailable" ? `No se pudo verificar GitHub Actions${tag}` : state === "unrelated" ? `GitHub Actions falla, pero no por esta misión${tag}` : `GitHub Actions en rojo${tag}`,
        detail: `${detail}${info.url ? `\n${info.url}` : ""}`,
        status: tone,
        metadata: { stepId: step!.id, ci: state, url: info.url },
      });
      return info;
    };

    let sha = res.commitSha!;
    for (;;) {
      const r = await waitForCi(
        github,
        { repo: w.cfg.github, branch: res.branch!, sha, appearMs: config.ciAppearMs, timeoutMs: config.ciTimeoutMs, pollMs: config.ciPollMs },
        { isCancelled: () => rt.cancelled, onProgress: (t) => this.emit(id, "vega", { provider: "github", sessionId: null, type: "AGENT_STATUS", title: `Actions${tag}: ${firstLine(t, 110)}`, detail: t, status: "running" }) },
      );
      info.sha = sha;
      info.url = r.failed[0]?.url ?? r.runs[0]?.url ?? info.url;
      if (r.state === "cancelled") return info;
      if (r.state === "success") return finish("success", r.detail, "done", "success");
      if (r.state === "none") return finish("none", `${r.detail} No se declara verde sin una ejecución real.`, "done", "warning");
      if (r.state === "unavailable")
        return finish("unavailable", `No se pudo consultar GitHub Actions con gh (${firstLine(r.detail, 160)}). Instala gh y ejecuta \`gh auth login\` en esta PC.`, "done", "warning");
      if (r.state === "timeout") return finish("timeout", r.detail, "failed", "error");

      // Falló: ¿también falla en la rama base? Entonces no lo causa esta misión.
      const onBase = await Promise.all(r.failed.map((f) => github.lastConclusion(w.cfg.github, w.base, f.workflowName)));
      if (onBase.every((c) => c && c !== "success"))
        return finish("unrelated", `${r.detail}. El mismo workflow también está en rojo en ${w.base}: no lo causan los cambios de esta misión.`, "done", "warning");
      if (info.attempts >= config.ciFixIterations)
        return finish("failure", `${r.detail}${info.attempts ? ` (tras ${info.attempts} corrección(es))` : ""}`, "failed", "error");

      info.attempts++;
      this.saveCi(id, info);
      const logs = (await Promise.all(r.failed.map(async (f) => `### ${f.workflowName} (${f.conclusion}) ${f.url}\n${await github.failedLog(w.cfg.github, f.databaseId)}`))).join("\n\n");
      const writer = rt.lastWriter.get(w.cfg.id) ?? (w.cfg.kind === "frontend" ? "mica" : "diego");
      this.emit(id, "vega", { provider: "github", sessionId: null, type: "AGENT_STATUS", title: `Actions falló${tag}: ${firstLine(r.detail, 80)}. Se lo paso a ${getAgent(writer).name}`, detail: logs.slice(-4000), status: "warning" });
      messageBus.handoff(id, "vega", writer, `GitHub Actions falló: ${firstLine(r.detail, 80)}`, logs);
      await sleep(config.visualPacingMs);
      const provider = runtime.forAgent(writer, mission.provider, mission.engine);
      const fix = await this.runAgent(
        id,
        writer,
        provider,
        w.wt,
        "workspace-write",
        `${getAgent(writer).systemBrief}
GitHub Actions falló en ${w.cfg.github}, rama ${res.branch} (commit ${sha.slice(0, 7)}), después de los cambios de esta misión: "${mission.prompt.slice(0, 400)}".
Corrige SOLO lo que causan los cambios de esta misión, con el cambio mínimo y sin tocar nada fuera de su alcance.${w.cfg.checkCommand ? ` Verifica con \`${w.cfg.checkCommand}\` (o la parte que falló).` : ""}
Si la falla no tiene relación con estos cambios (p. ej. un problema de infraestructura o algo que ya fallaba antes), NO modifiques archivos y empieza tu respuesta con "NO_RELACIONADO:" y el motivo.
${guideFor("ci-fix")}
Log de los jobs que fallaron:
${messageBus
  .take(id, writer)
  .map((h) => h.payload)
  .join("\n\n")
  .slice(-24000)}

No hagas git commit/push: el orquestador lo hace. Termina con "RESUMEN:" y una frase corta.`,
        "Corregir GitHub Actions",
        rt,
      );
      if (!fix.ok) return finish("failure", `${r.detail}. No se pudo corregir: ${firstLine(fix.error, 160)}`, "failed", "error");
      const text = this.absorb(id, writer, fix.text, w.cfg.id);
      if (/NO_RELACIONADO/i.test(text)) return finish("unrelated", `${r.detail}. ${getAgent(writer).name}: ${firstLine(text.replace(/.*NO_RELACIONADO:\s*/is, ""), 200)}`, "done", "warning");
      if (!(await gitManager.status(w.wt)).trim()) return finish("failure", `${r.detail}. ${getAgent(writer).name} no encontró qué cambiar.`, "failed", "error");
      if ((await this.guardSecrets(id, w, rt, tag)) === "stop") return finish("failure", `${r.detail}. La corrección tiene un posible secreto y no se publicó.`, "failed", "error");
      const directCi = res.branch === w.base;
      const newSha = await gitManager.commit(w.wt, `fix(ci): ${firstLine(r.detail, 60)}\n\nMisión ${id} · corrección tras GitHub Actions (intento ${info.attempts})`, directCi ? w.base : undefined);
      if (!newSha) return finish("failure", `${r.detail}. No se pudo crear el commit de corrección.`, "failed", "error");
      this.emit(id, writer, { provider: "git", sessionId: null, type: "GIT_COMMIT", title: `Commit ${newSha.slice(0, 7)}${tag} (corrección de CI)`, status: "success", metadata: { sha: newSha, branch: res.branch, repositoryId: w.cfg.id } });
      await gitManager.push(w.wt, directCi ? w.base : undefined);
      repo.insertDelivery({ missionId: id, kind: "push", ref: `${w.cfg.id}:${res.branch}` });
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_PUSH", title: `Corrección publicada${tag}: ${res.branch}`, detail: "Esperando GitHub Actions de nuevo", status: "success", metadata: { branch: res.branch, repositoryId: w.cfg.id } });
      sha = newSha;
      res.commitSha = newSha;
    }
  }

  /**
   * Rama existente de la que debe partir la misión aunque no sea una rama base configurada:
   * la de un run de GitHub Actions citado ("CI #502", enlace del run) o una rama nombrada en el texto.
   * Solo se LEE de ella: la entrega sigue siendo una rama agentic/… nueva (o directa si se pide y no está protegida).
   */
  private async targetBranch(id: string, mission: Mission, r: RepositoryConfig): Promise<string | null> {
    const ref = ciRunRef(mission.prompt);
    if (ref) {
      const info = await github.runInfo(r.github, ref).catch(() => null);
      if (info?.headBranch && (await gitManager.remoteBranchExists(r, info.headBranch))) {
        this.emit(id, "atlas", {
          provider: "github",
          sessionId: null,
          type: "AGENT_STATUS",
          title: `Rama base: ${info.headBranch} (la del run #${info.number} de ${info.workflowName})`,
          detail: `El CI citado corrió sobre ${info.headBranch} @ ${info.headSha.slice(0, 7)}; se trabaja sobre esa rama, no sobre ${r.defaultBase}.`,
          status: "info",
        });
        return info.headBranch;
      }
      if (!info) this.emit(id, "atlas", { provider: "github", sessionId: null, type: "AGENT_STATUS", title: "No pude identificar la rama del run de CI citado", detail: "Se usa la rama base por defecto. Si la misión es sobre otra rama, nómbrala en el texto (p. ej. \"en la rama feature/…\").", status: "warning" });
    }
    for (const b of mentionedBranches(mission.prompt)) {
      if (b === r.defaultBase || !(await gitManager.remoteBranchExists(r, b))) continue;
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "AGENT_STATUS", title: `Rama base tomada de la misión: ${b}`, status: "info" });
      return b;
    }
    return null;
  }

  /** Rama de entrega: la que pide la misión (si está libre) o una generada agentic/<área>/<slug>-<id>. */
  private async branchName(mission: Mission, w: WorkRepo): Promise<string> {
    const auto = `agentic/${mission.area}/${slugify(mission.prompt)}-${mission.id}`;
    const want = requestedBranch(mission.prompt);
    if (!want || isProtected(want)) return auto;
    const taken = (await gitManager.remoteHasBranch(w.wt, want)) || (await gitManager.localBranchExists(w.wt, want));
    if (!taken) return want;
    this.emit(mission.id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `La rama ${want} ya existe: se usa ${want}-${mission.id}`, status: "warning" });
    return `${want}-${mission.id}`;
  }

  /** Commit + rama nueva + publicación de UN repositorio de la misión (si tiene cambios). */
  private async deliverRepo(id: string, mission: Mission, w: WorkRepo, steps: MissionStep[], rt: MissionRuntime, prefs: { publish: boolean; directToBase: boolean }, multi: boolean, commitTitle?: string): Promise<MissionRepo> {
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
    // Seguridad 1: nada con posibles secretos se guarda ni se publica sin tu decisión.
    if ((await this.guardSecrets(id, w, rt, tag)) === "stop") {
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Entrega detenida${tag}: posible secreto en los cambios`, detail: `Los cambios quedan sin commit en ${w.wt}. Quita el secreto y pídele al agente por chat "publica los cambios".`, status: "warning" });
      return out;
    }
    // Directo en la rama base: pedido en la misión, o la misión ya se pasó a su rama (mission.branch === base).
    const promoted = (multi ? mission.repos.find((x) => x.repositoryId === w.cfg.id)?.branch : mission.branch) === w.base;
    let direct = (promoted || (!onBranch && prefs.directToBase)) && !isProtected(w.base);
    if (prefs.directToBase && !direct && !onBranch)
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `${w.base} está protegida${tag}: se usa una rama nueva`, status: "warning" });
    // Seguridad 2: entregas directas en la rama base y migraciones de BD se publican solo con tu aprobación.
    let publish = config.githubPushEnabled && prefs.publish;
    if (publish) {
      const gate = await this.approvePublish(id, w, rt, tag, direct && !promoted && config.approvals.direct);
      if (gate === "new-branch") direct = false;
      if (gate === "no") publish = false;
    }
    const branch = direct ? w.base : onBranch ? current : await this.branchName(mission, w);
    if (!direct && !onBranch) {
      await gitManager.createBranch(w.wt, branch);
      repo.insertBranch({ repositoryId: w.cfg.id, missionId: id, name: branch, base: w.base, worktree: w.wt });
      this.emit(id, "atlas", { provider: "git", sessionId: null, type: "GIT_BRANCH", title: `Rama ${branch}${tag}`, detail: `desde origin/${w.base}`, status: "success", metadata: { branch, base: w.base, repositoryId: w.cfg.id } });
    }
    out.branch = branch;
    const mine = steps.filter((s) => s.writes && s.status === "done" && (s.repositoryId ?? w.cfg.id) === w.cfg.id);
    const agents = [...new Set(mine.map((s) => getAgent(s.agentId).name))];
    const msg = `${mission.area}: ${commitTitle ?? firstLine(mission.prompt, 60)}\n\nMisión ${id} · LRD Agentic Office\nAgentes: ${agents.join(", ") || "—"}\nMotor: ${mission.provider}\nBase: ${w.base}`;
    const sha = status.trim() ? await gitManager.commit(w.wt, msg, direct ? branch : undefined) : await gitManager.headSha(w.wt);
    if (!sha) return out;
    out.commitSha = sha;
    repo.insertDelivery({ missionId: id, kind: "commit", ref: sha });
    const writer = rt.lastWriter.get(w.cfg.id) ?? (w.cfg.kind === "frontend" ? "mica" : "diego");
    this.emit(id, writer, { provider: "git", sessionId: null, type: "GIT_COMMIT", title: `Commit ${sha.slice(0, 7)}${tag}`, detail: msg, status: "success", metadata: { sha, branch, repositoryId: w.cfg.id } });

    if (!publish) {
      const why = !config.githubPushEnabled ? "GITHUB_PUSH_ENABLED=false" : !prefs.publish ? "la misión pidió no publicar" : "no se aprobó la publicación";
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

  /**
   * Revisión de secretos sobre todo lo que se publicaría (commits de la misión + cambios sin commit).
   * Si encuentra algo, pausa y pregunta: que el agente lo quite, publicar (falso positivo) o no publicar.
   * Sin respuesta a tiempo, no se publica.
   */
  private async guardSecrets(id: string, w: WorkRepo, rt: MissionRuntime, tag: string): Promise<"ok" | "stop"> {
    if (!config.secretScan) return "ok";
    for (let round = 0; ; round++) {
      const d = await gitManager.diffFromBase(w.wt, w.base);
      const found = scanSecrets(d.patch, d.files);
      if (!found.length) {
        if (round > 0) this.emit(id, "vega", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Revisión de secretos${tag}: ya no hay hallazgos`, status: "success" });
        return "ok";
      }
      const list = found.map((f) => `• ${f.file}${f.line ? `:${f.line}` : ""} — ${f.kind}: ${f.preview}`).join("\n");
      this.emit(id, "vega", { provider: "system", sessionId: null, type: "AGENT_BLOCKED", title: `Posible secreto en los cambios${tag}: no se publica sin tu decisión`, detail: list, status: "warning", metadata: { secrets: found.length } });
      const writer = rt.lastWriter.get(w.cfg.id) ?? (w.cfg.kind === "frontend" ? "mica" : "diego");
      const FIX = `Que ${getAgent(writer).name} lo quite`;
      const OK = "Es un falso positivo: publicar";
      const NO = "No publicar";
      const options = round < 2 ? [FIX, OK, NO] : [OK, NO];
      const { answer } = await this.ask(id, rt, {
        key: `secret:${w.cfg.id}:${hash(found.map((f) => `${f.file}|${f.kind}|${f.preview}`).join("\n"))}`,
        agentId: "vega",
        kind: "approval",
        text: `Encontré ${found.length} posible(s) secreto(s) en los cambios${tag}. ¿Qué hago?`,
        context: list,
        options,
        fallback: "No se publica.",
        timeoutMs: config.approvalTimeoutMs,
      });
      if (rt.cancelled) return "stop";
      // Una respuesta ambigua ("sí") nunca publica un secreto: cuenta como "no publicar".
      const choice = answer === null ? NO : options[pickOption(answer, options, options.length - 1)] ?? NO;
      if (choice === OK) {
        this.emit(id, "vega", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Aprobado por ti: se publica pese a la alerta de secretos${tag}`, status: "warning" });
        return "ok";
      }
      if (choice !== FIX) return "stop";
      messageBus.handoff(id, "vega", writer, "Quitar posibles secretos de los cambios", list);
      await sleep(config.visualPacingMs);
      const m = repo.getMission(id)!;
      const fix = await this.runAgent(
        id,
        writer,
        runtime.forAgent(writer, m.provider, m.engine),
        w.wt,
        "workspace-write",
        `${getAgent(writer).systemBrief}
La revisión de secretos encontró posibles credenciales en los cambios de ${w.cfg.name}:
${messageBus
  .take(id, writer)
  .map((h) => h.payload)
  .join("\n")}

Quítalas del código: lee el valor desde configuración/variables de entorno (y si hace falta documenta la variable en .env.example con un valor de ejemplo, nunca el real) y saca del cambio los archivos de credenciales. Nunca escribas el valor en tu respuesta.
No hagas git commit/push. Termina con "RESUMEN:" y una frase corta.`,
        "Quitar secretos",
        rt,
      );
      if (!fix.ok) return "stop";
      this.absorb(id, writer, fix.text, w.cfg.id);
    }
  }

  /**
   * Aprobación antes de publicar: entrega directa en la rama base (sin rama nueva ni PR) y/o cambios con
   * migraciones de base de datos. Devuelve "yes", "new-branch" (mejor en una rama nueva) o "no" (dejar local).
   */
  private async approvePublish(id: string, w: WorkRepo, rt: MissionRuntime, tag: string, direct: boolean): Promise<"yes" | "new-branch" | "no"> {
    const migrations = config.approvals.migrations ? migrationFiles((await gitManager.diffFromBase(w.wt, w.base)).files) : [];
    if (!direct && !migrations.length) return "yes";
    const reasons = [
      direct ? `Se publicaría DIRECTO en \`${w.base}\` (sin rama nueva ni PR).` : null,
      migrations.length ? `Incluye ${migrations.length} migración(es) de base de datos:\n${migrations.map((f) => `• ${f}`).join("\n")}` : null,
    ].filter(Boolean) as string[];
    const YES = direct ? `Aprobar: publicar en ${w.base}` : "Aprobar publicación";
    const BRANCH = "Mejor en una rama nueva agentic/…";
    const NO = "No publicar (dejar local)";
    const options = direct ? [YES, BRANCH, NO] : [YES, NO];
    this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Necesito tu aprobación para publicar${tag}`, detail: reasons.join("\n\n"), status: "warning" });
    const { answer } = await this.ask(id, rt, {
      key: `approve:${w.cfg.id}:${direct ? `direct-${w.base}` : ""}:${hash(migrations.join(","))}`,
      agentId: "atlas",
      kind: "approval",
      text: `¿Apruebas publicar los cambios${tag}?`,
      context: reasons.join("\n\n"),
      options,
      fallback: "No se publica: queda local.",
      timeoutMs: config.approvalTimeoutMs,
    });
    const choice = answer === null ? NO : options[pickOption(answer, options, 0, options.length - 1)] ?? NO;
    const result = choice === YES ? "yes" : choice === BRANCH ? "new-branch" : "no";
    this.emit(id, "atlas", {
      provider: "system",
      sessionId: null,
      type: "AGENT_STATUS",
      title: result === "yes" ? `Publicación aprobada${tag}` : result === "new-branch" ? `Se publica en una rama nueva${tag}, no en ${w.base}` : `No se publica${tag}: ${answer === null ? "sin respuesta a tiempo" : "no aprobado"}`,
      status: result === "yes" ? "success" : "info",
    });
    return result;
  }

  /**
   * Pausa la misión con una pregunta al usuario y espera su respuesta. Si la misma pregunta (misma clave)
   * ya se respondió —por ejemplo antes de un reinicio—, devuelve esa respuesta sin volver a preguntar.
   * `answer` es null si se canceló o no respondió a tiempo (`timedOut`).
   */
  private async ask(
    id: string,
    rt: MissionRuntime,
    q: { key: string; agentId: AgentId; step?: MissionStep; kind: MissionQuestion["kind"]; text: string; context?: string | null; options?: string[]; fallback: string; timeoutMs: number },
  ): Promise<{ answer: string | null; timedOut: boolean }> {
    const m = repo.getMission(id)!;
    const prior = m.questions.find((x) => x.key === q.key && x.status !== "expired");
    if (prior?.status === "answered") return { answer: prior.answer, timedOut: false };
    const question: MissionQuestion = prior ?? {
      id: questionIdGen(),
      key: q.key,
      agentId: q.agentId,
      stepId: q.step?.id ?? null,
      kind: q.kind,
      text: q.text,
      context: q.context ? q.context.slice(0, 3000) : null,
      options: q.options ?? [],
      status: "open",
      answer: null,
      fallback: q.fallback,
      askedAt: new Date().toISOString(),
      answeredAt: null,
    };
    if (m.status !== "waiting") rt.statusBeforeWait = m.status;
    this.setMission(id, { status: "waiting", ...(prior ? {} : { questions: [...m.questions, question] }) });
    if (q.step) this.setStep(id, q.step, { status: "waiting" });
    const name = getAgent(q.agentId).name;
    this.emit(id, q.agentId, {
      provider: "system",
      sessionId: null,
      type: "AGENT_WAITING",
      title: q.kind === "approval" ? `${name} espera tu aprobación: ${firstLine(q.text, 90)}` : `${name} te pregunta: ${firstLine(q.text, 100)}`,
      detail: `${q.text}${question.context ? `\n\n${question.context}` : ""}${question.options.length ? `\n\nOpciones: ${question.options.join(" · ")}` : ""}`,
      status: "warning",
      metadata: { question: question.id, kind: q.kind },
    });
    const answer = await new Promise<string | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (v: string | null) => {
        if (timer) clearTimeout(timer);
        rt.waiters.delete(question.id);
        resolve(v);
      };
      rt.waiters.set(question.id, done);
      if (q.timeoutMs > 0) timer = setTimeout(() => done(null), q.timeoutMs);
      if (rt.cancelled) done(null);
    });
    const timedOut = answer === null && !rt.cancelled;
    if (timedOut) {
      this.updateQuestion(id, question.id, { status: "expired" });
      this.emit(id, q.agentId, { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Sin respuesta a tiempo: ${q.fallback}`, detail: q.text, status: "info" });
    }
    if (!rt.cancelled && rt.waiters.size === 0) {
      this.setMission(id, { status: rt.statusBeforeWait ?? "running" });
      rt.statusBeforeWait = null;
    }
    if (q.step && !rt.cancelled) this.setStep(id, q.step, { status: "running" });
    return { answer, timedOut };
  }

  private updateQuestion(missionId: string, qid: string, patch: Partial<MissionQuestion>): MissionQuestion | null {
    const m = repo.getMission(missionId);
    const q = m?.questions.find((x) => x.id === qid);
    if (!m || !q) return null;
    const next = { ...q, ...patch };
    this.setMission(missionId, { questions: m.questions.map((x) => (x.id === qid ? next : x)) });
    return next;
  }

  /** Respuesta del usuario a una pregunta o aprobación (desde la oficina o por el chat del agente). */
  answerQuestion(missionId: string, qid: string, answer: string): MissionQuestion {
    const text = answer.trim();
    if (!text) throw new MissionError("La respuesta está vacía");
    const m = repo.getMission(missionId);
    const q = m?.questions.find((x) => x.id === qid);
    if (!m || !q) throw new MissionError("Pregunta no encontrada", 404);
    if (q.status !== "open") throw new MissionError(q.status === "answered" ? "Esa pregunta ya fue respondida" : "Esa pregunta ya no está vigente", 409);
    const next = this.updateQuestion(missionId, qid, { status: "answered", answer: text.slice(0, 4000), answeredAt: new Date().toISOString() })!;
    eventBus.publish({ missionId, agentId: q.agentId, provider: "system", sessionId: null, type: "MESSAGE_SENT", title: `Tú → ${getAgent(q.agentId).name}: ${firstLine(text, 80)}`, detail: text, status: "info", metadata: { chat: true, fromUser: true, answer: qid } });
    // Las decisiones quedan en la biblioteca (las de secretos no: no son conocimiento reutilizable).
    if (!q.key.startsWith("secret:"))
      this.document(missionId, q.agentId, {
        kind: "decision",
        title: `Decisión: ${firstLine(q.text, 120)}`,
        body: `**Pregunta** (${getAgent(q.agentId).name}, misión #${missionId}): ${q.text}\n\n**Respuesta:** ${next.answer}${q.options.length ? `\n\n**Opciones que había:** ${q.options.join(" · ")}` : ""}${q.context ? `\n\n**Contexto:**\n${q.context.slice(0, 1500)}` : ""}\n\n**Misión:** ${m.prompt}`,
        repositoryId: m.repositoryId === NO_REPO ? null : m.repositoryId,
        tags: [m.area, m.taskKind, q.kind],
        sourceKey: `decision:${qid}`,
      });
    // Si el servidor se reinició mientras tanto, la respuesta queda guardada y se usa al retomar.
    this.active.get(missionId)?.waiters.get(qid)?.(next.answer);
    return next;
  }

  /** Pregunta abierta de un agente en una misión en curso (para responderla por su chat). */
  private openQuestionFor(agentId: AgentId, missionId?: string | null): { missionId: string; q: MissionQuestion } | null {
    for (const mid of this.active.keys()) {
      if (missionId && mid !== missionId) continue;
      const q = repo
        .getMission(mid)
        ?.questions.filter((x) => x.status === "open" && x.agentId === agentId)
        .at(-1);
      if (q && this.active.get(mid)?.waiters.has(q.id)) return { missionId: mid, q };
    }
    return null;
  }

  /**
   * Ejecuta un agente y, si responde con "PREGUNTA: …", pausa el paso hasta que el usuario responda y
   * le pasa la respuesta para que continúe (como máximo MAX_QUESTIONS_PER_STEP veces por paso).
   */
  private async runAgentAsking(
    id: string,
    agentId: AgentId,
    provider: Provider,
    cwd: string,
    permission: PermissionProfile,
    prompt: string,
    title: string,
    rt: MissionRuntime,
    step?: MissionStep,
  ): ReturnType<AgentOrchestrator["runAgent"]> {
    let res = await this.runAgent(id, agentId, provider, cwd, permission, prompt, title, rt, step);
    for (let n = 0; res.ok && n < config.maxQuestionsPerStep; n++) {
      const q = extractQuestion(res.text);
      if (!q) break;
      const { answer, timedOut } = await this.ask(id, rt, {
        key: questionKey(step?.id ?? title, q.text),
        agentId,
        step,
        kind: "question",
        text: q.text,
        context: q.rest ? q.rest.slice(0, 1500) : null,
        options: q.options,
        fallback: `${getAgent(agentId).name} sigue con lo más prudente y lo explica en su resumen.`,
        timeoutMs: config.questionTimeoutMs,
      });
      if (rt.cancelled) return { ok: false, error: "Cancelada", provider: res.provider };
      const reply = timedOut || answer === null ? "(no respondió a tiempo: decide lo más prudente, sigue y explica el supuesto en tu resumen)" : `"${answer}"`;
      res = await this.runAgent(
        id,
        agentId,
        res.provider,
        cwd,
        permission,
        `${prompt}\n\n---\nYa le preguntaste al usuario: "${q.text}". Su respuesta: ${reply}\nNo vuelvas a preguntar lo mismo: continúa con tu tarea usando esa respuesta y termina como se pidió. Si la respuesta es una preferencia general que el equipo debe recordar en próximas misiones, agrega una línea "LECCIÓN: …".`,
        title,
        rt,
        step,
      );
    }
    return res;
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
    // Consulta rápida (sin revisión de Atlas): la respuesta del agente es el resultado de la misión.
    if (!steps.some((s) => s.kind === "review")) this.setMission(id, { summary: steps.map((s) => s.result ?? "").join("\n\n").slice(0, 20000) });
    this.setMission(id, { status: "done" });
    this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_FINISHED", title: `Misión ${id} completada`, detail: repo.getMission(id)?.summary ?? null, status: "success", metadata: { missionDone: true } });
  }

  /** Ámbitos de memoria que aplican a la misión: sus repos, "datos" si usa MCP, y "general". */
  private lessonScopes(m: Mission): string[] {
    const repos = m.repos.length ? m.repos.map((r) => r.repositoryId) : m.repositoryId === NO_REPO ? [] : [m.repositoryId];
    return [...repos, ...(m.allowMcp || m.repositoryId === NO_REPO ? ["datos"] : [])];
  }

  /** Lecciones para los prompts de la misión; recuerda cuáles recibió el equipo (para medir si sirven). */
  private lessonsText(m: Mission): string {
    const picked = pickLessons(this.lessonScopes(m));
    const cur = repo.getMission(m.id)?.lessonIds ?? m.lessonIds ?? [];
    const add = picked.map((l) => l.id).filter((x) => !cur.includes(x));
    if (add.length) {
      const lessonIds = [...cur, ...add];
      m.lessonIds = lessonIds;
      this.setMission(m.id, { lessonIds });
    }
    return lessonsPrompt(picked);
  }

  /** Guarda lecciones y avisa en la oficina cuando el equipo aprende algo nuevo. */
  private learn(missionId: string, agentId: AgentId, texts: string[], scope: string, source: "auto" | "equipo" | "correccion"): void {
    for (const t of texts.slice(0, 3)) {
      const l = addLesson(t, scope, source, repo.getMission(missionId)?.lessonIds ?? []);
      if (l && l.hits === 1) this.emit(missionId, agentId, { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `${source === "correccion" ? "Aprendido de tu corrección" : "Aprendido"}: ${firstLine(l.text, 110)}`, detail: l.text, status: "info", metadata: { lesson: l.id } });
    }
  }

  /** Separa las líneas "LECCIÓN:" de una respuesta, las guarda y devuelve el texto limpio. */
  private absorb(missionId: string, agentId: AgentId, text: string, scope: string): string {
    const { lessons, rest } = extractLessons(text);
    if (lessons.length) this.learn(missionId, agentId, lessons, scope, "equipo");
    // Marcas del checklist (HECHO / VERIFICADO / PENDIENTE / NO_APLICA).
    const cur = repo.getMission(missionId)?.checklist ?? [];
    const marked = applyChecklistMarks(cur, rest || text, agentId);
    if (marked.changed) {
      this.setMission(missionId, { checklist: marked.items });
      const done = marked.items.filter((i) => i.status === "done" || i.status === "skipped").length;
      this.emit(missionId, agentId, { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Checklist: ${done}/${marked.items.length} listos`, detail: marked.items.map((i) => `${i.status === "done" ? "✓" : i.status === "failed" ? "✗" : i.status === "skipped" ? "–" : "○"} ${i.id}. ${i.text}`).join("\n"), status: "info", metadata: { checklist: true } });
    }
    return marked.rest || rest || text;
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
        if (s.status === "running" || s.status === "cancelled" || s.status === "waiting") {
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

    // Consulta rápida de datos: un solo agente, sin planificación de Atlas ni reunión final.
    if (noRepo && isQuickLookup(mission.prompt)) {
      const who: AgentId = ({ rappi: "rafa", pedidosya: "piero", finance: "fiona" } as Record<string, AgentId>)[mission.area] ?? "nora";
      const task = `${mission.prompt}

Es una consulta puntual: respóndela directo con los datos, en pocas consultas (idealmente 1 a 3).
- Si hay varias coincidencias, lístalas brevemente (máx. 5, con fecha y canal) y detalla la más reciente o la que mejor encaje; no investigues todas.
- Órdenes/pedidos: busca SIEMPRE con LIKE '%<número dado>%' (número y correlativo; el prefijo tipo ORD-XXXX- varía y el usuario puede dar solo los últimos dígitos), de preferencia filtrando por la fecha de hoy y ampliando si no aparece. Las herramientas por número exacto, solo con el número completo que devolvió esa búsqueda.
- Un "no encontrado" (404, sin resultados) NO es una herramienta rota: antes de concluir, amplía la búsqueda y, si hay otro entorno (Producción / QA), búscalo también ahí. Di en qué entorno lo encontraste.
- No revises integraciones externas, código, logs ni permisos salvo que el usuario lo pida explícitamente.
- Responde en pocas líneas, como se lo dirías a alguien del equipo.`;
      const step = this.newStep(id, "s1", who, "Consulta rápida", task, [], false, "agent");
      repo.addStep(step, 1);
      this.setMission(id, { status: "running", planSource: "rules" });
      this.emit(id, "atlas", {
        provider: "system",
        sessionId: null,
        type: "PLAN_CREATED",
        title: `Consulta rápida: ${getAgent(who).name}`,
        detail: `Es una consulta puntual: la responde ${getAgent(who).name} directo con los datos, sin planificación ni reunión.`,
        status: "success",
        metadata: { source: "rules", quick: true, noRepo, steps: [{ id: step.id, agent: who, title: step.title, dependsOn: [], kind: "agent", repositoryId: null }] },
      });
      return [step];
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
    // Checklist visible: la que extrajo Atlas o, si no, las viñetas/puntos de la misión.
    const checklist = makeChecklist(plan.checklist?.length ? plan.checklist : extractChecklist(mission.prompt));
    this.setMission(id, { status: "running", planSource: plan.source, ...(checklist.length ? { checklist } : {}) });
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
        let own = steps.filter((s) => s.kind === "agent" && (s.repositoryId ?? null) === rid).map(short);
        // Revisión cruzada: el otro motor revisa lo implementado antes de QA.
        if (config.crossReview) {
          const xid = multi && cfg ? `xreview-${cfg.shortName}` : "xreview";
          steps.push(this.newStep(missionId, xid, "atlas", multi && cfg ? `Revisión cruzada · ${cfg.name}` : "Revisión cruzada del código", mission.prompt, own, false, "xreview", rid));
          own = [xid];
        }
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
    const ask = config.maxQuestionsPerStep > 0 ? `\nSi la misión es ambigua en algo que cambia el plan y solo el usuario puede decidirlo, en lugar del JSON responde SOLO "PREGUNTA: …" (y si aplica "OPCIONES: a | b"). No preguntes lo que puedes decidir tú o averiguar leyendo.` : "";
    const prompt = `${buildPlannerPrompt(mission.prompt, r, mission.baseBranch, team(), mission.mcpServers, multi, this.lessonsText(mission))}${this.libraryText(mission, "atlas", mission.prompt)}${guideFor(mission.taskKind)}${ask}`;
    const res = await this.runAgentAsking(id, "atlas", provider, wt, "read-only", prompt, "Planificar", rt, step);
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
    if (step.kind === "xreview" && w) return this.runCrossReviewStep(id, w, step, all, rt);
    if (step.kind === "review") return this.runReviewStep(id, wt, step, all, rt);

    const mission = repo.getMission(id)!;
    const provider = runtime.forAgent(step.agentId, mission.provider, mission.engine);
    this.setStep(id, step, { status: "running", provider, startedAt: new Date().toISOString() });
    const inbound = messageBus.take(id, step.agentId);
    const prompt = this.agentPrompt(mission, step, inbound, w, rt);
    const res = await this.runAgentAsking(id, step.agentId, provider, wt, step.writes ? "workspace-write" : "read-only", prompt, step.title, rt, step);
    if (res.ok) {
      if (step.writes && w) rt.lastWriter.set(w.cfg.id, step.agentId);
      const text = this.absorb(id, step.agentId, res.text, w?.cfg.id ?? "datos");
      this.setStep(id, step, { status: "done", result: text.slice(0, 20000), finishedAt: new Date().toISOString() });
      // "Documentar": el informe de la tarea queda en la biblioteca (salvo una consulta rápida de un dato puntual).
      if (step.kind === "agent" && step.title !== "Consulta rápida" && text.trim())
        this.document(id, step.agentId, {
          kind: step.writes ? "informe" : "investigacion",
          title: `${step.title} — ${firstLine(mission.prompt, 60)}`,
          body: `**Misión #${id}:** ${mission.prompt}\n**${getAgent(step.agentId).name}**${res.provider ? ` · ${res.provider === "codex" ? "Codex" : "Claude Code"}` : ""}${w ? ` · ${w.cfg.name}` : ""}\n\n**Tarea:** ${step.task}\n\n${text}`,
          repositoryId: w?.cfg.id ?? null,
          tags: [w?.cfg.id ?? "datos", mission.area, mission.taskKind],
          sourceKey: `step:${step.id}`,
        });
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
        : `Repositorio: ${w.cfg.name} (${w.cfg.github}, ${w.cfg.kind ?? "otro"}). Tu carpeta es una copia aislada de origin/${w.base} con HEAD separado (detached) A PROPÓSITO: la rama${
            requestedBranch(m.prompt) ? ` ${requestedBranch(m.prompt)}` : " agentic/…"
          } la crea el orquestador al final si hay cambios, y la publica. Para verificar la base usa \`git rev-parse HEAD origin/${w.base}\` (deben coincidir); que no haya rama activa es lo esperado, no un error.${
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
${where}${m.allowMcp ? mcpRules(m.mcpServers) + "\n- Ve DIRECTO a la consulta que responde la tarea: no verifiques autenticación/permisos ni explores el repositorio antes; hazlo solo si la consulta falla." : ""}${this.lessonsText(m)}${this.libraryText(m, step.agentId, `${m.prompt}\n${step.title}\n${step.task}`)}${guideFor(m.taskKind)}${step.writes ? checklistPrompt(repo.getMission(m.id)?.checklist ?? [], "implement") : ""}

Tu tarea (${step.title}):
${step.task}
${ctx}

${writes}${
      rt.restarted.has(step.id)
        ? "\n\nNota: este paso se interrumpió porque el servidor de la oficina se reinició, y ahora se retoma. Puede haber cambios parciales tuyos en la carpeta: revisa `git status` y `git diff`, y continúa desde ahí sin duplicar trabajo."
        : ""
    }
No hagas git commit/push ni cambies de rama: el orquestador controla Git.${config.maxQuestionsPerStep > 0 ? `\n${ASK_RULE}` : ""}
Si perdiste tiempo en algo evitable (una herramienta que no sirve aquí, un dato difícil de ubicar, un atajo), agrega hasta 2 líneas "LECCIÓN: …" concretas y reutilizables (sin datos personales ni valores de clientes; no repitas las lecciones que ya recibiste).
Termina tu respuesta con una línea que empiece exactamente con "RESUMEN:" seguida de una frase corta (máx. 12 palabras) de lo que encontraste o hiciste.`;
  }

  /** Ejecuta un agente real y publica sus eventos. */
  /**
   * Ejecuta un agente real y publica sus eventos. Si el motor llega a su límite (o está saturado),
   * lo recuerda temporalmente y reintenta el mismo paso con el otro motor (una vez).
   */
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
  ): Promise<{ ok: true; text: string; provider: Provider } | { ok: false; error: string; provider: Provider }> {
    let current = provider;
    for (let attempt = 0; ; attempt++) {
      const release = runtime.acquire(current); // síncrono: el reparto ve esta carga de inmediato
      let res: Awaited<ReturnType<AgentOrchestrator["runAgentOnce"]>>;
      try {
        res = await this.runAgentOnce(missionId, agentId, current, cwd, permission, prompt, title, rt, step);
      } finally {
        release();
      }
      if (res.ok || rt.cancelled) return { ...res, provider: current };
      const sat = saturationFrom(res.raw, config.engineCooldownMs);
      if (!sat) return { ok: false, error: res.error, provider: current };
      const s = runtime.markSaturated(current, sat.reason, sat.ms);
      eventBus.broadcast({ kind: "runtime", runtime: runtime.snapshot() });
      const back = new Date(s.until).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
      const alt = runtime.other(current);
      const label = (p: Provider) => (p === "codex" ? "Codex" : "Claude Code");
      if (attempt === 0 && runtime.isAvailable(alt)) {
        this.emit(missionId, agentId, {
          provider: "system",
          sessionId: null,
          type: "AGENT_STATUS",
          title: `${label(current)} ${sat.reason} (vuelve ~${back}): ${getAgent(agentId).name} sigue con ${label(alt)}`,
          detail: `Mientras tanto la oficina no usará ${label(current)}.`,
          status: "warning",
          metadata: { engineSwitch: { from: current, to: alt } },
        });
        current = alt;
        continue;
      }
      return { ok: false, error: `${res.error} (${label(current)} ${sat.reason}; vuelve ~${back}${runtime.isAvailable(alt) ? "" : `, y ${label(alt)} tampoco está disponible`})`, provider: current };
    }
  }

  private async runAgentOnce(
    missionId: string,
    agentId: AgentId,
    provider: Provider,
    cwd: string,
    permission: PermissionProfile,
    prompt: string,
    title: string,
    rt: MissionRuntime,
    step?: MissionStep,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string; raw: string }> {
    let entry;
    try {
      entry = await sessions.getOrCreate({ missionId, agentId, provider, cwd, permission, mcpAllow: repo.getMission(missionId)?.mcpServers ?? [] });
    } catch (e) {
      const msg = (e as Error).message;
      this.emit(missionId, agentId, { provider, sessionId: null, type: "AGENT_BLOCKED", title: `${getAgent(agentId).name} no pudo empezar`, detail: msg, status: "error" });
      return { ok: false, error: msg, raw: msg };
    }
    const exec = runtime.get(provider);
    entry.busy = true;
    sessions.sync(entry, "running");
    if (step) this.setStep(missionId, step, { provider });
    this.emit(missionId, agentId, { provider, sessionId: entry.session.cliSessionId, type: "AGENT_STARTED", title: `${getAgent(agentId).name}: ${title}`, status: "running", metadata: { stepId: step?.id ?? null, permission, engine: provider } });
    const iter = entry.session.hasTurn ? exec.sendMessage(entry.session, prompt) : exec.executeTask(entry.session, { prompt, title });
    let finalText = "";
    let error: string | null = null;
    let raw = "";
    try {
      for await (const ev of iter) {
        this.publishExecutorEvent(missionId, agentId, provider, entry.session.cliSessionId, ev, step);
        if (ev.type === "SESSION_CONNECTED" || ev.type === "SESSION_STARTED") sessions.sync(entry, "running");
        if (ev.type === "AGENT_FINISHED") finalText = ev.finalText ?? ev.detail ?? "";
        if (ev.type === "AGENT_ERROR") {
          const hint = (ev.metadata as { hint?: string } | undefined)?.hint;
          error = hint ? `${ev.title}. ${hint}` : `${ev.title}${ev.detail ? `: ${ev.detail}` : ""}`;
          raw += `${ev.title}\n${ev.detail ?? ""}\n`;
        }
      }
    } catch (e) {
      error = (e as Error).message;
      raw += error;
      this.emit(missionId, agentId, { provider, sessionId: entry.session.cliSessionId, type: "AGENT_ERROR", title: "Error interno de la oficina al ejecutar al agente", detail: error, status: "error" });
    } finally {
      entry.busy = false;
      if (step) this.setStep(missionId, step, { sessionId: entry.session.cliSessionId });
    }
    sessions.sync(entry, error ? "error" : "idle");
    if (rt.cancelled) return { ok: false, error: "Cancelada", raw: "" };
    if (error) {
      this.emit(missionId, agentId, { provider, sessionId: entry.session.cliSessionId, type: "AGENT_BLOCKED", title: `${getAgent(agentId).name} no pudo continuar`, detail: error, status: "error" });
      return { ok: false, error, raw };
    }
    return { ok: true, text: finalText };
  }

  private publishExecutorEvent(missionId: string | null, agentId: AgentId, provider: Provider, sessionId: string | null, ev: ExecutorEvent, step?: MissionStep): AgentRuntimeEvent {
    const { finalText, ...rest } = ev;
    // Una herramienta de datos que falla se recuerda, para que la próxima vez no se pierda tiempo en ella.
    const meta = (ev.metadata ?? {}) as { mcp?: boolean };
    if (missionId && ev.type === "TOOL_FINISHED" && meta.mcp && ev.tool) {
      if (ev.status === "error" || /"success"\s*:\s*false/.test(ev.detail ?? "")) {
        const l = lessonFromToolFailure(ev.tool, ev.detail ?? "");
        if (l) this.learn(missionId, agentId, [l], "datos", "auto");
      } else if (forgetToolFailures(ev.tool)) {
        // Volvió a funcionar: la lección de que "falla" ya no es cierta.
        this.emit(missionId, agentId, { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Olvidado: ${ev.tool.replace(/^mcp__/, "").replace(/__/g, ".")} ya funciona`, status: "info" });
      }
    }
    // AGENT_FINISHED de un paso intermedio no es el fin de la misión.
    return eventBus.publish({ ...rest, missionId, agentId, provider, sessionId, metadata: { ...(rest.metadata ?? {}), stepId: step?.id ?? null } });
  }

  // ------------------------------------------------------------------
  /**
   * Revisión cruzada: un motor distinto al que implementó revisa el diff contra la misión.
   * Si encuentra problemas BLOQUEANTES, el implementador (en su motor) los corrige antes de QA.
   */
  private async runCrossReviewStep(id: string, w: WorkRepo, step: MissionStep, all: MissionStep[], rt: MissionRuntime): Promise<void> {
    const mission = repo.getMission(id)!;
    const multi = rt.repos.size > 1;
    const tag = multi ? ` · ${w.cfg.name}` : "";
    const writers = all.filter((s) => s.kind === "agent" && s.writes && s.status === "done" && (s.repositoryId ?? w.cfg.id) === w.cfg.id);
    const writerEngines = [...new Set(writers.map((s) => s.provider).filter((p): p is Provider => !!p))];
    const avoid = writerEngines.length === 1 ? writerEngines[0] : null;
    const diff = await gitManager.diffStat(w.wt);
    if (!diff.files.length) {
      this.setStep(id, step, { status: "done", result: "Sin cambios: no hay nada que revisar", finishedAt: new Date().toISOString() });
      return;
    }
    const provider = runtime.choose({ agentId: "atlas", missionProvider: mission.provider, engine: mission.engine, avoid });
    const label = (p: Provider) => (p === "codex" ? "Codex" : "Claude Code");
    this.setStep(id, step, { status: "running", provider, startedAt: new Date().toISOString() });
    this.emit(id, "atlas", {
      provider: "system",
      sessionId: null,
      type: "AGENT_STATUS",
      title: avoid && provider !== avoid ? `Revisión cruzada${tag}: ${label(provider)} revisa lo que implementó ${label(avoid)}` : `Revisión cruzada${tag} con ${label(provider)}${avoid ? ` (el otro motor no está disponible)` : ""}`,
      status: "info",
    });
    const prompt = `Eres revisor de código senior. Otro motor implementó esta misión y tú revisas su trabajo con ojos frescos.
Misión: "${mission.prompt.slice(0, 4000)}"
Repositorio: ${w.cfg.name} (base ${w.base}). NO modifiques archivos.

Revisa el diff contra lo pedido: requisitos incumplidos, bugs, regresiones, casos borde, seguridad, cambios fuera de alcance.
- Por cada problema real escribe una línea "BLOQUEANTE: archivo:línea — qué está mal y cómo corregirlo".
- Observaciones menores: líneas "SUGERENCIA: …" (no bloquean).
- Si no hay nada bloqueante, escribe una línea "APROBADO".
${checklistPrompt(repo.getMission(id)?.checklist ?? [], "verify")}
Termina con "RESUMEN:" y una frase corta.

git diff --stat:
${diff.stat}

Diff:
${diff.patch.slice(0, 40000)}`;
    const res = await this.runAgent(id, "atlas", provider, w.wt, "read-only", prompt, step.title, rt, step);
    if (!res.ok) {
      // Una revisión que no se pudo hacer no bloquea la misión: QA y la revisión final siguen.
      this.setStep(id, step, { status: "done", result: `Revisión cruzada no disponible: ${res.error}`, finishedAt: new Date().toISOString() });
      return;
    }
    let review = this.absorb(id, "atlas", res.text, w.cfg.id);
    // Lo que la revisión dejó PENDIENTE en el checklist también vuelve al implementador.
    const pendientes = (repo.getMission(id)?.checklist ?? []).filter((i) => i.status === "failed").map((i) => `BLOQUEANTE: punto ${i.id} del checklist sin cumplir — ${i.text}${i.note ? ` (${i.note})` : ""}`);
    const blocking = [...review.split(/\r?\n/).filter((l) => /^\s*[-*•]?\s*BLOQUEANTE\s*:/i.test(l)), ...pendientes];
    if (pendientes.length) review += `\n\n${pendientes.join("\n")}`;
    const writer = writers.at(-1);
    for (let round = 0; blocking.length && writer && round < config.crossReviewFixRounds; round++) {
      this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Revisión cruzada${tag}: ${blocking.length} punto(s) bloqueante(s); se los paso a ${getAgent(writer.agentId).name}`, detail: blocking.join("\n"), status: "warning" });
      messageBus.handoff(id, "atlas", writer.agentId, `Revisión: ${blocking.length} punto(s) a corregir`, review);
      await sleep(config.visualPacingMs);
      const fixProvider = runtime.choose({ agentId: writer.agentId, missionProvider: mission.provider, engine: mission.engine, prefer: writer.provider });
      const fix = await this.runAgent(
        id,
        writer.agentId,
        fixProvider,
        w.wt,
        "workspace-write",
        `${getAgent(writer.agentId).systemBrief}
Un revisor (${label(provider)}) revisó tu implementación de la misión y encontró estos puntos BLOQUEANTES. Corrígelos con el cambio mínimo; si alguno es un falso positivo, no lo cambies y explica por qué.

${messageBus
  .take(id, writer.agentId)
  .map((h) => h.payload)
  .join("\n\n")
  .slice(0, 20000)}

${checklistPrompt(repo.getMission(id)?.checklist ?? [], "implement")}
No hagas git commit/push. Termina con "RESUMEN:" y una frase corta.`,
        "Corregir lo señalado en la revisión",
        rt,
      );
      review += fix.ok ? `\n\nCorrección de ${getAgent(writer.agentId).name}: ${summaryLine(fix.text)}` : `\n\nNo se pudo corregir: ${fix.error}`;
      if (fix.ok) this.absorb(id, writer.agentId, fix.text, w.cfg.id);
      break;
    }
    if (!blocking.length) this.emit(id, "atlas", { provider: "system", sessionId: null, type: "AGENT_STATUS", title: `Revisión cruzada${tag}: aprobado por ${label(provider)}`, status: "success" });
    this.setStep(id, step, { status: "done", result: review.slice(0, 20000), finishedAt: new Date().toISOString() });
  }

  private async runQaStep(id: string, w: WorkRepo, step: MissionStep, rt: MissionRuntime): Promise<void> {
    const { cfg: r, wt } = w;
    const multi = rt.repos.size > 1;
    const tag = multi ? ` · ${r.name}` : "";
    this.setStep(id, step, { status: "running", provider: null, startedAt: new Date().toISOString() });
    this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_STARTED", title: `Vega: QA real${tag}`, status: "running", metadata: { stepId: step.id, repositoryId: r.id } });
    const diff = await gitManager.diffStat(wt);
    this.emit(id, "vega", { provider: "git", sessionId: null, type: "GIT_DIFF", title: `${diff.files.length} archivo(s) cambiados${tag}`, detail: diff.stat, status: "info", metadata: { files: diff.files, repositoryId: r.id } });
    if (!diff.files.length) {
      // Nadie cambió nada: no hay nada que probar (y correr QA solo daría fallas ajenas a la misión).
      this.emit(id, "vega", { provider: "qa", sessionId: null, type: "AGENT_STATUS", title: `Sin cambios${tag}: no hay nada que probar`, status: "info" });
      this.setStep(id, step, { status: "done", result: "Sin cambios: QA no aplica", finishedAt: new Date().toISOString() });
      return;
    }

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
    const findings = all
      .filter((s) => (s.kind === "agent" || s.kind === "xreview") && s.result)
      .map((s) => `## ${getAgent(s.agentId).name} — ${s.title}${s.provider ? ` (${s.provider === "codex" ? "Codex" : "Claude Code"})` : ""}\n${s.result}`)
      .join("\n\n");
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

${checklistPrompt(mission.checklist ?? [], "verify")}
No modifiques archivos. Responde en español, conciso (máx. 15 líneas).
Después, si el equipo perdió tiempo en algo evitable (permisos o herramientas que fallaron, exploración innecesaria, pasos de más), agrega hasta 3 líneas "LECCIÓN: …" concretas para hacerlo mejor la próxima vez (sin datos personales).
Termina con "RESUMEN:" y una frase corta.`;
      const res = await this.runAgent(id, "atlas", provider, wt, "read-only", prompt, step.title, rt, step);
      if (res.ok) summary = this.absorb(id, "atlas", res.text, this.lessonScopes(mission)[0] ?? "general");
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
    // ¿El agente está esperando tu respuesta en una misión? Lo que escribas en su chat es la respuesta.
    const waiting = this.openQuestionFor(agentId, missionId) ?? this.openQuestionFor(agentId);
    if (waiting) {
      this.answerQuestion(waiting.missionId, waiting.q.id, message);
      eventBus.broadcast({ kind: "chat", agentId, missionId: waiting.missionId, delta: "", done: true });
      return;
    }
    if (this.isAgentBusy(agentId)) throw new MissionError(`${getAgent(agentId).name} está ejecutando un paso de misión. Espera a que termine.`, 409);
    const missions = repo.listMissions(20);
    const mission = (missionId ? repo.getMission(missionId) : null) ?? missions.find((m) => m.steps.some((s) => s.agentId === agentId)) ?? null;
    await runtime.detect();
    const prior = mission ? sessions.get(mission.id, agentId) : sessions.get(null, agentId);
    // Motor: el elegido en el chat > el preferido del empleado > el de su misión > el por defecto.
    const pref = getAgent(agentId).engine;
    let provider: Provider =
      engine === "codex" || engine === "claude"
        ? engine
        : prior?.session.provider ?? (pref && runtime.isUsable(pref) ? pref : mission ? runtime.forAgent(agentId, mission.provider, mission.engine) : runtime.resolve("auto"));
    // Motor saturado (límite de uso): se usa el otro mientras tanto.
    if (!runtime.isAvailable(provider) && runtime.isAvailable(runtime.other(provider))) provider = runtime.other(provider);
    const existing = prior && prior.session.provider === provider ? prior : undefined;
    if (!runtime.isUsable(provider)) {
      const st = runtime.snapshot().find((s) => s.provider === provider);
      throw new MissionError(`${st?.label ?? provider} no disponible: ${st?.message ?? ""}`, 409);
    }
    const noRepoCwd = mission && mission.repositoryId === NO_REPO ? path.join(paths.runs, mission.id, "workspace") : null;
    if (noRepoCwd) fs.mkdirSync(noRepoCwd, { recursive: true });
    // ¿Pide un cambio de código sobre una misión con repositorio ya terminada? Entonces el agente puede
    // editar en la carpeta de esa misión y la oficina hace commit en su misma rama, la publica y espera CI.
    const change = mission && mission.repositoryId !== NO_REPO && asksChange(message) ? this.chatChangeTarget(mission, agentId) : null;
    if (change && this.active.has(mission!.id)) throw new MissionError("La misión todavía está en curso: espera a que termine para pedir ajustes por chat.", 409);
    // "Hazlo directo en esa rama" sobre una misión ya entregada en una rama agentic/…: la oficina publica esos
    // commits en la rama base (si no está protegida) y la entrega pasa a ser esa rama. Sin despertar al agente.
    if (mission && mission.repositoryId !== NO_REPO && !this.active.has(mission.id) && deliveryPrefs(message).directToBase && this.agenticDeliveries(mission).length) {
      eventBus.publish({ missionId: mission.id, agentId, provider: "system", sessionId: null, type: "MESSAGE_SENT", title: `Tú → ${getAgent(agentId).name}: ${firstLine(message, 80)}`, detail: message, status: "info", metadata: { chat: true, fromUser: true } });
      void this.promoteToBase(mission, agentId)
        .catch((e) => {
          const g = e instanceof GitError ? explainGitError(e.message, e.output) : null;
          this.chatNote(mission.id, agentId, g ? `No pude pasar los cambios a la rama base: ${g.title}.\n\n${g.hint}` : `No pude pasar los cambios a la rama base: ${(e as Error).message}`);
        })
        .finally(() => eventBus.broadcast({ kind: "chat", agentId, missionId: mission.id, delta: "", done: true }));
      return;
    }
    // "publica los cambios" / "reintenta": solo publicar lo que ya está hecho, sin despertar al agente.
    if (change && message.length < 80 && /^\s*(por favor\s+)?(publica|vuelve a publicar|reintenta)/i.test(message)) {
      eventBus.publish({ missionId: mission!.id, agentId, provider: "system", sessionId: null, type: "MESSAGE_SENT", title: `Tú → ${getAgent(agentId).name}: ${firstLine(message, 80)}`, detail: message, status: "info", metadata: { chat: true, fromUser: true } });
      void this.deliverChatChange(mission!, agentId, change, message)
        .catch((e) => {
          const g = e instanceof GitError ? explainGitError(e.message, e.output) : null;
          this.chatNote(mission!.id, agentId, g ? `Sigo sin poder publicar: ${g.title}.\n\n${g.hint}\n\nDetalle de git:\n\`\`\`\n${tailText(`${e.message}\n${(e as GitError).output}`, 1500)}\n\`\`\`` : `Sigo sin poder publicar: ${(e as Error).message}`);
          if (repo.getMission(mission!.id)?.status === "committing") this.setMission(mission!.id, { status: "done" });
        })
        .finally(() => eventBus.broadcast({ kind: "chat", agentId, missionId: mission!.id, delta: "", done: true }));
      return;
    }
    const cwd = change?.wt ?? mission?.worktree ?? noRepoCwd ?? existing?.session.config.cwd ?? paths.runs;
    const mid = mission?.id ?? null;
    const entry = existing ?? (await sessions.getOrCreate({ missionId: mid, agentId, provider, cwd, permission: "read-only", mcpAllow: mission?.mcpServers ?? [] }));
    if (entry.busy) throw new MissionError(`${getAgent(agentId).name} está respondiendo otro mensaje`, 409);
    entry.session.config.permission = change ? "workspace-write" : "read-only";
    if (change) entry.session.config.cwd = change.wt;

    const changeNote = change
      ? `El usuario te pide un CAMBIO sobre la misión ${mission!.id}: puedes modificar archivos en tu carpeta (${change.cfg.name}, ${change.wt}). Haz el cambio mínimo y correcto${change.cfg.checkCommand ? ` y verifica con \`${change.cfg.checkCommand}\` o la parte relevante` : ""}. No hagas git commit/push ni cambies de rama: al terminar, la oficina hace el commit en la rama de la misión, la publica y espera GitHub Actions.
Este ajuste es una corrección del usuario sobre el trabajo del equipo: si revela algo que el equipo debió hacer bien desde el inicio y es reutilizable (una convención, un archivo que siempre hay que tocar, una preferencia), agrega al final UNA línea "LECCIÓN: …" con la regla general (sin datos del caso).`
      : "No modifiques archivos: si el usuario pide un cambio de código, dile que lo pida con un verbo claro (p. ej. \"cambia…\", \"corrige…\") o que lance una misión.";
    const state = mission ? this.missionState(mission) : "";
    let prompt = change ? `${state}${changeNote}\n\nMensaje del usuario: ${message}` : `${state}${message}`;
    if (!entry.session.hasTurn) {
      const a = getAgent(agentId);
      prompt = `${a.systemBrief}\nEl usuario te habla directamente por el chat de la oficina. Responde en español, breve y basado en evidencia. ${changeNote}\n\n${this.missionContext(mission, agentId)}${lessonsFor(mission ? this.lessonScopes(mission) : ["datos"])}\n\nMensaje del usuario: ${message}`;
    }
    const exec = runtime.get(provider);
    entry.busy = true;
    eventBus.publish({ missionId: mid, agentId, provider: "system", sessionId: entry.session.cliSessionId, type: "MESSAGE_SENT", title: `Tú → ${getAgent(agentId).name}: ${firstLine(message, 80)}`, detail: message, status: "info", metadata: { chat: true, fromUser: true } });
    const release = runtime.acquire(provider);
    void (async () => {
      let err: string | undefined;
      let finalText = "";
      try {
        const iter = entry.session.hasTurn ? exec.sendMessage(entry.session, prompt) : exec.executeTask(entry.session, { prompt, title: "chat" });
        for await (const ev of iter) {
          if (ev.type === "AGENT_FINISHED") finalText = ev.finalText ?? ev.detail ?? finalText;
          const pub = this.publishExecutorEvent(mid, agentId, provider, entry.session.cliSessionId, { ...ev, metadata: { ...(ev.metadata ?? {}), chat: true } });
          if (ev.type === "AGENT_MESSAGE") eventBus.broadcast({ kind: "chat", agentId, missionId: mid, delta: ev.detail ?? ev.title, done: false });
          if (ev.type === "AGENT_ERROR") err = `${ev.title}${ev.detail ? `: ${ev.detail}` : ""}`;
          void pub;
        }
      } catch (e) {
        err = (e as Error).message;
      } finally {
        release();
        entry.busy = false;
        entry.session.config.permission = "read-only";
        sessions.sync(entry, err ? "error" : "idle");
      }
      // Límite de uso a mitad del chat: se recuerda y el mensaje se reenvía al otro motor (una vez).
      const sat = err ? saturationFrom(err, config.engineCooldownMs) : null;
      if (sat) {
        const s = runtime.markSaturated(provider, sat.reason, sat.ms);
        eventBus.broadcast({ kind: "runtime", runtime: runtime.snapshot() });
        const alt = runtime.other(provider);
        const name = (p: Provider) => (p === "codex" ? "Codex" : "Claude Code");
        const back = new Date(s.until).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
        if (runtime.isAvailable(alt) && engine === "auto") {
          if (mid) this.chatNote(mid, agentId, `${name(provider)} ${sat.reason} (vuelve ~${back}). Le paso tu mensaje a ${name(alt)}.`);
          eventBus.broadcast({ kind: "chat", agentId, missionId: mid, delta: "", done: true });
          await this.chat(agentId, message, missionId, alt).catch((e) => eventBus.broadcast({ kind: "chat", agentId, missionId: mid, delta: "", done: true, error: (e as Error).message }));
          return;
        }
      }
      eventBus.broadcast({ kind: "chat", agentId, missionId: mid, delta: "", done: true, error: err });
      if (change && !err) {
        // Aprender de la corrección: la lección que propone el agente, y cuenta en contra de las lecciones que se usaron.
        const { lessons } = extractLessons(finalText);
        if (lessons.length) this.learn(mission!.id, agentId, lessons.slice(0, 1), change.cfg.id, "correccion");
        recordCorrection(mission!.lessonIds ?? [], mission!.id);
      }
      if (change && !err)
        await this.deliverChatChange(mission!, agentId, change, message).catch((e) => {
          const g = e instanceof GitError ? explainGitError(e.message, e.output) : null;
          this.chatNote(
            mission!.id,
            agentId,
            g
              ? `No pude publicar el cambio: ${g.title}.\n\n${g.hint}\n\nEl commit quedó guardado en la carpeta de la misión; cuando esté resuelto, escríbeme "publica los cambios".\n\nDetalle de git:\n\`\`\`\n${tailText(`${e.message}\n${(e as GitError).output}`, 1500)}\n\`\`\``
              : `No pude publicar el cambio: ${(e as Error).message}`,
          );
          if (repo.getMission(mission!.id)?.status === "committing") this.setMission(mission!.id, { status: "done" });
        });
    })();
  }

  /** Entregas de la misión que están en una rama agentic/… (candidatas a pasarse a la rama base). */
  private agenticDeliveries(m: Mission): { repositoryId: string; branch: string; base: string; worktree: string | null }[] {
    if (m.repos.length) return m.repos.filter((r) => r.branch?.startsWith("agentic/")).map((r) => ({ repositoryId: r.repositoryId, branch: r.branch!, base: r.baseBranch, worktree: r.worktree }));
    return m.branch?.startsWith("agentic/") ? [{ repositoryId: m.repositoryId, branch: m.branch, base: m.baseBranch, worktree: m.worktree }] : [];
  }

  /** Estado real de la misión para el chat (evita que el agente responda con un contexto viejo). */
  private missionState(m: Mission): string {
    const deliveries = m.repos.length
      ? m.repos.filter((r) => r.branch).map((r) => `${r.repositoryId}: commit ${r.commitSha?.slice(0, 7) ?? "—"} en \`${r.branch}\`${r.pushed ? " (publicado)" : " (sin publicar)"} desde ${r.baseBranch}`)
      : m.branch
        ? [`commit ${m.commitSha?.slice(0, 7) ?? "—"} en \`${m.branch}\`${m.pushed ? " (publicado)" : " (sin publicar)"} desde ${m.baseBranch}`]
        : [];
    const ci = (m.ci ?? []).map((c) => `${c.repositoryId}: ${c.state}`).join(", ");
    return `[Estado REAL de la misión ${m.id} (${m.status}) según la oficina: ${deliveries.length ? deliveries.join("; ") : "sin entrega de código"}${ci ? `; GitHub Actions: ${ci}` : ""}. Git (commit, push, ramas) lo hace la oficina: si el usuario pide pasar los cambios directo a la rama base o reintentar la publicación, la oficina lo ejecuta. No inventes el estado ni atribuyas la decisión a instrucciones de planificación.]\n\n`;
  }

  /** Pasa los commits de la misión (rama agentic/…) a su rama base, publica y espera GitHub Actions. */
  private async promoteToBase(m: Mission, agentId: AgentId): Promise<void> {
    const multi = m.repos.length > 1;
    const lines: string[] = [];
    const rt = newRuntime();
    this.active.set(m.id, rt);
    try {
      for (const d of this.agenticDeliveries(m)) {
        const cfg = this.repoConfig(d.repositoryId);
        if (isProtected(d.base)) {
          lines.push(`${multi ? `${cfg.name}: ` : ""}\`${d.base}\` está protegida, así que no publico directo ahí; los cambios siguen en \`${d.branch}\` para abrir un PR.`);
          continue;
        }
        if (!d.worktree || !fs.existsSync(d.worktree)) {
          lines.push(`${multi ? `${cfg.name}: ` : ""}la carpeta de la misión ya no existe; no puedo mover los cambios.`);
          continue;
        }
        const w: WorkRepo = { cfg, base: d.base, wt: d.worktree };
        rt.repos.set(cfg.id, w);
        this.setMission(m.id, { status: "committing" });
        await gitManager.push(w.wt, d.base);
        const sha = await gitManager.headSha(w.wt);
        this.emit(m.id, "atlas", { provider: "git", sessionId: null, type: "GIT_PUSH", title: `Cambios publicados directo en ${d.base}${multi ? ` (${cfg.name})` : ""}`, detail: `commit ${sha.slice(0, 7)} · antes en ${d.branch}`, status: "success", metadata: { branch: d.base, repositoryId: cfg.id } });
        repo.insertDelivery({ missionId: m.id, kind: "push", ref: `${cfg.id}:${d.base}` });
        const res: MissionRepo = { repositoryId: cfg.id, baseBranch: d.base, worktree: d.worktree, branch: d.base, commitSha: sha, pushed: true, prUrl: null };
        if (multi) m.repos = m.repos.map((r) => (r.repositoryId === cfg.id ? { ...r, branch: d.base, commitSha: sha, pushed: true } : r));
        this.setMission(m.id, multi ? { repos: m.repos } : { branch: d.base, commitSha: sha, pushed: true });
        let ciText = "";
        if (config.ciWaitEnabled) {
          this.setMission(m.id, { status: "ci" });
          const ci = await this.ciLoop(m.id, m, w, res, repo.getMission(m.id)!.steps, rt, multi);
          ciText = ci.state === "success" ? " GitHub Actions: ✅ en verde." : ` GitHub Actions: ${ci.state === "failure" || ci.state === "timeout" ? "❌" : "⚠️"} ${ci.detail}`;
          if (!multi) this.setMission(m.id, { commitSha: res.commitSha });
        }
        lines.push(`${multi ? `${cfg.name}: ` : ""}listo, los cambios (commit \`${(res.commitSha ?? sha).slice(0, 7)}\`) ya están directo en \`${d.base}\`. La rama \`${d.branch}\` queda como respaldo.${ciText}`);
      }
    } finally {
      this.active.delete(m.id);
      const cur = repo.getMission(m.id);
      if (cur && (cur.status === "committing" || cur.status === "ci")) this.setMission(m.id, { status: "done" });
    }
    this.chatNote(m.id, agentId, lines.join("\n") || "No había entregas en ramas agentic/… que pasar a la rama base.");
  }

  /** Repo y carpeta donde un agente puede aplicar por chat un cambio sobre una misión terminada. */
  private chatChangeTarget(m: Mission, agentId: AgentId): WorkRepo | null {
    const ids = m.repos.length ? m.repos.map((r) => r.repositoryId) : [m.repositoryId];
    const mine = m.steps.find((s) => s.agentId === agentId && s.kind === "agent" && s.repositoryId)?.repositoryId;
    const rid = mine && ids.includes(mine) ? mine : ids[0];
    const entry = m.repos.find((r) => r.repositoryId === rid);
    const wt = entry?.worktree ?? m.worktree;
    if (!wt || !fs.existsSync(wt)) throw new MissionError(`La carpeta de trabajo de la misión ${m.id} ya no existe; lanza una misión nueva para este cambio.`, 409);
    let cfg: RepositoryConfig;
    try {
      cfg = this.repoConfig(rid);
    } catch (e) {
      throw new MissionError((e as Error).message, 409);
    }
    return { cfg, base: entry?.baseBranch ?? m.baseBranch, wt };
  }

  /** Mensaje del sistema en el chat del agente (se ve en su conversación). */
  private chatNote(missionId: string, agentId: AgentId, text: string): void {
    eventBus.publish({ missionId, agentId, provider: "system", sessionId: null, type: "AGENT_MESSAGE", title: firstLine(text, 120), detail: text, status: "info", metadata: { chat: true } });
  }

  /** Tras un cambio pedido por chat: commit en la rama de la misión, publicación y espera de GitHub Actions. */
  private async deliverChatChange(m: Mission, agentId: AgentId, w: WorkRepo, message: string): Promise<void> {
    // Sin cambios nuevos pero con commits sin publicar (p. ej. un push que falló antes) también se publica.
    const dirty = (await gitManager.status(w.wt)).trim();
    const onBranch = (await gitManager.currentBranch(w.wt).catch(() => "HEAD")).startsWith("agentic/");
    if (!dirty && !onBranch && (await gitManager.aheadOf(w.wt, w.base)) === 0) {
      this.chatNote(m.id, agentId, "No quedaron cambios en la carpeta de la misión, así que no hay nada que publicar.");
      return;
    }
    const rt = newRuntime();
    rt.repos.set(w.cfg.id, w);
    rt.lastWriter.set(w.cfg.id, agentId);
    this.active.set(m.id, rt);
    const multi = m.repos.length > 1;
    const prev = { status: m.status, error: m.error };
    try {
      this.setMission(m.id, { status: "committing" });
      const steps = repo.getMission(m.id)!.steps;
      const res = await this.deliverRepo(m.id, m, w, steps, rt, deliveryPrefs(m.prompt), multi, `ajuste por chat: ${firstLine(message, 50)}`);
      const patchRepos = multi ? { repos: m.repos.map((r) => (r.repositoryId === res.repositoryId ? { ...r, ...res } : r)) } : {};
      const isMain = !multi || res.repositoryId === m.repositoryId;
      this.setMission(m.id, { ...patchRepos, ...(isMain ? { branch: res.branch, commitSha: res.commitSha, pushed: res.pushed, prUrl: res.prUrl ?? m.prUrl } : {}) });
      let ciText = "";
      if (res.pushed && res.commitSha && res.branch && config.ciWaitEnabled) {
        this.setMission(m.id, { status: "ci" });
        const ci = await this.ciLoop(m.id, m, w, res, steps, rt, multi);
        ciText =
          ci.state === "success" ? " GitHub Actions: ✅ en verde." : ci.state === "failure" || ci.state === "timeout" ? ` GitHub Actions: ❌ ${ci.detail}` : ` GitHub Actions: ⚠️ ${ci.detail}`;
        if (isMain) this.setMission(m.id, { commitSha: res.commitSha });
      }
      this.setMission(m.id, { status: prev.status === "failed" ? "failed" : "done", error: prev.error });
      this.chatNote(
        m.id,
        agentId,
        res.commitSha
          ? `Listo: commit \`${res.commitSha.slice(0, 7)}\` en \`${res.branch}\`${res.pushed ? " (publicado)" : " (sin publicar)"}.${ciText}`
          : "No se creó commit (no había cambios que guardar).",
      );
    } finally {
      this.active.delete(m.id);
    }
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
