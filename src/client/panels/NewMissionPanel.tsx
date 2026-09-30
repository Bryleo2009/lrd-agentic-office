import { useEffect, useMemo, useState } from "react";
import { isToolMcp, type EngineChoice } from "../../shared/types";
import { api } from "../app/api";
import { useStore } from "../app/store";

const EXAMPLES = [
  "Valida el CI de lrd-front y corrige el problema.",
  "Revisa por qué Rappi no está mandando el código de entrega, corrígelo y prepara el PR.",
  "Analiza el checkout y dime por qué falla esta validación.",
];

export function NewMissionPanel() {
  const open = useStore((s) => s.newMissionOpen);
  const setOpen = useStore((s) => s.setNewMission);
  const repos = useStore((s) => s.repositories);
  const runtime = useStore((s) => s.runtime);
  const config = useStore((s) => s.config);
  const toast = useStore((s) => s.showToast);
  const enabled = useMemo(() => repos.filter((r) => r.enabled), [repos]);
  const [prompt, setPrompt] = useState("");
  const [repoId, setRepoId] = useState("auto");
  const [base, setBase] = useState("");
  const [allowMcp, setAllowMcp] = useState(false);
  const [mcpSel, setMcpSel] = useState<string[] | null>(null);
  const [engine, setEngine] = useState<EngineChoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = enabled.find((r) => r.id === repoId);
  useEffect(() => {
    if (base && (!repo || !repo.allowedBases.includes(base))) setBase("");
  }, [repo, base]);
  const effEngine = engine === "auto" ? config?.aiEngineDefault ?? "codex" : engine;
  const mcp = runtime.find((r) => r.provider === effEngine)?.mcpServers.filter((m) => m.enabled) ?? [];
  useEffect(() => {
    if (repoId === "none" && mcp.length) setAllowMcp(true);
  }, [repoId, mcp.length]);
  // Por defecto sólo fuentes de datos (p. ej. "lrd"); herramientas como node_repl/cua_repl quedan apagadas.
  const selected = mcpSel ?? mcp.map((m) => m.name).filter((n) => !isToolMcp(n));
  const toggle = (n: string) => setMcpSel(selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  if (!open) return null;

  const status = (p: "codex" | "claude") => {
    const r = runtime.find((x) => x.provider === p);
    if (!r) return "…";
    return r.enabled && r.installed && r.authenticated !== false ? "disponible" : r.installed ? "sin sesión" : "no disponible";
  };
  const autoLabel = `Automático (${config?.aiEngineDefault === "claude" ? "Claude Code" : "Codex"})`;

  const submit = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createMission({ prompt: prompt.trim(), repositoryId: repoId, baseBranch: base || null, engine, allowMcp: allowMcp && selected.length > 0, mcpServers: selected });
      setPrompt("");
      setOpen(false);
      toast("Misión creada: el equipo se pone en marcha", "info");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="mission-panel glass" role="dialog" aria-label="Nueva misión">
        <div className="panel-head">
          <div>
            <div className="eyebrow">Nueva misión</div>
            <h2>¿Qué debe resolver el equipo?</h2>
          </div>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar">
            ×
          </button>
        </div>
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ej.: Revisa por qué Rappi no está mandando el código de entrega, corrígelo y prepara el PR."
          rows={4}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <div className="examples">
          {EXAMPLES.map((x) => (
            <button key={x} className="chip" onClick={() => setPrompt(x)}>
              {x.length > 52 ? x.slice(0, 50) + "…" : x}
            </button>
          ))}
        </div>
        <div className="fields">
          <label>
            <span>Repositorio</span>
            <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              <option value="auto">Automático</option>
              {enabled.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.localPath ? " · tu clon" : ""}
                </option>
              ))}
              <option value="none">Sin repo (análisis / datos)</option>
            </select>
          </label>
          <label>
            <span>Rama base</span>
            <select value={base} onChange={(e) => setBase(e.target.value)} disabled={repoId === "none"}>
              <option value="">{repo ? `Por defecto (${repo.defaultBase})` : repoId === "none" ? "No aplica" : "Por defecto del repo"}</option>
              {repo?.allowedBases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Motor IA</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value as EngineChoice)}>
              <option value="auto">{autoLabel}</option>
              <option value="codex">Codex · {status("codex")}</option>
              <option value="claude">Claude Code · {status("claude")}</option>
            </select>
          </label>
        </div>
        {mcp.length > 0 && (
          <div className="mcp-check">
            <label className="check">
              <input type="checkbox" checked={allowMcp} onChange={(e) => setAllowMcp(e.target.checked)} />
              <span>
                Usar datos reales vía MCP <b>(solo lectura)</b>
              </span>
            </label>
            {allowMcp && (
              <div className="mcp-list">
                {mcp.map((m) => (
                  <button key={m.name} type="button" className={`chip ${selected.includes(m.name) ? "on" : ""}`} onClick={() => toggle(m.name)} title={isToolMcp(m.name) ? "Herramienta de ejecución, no fuente de datos" : "Fuente de datos"}>
                    {selected.includes(m.name) ? "✓ " : ""}
                    {m.name}
                    {isToolMcp(m.name) ? " · herramienta" : ""}
                  </button>
                ))}
                {!selected.length && <span className="warn-text">Elige al menos un servidor</span>}
              </div>
            )}
          </div>
        )}
        <div className="fineprint">
          {repoId === "auto" && <>Repositorio y rama son opcionales: si los dejas en automático, Atlas elige según la misión (o trabaja sin repo si es de datos). </>}
          {repoId === "none"
            ? "Sin repositorio: nadie modifica código; el equipo analiza y responde. "
            : <>Se crea una rama <code>agentic/…</code> en un worktree aislado desde <code>{base || repo?.defaultBase || "la rama por defecto"}</code>. La rama base nunca se modifica. </>}
          Push {config?.githubPushEnabled ? "habilitado" : "deshabilitado"} · PR {config?.githubPrEnabled ? "habilitado" : "deshabilitado"}.
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="panel-actions">
          <button className="btn ghost" onClick={() => setOpen(false)}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !prompt.trim()} onClick={submit}>
            {busy ? "Creando…" : "Lanzar misión"}
          </button>
        </div>
      </div>
    </div>
  );
}
