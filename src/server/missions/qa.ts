import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RepositoryConfig } from "../../shared/types";
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
      else if (fs.existsSync(path.join(wt, "package-lock.json"))) setup.push("npm ci");
      else setup.push("npm install");
    }
  }
  if (fs.existsSync(path.join(wt, "composer.json")) && !fs.existsSync(path.join(wt, "vendor"))) {
    setup.push("composer install --no-interaction --prefer-dist");
  }
  // "php artisan test" configurado a mano también aprovecha ParaTest si está instalado.
  const par = (c: string) => (c.trim() === "php artisan test" && hasParatest(wt) ? "php artisan test --parallel" : c);
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
  if (fs.existsSync(path.join(wt, "artisan"))) commands.push(hasParatest(wt) ? "php artisan test --parallel" : "php artisan test");
  else if (fs.existsSync(path.join(wt, "vendor", "bin", "phpunit")) || fs.existsSync(path.join(wt, "phpunit.xml"))) commands.push("vendor/bin/phpunit");
  return { setup, commands, stages: commands.length ? [commands] : [], note: commands.length ? null : "No se detectaron comandos de build/test en el repositorio" };
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
  opts: { timeoutMs?: number; signal?: { cancelled: boolean; kill?: () => void } } = {},
): Promise<CommandResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(resolveShellCommand(command), {
      cwd,
      shell: true,
      env: childEnv({ CI: "true" }),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
