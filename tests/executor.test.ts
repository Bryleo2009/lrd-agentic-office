import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CODEX_COMMAND = path.resolve("tests/fixtures/fake-codex.mjs");
process.env.LRD_WORKSPACE_ROOT = path.join(os.tmpdir(), `lrd-test-${process.pid}`);

test("Codex que falla al arrancar no tumba el servidor; se reintenta sin el override de la herramienta y la fuente de datos sigue bloqueada", async () => {
  const { CodexCliExecutor } = await import("../src/server/runtime/CodexCliExecutor");
  const ex = new CodexCliExecutor();
  const st = await ex.checkAvailability(true);
  assert.equal(st.authenticated, true);
  assert.deepEqual(st.mcpServers.map((m) => m.name), ["lrd", "node_repl"]);
  const session = await ex.startSession({ missionId: null, agentId: "diego", cwd: os.tmpdir(), permission: "read-only", runDir: path.join(process.env.LRD_WORKSPACE_ROOT!, "runs"), timeoutMs: 20000, mcpAllow: [] });
  const big = "x".repeat(300_000); // provoca EPIPE si el proceso muere antes de leer stdin
  const evs = [];
  for await (const e of ex.sendMessage(session, big)) evs.push(e);
  const types = evs.map((e) => e.type);
  assert.ok(types.includes("AGENT_STATUS"), "debe avisar del reintento");
  const fin = evs.find((e) => e.type === "AGENT_FINISHED");
  assert.ok(fin, `debe terminar bien: ${JSON.stringify(evs.map((e) => [e.type, e.title]))}`);
  assert.match(fin!.finalText ?? "", /lrdOff=true/, "lrd (datos) debe seguir desactivado");
  assert.match(fin!.finalText ?? "", /len=300000/);
});

async function runCodex(env: Record<string, string>) {
  Object.assign(process.env, env);
  const { CodexCliExecutor } = await import("../src/server/runtime/CodexCliExecutor");
  const ex = new CodexCliExecutor();
  await ex.checkAvailability(true);
  const session = await ex.startSession({ missionId: null, agentId: "rafa", cwd: os.tmpdir(), permission: "read-only", runDir: path.join(process.env.LRD_WORKSPACE_ROOT!, "runs"), timeoutMs: 20000, mcpAllow: [] });
  const evs = [];
  for await (const e of ex.sendMessage(session, "hola")) evs.push(e);
  for (const k of Object.keys(env)) delete process.env[k];
  return evs;
}

test("MCP definido solo en otra carpeta ('invalid transport'): se reintenta sin su override y responde", async () => {
  const evs = await runCodex({ FAKE_LRD_ONLY_IN: process.cwd() });
  const fin = evs.find((e) => e.type === "AGENT_FINISHED");
  assert.ok(fin, JSON.stringify(evs.map((e) => [e.type, e.title])));
  assert.ok(evs.some((e) => e.type === "AGENT_STATUS" && /lrd no está configurado para esta carpeta/.test(e.title)));
});

test("MCP de datos definido pero roto: no se relaja el bloqueo y el error se explica", async () => {
  const evs = await runCodex({ FAKE_LRD_BROKEN: "1" });
  assert.ok(!evs.some((e) => e.type === "AGENT_FINISHED"));
  const err = evs.find((e) => e.type === "AGENT_ERROR");
  assert.match(err!.title, /servidor MCP «lrd» está mal definido/);
  assert.match(err!.detail ?? "", /\[mcp_servers\.lrd\]/);
});

test("MCP aportado por un plugin (lrd-connector): se desactiva el plugin, no mcp_servers.lrd", async () => {
  const fs = await import("node:fs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.writeFileSync(path.join(home, "config.toml"), '[plugins."lrd-connector@personal"]\nenabled = true\n\n[plugins."browser@openai-bundled"]\nenabled = true\n\n[mcp_servers.node_repl]\ncommand = "x"\n');
  const evs = await runCodex({ FAKE_LRD_PLUGIN: "1", CODEX_HOME: home });
  const fin = evs.find((e) => e.type === "AGENT_FINISHED");
  assert.ok(fin, JSON.stringify(evs.map((e) => [e.type, e.title])));
  assert.match(fin!.finalText ?? "", /lrdOff=true/, "lrd debe seguir bloqueado (vía plugin)");
});
