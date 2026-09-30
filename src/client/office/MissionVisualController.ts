import { isAgentId } from "../../shared/agents";
import { agentOf as getAgent } from "../app/team";
import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId, Mission } from "../../shared/types";
import type { OfficeEngine } from "./OfficeEngine";

const strip = (s: string, agent: AgentId) => s.replace(new RegExp(`^${getAgent(agent).name}:\\s*`), "");

/**
 * Traduce eventos REALES (WebSocket) a comportamiento visual.
 * Nunca inventa actividad: si no hay evento, el agente sigue con su vida ambiental.
 */
export class MissionVisualController {
  /** Agentes con un paso real en curso. */
  private active = new Set<AgentId>();
  private meetings = new Map<string, AgentId[]>();
  private screenMission: Mission | null = null;
  private lastEventTitle: string[] = [];
  private screenTimer: ReturnType<typeof setTimeout> | null = null;
  private chatting = new Set<AgentId>();

  constructor(private engine: OfficeEngine) {}

  /** Estado inicial al conectar: pasos que ya estaban corriendo (sin reproducir el historial). */
  bootstrap(missions: Mission[]): void {
    const running = missions.find((m) => ["preparing", "planning", "running", "qa", "committing"].includes(m.status));
    if (running) {
      this.screenMission = running;
      for (const s of running.steps.filter((s) => s.status === "running")) {
        this.active.add(s.agentId);
        const where = s.kind === "qa" ? "qa_terminal" : s.kind === "plan" ? "mission_screen" : "desk";
        this.engine.brain(s.agentId)?.setReal({ where, action: s.kind === "qa" ? "test" : s.kind === "plan" ? "think" : "type", tone: s.kind === "qa" ? "test" : "work" });
      }
    } else this.screenMission = missions[0] ?? null;
    this.renderScreen();
  }

  onMission(m: Mission): void {
    if (!this.screenMission || this.screenMission.id === m.id || ["created", "preparing"].includes(m.status)) this.screenMission = m;
    if (["done", "failed", "cancelled"].includes(m.status)) {
      // Fin de misión: todos vuelven a su vida normal tras un momento
      const involved = new Set(m.steps.map((s) => s.agentId));
      involved.add("atlas");
      setTimeout(() => {
        for (const a of involved) {
          if (this.chatting.has(a)) continue;
          this.active.delete(a);
          this.engine.brain(a)?.clearReal(m.status === "failed" ? 4 : 2);
        }
      }, 3500);
      this.engine.scene.setTestBench(m.status === "done" ? "pass" : m.status === "failed" ? "fail" : "idle");
    }
    this.renderScreen();
  }

