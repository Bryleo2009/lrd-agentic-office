import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-safety-"));
Object.assign(process.env, {
  LRD_WORKSPACE_ROOT: path.join(root, "ws"),
  LRD_LESSONS_FILE: path.join(root, "lessons.json"),
  RETENTION_DAYS: "14",
});

test("preguntas: extrae PREGUNTA/OPCIONES y entiende respuestas naturales", async () => {
  const { extractQuestion, pickOption, questionKey } = await import("../src/server/missions/questions");
  const q = extractQuestion("Revisé el módulo.\n**PREGUNTA:** ¿Con IGV o sin IGV?\nOPCIONES: Con IGV | Sin IGV\nRESUMEN: falta un dato");
  assert.equal(q?.text, "¿Con IGV o sin IGV?");
  assert.deepEqual(q?.options, ["Con IGV", "Sin IGV"]);
  assert.doesNotMatch(q!.rest, /PREGUNTA|OPCIONES/);
  assert.equal(extractQuestion("Todo listo.\nRESUMEN: hecho"), null);
  assert.equal(questionKey("s1", "¿Con IGV?"), questionKey("s1", "¿con igv ?"));

  const opts = ["Aprobar: publicar en feature/x", "Mejor en una rama nueva agentic/…", "No publicar (dejar local)"];
  assert.equal(pickOption("Aprobar: publicar en feature/x", opts), 0);
  assert.equal(pickOption("sí, dale", opts), 0);
  assert.equal(pickOption("no", opts), 2);
  assert.equal(pickOption("mejor en una rama nueva", opts), 1);
  assert.equal(pickOption("mmm no sé", opts), -1);
  // En secretos una respuesta afirmativa ambigua nunca publica: "yes" apunta a "No publicar".
  const sec = ["Que Diego lo quite", "Es un falso positivo: publicar", "No publicar"];
  assert.equal(pickOption("sí", sec, 2), 2);
  assert.equal(pickOption("es un falso positivo", sec, 2), 1);
});

test("secretos: detecta claves y archivos de credenciales solo en líneas agregadas, sin falsos positivos comunes", async () => {
  const { scanSecrets, migrationFiles } = await import("../src/server/missions/secrets");
  const patch = [
    "diff --git a/src/aws.ts b/src/aws.ts",
    "--- a/src/aws.ts",
    "+++ b/src/aws.ts",
    "@@ -1,2 +1,4 @@",
    " const region = 'us-east-1';",
    "-const OLD = 'AKIAOLDOLDOLDOLDOLD1';",
    '+const key = "AKIAIOSFODNN7ABCDEFG";',
    "+const token = process.env.GITHUB_TOKEN;",
    '+const db_password = "S3cr3t!Pass";',
    "--- a/config/app.php",
    "+++ b/config/app.php",
    "@@ -10,0 +11,3 @@",
    "+'password' => env('DB_PASSWORD'),",
    "+'api_key' => 'changeme',",
    "+$url = 'mysql://lrd:SuperClave123@db.internal/lrd';",
  ].join("\n");
  const found = scanSecrets(patch, ["src/aws.ts", ".env", ".env.example", "certs/server.pem"]);
  const kinds = found.map((f) => `${f.file}:${f.line}:${f.kind}`);
  assert.ok(kinds.includes("src/aws.ts:2:AWS access key"), kinds.join("\n"));
  assert.ok(kinds.some((k) => k.startsWith("src/aws.ts:4:Valor literal en db_password")), kinds.join("\n"));
  assert.ok(kinds.some((k) => k.startsWith("config/app.php:13:Cadena de conexión")), kinds.join("\n"));
  assert.ok(kinds.includes(".env:null:Archivo de credenciales") && kinds.includes("certs/server.pem:null:Archivo de credenciales"));
  assert.ok(!kinds.some((k) => k.startsWith(".env.example")), ".env.example es válido");
  assert.ok(!kinds.some((k) => /OLD/.test(k)) && !found.some((f) => /AKIAOLD/.test(f.preview)), "las líneas borradas no cuentan");
  assert.ok(!kinds.some((k) => /:3:|:11:|:12:/.test(k)), `env()/process.env/changeme no son secretos: ${kinds.join(", ")}`);
  assert.ok(found.every((f) => !f.preview.includes("AKIAIOSFODNN7ABCDEFG") && !f.preview.includes("S3cr3t!Pass")), "nunca se muestra el valor completo");
  assert.deepEqual(migrationFiles(["app/Models/Order.php", "database/migrations/2026_01_01_x.php", "prisma/migrations/1/migration.sql", "docs/x.md"]), [
    "database/migrations/2026_01_01_x.php",
    "prisma/migrations/1/migration.sql",
  ]);
});

