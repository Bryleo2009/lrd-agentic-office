import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, Provider, PublicConfig, RepositoryConfig } from "../shared/types";
import { isAgentId } from "../shared/agents";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === "") return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseAgentEngines(v: string | undefined): Partial<Record<AgentId, Provider>> {
  const out: Partial<Record<AgentId, Provider>> = {};
  if (!v) return out;
  for (const pair of v.split(",")) {
    const [a, p] = pair.split(":").map((s) => s.trim().toLowerCase());
    if (isAgentId(a) && (p === "codex" || p === "claude")) out[a] = p;
  }
  return out;
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4173),
  host: env.HOST ?? "127.0.0.1",
  isProd: env.NODE_ENV === "production",
  aiProviderMode: env.AI_PROVIDER_MODE ?? "cli",
  aiEngineDefault: (env.AI_ENGINE_DEFAULT === "claude" ? "claude" : "codex") as Provider,
  codexEnabled: bool(env.CODEX_ENABLED, true),
  claudeEnabled: bool(env.CLAUDE_ENABLED, true),
  codexCommand: env.CODEX_COMMAND || "codex",
  claudeCommand: env.CLAUDE_COMMAND || "claude",
  allowPaidApiFallback: bool(env.ALLOW_PAID_API_FALLBACK, false),
  githubPushEnabled: bool(env.GITHUB_PUSH_ENABLED, true),
  githubPrEnabled: bool(env.GITHUB_PR_ENABLED, false),
  workspaceRoot: path.resolve(expandHome(env.LRD_WORKSPACE_ROOT || "~/.lrd-agentic-office")),
  agentEngines: parseAgentEngines(env.AGENT_ENGINES),
  /** Automático: "mix" reparte los pasos entre Codex y Claude (el menos cargado); "single" usa el motor de la misión. */
  engineStrategy: (env.ENGINE_STRATEGY === "single" ? "single" : "mix") as "mix" | "single",
  /** Minutos que se evita un motor que llegó a su límite, si su mensaje no dice cuándo vuelve. */
  engineCooldownMs: Math.max(1, Number(env.ENGINE_COOLDOWN_MIN ?? 30)) * 60_000,
  /** Revisión cruzada: el otro motor revisa el diff antes de QA. */
  crossReview: bool(env.CROSS_REVIEW, true),
  crossReviewFixRounds: Math.max(0, Number(env.CROSS_REVIEW_FIX_ROUNDS ?? 1)),
  atlasReviewEnabled: bool(env.ATLAS_REVIEW_ENABLED, true),
  qaFixIterations: Math.max(0, Number(env.QA_FIX_ITERATIONS ?? 1)),
  /** Comandos de QA a la vez (build, lint, pruebas). 1 = en serie. */
  qaParallel: Math.max(1, Number(env.QA_PARALLEL ?? 3)),
  /** Veces que una misión se retoma sola tras reinicios del servidor antes de darla por fallida. */
  maxResumes: Math.max(0, Number(env.MISSION_MAX_RESUMES ?? 3)),
  ghCommand: env.GH_COMMAND || "gh",
  /** Esperar GitHub Actions tras publicar la rama y corregir si falla por los cambios de la misión. */
  ciWaitEnabled: bool(env.CI_WAIT_ENABLED, true),
  ciTimeoutMs: Math.max(1, Number(env.CI_TIMEOUT_MIN ?? 40)) * 60_000,
  /** Cuánto esperar a que aparezca alguna ejecución antes de concluir que la rama no dispara workflows. */
  ciAppearMs: Math.max(1, Number(env.CI_APPEAR_SEC ?? 180)) * 1000,
  ciPollMs: Math.max(1, Number(env.CI_POLL_SEC ?? 20)) * 1000,
  ciFixIterations: Math.max(0, Number(env.CI_FIX_ITERATIONS ?? 2)),
  /** Pausa (ms) tras handoffs/reuniones para que la oficina alcance a representarlos. 0 = sin pausa. */
  visualPacingMs: Math.max(0, Number(env.VISUAL_PACING_MS ?? 4000)),
  stepTimeoutMs: Math.max(1, Number(env.AGENT_STEP_TIMEOUT_MIN ?? 30)) * 60_000,
  /** Minutos que se espera la respuesta a una pregunta de un agente (0 = sin límite). Luego sigue con lo más prudente. */
  questionTimeoutMs: Math.max(0, Number(env.QUESTION_TIMEOUT_MIN ?? 120)) * 60_000,
  /** Preguntas al usuario por paso como máximo (0 = los agentes nunca preguntan). */
  maxQuestionsPerStep: Math.max(0, Number(env.MAX_QUESTIONS_PER_STEP ?? 2)),
  /** Minutos que se espera una aprobación antes de publicar (0 = sin límite). Sin respuesta, no se publica. */
  approvalTimeoutMs: Math.max(0, Number(env.APPROVAL_TIMEOUT_MIN ?? 120)) * 60_000,
  /** Qué necesita aprobación antes de publicar: entregas directas en la rama base y migraciones. */
  approvals: {
    direct: (env.REQUIRE_APPROVAL ?? "direct,migrations").split(",").map((x) => x.trim()).includes("direct"),
    migrations: (env.REQUIRE_APPROVAL ?? "direct,migrations").split(",").map((x) => x.trim()).includes("migrations"),
  },
  /** Revisar el diff en busca de secretos antes de cada commit/publicación. */
  secretScan: bool(env.SECRET_SCAN, true),
  /** Días que se conservan worktrees y logs de misiones terminadas (0 = no limpiar). */
  retentionDays: Math.max(0, Number(env.RETENTION_DAYS ?? 14)),
  guidesDir: path.resolve(PROJECT_ROOT, env.LRD_GUIDES_DIR || "config/guides"),
  reposFile: path.resolve(PROJECT_ROOT, env.LRD_REPOS_FILE || "config/repositories.json"),
};

export const paths = {
  repos: path.join(config.workspaceRoot, "repos"),
  worktrees: path.join(config.workspaceRoot, "worktrees"),
  runs: path.join(config.workspaceRoot, "runs"),
  db: path.join(config.workspaceRoot, "office.db"),
};

export function ensureWorkspace(): void {
  for (const p of Object.values(paths)) if (!p.endsWith(".db")) fs.mkdirSync(p, { recursive: true });
}

interface ReposFile {
  repositories: RepositoryConfig[];
  protectedBranches?: string[];
}

export function loadRepositories(): { repositories: RepositoryConfig[]; protectedBranches: string[] } {
  const raw = JSON.parse(fs.readFileSync(config.reposFile, "utf8")) as ReposFile;
  const protectedBranches = raw.protectedBranches ?? ["main", "release/fase2", "release/fase3.1"];
  return { repositories: raw.repositories, protectedBranches };
}

export function publicConfig(): PublicConfig {
  return {
    aiProviderMode: config.aiProviderMode,
    aiEngineDefault: config.aiEngineDefault,
    allowPaidApiFallback: config.allowPaidApiFallback,
    githubPushEnabled: config.githubPushEnabled,
    githubPrEnabled: config.githubPrEnabled,
    protectedBranches: loadRepositories().protectedBranches,
    workspaceRoot: config.workspaceRoot,
    agentEngines: config.agentEngines,
    approvals: config.approvals,
    retentionDays: config.retentionDays,
  };
}
