import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "../../shared/types";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { MissionVisualController } from "../office/MissionVisualController";
import { OfficeEngine } from "../office/OfficeEngine";
import { BottomFeed } from "../panels/BottomFeed";
import { MissionHud } from "../panels/MissionHud";
import { NewMissionPanel } from "../panels/NewMissionPanel";
import { TopBar } from "../panels/TopBar";
import { useStore } from "./store";
import { connectWs, onServerMessage } from "./ws";

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<OfficeEngine | null>(null);
  const visualRef = useRef<MissionVisualController | null>(null);
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selected);
  const toast = useStore((s) => s.toast);

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
      if (m.kind === "hello") vc.bootstrap(m.snapshot.missions);
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
  useEffect(() => {
    engine?.select(selected);
  }, [selected, engine]);

  // la cámara deja espacio para el drawer
  useEffect(() => {
    if (!engine) return;
    const mobile = window.innerWidth < 760;
    engine.setInsets({ right: selected && !mobile ? 420 : 16, bottom: selected && mobile ? window.innerHeight * 0.55 : 64 });
  }, [selected, engine]);

  const focusAgent = useCallback(
    (id: AgentId) => {
      select(id);
      engine?.focusAgent(id);
    },
    [engine, select],
  );

  return (
    <div className="app">
      <div className="office" ref={hostRef} />
      {!engine && <div className="loading">Preparando la oficina…</div>}
      <TopBar engine={engine} />
      <MissionHud onAgent={focusAgent} />
      <AgentDrawer engine={engine} onChatSent={(id) => visualRef.current?.onChatSent(id)} />
      <BottomFeed onAgent={focusAgent} />
      <NewMissionPanel />
      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}
