import fs from "node:fs";
import path from "node:path";
import type { ProjectInspection, RepositoryConfig } from "../shared/types";
import { ensureWorkspace, expandHome, loadCustomProjects, loadRepositories, paths } from "./config";
import { run } from "./runtime/processUtils";
import { setRepoPath } from "./settings";

/**
 * Proyectos propios: apuntas a tu carpeta local, indicas el repositorio de GitHub y la oficina detecta cómo
 * está armado (tecnologías, tipo, comandos de QA, ramas). Todo queda editable antes de guardar, porque no
 * todos los proyectos tienen la misma estructura.
 */

export class ProjectError extends Error {
  readonly statusCode = 400;
}

type Kind = NonNullable<RepositoryConfig["kind"]>;

export interface ProjectDetection {
  kind: Kind;
  stack: string;
  qaStages: string[][];
  checkCommand?: string;
  installCommand?: string;
  /** No se reconoció ninguna tecnología en la carpeta. */
  empty: boolean;
}

const exists = (dir: string, ...f: string[]) => fs.existsSync(path.join(dir, ...f));
const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const win = process.platform === "win32";

function detectNode(dir: string): ProjectDetection | null {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
  const has = (d: string) => d in deps;
  const fw: string[] = [];
  let kind: Kind = "other";
  const front: [string, string][] = [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["@angular/core", "Angular"],
    ["vue", "Vue"],
    ["react-native", "React Native"],
    ["expo", "Expo"],
    ["react", "React"],
    ["svelte", "Svelte"],
    ["solid-js", "Solid"],
  ];
  const back: [string, string][] = [
    ["@nestjs/core", "NestJS"],
    ["express", "Express"],
    ["fastify", "Fastify"],
    ["koa", "Koa"],
    ["@hapi/hapi", "hapi"],
  ];
  const f = front.find(([d]) => has(d));
  const b = back.find(([d]) => has(d));
  if (f) {
    fw.push(f[1]);
    kind = "frontend";
  } else if (b) {
    fw.push(b[1]);
    kind = "backend";
  }
  if (has("electron")) fw.push("Electron");
  if (has("vite")) fw.push("Vite");
  const lang = has("typescript") || exists(dir, "tsconfig.json") ? "TypeScript" : "JavaScript";
  const pm = exists(dir, "pnpm-lock.yaml") ? "pnpm" : exists(dir, "yarn.lock") ? "yarn" : exists(dir, "bun.lockb") || exists(dir, "bun.lock") ? "bun" : "npm";
  const runCmd = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : pm === "yarn" ? `yarn ${s}` : `${pm} run ${s}`);
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const pick = (...names: string[]) => names.find((n) => typeof scripts[n] === "string" && scripts[n].trim());
  const cmds: string[] = [];
  const lint = pick("lint:check", "lint");
  // Un "lint" que corrige archivos (--fix) no sirve como verificación: cambiaría el diff de la misión.
  if (lint && !/--fix\b/.test(scripts[lint])) cmds.push(runCmd(lint));
  const types = pick("type-check", "typecheck", "check-types", "tsc");
  if (types) cmds.push(runCmd(types));
  const test = pick("test:unit", "test:ci", "test");
  if (test && !/no test specified/.test(scripts[test])) cmds.push(runCmd(test));
  const build = pick("build");
  if (build) cmds.push(runCmd(build));
  const check = Object.keys(scripts).find((n) => /^(check|verify|ci|validate|check-[\w-]+)$/.test(n));
  return {
    kind,
    stack: [fw.join(" + ") || "Node.js", lang, pm !== "npm" ? pm : null].filter(Boolean).join(" · "),
    // Lint, tipos, pruebas y build no dependen entre sí: una sola etapa en paralelo (como el CI del front).
    qaStages: cmds.length ? [cmds] : [],
    checkCommand: check ? runCmd(check) : undefined,
    empty: false,
  };
}

