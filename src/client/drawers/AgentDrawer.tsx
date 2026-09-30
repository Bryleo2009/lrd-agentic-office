import { useEffect, useMemo, useRef, useState } from "react";
import { agentOf as getAgent } from "../app/team";
import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId } from "../../shared/types";
import { api } from "../app/api";
import { eventTone, isLive, timeOf } from "../app/format";
import { useStore } from "../app/store";
import type { OfficeEngine } from "../office/OfficeEngine";
import { EventRow } from "../panels/BottomFeed";

type Tab = "activity" | "chat" | "terminal" | "profile";

const STATE_LABEL: Record<string, string> = {
  IDLE_DESK: "En su escritorio",
  IDLE_STANDING: "De pie",
  WALKING: "Caminando",
  READING: "Leyendo",
  COFFEE: "Tomando café",
  TALKING: "Conversando",
  RETURNING: "Volviendo a su puesto",
  SITTING: "Sentado",
  THINKING: "Pensando",
};

const ACTION_LABEL: Record<string, string> = {
  type: "Escribiendo código",
  read: "Analizando archivos",
  think: "Pensando",
  talk: "Hablando",
  test: "Ejecutando pruebas",
  celebrate: "¡Terminado!",
  blocked: "Bloqueado",
  idle: "Esperando",
  coffee: "Café",
};

