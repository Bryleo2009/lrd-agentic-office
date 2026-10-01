import { customAlphabet } from "nanoid";
import type { AgentId, LibraryDoc, LibraryKind } from "../shared/types";
import { sqlite } from "./database/db";

/**
 * Biblioteca del equipo: lo que queda documentado de cada misión (resumen, informes de cada tarea,
 * investigaciones, decisiones que tomaste, incidentes) más los manuales que agregues tú. Se guarda en
 * office.db (no se borra con la limpieza de carpetas) y Atlas y los agentes la consultan antes de trabajar.
 * La documentación sale de lo que el equipo ya escribió: no gasta llamadas extra al motor.
 */

const idGen = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);
const KINDS: LibraryKind[] = ["mision", "informe", "investigacion", "decision", "incidente", "manual"];

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string;
  mission_id: string | null;
  agent_id: string | null;
  repository_id: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

const toDoc = (r: Row): LibraryDoc => ({
  id: r.id,
  kind: (KINDS.includes(r.kind as LibraryKind) ? r.kind : "manual") as LibraryKind,
  title: r.title,
  body: r.body,
  missionId: r.mission_id,
  agentId: r.agent_id as AgentId | null,
  repositoryId: r.repository_id,
  tags: (() => {
    try {
      return JSON.parse(r.tags);
    } catch {
      return [];
    }
  })(),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface NewDoc {
  kind: LibraryKind;
  title: string;
  body: string;
  missionId?: string | null;
  agentId?: AgentId | null;
  repositoryId?: string | null;
  tags?: string[];
  /** Clave de origen (p. ej. "step:<id>"): el mismo origen actualiza el documento en vez de duplicarlo. */
  sourceKey?: string | null;
}

/** Guarda (o actualiza, si ya existe uno con la misma clave de origen) un documento. */
export function saveDoc(d: NewDoc): LibraryDoc {
  const now = new Date().toISOString();
  const title = d.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Sin título";
  const body = d.body.trim().slice(0, 40_000);
  const tags = JSON.stringify([...new Set((d.tags ?? []).filter(Boolean).map(String))].slice(0, 12));
  const prior = d.sourceKey ? (sqlite.prepare("SELECT * FROM library_docs WHERE source_key = ?").get(d.sourceKey) as Row | undefined) : undefined;
  if (prior) {
    sqlite
      .prepare("UPDATE library_docs SET kind = ?, title = ?, body = ?, mission_id = ?, agent_id = ?, repository_id = ?, tags = ?, updated_at = ? WHERE id = ?")
      .run(d.kind, title, body, d.missionId ?? null, d.agentId ?? null, d.repositoryId ?? null, tags, now, prior.id);
    return getDoc(prior.id)!;
  }
  const id = idGen();
  sqlite
    .prepare("INSERT INTO library_docs (id, kind, title, body, mission_id, agent_id, repository_id, source_key, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, d.kind, title, body, d.missionId ?? null, d.agentId ?? null, d.repositoryId ?? null, d.sourceKey ?? null, tags, now, now);
  return getDoc(id)!;
}

export function getDoc(id: string): LibraryDoc | null {
  const r = sqlite.prepare("SELECT * FROM library_docs WHERE id = ?").get(id) as Row | undefined;
  return r ? toDoc(r) : null;
}

export function deleteDoc(id: string): boolean {
  return sqlite.prepare("DELETE FROM library_docs WHERE id = ?").run(id).changes > 0;
}

export function libraryCounts(): Record<LibraryKind | "todo", number> {
  const rows = sqlite.prepare("SELECT kind, COUNT(*) AS n FROM library_docs GROUP BY kind").all() as { kind: LibraryKind; n: number }[];
  const out = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<LibraryKind | "todo", number>;
  out.todo = 0;
  for (const r of rows) {
    if (r.kind in out) out[r.kind] = r.n;
    out.todo += r.n;
  }
  return out;
}

// ---------------------------------------------------------------- búsqueda

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const STOP = new Set(
  "para como cual cuales cuando donde desde este esta estos estas pero porque sobre entre hasta segun todo toda todos todas tambien solo sola misma mismo cada otro otra otros otras debe deben puede pueden hace hacer hacen tiene tienen tener esto eso aqui ahora luego antes despues mision agente agentes favor quiero dame dime revisa revisar ver usar usa implementa corrige arregla the and with from that this into only".split(
    " ",
  ),
);

/** Palabras con significado de un texto (sin tildes ni palabras vacías), sin repetir. */
export function terms(text: string, max = 24): string[] {
  const words = norm(text).match(/[a-z0-9_./-]{3,}/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    const t = w.replace(/^[./-]+|[./-]+$/g, "");
    if (t.length < 4 || STOP.has(t) || /^\d{1,3}$/.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function score(doc: LibraryDoc, ts: string[]): { score: number; matched: number } {
  const title = norm(doc.title);
  const body = norm(doc.body);
  const tags = norm(doc.tags.join(" "));
  let s = 0;
  let matched = 0;
  for (const t of ts) {
    const inTitle = title.includes(t);
    const inTags = tags.includes(t);
    const inBody = body.includes(t);
    if (inTitle || inTags || inBody) matched++;
    s += (inTitle ? 3 : 0) + (inTags ? 2 : 0) + (inBody ? 1 : 0);
  }
  return { score: s, matched };
}

/** Documentos más recientes (la relevancia se calcula en JS: SQLite no compara sin tildes). */
function candidates(kind: LibraryKind | null | undefined, cap: number): LibraryDoc[] {
  const rows = kind
    ? sqlite.prepare("SELECT * FROM library_docs WHERE kind = ? ORDER BY created_at DESC LIMIT ?").all(kind, cap)
    : sqlite.prepare("SELECT * FROM library_docs ORDER BY created_at DESC LIMIT ?").all(cap);
  return (rows as Row[]).map(toDoc);
}

/** Búsqueda para la ventana de la biblioteca: por relevancia si hay texto, si no las más recientes. */
export function searchLibrary(opts: { q?: string; kind?: LibraryKind | null; limit?: number }): LibraryDoc[] {
  const limit = Math.min(200, opts.limit ?? 80);
  const ts = opts.q ? terms(opts.q, 8) : [];
  if (!ts.length) return candidates(opts.kind, limit);
  const all = candidates(opts.kind, 2000);
  return all
    .map((d) => ({ d, ...score(d, ts) }))
    .filter((x) => x.matched > 0)
    .sort((a, b) => b.matched - a.matched || b.score - a.score || b.d.createdAt.localeCompare(a.d.createdAt))
    .slice(0, limit)
    .map((x) => x.d);
}

/**
 * Documentos relacionados con una tarea (para "consultar la biblioteca" antes de trabajar): coinciden en
 * al menos 2 términos (o 1 si la tarea es muy corta), se prefieren los del mismo repositorio, las decisiones
 * y los manuales. Nunca se devuelve la documentación de la propia misión.
 */
export function relatedDocs(text: string, opts: { repoIds?: string[]; excludeMissionId?: string | null; limit?: number } = {}): LibraryDoc[] {
  const ts = terms(text);
  if (!ts.length) return [];
  const need = ts.length <= 2 ? 1 : 2;
  const repos = new Set(opts.repoIds ?? []);
  return candidates(null, 2000)
    .filter((d) => !opts.excludeMissionId || d.missionId !== opts.excludeMissionId)
    .map((d) => {
      const r = score(d, ts);
      const bonus = (d.repositoryId && repos.has(d.repositoryId) ? 2 : 0) + (d.kind === "decision" || d.kind === "manual" ? 2 : 0) + (d.kind === "mision" ? 1 : 0);
      return { d, matched: r.matched, score: r.score + bonus };
    })
    .filter((x) => x.matched >= need)
    .sort((a, b) => b.score - a.score || b.d.createdAt.localeCompare(a.d.createdAt))
    .slice(0, opts.limit ?? 3)
    .map((x) => x.d);
}

const KIND_LABEL: Record<LibraryKind, string> = { mision: "Misión", informe: "Informe de tarea", investigacion: "Investigación", decision: "Decisión", incidente: "Incidente", manual: "Manual" };

/** Texto para el prompt con extractos de los documentos relacionados. */
export function libraryPrompt(docs: LibraryDoc[], excerpt = 500): string {
  if (!docs.length) return "";
  return `\nDocumentación del equipo relacionada (biblioteca). Úsala para no re-investigar lo que ya se sabe; si algo pudo cambiar desde entonces, verifícalo:\n${docs
    .map((d) => {
      const body = d.body.replace(/\n{3,}/g, "\n\n").trim();
      return `### [${KIND_LABEL[d.kind]}] ${d.title} (${d.createdAt.slice(0, 10)}${d.missionId ? ` · misión #${d.missionId}` : ""})\n${body.length > excerpt ? `${body.slice(0, excerpt)}…` : body}`;
    })
    .join("\n\n")}\n`;
}
