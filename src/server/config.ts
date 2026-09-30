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
  atlasReviewEnabled: bool(env.ATLAS_REVIEW_ENABLED, true),
  qaFixIterations: Math.max(0, Number(env.QA_FIX_ITERATIONS ?? 1)),
  /** Comandos de QA a la vez (build, lint, pruebas). 1 = en serie. */
  qaParallel: Math.max(1, Number(env.QA_PARALLEL ?? 3)),
  /** Pausa (ms) tras handoffs/reuniones para que la oficina alcance a representarlos. 0 = sin pausa. */
  visualPacingMs: Math.max(0, Number(env.VISUAL_PACING_MS ?? 4000)),
  stepTimeoutMs: Math.max(1, Number(env.AGENT_STEP_TIMEOUT_MIN ?? 30)) * 60_000,
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
  };
}
