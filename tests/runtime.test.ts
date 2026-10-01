import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeStreamParser } from "../src/server/runtime/parsers/claudeParser";
import { CodexJsonParser } from "../src/server/runtime/parsers/codexParser";
import { classifyCommand, unwrapShell } from "../src/server/runtime/parsers/common";
import { parsePlan, rulesPlan, inferArea, inferRepo, isAnalysisOnly, deliveryPrefs } from "../src/server/missions/MissionPlanner";
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

test("repo automático: elige por nombre, por tipo o sin repositorio para datos", () => {
  const repos: RepositoryConfig[] = [
    { ...repo, id: "lrd-back", name: "lrd-back", shortName: "back", kind: "backend" },
    { ...repo, id: "lrd-front", name: "lrd-front", shortName: "front", kind: "frontend" },
  ];
  assert.equal(inferRepo("Valida el CI de lrd-front y corrige el problema.", repos, false).id, "lrd-front");
  assert.equal(inferRepo("El botón del checkout se ve mal en mobile", repos, false).id, "lrd-front");
  assert.equal(inferRepo("Revisa por qué Rappi no manda el código de entrega", repos, false).id, "lrd-back");
  assert.equal(inferRepo("¿Cuántas ventas tuvimos ayer por canal? Dame el ticket promedio", repos, true).id, "none");
  assert.equal(inferRepo("¿Cuántas ventas tuvimos ayer por canal?", repos, false).id, "none");
});

test("parser: llamadas MCP se muestran como consultas de datos", () => {
  const c = new ClaudeStreamParser("/wt");
  const evs = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "m1", name: "mcp__prod-db__query", input: { sql: "SELECT 1" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m1", content: "[{\"n\":1}]" }] } },
  ].flatMap((l) => c.parseLine(JSON.stringify(l)));
  assert.equal(evs[0].title, "Consultando datos: prod-db · query");
  assert.equal(evs[1].type, "TOOL_FINISHED");
  const x = new CodexJsonParser("/wt");
  const e2 = x.parseLine(JSON.stringify({ type: "item.started", item: { id: "1", type: "mcp_tool_call", server: "prod", tool: "sql", status: "in_progress" } }));
  assert.equal((e2[0].metadata as any).mcp, true);
});

test("planner: decide Atlas (no las palabras); si planifica cambios, no se degradan a análisis", () => {
  const ai = JSON.stringify({ deliverable: "analysis", steps: [{ id: "s1", agent: "diego", title: "Corregir CI", task: "x", dependsOn: [], writes: true }] });
  const fix = parsePlan(ai, "Revisa el CI de fase3.1 y corrige los fallos");
  assert.equal(fix?.deliverable, "code_change");
  assert.equal(fix?.steps[0].writes, true);
  const review = JSON.stringify({ deliverable: "analysis", steps: [{ id: "s1", agent: "diego", title: "Revisar CI", task: "x", dependsOn: [], writes: false }] });
  assert.equal(parsePlan(review, "Revisa por qué falla el CI de fase3.1")?.deliverable, "analysis");
  // Aunque el texto diga "analiza", si Atlas entendió que hay que corregir, se corrige.
  const code = JSON.stringify({ deliverable: "code_change", delivery: { publish: true, directToBase: true }, steps: [{ id: "s1", agent: "diego", title: "Corregir", task: "x", dependsOn: [], writes: true }] });
  const p = parsePlan(code, "Analiza la rama feature/x; si no pasa por el embudo, corrígelo sobre la misma rama");
  assert.equal(p?.steps[0].writes, true);
  assert.deepEqual(p?.delivery, { publish: true, directToBase: true }, "cómo entregar lo decide Atlas");
});

test("entrega: por defecto rama nueva publicada; la misión puede pedir lo contrario", () => {
  assert.deepEqual(deliveryPrefs("Corrige el CI de fase3.1"), { publish: true, directToBase: false });
  assert.equal(deliveryPrefs("Corrige el CI pero no publiques la rama").publish, false);
  assert.equal(deliveryPrefs("Arregla el bug, solo local").publish, false);
  assert.equal(deliveryPrefs("Corrige esto directamente en la rama base").directToBase, true);
  assert.equal(deliveryPrefs("Corrige esto sin crear rama").directToBase, true);
});

