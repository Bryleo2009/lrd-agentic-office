import { useState } from "react";
import type { Mission, MissionQuestion } from "../../shared/types";
import { agentOf as getAgent } from "../app/team";
import { api } from "../app/api";
import { branchesOf, isLive, MISSION_STATUS, repoLabel, STEP_STATUS } from "../app/format";
import { useStore } from "../app/store";

/** Tarjeta flotante compacta de la misión actual (no es un dashboard). */
export function MissionHud({ onAgent }: { onAgent: (id: any) => void }) {
  const missions = useStore((s) => s.missions);
  const order = useStore((s) => s.missionOrder);
  const toast = useStore((s) => s.showToast);
  useStore((s) => s.team);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 760);
  const current = order.map((id) => missions[id]).find((m) => m && isLive(m.status)) ?? missions[order[0]];
  if (!current) return null;
  const live = isLive(current.status);
  const age = Date.now() - new Date(current.updatedAt).getTime();
  if (!live && age > 10 * 60_000) return null;
  const steps = current.steps.filter((s) => s.kind !== "plan" || s.status !== "done");
  const open = (current.questions ?? []).filter((q) => q.status === "open");

  return (
    <div className={`mission-hud glass ${current.status}`}>
      <button className="hud-head" onClick={() => setCollapsed(!collapsed)}>
        <span className={`status-pill ${current.status}`}>{MISSION_STATUS[current.status]}</span>
        <span className="hud-id">#{current.id}</span>
        <span className="hud-engine" title="Motores que usaron los pasos de esta misión (la revisión cruzada usa a propósito el otro motor)">
          {engineLabel(current)}
        </span>
        <span className="chev">{collapsed ? "▸" : "▾"}</span>
      </button>
      {/* Una pregunta abierta siempre se ve, aunque la tarjeta esté plegada. */}
      {open.map((q) => (
        <QuestionCard key={q.id} mission={current} q={q} />
      ))}
      {!collapsed && (
        <>
          <div className="hud-prompt">{current.prompt}</div>
          <div className="hud-steps">
            {steps.map((s) => {
              const a = getAgent(s.agentId);
              return (
                <button key={s.id} className={`step ${s.status}`} onClick={() => onAgent(s.agentId)} title={`${s.title} · ${STEP_STATUS[s.status]}${s.provider ? ` · ${s.provider === "codex" ? "Codex" : "Claude Code"}` : ""}${s.error ? `\n${s.error}` : ""}`}>
                  <i style={{ background: a.color }} />
                  <span>{a.name}</span>
                  <small>
                    {s.kind === "xreview" ? "revisión cruzada" : s.kind === "ci" ? "Actions" : s.kind === "qa" ? "QA" : s.kind === "review" ? "revisión" : s.kind === "plan" ? "plan" : s.writes ? "cambios" : "análisis"}
                    {s.provider ? ` · ${s.provider === "codex" ? "Codex" : "Claude"}` : ""}
                  </small>
                </button>
              );
            })}
          </div>
          <Checklist items={current.checklist ?? []} live={live} />
          <div className="hud-meta">
            {current.repos?.length > 1 && <span>{repoLabel(current)} · en paralelo</span>}
            {branchesOf(current).map((b) => (
              <span key={b.branch + (b.repo ?? "")} title={current.worktree ?? ""}>
                {b.repo ? `${b.repo}: ` : ""}
                <code>{b.branch}</code>
                {b.sha && (
                  <>
                    {" "}
                    commit <code>{b.sha.slice(0, 7)}</code>
                  </>
                )}
              </span>
            ))}
            {current.prUrl && (
              <a href={current.prUrl} target="_blank" rel="noreferrer">
                Ver PR
              </a>
            )}
            {current.planSource === "rules" && <span className="warn-text">plan por reglas</span>}
            {current.taskKind && current.taskKind !== "general" && <span title="Guía de trabajo aplicada (config/guides)">guía: {current.taskKind === "ci-fix" ? "corrección de CI" : "consulta de datos"}</span>}
          </div>
          {current.error && <div className="hud-error">{current.error.split("\n")[0]}</div>}
          <button className="btn tiny ghost" onClick={() => useStore.getState().setTablet(true, current.id)} title="Abrir la tablet de avance del equipo">
            Ver avance
          </button>
          {live && (
            <button
              className="btn tiny ghost"
              onClick={async () => {
                try {
                  await api.cancelMission(current.id);
                } catch (e) {
                  toast((e as Error).message);
                }
              }}
            >
              Cancelar misión
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Checklist de la misión: lo que falta y lo que ya se hizo/verificó. */
export function Checklist({ items, live }: { items: import("../../shared/types").ChecklistItem[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  const done = items.filter((i) => i.status === "done" || i.status === "skipped").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const icon = (st: string) => (st === "done" ? "✓" : st === "failed" ? "✗" : st === "skipped" ? "–" : "○");
  return (
    <div className="hud-checklist">
      <button className="hud-check-head" onClick={() => setOpen(!open)}>
        <span>Checklist</span>
        <span className="hud-check-bar">
          <i style={{ width: `${(done / items.length) * 100}%` }} />
        </span>
        <b>
          {done}/{items.length}
        </b>
        {failed > 0 && <span className="warn-text">{failed} pendiente{failed === 1 ? "" : "s"}</span>}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul>
          {items.map((i) => (
            <li key={i.id} className={i.status} title={i.note ?? ""}>
              <span className="ic">{icon(i.status)}</span>
              <span className="tx">
                {i.text}
                {i.how && i.by && (
                  <small>
                    {" "}
                    · {i.how} por {getAgent(i.by).name}
                    {i.note ? ` — ${i.note}` : ""}
                  </small>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!live && done < items.length && failed === 0 && <div className="muted tiny">Algunos puntos no se marcaron explícitamente; revisa el informe de Atlas.</div>}
    </div>
  );
}

/** Pregunta de un agente o aprobación antes de publicar: la misión espera tu respuesta. */
export function QuestionCard({ mission, q }: { mission: Mission; q: MissionQuestion }) {
  const toast = useStore((s) => s.showToast);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const a = getAgent(q.agentId);
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    try {
      await api.answer(mission.id, q.id, answer.trim());
      setText("");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`hud-question ${q.kind}`} role="group" aria-label={q.kind === "approval" ? "Aprobación pendiente" : "Pregunta pendiente"}>
      <div className="hq-head">
        <i style={{ background: a.color }} />
        <b>{a.name}</b>
        <span>{q.kind === "approval" ? "necesita tu aprobación" : "te pregunta"}</span>
      </div>
      <div className="hq-text">{q.text}</div>
      {q.context && (
        <details className="hq-context">
          <summary>Detalle</summary>
          <pre>{q.context}</pre>
        </details>
      )}
      {q.options.length > 0 && (
        <div className="hq-options">
          {q.options.map((o, i) => (
            <button key={o} className={`btn tiny ${i === 0 ? "primary" : "ghost"}`} disabled={busy} onClick={() => void send(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      {(q.kind === "question" || !q.options.length) && (
        <div className="hq-reply">
          <input value={text} placeholder="Escribe tu respuesta…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send(text)} disabled={busy} />
          <button className="btn tiny primary" disabled={busy || !text.trim()} onClick={() => void send(text)}>
            Responder
          </button>
        </div>
      )}
      {q.fallback && <div className="muted tiny">Si no respondes a tiempo: {q.fallback}</div>}
    </div>
  );
}

/** Motores reales de la misión: los que usaron sus pasos (o el principal, si aún no empezó ninguno). */
function engineLabel(m: Mission): string {
  const used = [...new Set(m.steps.map((s) => s.provider).filter(Boolean))];
  if (used.length > 1) return "Codex + Claude Code";
  const p = used[0] ?? m.provider;
  return p === "codex" ? "Codex" : "Claude Code";
}
