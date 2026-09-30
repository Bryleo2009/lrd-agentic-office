import { isAgentId } from "../../shared/agents";
import type { AgentId, AgentProfile, RepositoryConfig } from "../../shared/types";

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

/** Área para el nombre de rama (se decide antes de crear el worktree). */
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Normaliza para comparar sin tildes ni mayúsculas. */
export { norm };

const FRONT_WORDS = /\b(front|frontend|ui|ux|vista|pantalla|componente|css|scss|html|angular|react|vue|formulario|boton|modal|responsive|pagina|web|checkout|carrito|salon|mobile)\b/;
const BACK_WORDS = /\b(back|backend|api|endpoint|webhook|controller|controlador|servicio|laravel|php|artisan|migracion|cola|queue|job|rappi|pedidosya|pedidos ya|integracion|servidor|cron|base de datos)\b/;
const DATA_WORDS = /\b(datos|data|produccion|prod|ventas|reporte|metricas|kpi|estadisticas|cuantos|cuantas|promedio|ticket|consulta los|analiza los datos|clientes|pedidos del|dashboard)\b/;
const CODE_WORDS = /\b(codigo|build|ci|test|pruebas|bug|error|corrig|arregl|implementa|refactor|compila|deploy|rama|pr)\b/;

/**
 * Elige el repositorio en modo Automático. Devuelve "none" si la misión es de datos/análisis sin código.
 * Siempre explica el motivo (se muestra en la oficina).
 */
export function inferRepo(prompt: string, repos: RepositoryConfig[], mcpAvailable: boolean): { id: string; reason: string } {
  const p = norm(prompt);
  const enabled = repos.filter((r) => r.enabled);
  for (const r of enabled) {
    const names = [r.id, r.name, r.shortName, ...(r.keywords ?? [])].map((x) => norm(x)).filter((x) => x.length > 2);
    const hit = names.find((n) => p.includes(n));
    if (hit && !["back", "front"].includes(hit)) return { id: r.id, reason: `la misión menciona "${hit}"` };
  }
  const isData = DATA_WORDS.test(p) && !CODE_WORDS.test(p);
  if (isData && mcpAvailable) return { id: "none", reason: "es una consulta de datos: se trabaja sin repositorio, con los datos vía MCP" };
  const front = FRONT_WORDS.test(p);
  const back = BACK_WORDS.test(p);
  const byKind = (k: string) => enabled.find((r) => r.kind === k);
  if (front && !back && byKind("frontend")) return { id: byKind("frontend")!.id, reason: "habla de interfaz / frontend" };
  if (back && !front && byKind("backend")) return { id: byKind("backend")!.id, reason: "habla de API / backend / integraciones" };
  if (isData) return { id: "none", reason: "es una consulta de análisis sin cambios de código" };
  const def = byKind("backend") ?? enabled[0];
  if (!def) return { id: "none", reason: "no hay repositorios habilitados" };
  return { id: def.id, reason: front && back ? "menciona front y back; se empieza por el backend" : "no hay pistas claras; se usa el backend por defecto" };
}

export function inferArea(prompt: string, repo: RepositoryConfig | null): string {
  const p = norm(prompt);
  if (/\brappi\b/.test(p)) return "rappi";
  if (/pedidos\s?ya|pedidosya/.test(p)) return "pedidosya";
  if (/factura|finanz|pago|concilia|sunat|contab/.test(p)) return "finance";
  if (/\b(ci|build|compila|pipeline|tests?|pruebas?)\b/.test(p)) return "qa";
  if (/migraci|base de datos|\bsql\b|query|consulta|indice|tabla/.test(p)) return "database";
  if (!repo) return "data";
  if (repo.kind === "frontend") return "frontend";
  if (repo.kind === "backend") return "backend";
  return "general";
}

/** La misión pide explícitamente modificar código (corregir, implementar, …). */
export function asksChange(prompt: string): boolean {
  return /corrig|arregl|\bfix|implementa|agrega|anade|\bcrea|cambia|modifica|refactor|actualiza|prepara el pr|elimina|repara|soluciona/.test(norm(prompt));
}