function detectPhp(dir: string): ProjectDetection | null {
  if (!exists(dir, "composer.json")) return null;
  const composer = readJson(path.join(dir, "composer.json")) ?? {};
  const req = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) } as Record<string, string>;
  const laravel = exists(dir, "artisan");
  const fw = laravel ? "Laravel" : "symfony/framework-bundle" in req ? "Symfony" : "PHP";
  const stages: string[][] = [["composer validate --no-check-publish"]];
  if (laravel) stages.push(["php artisan test"]);
  else if ("phpunit/phpunit" in req || exists(dir, "phpunit.xml") || exists(dir, "phpunit.xml.dist")) stages.push([win ? "vendor\\bin\\phpunit" : "vendor/bin/phpunit"]);
  return { kind: "backend", stack: fw === "PHP" ? "PHP" : `${fw} · PHP`, qaStages: stages, empty: false };
}

function detectPython(dir: string): ProjectDetection | null {
  const markers = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "manage.py"];
  if (!markers.some((m) => exists(dir, m))) return null;
  const text = `${readText(path.join(dir, "pyproject.toml"))}\n${readText(path.join(dir, "requirements.txt"))}\n${readText(path.join(dir, "Pipfile"))}`.toLowerCase();
  const django = exists(dir, "manage.py");
  const fw = django ? "Django" : /\bfastapi\b/.test(text) ? "FastAPI" : /\bflask\b/.test(text) ? "Flask" : null;
  const py = win ? "python" : "python3";
  const cmds: string[] = [];
  if (/\bruff\b/.test(text)) cmds.push("ruff check .");
  if (django) cmds.push(`${py} manage.py test`);
  else if (/\bpytest\b/.test(text) || exists(dir, "pytest.ini") || exists(dir, "tests")) cmds.push(`${py} -m pytest`);
  return { kind: fw ? "backend" : "other", stack: [fw, "Python"].filter(Boolean).join(" · "), qaStages: cmds.length ? [cmds] : [], empty: false };
}

function detectJvm(dir: string): ProjectDetection | null {
  const maven = exists(dir, "pom.xml");
  const gradle = exists(dir, "build.gradle") || exists(dir, "build.gradle.kts");
  if (!maven && !gradle) return null;
  const build = `${readText(path.join(dir, "pom.xml"))}${readText(path.join(dir, "build.gradle"))}${readText(path.join(dir, "build.gradle.kts"))}`;
  const android = /com\.android\.(application|library)/.test(build);
  const spring = /spring-boot/.test(build);
  const kotlin = /kotlin/.test(build);
  let cmd: string;
  if (maven) cmd = exists(dir, "mvnw") ? (win ? "mvnw.cmd -B verify" : "./mvnw -B verify") : "mvn -B verify";
  else cmd = exists(dir, "gradlew") ? (win ? "gradlew.bat build" : "./gradlew build") : "gradle build";
  return {
    kind: android ? "frontend" : spring ? "backend" : "other",
    stack: [android ? "Android" : spring ? "Spring Boot" : null, kotlin ? "Kotlin" : "Java", maven ? "Maven" : "Gradle"].filter(Boolean).join(" · "),
    qaStages: [[cmd]],
    empty: false,
  };
}

function detectDotnet(dir: string): ProjectDetection | null {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  if (!files.some((f) => /\.(sln|csproj|fsproj|vbproj)$/i.test(f))) return null;
  const all = files.filter((f) => /\.csproj$/i.test(f)).map((f) => readText(path.join(dir, f))).join("\n");
  const web = /Microsoft\.NET\.Sdk\.Web/.test(all);
  const blazor = /Microsoft\.NET\.Sdk\.BlazorWebAssembly/.test(all);
  return { kind: blazor ? "frontend" : web ? "backend" : "other", stack: `${blazor ? "Blazor" : web ? "ASP.NET" : ".NET"} · C#`, qaStages: [["dotnet build"], ["dotnet test --no-build"]], empty: false };
}

