import { useEffect, useRef, useState } from "react";
import type { AgentId } from "../../shared/types";
import { agentOf as getAgent } from "../app/team";
import { useStore } from "../app/store";
import { ChatView } from "./AgentDrawer";

const POS_KEY = "lrd.chatWindow.pos";

function readPos(): { x: number; y: number; w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
    return v && typeof v.x === "number" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ventana de chat con un agente: más espacio que la ficha, movible (arrastrando el encabezado)
 * y redimensionable (esquina inferior derecha). Recuerda su posición en este navegador.
 */
export function ChatWindow({ onChatSent, onFocusAgent }: { onChatSent: (id: AgentId) => void; onFocusAgent: (id: AgentId) => void }) {
  const agentId = useStore((s) => s.chatWindow);
  const close = useStore((s) => s.setChatWindow);
  useStore((s) => s.team);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(readPos);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!agentId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && document.activeElement?.closest(".chat-window") && close(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentId, close]);

  // Guardar tamaño cuando el usuario lo cambia desde la esquina.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }));
      } catch {
        /* sin almacenamiento */
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [agentId]);

  if (!agentId) return null;
  const a = getAgent(agentId);
  const style = pos
    ? {
        left: Math.max(0, Math.min(pos.x, window.innerWidth - 240)),
        top: Math.max(60, Math.min(pos.y, window.innerHeight - 120)),
        width: pos.w,
        height: pos.h,
      }
    : undefined;

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = ref.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy, w: r.width, h: r.height });
  };
  const onUp = () => {
    drag.current = null;
    const r = ref.current?.getBoundingClientRect();
    if (r)
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }));
      } catch {
        /* sin almacenamiento */
      }
  };

  return (
    <section ref={ref} className="chat-window glass" style={style} aria-label={`Chat con ${a.name}`}>
      <header className="chat-window-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <i style={{ background: a.color }} />
        <div className="grow">
          <b>{a.name}</b>
          <small>{a.role}</small>
        </div>
        <button className="link" onClick={() => onFocusAgent(agentId)} title="Ver su ficha y ubicarlo en la oficina">
          Ver ficha
        </button>
        <button className="icon-btn" onClick={() => close(null)} aria-label="Cerrar chat">
          ×
        </button>
      </header>
      <ChatView agentId={agentId} onSent={onChatSent} />
    </section>
  );
}