test("errores de Codex/Claude se explican en lenguaje claro", async () => {
  const { explainCliFailure, commandExitReason } = await import("../src/server/runtime/humanize");
  const silent = explainCliFailure("codex", 1, "");
  assert.match(silent.title, /Codex se cerró sin explicar/);
  assert.match(silent.hint, /codex login/);
  assert.match(explainCliFailure("codex", 1, "Error: Not logged in").title, /no tiene la sesión iniciada/);
  assert.match(explainCliFailure("codex", 1, "stream error: 429 Too Many Requests").title, /límite de uso/);
  assert.match(explainCliFailure("claude", 1, "getaddrinfo ENOTFOUND api.anthropic.com").title, /conexión/);
  const other = explainCliFailure("codex", 1, "boom\nsomething weird happened");
  assert.match(other.hint, /something weird happened/);
  assert.equal(commandExitReason(127), "el comando no existe en esta máquina");
});

test("config.toml de Codex: distingue MCP propios de los aportados por plugins", async () => {
  const { parseCodexConfig, pluginForServer } = await import("../src/server/runtime/codexConfig");
  const cfg = parseCodexConfig(`model = "x"\n[plugins."lrd-connector@personal"]\nenabled = true\n[plugins."pdf@openai-primary-runtime"]\nenabled = true\n[plugins."old@x"]\nenabled = false\n[mcp_servers.node_repl]\ncommand = 'C:\\\\x'\n[mcp_servers.node_repl.env]\nA = "1"\n`);
  assert.deepEqual(cfg.mcpServers, ["node_repl"]);
  assert.deepEqual(cfg.enabledPlugins, ["lrd-connector@personal", "pdf@openai-primary-runtime"]);
  assert.equal(pluginForServer("lrd", cfg), "lrd-connector@personal");
  assert.equal(pluginForServer("rappi", cfg), null);
});

test("planificador multi-repo: cada paso queda en su repo y 'front y back' elige ambos", () => {
  const back = { ...repo, id: "lrd-back", kind: "backend" as const };
  const front = { ...repo, id: "lrd-front", name: "lrd-front", shortName: "front", kind: "frontend" as const };
  const plan = parsePlan(
    JSON.stringify({ deliverable: "code_change", steps: [
      { id: "s1", agent: "diego", title: "API", task: "x", dependsOn: [], writes: true, repo: "lrd-back" },
      { id: "s2", agent: "mica", title: "UI", task: "x", dependsOn: [], writes: true },
    ] }),
    "Implementa el endpoint y la pantalla",
    [back, front],
  );
  assert.deepEqual(plan?.steps.map((s) => s.repo), ["lrd-back", "lrd-front"]);
  const rules = rulesPlan("Implementa el endpoint y la pantalla", back, "backend", [back, front]);
  assert.deepEqual(rules.steps.map((s) => [s.agent, s.repo, s.dependsOn.length]), [["diego", "lrd-back", 0], ["mica", "lrd-front", 0]]);
  assert.equal(inferRepo("agrega el campo en la api y muéstralo en la pantalla", [back, front], false).id, "lrd-back+lrd-front");
});

test("DAG: pasos que editan repos distintos corren en paralelo; en el mismo repo, de a uno", async () => {
  const mk = (id: string, repositoryId: string): MissionStep => ({ id, missionId: "M", agentId: "diego", title: id, task: "", dependsOn: [], writes: true, kind: "agent", status: "pending", provider: null, sessionId: null, result: null, error: null, startedAt: null, finishedAt: null, repositoryId });
  const steps = [mk("a", "back"), mk("b", "front"), mk("c", "back")];
  const spans: Record<string, [number, number]> = {};
  const dag = new MissionDagExecutor(steps, {
    isCancelled: () => false,
    onSkip: () => undefined,
    run: async (s) => {
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 120));
      spans[s.id] = [t0, Date.now()];
      s.status = "done";
    },
  });
  await dag.execute();
  const overlap = (x: string, y: string) => spans[x][0] < spans[y][1] && spans[y][0] < spans[x][1];
  assert.ok(overlap("a", "b"), "back y front a la vez");
  assert.ok(!overlap("a", "c"), "dos ediciones del mismo repo no se pisan");
});

