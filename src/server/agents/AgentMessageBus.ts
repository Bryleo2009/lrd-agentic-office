import { nanoid } from "nanoid";
import { profile as getAgent } from "../settings";
import type { AgentId } from "../../shared/types";
import { insertHandoff, missionHandoffs } from "../database/repo";
import { eventBus } from "../events/AgentEventBus";

export interface Handoff {
  id: string;
  missionId: string;
  from: AgentId;
  to: AgentId;
  title: string;
  payload: string;
}

/**
 * Intercambio REAL de información entre agentes.
 * El payload es el resultado real producido por el agente origen y se inyecta en la tarea del destino.
 */
class AgentMessageBusImpl {
  private inbox = new Map<string, Handoff[]>();

  private key(missionId: string, to: AgentId) {
    return `${missionId}:${to}`;
  }

  handoff(missionId: string, from: AgentId, to: AgentId, title: string, payload: string, meetingId?: string): Handoff {
    const h: Handoff = { id: nanoid(10), missionId, from, to, title, payload };
    insertHandoff({ id: h.id, missionId, fromAgent: from, toAgent: to, title, payload });
    const k = this.key(missionId, to);
    this.inbox.set(k, [...(this.inbox.get(k) ?? []), h]);
    const base = { missionId, provider: "system" as const, sessionId: null };
    eventBus.publish({
      ...base,
      agentId: from,
      type: "HANDOFF",
      title,
      detail: payload.slice(0, 4000),
      status: "info",
      metadata: { from, to, handoffId: h.id, meetingId: meetingId ?? null, toName: getAgent(to).name },
    });
    eventBus.publish({
      ...base,
      agentId: to,
      type: "HANDOFF_CREATED",
      title: `${getAgent(to).name} recibió contexto de ${getAgent(from).name}`,
      detail: title,
      status: "info",
      metadata: { from, to, handoffId: h.id, meetingId: meetingId ?? null },
    });
    return h;
  }

  /** Consume los handoffs pendientes del agente destino. */
  take(missionId: string, to: AgentId): Handoff[] {
    const k = this.key(missionId, to);
    const hs = this.inbox.get(k) ?? [];
    this.inbox.delete(k);
    return hs;
  }

  history(missionId: string): Handoff[] {
    return missionHandoffs(missionId).map((r) => ({
      id: r.id,
      missionId: r.missionId,
      from: r.fromAgent as AgentId,
      to: r.toAgent as AgentId,
      title: r.title,
      payload: r.payload,
    }));
  }

  meeting(missionId: string, participants: AgentId[], topic: string): string {
    const meetingId = nanoid(8);
    eventBus.publish({
      missionId,
      agentId: participants[participants.length - 1],
      provider: "system",
      sessionId: null,
      type: "MEETING_STARTED",
      title: topic,
      status: "info",
      metadata: { meetingId, participants },
    });
    for (const p of participants)
      eventBus.publish({
        missionId,
        agentId: p,
        provider: "system",
        sessionId: null,
        type: "AGENT_JOINED_MEETING",
        title: `${getAgent(p).name} se une a la reunión`,
        status: "info",
        metadata: { meetingId, participants },
      });
    return meetingId;
  }

  endMeeting(missionId: string, meetingId: string, participants: AgentId[]): void {
    eventBus.publish({
      missionId,
      agentId: participants[participants.length - 1],
      provider: "system",
      sessionId: null,
      type: "MEETING_FINISHED",
      title: "Reunión terminada",
      status: "info",
      metadata: { meetingId, participants },
    });
  }
}

export const messageBus = new AgentMessageBusImpl();
