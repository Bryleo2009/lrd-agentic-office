import fs from "node:fs";
import path from "node:path";
import { AGENTS, isAgentId } from "../shared/agents";
import type { AgentId, AgentProfile, Appearance, Gender, Provider, RepositoryConfig } from "../shared/types";
import { config, ensureWorkspace, expandHome, loadRepositories, PROJECT_ROOT } from "./config";
import { run } from "./runtime/processUtils";

/**
 * Ajustes del usuario en esta PC: rutas locales de repos y personalización del equipo.
 * Se guardan en <LRD_WORKSPACE_ROOT>/settings.json (fuera del repositorio). Sin secretos.
 */
interface ProfileOverride {
  name?: string;
  gender?: Gender;
  role?: string;
  tagline?: string;
  color?: string;
  responsibilities?: string[];
  appearance?: Partial<Appearance>;
  engine?: Provider | null;
}

interface SettingsFile {
  repoPaths: Record<string, string>;
  team: Partial<Record<AgentId, ProfileOverride>>;
  /** Servidores MCP que no se ofrecen en las misiones (p. ej. un conector duplicado o herramientas). */
  hiddenMcp?: string[];
}

const FILE = () => path.join(config.workspaceRoot, "settings.json");

const DEFAULT_GENDER: Record<AgentId, Gender> = {
  atlas: "male",
  diego: "male",
  mica: "female",
  nora: "female",
  vega: "female",
  rafa: "male",
  piero: "male",
  fiona: "female",
};

const FALLBACK_APPEARANCE: Appearance = {
  skin: "#e0ac82",
  hair: "#2b1d16",
  hairStyle: "side_part",
  outfit: "shirt",
  shirt: "#3b82f6",
  shirtAccent: "#dbeafe",
  pants: "#334155",
  shoes: "#111827",
  accessory: "none",
  height: 1,
  build: 1,
  renderer: "rig",
};

function read(): SettingsFile {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return { repoPaths: j.repoPaths ?? {}, team: j.team ?? {}, hiddenMcp: Array.isArray(j.hiddenMcp) ? j.hiddenMcp.map(String) : [] };
  } catch {
    return { repoPaths: {}, team: {} };
  }
}

function write(s: SettingsFile): void {
  ensureWorkspace();
  fs.writeFileSync(FILE(), JSON.stringify(s, null, 2));
}

function baseAppearance(id: AgentId): Appearance {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "assets/characters", id, "character.json"), "utf8"));
    delete j.$schema;
    return { ...FALLBACK_APPEARANCE, ...j };
  } catch {
    return FALLBACK_APPEARANCE;
  }
}

// ---------------- servidores MCP ocultos ----------------

export function hiddenMcp(): string[] {
  return read().hiddenMcp ?? [];
}

export function setMcpHidden(name: string, hidden: boolean): string[] {
  const s = read();
  const cur = new Set(s.hiddenMcp ?? []);
  if (hidden) cur.add(name);
  else cur.delete(name);
  s.hiddenMcp = [...cur].sort();
  write(s);
  return s.hiddenMcp;
}

// ---------------- equipo ----------------

export function team(): AgentProfile[] {
  const s = read();
  return AGENTS.map((a) => {
    const o = s.team[a.id] ?? {};
    const name = (o.name ?? a.name).trim() || a.name;
    const role = (o.role ?? a.role).trim() || a.role;
    const gender = o.gender ?? DEFAULT_GENDER[a.id];
    // El brief de sistema se reconstruye con el nombre y rol personalizados.
    const systemBrief = o.name || o.role ? a.systemBrief.replace(new RegExp(`\\b${a.name}\\b`, "g"), name).replace(a.role, role) : a.systemBrief;
    return {
      ...a,
      name,
      role,
      gender,
      tagline: o.tagline ?? a.tagline,
      color: o.color ?? a.color,
      responsibilities: o.responsibilities ?? a.responsibilities,
      systemBrief: o.role ? `${systemBrief} Tu rol es: ${role}.` : systemBrief,
      appearance: { ...baseAppearance(a.id), ...(o.appearance ?? {}) },
      engine: o.engine !== undefined ? o.engine : (config.agentEngines[a.id] ?? null),
      customized: Object.keys(o).length > 0,
    };
  });
}

