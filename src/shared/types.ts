import type { AgentRuntimeEvent } from "./events";

export type Provider = "codex" | "claude";
export type EngineChoice = "auto" | Provider;

export type AgentId = "atlas" | "diego" | "mica" | "nora" | "vega" | "rafa" | "piero" | "fiona";

export type Department = "CONTROL" | "INGENIERIA" | "QA" | "OPERACIONES";

export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: string;
  department: Department;
  /** Área usada en el nombre de rama agentic/<area>/... */
  area: string;
  tagline: string;
  responsibilities: string[];
  /** Instrucciones de rol que se anteponen a cada tarea real. */
  systemBrief: string;
  color: string;
}

export type Gender = "female" | "male" | "other";

/** Apariencia del rig 2.5D del personaje. */
export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: "side_part" | "curly" | "ponytail" | "bun" | "bob" | "buzz" | "wavy" | "long";
  outfit: "blazer" | "hoodie" | "sweater" | "shirt" | "polo" | "blouse";
  shirt: string;
  shirtAccent: string;
  pants: string;
  shoes: string;
  accessory: "none" | "glasses" | "headphones" | "headset" | "badge" | "earrings";
  height: number;
  build: number;
  beard?: boolean;
  renderer?: "rig" | "spritesheet";
}

/** Empleado personalizado: definición base + lo que el usuario edita. */
export interface AgentProfile extends AgentDefinition {
  gender: Gender;
  appearance: Appearance;
  /** Motor preferido en modo Automático (null = el de la misión). */
  engine: Provider | null;
  customized: boolean;
}

/** Servidores que son herramientas de ejecución (no fuentes de datos): no se preseleccionan. */
export function isToolMcp(name: string): boolean {
  return /repl|^codex_app$|computer|cua|browser|playwright|shell|terminal/i.test(name);
}

export interface McpServerInfo {
  name: string;
  enabled: boolean;
  transport: string;
  /** Ocultado por el usuario en Ajustes: no se ofrece en las misiones y queda desactivado en ellas. */
  hidden?: boolean;
}

export interface RuntimeStatus {
  provider: Provider;
  label: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  authenticated: boolean | null;
  authDetail: string | null;
  /** Flags detectados en el --help de la versión instalada. */
  capabilities: Record<string, boolean>;
  /** Servidores MCP configurados en el CLI (sólo nombre/estado; nunca args ni env). */
  mcpServers: McpServerInfo[];
  message: string;
  checkedAt: string;
  /** Si el motor llegó a su límite: hasta cuándo no se usará (se recuerda temporalmente). */
  saturatedUntil?: string | null;
  saturationReason?: string | null;
}

export type MissionStatus =
  | "created"
  | "preparing"
  | "planning"
  | "running"
  | "qa"
  | "committing"
  | "ci"
  /** Pausada: espera la respuesta o la aprobación del usuario. */
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";

export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped" | "cancelled";

export interface MissionStep {
  id: string;
  missionId: string;
  agentId: AgentId;
  title: string;
  task: string;
  dependsOn: string[];
  writes: boolean;
  kind: "plan" | "agent" | "xreview" | "qa" | "review" | "ci";
  status: StepStatus;
  provider: Provider | null;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Repositorio en el que trabaja el paso (misiones con varios repos). null = el principal. */
  repositoryId?: string | null;
}

/** Estado de cada repositorio en una misión con varios repos (p. ej. back + front en paralelo). */
export interface MissionRepo {
  repositoryId: string;
  baseBranch: string;
  worktree: string | null;
  branch: string | null;
  commitSha: string | null;
  pushed: boolean;
  prUrl: string | null;
}

/** Un criterio de aceptación de la misión. */
export interface ChecklistItem {
  id: string;
  text: string;
  /** pending · done (hecho/verificado) · failed (pendiente según la revisión) · skipped (no aplica) */
  status: "pending" | "done" | "failed" | "skipped";
  /** Quién lo marcó por última vez y cómo ("hecho" por el implementador, "verificado" por la revisión). */
  by: AgentId | null;
  how: "hecho" | "verificado" | "pendiente" | "no aplica" | null;
  note: string | null;
}

/** GitHub Actions de la rama publicada. */
export interface CiInfo {
  repositoryId: string;
  /** pending (esperando) · success · failure · none (la rama no disparó workflows) · unavailable (gh no disponible) · timeout · unrelated (falla también en la base) */
  state: "pending" | "success" | "failure" | "none" | "unavailable" | "timeout" | "unrelated";
  detail: string;
  url: string | null;
  sha: string | null;
  attempts: number;
}