test("guías por tipo de tarea: corrección de CI y consulta de datos", async () => {
  const { taskKind, guideFor } = await import("../src/server/missions/guides");
  assert.equal(taskKind("valida el CI Frontend Quality #502 en Github y corrígelo", false), "ci-fix");
  assert.equal(taskKind("El build de GitHub Actions está en rojo, arréglalo", false), "ci-fix");
  assert.equal(taskKind("Dame info del pedido que termina en 201631", true), "data-lookup");
  assert.equal(taskKind("Implementa el filtro por origen", false), "general");
  assert.match(guideFor("ci-fix"), /Reproduce localmente[\s\S]*Nunca: desactivar/);
  assert.match(guideFor("data-lookup"), /`LIKE .%<lo que dio>%.` sobre el número de orden y el correlativo en `cabecera_ordens`/);
  assert.equal(guideFor("general"), "");
});

test("lecciones: se mide si sirven; las que no ayudan dejan de enviarse", async () => {
  const L = await import("../src/server/missions/lessons");
  const { lessonHealth } = await import("../src/shared/types");
  const good = L.addLesson("Para ubicar pedidos usa numero_orden y correlativo a la vez", "datos", "equipo")!;
  const bad = L.addLesson("La herramienta db.explain falla en este entorno; no la uses", "datos", "auto")!;
  for (const [i, ok] of [true, true, true].entries()) L.recordOutcome([good.id, bad.id], `M${i}`, ok);
  L.recordOutcome([good.id], "M0", true); // la misma misión no cuenta dos veces
  // La herramienta volvió a fallar en dos misiones aunque el equipo tenía la lección.
  L.addLesson("La herramienta db.explain falla en este entorno; no la uses", "datos", "auto", [bad.id]);
  L.addLesson("La herramienta db.explain falla en este entorno; no la uses", "datos", "auto", [bad.id]);
  // Que un agente repita una lección que recibió no es una repetición del problema.
  L.addLesson("Para ubicar pedidos usa numero_orden y correlativo a la vez", "datos", "equipo", [good.id]);
  const all = L.listLessons();
  const g = all.find((l) => l.id === good.id)!;
  const b = all.find((l) => l.id === bad.id)!;
  assert.equal(g.uses, 3);
  assert.equal(g.ok, 3);
  assert.equal(g.repeats ?? 0, 0);
  assert.equal(lessonHealth(g), "util");
  assert.equal(b.repeats, 2);
  assert.equal(lessonHealth(b), "no_sirve");
  const picked = L.pickLessons(["datos"]).map((l) => l.id);
  assert.ok(picked.includes(good.id) && !picked.includes(bad.id), "la que no sirve queda en pausa");
  L.recordCorrection([good.id], "M1");
  L.recordCorrection([good.id], "M1");
  assert.equal(L.listLessons().find((l) => l.id === good.id)!.corrected, 1, "una corrección por misión");
});

test("limpieza: borra worktrees y logs viejos, conserva lo que tiene cambios sin commit", async () => {
  const { paths } = await import("../src/server/config");
  const { cleanupOld } = await import("../src/server/maintenance");
  const old = new Date(Date.now() - 30 * 86_400_000);
  const mk = (p: string) => {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "f.txt"), "x".repeat(2048));
  };
  // Worktree viejo limpio, otro viejo con cambios sin commit, uno reciente y logs viejos.
  const clean = path.join(paths.worktrees, "OLD01", "back");
  const dirty = path.join(paths.worktrees, "OLD02", "back");
  const fresh = path.join(paths.worktrees, "NEW01", "back");
  for (const p of [clean, dirty, fresh]) mk(p);
  for (const p of [clean, dirty]) {
    execFileSync("git", ["init", "-q"], { cwd: p });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: p });
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: clean });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "y"], { cwd: clean });
  const runs = path.join(paths.runs, "OLD01");
  mk(runs);
  for (const p of [path.dirname(clean), path.dirname(dirty), runs]) fs.utimesSync(p, old, old);

  const preview = await cleanupOld({ dryRun: true, isActive: () => false });
  assert.equal(preview.dryRun, true);
  assert.ok(fs.existsSync(clean), "la vista previa no borra nada");
  assert.deepEqual(preview.removed.map((r) => `${r.kind}:${path.relative(paths.worktrees, r.path).startsWith("..") ? path.basename(r.path) : path.relative(paths.worktrees, r.path)}`).sort(), ["runs:OLD01", "worktree:OLD01/back"].sort());
  assert.deepEqual(preview.kept.map((k) => k.reason), ["tiene cambios sin commit"]);

  const done = await cleanupOld({ isActive: () => false });
  assert.equal(done.removed.length, 2);
  assert.ok(!fs.existsSync(path.dirname(clean)) && !fs.existsSync(runs), "se borró lo viejo");
  assert.ok(fs.existsSync(dirty) && fs.existsSync(fresh), "se conserva lo que tiene cambios y lo reciente");
  assert.equal((await cleanupOld({ isActive: () => false, days: 0 })).removed.length, 0, "RETENTION_DAYS=0 no limpia");
});