function detectOther(dir: string): ProjectDetection | null {
  if (exists(dir, "go.mod")) return { kind: "backend", stack: "Go", qaStages: [["go vet ./...", "go test ./..."]], empty: false };
  if (exists(dir, "Cargo.toml")) return { kind: "other", stack: "Rust", qaStages: [["cargo build"], ["cargo test"]], empty: false };
  if (exists(dir, "pubspec.yaml")) return { kind: "frontend", stack: "Flutter · Dart", qaStages: [["flutter analyze", "flutter test"]], empty: false };
  if (exists(dir, "Gemfile")) {
    const rails = exists(dir, "bin", "rails");
    return { kind: rails ? "backend" : "other", stack: rails ? "Rails · Ruby" : "Ruby", qaStages: rails ? [["bin/rails test"]] : [], empty: false };
  }
  return null;
}

/** Detecta las tecnologías de una carpeta y propone tipo y comandos de QA. Solo lee archivos. */
export function detectProject(dir: string): ProjectDetection {
  for (const d of [detectPhp, detectJvm, detectDotnet, detectPython, detectOther]) {
    const r = d(dir);
    if (!r) continue;
    // Laravel/Django/Rails + package.json: el front de la plantilla no cambia el tipo, pero su build sí se prueba.
    const node = detectNode(dir);
    if (node?.qaStages.length && r.kind === "backend") {
      const build = node.qaStages[0].filter((c) => /\bbuild\b/.test(c));
      if (build.length) r.qaStages = [...r.qaStages, build];
      r.stack += ` + ${node.stack.split(" · ")[0]}`;
    }
    return r;
  }
  const node = detectNode(dir);
  if (node) return node;
  const html = exists(dir, "index.html");
  return { kind: html ? "frontend" : "other", stack: html ? "HTML estático" : "Sin tecnología reconocida", qaStages: [], empty: !html };
}

/** Subcarpetas (hasta 2 niveles) que parecen proyectos propios: monorepos con back y front juntos. */
export function findSubprojects(root: string): ProjectInspection["subprojects"] {
  const skip = new Set(["node_modules", "vendor", ".git", "dist", "build", "target", "bin", "obj", ".venv", "venv", "__pycache__", "storage", "public", "docs", ".github", ".idea", ".vscode"]);
  const out: ProjectInspection["subprojects"] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith(".")) continue;
      const sub = rel ? `${rel}/${e.name}` : e.name;
      const d = detectProject(path.join(root, sub));
      if (!d.empty && d.stack !== "HTML estático") out.push({ dir: sub, stack: d.stack, kind: d.kind });
      else if (depth < 2) walk(sub, depth + 1);
      if (out.length >= 12) return;
    }
  };
  walk("", 1);
  return out;
}