/** Pregunta o aprobación que pausa la misión hasta que el usuario responde. */
export interface MissionQuestion {
  id: string;
  /** Clave estable (paso + pregunta): al retomar tras un reinicio no se repite lo ya respondido. */
  key: string;
  agentId: AgentId;
  stepId: string | null;
  /** question: la hace un agente · approval: la pide la oficina antes de publicar (secretos, migraciones, entrega directa). */
  kind: "question" | "approval";
  text: string;
  /** Contexto breve (qué archivo, qué rama…). */
  context: string | null;
  options: string[];
  status: "open" | "answered" | "expired";
  answer: string | null;
  /** Si nadie responde a tiempo, qué se hace (se muestra al usuario). */
  fallback: string | null;
  askedAt: string;
  answeredAt: string | null;
}

/** Tipo de tarea: decide qué guía de trabajo reciben Atlas y los agentes. */
export type TaskKind = "ci-fix" | "data-lookup" | "general";

/** Separador para pedir varios repos en una misión: "lrd-back+lrd-front". */
export const MULTI_REPO_SEP = "+";

/** Misión sin repositorio (análisis / datos). */
export const NO_REPO = "none";

export interface Mission {
  id: string;
  prompt: string;
  /** Id del repositorio o "none" (análisis/datos sin código). */
  repositoryId: string;
  /** Cómo se eligió el repositorio. */
  repoSelection: "manual" | "auto";
  /** Si los agentes pueden usar los servidores MCP (datos reales, sólo lectura). */
  allowMcp: boolean;
  /** Servidores MCP habilitados para esta misión (el resto queda desactivado). */
  mcpServers: string[];
  baseBranch: string;
  engine: EngineChoice;
  provider: Provider;
  area: string;
  branch: string | null;
  worktree: string | null;
  status: MissionStatus;
  error: string | null;
  commitSha: string | null;
  pushed: boolean;
  prUrl: string | null;
  summary: string | null;
  planSource: "ai" | "rules" | null;
  /** Resultado de GitHub Actions por repositorio publicado. */
  ci: CiInfo[];
  /** Criterios de aceptación de la misión y su avance (se ve en la oficina). */
  checklist: ChecklistItem[];
  /** Misión con varios repositorios: estado de cada uno (el primero es el principal). Vacío = un solo repo. */
  repos: MissionRepo[];
  /** Preguntas y aprobaciones al usuario (abiertas y respondidas). */
  questions: MissionQuestion[];
  /** Tipo de tarea detectado (guía que se aplicó). */
  taskKind: TaskKind;
  /** Lecciones que recibió el equipo en esta misión (para medir si sirven). */
  lessonIds: string[];
  createdAt: string;
  updatedAt: string;
  steps: MissionStep[];
}

export interface RepositoryConfig {
  id: string;
  name: string;
  github: string;
  cloneUrl: string;
  shortName: string;
  enabled: boolean;
  allowedBases: string[];
  defaultBase: string;
  /** Comandos de QA explícitos. Si faltan, se autodetectan. */
  qaCommands?: string[];
  /**
   * QA por etapas: las etapas van en orden y los comandos de cada etapa corren en paralelo.
   * Tiene prioridad sobre qaCommands. Ej.: [["composer validate --strict", "bash scripts/pint-changed"], ["php artisan test"]]
   */
  qaStages?: string[][];
  /** Comando único de verificación del repo que los agentes pueden correr tras sus cambios (p. ej. "npm run check-frontend"). */
  checkCommand?: string;
  /**
   * Variables de entorno de QA (las mismas del CI). Acepta `${VAR:-por defecto}`, para poder cambiarlas
   * desde tu .env sin tocar el archivo (p. ej. CI_DB_HOST).
   */
  qaEnv?: Record<string, string>;
  /** `php artisan test` en paralelo con ParaTest (por defecto sí). Con MySQL compartido conviene false, como en el CI. */
  qaParallelTests?: boolean;
  installCommand?: string | null;
  kind?: "frontend" | "backend" | "other";
  /** Palabras que ayudan a elegir este repo en modo Automático. */
  keywords?: string[];
  /** Ruta de tu clon local en esta PC (Ajustes). Si existe, se usa en lugar de clonar. */
  localPath?: string | null;
  localStatus?: { ok: boolean; message: string; branch?: string | null } | null;
}

export interface AgentSessionInfo {
  missionId: string;
  agentId: AgentId;
  provider: Provider;
  sessionId: string | null;
  cwd: string;
  status: "starting" | "running" | "idle" | "closed" | "error";
  startedAt: string;
}