test("uso por motor: pasos, duración, límites alcanzados y misiones", async () => {
  const { sqlite } = await import("../src/server/database/db");
  const { usageMetrics } = await import("../src/server/metrics");
  const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  sqlite.prepare("INSERT INTO missions (id, prompt, repository_id, base_branch, engine, provider, area, status, questions, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("U1", "x", "lrd-back", "release/fase2", "auto", "codex", "backend", "done", JSON.stringify([{ kind: "question" }, { kind: "approval" }]), t(60), t(1));
  const step = sqlite.prepare("INSERT INTO mission_steps (id, mission_id, agent_id, title, task, depends_on, kind, status, provider, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  step.run("U1-s1", "U1", "diego", "a", "a", "[]", "agent", "done", "codex", t(50), t(40));
  step.run("U1-s2", "U1", "mica", "b", "b", "[]", "agent", "failed", "claude", t(30), t(25));
  step.run("U1-x", "U1", "atlas", "c", "c", "[]", "xreview", "done", "claude", t(20), t(19));
  sqlite.prepare("INSERT INTO runtime_events (id, timestamp, type, title, metadata) VALUES (?,?,?,?,?)").run("E1", t(45), "AGENT_STATUS", "Codex llegó a su límite", JSON.stringify({ engineSwitch: { from: "codex", to: "claude" } }));
  const m = usageMetrics(7);
  const codex = m.engines.find((e) => e.provider === "codex")!;
  const claude = m.engines.find((e) => e.provider === "claude")!;
  assert.deepEqual([codex.steps, codex.done, codex.minutes, codex.saturations, codex.missions], [1, 1, 10, 1, 1]);
  assert.deepEqual([claude.steps, claude.failed, claude.minutes, claude.byKind], [2, 1, 6, { agent: 1, xreview: 1 }]);
  assert.equal(m.missions.questions, 1);
  assert.equal(m.missions.approvals, 1);
});

test("un 404 / 'no encontrado' no se aprende como herramienta rota; si vuelve a funcionar se olvida", async () => {
  const L = await import("../src/server/missions/lessons");
  const notFound = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ success: false, error: "Backend lrd_query_production respondió 404 Not Found" }) }] });
  assert.equal(L.lessonFromToolFailure("mcp__lrd__lrd_order_get", notFound), null);
  assert.equal(L.lessonFromToolFailure("mcp__lrd__lrd_order_get", "La orden no existe"), null);
  const infra = L.lessonFromToolFailure("mcp__lrd__db_explain", "connect ECONNREFUSED 10.0.0.5:5432");
  assert.match(infra ?? "", /lrd\.db_explain falla[\s\S]*no concluyas que el dato no existe/);
  L.addLesson(infra!, "datos", "auto");
  assert.ok(L.listLessons().some((l) => l.text === infra));
  assert.equal(L.forgetToolFailures("mcp__lrd__db_explain"), 1, "respondió bien: se olvida");
  // Lecciones viejas que tomaron un 404 por herramienta rota se limpian al arrancar.
  L.addLesson('La herramienta lrd.lrd_order_get falla en este entorno ("Backend lrd_query_production respondió 404"). No la uses como paso previo; ve directo a la consulta que se necesita.', "datos", "auto");
  assert.equal(L.purgeMisreadToolLessons(), 1);
  assert.ok(!L.listLessons().some((l) => /lrd_order_get/.test(l.text)));
});