test("QA por etapas y bash de Git en Windows", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { detectQa, resolveShellCommand } = await import("../src/server/missions/qa");
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "qa-"));
  fs.writeFileSync(path.join(wt, "composer.json"), '{"require-dev":{"brianium/paratest":"^7"}}');
  fs.mkdirSync(path.join(wt, "vendor"));
  const plan = detectQa(wt, { ...repo, qaStages: [["composer validate --strict", "bash scripts/pint-changed"], ["bash scripts/migrate-ci"], ["php artisan test"]] });
  assert.deepEqual(plan.stages, [["composer validate --strict", "bash scripts/pint-changed"], ["bash scripts/migrate-ci"], ["php artisan test --parallel"]]);
  assert.equal(plan.commands.length, 4);

  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(resolveShellCommand("bash scripts/check-backend", "win32", (p) => p === gitBash), `"${gitBash}" scripts/check-backend`);
  assert.equal(resolveShellCommand("bash scripts/check-backend", "linux"), "bash scripts/check-backend");
  assert.equal(resolveShellCommand("npm run build", "win32", () => true), "npm run build");
});

test("consulta rápida: el ejemplo real no elige repo ni planifica; lo que cambia código sí", async () => {
  const { isQuickLookup } = await import("../src/server/missions/MissionPlanner");
  const q = "Dame infor sobre el pedido que termina en 201631";
  assert.equal(isQuickLookup(q), true);
  assert.equal(inferRepo(q, [repo], true).id, "none");
  assert.equal(isQuickLookup("¿Cuántas boletas se emitieron hoy?"), true);
  assert.equal(isQuickLookup("Corrige el cálculo del pedido 201631"), false);
  assert.equal(isQuickLookup("Revisa por qué falla el CI de fase3.1"), false);
});

test("memoria: extrae LECCIÓN, limpia datos personales, refuerza duplicadas y entiende el error MCP real", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.LRD_LESSONS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lessons-")), "lessons.json");
  const L = await import("../src/server/missions/lessons");
  const { lessons, rest } = L.extractLessons("Todo bien.\nLECCIÓN: usa numero_orden para buscar pedidos\nRESUMEN: ok");
  assert.deepEqual(lessons, ["usa numero_orden para buscar pedidos"]);
  assert.equal(rest, "Todo bien.\nRESUMEN: ok");
  assert.equal(L.sanitizeLesson("escribe a juan.perez@correo.com o al +51 987 654 321"), "escribe a [correo] o al [número]");

  const a = L.addLesson("Usa numero_orden para buscar pedidos", "datos", "equipo")!;
  const b = L.addLesson("usa numero_orden para buscar pedidos", "datos", "equipo")!;
  assert.equal(a.id, b.id);
  assert.equal(b.hits, 2);
  assert.match(L.lessonsFor(["datos"]), /numero_orden/);
  assert.equal(L.lessonsFor(["lrd-front"]), "");

  // Payload tal cual llegó en la misión real
  const payload = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ success: false, error: "Faltan credenciales para LRD Back Producción. Configure LRD_PROD_EMAIL, LRD_PROD_PASSWORD y LRD_PROD_RECAPTCHA_TOKEN." }) }], structured_content: null });
  const t = L.lessonFromToolFailure("lrd.lrd_auth_check", payload)!;
  assert.match(t, /lrd\.lrd_auth_check falla en este entorno \("Faltan credenciales/);
  assert.ok(L.deleteLesson(a.id));
});

