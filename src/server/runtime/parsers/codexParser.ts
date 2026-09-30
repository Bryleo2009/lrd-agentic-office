import type { ExecutorEvent } from "../AgentExecutor";
import { base, classifyCommand, clip, firstLine, rel, summarizeOutput, unwrapShell } from "./common";

/**
 * Parser desacoplado de `codex exec --json`.
 * Soporta:
 *  - Formato actual (thread/turn/item): thread.started, turn.started, item.started|updated|completed,
 *    turn.completed, turn.failed, error.
 *  - Formato legado ({ id, msg: { type: "exec_command_begin" | ... } }).
 * Los ítems `reasoning` / `agent_reasoning*` se descartan: no se expone razonamiento.
 */
export class CodexJsonParser {
  sessionId: string | null = null;
  finalText = "";
  lastAgentMessage = "";
  private cmdKinds = new Map<string, { kind: string; cmd: string }>();
  failed = false;

  constructor(readonly cwd: string) {}

  parseLine(line: string): ExecutorEvent[] {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return [];
    }
    if (o && typeof o === "object" && o.msg && typeof o.msg === "object") return this.legacy(o.msg);
    return this.current(o);
  }

  // ---------------- formato actual ----------------
  private current(o: any): ExecutorEvent[] {
    switch (o.type) {
      case "thread.started":
      case "session.created":
        this.sessionId = o.thread_id ?? o.session_id ?? this.sessionId;
        return [{ type: "SESSION_CONNECTED", title: "Codex conectado", status: "success", metadata: { cliSessionId: this.sessionId } }];
      case "turn.started":
        return [{ type: "AGENT_STATUS", title: "Trabajando…", status: "running" }];
      case "item.started":
        return this.item(o.item, "started");
      case "item.updated":
        return this.item(o.item, "updated");
      case "item.completed":
        return this.item(o.item, "completed");
      case "turn.completed":
        this.finalText = this.lastAgentMessage;
        return [
          {
            type: "AGENT_FINISHED",
            title: "Tarea completada",
            detail: clip(this.finalText, 6000),
            status: "success",
            metadata: { usage: o.usage, cliSessionId: this.sessionId },
            finalText: this.finalText,
          },
        ];
      case "turn.failed":
        this.failed = true;
        return [{ type: "AGENT_ERROR", title: "Codex falló", detail: String(o.error?.message ?? JSON.stringify(o.error ?? {})), status: "error", finalText: this.lastAgentMessage }];
      case "error":
        this.failed = true;
        return [{ type: "AGENT_ERROR", title: "Error de Codex", detail: String(o.message ?? line(o)), status: "error" }];
      default:
        return [];
    }
  }

  private item(item: any, phase: "started" | "updated" | "completed"): ExecutorEvent[] {
    if (!item) return [];
    const t: string = item.type ?? item.item_type ?? "";
    const id: string = item.id ?? "";
    switch (t) {
      case "reasoning":
        return [];
      case "agent_message":
      case "assistant_message": {
        if (phase !== "completed") return [];
        const text = String(item.text ?? "");
        if (!text.trim()) return [];
        this.lastAgentMessage = text;
        return [{ type: "AGENT_MESSAGE", title: firstLine(text), detail: clip(text, 6000), status: "info" }];
      }
      case "command_execution": {
        const cmd = unwrapShell(item.command ?? "");
        if (phase === "started") return this.cmdStart(id, cmd);
        if (phase === "completed") {
          const exit = item.exit_code ?? (item.status === "failed" ? 1 : 0);
          return this.cmdEnd(id, cmd, String(item.aggregated_output ?? item.output ?? ""), exit);
        }
        return [];
      }
      case "file_change": {
        if (phase !== "completed") {
          const f = item.changes?.[0]?.path;
          return phase === "started" && f
            ? [{ type: "TOOL_STARTED", title: `Editando ${base(f)}`, file: rel(f, this.cwd), tool: "apply_patch", status: "running", metadata: { edit: true } }]
            : [];
        }
        const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
        const ok = item.status !== "failed";
        return changes.map((c) => ({
          type: ok ? "FILE_CHANGED" : "AGENT_STATUS",
          title: ok ? `${kindLabel(c.kind)} ${base(c.path)}` : `No se pudo aplicar cambio en ${base(c.path)}`,
          file: rel(c.path, this.cwd),
          tool: "apply_patch",
          status: ok ? "success" : "warning",
          metadata: { kind: c.kind },
        })) as ExecutorEvent[];
      }
      case "mcp_tool_call": {
        const name = `${item.server ?? "mcp"}.${item.tool ?? "tool"}`;
        if (phase === "started") return [{ type: "TOOL_STARTED", title: `Consultando datos: ${item.server ?? "mcp"} · ${item.tool ?? ""}`, tool: name, detail: item.arguments ? clip(JSON.stringify(item.arguments), 600) : null, status: "running", metadata: { mcp: true, server: item.server } }];
        if (phase === "completed")
          return [{ type: "TOOL_FINISHED", title: item.status === "failed" ? "La consulta de datos falló" : "Datos recibidos", tool: name, detail: item.result ? clip(JSON.stringify(item.result), 3000) : item.error ? String(item.error.message ?? item.error) : null, status: item.status === "failed" ? "error" : "success", metadata: { mcp: true } }];
        return [];
      }
      case "web_search":
        return phase === "started" || phase === "completed"
          ? [{ type: phase === "started" ? "SEARCH_STARTED" : "SEARCH_FINISHED", title: `Buscando en web: ${firstLine(item.query ?? "", 60)}`, tool: "web_search", status: phase === "started" ? "running" : "success" }]
          : [];
      case "todo_list": {
        const items: any[] = Array.isArray(item.items) ? item.items : [];
        const cur = items.find((i) => !i.completed);
        return [{ type: "AGENT_STATUS", title: cur ? firstLine(cur.text, 80) : "Plan de trabajo completado", status: "info", metadata: { todos: items } }];
      }
      case "error":
        return [{ type: "AGENT_STATUS", title: "Aviso de Codex", detail: String(item.message ?? ""), status: "warning" }];
      default:
        return [];
    }
  }

  private cmdStart(id: string, cmd: string): ExecutorEvent[] {
    const c = classifyCommand(cmd);
    const kind = c.kind === "test" || c.kind === "build" ? "test" : c.kind;
    this.cmdKinds.set(id, { kind, cmd });
    if (kind === "test") return [{ type: "TEST_STARTED", title: `Ejecutando ${firstLine(cmd, 60)}`, command: cmd, status: "running" }];
    if (kind === "read") return [{ type: "FILE_READ", title: `Analizando ${base(c.file)}`, file: rel(c.file, this.cwd), command: cmd, status: "running" }];
    if (kind === "search") return [{ type: "SEARCH_STARTED", title: `Buscando: ${firstLine(cmd, 60)}`, command: cmd, status: "running" }];
    return [{ type: "COMMAND_STARTED", title: `$ ${firstLine(cmd, 70)}`, command: cmd, status: "running" }];
  }

  private cmdEnd(id: string, cmd: string, output: string, exit: number): ExecutorEvent[] {
    const k = this.cmdKinds.get(id) ?? { kind: classifyCommand(cmd).kind, cmd };
    this.cmdKinds.delete(id);
    cmd = cmd || k.cmd;
    const status = exit === 0 ? "success" : "error";
    const meta = { exitCode: exit };
    if (k.kind === "test" || k.kind === "build")
      return [
        { type: "TEST_OUTPUT", title: firstLine(summarizeOutput(output), 120) || "salida", command: cmd, detail: clip(output, 12000), status, metadata: meta },
        { type: "TEST_FINISHED", title: exit === 0 ? "Pruebas OK" : `Pruebas fallaron (exit ${exit})`, command: cmd, status, detail: summarizeOutput(output), metadata: meta },
      ];
    if (k.kind === "read") return exit === 0 ? [] : [{ type: "AGENT_STATUS", title: "Lectura fallida", command: cmd, detail: clip(output, 600), status: "warning" }];
    if (k.kind === "search") {
      const n = output.split(/\r?\n/).filter(Boolean).length;
      return [{ type: "SEARCH_FINISHED", title: `${n} resultados`, command: cmd, detail: clip(output, 1500), status: "success", metadata: meta }];
    }
    return [
      { type: "COMMAND_OUTPUT", title: firstLine(output, 120) || "(sin salida)", command: cmd, detail: clip(output, 12000), status, metadata: meta },
      { type: "COMMAND_FINISHED", title: `${exit === 0 ? "OK" : `exit ${exit}`}: ${firstLine(cmd, 60)}`, command: cmd, status, metadata: meta },
    ];
  }

  // ---------------- formato legado ----------------
  private legacy(m: any): ExecutorEvent[] {
    switch (m.type) {
      case "session_configured":
        this.sessionId = m.session_id ?? this.sessionId;
        return [{ type: "SESSION_CONNECTED", title: "Codex conectado", status: "success", metadata: { cliSessionId: this.sessionId, model: m.model } }];
      case "task_started":
        return [{ type: "AGENT_STATUS", title: "Trabajando…", status: "running" }];
      case "agent_message":
        this.lastAgentMessage = String(m.message ?? "");
        return this.lastAgentMessage.trim()
          ? [{ type: "AGENT_MESSAGE", title: firstLine(this.lastAgentMessage), detail: clip(this.lastAgentMessage, 6000), status: "info" }]
          : [];
      case "exec_command_begin":
        return this.cmdStart(m.call_id, unwrapShell(m.command ?? ""));
      case "exec_command_end":
        return this.cmdEnd(m.call_id, "", `${m.stdout ?? ""}${m.stderr ?? ""}` || String(m.formatted_output ?? m.aggregated_output ?? ""), m.exit_code ?? 0);
      case "patch_apply_begin": {
        const files = Object.keys(m.changes ?? {});
        return files.map((f) => ({ type: "TOOL_STARTED", title: `Editando ${base(f)}`, file: rel(f, this.cwd), tool: "apply_patch", status: "running", metadata: { edit: true } }) as ExecutorEvent);
      }
      case "patch_apply_end":
        return [{ type: m.success ? "FILE_CHANGED" : "AGENT_STATUS", title: m.success ? "Cambios aplicados" : "Patch rechazado", detail: clip(String(m.stdout ?? m.stderr ?? ""), 800), status: m.success ? "success" : "warning" }];
      case "mcp_tool_call_begin":
        return [{ type: "TOOL_STARTED", title: `Usando ${m.invocation?.tool ?? "herramienta"}`, tool: m.invocation?.tool, status: "running" }];
      case "mcp_tool_call_end":
        return [{ type: "TOOL_FINISHED", title: "Herramienta lista", status: "success" }];
      case "task_complete":
        this.finalText = String(m.last_agent_message ?? this.lastAgentMessage ?? "");
        return [{ type: "AGENT_FINISHED", title: "Tarea completada", detail: clip(this.finalText, 6000), status: "success", finalText: this.finalText }];
      case "error":
        this.failed = true;
        return [{ type: "AGENT_ERROR", title: "Error de Codex", detail: String(m.message ?? ""), status: "error" }];
      default:
        return []; // agent_reasoning*, token_count, etc.
    }
  }
}

function kindLabel(k: string | undefined): string {
  if (k === "add") return "Creó";
  if (k === "delete") return "Eliminó";
  return "Modificó";
}

function line(o: unknown): string {
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}