export interface PublicConfig {
  aiProviderMode: string;
  aiEngineDefault: Provider;
  allowPaidApiFallback: boolean;
  githubPushEnabled: boolean;
  githubPrEnabled: boolean;
  protectedBranches: string[];
  workspaceRoot: string;
  agentEngines: Partial<Record<AgentId, Provider>>;
  /** Qué necesita tu aprobación antes de publicar. */
  approvals: { direct: boolean; migrations: boolean };
  retentionDays: number;
}

export interface Snapshot {
  runtime: RuntimeStatus[];
  missions: Mission[];
  repositories: RepositoryConfig[];
  config: PublicConfig;
  recentEvents: AgentRuntimeEvent[];
  sessions: AgentSessionInfo[];
  team: AgentProfile[];
}

export type WsServerMessage =
  | { kind: "hello"; snapshot: Snapshot }
  | { kind: "event"; event: AgentRuntimeEvent }
  | { kind: "mission"; mission: Mission }
  | { kind: "runtime"; runtime: RuntimeStatus[] }
  | { kind: "session"; session: AgentSessionInfo }
  | { kind: "team"; team: AgentProfile[] }
  | { kind: "repositories"; repositories: RepositoryConfig[] }
  | { kind: "library"; doc: Pick<LibraryDoc, "id" | "kind" | "title" | "missionId"> | null }
  | { kind: "chat"; agentId: AgentId; missionId: string | null; delta: string; done: boolean; error?: string };

/** Lección aprendida por el equipo (memoria entre misiones). */
export interface Lesson {
  id: string;
  text: string;
  scope: string;
  /** auto: herramienta que falló · equipo: la anotó un agente · usuario: la enseñaste tú · correccion: salió de un ajuste tuyo */
  source: "auto" | "equipo" | "usuario" | "correccion";
  hits: number;
  createdAt: string;
  updatedAt: string;
  /** Misiones terminadas en las que el equipo la tuvo en cuenta. */
  uses?: number;
  /** De esas, cuántas terminaron bien / fallaron. */
  ok?: number;
  failed?: number;
  /** Veces que el mismo problema se repitió aunque la lección estaba en el prompt. */
  repeats?: number;
  /** Misiones en las que la usaron y luego tuviste que corregir por chat. */
  corrected?: number;
  /** Misiones ya contadas (evita contar dos veces al retomar). */
  scored?: string[];
}

export type LessonHealth = "nueva" | "util" | "regular" | "no_sirve";

/**
 * ¿Sirve la lección? Con pocos usos no se juzga. Si el problema se repite a pesar de ella, o las misiones
 * que la usan fallan o hay que corregirlas, "no_sirve" (deja de enviarse a los agentes).
 */
export function lessonHealth(l: Lesson): LessonHealth {
  const uses = l.uses ?? 0;
  if (uses < 3) return "nueva";
  if ((l.repeats ?? 0) / uses >= 0.34 || ((l.failed ?? 0) + (l.corrected ?? 0)) / uses >= 0.6) return "no_sirve";
  if ((l.ok ?? 0) / uses >= 0.7) return "util";
  return "regular";
}

/** Uso por motor (Codex / Claude Code) en un periodo. */
export interface EngineUsage {
  provider: Provider;
  steps: number;
  done: number;
  failed: number;
  /** Minutos de trabajo real (suma de duración de pasos). */
  minutes: number;
  avgStepMin: number;
  /** Veces que llegó a su límite y el paso siguió con el otro motor. */
  saturations: number;
  /** Misiones en las que fue el motor principal. */
  missions: number;
  byKind: Record<string, number>;
}

export interface UsageMetrics {
  days: number;
  since: string;
  engines: EngineUsage[];
  missions: { total: number; done: number; failed: number; cancelled: number; questions: number; approvals: number };
}

/** Resultado de la limpieza de carpetas viejas. */
export interface CleanupReport {
  dryRun: boolean;
  days: number;
  removed: { path: string; missionId: string | null; kind: "worktree" | "runs"; mb: number }[];
  kept: { path: string; reason: string }[];
  freedMb: number;
}

/** Tipos de documento de la biblioteca del equipo. */
export type LibraryKind = "mision" | "informe" | "investigacion" | "decision" | "incidente" | "manual";

export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = {
  mision: "Misión",
  informe: "Informe de tarea",
  investigacion: "Investigación",
  decision: "Decisión",
  incidente: "Incidente",
  manual: "Manual",
};

/** Documento de la biblioteca: lo que el equipo dejó documentado (se consulta antes de trabajar). */
export interface LibraryDoc {
  id: string;
  kind: LibraryKind;
  title: string;
  body: string;
  missionId: string | null;
  agentId: AgentId | null;
  repositoryId: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
