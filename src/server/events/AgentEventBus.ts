import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { AgentRuntimeEvent, RuntimeEventInput } from "../../shared/events";
import type { WsServerMessage } from "../../shared/types";
import { insertEvent } from "../database/repo";

/**
 * Bus central de eventos reales.
 * publish() → persiste en SQLite → difunde a los suscriptores (WebSocket hub).
 * COMMAND_OUTPUT / TEST_OUTPUT se limitan para no saturar la UI.
 */
class AgentEventBusImpl extends EventEmitter {
  private lastOutputAt = new Map<string, number>();

  publish(input: RuntimeEventInput): AgentRuntimeEvent {
    const ev: AgentRuntimeEvent = {
      ...input,
      id: input.id ?? nanoid(12),
      timestamp: input.timestamp ?? new Date().toISOString(),
      detail: input.detail ?? null,
      tool: input.tool ?? null,
      command: input.command ?? null,
      file: input.file ?? null,
      status: input.status ?? null,
      metadata: input.metadata ?? null,
    };
    insertEvent(ev);
    if (ev.type === "COMMAND_OUTPUT" || ev.type === "TEST_OUTPUT") {
      const key = `${ev.missionId}:${ev.agentId}:${ev.type}`;
      const last = this.lastOutputAt.get(key) ?? 0;
      if (Date.now() - last < 250) return ev; // persistido, no difundido
      this.lastOutputAt.set(key, Date.now());
    }
    this.broadcast({ kind: "event", event: ev });
    return ev;
  }

  broadcast(msg: WsServerMessage): void {
    this.emit("message", msg);
  }
}

export const eventBus = new AgentEventBusImpl();
eventBus.setMaxListeners(100);
