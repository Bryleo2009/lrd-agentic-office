import { AGENTS, isAgentId } from "../../shared/agents";
import type { AgentId, RepositoryConfig } from "../../shared/types";

export interface PlannedStep {
  id: string;
  agent: AgentId;
  title: string;
  task: string;
  dependsOn: string[];
  writes: boolean;
}

export interface MissionPlan {
  deliverable: "code_change" | "analysis";
  steps: PlannedStep[];
  source: "ai" | "rules";
  note?: string;
}

const WORKERS = AGENTS.filter((a) => a.id !== "atlas" && a.id !== "vega");

/** Área para el nombre de rama (se decide antes de crear el worktree). */
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function inferArea(prompt: string, repo: RepositoryConfig): string {
  const p = norm(prompt);
  if (/\brappi\b/.test(p)) return "rappi";
  if (/pedidos\s?ya|pedidosya/.test(p)) return "pedidosya";
  if (/factura|finanz|pago|concilia|sunat|contab/.test(p)) return "finance";
  if (/\b(ci|build|compila|pipeline|tests?|pruebas?)\b/.test(p)) return "qa";
  if (/migraci|base de datos|\bsql\b|query|consulta|indice|tabla/.test(p)) return "database";
  if (repo.kind === "frontend") return "frontend";
  if (repo.kind === "backend") return "backend";
  return "general";
}

export function isAnalysisOnly(prompt: string): boolean {
  const p = norm(prompt);
  const asksChange = /corrig|arregl|\bfix|implementa|agrega|anade|\bcrea|cambia|modifica|refactor|actualiza|prepara el pr|elimina/.test(p);
  const asksAnalysis = /analiza|revisa|explica|dime|por que|porque|investiga|diagn|valida/.test(p);
  return asksAnalysis && !asksChange;
}

export function buildPlannerPrompt(mission: string, repo: RepositoryConfig, base: string): string {
  const roster = WORKERS.map((a) => `- ${a.id}: ${a.name}, ${a.role}. ${a.tagline}`).join("\n");
  return `Eres Atlas, lead del equipo de agentes de LRD. Tu trabajo AHORA es SOLO planificar (no edites archivos).

Misión del usuario:
"""${mission}"""

Repositorio: ${repo.name} (${repo.kind ?? "desconocido"}), rama base ${base}. Estás dentro de su worktree.
Explora brevemente la estructura del repositorio (máximo unos pocos comandos de lectura) para asignar bien el trabajo.

Equipo disponible:
${roster}

QA (Vega) y la revisión final (Atlas) las agrega el sistema automáticamente: NO las incluyas.
Git (commit/push/PR) lo controla el sistema: NO lo incluyas.

Reglas del plan:
- Entre 1 y 4 pasos. Usa solo agentes cuyo rol encaje con la misión.
- Pasos de investigación: "writes": false. Pasos que modifican código: "writes": true.
- Si la misión solo pide analizar/explicar, ningún paso debe tener "writes": true.
- Pasos independientes no deben depender entre sí (se ejecutan en paralelo).
- "task" debe ser una instrucción concreta y autocontenida para ese agente.

Responde ÚNICAMENTE con un bloque JSON válido, sin texto adicional, con esta forma:
{"deliverable":"code_change"|"analysis","steps":[{"id":"s1","agent":"rafa","title":"…","task":"…","dependsOn":[],"writes":false}]}`;
}

export function parsePlan(text: string, prompt: string): MissionPlan | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fence) for (const f of fence) candidates.push(f.replace(/```(?:json)?/g, "").trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const plan = validate(j, prompt);
      if (plan) return plan;
    } catch {
      /* siguiente */
    }
  }
  return null;
}

function validate(j: any, prompt: string): MissionPlan | null {
  if (!j || !Array.isArray(j.steps) || j.steps.length === 0) return null;
  const analysis = j.deliverable === "analysis" || isAnalysisOnly(prompt);
  const steps: PlannedStep[] = [];
  const ids = new Set<string>();
  for (const [i, s] of j.steps.slice(0, 6).entries()) {
    const agent = String(s.agent ?? "").toLowerCase();
    if (!isAgentId(agent) || agent === "atlas" || agent === "vega") continue;
    let id = String(s.id ?? `s${i + 1}`).replace(/[^\w-]/g, "") || `s${i + 1}`;
    while (ids.has(id)) id += "x";
    ids.add(id);
    steps.push({
      id,
      agent,
      title: String(s.title ?? "Paso").slice(0, 120),
      task: String(s.task ?? s.title ?? "").slice(0, 4000),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      writes: analysis ? false : !!s.writes,
    });
  }
  if (!steps.length) return null;
  for (const s of steps) s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id);
  if (hasCycle(steps)) return null;
  return { deliverable: analysis ? "analysis" : "code_change", steps, source: "ai" };
}

function hasCycle(steps: PlannedStep[]): boolean {
  const map = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const d of map.get(id)?.dependsOn ?? []) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return steps.some((s) => visit(s.id));
}

/** Plan base por reglas cuando el motor no devuelve JSON válido. Se informa explícitamente en la UI. */
export function rulesPlan(prompt: string, repo: RepositoryConfig, area: string): MissionPlan {
  const analysis = isAnalysisOnly(prompt);
  const specialist: Record<string, AgentId> = { rappi: "rafa", pedidosya: "piero", finance: "fiona", database: "nora" };
  const implementer: AgentId = repo.kind === "frontend" ? "mica" : "diego";
  const steps: PlannedStep[] = [];
  const spec = specialist[area];
  if (spec) {
    steps.push({ id: "s1", agent: spec, title: "Investigar la causa", task: `Investiga en el repositorio: ${prompt}. Identifica archivos y causa raíz. No modifiques archivos.`, dependsOn: [], writes: false });
  }
  if (!analysis) {
    steps.push({ id: `s${steps.length + 1}`, agent: implementer, title: "Implementar la corrección", task: prompt, dependsOn: steps.map((s) => s.id), writes: true });
  } else if (!spec) {
    steps.push({ id: "s1", agent: implementer, title: "Analizar", task: `${prompt}\nNo modifiques archivos; entrega un diagnóstico con evidencia (archivos y líneas).`, dependsOn: [], writes: false });
  }
  return { deliverable: analysis ? "analysis" : "code_change", steps, source: "rules" };
}
