import type { ExecutorEvent } from "../AgentExecutor";
import { explainCliFailure, explainedDetail } from "../humanize";
import { base, classifyCommand, clip, describeCommand, firstLine, rel, summarizeOutput } from "./common";

interface PendingTool {
  name: string;
  input: Record<string, any>;
  kind: string;
}

/**
 * Parser desacoplado del formato `claude -p --output-format stream-json --verbose`.
 * Descarta bloques `thinking` (nunca se expone razonamiento).
 */
export class ClaudeStreamParser {
  sessionId: string | null = null;
  finalText = "";
  lastAssistantText = "";
  private tools = new Map<string, PendingTool>();

  constructor(private cwd: string) {}

  parseLine(line: string): ExecutorEvent[] {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return [];
    }
    const out: ExecutorEvent[] = [];
    switch (o.type) {
      case "system":
        if (o.subtype === "init") {
          this.sessionId = o.session_id ?? this.sessionId;
          out.push({
            type: "SESSION_CONNECTED",
            title: "Claude Code conectado",
            detail: `modelo ${o.model ?? "?"} · permisos ${o.permissionMode ?? "?"}`,
            status: "success",
            metadata: { cliSessionId: o.session_id, model: o.model, version: o.claude_code_version, apiKeySource: o.apiKeySource },
          });
        }
        break;
      case "assistant": {
        const content = Array.isArray(o.message?.content) ? o.message.content : [];
        for (const c of content) {
          if (c.type === "text" && c.text?.trim()) {
            this.lastAssistantText = c.text;
            out.push({ type: "AGENT_MESSAGE", title: firstLine(c.text), detail: clip(c.text, 6000), status: "info" });
          } else if (c.type === "tool_use") {
            out.push(...this.toolStart(c.id, c.name, c.input ?? {}));
          }
          // "thinking" / "redacted_thinking": se ignoran deliberadamente.
        }
        break;
      }
      case "user": {
        const content = Array.isArray(o.message?.content) ? o.message.content : [];
        for (const c of content) if (c.type === "tool_result") out.push(...this.toolEnd(c.tool_use_id, c.content, !!c.is_error));
        break;
      }
      case "result": {
        this.sessionId = o.session_id ?? this.sessionId;
        this.finalText = typeof o.result === "string" ? o.result : this.lastAssistantText;
        const meta = { cliSessionId: o.session_id, turns: o.num_turns, durationMs: o.duration_ms, subtype: o.subtype };
        if (o.is_error || (o.subtype && o.subtype !== "success")) {
          const raw = clip(String(o.result ?? o.subtype ?? "error"), 2000);
          const ex =
            o.subtype === "error_max_turns"
              ? { title: "Claude Code llegó al máximo de pasos permitidos", hint: "La tarea era muy larga para un solo turno: divídela o vuelve a lanzarla para continuar." }
              : explainCliFailure("claude", undefined, raw);
          out.push({
            type: "AGENT_ERROR",
            title: ex.title,
            detail: explainedDetail(ex, undefined, raw),
            status: "error",
            metadata: { ...meta, hint: ex.hint },
            finalText: this.finalText,
          });
        } else {
          out.push({ type: "AGENT_FINISHED", title: "Tarea completada", detail: clip(this.finalText, 6000), status: "success", metadata: meta, finalText: this.finalText });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  private toolStart(id: string, name: string, input: Record<string, any>): ExecutorEvent[] {
    const file = rel(input.file_path ?? input.notebook_path ?? input.path, this.cwd);
    let kind = "tool";
    let ev: ExecutorEvent;
    switch (name) {
      case "Read":
        kind = "read";
        ev = { type: "FILE_READ", title: `Analizando ${base(file)}`, file, tool: name, status: "running" };
        break;
      case "Grep":
      case "Glob":
      case "LS":
      case "WebSearch":
      case "WebFetch":
      case "ToolSearch":
        kind = "search";
        ev = {
          type: "SEARCH_STARTED",
          title: `Buscando ${firstLine(String(input.pattern ?? input.query ?? input.url ?? input.path ?? ""), 60)}`,
          tool: name,
          detail: JSON.stringify(input).slice(0, 400),
          status: "running",
        };
        break;
      case "Edit":
      case "MultiEdit":
      case "Write":
      case "NotebookEdit":
        kind = "edit";
        ev = { type: "TOOL_STARTED", title: `Editando ${base(file)}`, file, tool: name, status: "running", metadata: { edit: true } };
        break;
      case "Bash": {
        const cmd = String(input.command ?? "");
        const c = classifyCommand(cmd);
        kind = c.kind === "test" || c.kind === "build" ? "test" : c.kind === "read" ? "read" : c.kind === "search" ? "search" : "command";
        // Claude Code suele describir el comando ("Run the linter"); si no, se describe en palabras.
        const say = describeCommand(cmd);
        if (kind === "test") ev = { type: "TEST_STARTED", title: `${say}…`, command: cmd, tool: name, status: "running" };
        else if (kind === "read") ev = { type: "FILE_READ", title: say, file: rel(c.file, this.cwd), command: cmd, tool: name, status: "running" };
        else if (kind === "search") ev = { type: "SEARCH_STARTED", title: `${say}…`, command: cmd, tool: name, status: "running" };
        else ev = { type: "COMMAND_STARTED", title: `${say}…`, command: cmd, tool: name, detail: input.description ?? null, status: "running" };
        break;
      }
      case "TodoWrite": {
        const todos: any[] = Array.isArray(input.todos) ? input.todos : [];
        const cur = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
        kind = "status";
        ev = {
          type: "AGENT_STATUS",
          title: cur ? firstLine(cur.activeForm ?? cur.content, 80) : "Actualizando plan de trabajo",
          tool: name,
          status: "info",
          metadata: { todos: todos.map((t) => ({ content: t.content, status: t.status })) },
        };
        break;
      }
      default:
        if (name.startsWith("mcp__")) {
          const [, server, tool] = name.split("__");
          kind = "mcp";
          ev = { type: "TOOL_STARTED", title: `Consultando datos: ${server}${tool ? ` · ${tool}` : ""}`, tool: name, detail: JSON.stringify(input).slice(0, 600), status: "running", metadata: { mcp: true, server } };
          break;
        }
        ev = { type: "TOOL_STARTED", title: `Usando ${name}`, tool: name, detail: JSON.stringify(input).slice(0, 400), status: "running" };
    }
    this.tools.set(id, { name, input, kind });
    return [ev];
  }

  private toolEnd(id: string, content: unknown, isError: boolean): ExecutorEvent[] {
    const t = this.tools.get(id);
    this.tools.delete(id);
    const text = Array.isArray(content)
      ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n")
      : String(content ?? "");
    const status = isError ? "error" : "success";
    if (!t) return [];
    if (isError && /haven't granted|permission|not allowed|denied|requires approval/i.test(text)) {
      const what = t.name === "Bash" ? `\`${firstLine(String(t.input.command ?? ""), 50)}\`` : t.name;
      const label = `No tengo permiso para ${t.name === "Bash" ? "ejecutar" : "usar"} ${what} en esta tarea (solo lectura)`;
      const out: ExecutorEvent[] = [{ type: "AGENT_STATUS", title: label, tool: t.name, command: t.input.command ?? null, status: "warning" }];
      // Cierra el comando en la terminal sin reportarlo como prueba fallida.
      if (t.kind === "test" || t.kind === "command") out.push({ type: "COMMAND_FINISHED", title: "Bloqueado: la tarea es de solo lectura", command: String(t.input.command ?? ""), detail: clip(text, 800), status: "warning", metadata: { denied: true } });
      return out;
    }
    const file = rel(t.input.file_path ?? t.input.path, this.cwd);
    switch (t.kind) {
      case "read":
        return isError ? [{ type: "AGENT_STATUS", title: `No se pudo leer ${base(file)}`, detail: clip(text, 600), status: "warning" }] : [];
      case "search": {
        const n = text.split(/\r?\n/).filter(Boolean).length;
        return [{ type: "SEARCH_FINISHED", title: isError ? "La búsqueda no funcionó" : n ? `Encontró ${n} coincidencia${n === 1 ? "" : "s"}` : "Sin coincidencias", tool: t.name, detail: clip(text, 1500), status }];
      }
      case "edit":
        return [
          isError
            ? { type: "AGENT_STATUS", title: `No se pudo editar ${base(file)}`, file, detail: clip(text, 800), status: "warning" }
            : { type: "FILE_CHANGED", title: `Modificó ${base(file)}`, file, tool: t.name, status: "success" },
        ];
      case "test": {
        const cmd = String(t.input.command ?? "");
        return [
          { type: "TEST_OUTPUT", title: firstLine(summarizeOutput(text), 120) || "salida", command: cmd, detail: clip(text, 12000), status },
          { type: "TEST_FINISHED", title: isError ? "Algunas pruebas fallaron" : "Pruebas OK", command: cmd, status, detail: summarizeOutput(text) },
        ];
      }
      case "command": {
        const cmd = String(t.input.command ?? "");
        return [
          { type: "COMMAND_OUTPUT", title: firstLine(text, 120) || "(sin salida)", command: cmd, detail: clip(text, 12000), status },
          { type: "COMMAND_FINISHED", title: `${isError ? "No funcionó" : "Listo"}: ${describeCommand(cmd).replace(/^./, (x) => x.toLowerCase())}`, command: cmd, status },
        ];
      }
      case "status":
        return [];
      case "mcp":
        return [{ type: "TOOL_FINISHED", title: isError ? "La consulta de datos falló" : "Datos recibidos", tool: t.name, detail: clip(text, 3000), status, metadata: { mcp: true } }];
      default:
        return [{ type: "TOOL_FINISHED", title: `${t.name} ${isError ? "falló" : "listo"}`, tool: t.name, detail: clip(text, 1500), status }];
    }
  }
}
