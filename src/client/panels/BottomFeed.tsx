import { useMemo, useState } from "react";
import { agentOf as getAgent } from "../app/team";
import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId } from "../../shared/types";
import { eventTone, MISSION_STATUS, timeOf, typeLabel } from "../app/format";
import { useStore } from "../app/store";

const HIDDEN = new Set(["COMMAND_OUTPUT", "TEST_OUTPUT", "SESSION_STARTED", "AGENT_JOINED_MEETING"]);

export function EventRow({ e, onAgent }: { e: AgentRuntimeEvent; onAgent?: (id: AgentId) => void }) {
  const a = e.agentId ? getAgent(e.agentId) : null;
  return (
    <div className={`ev ${eventTone(e)}`}>
      <span className="ev-time">{timeOf(e.timestamp)}</span>
      {a ? (
        <button className="ev-agent" onClick={() => onAgent?.(a.id)}>
          <i style={{ background: a.color }} />
          {a.name}
        </button>
      ) : (
        <span className="ev-agent">sistema</span>
      )}
      <span className="ev-type">{typeLabel(e.type)}</span>
      <span className="ev-title" title={e.detail ?? e.title}>
        {e.title}
      </span>
    </div>
  );
}

export function BottomFeed({ onAgent }: { onAgent: (id: AgentId) => void }) {
  useStore((s) => s.team);
  const events = useStore((s) => s.events);
  const open = useStore((s) => s.feedOpen);
  const setOpen = useStore((s) => s.setFeedOpen);
  const missions = useStore((s) => s.missions);
  const order = useStore((s) => s.missionOrder);
  const runtime = useStore((s) => s.runtime);
  const config = useStore((s) => s.config);
  const [tab, setTab] = useState<"activity" | "missions" | "engines">("activity");
  const visible = useMemo(() => events.filter((e) => !HIDDEN.has(e.type)), [events]);
  const last = visible[visible.length - 1];

  return (
    <div className={`feed glass ${open ? "open" : ""}`}>
      <div className="feed-bar" onClick={() => setOpen(!open)}>
        <span className="feed-label">Actividad real</span>
        <div className="feed-last">{last ? <EventRow e={last} onAgent={onAgent} /> : <span className="muted">Sin eventos todavía. Los agentes están en modo ambiental.</span>}</div>
        <button className="icon-btn" aria-label={open ? "Contraer" : "Expandir"}>
          {open ? "▾" : "▴"}
        </button>
      </div>
      {open && (
        <div className="feed-body">
          <div className="tabs">
            <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>
              Actividad
            </button>
            <button className={tab === "missions" ? "on" : ""} onClick={() => setTab("missions")}>
              Misiones
            </button>
            <button className={tab === "engines" ? "on" : ""} onClick={() => setTab("engines")}>
              Motores
            </button>
          </div>
          {tab === "activity" && (
            <div className="feed-list">
              {visible
                .slice(-200)
                .reverse()
                .map((e) => (
                  <EventRow key={e.id} e={e} onAgent={onAgent} />
                ))}
            </div>
          )}
          {tab === "missions" && (
            <div className="feed-list">
              {order.length === 0 && <div className="muted pad">Aún no hay misiones.</div>}
              {order.map((id) => {
                const m = missions[id];
                if (!m) return null;
                return (
                  <div key={id} className="mission-row">
                    <span className={`status-pill ${m.status}`}>{MISSION_STATUS[m.status]}</span>
                    <b>#{m.id}</b>
                    <span className="grow">{m.prompt}</span>
                    <code>{m.branch}</code>
                    {m.commitSha && <code>{m.commitSha.slice(0, 7)}</code>}
                    <span className="muted">{m.steps.filter((s) => s.kind === "agent").map((s) => getAgent(s.agentId).name).join(" · ")}</span>
                  </div>
                );
              })}
            </div>
          )}
          {tab === "engines" && (
            <div className="feed-list pad">
              {runtime.map((r) => (
                <div key={r.provider} className="engine-row">
                  <b>{r.label}</b> <span>{r.installed ? `v${r.version}` : "no instalado"}</span> <span>{r.authDetail ?? ""}</span>
                  <span className="muted">{r.message}</span>
                  <span className="muted">flags: {Object.entries(r.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ") || "—"}</span>
                </div>
              ))}
              <div className="engine-row">
                <b>Política</b>
                <span>modo {config?.aiProviderMode}</span>
                <span>motor por defecto {config?.aiEngineDefault}</span>
                <span>API fallback {config?.allowPaidApiFallback ? "habilitado" : "deshabilitado"}</span>
                <span>push {config?.githubPushEnabled ? "on" : "off"} · PR {config?.githubPrEnabled ? "on" : "off"}</span>
                <span className="muted">workspace {config?.workspaceRoot}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
