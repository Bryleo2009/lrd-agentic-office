import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Snapshot, WsServerMessage } from "../../shared/types";
import { eventBus } from "../events/AgentEventBus";

/** WebSocket /ws: snapshot inicial + push de eventos. Sin polling. */
export function registerWs(app: FastifyInstance, getSnapshot: () => Promise<Snapshot>): void {
  const clients = new Set<WebSocket>();

  eventBus.on("message", (msg: WsServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  });

  app.get("/ws", { websocket: true }, async (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    try {
      const snapshot = await getSnapshot();
      socket.send(JSON.stringify({ kind: "hello", snapshot } satisfies WsServerMessage));
    } catch (e) {
      app.log.error(e);
    }
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.ping();
      else clearInterval(ping);
    }, 25_000);
  });
}
