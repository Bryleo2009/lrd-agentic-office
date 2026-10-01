import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId, Mission, MissionStep } from "../../shared/types";
import { branchesOf, fmtTokens, isLive, MISSION_STATUS, repoLabel, STEP_STATUS, timeOf, tokensLabel } from "../app/format";
import { useStore } from "../app/store";
import { agentOf as getAgent } from "../app/team";
import { Checklist, QuestionCard } from "./MissionHud";

const POS_KEY = "lrd.tablet.pos";
const TAB_KEY = "lrd.tablet.tab";
type Tab = "equipo" | "checklist" | "linea" | "actividad";

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* sin almacenamiento */
  }
}

/** "3m 12s", "1h 05m". */
function dur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s % 60}s`;
}
const stepMs = (s: MissionStep, now: number) => (s.startedAt ? (s.finishedAt ? new Date(s.finishedAt).getTime() : now) - new Date(s.startedAt).getTime() : 0);
const engineName = (p: string | null | undefined) => (p === "codex" ? "Codex" : p === "claude" ? "Claude Code" : null);
const KIND: Record<MissionStep["kind"], string> = { plan: "Plan", agent: "Tarea", xreview: "Revisión cruzada", qa: "QA", review: "Revisión final", ci: "GitHub Actions" };
const ICON: Record<MissionStep["status"], string> = { pending: "○", running: "◐", waiting: "?", done: "✓", failed: "✗", skipped: "–", cancelled: "–" };

/**
 * Tablet de avance: una ventana aparte (movible y redimensionable, como el chat) para seguir al equipo
 * como si tuvieras una tablet en la mano. Todo sale del estado en vivo (WebSocket): se actualiza sola.
 */
export function ProgressTablet({ onFocusAgent, onChat }: { onFocusAgent: (id: AgentId) => void; onChat: (id: AgentId) => void }) {
  const tablet = useStore((s) => s.tablet);
  const setTablet = useStore((s) => s.setTablet);
  const missions = useStore((s) => s.missions);
  const order = useStore((s) => s.missionOrder);
  const events = useStore((s) => s.events);
  useStore((s) => s.team);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState(() => readJson<{ x: number; y: number; w: number; h: number }>(POS_KEY));
  const [tab, setTabState] = useState<Tab>(() => readJson<Tab>(TAB_KEY) ?? "equipo");
  const [now, setNow] = useState(Date.now());
  const setTab = (t: Tab) => {
    setTabState(t);
    writeJson(TAB_KEY, t);
  };

  // La misión que se ve: la elegida, o la que está en curso, o la última.
  const list = order.map((id) => missions[id]).filter(Boolean) as Mission[];
  const mission = (tablet.missionId && missions[tablet.missionId]) || list.find((m) => isLive(m.status)) || list[0] || null;
  const live = mission ? isLive(mission.status) : false;

  // Reloj: los tiempos de lo que está en curso avanzan cada segundo.
  useEffect(() => {
    if (!tablet.open || !live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tablet.open, live]);

  useEffect(() => {
    if (!tablet.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && document.activeElement?.closest(".tablet") && setTablet(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tablet.open, setTablet]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      writeJson(POS_KEY, { x: r.left, y: r.top, w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tablet.open]);

  const mine = useMemo(() => (mission ? events.filter((e) => e.missionId === mission.id) : []), [events, mission?.id]);

  if (!tablet.open) return null;

  const style = pos
    ? { left: Math.max(0, Math.min(pos.x, window.innerWidth - 260)), top: Math.max(60, Math.min(pos.y, window.innerHeight - 140)), width: pos.w, height: pos.h }
    : undefined;
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, select")) return;
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
    if (r) writeJson(POS_KEY, { x: r.left, y: r.top, w: r.width, h: r.height });
  };

  const steps = mission?.steps.filter((s) => !(s.kind === "plan" && s.status === "done")) ?? [];
  const finished = steps.filter((s) => ["done", "skipped"].includes(s.status)).length;
  const pct = steps.length ? Math.round((finished / steps.length) * 100) : mission?.status === "done" ? 100 : 0;
  const open = mission?.questions?.filter((q) => q.status === "open") ?? [];
  const checklist = mission?.checklist ?? [];
  const checkDone = checklist.filter((i) => i.status === "done" || i.status === "skipped").length;
  const elapsed = mission ? (live ? now : new Date(mission.updatedAt).getTime()) - new Date(mission.createdAt).getTime() : 0;

  return (
    <section ref={ref} className="tablet glass" style={style} aria-label="Tablet de avance del equipo">
      <header className="tablet-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <div className="tablet-cam" aria-hidden />
        <div className="grow">
          <b>Avance del equipo</b>
          {mission ? (
            <select value={mission.id} onChange={(e) => setTablet(true, e.target.value)} aria-label="Misión">
              {list.slice(0, 20).map((m) => (
                <option key={m.id} value={m.id}>
                  #{m.id} · {MISSION_STATUS[m.status]} · {m.prompt.slice(0, 48)}
                </option>
              ))}
            </select>
          ) : (
            <small>Sin misiones todavía</small>
          )}
        </div>
        <button className="icon-btn" onClick={() => setTablet(false)} aria-label="Cerrar tablet">
          ×
        </button>
      </header>

      {!mission ? (
        <div className="empty">Cuando lances una misión verás aquí el avance de cada persona en vivo.</div>
      ) : (
        <div className="tablet-body">
          <div className="tablet-summary">
            <div className="tablet-ring" style={{ ["--p" as string]: `${pct}` }} aria-label={`${pct}% completado`}>
              <span>{pct}%</span>
            </div>
            <div className="grow">
              <div className="tablet-title">
                <span className={`status-pill ${mission.status}`}>{MISSION_STATUS[mission.status]}</span>
                <span className="muted">{dur(elapsed)}</span>
              </div>
              <div className="tablet-prompt" title={mission.prompt}>
                {mission.prompt}
              </div>
              <div className="tablet-kpis">
                <span>
                  <b>
                    {finished}/{steps.length}
                  </b>{" "}
                  pasos
                </span>
                {checklist.length > 0 && (
                  <span>
                    <b>
                      {checkDone}/{checklist.length}
                    </b>{" "}
                    checklist
                  </span>
                )}
                {open.length > 0 && (
                  <span className="warn-text">
                    <b>{open.length}</b> esperando tu respuesta
                  </span>
                )}
                {mission.usage?.total && (mission.usage.total.input || mission.usage.total.output) ? (
                  <span title={`${mission.usage.total.calls} llamadas al motor · ${Object.entries(mission.usage.byProvider ?? {}).map(([p, u]) => `${p === "codex" ? "Codex" : "Claude"}: ${tokensLabel(u)}`).join(" · ")}${mission.usage.total.costUsd ? ` · ≈ US$ ${mission.usage.total.costUsd.toFixed(2)} equivalente en API (Claude)` : ""}`}>
                    <b>{fmtTokens(mission.usage.total.input + mission.usage.total.output)}</b> tokens
                  </span>
                ) : null}
                <span className="muted">{repoLabel(mission) === "none" ? "sin repositorio" : repoLabel(mission)}</span>
              </div>
            </div>
          </div>

          {open.map((q) => (
            <QuestionCard key={q.id} mission={mission} q={q} />
          ))}

          <nav className="tabs tablet-tabs">
            {(
              [
                ["equipo", "Equipo"],
                ["checklist", `Checklist${checklist.length ? ` ${checkDone}/${checklist.length}` : ""}`],
                ["linea", "Pasos"],
                ["actividad", "Actividad"],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </nav>

          <div className="tablet-pane">
            {tab === "equipo" && <TeamPane mission={mission} events={mine} now={now} onFocusAgent={onFocusAgent} onChat={onChat} />}
            {tab === "checklist" &&
              (checklist.length ? <Checklist items={checklist} live={live} /> : <div className="empty">Esta misión no tiene checklist (no pedía puntos concretos).</div>)}
            {tab === "linea" && <TimelinePane mission={mission} steps={steps} now={now} />}
            {tab === "actividad" && <ActivityPane events={mine} />}
          </div>
        </div>
      )}
    </section>
  );
}

/** Una tarjeta por persona: qué está haciendo, con qué motor, cuánto lleva y lo último que hizo. */
function TeamPane({ mission, events, now, onFocusAgent, onChat }: { mission: Mission; events: AgentRuntimeEvent[]; now: number; onFocusAgent: (id: AgentId) => void; onChat: (id: AgentId) => void }) {
  const people = [...new Set(mission.steps.map((s) => s.agentId))];
  if (!people.length) return <div className="empty">Atlas está preparando el plan…</div>;
  return (
    <div className="tablet-team">
      {people.map((id) => {
        const a = getAgent(id);
        const theirs = mission.steps.filter((s) => s.agentId === id);
        const cur = theirs.find((s) => s.status === "running" || s.status === "waiting") ?? theirs.find((s) => s.status === "pending") ?? theirs.at(-1)!;
        const done = theirs.filter((s) => s.status === "done").length;
        const last = [...events].reverse().find((e) => e.agentId === id && e.type !== "COMMAND_OUTPUT" && e.type !== "TEST_OUTPUT");
        const state = cur.status === "waiting" ? "waiting" : cur.status === "running" ? "running" : theirs.some((s) => s.status === "failed") ? "failed" : theirs.every((s) => ["done", "skipped"].includes(s.status)) ? "done" : "pending";
        const label = { waiting: "Te pregunta", running: "Trabajando", failed: "Con problemas", done: "Terminó", pending: "En espera" }[state];
        return (
          <article key={id} className={`tablet-person ${state}`}>
            <div className="tp-head">
              <span className="tp-avatar" style={{ background: a.color }}>
                {a.name.slice(0, 1)}
              </span>
              <div className="grow">
                <b>{a.name}</b>
                <small>{a.role}</small>
              </div>
              <span className={`tp-state ${state}`}>{label}</span>
            </div>
            <div className="tp-task">
              {!cur.title.toLowerCase().startsWith(KIND[cur.kind].toLowerCase()) && <span className="muted">{KIND[cur.kind]}: </span>}
              {cur.title}
            </div>
            <div className="tp-meta">
              <span>
                {done}/{theirs.length} pasos
              </span>
              {engineName(cur.provider) && <span>{engineName(cur.provider)}</span>}
              {cur.startedAt && <span>{dur(stepMs(cur, now))}</span>}
              {(() => {
                const t = theirs.reduce((acc, s) => acc + (s.usage ? s.usage.input + s.usage.output : 0), 0);
                return t ? <span title="Tokens de sus pasos">{fmtTokens(t)} tokens</span> : null;
              })()}
            </div>
            {last && (
              <div className="tp-last" title={last.detail ?? last.title}>
                <span className="muted">{timeOf(last.timestamp)}</span> {last.title}
              </div>
            )}
            {cur.error && <div className="tp-error">{cur.error.split("\n")[0]}</div>}
            <div className="tp-actions">
              <button className="btn tiny ghost" onClick={() => onFocusAgent(id)}>
                Ubicar
              </button>
              <button className="btn tiny ghost" onClick={() => onChat(id)}>
                Chat
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function TimelinePane({ mission, steps, now }: { mission: Mission; steps: MissionStep[]; now: number }) {
  return (
    <div className="tablet-timeline">
      <ol>
        {steps.map((s) => {
          const a = getAgent(s.agentId);
          return (
            <li key={s.id} className={s.status}>
              <span className="tl-icon">{ICON[s.status]}</span>
              <div className="grow">
                <div>
                  <b style={{ color: a.color }}>{a.name}</b> · {s.title}
                </div>
                <small className="muted">
                  {KIND[s.kind]} · {STEP_STATUS[s.status]}
                  {engineName(s.provider) ? ` · ${engineName(s.provider)}` : ""}
                  {s.startedAt ? ` · ${dur(stepMs(s, now))}` : ""}
                  {tokensLabel(s.usage) ? ` · ${tokensLabel(s.usage)}` : ""}
                </small>
                {s.error && <div className="tp-error">{s.error.split("\n")[0]}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {(branchesOf(mission).length > 0 || mission.ci?.length > 0) && (
        <div className="tablet-delivery">
          <b>Entrega</b>
          {branchesOf(mission).map((b) => (
            <div key={b.branch + (b.repo ?? "")}>
              {b.repo ? `${b.repo}: ` : ""}
              <code>{b.branch}</code>
              {b.sha ? ` · ${b.sha.slice(0, 7)}` : ""}
            </div>
          ))}
          {mission.ci?.map((c) => (
            <div key={c.repositoryId} className={c.state === "success" ? "ok-text" : c.state === "failure" || c.state === "timeout" ? "err-text" : "muted"}>
              GitHub Actions ({c.repositoryId}): {c.state === "success" ? "en verde" : c.state === "pending" ? "esperando…" : c.detail}
            </div>
          ))}
          {mission.prUrl && (
            <a href={mission.prUrl} target="_blank" rel="noreferrer">
              Ver PR
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityPane({ events }: { events: AgentRuntimeEvent[] }) {
  const shown = events.filter((e) => e.type !== "COMMAND_OUTPUT" && e.type !== "TEST_OUTPUT").slice(-60).reverse();
  if (!shown.length) return <div className="empty">Sin actividad todavía.</div>;
  return (
    <ul className="tablet-activity">
      {shown.map((e) => (
        <li key={e.id} className={e.status ?? "info"}>
          <span className="muted">{timeOf(e.timestamp)}</span>
          {e.agentId && (
            <b style={{ color: getAgent(e.agentId).color }}>
              {getAgent(e.agentId).name}
            </b>
          )}
          <span className="grow">{e.title}</span>
        </li>
      ))}
    </ul>
  );
}