export function profile(id: AgentId): AgentProfile {
  return team().find((p) => p.id === id)!;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const HAIR = ["side_part", "curly", "ponytail", "bun", "bob", "buzz", "wavy", "long"];
const OUTFIT = ["blazer", "hoodie", "sweater", "shirt", "polo", "blouse"];
const ACC = ["none", "glasses", "headphones", "headset", "badge", "earrings"];

export function updateProfile(id: AgentId, patch: ProfileOverride): AgentProfile {
  if (!isAgentId(id)) throw new Error("Agente desconocido");
  const s = read();
  const cur = s.team[id] ?? {};
  const next: ProfileOverride = { ...cur };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  if (patch.name !== undefined) next.name = str(patch.name, 24);
  if (patch.role !== undefined) next.role = str(patch.role, 60);
  if (patch.tagline !== undefined) next.tagline = str(patch.tagline, 140);
  if (patch.gender !== undefined && ["female", "male", "other"].includes(patch.gender)) next.gender = patch.gender;
  if (patch.color !== undefined && HEX.test(patch.color)) next.color = patch.color;
  if (Array.isArray(patch.responsibilities)) next.responsibilities = patch.responsibilities.map((r) => String(r).slice(0, 80)).filter(Boolean).slice(0, 8);
  if (patch.engine !== undefined) next.engine = patch.engine === "codex" || patch.engine === "claude" ? patch.engine : null;
  if (patch.appearance) {
    const a: Partial<Appearance> = { ...(cur.appearance ?? {}) };
    const p = patch.appearance;
    for (const k of ["skin", "hair", "shirt", "shirtAccent", "pants", "shoes"] as const) if (p[k] !== undefined && HEX.test(String(p[k]))) a[k] = p[k];
    if (p.hairStyle && HAIR.includes(p.hairStyle)) a.hairStyle = p.hairStyle;
    if (p.outfit && OUTFIT.includes(p.outfit)) a.outfit = p.outfit;
    if (p.accessory && ACC.includes(p.accessory)) a.accessory = p.accessory;
    if (typeof p.beard === "boolean") a.beard = p.beard;
    if (typeof p.height === "number") a.height = Math.min(1.1, Math.max(0.9, p.height));
    if (typeof p.build === "number") a.build = Math.min(1.15, Math.max(0.85, p.build));
    next.appearance = a;
  }
  for (const k of Object.keys(next) as (keyof ProfileOverride)[]) if (next[k] === undefined || next[k] === "") delete next[k];
  s.team[id] = next;
  write(s);
  return profile(id);
}

export function resetProfile(id: AgentId): AgentProfile {
  const s = read();
  delete s.team[id];
  write(s);
  return profile(id);
}

// ---------------- repositorios ----------------

export function repoLocalPath(id: string): string | null {
  const p = read().repoPaths[id];
  return p ? path.resolve(expandHome(p)) : null;
}

/** Valida que la ruta sea un repositorio git y devuelve su estado (sin modificar nada). */
export async function inspectLocalRepo(p: string, repo?: RepositoryConfig): Promise<{ ok: boolean; message: string; branch?: string | null }> {
  const abs = path.resolve(expandHome(p.trim()));
  if (!fs.existsSync(abs)) return { ok: false, message: "La carpeta no existe en esta PC" };
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: abs, timeoutMs: 10000 });
  if (top.code !== 0) return { ok: false, message: "No es un repositorio git" };
  const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: abs, timeoutMs: 10000 })).stdout.trim() || null;
  const remote = (await run("git", ["remote", "get-url", "origin"], { cwd: abs, timeoutMs: 10000 })).stdout.trim();
  if (!remote) return { ok: false, message: "El repositorio no tiene remoto 'origin'", branch };
  if (repo) {
    const slug = repo.github.toLowerCase().split("/").pop()!;
    if (!remote.toLowerCase().includes(slug)) return { ok: true, message: `Atención: origin apunta a ${remote}`, branch };
  }
  return { ok: true, message: `OK · rama actual ${branch ?? "?"} (no se modifica)`, branch };
}

export async function setRepoPath(id: string, p: string | null): Promise<{ ok: boolean; message: string; branch?: string | null }> {
  const repo = loadRepositories().repositories.find((r) => r.id === id);
  if (!repo) throw new Error(`Repositorio desconocido: ${id}`);
  const s = read();
  if (!p || !p.trim()) {
    delete s.repoPaths[id];
    write(s);
    return { ok: true, message: "Se usará un clon gestionado por la app" };
  }
  const st = await inspectLocalRepo(p, repo);
  if (!st.ok) return st;
  s.repoPaths[id] = path.resolve(expandHome(p.trim()));
  write(s);
  return st;
}

/** Repositorios de config + ruta local y su estado. */
export async function repositoriesWithLocal(): Promise<RepositoryConfig[]> {
  const { repositories } = loadRepositories();
  const paths = read().repoPaths;
  return Promise.all(
    repositories.map(async (r) => {
      const lp = paths[r.id] ?? null;
      return { ...r, localPath: lp, localStatus: lp ? await inspectLocalRepo(lp, r) : null };
    }),
  );
}