test("misión real: respeta repo, rama base y nombre de rama pedidos en el texto (y las prohibiciones)", async () => {
  const fs = await import("node:fs");
  const { inferBase, requestedBranch } = await import("../src/server/missions/MissionPlanner");
  const text = fs.readFileSync("tests/fixtures/mision-console-origin.txt", "utf8");
  const bases = ["release/fase2", "release/fase3.1", "main"];
  const back = { ...repo, id: "lrd-back", name: "lrd-back", github: "Bryleo2009/lrd-back", kind: "backend" as const, allowedBases: bases };
  const front = { ...repo, id: "lrd-front", name: "lrd-front", github: "Bryleo2009/lrd-front", shortName: "front", kind: "frontend" as const, allowedBases: bases };
  const pick = inferRepo(text, [back, front], true);
  assert.equal(pick.id, "lrd-front", "'No tocar lrd-back' no puede elegir lrd-back");
  assert.match(pick.reason, /prohíbe lrd-back/);
  assert.equal(inferBase(text, front), "release/fase3.1", "'No uses release/fase2' + 'Parte desde release/fase3.1'");
  assert.equal(requestedBranch(text), "agentic/feature/console-origin-filter");

  assert.equal(inferBase("Arregla el login", front), null, "sin pistas: la del repo");
  assert.equal(requestedBranch("crea la rama feature/x"), null, "solo ramas agentic/");
  assert.equal(inferRepo("No toques lrd-front; el bug está en la API", [back, front], false).id, "lrd-back");
});

test("errores de git al publicar: se explica la causa real", async () => {
  const { explainGitError } = await import("../src/server/runtime/humanize");
  assert.match(explainGitError("git push falló", " ! [rejected] x -> x (fetch first)\nerror: failed to push some refs").title, /rama remota tiene commits/);
  assert.match(explainGitError("git push falló", "husky - pre-push hook exited with code 1 (error)\nlint failed").title, /hook de git/);
  assert.match(explainGitError("git push falló", "git@github.com: Permission denied (publickey).").title, /credenciales/);
  assert.match(explainGitError("git push falló", "remote: error: GH006: Protected branch update failed").title, /protegida/);
});

test("misión sobre un run de CI o una rama existente: detecta cuál", async () => {
  const { ciRunRef, mentionedBranches } = await import("../src/server/missions/MissionPlanner");
  const q = "que opinas de.. la tarea fue valida el CI Frontend Quality feat: add SalonCheckoutDrawer component for managing salon payments #502 en Github y corrigelo";
  assert.deepEqual(ciRunRef(q), { runNumber: 502, workflowHint: "Frontend Quality" });
  assert.equal(ciRunRef("revisa https://github.com/o/r/actions/runs/36759211138 y corrige")?.runId, 36759211138);
  assert.equal(ciRunRef("agrega el filtro #3 a la consola"), null, "un # sin contexto de CI no es un run");
  assert.deepEqual(mentionedBranches("Corrige el lint en la rama `feature/venta-salon-configuracion-mesas`"), ["feature/venta-salon-configuracion-mesas"]);
  assert.deepEqual(mentionedBranches("No toques feature/vieja; crea agentic/feature/nueva"), []);
});

test("'en la misma rama' / 'directos en esa rama' = entregar directo en la rama base", async () => {
  const { deliveryPrefs } = await import("../src/server/missions/MissionPlanner");
  assert.equal(deliveryPrefs("Corrige el CI Frontend Quality #502 en la misma rama").directToBase, true);
  assert.equal(deliveryPrefs("pero te dije que hagas los cambios directos en esa rama").directToBase, true);
  assert.equal(deliveryPrefs("Corrige esto directamente en la rama base").directToBase, true);
  assert.equal(deliveryPrefs("Crea una nueva rama a partir de release/fase3.1").directToBase, false);
  assert.equal(deliveryPrefs("Trabaja en la rama feature/x y crea agentic/feature/y").directToBase, false);
  // Frases equivalentes
  for (const yes of [
    "arreglalo en la misma branch",
    "súbelo a esa rama",
    "no crees otra rama, hazlo ahí",
    "sin una rama nueva",
    "no abras una rama aparte",
    "haz commit en la rama base",
    "corrígelo en la rama que falla",
    "aplica el fix en la rama del CI",
    "push directo a la rama",
    "fix it on the same branch",
    "commit directly to the feature branch",
    "don't create a new branch",
  ])
    assert.equal(deliveryPrefs(yes).directToBase, true, yes);
  for (const no of ["no lo hagas en la misma rama", "no uses esa rama, crea agentic/feature/x", "trabaja en la rama feature/x", "revisa el CI de la rama feature/x"])
    assert.equal(deliveryPrefs(no).directToBase, false, no);
});