test("datos: se distingue Producción y QA, y 'no encontrado' en uno obliga a buscar en el otro", async () => {
  const { mcpEnv, mcpRules } = await import("../src/server/missions/MissionPlanner");
  assert.equal(mcpEnv("lrd_query_production"), "Producción");
  assert.equal(mcpEnv("lrd-qa"), "QA");
  assert.equal(mcpEnv("lrd_query_staging"), "QA");
  assert.equal(mcpEnv("lrd"), null);
  const both = mcpRules(["lrd_query_production", "lrd_query_qa"]);
  assert.match(both, /lrd_query_production = Producción, lrd_query_qa = QA/);
  assert.match(both, /primero en Producción y, si no aparece, en QA/);
  assert.match(both, /404[\s\S]*NO una herramienta rota/);
  assert.match(mcpRules(["lrd"]), /Producción y de QA \(por su nombre\)/);
});

test("LRD Connector (servidor 'lrd') + un MCP de QA registrado: 'lrd' se toma como Producción", async () => {
  const { mcpRules } = await import("../src/server/missions/MissionPlanner");
  assert.match(mcpRules(["lrd", "lrd-qa"]), /lrd = Producción, lrd-qa = QA/);
  const { guideFor } = await import("../src/server/missions/guides");
  assert.match(guideFor("data-lookup"), /SIEMPRE busca con `LIKE`[\s\S]*ORD-RDMI-260930123604[\s\S]*fecha de HOY[\s\S]*solo DESPUÉS, con el número completo/);
});

test("servidores MCP ocultos: se guardan en los ajustes y se pueden volver a mostrar", async () => {
  const S = await import("../src/server/settings");
  assert.deepEqual(S.setMcpHidden("lrd", true), ["lrd"]);
  assert.deepEqual(S.setMcpHidden("cua_repl", true), ["cua_repl", "lrd"]);
  assert.deepEqual(S.setMcpHidden("lrd", false), ["cua_repl"]);
  assert.deepEqual(S.hiddenMcp(), ["cua_repl"]);
});

test("biblioteca: guarda sin duplicar, busca sin tildes y trae lo relacionado", async () => {
  const lib = await import("../src/server/library");
  const a = lib.saveDoc({ kind: "manual", title: "Cómo se numeran las órdenes", body: "numero_orden lleva prefijo ORD-XXXX- y se busca con LIKE en cabecera_ordens", sourceKey: "t:1", repositoryId: "lrd-back" });
  const a2 = lib.saveDoc({ kind: "manual", title: "Cómo se numeran las órdenes (v2)", body: "numero_orden lleva prefijo ORD-XXXX-; buscar siempre con LIKE en cabecera_ordens", sourceKey: "t:1" });
  assert.equal(a2.id, a.id, "misma clave de origen: se actualiza");
  lib.saveDoc({ kind: "informe", title: "Filtro de origen en el front", body: "Se agregó un filtro por canal en la consola", missionId: "M1", repositoryId: "lrd-front" });
  assert.equal(lib.searchLibrary({ q: "ordenes" })[0].id, a.id, "sin tildes");
  assert.equal(lib.searchLibrary({ q: "", kind: "informe" }).length, 1);
  const rel = lib.relatedDocs("Busca la orden en cabecera_ordens por numero_orden", { repoIds: ["lrd-back"] });
  assert.equal(rel[0]?.id, a.id);
  assert.equal(lib.relatedDocs("Filtro de origen por canal", { excludeMissionId: "M1" }).length, 0, "no se consulta la propia misión");
  assert.match(lib.libraryPrompt(rel), /Documentación del equipo relacionada[\s\S]*\[Manual\] Cómo se numeran las órdenes \(v2\)/);
  assert.equal(lib.libraryCounts().manual, 1);
  assert.equal(lib.deleteDoc(a.id), true);
});

