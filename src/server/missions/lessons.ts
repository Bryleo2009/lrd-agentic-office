import fs from "node:fs";
import path from "node:path";
import type { Lesson } from "../../shared/types";
import { config } from "../config";

/**
 * Memoria del equipo: lecciones prácticas aprendidas en misiones anteriores para no repetir errores
 * ni pasos innecesarios (una herramienta que falla, dónde está un dato, qué verificación sobra…).
 * Se inyectan en el plan de Atlas y en las tareas de los agentes. Viven en <workspace>/lessons.json.
 */
export type { Lesson };

const FILE = () => process.env.LRD_LESSONS_FILE || path.join(config.workspaceRoot, "lessons.json");
const MAX = 80;

function load(): Lesson[] {
  try {
    const v = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function save(all: Lesson[]): void {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(all, null, 2));
  } catch {
    /* sin disco: la memoria es una ayuda, no algo crítico */
  }
}

const key = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Quita datos que no deben guardarse (correos, teléfonos, documentos, tokens largos). */
export function sanitizeLesson(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[correo]")
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][\w-]{10,}\b/gi, "[token]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]")
    .replace(/(?<![\w.])\+?\d[\d\s-]{8,}\d\b/g, "[número]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function listLessons(): Lesson[] {
  return load().sort((a, b) => b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt));
}

/** Guarda (o refuerza, si ya existe una muy parecida) una lección. */
export function addLesson(text: string, scope: string, source: Lesson["source"]): Lesson | null {
  const clean = sanitizeLesson(text);
  if (clean.length < 12) return null;
  const all = load();
  const k = key(clean);
  const now = new Date().toISOString();
  const same = all.find((l) => l.scope === scope && (key(l.text) === k || key(l.text).includes(k) || k.includes(key(l.text))));
  if (same) {
    same.hits++;
    same.updatedAt = now;
    if (clean.length > same.text.length && source !== "auto") same.text = clean;
    save(all);
    return same;
  }
  const l: Lesson = { id: Math.random().toString(36).slice(2, 10), text: clean, scope, source, hits: 1, createdAt: now, updatedAt: now };
  all.push(l);
  // Si se llena, se olvidan primero las menos reforzadas y más antiguas.
  all.sort((a, b) => b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt));
  save(all.slice(0, MAX));
  return l;
}

export function deleteLesson(id: string): boolean {
  const all = load();
  const next = all.filter((l) => l.id !== id);
  save(next);
  return next.length !== all.length;
}

/** Lecciones útiles para una misión (según sus repos y si usa datos), como texto para el prompt. */
export function lessonsFor(scopes: string[], limit = 12): string {
  const want = new Set([...scopes, "general"]);
  const picked = listLessons()
    .filter((l) => want.has(l.scope))
    .slice(0, limit);
  if (!picked.length) return "";
  return `\nLecciones de misiones anteriores de este equipo (aplícalas para ir directo y no repetir errores):\n${picked.map((l) => `- ${l.text}`).join("\n")}\n`;
}

/** Extrae líneas "LECCIÓN: …" de una respuesta y devuelve el texto sin ellas. */
export function extractLessons(text: string): { lessons: string[]; rest: string } {
  const lessons: string[] = [];
  const rest = text
    .split(/\r?\n/)
    .filter((line) => {
      const m = line.match(/^\s*[-*•]?\s*LECCI[OÓ]N(?:ES)?\s*:\s*(.+)$/i);
      if (m) lessons.push(m[1].trim());
      return !m;
    })
    .join("\n")
    .trim();
  return { lessons, rest };
}

/** Una herramienta de datos que falló se recuerda como hecho, para no volver a tropezar con ella. */
export function lessonFromToolFailure(tool: string, detail: string): string | null {
  let msg = detail;
  try {
    // Formato MCP: {"content":[{"type":"text","text":"{\"success\":false,\"error\":\"…\"}"}]}
    const j = JSON.parse(detail);
    const inner = j?.content?.[0]?.text ?? j;
    const k = typeof inner === "string" ? JSON.parse(inner) : inner;
    msg = String(k?.error ?? k?.message ?? detail);
  } catch {
    /* texto plano */
  }
  msg = msg.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!msg) return null;
  const short = tool.replace(/^mcp__/, "").replace(/__/g, ".");
  return `La herramienta ${short} falla en este entorno ("${msg}"). No la uses como paso previo; ve directo a la consulta que se necesita.`;
}