/** "git@github.com:owner/repo.git", "https://github.com/owner/repo" u "owner/repo" → "owner/repo" (o null). */
export function parseGithub(s: string): string | null {
  const t = s.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const m = t.match(/github[\w.-]*[:/]+([\w.-]+)\/([\w.-]+)$/i) ?? t.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function slugId(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "proyecto";
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let s = base;
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
  return s;
}

async function git(args: string[], cwd: string, timeoutMs = 15000) {
  return run("git", args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

const BASE_ORDER = /^(develop|development|dev|main|master|staging|qa|test|release\/.+|production|prod)$/;

/**
 * Analiza tu carpeta local: valida que sea un repo git, ubica el remoto, trae sus ramas (git fetch, no toca tu
 * rama ni tus cambios) y propone una configuración. No guarda nada.
 */
export async function inspectProject(input: { path: string; github?: string | null; workdir?: string | null }): Promise<ProjectInspection> {
  const fail = (message: string): ProjectInspection => ({ ok: false, message, warnings: [], draft: null, branches: [], subprojects: [], existing: false });
  if (!input.path?.trim()) return fail("Indica la ruta de la carpeta del proyecto en esta PC");
  const abs = path.resolve(expandHome(input.path.trim()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return fail(`La carpeta no existe en esta PC: ${abs}`);
  const top = await git(["rev-parse", "--show-toplevel"], abs);
  if (top.code !== 0)
    return fail("La carpeta no es un repositorio git. Clónalo primero (git clone <url> <carpeta>) o ejecuta git init y conéctalo a GitHub.");
  const root = path.resolve(top.stdout.trim());
  const warnings: string[] = [];
  // Si apuntaste a una subcarpeta del repo, esa es la carpeta de trabajo (monorepo).
  let workdir = (input.workdir ?? path.relative(root, abs)).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (workdir.startsWith("..") || path.isAbsolute(workdir)) workdir = "";
  if (workdir && !fs.existsSync(path.join(root, workdir))) return fail(`La subcarpeta ${workdir} no existe dentro del repositorio`);

  const wanted = input.github?.trim() ? parseGithub(input.github) : null;
  if (input.github?.trim() && !wanted) return fail(`No entiendo el repositorio "${input.github}". Usa owner/repo o la URL de GitHub.`);
  let origin = (await git(["config", "--get", "remote.origin.url"], root)).stdout.trim();
  if (!origin) {
    if (!wanted) return fail("El repositorio no tiene remoto 'origin'. Indica cuál es su repositorio de GitHub (owner/repo) y lo conecto.");
    origin = `git@github.com:${wanted}.git`;
    const add = await git(["remote", "add", "origin", origin], root);
    if (add.code !== 0) return fail(`No se pudo agregar el remoto origin: ${add.stderr.trim()}`);
    warnings.push(`Tu carpeta no tenía remoto: se agregó origin → ${origin}`);
  }
  const fromOrigin = parseGithub(origin);
  const originTail = origin.replace(/\.git$/i, "").replace(/\/+$/, "").split(/[/:\\]/).slice(-2).join("/");
  if (wanted && wanted.toLowerCase() !== (fromOrigin ?? originTail).toLowerCase())
    return fail(
      `El origin de tu carpeta apunta a ${fromOrigin ?? origin}, no a ${wanted}. La oficina publica en origin, así que deben coincidir: revisa la carpeta o cambia el remoto (git remote set-url origin …).`,
    );
  const github = wanted ?? fromOrigin;
  if (!github) warnings.push(`origin (${origin}) no es GitHub: no se podrá esperar GitHub Actions ni abrir PR.`);
  const githubName = github ?? originTail;

  // Ramas: fetch para tenerlas al día (solo actualiza referencias remotas).
  const fetched = await git(["fetch", "origin"], root, 90_000);
  if (fetched.code !== 0) warnings.push(`No se pudo hacer git fetch (${fetched.stderr.trim().split("\n").pop() || "sin detalle"}); se usan las ramas que ya conoce tu clon.`);
  const refs = await git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], root);
  const branches = refs.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^origin\//, ""))
    .filter((b) => b && b !== "HEAD" && b !== "origin");
  if (!branches.length) return fail("origin no tiene ramas (¿repositorio vacío o sin acceso?). Sube al menos una rama y vuelve a intentar.");
  const head = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)).stdout.trim().replace(/^origin\//, "");
  const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();

  const { repositories } = loadRepositories();
  const builtin = !workdir ? repositories.find((r) => r.github.toLowerCase() === githubName.toLowerCase()) : undefined;
  const sameRepo = repositories.find((r) => r.github.toLowerCase() === githubName.toLowerCase() && (r.workdir ?? "") === workdir && r.custom);
  const prev = sameRepo ?? builtin;

  const det = detectProject(path.join(root, workdir));
  const subprojects = workdir ? [] : findSubprojects(root);
  if (det.empty && subprojects.length)
    warnings.push(`En la raíz no hay un proyecto reconocible, pero sí en: ${subprojects.map((s) => `${s.dir} (${s.stack})`).join(", ")}. Puedes registrar cada uno por separado indicando la subcarpeta.`);
  else if (!det.qaStages.length) warnings.push("No se detectaron comandos de build/pruebas: escribe los de QA o déjalo vacío (QA se omitirá).");

  const defaultBase =
    prev?.defaultBase && branches.includes(prev.defaultBase)
      ? prev.defaultBase
      : ["develop", "development", "dev"].find((b) => branches.includes(b)) ?? (branches.includes(head) ? head : null) ?? ["main", "master"].find((b) => branches.includes(b)) ?? (branches.includes(current) ? current : branches[0]);
  const allowed = prev?.allowedBases?.filter((b) => branches.includes(b)).length
    ? prev.allowedBases.filter((b) => branches.includes(b))
    : [...new Set([defaultBase, ...branches.filter((b) => BASE_ORDER.test(b))])].slice(0, 8);
  const repoName = githubName.split("/").pop()!;
  const taken = new Set(repositories.filter((r) => r.id !== prev?.id).flatMap((r) => [r.id, r.shortName]));
  const base = workdir ? `${repoName}-${workdir.split("/").pop()}` : repoName;
  const id = prev?.id ?? uniqueSlug(slugId(base), taken);
  const draft: RepositoryConfig = {
    ...(prev ?? {}),
    id,
    name: prev?.name ?? (workdir ? `${repoName}/${workdir}` : repoName),
    github: githubName,
    cloneUrl: prev?.cloneUrl ?? origin,
    shortName: prev?.shortName ?? uniqueSlug(slugId(workdir ? workdir.split("/").pop()! : repoName).slice(0, 20), taken),
    enabled: true,
    kind: prev?.kind ?? det.kind,
    stack: prev?.stack ?? det.stack,
    allowedBases: allowed.length ? allowed : [defaultBase],
    defaultBase,
    qaStages: prev?.qaStages ?? (prev?.qaCommands ? [prev.qaCommands] : det.qaStages),
    checkCommand: prev?.checkCommand ?? det.checkCommand,
    keywords: prev?.keywords ?? [...new Set([repoName.toLowerCase(), ...(workdir ? [workdir.split("/").pop()!.toLowerCase()] : [])])],
    protectedBranches: prev?.protectedBranches ?? [...new Set([defaultBase, ...["main", "master"].filter((b) => branches.includes(b))])],
    workdir: workdir || undefined,
    notes: prev?.notes ?? "",
    localPath: root,
    localStatus: null,
    custom: true,
  };
  delete draft.qaCommands;
  return {
    ok: true,
    message: `${builtin && !sameRepo ? "Repositorio ya conocido: se reutiliza su configuración" : `Detectado: ${det.stack}`} · ${branches.length} rama(s) en origin · tu rama actual (${current || "?"}) no se toca`,
    warnings,
    draft,
    branches,
    subprojects,
    existing: !!builtin,
  };
}

// ---------------- guardar / quitar ----------------

function writeProjects(list: RepositoryConfig[]): void {
  ensureWorkspace();
  fs.writeFileSync(paths.projects, JSON.stringify({ projects: list }, null, 2));
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const BRANCH = /^[\w.\-/]{1,120}$/;

/** Limpia y valida lo que llega del formulario. */
function sanitize(d: Partial<RepositoryConfig>, others: RepositoryConfig[]): RepositoryConfig {
  const id = slugId(str(d.id, 40) || str(d.name, 40));
  const github = str(d.github, 200);
  const cloneUrl = str(d.cloneUrl, 300);
  if (!github) throw new ProjectError("Falta el repositorio (owner/repo)");
  if (!cloneUrl) throw new ProjectError("Falta la URL del remoto (cloneUrl)");
  const shortName = slugId(str(d.shortName, 20) || id).slice(0, 20);
  const clash = others.find((r) => r.id !== id && (r.shortName === shortName || r.id === shortName));
  if (clash) throw new ProjectError(`El nombre corto "${shortName}" ya lo usa ${clash.name}; elige otro.`);
  const branches = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((b) => str(b, 120)).filter((b) => BRANCH.test(b) && !b.includes("..")))] : []);
  const defaultBase = str(d.defaultBase, 120);
  if (!BRANCH.test(defaultBase)) throw new ProjectError("Elige la rama base por defecto");
  const allowedBases = branches(d.allowedBases);
  if (!allowedBases.includes(defaultBase)) allowedBases.unshift(defaultBase);
  const qaStages = (Array.isArray(d.qaStages) ? d.qaStages : [])
    .map((s) => (Array.isArray(s) ? s.map((c) => str(c, 400)).filter(Boolean) : []))
    .filter((s) => s.length)
    .slice(0, 8);
  const workdir = str(d.workdir, 200).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (workdir && (workdir.split("/").includes("..") || path.isAbsolute(workdir))) throw new ProjectError("La subcarpeta debe ser una ruta relativa dentro del repositorio");
  const kind: Kind = d.kind === "frontend" || d.kind === "backend" ? d.kind : "other";
  const keywords = Array.isArray(d.keywords) ? [...new Set(d.keywords.map((k) => str(k, 40).toLowerCase()).filter(Boolean))].slice(0, 12) : [];
  const out: RepositoryConfig = {
    ...(d as RepositoryConfig),
    id,
    name: str(d.name, 80) || id,
    github,
    cloneUrl,
    shortName,
    enabled: true,
    kind,
    stack: str(d.stack, 120) || undefined,
    allowedBases,
    defaultBase,
    qaStages,
    checkCommand: str(d.checkCommand, 300) || undefined,
    installCommand: str(d.installCommand, 300) || undefined,
    keywords,
    protectedBranches: branches(d.protectedBranches),
    workdir: workdir || undefined,
    notes: str(d.notes, 4000) || undefined,
    custom: true,
  };
  delete out.localPath;
  delete out.localStatus;
  delete out.qaCommands;
  if (d.qaEnv && typeof d.qaEnv === "object") out.qaEnv = Object.fromEntries(Object.entries(d.qaEnv).map(([k, v]) => [str(k, 80), str(v, 400)]).filter(([k]) => /^\w+$/.test(k)));
  return out;
}

