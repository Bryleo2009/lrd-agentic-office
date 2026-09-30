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
