import { useEffect } from "react";
import type { Mission, MissionQuestion } from "../../shared/types";
import { useStore } from "../app/store";
import { agentOf as getAgent } from "../app/team";
import { ago } from "../app/useFloating";
import { QuestionCard } from "./MissionHud";

/** Preguntas y aprobaciones abiertas de todas las misiones (más antiguas primero). */
export function openDecisions(missions: Record<string, Mission>): { m: Mission; q: MissionQuestion }[] {
  return Object.values(missions)
    .flatMap((m) => (m.questions ?? []).filter((q) => q.status === "open").map((q) => ({ m, q })))
    .sort((a, b) => a.q.askedAt.localeCompare(b.q.askedAt));
}

/**
 * Bandeja de decisiones: todo lo que espera tu respuesta o aprobación, de todas las misiones, en un
 * solo lugar. Se responde ahí mismo. Abajo, lo que decidiste hace poco.
 */
export function DecisionsInbox({ onOpenMission }: { onOpenMission: (missionId: string) => void }) {
  const open = useStore((s) => s.inboxOpen);
  const setOpen = useStore((s) => s.setInboxOpen);
  const missions = useStore((s) => s.missions);
  useStore((s) => s.team);
  const pending = openDecisions(missions);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const recent = Object.values(missions)
    .flatMap((m) => (m.questions ?? []).filter((q) => q.status === "answered").map((q) => ({ m, q })))
    .sort((a, b) => (b.q.answeredAt ?? "").localeCompare(a.q.answeredAt ?? ""))
    .slice(0, 8);

  return (
    <section className="inbox glass" aria-label="Decisiones pendientes">
      <header className="inbox-head">
        <div className="grow">
          <b>Decisiones</b>
          <small className="muted">{pending.length ? `${pending.length} esperan tu respuesta` : "Nada pendiente"}</small>
        </div>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar">
          ×
        </button>
      </header>
      <div className="inbox-body">
        {pending.length === 0 && <div className="empty">Nada que decidir. Cuando un agente te pregunte algo o una entrega necesite tu aprobación, aparecerá aquí.</div>}
        {pending.map(({ m, q }) => (
          <div key={q.id} className="inbox-item">
            <button className="inbox-mission" onClick={() => onOpenMission(m.id)} title="Ver el avance de esta misión">
              #{m.id} · {m.prompt.slice(0, 70)}
              {m.prompt.length > 70 ? "…" : ""} · {ago(q.askedAt)}
            </button>
            <QuestionCard mission={m} q={q} />
          </div>
        ))}
        {recent.length > 0 && (
          <>
            <div className="inbox-sep">Decidido hace poco</div>
            <ul className="inbox-recent">
              {recent.map(({ m, q }) => (
                <li key={q.id}>
                  <span className="muted">
                    #{m.id} · {getAgent(q.agentId).name} · {q.answeredAt ? ago(q.answeredAt) : ""}
                  </span>
                  <span>
                    {q.text} → <b>{q.answer}</b>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