export function AgentDrawer({ engine, onChatSent }: { engine: OfficeEngine | null; onChatSent: (id: AgentId) => void }) {
  const selected = useStore((s) => s.selected);
  useStore((s) => s.team);
  const select = useStore((s) => s.select);
  const [tab, setTab] = useState<Tab>("activity");
  const [portrait, setPortrait] = useState<string | null>(null);
  const [live, setLive] = useState<{ state: string; mode: string; action: string } | null>(null);

  useEffect(() => {
    setPortrait(null);
    if (selected && engine) void engine.portrait(selected).then(setPortrait).catch(() => undefined);
  }, [selected, engine]);

  // Estado visual actual (lectura liviana del motor, no frame a frame)
  useEffect(() => {
    if (!selected || !engine) return;
    const read = () => {
      const b = engine.brain(selected);
      const e = engine.entity(selected);
      if (b && e) setLive({ state: b.fsm.state, mode: b.modeName, action: e.animator.action });
    };
    read();
    const t = setInterval(read, 600);
    return () => clearInterval(t);
  }, [selected, engine]);

  if (!selected) return null;
  const a = getAgent(selected);

  return (
    <aside className="drawer glass" aria-label={`Agente ${a.name}`}>
      <div className="drawer-head">
        <div className="portrait" style={{ borderColor: a.color }}>
          {portrait ? <img src={portrait} alt="" /> : null}
        </div>
        <div className="grow">
          <div className="drawer-name">{a.name}</div>
          <div className="drawer-role">
            {a.role} · <span style={{ color: a.color }}>{a.department === "INGENIERIA" ? "Ingeniería" : a.department === "OPERACIONES" ? "Operaciones" : a.department === "CONTROL" ? "Control" : "QA"}</span>
          </div>
          {live && (
            <div className={`drawer-live ${live.mode}`}>
              <i />
              {live.mode === "real" ? ACTION_LABEL[live.action] ?? live.action : live.mode === "engaged" ? "Conversando" : STATE_LABEL[live.state] ?? live.state}
              <small>{live.mode === "real" ? "actividad real" : "vida ambiental"}</small>
            </div>
          )}
        </div>
        <button className="btn tiny ghost customize" onClick={() => useStore.getState().setSettingsOpen(true)} title="Personalizar empleado">
          Personalizar
        </button>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Cerrar">
          ×
        </button>
      </div>
      <AgentFacts agentId={selected} />
      <div className="tabs">
        {(["activity", "chat", "terminal", "profile"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "activity" ? "Actividad" : t === "chat" ? "Chat" : t === "terminal" ? "Terminal" : "Perfil"}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {tab === "activity" && <ActivityTab agentId={selected} />}
        {tab === "chat" && <ChatTab agentId={selected} onSent={onChatSent} />}
        {tab === "terminal" && <TerminalTab agentId={selected} />}
        {tab === "profile" && <ProfileTab agentId={selected} />}
      </div>
    </aside>
  );
}

function AgentFacts({ agentId }: { agentId: AgentId }) {
  const missions = useStore((s) => s.missions);
  const order = useStore((s) => s.missionOrder);
  const sessions = useStore((s) => s.sessions);
  const runtime = useStore((s) => s.runtime);
  const config = useStore((s) => s.config);
  const events = useStore((s) => s.events);
  const mission = order.map((id) => missions[id]).find((m) => m && m.steps.some((s) => s.agentId === agentId));
  const step = mission?.steps.find((s) => s.agentId === agentId && s.status === "running") ?? mission?.steps.filter((s) => s.agentId === agentId).slice(-1)[0];
  const session = sessions.find((s) => s.agentId === agentId && (!mission || s.missionId === mission.id)) ?? sessions.find((s) => s.agentId === agentId);
  const provider = step?.provider ?? session?.provider ?? config?.agentEngines?.[agentId] ?? config?.aiEngineDefault ?? "codex";
  const rt = runtime.find((r) => r.provider === provider);
  const lastEv = [...events].reverse().find((e) => e.agentId === agentId && !["COMMAND_OUTPUT", "TEST_OUTPUT"].includes(e.type));
  const rows: [string, React.ReactNode][] = [
    [
      "Motor IA",
      step?.kind === "qa" && !step.provider ? (
        <>QA local <span className="mini-pill ok">comandos reales</span></>
      ) : (
        <>{provider === "codex" ? "Codex CLI" : "Claude Code"} <span className={`mini-pill ${rt && rt.installed && rt.authenticated !== false ? "ok" : "bad"}`}>{rt ? (rt.installed && rt.authenticated !== false ? "Connected" : "No disponible") : "…"}</span></>
      ),
    ],
    ["Session", session?.sessionId ? <code title={session.sessionId}>{session.sessionId.slice(0, 13)}…</code> : "—"],
    ["Misión", mission ? <>#{mission.id} {isLive(mission.status) ? "· en curso" : `· ${mission.status}`}</> : "—"],
    ["Repositorio", mission ? (mission.repositoryId === "none" ? "Sin repositorio (datos)" : `${mission.repositoryId}${mission.repoSelection === "auto" ? " (auto)" : ""}`) : "—"],
    ["Rama base", mission?.baseBranch || "—"],
    ["Rama agentic", mission?.branch ? <code>{mission.branch}</code> : "—"],
    ["Worktree", mission?.worktree ? <code title={mission.worktree}>…{mission.worktree.slice(-34)}</code> : "—"],
    ["Actividad actual", step?.status === "running" ? step.title : lastEv ? `${lastEv.title} (${timeOf(lastEv.timestamp)})` : "Vida ambiental"],
  ];
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActivityTab({ agentId }: { agentId: AgentId }) {
  const events = useStore((s) => s.events);
  const list = useMemo(() => events.filter((e) => e.agentId === agentId && e.type !== "COMMAND_OUTPUT" && e.type !== "TEST_OUTPUT").slice(-120).reverse(), [events, agentId]);
  if (!list.length) return <div className="empty">Sin actividad real registrada. {getAgent(agentId).name} sigue su rutina en la oficina.</div>;
  return (
    <div className="feed-list">
      {list.map((e) => (
        <EventRow key={e.id} e={e} />
      ))}
    </div>
  );
}

function ChatTab({ agentId, onSent }: { agentId: AgentId; onSent: (id: AgentId) => void }) {
  const chats = useStore((s) => s.chats[agentId]) ?? [];
  const busy = useStore((s) => s.chatBusy[agentId]);
  const push = useStore((s) => s.pushChat);
  const setBusy = useStore((s) => s.setChatBusy);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [chats.length, busy]);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setText("");
    push({ id: `u-${Date.now()}`, agentId, from: "user", text: msg, at: new Date().toISOString() });
    setBusy(agentId, true);
    onSent(agentId);
    try {
      await api.chat(agentId, msg);
    } catch (e) {
      setBusy(agentId, false);
      push({ id: `e-${Date.now()}`, agentId, from: "system", text: (e as Error).message, at: new Date().toISOString() });
    }
  };

  return (
    <div className="chat">
      <div className="chat-log">
        {chats.length === 0 && (
          <div className="empty">
            Escríbele a {getAgent(agentId).name}. El mensaje va a su sesión real de Codex/Claude Code, con el contexto de su última misión.
          </div>
        )}
        {chats.map((c) => (
          <div key={c.id} className={`msg ${c.from}`}>
            {c.text}
          </div>
        ))}
        {busy && <div className="msg agent typing">…</div>}
        <div ref={endRef} />
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          rows={2}
          placeholder={`Pregunta a ${getAgent(agentId).name}… (Enter para enviar)`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !text.trim()} onClick={send}>
          Enviar
        </button>
      </div>
    </div>
  );
}

function TerminalTab({ agentId }: { agentId: AgentId }) {
  const events = useStore((s) => s.events);
  const [full, setFull] = useState<AgentRuntimeEvent | null>(null);
  const cmds = useMemo(
    () => events.filter((e) => e.agentId === agentId && (e.type === "COMMAND_FINISHED" || e.type === "TEST_FINISHED" || e.type === "COMMAND_STARTED" || e.type === "TEST_STARTED")).slice(-60),
    [events, agentId],
  );
  // agrupar inicio/fin por comando
  const rows: { cmd: string; start: AgentRuntimeEvent; end?: AgentRuntimeEvent }[] = [];
  for (const e of cmds) {
    if (e.type === "COMMAND_STARTED" || e.type === "TEST_STARTED") rows.push({ cmd: e.command ?? e.title, start: e });
    else {
      const r = [...rows].reverse().find((x) => !x.end && (x.cmd === e.command || !e.command));
      if (r) r.end = e;
      else rows.push({ cmd: e.command ?? e.title, start: e, end: e });
    }
  }
  if (!rows.length) return <div className="empty">Sin comandos todavía. Aquí aparecen los comandos reales que ejecuta {getAgent(agentId).name}, con su salida y exit code.</div>;
  return (
    <div className="terminal">
      {rows
        .slice()
        .reverse()
        .map((r) => {
          const exit = (r.end?.metadata as any)?.exitCode;
          const tone = r.end ? eventTone(r.end) : "run";
          return (
            <div key={r.start.id} className={`term-row ${tone}`}>
              <div className="term-cmd">$ {r.cmd}</div>
              {r.end ? (
                <div className="term-out">
                  <span className={`exit ${tone}`}>{tone === "ok" ? "PASS" : tone === "err" ? "FAIL" : tone === "warn" ? "DENEGADO" : "…"}</span>
                  {exit !== undefined && exit !== null && <span className="muted">exit {exit}</span>}
                  <span>{((r.end.metadata as any)?.summary ?? r.end.detail ?? r.end.title).toString().split("\n").slice(0, 3).join(" · ")}</span>
                  <button className="link" onClick={async () => setFull(await api.event(r.end!.id))}>
                    Ver output completo
                  </button>
                </div>
              ) : (
                <div className="term-out muted">ejecutando… {timeOf(r.start.timestamp)}</div>
              )}
            </div>
          );
        })}
      {full && (
        <div className="full-output" onClick={() => setFull(null)}>
          <pre onClick={(e) => e.stopPropagation()}>
            {`$ ${full.command ?? ""}\n\n${full.detail ?? ""}`}
          </pre>
        </div>
      )}
    </div>
  );
}

function ProfileTab({ agentId }: { agentId: AgentId }) {
  const a = getAgent(agentId);
  const config = useStore((s) => s.config);
  return (
    <div className="profile">
      <p className="tagline">{a.tagline}</p>
      <h4>Responsabilidades</h4>
      <ul>
        {a.responsibilities.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <h4>Motor preferido</h4>
      <p>{config?.agentEngines?.[agentId] ? (config.agentEngines[agentId] === "codex" ? "Codex CLI" : "Claude Code") : `Mismo motor de la misión (por defecto ${config?.aiEngineDefault === "claude" ? "Claude Code" : "Codex"})`}</p>
      <h4>Permisos</h4>
      <p>Investigación: solo lectura. Implementación: escritura dentro del worktree de la misión. Git (commit/push/PR) lo controla el orquestador.</p>
    </div>
  );
}
