import type { RuntimeStatus } from "../../shared/types";
import { config } from "../config";
import type { AgentSession, AgentTask } from "./AgentExecutor";
import { BaseCliExecutor, type Invocation } from "./BaseCliExecutor";
import { CodexJsonParser } from "./parsers/codexParser";
import { run } from "./processUtils";

const CACHE_MS = 60_000;

/**
 * Ejecuta el binario oficial `codex` autenticado con la cuenta ChatGPT del usuario.
 * Nunca usa OPENAI_API_KEY (se elimina del entorno del proceso hijo salvo ALLOW_PAID_API_FALLBACK=true).
 * Los flags se deciden a partir del `codex exec --help` de la versión instalada.
 */
export class CodexCliExecutor extends BaseCliExecutor {
  provider = "codex" as const;
  protected command = config.codexCommand;
  private checkedAt = 0;

  async checkAvailability(force = false): Promise<RuntimeStatus> {
    if (this.status && !force && Date.now() - this.checkedAt < CACHE_MS) return this.status;
    const st: RuntimeStatus = {
      provider: "codex",
      label: "Codex CLI",
      enabled: config.codexEnabled,
      installed: false,
      version: null,
      authenticated: null,
      authDetail: null,
      capabilities: {},
      message: "",
      checkedAt: new Date().toISOString(),
    };
    if (!config.codexEnabled) {
      st.message = "Deshabilitado (CODEX_ENABLED=false)";
      return this.save(st);
    }
    const v = await run(this.command, ["--version"], { timeoutMs: 15000 });
    if (v.code !== 0) {
      st.message = `Codex CLI no encontrado (${this.command}). Instálalo: npm i -g @openai/codex`;
      return this.save(st);
    }
    st.installed = true;
    st.version = (v.stdout || v.stderr).trim().split(/\s+/).pop() ?? null;

    const h = await run(this.command, ["exec", "--help"], { timeoutMs: 15000 });
    const help = `${h.stdout}\n${h.stderr}`;
    st.capabilities = {
      exec: h.code === 0,
      json: /--json\b/.test(help),
      experimentalJson: /--experimental-json\b/.test(help),
      cd: /--cd\b/.test(help),
      sandbox: /--sandbox\b/.test(help),
      skipGitRepoCheck: /--skip-git-repo-check\b/.test(help),
      resume: /\bresume\b/.test(help),
      stdinPrompt: /read from stdin|from stdin|`-` is used/i.test(help),
      color: /--color\b/.test(help),
    };

    const a = await run(this.command, ["login", "status"], { timeoutMs: 15000 });
    const out = `${a.stdout}\n${a.stderr}`.trim();
    if (a.code === 0 && /logged in/i.test(out)) {
      const apiKey = /api key/i.test(out);
      st.authDetail = out.split(/\r?\n/)[0];
      if (apiKey && !config.allowPaidApiFallback) {
        st.authenticated = false;
        st.message = "Codex está autenticado con API key. Para usar tu suscripción ejecuta: codex logout && codex login (ChatGPT).";
      } else {
        st.authenticated = true;
        st.message = "Conectado";
      }
    } else if (/not logged in/i.test(out) || a.code !== 0) {
      st.authenticated = false;
      st.authDetail = out.split(/\r?\n/)[0] || null;
      st.message = "Codex no está autenticado. Ejecuta codex login.";
    }
    if (st.installed && !st.capabilities.json && !st.capabilities.experimentalJson) {
      st.message = `Codex ${st.version} no soporta salida JSON en exec. Actualiza: npm i -g @openai/codex`;
      st.authenticated = st.authenticated && false;
    }
    return this.save(st);
  }

  private save(st: RuntimeStatus): RuntimeStatus {
    this.status = st;
    this.checkedAt = Date.now();
    return st;
  }

  private baseArgs(session: AgentSession, allowSandboxFlag = true): string[] {
    const caps = this.status?.capabilities ?? {};
    const args = ["exec", caps.json ? "--json" : "--experimental-json"];
    if (caps.color) args.push("--color", "never");
    if (caps.cd) args.push("--cd", session.config.cwd);
    if (caps.skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (allowSandboxFlag && caps.sandbox) args.push("--sandbox", session.config.permission === "read-only" ? "read-only" : "workspace-write");
    return args;
  }

  private withPrompt(args: string[], prompt: string): { args: string[]; stdin?: string } {
    const caps = this.status?.capabilities ?? {};
    // Si la versión acepta el prompt por stdin ('-'), se usa siempre: evita límites de longitud (Windows ~32k)
    // y que el prompt aparezca en la lista de procesos.
    if (caps.stdinPrompt) return { args: [...args, "-"], stdin: prompt };
    return { args: [...args, prompt] };
  }

  protected buildTask(session: AgentSession, task: AgentTask): Invocation {
    const parser = new CodexJsonParser(session.config.cwd);
    const p = this.withPrompt(this.baseArgs(session), task.prompt);
    return { ...p, parser, label: `codex-${slug(task.title)}` };
  }

  /**
   * Continuación de la misma sesión: `codex exec resume [opciones] <thread_id> -`.
   * `resume` tiene su propio set de flags (sin --cd ni --sandbox): el cwd lo fija spawn()
   * y el sandbox se pasa como override de configuración `-c sandbox_mode=...`.
   */
  protected buildMessage(session: AgentSession, message: string): Invocation {
    const parser = new CodexJsonParser(session.config.cwd);
    const caps = this.status?.capabilities ?? {};
    if (session.cliSessionId && caps.resume) {
      const sandbox = session.config.permission === "read-only" ? "read-only" : "workspace-write";
      const args = ["exec", "resume", caps.json ? "--json" : "--experimental-json", "-c", `sandbox_mode="${sandbox}"`];
      if (caps.skipGitRepoCheck) args.push("--skip-git-repo-check");
      args.push(session.cliSessionId);
      return { ...this.withPrompt(args, message), parser, label: "codex-resume" };
    }
    const p = this.withPrompt(this.baseArgs(session), message);
    return { ...p, parser, label: "codex-chat" };
  }
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}
