import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeStreamParser } from "../src/server/runtime/parsers/claudeParser";
import { CodexJsonParser } from "../src/server/runtime/parsers/codexParser";
import { classifyCommand, unwrapShell } from "../src/server/runtime/parsers/common";
import { parsePlan, rulesPlan, inferArea, isAnalysisOnly } from "../src/server/missions/MissionPlanner";
import { MissionDagExecutor } from "../src/server/missions/MissionDagExecutor";
import type { MissionStep, RepositoryConfig } from "../src/shared/types";

const repo: RepositoryConfig = { id: "lrd-back", name: "lrd-back", github: "x/lrd-back", cloneUrl: "", shortName: "back", enabled: true, allowedBases: ["release/fase2"], defaultBase: "release/fase2", kind: "backend" };

test("parser Codex (formato thread/item) produce eventos observables y descarta razonamiento", () => {
  const p = new CodexJsonParser("/wt");
  const lines = [
    { type: "thread.started", thread_id: "th_123" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "r1", type: "reasoning", text: "pensamiento privado" } },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "bash -lc 'sed -n 1,200p app/Http/Controllers/RappiWebhookController.php'", status: "in_progress" } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "bash -lc 'sed -n 1,200p app/Http/Controllers/RappiWebhookController.php'", aggregated_output: "<?php", exit_code: 0, status: "completed" } },
    { type: "item.started", item: { id: "c2", type: "command_execution", command: "php artisan test --filter=RappiWebhookTest", status: "in_progress" } },
    { type: "item.completed", item: { id: "c2", type: "command_execution", command: "php artisan test --filter=RappiWebhookTest", aggregated_output: "PASS\nTests: 12 passed", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "/wt/app/Http/Controllers/RappiWebhookController.php", kind: "update" }], status: "completed" } },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Listo.\nRESUMEN: delivery_code viene en additional_data" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  const evs = lines.flatMap((l) => p.parseLine(JSON.stringify(l)));
  const types = evs.map((e) => e.type);
  assert.equal(p.sessionId, "th_123");
  assert.ok(types.includes("SESSION_CONNECTED"));
  assert.ok(types.includes("FILE_READ"));
  assert.ok(types.includes("TEST_STARTED") && types.includes("TEST_FINISHED"));
  assert.ok(types.includes("FILE_CHANGED"));
  assert.equal(evs.find((e) => e.type === "FILE_CHANGED")!.file, "app/Http/Controllers/RappiWebhookController.php");
  assert.equal(types[types.length - 1], "AGENT_FINISHED");
  assert.match(p.finalText, /RESUMEN/);
  assert.ok(!JSON.stringify(evs).includes("pensamiento privado"), "no debe exponer razonamiento");
});

test("parser Codex (formato legado msg)", () => {
  const p = new CodexJsonParser("/wt");
  const evs = [
    { id: "0", msg: { type: "session_configured", session_id: "s1", model: "gpt" } },
    { id: "1", msg: { type: "agent_reasoning", text: "secreto" } },
    { id: "2", msg: { type: "exec_command_begin", call_id: "a", command: ["bash", "-lc", "npm run build"] } },
    { id: "3", msg: { type: "exec_command_end", call_id: "a", stdout: "built in 2s", stderr: "", exit_code: 0 } },
    { id: "4", msg: { type: "task_complete", last_agent_message: "ok" } },
  ].flatMap((l) => p.parseLine(JSON.stringify(l)));
  assert.deepEqual(
    evs.map((e) => e.type),
    ["SESSION_CONNECTED", "TEST_STARTED", "TEST_OUTPUT", "TEST_FINISHED", "AGENT_FINISHED"],
  );
  assert.ok(!JSON.stringify(evs).includes("secreto"));
});

test("parser Claude stream-json", () => {
  const p = new ClaudeStreamParser("/wt");
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-1", model: "m", permissionMode: "acceptEdits" },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "oculto" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/wt/src/a.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/wt/src/a.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "Tests: 3 failed", is_error: true }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Hecho. RESUMEN: arreglé a.ts" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Hecho. RESUMEN: arreglé a.ts", session_id: "sess-1", num_turns: 4 },
  ];
  const evs = lines.flatMap((l) => p.parseLine(JSON.stringify(l)));
  const types = evs.map((e) => e.type);
  assert.deepEqual(types, ["SESSION_CONNECTED", "FILE_READ", "TOOL_STARTED", "FILE_CHANGED", "TEST_STARTED", "TEST_OUTPUT", "TEST_FINISHED", "AGENT_MESSAGE", "AGENT_FINISHED"]);
  assert.equal(evs.find((e) => e.type === "TEST_FINISHED")!.status, "error");
  assert.equal(p.sessionId, "sess-1");
  assert.ok(!JSON.stringify(evs).includes("oculto"));
});