test("checklist: se extrae de la misión y se marca HECHO / VERIFICADO / PENDIENTE", async () => {
  const fs = await import("node:fs");
  const { extractChecklist, makeChecklist, applyChecklistMarks } = await import("../src/server/missions/checklist");
  const items = makeChecklist(extractChecklist(fs.readFileSync("tests/fixtures/mision-console-origin.txt", "utf8")));
  assert.ok(items.some((i) => /No modificar backend/.test(i.text)));
  assert.ok(items.some((i) => /Verifica que la rama base actual sea/.test(i.text)));
  assert.ok(!items.some((i) => /release\/fase3\.1$/.test(i.text.trim())), "no toma líneas de bloques de código");

  let cl = makeChecklist(["Filtro por origen", "Badge OTRO para null", "Pruebas de normalización"]);
  let r = applyChecklistMarks(cl, "Hecho.\nHECHO: 1, 2\nRESUMEN: ok", "mica");
  assert.equal(r.rest, "Hecho.\nRESUMEN: ok");
  assert.deepEqual(r.items.map((i) => i.status), ["done", "done", "pending"]);
  r = applyChecklistMarks(r.items, "VERIFICADO: 1\nPENDIENTE: 2 — no cubre valores vacíos\nPENDIENTE: 3 — faltan pruebas", "atlas");
  assert.deepEqual(r.items.map((i) => [i.status, i.how]), [["done", "verificado"], ["failed", "pendiente"], ["failed", "pendiente"]]);
  assert.equal(r.items[1].note, "no cubre valores vacíos");
  cl = applyChecklistMarks(r.items, "HECHO: 2", "mica").items;
  assert.equal(cl[1].status, "failed", "un HECHO no borra un PENDIENTE de la revisión");
  assert.equal(applyChecklistMarks(cl, "VERIFICADO: 2", "atlas").items[1].status, "done");
});

test("comandos en palabras: desenvuelve pwsh/cmd de Windows y describe qué hacen", async () => {
  const { describeCommand, unwrapShell } = await import("../src/server/runtime/parsers/common");
  const pw = '"C:\\Users\\bryle\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "git status --short"';
  assert.equal(unwrapShell(pw), "git status --short");
  assert.equal(describeCommand(pw), "Revisando qué archivos cambiaron");
  assert.equal(describeCommand('pwsh.exe -NoProfile -Command "Get-Content -Path src/views/Console.vue | Select-Object -First 80"'), "Leyendo Console.vue");
  assert.equal(describeCommand(`rg -n 'shouldOfferStockOverride' src`), "Buscando «shouldOfferStockOverride»");
  assert.equal(describeCommand('cmd.exe /d /s /c "npm run lint:check"'), "Pasando el linter");
  assert.equal(describeCommand("cd front && npm run type-check"), "Verificando los tipos");
  assert.equal(describeCommand("bash scripts/check-backend"), "Corriendo el chequeo completo del back");
  // Así llega en Windows: pwsh con el preámbulo $ErrorActionPreference y comillas encadenadas '"'"'.
  const codexWin = `"C:\\Users\\bryle\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command '$ErrorActionPreference='"'"'Stop'"'"'; rg -n "embudo" src'`;
  assert.equal(unwrapShell(codexWin), `$ErrorActionPreference='Stop'; rg -n "embudo" src`);
  assert.equal(describeCommand(codexWin), "Buscando «embudo»");
  assert.equal(describeCommand(`pwsh -Command '$ErrorActionPreference='"'"'Stop'"'"'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Raw '"'"'C:\\x\\SKILL.md'"'"''`), "Leyendo SKILL.md");
  assert.equal(describeCommand(`pwsh -Command "$ErrorActionPreference='Stop'; git status --short"`), "Revisando qué archivos cambiaron");
});
