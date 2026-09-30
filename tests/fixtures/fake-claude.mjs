#!/usr/bin/env node
// Claude Code falso: reutiliza el comportamiento del Codex falso de equipo y lo emite en formato stream-json de Claude.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (a.includes("--help")) { console.log("--print -p --output-format stream-json --verbose --session-id --resume --permission-mode --allowedTools --disallowedTools --append-system-prompt --strict-mcp-config Commands: auth mcp"); process.exit(0); }
if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
if (a[0] === "mcp") { console.log("No MCP servers configured."); process.exit(0); }

const core = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-codex-team.mjs");
const child = spawn(process.execPath, [core, "exec", "--json", "-"], { cwd: process.cwd(), env: { ...process.env, FAKE_ENGINE: "claude" }, stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
let out = "";
child.stdout.on("data", (d) => (out += d));
child.on("close", (code) => {
  const sid = `s_${process.pid}`;
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
  let text = "";
  let error = null;
  for (const line of out.split("\n").filter(Boolean)) {
    const o = JSON.parse(line);
    if (o.type === "item.completed" && o.item?.type === "agent_message") text = o.item.text;
    if (o.type === "error") error = o.message;
  }
  if (error) {
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: `Claude AI usage limit reached. ${error}`, session_id: sid }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: sid }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid }));
  process.exit(code ?? 0);
});
