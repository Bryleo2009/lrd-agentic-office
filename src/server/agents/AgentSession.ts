import path from "node:path";
import type { AgentId, AgentSessionInfo, Provider } from "../../shared/types";
import { config, paths } from "../config";
import { upsertSession } from "../database/repo";
import { eventBus } from "../events/AgentEventBus";
import type { AgentSession, PermissionProfile } from "../runtime/AgentExecutor";
import { runtime } from "../runtime/RuntimeDetector";

interface Entry {
  session: AgentSession;
  info: AgentSessionInfo;
  busy: boolean;
}

/**
 * Registro de sesiones por (misión, agente). Guarda sólo metadata (ids, cwd, provider).
 * Reutiliza la sesión del CLI entre pasos del mismo agente (resume) cuando el CLI lo soporta.
 */
class AgentSessionRegistry {
  private map = new Map<string, Entry>();

  key(missionId: string | null, agentId: AgentId): string {
    return `${missionId ?? "none"}:${agentId}`;
  }

  get(missionId: string | null, agentId: AgentId): Entry | undefined {
    return this.map.get(this.key(missionId, agentId));
  }

  /** Última sesión conocida del agente (para el chat). */
  latestFor(agentId: AgentId): Entry | undefined {
    let best: Entry | undefined;
    for (const e of this.map.values()) if (e.info.agentId === agentId && (!best || e.info.startedAt > best.info.startedAt)) best = e;
    return best;
  }

  async getOrCreate(opts: { missionId: string | null; agentId: AgentId; provider: Provider; cwd: string; permission: PermissionProfile; mcpAllow?: string[] }): Promise<Entry> {
    const k = this.key(opts.missionId, opts.agentId);
    const ex = this.map.get(k);
    if (ex && ex.session.provider === opts.provider && ex.session.config.cwd === opts.cwd) {
      ex.session.config.permission = opts.permission;
      ex.session.config.mcpAllow = opts.mcpAllow ?? [];
      return ex;
    }
    const exec = runtime.get(opts.provider);
    const session = await exec.startSession({
      missionId: opts.missionId,
      agentId: opts.agentId,
      cwd: opts.cwd,
      permission: opts.permission,
      runDir: path.join(paths.runs, opts.missionId ?? "_chat", opts.agentId),
      timeoutMs: config.stepTimeoutMs,
      mcpAllow: opts.mcpAllow ?? [],
    });
    const info: AgentSessionInfo = {
      missionId: opts.missionId ?? "_chat",
      agentId: opts.agentId,
      provider: opts.provider,
      sessionId: null,
      cwd: opts.cwd,
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    const entry: Entry = { session, info, busy: false };
    this.map.set(k, entry);
    this.sync(entry);
    return entry;
  }

  sync(e: Entry, status?: AgentSessionInfo["status"]): void {
    if (status) e.info.status = status;
    e.info.sessionId = e.session.cliSessionId;
    upsertSession(e.info);
    eventBus.broadcast({ kind: "session", session: { ...e.info } });
  }

  forMission(missionId: string): Entry[] {
    return [...this.map.values()].filter((e) => e.info.missionId === missionId);
  }

  async cancelMission(missionId: string): Promise<void> {
    for (const e of this.forMission(missionId)) {
      await runtime.get(e.session.provider).cancel(e.session);
      this.sync(e, "closed");
    }
  }
}

export const sessions = new AgentSessionRegistry();