/** Guarda (o actualiza) un proyecto y su carpeta local. */
export async function saveProject(draft: Partial<RepositoryConfig>, localPath: string): Promise<{ project: RepositoryConfig; status: { ok: boolean; message: string } }> {
  if (!localPath?.trim()) throw new ProjectError("Indica la carpeta local del proyecto");
  const { repositories } = loadRepositories();
  const project = sanitize(draft, repositories);
  const custom = loadCustomProjects();
  const prev = custom.find((p) => p.id === project.id);
  const list = [...custom.filter((p) => p.id !== project.id), project];
  writeProjects(list);
  try {
    const status = await setRepoPath(project.id, localPath);
    if (!status.ok) throw new ProjectError(status.message);
    return { project, status };
  } catch (e) {
    // La carpeta no sirve: se deja todo como estaba.
    writeProjects(prev ? [...list.filter((p) => p.id !== project.id), prev] : list.filter((p) => p.id !== project.id));
    throw e instanceof ProjectError ? e : new ProjectError((e as Error).message);
  }
}

/** Quita un proyecto agregado (si era uno de config/repositories.json, vuelve a su configuración original). */
export async function removeProject(id: string): Promise<void> {
  const custom = loadCustomProjects();
  if (!custom.some((p) => p.id === id)) throw new ProjectError("Ese repositorio no fue agregado desde Ajustes");
  await setRepoPath(id, null).catch(() => undefined);
  writeProjects(custom.filter((p) => p.id !== id));
}
