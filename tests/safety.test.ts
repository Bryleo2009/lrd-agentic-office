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
  assert.match(guideFor("data-lookup"), /LIKE '%201631'/);
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
