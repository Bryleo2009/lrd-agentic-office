import { useState } from "react";
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

  return (
    <div className={`mission-hud glass ${current.status}`}>
      <button className="hud-head" onClick={() => setCollapsed(!collapsed)}>
        <span className={`status-pill ${current.status}`}>{MISSION_STATUS[current.status]}</span>
        <span className="hud-id">#{current.id}</span>
        <span className="hud-engine">{current.provider === "codex" ? "Codex" : "Claude Code"}</span>
        <span className="chev">{collapsed ? "▸" : "▾"}</span>
      </button>
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
                  <small>{s.kind === "xreview" ? "revisión cruzada" : s.kind === "ci" ? "Actions" : s.kind === "qa" ? "QA" : s.kind === "review" ? "revisión" : s.kind === "plan" ? "plan" : s.writes ? "cambios" : "análisis"}</small>
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
          </div>
          {current.error && <div className="hud-error">{current.error.split("\n")[0]}</div>}
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
function Checklist({ items, live }: { items: import("../../shared/types").ChecklistItem[]; live: boolean }) {
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
