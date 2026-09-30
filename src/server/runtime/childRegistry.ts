import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

/**
 * Registro de procesos hijo de larga duración (Codex, Claude, comandos de QA).
 *
 * En Linux/macOS se lanzan en su propio grupo (detached) para poder matar el árbol completo; por eso,
 * si el servidor se detiene, NO mueren solos. Este registro:
 *  - los cierra al apagarse el servidor (Ctrl+C, reinicio de `npm run dev`);
 *  - al arrancar, cierra los que hayan quedado huérfanos de un cierre abrupto, para que al retomar
 *    una misión no haya dos agentes editando la misma carpeta.
 * Solo se matan procesos cuyo nombre corresponde a lo que la oficina lanza (evita PIDs reutilizados).
 */
const FILE = () => path.join(config.workspaceRoot, "children.json");
const live = new Map<number, ChildProcess>();
const EXPECTED = /codex|claude|node|bash|sh|php|npm|npx|composer|cmd|pwsh|powershell|git|vendor|artisan|tsx|vite|vitest|jest/i;

function save(): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify([...live.keys()]));
  } catch {
    /* sin disco: no es crítico */
  }
}

export function trackChild(child: ChildProcess): void {
  if (!child.pid) return;
  const pid = child.pid;
  live.set(pid, child);
  save();
  child.once("close", () => {
    live.delete(pid);
    save();
  });
}

function processName(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      const m = r.stdout?.match(/^"([^"]+)"/m);
      return m ? m[1] : null;
    }
    const r = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else {
      try {
        process.kill(-pid, "SIGKILL"); // grupo completo (detached)
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* ya no existe */
  }
}

/** Al arrancar: cierra procesos que quedaron vivos de una ejecución anterior. Devuelve cuántos cerró. */
export function reapOrphans(): number {
  let pids: number[] = [];
  try {
    pids = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return 0;
  }
  let n = 0;
  for (const pid of Array.isArray(pids) ? pids : []) {
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    const name = processName(pid);
    if (name && EXPECTED.test(name)) {
      killPid(pid);
      n++;
    }
  }
  try {
    fs.writeFileSync(FILE(), "[]");
  } catch {
    /* ignore */
  }
  return n;
}

/** Al apagarse: cierra todo lo que la oficina lanzó. */
export function killAllChildren(): void {
  for (const pid of live.keys()) killPid(pid);
  live.clear();
  save();
}

let installed = false;
/** Cierra los hijos al recibir Ctrl+C / SIGTERM (reinicio de `tsx watch`) y sale. */
export function installShutdownHooks(): void {
  if (installed) return;
  installed = true;
  const bye = (sig: string) => {
    if (live.size) console.log(`[lrd] ${sig}: cerrando ${live.size} proceso(s) de agentes/QA; las misiones se retomarán al volver a arrancar.`);
    killAllChildren();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(sig, () => bye(sig));
    } catch {
      /* señal no soportada en esta plataforma */
    }
  }
  process.on("exit", () => killAllChildren());
}

