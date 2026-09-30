import { useEffect, useState } from "react";
import { LIBRARY_KIND_LABEL, type LibraryDoc, type LibraryKind } from "../../shared/types";
import { api } from "../app/api";
import { useStore } from "../app/store";
import { agentOf as getAgent } from "../app/team";
import { ago, useFloating } from "../app/useFloating";
import { RichText } from "../drawers/RichText";

const ICON: Record<LibraryKind, string> = { mision: "🎯", informe: "📝", investigacion: "🔎", decision: "⚖️", incidente: "⚠️", manual: "📘" };
const DAY = 86_400_000;

/**
 * Biblioteca: todo lo que el equipo dejó documentado (misiones, informes de tarea, investigaciones,
 * decisiones, incidentes) y tus manuales. Buscable; se actualiza sola cuando el equipo documenta algo.
 */
export function LibraryWindow({ onOpenMission }: { onOpenMission: (missionId: string) => void }) {
  const open = useStore((s) => s.libraryOpen);
  const setOpen = useStore((s) => s.setLibraryOpen);
  const version = useStore((s) => s.libraryVersion);
  const toast = useStore((s) => s.showToast);
  useStore((s) => s.team);
  const { ref, style, headProps } = useFloating("lrd.library.pos", open);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<LibraryKind | null>(null);
  const [data, setData] = useState<{ docs: LibraryDoc[]; counts: Record<string, number> } | null>(null);
  const [sel, setSel] = useState<LibraryDoc | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "" });

  // Búsqueda con una pequeña espera mientras escribes; se recarga cuando el equipo documenta algo.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      void api
        .library(q.trim(), kind)
        .then((d) => {
          setData(d);
          setSel((cur) => (cur ? (d.docs.find((x) => x.id === cur.id) ?? cur) : cur));
        })
        .catch(() => setData({ docs: [], counts: {} }));
    }, 250);
    return () => clearTimeout(t);
  }, [open, q, kind, version]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && document.activeElement?.closest(".library") && (sel ? setSel(null) : setOpen(false));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, sel, setOpen]);

  if (!open) return null;
  const counts = data?.counts ?? {};
  const kinds = Object.keys(LIBRARY_KIND_LABEL) as LibraryKind[];

  const addManual = async () => {
    try {
      await api.addLibraryDoc(draft.title.trim(), draft.body.trim());
      setDraft({ title: "", body: "" });
      setAdding(false);
      toast("Manual agregado a la biblioteca", "info");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const forget = async (d: LibraryDoc) => {
    if (!confirm(`¿Olvidar "${d.title}"? El equipo ya no lo consultará.`)) return;
    await api.deleteLibraryDoc(d.id).catch((e) => toast((e as Error).message));
    setSel(null);
  };

  return (
    <section ref={ref as React.RefObject<HTMLElement>} className="library glass" style={style} aria-label="Biblioteca del equipo">
      <header className="tablet-head" {...headProps}>
        <span className="lib-mark" aria-hidden>
          📚
        </span>
        <div className="grow">
          <b>Biblioteca</b>
          <small className="muted">todo lo que el equipo ha documentado · lo consultan antes de trabajar</small>
        </div>
        <button className="btn tiny ghost" onClick={() => setAdding(!adding)}>
          {adding ? "Cancelar" : "+ Manual"}
        </button>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar biblioteca">
          ×
        </button>
      </header>

      <div className="lib-body">
        {adding && (
          <div className="lib-add">
            <input value={draft.title} placeholder="Título (p. ej. Cómo se numeran las órdenes)" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea
              value={draft.body}
              rows={5}
              placeholder="Contenido. El equipo lo leerá cuando una misión trate de esto."
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <button className="btn primary tiny" disabled={!draft.title.trim() || !draft.body.trim()} onClick={() => void addManual()}>
              Guardar en la biblioteca
            </button>
          </div>
        )}

        {sel ? (
          <article className="lib-doc">
            <div className="lib-doc-bar">
              <button className="btn tiny ghost" onClick={() => setSel(null)}>
                ← Volver
              </button>
              {sel.missionId && (
                <button className="btn tiny ghost" onClick={() => onOpenMission(sel.missionId!)}>
                  Ver misión #{sel.missionId}
                </button>
              )}
              <span className="grow" />
              <button className="btn tiny ghost" onClick={() => void forget(sel)}>
                Olvidar
              </button>
            </div>
            <h3>
              {ICON[sel.kind]} {sel.title}
            </h3>
            <div className="muted tiny">
              {LIBRARY_KIND_LABEL[sel.kind]}
              {sel.agentId ? ` · ${getAgent(sel.agentId).name}` : ""}
              {sel.repositoryId ? ` · ${sel.repositoryId}` : ""} · {new Date(sel.createdAt).toLocaleString("es-PE")}
            </div>
            <div className="lib-doc-body msg agent">
              <RichText text={sel.body} />
            </div>
          </article>
        ) : (
          <>
            <input className="lib-search" value={q} placeholder="Buscar en la biblioteca (p. ej. «cabecera_ordens», «rappi», «CI»)" onChange={(e) => setQ(e.target.value)} autoFocus />
            <div className="lib-kinds">
              <button className={`chip ${kind === null ? "on" : ""}`} onClick={() => setKind(null)}>
                Todo · {counts.todo ?? 0}
              </button>
              {kinds.map((k) => (
                <button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(kind === k ? null : k)} disabled={!counts[k] && kind !== k}>
                  {LIBRARY_KIND_LABEL[k]} · {counts[k] ?? 0}
                </button>
              ))}
            </div>
            <ul className="lib-list">
              {data === null && <li className="empty">Cargando…</li>}
              {data && data.docs.length === 0 && (
                <li className="empty">
                  {q || kind
                    ? "Nada con ese filtro."
                    : "Todavía no hay documentos. Cada misión que termine dejará su resumen, los informes de sus tareas y las decisiones que tomes."}
                </li>
              )}
              {data?.docs.map((d) => (
                <li key={d.id}>
                  <button className="lib-item" onClick={() => setSel(d)}>
                    <span className="lib-icon" aria-hidden>
                      {ICON[d.kind]}
                    </span>
                    <span className="grow">
                      <span className="lib-title">
                        {d.title}
                        {Date.now() - new Date(d.createdAt).getTime() < DAY && <span className="lib-new">NUEVO</span>}
                      </span>
                      <small className="muted">
                        {LIBRARY_KIND_LABEL[d.kind]}
                        {d.agentId ? ` · ${getAgent(d.agentId).name}` : ""}
                        {d.repositoryId ? ` · ${d.repositoryId}` : ""} · {ago(d.createdAt)}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
