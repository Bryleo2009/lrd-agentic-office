import { isToolMcp, type RuntimeStatus } from "../../shared/types";
import { config } from "../config";
import type { AgentSession, AgentTask } from "./AgentExecutor";
import { BaseCliExecutor, type Invocation } from "./BaseCliExecutor";
import { pluginForServer, readCodexConfig } from "./codexConfig";
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
      mcpServers: [],
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

    st.mcpServers = await this.listMcp();

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

  /** `codex mcp list --json`: sólo nombre, estado y tipo de transporte (nunca args/env, pueden tener credenciales). */
  private async listMcp(): Promise<RuntimeStatus["mcpServers"]> {
    const r = await run(this.command, ["mcp", "list", "--json"], { timeoutMs: 15000 });
    if (r.code !== 0) return [];
    try {
      const arr = JSON.parse(r.stdout) as { name: string; enabled?: boolean; transport?: { type?: string } }[];
      return arr.map((m) => ({ name: String(m.name), enabled: m.enabled !== false, transport: m.transport?.type ?? "?" }));
    } catch {
      return [];
    }
  }

  /** Desactiva los MCP para esta invocación si la misión no los permite. */
  private mcpArgs(session: AgentSession): string[] {
    const allow = new Set(session.config.mcpAllow);
    const cfg = readCodexConfig();
    const args: string[] = [];
    const plugins = new Set<string>();
    for (const m of this.status?.mcpServers ?? []) {
      if (!m.enabled || allow.has(m.name) || !/^[\w-]+$/.test(m.name)) continue;
      // Herramientas integradas (cua_repl, browser…) que no están en [mcp_servers]: no son fuentes de
      // datos y Codex rechaza desactivarlas por override, así que no se intenta (evita un arranque fallido).
      if (cfg && isToolMcp(m.name) && !cfg.mcpServers.includes(m.name)) continue;
      // Un MCP aportado por un plugin no está en [mcp_servers.<n>]: `mcp_servers.<n>.enabled=false`
      // crearía una entrada sin command/url ("invalid transport"). Se desactiva el plugin completo.
      const plugin = cfg && !cfg.mcpServers.includes(m.name) ? pluginForServer(m.name, cfg) : null;
      if (plugin && /^[\w@-]+$/.test(plugin)) plugins.add(plugin);
      else args.push("-c", `mcp_servers.${m.name}.enabled=false`);
    }
    for (const p of plugins) args.push("-c", `plugins.${p}.enabled=false`);
    return args;
  }

  /**
   * Correcciones seguras cuando Codex no arranca por los overrides `mcp_servers.<n>.enabled=false`:
   *
   * 1. "invalid transport" en `mcp_servers.<n>`: el servidor no está definido en el config.toml que
   *    Codex lee desde este directorio (p. ej. vive en el config de otro proyecto), así que el override
   *    crea una entrada sin `command` ni `url`. Se confirma con `codex mcp list` en el mismo directorio:
   *    si ahí no existe, quitar el override no expone nada.
   * 2. Herramientas integradas (p. ej. node_repl, cua_repl) que no aceptan el override: se quitan.
   *
   * Nunca se relaja el bloqueo de una fuente de datos que sí está disponible para el agente.
   */
  protected async recoverFromStartupFailure(inv: Invocation, stderr: string, session: AgentSession): Promise<{ inv: Invocation; note: string } | null> {
    const overridden = inv.args.flatMap((a, i) => (inv.args[i - 1] === "-c" ? [a.match(/^mcp_servers\.([\w-]+)\.enabled=false$/)?.[1]] : [])).filter((n): n is string => !!n);
    if (!overridden.length) return null;
    const mentioned = overridden.filter((n) => new RegExp(`mcp_servers\\.${n}\\b|\\b${n}\\b`).test(stderr));

    if (/invalid transport|missing field .?(command|url)/i.test(stderr) && mentioned.length) {
      const here = await this.listMcpAt(session.config.cwd);
      const undefinedHere = here ? mentioned.filter((n) => !here.includes(n)) : [];
      if (undefinedHere.length)
        return {
          inv: this.withoutOverrides(inv, undefinedHere),
          note: `${undefinedHere.join(", ")} no está configurado para esta carpeta; se reintenta sin intentar desactivarlo`,
        };
      // Definido aquí: puede ser una herramienta integrada que no acepta el override (caso 2).
    }

    const generic = !mentioned.length && /mcp_servers/i.test(stderr);
    if (!mentioned.length && !generic) return null;
    const drop = generic ? overridden.filter(isToolMcp) : mentioned;
    if (!drop.length || drop.some((n) => !isToolMcp(n))) return null;
    return {
      inv: this.withoutOverrides(inv, drop),
      note: `Ajustando el arranque de Codex (${drop.join(", ")} es una herramienta integrada)`,
    };
  }

  private withoutOverrides(inv: Invocation, names: string[]): Invocation {
    const args: string[] = [];
    for (let i = 0; i < inv.args.length; i++) {
      if (inv.args[i] === "-c" && names.some((n) => inv.args[i + 1] === `mcp_servers.${n}.enabled=false`)) {
        i++;
        continue;
      }
      args.push(inv.args[i]);
    }
    return { ...inv, args, parser: new CodexJsonParser((inv.parser as CodexJsonParser).cwd) };
  }

  /** Nombres de MCP que Codex ve desde `cwd` (null si Codex no puede leer su configuración ahí). */
  private async listMcpAt(cwd: string): Promise<string[] | null> {
    const r = await run(this.command, ["mcp", "list", "--json"], { cwd, timeoutMs: 15000 });
    if (r.code !== 0) return null;
    try {
      return (JSON.parse(r.stdout) as { name: string }[]).map((m) => String(m.name));
    } catch {
      return null;
    }
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
    args.push(...this.mcpArgs(session));
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
      const args = ["exec", "resume", caps.json ? "--json" : "--experimental-json", "-c", `sandbox_mode="${sandbox}"`, ...this.mcpArgs(session)];
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