test("QA: variables del CI por repo, chequeo de la base de pruebas y fallas de entorno", async () => {
  const net = await import("node:net");
  const { qaEnvFor, qaPreflight, environmentProblem, failureLine, detectQa } = await import("../src/server/missions/qa");
  const repo = { id: "b", qaEnv: { APP_ENV: "testing", DB_HOST: "${CI_DB_HOST:-127.0.0.1}", DB_DATABASE: "${CI_DB_DATABASE:-lrd_ci}" } } as never;
  assert.deepEqual(qaEnvFor(repo, { CI_DB_HOST: "10.0.0.9" }), { APP_ENV: "testing", DB_HOST: "10.0.0.9", DB_DATABASE: "lrd_ci" });
  assert.equal(await qaPreflight({ DB_CONNECTION: "sqlite" }), null, "sqlite no necesita servidor");
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = String((srv.address() as { port: number }).port);
  assert.equal(await qaPreflight({ DB_CONNECTION: "mysql", DB_HOST: "127.0.0.1", DB_PORT: port }), null);
  srv.close();
  assert.match((await qaPreflight({ DB_CONNECTION: "mysql", DB_HOST: "127.0.0.1", DB_PORT: port, DB_DATABASE: "lrd_ci" }, 800)) ?? "", /no hay MySQL en 127\.0\.0\.1:\d+ .*lrd_ci/);
  assert.equal(environmentProblem("scripts/migrate-ci: line 4: APP_ENV: APP_ENV es obligatorio."), "faltan variables de entorno de QA");
  assert.equal(environmentProblem("SQLSTATE[HY000] [2002] Connection refused"), "no se pudo conectar a la base de datos de pruebas");
  assert.equal(environmentProblem("FAILED  Tests\\Feature\\OrderTest > crea la orden\nExpected 201, got 500"), null, "una prueba que falla sí es del código");
  assert.equal(failureLine("Running…\n  INFO  ok\nError: Call to undefined method Orden::embudo()\n   at app/Foo.php:12"), "Error: Call to undefined method Orden::embudo()");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-qa-"));
  fs.writeFileSync(path.join(wt, "artisan"), "");
  fs.writeFileSync(path.join(wt, "composer.json"), '{"require-dev":{"brianium/paratest":"^7"}}');
  fs.mkdirSync(path.join(wt, "vendor"));
  const base = { id: "b", qaStages: [["php artisan test"]] } as never;
  assert.deepEqual(detectQa(wt, base).commands, ["php artisan test --parallel"]);
  assert.deepEqual(detectQa(wt, { ...(base as object), qaParallelTests: false } as never).commands, ["php artisan test"], "como el CI: en serie");
});

test("chat: 'revierte', 'deshaz' y 'restaura' son pedidos de cambio (no de solo lectura)", async () => {
  const { asksChange } = await import("../src/server/missions/MissionPlanner");
  for (const t of ["revierte composer.json y composer.lock a HEAD", "Revierte tus cambios en composer.json", "deshaz lo de paratest", "restaura el composer.lock", "git restore composer.json"])
    assert.equal(asksChange(t), true, t);
  for (const t of ["¿por qué tocaste composer.json?", "explícame qué hiciste", "¿por qué se borra la orden?", "dime cuánto devuelve el total"]) assert.equal(asksChange(t), false, t);
});

test("tokens: se normaliza lo que informa cada motor y se suma por misión", async () => {
  const { normalizeUsage, addMissionUsage } = await import("../src/server/usage");
  const claude = normalizeUsage("claude", { usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 3000, output_tokens: 120 }, costUsd: 0.0123 });
  assert.deepEqual(claude, { input: 3510, cached: 3000, output: 120, calls: 1, costUsd: 0.0123 });
  const codex = normalizeUsage("codex", { usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 300 } });
  assert.deepEqual(codex, { input: 2000, cached: 1500, output: 300, calls: 1 });
  assert.equal(normalizeUsage("codex", { usage: {} }), null);
  const m = addMissionUsage(addMissionUsage(null, "claude", claude!), "codex", codex!);
  assert.deepEqual(m.total, { input: 5510, cached: 4500, output: 420, calls: 2, costUsd: 0.0123 });
  assert.equal(m.byProvider.codex?.input, 2000);
});

test("modelo por rol: por defecto lo potente solo para implementar y corregir", async () => {
  const { ENGINE_MODELS } = await import("../src/server/config");
  assert.equal(ENGINE_MODELS.claude.implement.model, null, "implementar: el modelo de tu cuenta");
  assert.equal(ENGINE_MODELS.claude.fix.model, null);
  for (const r of ["plan", "research", "review", "chat"] as const) assert.equal(ENGINE_MODELS.claude[r].model, "sonnet", r);
  assert.equal(ENGINE_MODELS.codex.review.effort, "medium");
  assert.equal(ENGINE_MODELS.codex.chat.effort, "low");
  assert.equal(ENGINE_MODELS.codex.implement.effort, null);
});