test("clasificación de comandos", () => {
  assert.equal(unwrapShell(["bash", "-lc", "ls -la"]), "ls -la");
  assert.equal(classifyCommand("php artisan test").kind, "test");
  assert.equal(classifyCommand("npm run build").kind, "build");
  assert.deepEqual(classifyCommand("cat src/index.ts"), { kind: "read", file: "src/index.ts" });
  assert.equal(classifyCommand("rg delivery_code").kind, "search");
});

test("planner: parsea JSON del modelo, valida agentes y evita ciclos", () => {
  const txt = 'Plan:\n```json\n{"deliverable":"code_change","steps":[{"id":"s1","agent":"rafa","title":"Investigar","task":"x","dependsOn":[],"writes":false},{"id":"s2","agent":"nora","title":"DB","task":"y","dependsOn":[]},{"id":"s3","agent":"diego","title":"Fix","task":"z","dependsOn":["s1","s2"],"writes":true},{"id":"s4","agent":"vega","title":"QA","task":"q","dependsOn":["s3"]}]}\n```';
  const plan = parsePlan(txt, "corrige rappi")!;
  assert.equal(plan.steps.length, 3, "vega se descarta (QA lo agrega el sistema)");
  assert.deepEqual(plan.steps[2].dependsOn, ["s1", "s2"]);
  assert.equal(parsePlan('{"steps":[{"id":"a","agent":"diego","dependsOn":["b"]},{"id":"b","agent":"mica","dependsOn":["a"]}]}', "x"), null);
  assert.equal(inferArea("Revisa por qué Rappi no manda el código", repo), "rappi");
  assert.equal(inferArea("Valida el CI de lrd-front", repo), "qa");
  assert.ok(isAnalysisOnly("Analiza el checkout y dime por qué falla"));
  const rp = rulesPlan("Revisa por qué Rappi no está mandando el código de entrega, corrígelo", repo, "rappi");
  assert.deepEqual(rp.steps.map((s) => s.agent), ["rafa", "diego"]);
});

test("DAG ejecuta nodos independientes en paralelo y respeta dependencias", async () => {
  const mk = (id: string, deps: string[], writes = false): MissionStep => ({ id, missionId: "m", agentId: "diego", title: id, task: "", dependsOn: deps, writes, kind: "agent", status: "pending", provider: null, sessionId: null, result: null, error: null, startedAt: null, finishedAt: null });
  const steps = [mk("a", []), mk("b", []), mk("c", ["a", "b"], true), mk("d", ["c"])];
  const log: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const dag = new MissionDagExecutor(steps, {
    isCancelled: () => false,
    onSkip: () => undefined,
    run: async (s) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      log.push(`start:${s.id}`);
      s.status = "running";
      await new Promise((r) => setTimeout(r, 30));
      s.status = "done";
      log.push(`end:${s.id}`);
      concurrent--;
    },
  });
  const { failed } = await dag.execute();
  assert.equal(failed.length, 0);
  assert.equal(maxConcurrent, 2, "a y b en paralelo");
  assert.ok(log.indexOf("start:c") > log.indexOf("end:a") && log.indexOf("start:c") > log.indexOf("end:b"));
  assert.ok(log.indexOf("start:d") > log.indexOf("end:c"));
});

test("DAG omite dependientes de un nodo fallido", async () => {
  const mk = (id: string, deps: string[]): MissionStep => ({ id, missionId: "m", agentId: "diego", title: id, task: "", dependsOn: deps, writes: false, kind: "agent", status: "pending", provider: null, sessionId: null, result: null, error: null, startedAt: null, finishedAt: null });
  const steps = [mk("a", []), mk("b", ["a"])];
  const skipped: string[] = [];
  const dag = new MissionDagExecutor(steps, {
    isCancelled: () => false,
    onSkip: (s) => skipped.push(s.id),
    run: async (s) => {
      s.status = "failed";
    },
  });
  const { failed } = await dag.execute();
  assert.deepEqual(failed.map((f) => f.id), ["a"]);
  assert.deepEqual(skipped, ["b"]);
});
