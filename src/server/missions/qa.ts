import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { RepositoryConfig } from "../../shared/types";
import { trackChild } from "../runtime/childRegistry";
import { childEnv, killTree } from "../runtime/processUtils";
import { summarizeOutput } from "../runtime/parsers/common";

export interface QaPlan {
  setup: string[];
  /** Todos los comandos (para mostrar). */
  commands: string[];
  /** Etapas en orden; los comandos de una etapa corren en paralelo. */
  stages: string[][];
  note: string | null;
}

function hasParatest(wt: string): boolean {
  for (const f of ["composer.json", "composer.lock"]) {
    try {
      if (fs.readFileSync(path.join(wt, f), "utf8").includes("brianium/paratest")) return true;
    } catch {
      /* no existe */
    }
  }
  return false;
}

/** Detecta comandos reales de QA para el worktree. */
export function detectQa(wt: string, repo: RepositoryConfig): QaPlan {
  const setup: string[] = [];
  const commands: string[] = [];
  const pkgPath = path.join(wt, "package.json");
  if (fs.existsSync(pkgPath)) {
    if (!fs.existsSync(path.join(wt, "node_modules"))) {
      if (repo.installCommand) setup.push(repo.installCommand);
      else if (fs.existsSync(path.join(wt, "pnpm-lock.yaml"))) setup.push("pnpm install --frozen-lockfile");
      else if (fs.existsSync(path.join(wt, "yarn.lock"))) setup.push("yarn install --frozen-lockfile");
      else if (fs.existsSync(path.join(wt, "package-lock.json"))) setup.push("npm ci --include=dev");
      else setup.push("npm install --include=dev");
    }
  }
  if (fs.existsSync(path.join(wt, "composer.json")) && !fs.existsSync(path.join(wt, "vendor"))) {
    setup.push("composer install --no-interaction --prefer-dist");
  }
  // "php artisan test" configurado a mano también aprovecha ParaTest si está instalado.
  const par = (c: string) => (c.trim() === "php artisan test" && repo.qaParallelTests !== false && hasParatest(wt) ? "php artisan test --parallel" : c);
  const stages = repo.qaStages?.map((s) => s.filter(Boolean).map(par)).filter((s) => s.length);
  if (stages?.length) return { setup, commands: stages.flat(), stages, note: null };
  if (repo.qaCommands?.length) return { setup, commands: repo.qaCommands, stages: [repo.qaCommands], note: null };

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const s = pkg.scripts ?? {};
      if (s.build) commands.push("npm run build");
      if (s.test && !/no test specified/.test(s.test)) commands.push("npm test");
    } catch {
      /* package.json inválido: se reportará al correr */
    }
  }
  // Con ParaTest instalado, Laravel reparte las pruebas en varios procesos (cada uno con su propia BD de prueba).
  if (fs.existsSync(path.join(wt, "artisan"))) commands.push(repo.qaParallelTests !== false && hasParatest(wt) ? "php artisan test --parallel" : "php artisan test");
  else if (fs.existsSync(path.join(wt, "vendor", "bin", "phpunit")) || fs.existsSync(path.join(wt, "phpunit.xml"))) commands.push("vendor/bin/phpunit");
  return { setup, commands, stages: commands.length ? [commands] : [], note: commands.length ? null : "No se detectaron comandos de build/test en el repositorio" };
}

/** Variables de QA del repo con `${VAR:-por defecto}` resuelto desde el entorno de la oficina. */
export function qaEnvFor(repo: RepositoryConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(repo.qaEnv ?? {}))
    out[k] = String(v).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => env[name] || def || "");
  return out;
}

/**
 * Antes de correr QA: si el repo prueba contra una base de datos de red (MySQL/Postgres), comprueba que
 * responda. Devuelve el problema (en palabras) o null si se puede correr.
 */