  private renderScreen(): void {
    if (this.screenTimer) return;
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null;
      const m = this.screenMission;
      const st = m?.status;
      const state = !m ? "idle" : st === "done" ? "done" : st === "failed" || st === "cancelled" ? "failed" : "running";
      const lines = m
        ? [`MISIÓN ${m.id} · ${st?.toUpperCase()}`, m.prompt, `${m.repos?.length > 1 ? m.repos.map((r) => r.repositoryId).join(" + ") : m.repositoryId} · ${m.branch ?? m.baseBranch}`, `motor ${m.provider === "codex" ? "Codex CLI" : "Claude Code"}`, ...this.lastEventTitle.slice(-2)]
        : ["Sin misiones activas", "La oficina está en modo ambiental", "", "", "", ""];
      this.engine.scene.missionScreen.setLines(lines, state);
    }, 400);
  }

  onChat(agentId: AgentId, delta: string, done: boolean, error?: string): void {
    const b = this.engine.brain(agentId);
    const e = this.engine.entity(agentId);
    if (!b || !e) return;
    if (!done) {
      if (!this.chatting.has(agentId)) {
        this.chatting.add(agentId);
        b.setReal({ where: "desk", action: "talk", tone: "talk" });
      }
      e.say(delta.split("\n").find((l) => l.trim()) ?? delta, "talk", 5.5);
      return;
    }
    this.chatting.delete(agentId);
    if (error) e.say(error, "blocked", 5);
    if (this.active.has(agentId)) b.setReal({ action: "type", tone: "work" });
    else b.clearReal(2.5);
  }

  /** Marca al agente como "escuchando" mientras espera la respuesta del CLI. */
  onChatSent(agentId: AgentId): void {
    const b = this.engine.brain(agentId);
    if (!b) return;
    this.chatting.add(agentId);
    b.setReal({ where: "desk", action: "think", tone: "talk" });
  }

  handle(ev: AgentRuntimeEvent): void {
    const a = ev.agentId;
    if (!a || !isAgentId(a)) return;
    const b = this.engine.brain(a);
    const e = this.engine.entity(a);
    if (!b || !e) return;
    const meta = (ev.metadata ?? {}) as Record<string, any>;
    if (ev.missionId && this.screenMission?.id === ev.missionId && !["COMMAND_OUTPUT", "TEST_OUTPUT"].includes(ev.type)) {
      this.lastEventTitle.push(`${getAgent(a).name}: ${ev.title}`);
      if (this.lastEventTitle.length > 4) this.lastEventTitle.shift();
      this.renderScreen();
    }
    const isChat = !!meta.chat;
    const act = (patch: Parameters<typeof b.setReal>[0]) => {
      if (this.active.has(a) || this.chatting.has(a)) b.setReal(patch);
    };

    switch (ev.type) {
      case "MISSION_CREATED":
        this.active.add("atlas");
        b.setReal({ where: "mission_screen", action: "think", tone: "think" });
        e.say("Nueva misión recibida", "think", 3);
        break;
      case "AGENT_STARTED": {
        if (isChat) break;
        this.active.add(a);
        if (a === "vega" && ev.provider === "qa") {
          b.setReal({ where: "qa_terminal", action: "test", tone: "test" });
          this.engine.scene.setTestBench("running");
        } else if (a === "atlas" && ev.provider === "git") b.setReal({ where: "desk", action: "type", tone: "work" });
        else if (a === "atlas" && /planific/i.test(ev.title)) b.setReal({ where: "mission_screen", action: "think", tone: "think" });
        else b.setReal({ where: b.meetingSeat ? "meeting" : "desk", action: "type", tone: "work" });
        e.say(strip(ev.title, a), "work", 3.5);
        break;
      }
      case "AGENT_STATUS":
        if (meta.visual === "THINKING") act({ action: "think", tone: "think" });
        if (ev.title !== "Trabajando…" && (this.active.has(a) || this.chatting.has(a) || ev.status === "warning")) e.say(ev.title, ev.status === "warning" ? "blocked" : "work", 3.5);
        break;
      case "SESSION_CONNECTED":
        if (this.active.has(a)) e.say(ev.title, "work", 2.5);
        break;
      case "FILE_READ":
        act({ action: "read" });
        e.say(`${ev.title}…`, "work", 3);
        break;
      case "SEARCH_STARTED":
        act({ action: "read" });
        e.say(`${ev.title}…`, "work", 2.6);
        break;
      case "TOOL_STARTED":
        act({ action: meta.edit ? "type" : meta.mcp ? "read" : "think" });
        e.say(`${ev.title}…`, "work", 3);
        break;
      case "FILE_CHANGED":
        act({ action: "type" });
        e.say(ev.title, "work", 3);
        break;
      case "COMMAND_STARTED":
        act({ action: "type" });
        e.say(ev.title, "work", 2.6);
        break;
      case "COMMAND_FINISHED":
        if (ev.status === "error") e.say(ev.title, "blocked", 3.5);
        break;
      case "TEST_STARTED":
        if (a === "vega") {
          b.setReal({ where: "qa_terminal", action: "test", tone: "test" });
          this.engine.scene.setTestBench("running");
        } else act({ action: "test", tone: "test" });
        e.say(`${ev.title}…`, "test", 3.5);
        break;
      case "TEST_FINISHED": {
        const ok = ev.status === "success";
        if (a === "vega") this.engine.scene.setTestBench(ok ? "pass" : "fail");
        e.say(ok ? (/build/i.test(ev.command ?? "") ? "Build passed" : ev.title) : ev.title, ok ? "success" : "blocked", 4);
        if (ok && a === "vega") b.pushScenario({ kind: "celebrate" });
        break;
      }
      case "AGENT_MESSAGE":
        if (isChat) break; // el chat se maneja con mensajes "chat"
        if (this.active.has(a)) e.say(ev.title, "work", 4);
        break;
      case "PLAN_CREATED":
        e.say(ev.title, "think", 5);
        break;
      case "HANDOFF": {
        const to = meta.to as AgentId;
        if (!isAgentId(to) || to === a) break;
        if (meta.meetingId) {
          e.say(ev.title, "talk", 4.5);
          break;
        }
        b.pushScenario({ kind: "handoff", to, text: ev.title });
        break;
      }
      case "HANDOFF_CREATED": {
        const from = meta.from as AgentId;
        if (isAgentId(from) && from !== a && !meta.meetingId) setTimeout(() => e.say(`Recibí el contexto de ${getAgent(from).name}`, "talk", 3), 4200);
        break;
      }
      case "MEETING_STARTED": {
        const parts = (meta.participants as AgentId[]).filter(isAgentId);
        this.meetings.set(meta.meetingId, parts);
        for (const p of parts) {
          const pb = this.engine.brain(p);
          if (!pb) continue;
          pb.meetingSeat = this.engine.assignMeetingSeat(p, p === "atlas");
          this.active.add(p);
          pb.setReal({ where: "meeting", action: "talk", tone: "talk" });
        }
        e.say(ev.title, "talk", 4);
        break;
      }
      case "MESSAGE_SENT":
        if (meta.fromUser) break;
        e.say(ev.title, "talk", 4.5);
        break;
      case "MEETING_FINISHED": {
        const parts = this.meetings.get(meta.meetingId) ?? [];
        this.meetings.delete(meta.meetingId);
        const receiver = a;
        // La reunión real terminó; visualmente se cierra cuando todos llegaron y conversaron un momento.
        const t0 = performance.now();
        const tryEnd = () => {
          const ready = parts.every((p) => this.engine.brain(p)?.meetingReadyFor(3.5));
          if (!ready && performance.now() - t0 < 30000) return void setTimeout(tryEnd, 400);
          for (const p of parts) {
            const pb = this.engine.brain(p);
            if (!pb) continue;
            pb.meetingSeat = null;
            this.engine.releaseMeetingSeat(p);
            if (p !== receiver || !this.active.has(p)) {
              this.active.delete(p);
              pb.clearReal(0.5);
            } else pb.setReal({ where: "desk" });
          }
        };
        tryEnd();
        break;
      }
      case "GIT_FETCH":
      case "GIT_BRANCH":
      case "GIT_WORKTREE":
      case "GIT_DIFF":
        e.say(ev.title, "work", 3.2);
        break;
      case "GIT_COMMIT":
        b.pushScenario({ kind: "celebrate", text: ev.title });
        break;
      case "GIT_PUSH":
        e.say(ev.title, "success", 3.5);
        break;
      case "PR_CREATED":
        b.pushScenario({ kind: "celebrate", text: ev.title });
        break;
      case "AGENT_WAITING":
        act({ action: "think", tone: "think" });
        e.say(ev.title, "think", 3);
        break;
      case "AGENT_BLOCKED":
      case "AGENT_ERROR":
        if (isChat) break;
        if (ev.type === "AGENT_ERROR" && meta.cancelled) break;
        b.pushScenario({ kind: "blocked", text: ev.title });
        if (ev.type === "AGENT_BLOCKED") {
          this.active.delete(a);
          b.clearReal(7);
        }
        break;
      case "AGENT_FINISHED":
        if (isChat) break;
        if (meta.missionDone) {
          b.pushScenario({ kind: "celebrate", text: ev.title });
          break;
        }
        if (a === "vega" && ev.provider === "qa") {
          this.active.delete(a);
          b.clearReal(2.5);
          break;
        }
        if (ev.provider === "codex" || ev.provider === "claude") {
          b.pushScenario({ kind: "celebrate", text: "Listo" });
          this.active.delete(a);
          b.clearReal(2.5);
        }
        break;
      default:
        break;
    }
  }
}
