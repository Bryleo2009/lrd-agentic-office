import { randomUUID } from "node:crypto";
import type { RuntimeStatus } from "../../shared/types";
import { config } from "../config";
import type { AgentSession, AgentTask } from "./AgentExecutor";
import { BaseCliExecutor, type Invocation } from "./BaseCliExecutor";
import { ClaudeStreamParser } from "./parsers/claudeParser";
import { run } from "./processUtils";

const CACHE_MS = 60_000;

const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "TodoWrite",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git show:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  // Verificación sin modificar código fuente
  "Bash(npm run build:*)",
  "Bash(npm test:*)",
  "Bash(npm run test:*)",
  "Bash(npm run lint:*)",
  "Bash(php artisan test:*)",
  "Bash(vendor/bin/phpunit:*)",
  "Bash(composer validate:*)",
];
const WRITE_TOOLS = ["Read", "Grep", "Glob", "LS", "TodoWrite", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];
const ALWAYS_DENY = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git reset:*)",
  "Bash(git rebase:*)",
  "Bash(git merge:*)",
  "Bash(git worktree:*)",
  "Bash(gh:*)",
];
const READ_ONLY_DENY = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/**
 * Ejecuta el binario oficial `claude` (Claude Code) autenticado con la cuenta del usuario.
 * Modo no interactivo: `claude -p --output-format stream-json --verbose`.
 * Nunca usa ANTHROPIC_API_KEY salvo ALLOW_PAID_API_FALLBACK=true.
 */
export class ClaudeCodeExecutor extends BaseCliExecutor {
  provider = "claude" as const;
  protected command = config.claudeCommand;
  private checkedAt = 0;

  async checkAvailability(force = false): Promise<RuntimeStatus> {
    if (this.status && !force && Date.now() - this.checkedAt < CACHE_MS) return this.status;
    const st: RuntimeStatus = {
      provider: "claude",
      label: "Claude Code",
      enabled: config.claudeEnabled,
      installed: false,
      version: null,
      authenticated: null,
      authDetail: null,
      capabilities: {},
      message: "",
      checkedAt: new Date().toISOString(),
    };
    if (!config.claudeEnabled) {
      st.message = "Deshabilitado (CLAUDE_ENABLED=false)";
      return this.save(st);
    }
    const v = await run(this.command, ["--version"], { timeoutMs: 20000 });
    if (v.code !== 0) {
      st.message = "NO DISPONIBLE — Claude Code no está instalado (npm i -g @anthropic-ai/claude-code)";
      return this.save(st);
    }
    st.installed = true;
    st.version = (v.stdout || v.stderr).trim().split(/\s+/)[0] ?? null;

    const h = await run(this.command, ["--help"], { timeoutMs: 20000 });
    const help = `${h.stdout}\n${h.stderr}`;
    st.capabilities = {
      print: /--print\b/.test(help),
      streamJson: /stream-json/.test(help),
      verbose: /--verbose\b/.test(help),
      sessionId: /--session-id\b/.test(help),
      resume: /--resume\b/.test(help),
      permissionMode: /--permission-mode\b/.test(help),
      allowedTools: /--allowedTools\b|--allowed-tools\b/.test(help),
      disallowedTools: /--disallowedTools\b|--disallowed-tools\b/.test(help),
      appendSystemPrompt: /--append-system-prompt\b/.test(help),
      authCommand: /\bauth\b/.test(help),
    };

    if (st.capabilities.authCommand) {
      const a = await run(this.command, ["auth", "status"], { timeoutMs: 20000 });
      try {
        const j = JSON.parse(a.stdout);
        st.authenticated = !!j.loggedIn;
        st.authDetail = j.loggedIn ? `${j.authMethod ?? "login"}${j.email ? " · " + j.email : ""}` : "sin sesión";
        if (j.loggedIn && /api.?key/i.test(String(j.authMethod)) && !config.allowPaidApiFallback) {
          st.authenticated = false;
          st.message = "Claude Code está usando API key. Inicia sesión con tu cuenta: claude auth login";
        }
      } catch {
        st.authenticated = a.code === 0 ? null : false;
        st.authDetail = (a.stdout || a.stderr).trim().split(/\r?\n/)[0] || null;
      }
    }
    if (!st.message)
      st.message =
        st.authenticated === false
          ? "Claude Code no está autenticado. Ejecuta `claude` y usa /login, o `claude auth login`."
          : st.authenticated === null
            ? "Instalado (autenticación se verificará al primer uso)"
            : "Conectado";
    if (!st.capabilities.print || !st.capabilities.streamJson) {
      st.message = `Claude Code ${st.version} no soporta -p con stream-json. Actualiza Claude Code.`;
      st.authenticated = false;
    }
    return this.save(st);
  }

  private save(st: RuntimeStatus): RuntimeStatus {
    this.status = st;
    this.checkedAt = Date.now();
    return st;
  }

  private args(session: AgentSession, appendSystem: string | null): string[] {
    const caps = this.status?.capabilities ?? {};
    const a = ["-p", "--output-format", "stream-json"];
    if (caps.verbose) a.push("--verbose");
    if (session.hasTurn && session.cliSessionId && caps.resume) a.push("--resume", session.cliSessionId);
    else if (caps.sessionId) {
      session.cliSessionId = session.cliSessionId ?? randomUUID();
      a.push("--session-id", session.cliSessionId);
    }
    const ro = session.config.permission === "read-only";
    if (caps.permissionMode) a.push("--permission-mode", ro ? "default" : "acceptEdits");
    if (caps.allowedTools) a.push("--allowedTools", ...(ro ? READ_ONLY_TOOLS : WRITE_TOOLS));
    if (caps.disallowedTools) a.push("--disallowedTools", ...(ro ? [...READ_ONLY_DENY, ...ALWAYS_DENY] : ALWAYS_DENY));
    if (appendSystem && caps.appendSystemPrompt) a.push("--append-system-prompt", appendSystem);
    return a;
  }

  protected buildTask(session: AgentSession, task: AgentTask): Invocation {
    const guard =
      "Trabajas dentro de un git worktree aislado gestionado por LRD Agentic Office. " +
      "No hagas git commit, push, checkout ni crees ramas: el orquestador controla Git. No pidas confirmaciones: actúa y resume.";
    return { args: this.args(session, guard), stdin: task.prompt, parser: new ClaudeStreamParser(session.config.cwd), label: "claude-task" };
  }

  protected buildMessage(session: AgentSession, message: string): Invocation {
    return { args: this.args(session, null), stdin: message, parser: new ClaudeStreamParser(session.config.cwd), label: "claude-chat" };
  }
}
