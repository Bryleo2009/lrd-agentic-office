import { and, asc, desc, eq } from "drizzle-orm";
import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId, AgentSessionInfo, Mission, MissionStep, Provider } from "../../shared/types";
import { db, schema, sqlite } from "./db";

const now = () => new Date().toISOString();

function safeList(v: unknown): string[] {
  try {
    const j = JSON.parse(String(v ?? "[]"));
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

// ---------- missions ----------
export function insertMission(m: Mission): void {
  const { steps, ...row } = m;
  db.insert(schema.missions)
    .values({ ...row, mcpServers: JSON.stringify(m.mcpServers ?? []), repos: JSON.stringify(m.repos ?? []), ci: JSON.stringify(m.ci ?? []), checklist: JSON.stringify(m.checklist ?? []), questions: JSON.stringify(m.questions ?? []), lessonIds: JSON.stringify(m.lessonIds ?? []) })
    .run();
}

export function updateMission(id: string, patch: Partial<Omit<Mission, "id" | "steps">>): void {
  const { mcpServers, repos, ci, checklist, questions, lessonIds, ...rest } = patch;
  const json = (k: string, v: unknown) => (v ? { [k]: JSON.stringify(v) } : {});
  db.update(schema.missions)
    .set({ ...rest, ...json("mcpServers", mcpServers), ...json("repos", repos), ...json("ci", ci), ...json("checklist", checklist), ...json("questions", questions), ...json("lessonIds", lessonIds), updatedAt: now() })
    .where(eq(schema.missions.id, id))
    .run();
}

function rowToStep(r: typeof schema.missionSteps.$inferSelect): MissionStep {
  return {
    id: r.id,
    missionId: r.missionId,
    agentId: r.agentId as AgentId,
    title: r.title,
    task: r.task,
    dependsOn: JSON.parse(r.dependsOn),
    writes: !!r.writes,
    kind: r.kind as MissionStep["kind"],
    status: r.status as MissionStep["status"],
    provider: (r.provider as Provider) ?? null,
    sessionId: r.sessionId,
    result: r.result,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    repositoryId: r.repositoryId ?? null,
  };
}

function safeRepos(v: string | null | undefined): Mission["repos"] {
  try {
    const a = JSON.parse(v ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function getMission(id: string): Mission | null {
  const r = db.select().from(schema.missions).where(eq(schema.missions.id, id)).get();
  if (!r) return null;
  const steps = db
    .select()
    .from(schema.missionSteps)
    .where(eq(schema.missionSteps.missionId, id))
    .orderBy(asc(schema.missionSteps.position))
    .all()
    .map(rowToStep);
  return { ...(r as any), pushed: !!r.pushed, allowMcp: !!r.allowMcp, mcpServers: safeList(r.mcpServers), repos: safeRepos(r.repos), ci: safeRepos(r.ci) as unknown as Mission["ci"], checklist: safeRepos(r.checklist) as unknown as Mission["checklist"], questions: safeRepos(r.questions) as unknown as Mission["questions"], taskKind: (r.taskKind ?? "general") as Mission["taskKind"], lessonIds: safeList(r.lessonIds), steps } as Mission;
}

export function listMissions(limit = 30): Mission[] {
  return db
    .select({ id: schema.missions.id })
    .from(schema.missions)
    .orderBy(desc(schema.missions.createdAt))
    .limit(limit)
    .all()
    .map((r) => getMission(r.id)!)
    .filter(Boolean);
}

export function replaceSteps(missionId: string, steps: MissionStep[]): void {
  db.delete(schema.missionSteps).where(eq(schema.missionSteps.missionId, missionId)).run();
  steps.forEach((s, i) => {
    db.insert(schema.missionSteps)
      .values({ ...s, dependsOn: JSON.stringify(s.dependsOn), position: i })
      .run();
  });
}

export function addStep(step: MissionStep, position: number): void {
  db.insert(schema.missionSteps).values({ ...step, dependsOn: JSON.stringify(step.dependsOn), position }).run();
}

export function updateStep(id: string, patch: Partial<MissionStep>): void {
  const { dependsOn, ...rest } = patch;
  const set: Record<string, unknown> = { ...rest };
  if (dependsOn) set.dependsOn = JSON.stringify(dependsOn);
  db.update(schema.missionSteps).set(set).where(eq(schema.missionSteps.id, id)).run();
}

// ---------- events ----------
export function insertEvent(e: AgentRuntimeEvent): void {
  db.insert(schema.runtimeEvents)
    .values({
      id: e.id,
      timestamp: e.timestamp,
      missionId: e.missionId,
      agentId: e.agentId,
      provider: e.provider,
      sessionId: e.sessionId,
      type: e.type,
      title: e.title,
      detail: e.detail ?? null,
      tool: e.tool ?? null,
      command: e.command ?? null,
      file: e.file ?? null,
      status: e.status ?? null,
      metadata: e.metadata ? JSON.stringify(e.metadata) : null,
    })
    .run();
}

function rowToEvent(r: typeof schema.runtimeEvents.$inferSelect): AgentRuntimeEvent {
  return { ...(r as any), metadata: r.metadata ? JSON.parse(r.metadata) : null };
}

export function recentEvents(limit = 200): AgentRuntimeEvent[] {
  return db.select().from(schema.runtimeEvents).orderBy(desc(schema.runtimeEvents.timestamp)).limit(limit).all().map(rowToEvent).reverse();
}

export function missionEvents(missionId: string): AgentRuntimeEvent[] {
  return db.select().from(schema.runtimeEvents).where(eq(schema.runtimeEvents.missionId, missionId)).orderBy(asc(schema.runtimeEvents.timestamp)).all().map(rowToEvent);
}

export function agentEvents(agentId: AgentId, limit = 150): AgentRuntimeEvent[] {
  return db
    .select()
    .from(schema.runtimeEvents)
    .where(eq(schema.runtimeEvents.agentId, agentId))
    .orderBy(desc(schema.runtimeEvents.timestamp))
    .limit(limit)
    .all()
    .map(rowToEvent)
    .reverse();
}

export function getEvent(id: string): AgentRuntimeEvent | null {
  const r = db.select().from(schema.runtimeEvents).where(eq(schema.runtimeEvents.id, id)).get();
  return r ? rowToEvent(r) : null;
}

// ---------- sessions ----------
export function upsertSession(s: AgentSessionInfo & { cliSessionId?: string | null }): void {
  const existing = db
    .select()
    .from(schema.agentSessions)
    .where(and(eq(schema.agentSessions.missionId, s.missionId), eq(schema.agentSessions.agentId, s.agentId)))
    .get();
  if (existing) {
    db.update(schema.agentSessions)
      .set({ provider: s.provider, cliSessionId: s.sessionId, cwd: s.cwd, status: s.status, updatedAt: now() })
      .where(eq(schema.agentSessions.id, existing.id))
      .run();
  } else {
    db.insert(schema.agentSessions)
      .values({ missionId: s.missionId, agentId: s.agentId, provider: s.provider, cliSessionId: s.sessionId, cwd: s.cwd, status: s.status, startedAt: s.startedAt, updatedAt: now() })
      .run();
  }
}

export function listSessions(limit = 100): AgentSessionInfo[] {
  return db
    .select()
    .from(schema.agentSessions)
    .orderBy(desc(schema.agentSessions.updatedAt))
    .limit(limit)
    .all()
    .map((r) => ({
      missionId: r.missionId,
      agentId: r.agentId as AgentId,
      provider: r.provider as Provider,
      sessionId: r.cliSessionId,
      cwd: r.cwd,
      status: r.status as AgentSessionInfo["status"],
      startedAt: r.startedAt,
    }));
}

// ---------- handoffs / branches / deliveries ----------
export function insertHandoff(h: { id: string; missionId: string; fromAgent: AgentId; toAgent: AgentId; title: string; payload: string }): void {
  db.insert(schema.handoffs).values({ ...h, createdAt: now() }).run();
}

export function missionHandoffs(missionId: string) {
  return db.select().from(schema.handoffs).where(eq(schema.handoffs.missionId, missionId)).orderBy(asc(schema.handoffs.createdAt)).all();
}

export function insertBranch(b: { repositoryId: string; missionId: string; name: string; base: string; worktree: string }): void {
  db.insert(schema.branches).values({ ...b, createdAt: now() }).run();
}

export function insertDelivery(d: { missionId: string; kind: string; ref: string; detail?: string }): void {
  db.insert(schema.deliveries).values({ ...d, detail: d.detail ?? null, createdAt: now() }).run();
}

export function upsertRepository(r: { id: string; name: string; github: string; cloneUrl: string; localPath?: string | null; lastFetchAt?: string | null }): void {
  const ex = db.select().from(schema.repositories).where(eq(schema.repositories.id, r.id)).get();
  if (ex) db.update(schema.repositories).set(r).where(eq(schema.repositories.id, r.id)).run();
  else db.insert(schema.repositories).values(r).run();
}

// ---------- reanudación ----------
/** Misiones que quedaron en curso (el servidor se detuvo en medio). */
export function interruptedMissionIds(): string[] {
  return (
    sqlite
      .prepare(`SELECT id FROM missions WHERE status IN ('created','preparing','planning','running','qa','committing','ci','waiting') ORDER BY created_at`)
      .all() as { id: string }[]
  ).map((r) => r.id);
}

/** Suma un intento de reanudación y devuelve el total. */
export function bumpResume(id: string): number {
  sqlite.prepare("UPDATE missions SET resumes = resumes + 1 WHERE id = ?").run(id);
  return (sqlite.prepare("SELECT resumes FROM missions WHERE id = ?").get(id) as { resumes: number } | undefined)?.resumes ?? 0;
}
