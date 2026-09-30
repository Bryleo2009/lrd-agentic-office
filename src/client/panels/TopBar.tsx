import { useStore } from "../app/store";
import type { OfficeEngine } from "../office/OfficeEngine";

export function TopBar({ engine }: { engine: OfficeEngine | null }) {
  const runtime = useStore((s) => s.runtime);
  const connected = useStore((s) => s.connected);
  const config = useStore((s) => s.config);
  const setNew = useStore((s) => s.setNewMission);
  const setSettings = useStore((s) => s.setSettingsOpen);

  return (
    <>
      <div className="brand glass">
        <div className="brand-mark" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div>
          <div className="brand-title">LRD Agentic Office</div>
          <div className="brand-sub">
            <i className={`live-dot ${connected ? "on" : ""}`} /> {connected ? "En vivo" : "Reconectando…"} · Lima HQ
          </div>
        </div>
      </div>

      <div className="engines glass">
        {runtime.length === 0 && <span className="engine muted">Detectando motores…</span>}
        {runtime.map((r) => {
          const ok = r.enabled && r.installed && r.authenticated !== false;
          const sat = r.saturatedUntil && new Date(r.saturatedUntil).getTime() > Date.now() ? new Date(r.saturatedUntil) : null;
          const back = sat?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
          return (
            <span
              key={r.provider}
              className={`engine ${ok ? (sat ? "warn" : "ok") : "bad"}`}
              title={sat ? `${r.label} ${r.saturationReason ?? "saturado"}. La oficina usa el otro motor hasta las ${back}.` : `${r.message}${r.version ? ` · v${r.version}` : ""}`}
            >
              <i />
              {r.label}
              <b>{sat ? `Saturado · vuelve ${back}` : ok ? (r.authenticated ? "Conectado" : "Instalado") : r.installed ? "Sin sesión" : "No disponible"}</b>
            </span>
          );
        })}
        <span className="engine muted" title="Nunca se usa API de pago sin autorización explícita">
          API fallback: <b>{config?.allowPaidApiFallback ? "ON" : "off"}</b>
        </span>
      </div>

      <div className="top-actions">
        <button className="btn ghost glass" onClick={() => engine?.fit()} title="Centrar oficina">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
          <span className="hide-sm">Centrar oficina</span>
        </button>
        <button className="btn ghost glass" onClick={() => setSettings(true)} title="Equipo, repositorios y datos">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          <span className="hide-sm">Ajustes</span>
        </button>
        <button className="btn primary" onClick={() => setNew(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Nueva misión
        </button>
      </div>
    </>
  );
}
