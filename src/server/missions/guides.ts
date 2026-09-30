import fs from "node:fs";
import path from "node:path";
import type { TaskKind } from "../../shared/types";
import { config } from "../config";
import { ciRunRef, isQuickLookup, norm } from "./MissionPlanner";

/**
 * Guías por tipo de tarea: cómo trabaja el equipo cuando la misión es de un tipo conocido
 * (corregir un CI en rojo, consultar un dato puntual…). Viven en config/guides/<tipo>.md para que
 * se puedan ajustar sin tocar código, y se agregan al plan de Atlas y a la tarea de cada agente.
 */

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  "ci-fix": "Corrección de CI",
  "data-lookup": "Consulta de datos",
  general: "General",
};

const CI_WORDS = /\b(ci|github actions|actions|pipeline|workflow|lint|type-?check|build|quality|checks?)\b/;
const BROKEN = /\b(falla|fallo|fallando|rojo|roto|rompe|rompio|corrig|arregl|repar|fix|verde|pasa|pase|error(es)?)\b/;

/** Tipo de tarea de la misión. */
export function taskKind(prompt: string, noRepo: boolean): TaskKind {
  const p = norm(prompt);
  if (!noRepo && (ciRunRef(prompt) || (CI_WORDS.test(p) && BROKEN.test(p)))) return "ci-fix";
  if (noRepo && isQuickLookup(prompt)) return "data-lookup";
  if (noRepo && /\b(dame|dime|busca|consulta|cuanto|cuantos|cuantas|info|informacion)\b/.test(p)) return "data-lookup";
  return "general";
}

/** Texto de la guía para el prompt ("" si no hay guía para ese tipo). */
export function guideFor(kind: TaskKind): string {
  if (kind === "general") return "";
  try {
    const text = fs.readFileSync(path.join(config.guidesDir, `${kind}.md`), "utf8").trim();
    if (!text) return "";
    return `\nGuía del equipo para este tipo de tarea (${TASK_KIND_LABEL[kind]}). Síguela salvo que la misión diga otra cosa:\n${text.replace(/^#.*\n+/, "")}\n`;
  } catch {
    return "";
  }
}