/**
 * Preferencias de entrega escritas en la misión. Por defecto: rama nueva agentic/… publicada.
 * - "no publiques", "solo local", "sin push" → la rama queda solo local.
 * - "directo en la rama base", "sin crear rama" → commit sobre la base (si no está protegida).
 */
export function deliveryPrefs(prompt: string): { publish: boolean; directToBase: boolean } {
  const p = norm(prompt);
  const publish = !/no (la )?publiques|sin publicar|no (hagas )?push|sin push|no (la )?subas|solo local/.test(p);
  const directToBase = /sin crear (una |ninguna )?rama|no crees (una |ninguna )?rama|directo en la rama|directamente (en|sobre) la rama/.test(p);
  return { publish, directToBase };
}

export function isAnalysisOnly(prompt: string): boolean {
  const asksAnalysis = /analiza|revisa|explica|dime|por que|porque|investiga|diagn|valida/.test(norm(prompt));
  return asksAnalysis && !asksChange(prompt);
}

export function mcpRules(servers: string[]): string {
  if (!servers.length) return "";
  return `
Tienes acceso a servidores MCP con DATOS REALES DE PRODUCCIÓN (${servers.join(", ")}). Reglas obligatorias:
- SOLO LECTURA: únicamente consultas de lectura (SELECT / GET). Nunca INSERT, UPDATE, DELETE, DDL, ni acciones que modifiquen datos o envíen algo.
- Limita resultados (LIMIT / filtros por fecha) y prefiere agregados.
- No copies datos personales sensibles (documentos, teléfonos, correos, tarjetas) en tu respuesta; resume.
- Indica qué consulta usaste para cada cifra.`;
}

export function buildPlannerPrompt(mission: string, repo: RepositoryConfig | null, base: string, team: AgentProfile[], mcp: string[] = []): string {
  const roster = team.filter((a) => a.id !== "atlas" && a.id !== "vega").map((a) => `- ${a.id}: ${a.name}, ${a.role}. ${a.tagline}`).join("\n");
  const where = repo
    ? `Repositorio: ${repo.name} (${repo.kind ?? "desconocido"}), rama base ${base}. Estás dentro de su worktree.
Explora brevemente la estructura del repositorio (máximo unos pocos comandos de lectura) para asignar bien el trabajo.`
    : `Esta misión NO tiene repositorio: es de análisis / datos. Nadie modifica código; todos los pasos son "writes": false.${mcp.length ? " Asigna las consultas de datos a quien mejor encaje (p. ej. Nora para base de datos, Fiona para finanzas, Rafa/Piero para Rappi/PedidosYa)." : ""}`;
  return `Eres Atlas, lead del equipo de agentes de LRD. Tu trabajo AHORA es SOLO planificar (no edites archivos).

Misión del usuario:
"""${mission}"""

${where}
${mcpRules(mcp)}

Equipo disponible (usa el id en "agent"):
${roster}

QA (Vega) y la revisión final (Atlas) las agrega el sistema automáticamente: NO las incluyas.
Git (commit/push/PR) lo controla el sistema: NO lo incluyas.

Reglas del plan:
- Entre 1 y 4 pasos. Usa solo agentes cuyo rol encaje con la misión.
- Pasos de investigación: "writes": false. Pasos que modifican código: "writes": true.
- Si la misión solo pide analizar/explicar, ningún paso debe tener "writes": true.
- Si la misión pide corregir/arreglar/implementar, al menos un paso debe tener "writes": true (y "deliverable": "code_change").
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
  // Si la misión pide corregir, el planificador no puede degradarla a "analysis":
  // eso dejaba pasos como "Corregir …" en modo lectura sin poder editar nada.
  const analysis = isAnalysisOnly(prompt) || (j.deliverable === "analysis" && !asksChange(prompt));
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
export function rulesPlan(prompt: string, repo: RepositoryConfig | null, area: string): MissionPlan {
  if (!repo) {
    const who: AgentId = ({ rappi: "rafa", pedidosya: "piero", finance: "fiona" } as Record<string, AgentId>)[area] ?? "nora";
    return { deliverable: "analysis", steps: [{ id: "s1", agent: who, title: "Analizar datos", task: prompt, dependsOn: [], writes: false }], source: "rules" };
  }
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
