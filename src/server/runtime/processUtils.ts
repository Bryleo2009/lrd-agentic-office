import spawn from "cross-spawn";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { config } from "../config";

/**
 * Entorno para procesos hijo (codex / claude / git).
 * Si ALLOW_PAID_API_FALLBACK=false se eliminan las API keys para que los CLIs
 * usen exclusivamente la sesión de suscripción del usuario (ChatGPT / Claude).
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!config.allowPaidApiFallback) {
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // Evita que un Claude Code anidado herede la sesión del proceso padre.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Ejecuta un comando corto y captura salida (para --version, --help, git, gh). Usa spawn, nunca execSync. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, stdout, stderr, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) {
        killTree(child);
        settled = true;
        resolve({ code: null, stdout, stderr, error: `Timeout tras ${opts.timeoutMs} ms` });
      }
    }, opts.timeoutMs ?? 20_000);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin?.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

export function spawnStreaming(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  return spawn(cmd, args, {
    ...opts,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

export function killTree(child: ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ya terminó */
        }
      }, 4000);
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Lee stdout línea a línea mientras llega y produce cada línea.
 * Termina cuando el proceso cierra stdout.
 */
export async function* readLines(child: ChildProcess): AsyncGenerator<string> {
  const stream = child.stdout!;
  stream.setEncoding("utf8");
  let buf = "";
  for await (const chunk of stream as AsyncIterable<string>) {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

export function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("close", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function tail(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(s.length - n) : s;
}
