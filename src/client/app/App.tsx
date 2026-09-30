import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "../../shared/types";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { MissionVisualController } from "../office/MissionVisualController";
import { OfficeEngine } from "../office/OfficeEngine";
import { BottomFeed } from "../panels/BottomFeed";
import { MissionHud } from "../panels/MissionHud";
import { NewMissionPanel } from "../panels/NewMissionPanel";
import { SettingsPanel } from "../panels/SettingsPanel";
import { TopBar } from "../panels/TopBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { ackReport, buildReport, callText, saveDelivered } from "./reports";
import { useStore } from "./store";
import { connectWs, onServerMessage } from "./ws";

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<OfficeEngine | null>(null);
  const visualRef = useRef<MissionVisualController | null>(null);
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selected);
  const toast = useStore((s) => s.toast);
  const [glLost, setGlLost] = useState(false);
  const pendingReports = useStore((s) => s.pendingReports);
  const missions = useStore((s) => s.missions);

  // Motor PixiJS (una sola vez)
  useEffect(() => {
    const el = hostRef.current!;
    const eng = new OfficeEngine();
    let disposed = false;
    void eng.init(el).then(() => {
      if (disposed) {
        eng.destroy();
        return;
      }
      eng.onSelect((id) => useStore.getState().select(id));
      eng.onContextLost(setGlLost);
      visualRef.current = new MissionVisualController(eng);
      setEngine(eng);
    });
    return () => {
      disposed = true;
      if (visualRef.current) eng.destroy();
    };
  }, []);

  // Eventos reales → oficina
  useEffect(() => {
    if (!engine) return;
    const vc = visualRef.current!;
    const off = onServerMessage((m) => {
      if (m.kind === "hello") {
        engine.applyTeam(m.snapshot.team ?? []);
        vc.bootstrap(m.snapshot.missions);
      } else if (m.kind === "team") engine.applyTeam(m.team);
      else if (m.kind === "event") vc.handle(m.event);
      else if (m.kind === "mission") vc.onMission(m.mission);
      else if (m.kind === "chat") vc.onChat(m.agentId, m.delta, m.done, m.error);
    });
    const disconnect = connectWs();
    return () => {
      off();
      disconnect();
    };
  }, [engine]);

  // selección React → motor
  // (protegido: un fallo del motor al seleccionar no debe tumbar toda la interfaz)
  useEffect(() => {
    try {
      engine?.select(selected);
    } catch (e) {
      console.error("No se pudo seleccionar al agente en la oficina", e);
    }
  }, [selected, engine]);

  // la cámara deja espacio para el drawer
  useEffect(() => {
    if (!engine) return;
    const mobile = window.innerWidth < 760;
    engine.setInsets({ right: selected && !mobile ? 420 : 16, bottom: selected && mobile ? window.innerHeight * 0.55 : 64 });
  }, [selected, engine]);

  // Informe pendiente: Atlas sale a saludar hasta que el usuario le hace clic.
  useEffect(() => {
    const list = pendingReports.map((id) => missions[id]).filter(Boolean);
    document.title = list.length ? `(${list.length}) Informe listo · LRD Agentic Office` : "LRD Agentic Office";
    try {
      engine?.brain("atlas")?.setCalling(list.length ? callText(list) : null);
    } catch (e) {
      console.error("No se pudo animar el aviso de Atlas", e);
    }
  }, [pendingReports, missions, engine]);

  // Al abrir a Atlas con informes pendientes: te cuenta en el chat en qué quedó cada misión.
  useEffect(() => {
    if (selected !== "atlas" || !pendingReports.length) return;
    const st = useStore.getState();
    for (const id of pendingReports) {
      const m = st.missions[id];
      if (m) {
        const line = { id: `report-${id}`, agentId: "atlas" as const, from: "agent" as const, text: buildReport(m), at: new Date().toISOString() };
        st.pushChat(line);
        saveDelivered({ id: line.id, missionId: id, text: line.text, at: line.at });
      }
      ackReport(id);
      st.removePendingReport(id);
    }
    st.setDrawerTab("chat");
    engine?.entity("atlas")?.say("¡Te cuento cómo nos fue!", "talk", 3.5);
  }, [selected, pendingReports, engine]);

  const focusAgent = useCallback(
    (id: AgentId) => {
      select(id);
      try {
        engine?.focusAgent(id);
      } catch (e) {
        console.error("No se pudo enfocar al agente", e);
      }
    },
    [engine, select],
  );

  return (
    <div className="app">
      <div className="office" ref={hostRef} />
      {!engine && <div className="loading">Preparando la oficina…</div>}
      {glLost && (
        <div className="ui-error full" role="alert">
          <b>La tarjeta gráfica reinició la vista de la oficina.</b>
          <span>Suele pasar al volver de suspensión o con poca memoria de video. Las misiones siguen corriendo.</span>
          <div className="ui-error-actions">
            <button onClick={() => location.reload()}>Recargar vista</button>
          </div>
        </div>
      )}
      <ErrorBoundary name="la barra superior">
        <TopBar engine={engine} />
      </ErrorBoundary>
      <ErrorBoundary name="el panel de la misión">
        <MissionHud onAgent={focusAgent} />
      </ErrorBoundary>
      <ErrorBoundary name="el panel del agente">
        <AgentDrawer engine={engine} onChatSent={(id) => visualRef.current?.onChatSent(id)} />
      </ErrorBoundary>
      <ErrorBoundary name="la actividad">
        <BottomFeed onAgent={focusAgent} />
      </ErrorBoundary>
      <ErrorBoundary name="nueva misión">
        <NewMissionPanel />
      </ErrorBoundary>
      <ErrorBoundary name="ajustes">
        <SettingsPanel engine={engine} />
      </ErrorBoundary>
      {pendingReports.length > 0 && selected !== "atlas" && (
        <button className="report-call" onClick={() => focusAgent("atlas")}>
          <span className="report-dot">!</span>
          {pendingReports.length === 1 ? "Atlas tiene un informe para ti" : `Atlas tiene ${pendingReports.length} informes para ti`}
          <b>Ver</b>
        </button>
      )}
      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}
