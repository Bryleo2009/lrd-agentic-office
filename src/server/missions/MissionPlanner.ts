import { isAgentId } from "../../shared/agents";
import { MULTI_REPO_SEP, type AgentId, type AgentProfile, type RepositoryConfig } from "../../shared/types";

export interface PlannedStep {
  id: string;
  agent: AgentId;
  title: string;
  task: string;
  dependsOn: string[];
  writes: boolean;
  /** Repositorio del paso (misiones con varios repos). */
  repo?: string;
}

export interface MissionPlan {
  deliverable: "code_change" | "analysis";
  /** Cómo entregar, según lo que Atlas entendió de la misión completa (no por palabras sueltas). */
  delivery?: { publish: boolean; directToBase: boolean };
  /** Criterios de aceptación verificables extraídos de la misión. */
  checklist?: string[];
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

const RECORD_WORDS = /\b(pedido|pedidos|orden|ordenes|boleta|boletas|factura|facturas|comprobante|cliente|venta|ventas|ticket|producto|delivery|correlativo|transaccion|pago|cuenta|mesa|reserva)\b/;

/**
 * Consulta puntual de datos ("dame info del pedido que termina en 201631", "¿cuántas ventas hubo ayer?"):
 * la responde un solo agente con los datos, sin repositorio, sin planificación de Atlas y sin reunión final.
 */
export function isQuickLookup(prompt: string): boolean {
  const p = norm(prompt);
  if (p.length > 280 || asksChange(prompt) || CODE_WORDS.test(p)) return false;
  const asks = /^(dame|dime|muestrame|busca|buscame|consulta|revisa|ver|que|cual|cuales|cuanto|cuantos|cuantas|como esta|estado|info)\b|\?/.test(p);
  const aboutRecord = RECORD_WORDS.test(p) && (/\d{3,}/.test(p) || /\b(hoy|ayer|semana|mes|ultimo|ultima|ultimos|ultimas)\b/.test(p));
  return aboutRecord || (asks && DATA_WORDS.test(p));
}

/**
 * Elige el repositorio en modo Automático. Devuelve "none" si la misión es de datos/análisis sin código.
 * Siempre explica el motivo (se muestra en la oficina).
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Frases que prohíben algo: "no tocar X", "no uses X", "sin modificar X", "excepto X"… */
const NEGATION = /(\bno\b|\bnunca\b|\bsin\b|\bexcepto\b|\bni\b)[^.\n]{0,40}$/;

/**
 * Puntúa cuánto pide la misión un término (repo o rama): menciones explícitas suman, las que están
 * dentro de una prohibición ("No tocar lrd-back", "No uses release/fase2") restan.
 */
function mentionScore(p: string, term: string, strong: RegExp): number {
  const t = norm(term);
  if (t.length < 3) return 0;
  let score = 0;
  const re = new RegExp(`(^|[^a-z0-9_/-])${escapeRe(t)}(?![a-z0-9_-])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    const before = p.slice(Math.max(0, m.index - 60), m.index + m[1].length);
    if (NEGATION.test(before)) score -= 5;
    else score += strong.test(before) ? 4 : 1;
  }
  return score;
}

/** Rama base pedida en el texto ("Parte desde release/fase3.1", "No uses release/fase2"), si es inequívoca. */
export function inferBase(prompt: string, repo: RepositoryConfig): string | null {
  const p = norm(prompt).replace(/`/g, " ");
  const scored = repo.allowedBases
    .map((b) => ({ b, s: mentionScore(p, b, /(desde|parte|partir|base|sobre|from|basad[ao])[^.\n]{0,40}$/) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!scored.length || (scored[1] && scored[1].s === scored[0].s)) return null;
  return scored[0].b;
}

/**
 * Ramas existentes que la misión nombra como punto de partida ("en la rama feature/x", "corrige feature/y"),
 * aunque no estén entre las ramas base configuradas. Excluye la rama de salida agentic/… y las prohibidas.
 */
export function mentionedBranches(prompt: string): string[] {
  const out = requestedBranch(prompt);
  const p = norm(prompt).replace(/`/g, " ");
  const names = new Set<string>();
  for (const m of prompt.matchAll(/(?<![\w/.-])((?:feature|feat|fix|hotfix|bugfix|release|chore|refactor|develop|dev|hotfixes|features)\/[A-Za-z0-9._\/-]*[A-Za-z0-9])/g)) names.add(m[1]);
  return [...names].filter((b) => b !== out && mentionScore(p, b, /(rama|branch|desde|en|sobre|de|del)[^.\n]{0,40}$/) > 0);
}

/**
 * Referencia a una ejecución de GitHub Actions: enlace .../actions/runs/<id> o "#<número>" junto a palabras de CI.
 * Devuelve el id o el número de ejecución y, si se nombra, el workflow ("Frontend Quality").
 */
export function ciRunRef(prompt: string): { runId?: number; runNumber?: number; workflowHint: string | null } | null {
  const url = prompt.match(/actions\/runs\/(\d{5,})/);
  const wf = prompt.match(/\b(?:ci|workflow|action)\s+[«"'`]?([A-Za-z][\w -]{2,40}?(?:quality|ci|tests?|build|lint|check|checks|pipeline))\b/i)?.[1]?.trim() ?? null;
  if (url) return { runId: Number(url[1]), workflowHint: wf };
  const p = norm(prompt);
  if (!/\b(ci|actions?|workflow|pipeline|quality|run|ejecucion)\b/.test(p)) return null;
  const n = prompt.match(/#(\d{1,6})\b/) ?? prompt.match(/\b(?:run|ejecuci[oó]n)\s+(\d{1,6})\b/i);
  return n ? { runNumber: Number(n[1]), workflowHint: wf } : null;
}

/** Nombre de rama pedido explícitamente ("Crea una rama agentic/feature/xyz"). Debe empezar con agentic/. */
export function requestedBranch(prompt: string): string | null {
  const m = prompt.match(/\bagentic\/[A-Za-z0-9._\/-]*[A-Za-z0-9]/);
  if (!m) return null;
  const b = m[0].replace(/\/{2,}/g, "/");
  return /^agentic\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(b) && !b.includes("..") ? b : null;
}

export function inferRepo(prompt: string, repos: RepositoryConfig[], mcpAvailable: boolean): { id: string; reason: string } {
  const p = norm(prompt).replace(/`/g, " ");
  const enabled = repos.filter((r) => r.enabled);
  // Menciones explícitas (nombre, owner/repo de GitHub, palabras clave), descontando las prohibidas.
  const strong = /(repositorio|repo|trabaja|sobre|en el|modifica|cambia|en)[^.\n]{0,30}$/;
  const scored = enabled
    .map((r) => {
      const names = [...new Set([r.github, r.id, r.name, ...(r.keywords ?? [])].filter(Boolean))];
      return { r, s: names.reduce((acc, n) => acc + mentionScore(p, n, strong), 0) };
    })
    .sort((a, b) => b.s - a.s);
  const forbidden = scored.filter((x) => x.s < 0).map((x) => x.r.id);
  if (scored[0] && scored[0].s > 0 && !(scored[1] && scored[1].s === scored[0].s))
    return { id: scored[0].r.id, reason: `la misión pide ${scored[0].r.name}${forbidden.length ? ` (y prohíbe ${forbidden.join(", ")})` : ""}` };
  const isData = (DATA_WORDS.test(p) || isQuickLookup(prompt)) && !CODE_WORDS.test(p);
  if (isData && mcpAvailable) return { id: "none", reason: "es una consulta de datos: se trabaja sin repositorio, con los datos vía MCP" };
  const front = FRONT_WORDS.test(p);
  const back = BACK_WORDS.test(p);
  const byKind = (k: string) => enabled.find((r) => r.kind === k && !forbidden.includes(r.id));
  if (front && back && byKind("frontend") && byKind("backend"))
    return { id: `${byKind("backend")!.id}${MULTI_REPO_SEP}${byKind("frontend")!.id}`, reason: "menciona front y back: el equipo de back y el de front trabajan en paralelo" };
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
  return /corrig|arregl|\bfix|implementa|agrega|anade|\bcrea|cambia|\bcambio\b|modifica|refactor|actualiza|prepara el pr|elimina|repara|soluciona|\bajusta|\bquita|reemplaza|renombra|\bedita|\baplica|\bpublica(?!ndo)|reintenta|revi[eé]rt|revert|\bdeshaz|deshac|restaur|\brestore/.test(norm(prompt));
}

const R = "(?:rama|branch)";
/** Frases que piden NO crear rama: ya son una negación, así que cuentan directamente. */
const NO_NEW_BRANCH = [
  new RegExp(`\\b(?:sin|no)\\s+(?:crear|crees|abrir|abras|generar|generes|hacer|hagas|nueva|otra)\\b[^.\\n]{0,20}\\b${R}\\b`),
  new RegExp(`\\b(?:sin|no)\\s+(?:una\\s+|otra\\s+)?${R}\\s+(?:nueva|aparte|adicional|distinta|diferente)\\b`),
  new RegExp(`\\b(?:don'?t|do not|without)\\s+(?:creating|create|opening|open|a|any|new)\\b[^.\\n]{0,20}\\bbranch\\b`),
];
/** Frases positivas de "en la misma rama"; se descartan si van dentro de una prohibición. */
const SAME_BRANCH = [
  new RegExp(`\\bmism[ao]\\s+${R}\\b`),
  new RegExp(`\\b(?:en|sobre|a|hacia)\\s+(?:esa|dicha|esta|su|la\\s+propia|su\\s+propia)\\s+${R}\\b`),
  new RegExp(`\\b(?:directo|directos|directa|directas|directamente)\\b[^.\\n]{0,25}\\b${R}\\b`),
  new RegExp(`\\b${R}\\s+(?:original|actual|existente|de\\s+origen|que\\s+falla|del\\s+(?:ci|run|pr|pull\\s+request|error))\\b`),
  new RegExp(`\\b(?:commit\\w*|push\\w*|sub\\w*|empuj\\w*|publica\\w*|integra\\w*|merge\\w*|aplica\\w*)\\b[^.\\n]{0,25}\\b(?:en|a|sobre)\\s+(?:la\\s+)?${R}\\s+base\\b`),
  /\bsame branch\b/,
  /\bdirectly (?:on|to|in|into) (?:the |that |this )?(?:\w+ )?branch\b/,
];

/** ¿La misión (ya normalizada) pide entregar directo en la rama base, sin rama nueva? */
function wantsDirectToBase(p: string): boolean {
  if (NO_NEW_BRANCH.some((re) => re.test(p))) return true;
  for (const re of SAME_BRANCH) {
    const g = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(p))) {
      const before = p.slice(Math.max(0, m.index - 30), m.index);
      if (!/(\bno\b|\bnunca\b|\bni\b|\bnot\b|\bnever\b|don'?t)[^.\n]{0,25}$/.test(before)) return true;
    }
  }
  return false;
}

/**
 * Preferencias de entrega escritas en la misión. Por defecto: rama nueva agentic/… publicada.
 * - "no publiques", "solo local", "sin push" → la rama queda solo local.
 * - "directo en la rama base", "sin crear rama" → commit sobre la base (si no está protegida).
 */
export function deliveryPrefs(prompt: string): { publish: boolean; directToBase: boolean } {
  const p = norm(prompt);
  const publish = !/no (la )?publiques|sin publicar|no (hagas )?push|sin push|no (la )?subas|solo local/.test(p);
  const directToBase = wantsDirectToBase(p);
  return { publish, directToBase };
}

export function isAnalysisOnly(prompt: string): boolean {
  const asksAnalysis = /analiza|revisa|explica|dime|por que|porque|investiga|diagn|valida/.test(norm(prompt));
  return asksAnalysis && !asksChange(prompt);
}

/** Entorno de una fuente de datos según su nombre (servidor MCP o plugin). */
export function mcpEnv(name: string): "Producción" | "QA" | null {
  const n = name.toLowerCase();
  if (/(^|[-_.\s])(qa|staging|stage|stg|test|testing|dev|sandbox|pruebas?)([-_.\s]|$)/.test(n)) return "QA";
  if (/prod|production|produccion|producción|live/.test(n) || /(^|[-_.\s])pr([-_.\s]|$)/.test(n)) return "Producción";
  return null;
}

export function mcpRules(servers: string[]): string {
  if (!servers.length) return "";
  // Si hay una fuente marcada como QA, las que no dicen entorno son las de siempre: Producción.
  const hasQa = servers.some((s) => mcpEnv(s) === "QA");
  const labeled = servers.map((s) => ({ s, env: mcpEnv(s) ?? (hasQa && !servers.some((x) => mcpEnv(x) === "Producción") ? ("Producción" as const) : null) }));
  const envs = labeled.some((x) => x.env === "QA") && labeled.some((x) => x.env === "Producción");
  return `
Tienes acceso a servidores MCP con DATOS REALES (${labeled.map((x) => (x.env ? `${x.s} = ${x.env}` : x.s)).join(", ")}). Reglas obligatorias:
- Entornos: ${envs ? "hay Producción y QA. Si la misión no dice el entorno, busca primero en Producción y, si no aparece, en QA antes de concluir; di siempre en qué entorno estaba el dato." : "si ves herramientas o backends de Producción y de QA (por su nombre), y la misión no dice el entorno, busca en Producción y luego en QA antes de concluir; di en qué entorno estaba el dato."}
- Un 404 / "no encontrado" / sin resultados es una respuesta sobre los datos, NO una herramienta rota. Si buscaste por un número incompleto, busca por coincidencia parcial antes de concluir.
- SOLO LECTURA: únicamente consultas de lectura (SELECT / GET). Nunca INSERT, UPDATE, DELETE, DDL, ni acciones que modifiquen datos o envíen algo.
- Limita resultados (LIMIT / filtros por fecha) y prefiere agregados.
- No copies datos personales sensibles (documentos, teléfonos, correos, tarjetas) en tu respuesta; resume.
- Indica qué consulta usaste para cada cifra.`;
}

/** Repositorio de trabajo con su carpeta (para planificar misiones de varios repos). */
export interface PlanRepo {
  repo: RepositoryConfig;
  base: string;
  worktree: string;
}

export function buildPlannerPrompt(mission: string, repo: RepositoryConfig | null, base: string, team: AgentProfile[], mcp: string[] = [], multi: PlanRepo[] = [], lessons = ""): string {
  const roster = team.filter((a) => a.id !== "atlas" && a.id !== "vega").map((a) => `- ${a.id}: ${a.name}, ${a.role}. ${a.tagline}`).join("\n");
  const where = multi.length > 1
    ? `Esta misión abarca VARIOS repositorios que se trabajan EN PARALELO, cada uno en su propia carpeta:
${multi.map((m) => `- "${m.repo.id}" (${m.repo.kind ?? "otro"}), rama base ${m.base}, carpeta ${m.worktree}`).join("\n")}
Cada paso DEBE indicar "repo" con uno de esos ids. El trabajo de backend va en el repo backend y el de frontend en el frontend.
Pasos de repos distintos no deben depender entre sí salvo que sea imprescindible: si el front necesita un contrato de la API, descríbelo en el "task" de ambos (endpoint, campos, formato) para que avancen a la vez.
Puedes leer brevemente ambas carpetas para asignar bien el trabajo.`
    : repo
    ? `Repositorio: ${repo.name} (${repo.kind ?? "desconocido"}), rama base ${base}. Estás dentro de su worktree.
${isAnalysisOnly(mission) && mcp.length ? "Es una consulta: NO explores el repositorio; planifica directo con lo que sabes del equipo." : "Si lo necesitas, mira la estructura con 1-2 comandos de lectura como máximo; no hagas un análisis profundo, eso es trabajo de los agentes."}`
    : `Esta misión NO tiene repositorio: es de análisis / datos. Nadie modifica código; todos los pasos son "writes": false.${mcp.length ? " Asigna las consultas de datos a quien mejor encaje (p. ej. Nora para base de datos, Fiona para finanzas, Rafa/Piero para Rappi/PedidosYa)." : ""}`;
  return `Eres Atlas, lead del equipo de agentes de LRD. Tu trabajo AHORA es SOLO planificar (no edites archivos).

Misión del usuario:
"""${mission}"""

${where}
${mcpRules(mcp)}

${lessons}
Equipo disponible (usa el id en "agent"):
${roster}

QA (Vega) y la revisión final (Atlas) las agrega el sistema automáticamente: NO las incluyas.
Git (commit/push/PR) lo controla el sistema: NO lo incluyas.

Reglas del plan:
- Entre 1 y 4 pasos. Usa el MENOR número de agentes que resuelva la misión: una consulta o dato puntual es 1 solo paso de 1 agente; no encadenes especialistas "por si acaso".
- Usa solo agentes cuyo rol encaje con la misión.
- Pasos de investigación: "writes": false. Pasos que modifican código: "writes": true.
- Si la misión solo pide analizar/explicar, ningún paso debe tener "writes": true.
- Si la misión pide corregir/arreglar/implementar, al menos un paso debe tener "writes": true (y "deliverable": "code_change").
- Pasos independientes no deben depender entre sí (se ejecutan en paralelo).
- "task" debe ser una instrucción concreta y autocontenida para ese agente.
- "delivery": cómo quiere el usuario recibir los cambios, según lo que pide en TODO el texto (no por una palabra suelta): "publish" = false solo si pide no publicar / dejarlo local; "directToBase" = true solo si pide trabajar sobre la misma rama (la rama base o la que nombra) sin crear una rama nueva.
- "checklist": los criterios de aceptación VERIFICABLES que pide la misión (archivos a tocar o no tocar, reglas, pruebas pedidas, entregables), cada uno en una frase corta; máximo 12. Si la misión no pide nada concreto, déjalo vacío.

Responde ÚNICAMENTE con un bloque JSON válido, sin texto adicional, con esta forma:
{"deliverable":"code_change"|"analysis","delivery":{"publish":true,"directToBase":false},"checklist":["…"],"steps":[{"id":"s1","agent":"rafa","title":"…","task":"…","dependsOn":[],"writes":false${multi.length > 1 ? ',"repo":"<id del repositorio>"' : ""}}]}`;
}

/** Repo por defecto de un agente en misiones de varios repos: Mica → frontend, el resto → backend. */
export function repoForAgent(agent: AgentId, repos: RepositoryConfig[]): string {
  const want = agent === "mica" ? "frontend" : "backend";
  return (repos.find((r) => r.kind === want) ?? repos[0]).id;
}

export function parsePlan(text: string, prompt: string, repos: RepositoryConfig[] = []): MissionPlan | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fence) for (const f of fence) candidates.push(f.replace(/```(?:json)?/g, "").trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const plan = validate(j, prompt, repos);
      if (plan) return plan;
    } catch {
      /* siguiente */
    }
  }
  return null;
}

function validate(j: any, prompt: string, repos: RepositoryConfig[] = []): MissionPlan | null {
  if (!j || !Array.isArray(j.steps) || j.steps.length === 0) return null;
  // Lo decide Atlas, que leyó la misión completa. Si se contradice (dice "analysis" pero planifica pasos
  // que modifican código), manda lo que planificó: los pasos con cambios no se degradan a solo lectura.
  void prompt;
  const analysis = j.deliverable === "analysis" && !j.steps.some((s: any) => !!s?.writes);
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
      ...(repos.length > 1 ? { repo: repos.some((r) => r.id === s.repo) ? String(s.repo) : repoForAgent(agent, repos) } : {}),
    });
  }
  if (!steps.length) return null;
  for (const s of steps) s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id);
  if (hasCycle(steps)) return null;
  const checklist = Array.isArray(j.checklist) ? j.checklist.map((x: unknown) => String(x)).filter((x: string) => x.trim().length > 3).slice(0, 12) : undefined;
  const d = j.delivery && typeof j.delivery === "object" ? { publish: j.delivery.publish !== false, directToBase: j.delivery.directToBase === true } : undefined;
  return { deliverable: analysis ? "analysis" : "code_change", steps, source: "ai", ...(checklist?.length ? { checklist } : {}), ...(d ? { delivery: d } : {}) };
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
export function rulesPlan(prompt: string, repo: RepositoryConfig | null, area: string, repos: RepositoryConfig[] = []): MissionPlan {
  if (repos.length > 1) {
    // Varios repos: un responsable por repo, en paralelo.
    const analysis = isAnalysisOnly(prompt);
    const steps: PlannedStep[] = repos.map((r, i) => {
      const agent: AgentId = r.kind === "frontend" ? "mica" : "diego";
      return analysis
        ? { id: `s${i + 1}`, agent, title: `Analizar ${r.name}`, task: `${prompt}\nTrabaja solo en ${r.name}. No modifiques archivos; entrega un diagnóstico con evidencia.`, dependsOn: [], writes: false, repo: r.id }
        : { id: `s${i + 1}`, agent, title: `Implementar en ${r.name}`, task: `${prompt}\nTrabaja solo en ${r.name}; coordina el contrato con el otro repositorio a través de lo descrito en la misión.`, dependsOn: [], writes: true, repo: r.id };
    });
    return { deliverable: analysis ? "analysis" : "code_change", steps, source: "rules" };
  }
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
