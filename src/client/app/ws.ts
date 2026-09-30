import type { WsServerMessage } from "../../shared/types";
import { useStore } from "./store";

type Listener = (m: WsServerMessage) => void;
const listeners = new Set<Listener>();

export function onServerMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Conexión WebSocket con reconexión exponencial. Sin polling. */
export function connectWs(): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      useStore.getState().setConnected(true);
    };
    ws.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const s = useStore.getState();
      switch (msg.kind) {
        case "hello":
          s.hydrate(msg.snapshot);
          break;
        case "event":
          s.addEvent(msg.event);
          break;
        case "mission":
          s.upsertMission(msg.mission);
          break;
        case "runtime":
          s.setRuntime(msg.runtime);
          break;
        case "session":
          s.upsertSession(msg.session);
          break;
        case "chat":
          if (msg.done) {
            s.setChatBusy(msg.agentId, false);
            if (msg.error) s.pushChat({ id: `err-${Date.now()}`, agentId: msg.agentId, from: "system", text: msg.error, at: new Date().toISOString() });
          }
          break;
      }
      for (const l of listeners) l(msg);
    };
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      if (closed) return;
      retry++;
      timer = setTimeout(open, Math.min(8000, 400 * 2 ** retry));
    };
  };
  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
