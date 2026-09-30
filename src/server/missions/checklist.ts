import type { AgentId, ChecklistItem } from "../../shared/types";

/**
 * Checklist de la misión: criterios de aceptación visibles en la oficina.
 * Los implementadores marcan "HECHO: n"; la revisión cruzada y Atlas marcan "VERIFICADO: n" o "PENDIENTE: n — motivo".
 */
export function makeChecklist(texts: string[]): ChecklistItem[] {
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, " ").replace(/^[-*•\d.)\s]+/, "").trim().slice(0, 200);
    const k = text.toLowerCase();
    if (text.length < 6 || seen.has(k)) continue;
    seen.add(k);
    out.push({ id: String(out.length + 1), text, status: "pending", by: null, how: null, note: null });
    if (out.length >= 15) break;
  }
  return out;
}

/** Plan B cuando Atlas no devuelve checklist: viñetas y puntos numerados escritos en la misión. */
export function extractChecklist(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = l.match(/^\s*(?:[-*•]|\d{1,2}[.)])\s+(.{6,200})$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** Texto para el prompt de un agente. */
export function checklistPrompt(items: ChecklistItem[], mode: "implement" | "verify"): string {
  if (!items.length) return "";
  const list = items.map((i) => `${i.id}. ${i.text}${i.status === "done" ? " (ya marcado)" : i.status === "failed" ? ` (PENDIENTE: ${i.note ?? ""})` : ""}`).join("\n");
  return mode === "implement"
    ? `\n\nChecklist de la misión (criterios de aceptación):\n${list}\nAl final, por cada punto que TÚ dejaste resuelto escribe una línea "HECHO: <número>" (puedes agrupar: "HECHO: 1, 3, 4"). Si alguno no aplica a tu tarea, "NO_APLICA: <número> — motivo". No marques lo que no hiciste.\n`
    : `\n\nChecklist de la misión (criterios de aceptación):\n${list}\nVerifica cada punto contra el código/resultado real y escribe por cada uno "VERIFICADO: <número>" o "PENDIENTE: <número> — qué falta". No marques VERIFICADO sin evidencia.\n`;
}

const MARK = /^\s*[-*•]?\s*(HECHO|VERIFICADO|PENDIENTE|NO[_ ]APLICA)\s*:\s*([\d\s,y]+?)\s*(?:[—–-]+\s*(.*))?$/i;

/** Aplica las marcas de un agente. Devuelve la lista actualizada y el texto sin esas líneas. */
export function applyChecklistMarks(items: ChecklistItem[], text: string, agentId: AgentId): { items: ChecklistItem[]; rest: string; changed: boolean } {
  if (!items.length) return { items, rest: text, changed: false };
  let changed = false;
  const next = items.map((i) => ({ ...i }));
  const rest = text
    .split(/\r?\n/)
    .filter((line) => {
      const m = line.match(MARK);
      if (!m) return true;
      const kind = m[1].toUpperCase().replace(" ", "_");
      for (const n of m[2].split(/[\s,y]+/).filter(Boolean)) {
        const it = next.find((i) => i.id === n);
        if (!it) continue;
        // Un "HECHO" del implementador no pisa un "PENDIENTE" de la revisión (salvo que la revisión lo verifique).
        if (kind === "HECHO" && it.status === "failed") continue;
        it.status = kind === "PENDIENTE" ? "failed" : kind === "NO_APLICA" ? "skipped" : "done";
        it.how = kind === "HECHO" ? "hecho" : kind === "VERIFICADO" ? "verificado" : kind === "PENDIENTE" ? "pendiente" : "no aplica";
        it.by = agentId;
        it.note = m[3]?.trim() || null;
        changed = true;
      }
      return false;
    })
    .join("\n")
    .trim();
  return { items: next, rest: rest || text, changed };
}
