import { NO_REPO, type Mission } from "../../shared/types";
import { agentOf } from "./team";

/**
 * Informes de misión que Atlas entrega al usuario.
 * Se recuerda en este navegador qué informes ya se vieron (no afecta al servidor).
 */
const ACK_KEY = "lrd.reports.ack";
const SINCE_KEY = "lrd.reports.since";
const DELIVERED_KEY = "lrd.reports.delivered";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* almacenamiento no disponible: el aviso vive solo en esta sesión */
  }
}

/** Solo cuentan misiones terminadas después de empezar a usar esta función (no se reportan las antiguas). */
function since(): string {
  let s = read<string | null>(SINCE_KEY, null);
  if (!s) {
    s = new Date().toISOString();
    write(SINCE_KEY, s);
  }
  return s;
}

const acked = new Set<string>(read<string[]>(ACK_KEY, []));

export function isReportable(m: Mission): boolean {
  return (m.status === "done" || m.status === "failed") && !acked.has(m.id) && m.updatedAt >= since();
}

export function ackReport(id: string): void {
  acked.add(id);
  write(ACK_KEY, [...acked].slice(-200));
}

export interface DeliveredReport {
  id: string;
  missionId: string;
  text: string;
  at: string;
}

/** Informes ya entregados en el chat de Atlas (el chat se reconstruye desde el servidor y no los incluye). */
export function deliveredReports(): DeliveredReport[] {
  return read<DeliveredReport[]>(DELIVERED_KEY, []);
}
export function saveDelivered(r: DeliveredReport): void {
  write(DELIVERED_KEY, [...deliveredReports().filter((x) => x.id !== r.id), r].slice(-30));
}

/** Frase corta para la burbuja de Atlas mientras saluda. */
export function callText(pending: Mission[]): string {
  if (pending.length > 1) return `¡Tengo ${pending.length} informes para ti! Haz clic en mí`;
  const m = pending[0];
  return m.status === "failed" ? `La misión #${m.id} tuvo un problema. ¿Te cuento?` : `¡Terminé la misión #${m.id}! Haz clic en mí`;
}

function splitSummary(summary: string): { headline: string | null; body: string } {
  const lines = summary.trim().split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*RESUMEN:/i.test(l));
  if (i < 0) return { headline: null, body: summary.trim() };
  const headline = lines[i].replace(/^\s*RESUMEN:\s*/i, "").trim();
  const body = lines.filter((_, j) => j !== i).join("\n").trim();
  return { headline: headline || null, body };
}

/** Lo que Atlas le cuenta al usuario: qué pidió, en qué quedó, qué se entregó y qué sigue. */
export function buildReport(m: Mission): string {
  const team = [...new Set(m.steps.filter((s) => s.kind === "agent").map((s) => agentOf(s.agentId).name))];
  const ask = m.prompt.length > 220 ? `${m.prompt.slice(0, 218)}…` : m.prompt;
  const out: string[] = [];

  if (m.status === "failed") {
    out.push(`Hola 👋 Te cuento sobre la misión #${m.id} que me pediste:`, `«${ask}»`, "");
    out.push(`No pudimos terminarla. ${m.error ? `Motivo: ${m.error.split("\n")[0]}` : ""}`.trim());
    const done = m.steps.filter((s) => s.status === "done" && s.kind === "agent");
    if (done.length) out.push("", `Lo que sí alcanzamos a hacer: ${done.map((s) => `${agentOf(s.agentId).name} (${s.title})`).join(", ")}.`);
    out.push("", "¿Quieres que lo reintentemos, o prefieres ajustar el pedido primero?");
    return out.join("\n");
  }

  const { headline, body } = splitSummary(m.summary ?? "");
  out.push(`Hola 👋 Terminé la misión #${m.id} que me pediste:`, `«${ask}»`, "");
  if (headline) out.push(`En resumen: ${headline}`, "");
  if (body) out.push(body.length > 3500 ? `${body.slice(0, 3500)}…` : body, "");
  if (team.length) out.push(`Trabajamos en esto: ${team.join(", ")}.`);

  if (m.commitSha && m.branch) {
    const where = m.pushed ? `publicada en la rama \`${m.branch}\` para que la revises` : `en la rama local \`${m.branch}\` (sin publicar)`;
    out.push(`Entrega: commit ${m.commitSha.slice(0, 7)} ${where}.${m.prUrl ? ` PR: ${m.prUrl}` : ""}`);
  } else if (m.repositoryId !== NO_REPO) {
    out.push("Entrega: fue un análisis, no hubo cambios de código ni ramas nuevas.");
  }
  out.push("", m.commitSha ? "¿La revisas y me dices si la dejamos así o ajustamos algo?" : "¿Quieres que profundice en algo o que preparemos una corrección?");
  return out.join("\n");
}