export async function qaPreflight(env: Record<string, string>, timeoutMs = 3000): Promise<string | null> {
  const driver = (env.DB_CONNECTION ?? "").toLowerCase();
  if (!["mysql", "mariadb", "pgsql"].includes(driver)) return null;
  const host = env.DB_HOST || "127.0.0.1";
  const port = Number(env.DB_PORT || (driver === "pgsql" ? 5432 : 3306));
  const ok = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
  return ok
    ? null
    : `no hay ${driver === "pgsql" ? "PostgreSQL" : "MySQL"} en ${host}:${port} para las pruebas (base ${env.DB_DATABASE || "?"}, usuario ${env.DB_USERNAME || "?"}), como el que usa el CI`;
}

/**
 * ¿La falla es del ENTORNO de QA (base de datos, .env, dependencias) y no del código? Esas no se le pasan al
 * desarrollador para "corregir": no es su código, y tocaría archivos que no corresponden.
 */
export function environmentProblem(output: string): string | null {
  const checks: [RegExp, string][] = [
    [/(\w+) es obligatorio|parameter null or not set|: (\w+): unbound variable/i, "faltan variables de entorno de QA"],
    [/SQLSTATE\[HY000\] \[(2002|2003|1045|1049)\]|Connection refused|could not connect to server|Can't connect to MySQL/i, "no se pudo conectar a la base de datos de pruebas"],
    [/could not find driver/i, "falta la extensión de PHP para la base de datos (pdo_mysql/pdo_pgsql)"],
    [/vendor[\\/]autoload\.php|Failed opening required/i, "faltan las dependencias (vendor/)"],
    [/No application encryption key has been specified|MissingAppKeyException/i, "falta APP_KEY"],
    [/database file at path .* does not exist|Database .* does not exist/i, "no existe la base de datos de pruebas"],
  ];
  for (const [re, why] of checks) if (re.test(output)) return why;
  return null;
}

/** La línea que mejor explica por qué falló un comando (para el resumen). */
export function failureLine(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => /error|exception|failed|fail|obligatorio|SQLSTATE|denied|not found|no existe|✗|⨯/i.test(l) && !/^at |^#\d/.test(l));
  const l = hit ?? lines.at(-1) ?? "";
  return l.length > 160 ? `${l.slice(0, 159)}…` : l;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  output: string;
  summary: string;
  durationMs: number;
}

/**
 * En Windows, `bash scripts/...` necesita el bash de Git: el de System32 es WSL (otro sistema)
 * y a menudo Git Bash no está en el PATH. Se usa la ruta de Git for Windows si existe.
 */
export function resolveShellCommand(cmd: string, platform = process.platform, exists = fs.existsSync): string {
  if (platform !== "win32" || !/^bash(\.exe)?\s/i.test(cmd)) return cmd;
  const candidates = [
    process.env.GIT_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.LOCALAPPDATA ? path.win32.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : undefined,
  ].filter((c): c is string => !!c);
  const bash = candidates.find((c) => exists(c));
  return bash ? cmd.replace(/^bash(\.exe)?/i, `"${bash}"`) : cmd;
}

/** Ejecuta un comando real con streaming (shell). */
export function runShell(
  command: string,
  cwd: string,
  onOutput: (chunk: string) => void,
  opts: { timeoutMs?: number; signal?: { cancelled: boolean; kill?: () => void }; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(resolveShellCommand(command), {
      cwd,
      shell: true,
      env: childEnv({ CI: "true", ...(opts.env ?? {}) }),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChild(child);
    if (opts.signal) opts.signal.kill = () => killTree(child);
    const onData = (d: Buffer) => {
      const s = d.toString();
      output += s;
      if (output.length > 400_000) output = output.slice(-400_000);
      onOutput(s);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => killTree(child), opts.timeoutMs ?? 20 * 60_000);
    child.on("error", (e) => {
      output += `\n${e.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code, output, summary: summarizeOutput(output), durationMs: Date.now() - t0 });
    });
  });
}
