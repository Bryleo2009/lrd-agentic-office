import fs from "node:fs";
import path from "node:path";
import type { Provider, RuntimeStatus } from "../../shared/types";
import type { AgentExecutor, AgentSession, AgentTask, ExecutorEvent, SessionConfig } from "./AgentExecutor";
import { ExecutorUnavailableError } from "./AgentExecutor";
import { childEnv, killTree, readLines, spawnStreaming, tail, waitExit } from "./processUtils";

export interface LineParser {
  sessionId: string | null;
  finalText: string;
  parseLine(line: string): ExecutorEvent[];
}

export interface Invocation {
  args: string[];
  stdin?: string;
  parser: LineParser;
  label: string;
}

/** Base común: spawn + streaming de stdout JSONL + timeout + cancelación + log crudo. */
export abstract class BaseCliExecutor implements AgentExecutor {
  abstract provider: Provider;
  protected abstract command: string;
  protected status: RuntimeStatus | null = null;

  abstract checkAvailability(force?: boolean): Promise<RuntimeStatus>;
  protected abstract buildTask(session: AgentSession, task: AgentTask): Invocation;
  protected abstract buildMessage(session: AgentSession, message: string): Invocation;

  async startSession(cfg: SessionConfig): Promise<AgentSession> {
    const st = await this.checkAvailability();
    if (!st.installed) throw new ExecutorUnavailableError(`${st.label} no está instalado (${this.command}).`);
    if (st.authenticated === false) throw new ExecutorUnavailableError(st.message);
    fs.mkdirSync(cfg.runDir, { recursive: true });
    return { provider: this.provider, config: cfg, cliSessionId: null, hasTurn: false, process: null, cancelled: false };
  }

  executeTask(session: AgentSession, task: AgentTask): AsyncIterable<ExecutorEvent> {
    return this.runInvocation(session, this.buildTask(session, task), task.prompt);
  }

  sendMessage(session: AgentSession, message: string): AsyncIterable<ExecutorEvent> {
    return this.runInvocation(session, this.buildMessage(session, message), message);
  }

  async cancel(session: AgentSession): Promise<void> {
    session.cancelled = true;
    killTree(session.process);
  }

  async resume(session: AgentSession): Promise<void> {
    session.cancelled = false;
  }

  async close(session: AgentSession): Promise<void> {
    killTree(session.process);
    session.process = null;
  }

  private async *runInvocation(session: AgentSession, inv: Invocation, promptForLog: string): AsyncGenerator<ExecutorEvent> {
    const { cwd, runDir, timeoutMs } = session.config;
    fs.mkdirSync(runDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(runDir, `${stamp}-${inv.label}.jsonl`);
    fs.writeFileSync(path.join(runDir, `${stamp}-${inv.label}.prompt.md`), promptForLog);
    const log = fs.createWriteStream(logFile);

    const child = spawnStreaming(this.command, inv.args, { cwd, env: childEnv() });
    session.process = child;
    let stderr = "";
    let spawnError: string | null = null;
    child.on("error", (e) => (spawnError = e.message));
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    if (inv.stdin !== undefined) child.stdin?.end(inv.stdin);
    else child.stdin?.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    yield {
      type: "SESSION_STARTED",
      title: `${this.provider === "codex" ? "Codex CLI" : "Claude Code"} iniciado`,
      detail: `${this.command} ${inv.args.filter((a) => a !== inv.stdin).map((a) => (a.length > 80 ? a.slice(0, 77) + "…" : a)).join(" ")}`,
      status: "running",
      metadata: { pid: child.pid, cwd, log: logFile },
    };

    let terminal = false;
    try {
      for await (const line of readLines(child)) {
        log.write(line + "\n");
        for (const ev of inv.parser.parseLine(line)) {
          if (inv.parser.sessionId && inv.parser.sessionId !== session.cliSessionId) session.cliSessionId = inv.parser.sessionId;
          if (ev.type === "AGENT_FINISHED" || ev.type === "AGENT_ERROR") terminal = true;
          yield ev;
        }
      }
    } finally {
      clearTimeout(timer);
      log.end();
    }
    const code = await waitExit(child);
    session.process = null;
    session.hasTurn = true;
    if (inv.parser.sessionId) session.cliSessionId = inv.parser.sessionId;

    if (session.cancelled) {
      yield { type: "AGENT_ERROR", title: "Cancelado por el usuario", status: "error", metadata: { cancelled: true } };
      return;
    }
    if (timedOut) {
      yield { type: "AGENT_ERROR", title: `Tiempo máximo excedido (${Math.round(timeoutMs / 60000)} min)`, status: "error", detail: tail(stderr, 1500) };
      return;
    }
    if (spawnError) {
      yield { type: "AGENT_ERROR", title: `No se pudo ejecutar ${this.command}`, detail: spawnError, status: "error" };
      return;
    }
    if (code !== 0 && !terminal) {
      yield { type: "AGENT_ERROR", title: `${this.command} terminó con código ${code}`, detail: tail(stderr, 3000) || "(sin stderr)", status: "error", metadata: { exitCode: code } };
      return;
    }
    if (!terminal) {
      yield { type: "AGENT_FINISHED", title: "Proceso terminado", detail: inv.parser.finalText, status: "success", finalText: inv.parser.finalText };
    }
  }
}
