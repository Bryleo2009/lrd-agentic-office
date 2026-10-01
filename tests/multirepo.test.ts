import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Entorno aislado: dos repos git reales (back y front) con remotos locales y un Codex falso de equipo.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-multi-"));
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
function makeRepo(name: string, pkg: object): string {
  const bare = path.join(root, `${name}.git`);
  git(["init", "-q", "--bare", bare], root);
  const seed = path.join(root, `${name}-seed`);
  git(["clone", "-q", bare, seed], root);
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify(pkg));
  fs.mkdirSync(path.join(seed, "node_modules")); // evita el "npm install" del setup de QA
  fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules\n");
  git(["add", "-A"], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], seed);
  git(["push", "-q", "origin", "HEAD:refs/heads/release/fase2"], seed);
  git(["push", "-q", "origin", "HEAD:refs/heads/release/fase3.1"], seed);
  git(["push", "-q", "origin", "HEAD:refs/heads/feature/venta-salon"], seed);
  return bare;
}
// Cada script de QA deja constancia de cuándo corrió, para comprobar que van en paralelo.
const qaLog = path.join(root, "qa.log");
const slow = (tag: string) => `node -e "const t=Date.now();setTimeout(()=>{require('fs').appendFileSync(process.env.QA_LOG, JSON.stringify({tag:'${tag}',start:t,end:Date.now()})+'\\\\n')},1200)"`;
const back = makeRepo("lrd-back", { name: "back", scripts: { build: slow("build"), test: slow("test") } });
const front = makeRepo("lrd-front", { name: "front", scripts: { build: slow("front-build") } });
const api = makeRepo("lrd-api", { name: "api" });
fs.writeFileSync(
  path.join(root, "repos.json"),
  JSON.stringify({
    repositories: [
      { id: "lrd-back", name: "lrd-back", github: "x/lrd-back", cloneUrl: back, shortName: "back", kind: "backend", enabled: true, allowedBases: ["release/fase2", "release/fase3.1"], defaultBase: "release/fase2",
        qaStages: [["npm run build", "npm test"], [slow("after")]] },
      { id: "lrd-front", name: "lrd-front", github: "x/lrd-front", cloneUrl: front, shortName: "front", kind: "frontend", enabled: true, allowedBases: ["release/fase2"], defaultBase: "release/fase2" },
      // QA como el de lrd-back: variables del CI y una base MySQL de pruebas (aquí no hay ninguna escuchando).
      { id: "lrd-api", name: "lrd-api", github: "x/lrd-api", cloneUrl: api, shortName: "api", kind: "backend", enabled: true, allowedBases: ["release/fase2"], defaultBase: "release/fase2",
        qaEnv: { APP_ENV: "testing", DB_CONNECTION: "${QA_TEST_DB:-mysql}", DB_HOST: "127.0.0.1", DB_PORT: "1", DB_DATABASE: "lrd_ci" },
        qaStages: [[`node -e "process.exit(process.env.APP_ENV ? 0 : (console.error('APP_ENV es obligatorio.'), 1))"`]] },
    ],
    protectedBranches: ["main", "release/fase2"],
  }),
);
const timeline = path.join(root, "timeline.log");
Object.assign(process.env, {
  LRD_WORKSPACE_ROOT: path.join(root, "ws"),
  LRD_REPOS_FILE: path.join(root, "repos.json"),
  CODEX_COMMAND: path.resolve("tests/fixtures/fake-codex-team.mjs"),
  CLAUDE_ENABLED: "false",
  AI_ENGINE_DEFAULT: "codex",
  VISUAL_PACING_MS: "0",
  GITHUB_PUSH_ENABLED: "true",
  GITHUB_PR_ENABLED: "false",
  QA_PARALLEL: "3",
  FAKE_TIMELINE: timeline,
  QA_LOG: qaLog,
  CODEX_HOME: path.join(root, "codex-home"),
  GH_COMMAND: path.resolve("tests/fixtures/fake-gh.mjs"),
  FAKE_GH_REPOS: JSON.stringify({ "x/lrd-back": back, "x/lrd-front": front, "x/lrd-api": api }),
  CI_POLL_SEC: "1",
  CI_APPEAR_SEC: "2",
});

test("misión back + front: Diego y Mica en paralelo, QA en carriles paralelos, una rama publicada por repo", { timeout: 90_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const m0 = await orchestrator.createMission({ prompt: "Implementa los totales: endpoint en la API y pantalla en el front", repositoryId: "lrd-back+lrd-front", engine: "codex" });
  assert.equal(m0.repos.length, 2);

  let m = m0;
  for (let i = 0; i < 300 && !["done", "failed", "cancelled"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(m0.id)!;
  }
  assert.equal(m.status, "done", `estado ${m.status}: ${m.error}`);

  // Diego (back) y Mica (front) trabajaron a la vez, cada uno en su repo.
  const t = fs.readFileSync(timeline, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const b = t.find((x) => x.who === "back");
  const f = t.find((x) => x.who === "front");
  assert.ok(b && f, "ambos trabajaron");
  assert.ok(b.start < f.end && f.start < b.end, "sus trabajos se solaparon en el tiempo (paralelo)");
  assert.notEqual(b.cwd, f.cwd, "cada uno en su propio worktree");

  // QA: los dos comandos del back corrieron a la vez, y el front en paralelo con el back.
  const q = fs.readFileSync(qaLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const qb = q.find((x) => x.tag === "build")!;
  const qt = q.find((x) => x.tag === "test")!;
  assert.ok(qb && qt && qb.start < qt.end && qt.start < qb.end, "build y test del back en paralelo");
  const qa2 = q.find((x) => x.tag === "after")!;
  assert.ok(qa2 && qa2.start >= Math.max(qb.end, qt.end) - 50, "la etapa 2 empieza cuando termina la etapa 1");

  // Una rama publicada en cada repositorio.
  assert.equal(m.repos.filter((r) => r.pushed && r.branch?.startsWith("agentic/")).length, 2);
  for (const bare of [back, front]) assert.match(git(["branch", "--list", "agentic/*"], bare), /agentic\//);
  // Checklist visible: lo marcan los desarrolladores (HECHO) y lo confirma la revisión (VERIFICADO).
  assert.deepEqual(m.checklist.map((i) => [i.text, i.status, i.how]), [["Endpoint GET /api/totales", "done", "verificado"], ["Pantalla de totales en el front", "done", "verificado"]]);
  assert.doesNotMatch(m.summary ?? "", /VERIFICADO:|HECHO:/, "las marcas no ensucian el resumen");
  const steps = m.steps.map((s) => `${s.kind}:${s.agentId}:${s.repositoryId ?? "-"}`);
  assert.ok(steps.includes("qa:vega:lrd-back") && steps.includes("qa:vega:lrd-front"), steps.join(", "));
});

test("misión de un solo repo sigue igual: una rama, un QA, sin lista de repos", { timeout: 90_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const m0 = await orchestrator.createMission({ prompt: "Implementa los totales en la API", repositoryId: "lrd-back", engine: "codex" });
  let m = m0;
  for (let i = 0; i < 300 && !["done", "failed", "cancelled"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(m0.id)!;
  }
  assert.equal(m.status, "done", `estado ${m.status}: ${m.error}`);
  assert.equal(m.repos.length, 0);
  assert.ok(m.branch?.startsWith("agentic/") && m.pushed && m.commitSha);
  assert.equal(m.steps.filter((s) => s.kind === "qa").length, 1);
});

test("consulta rápida de datos: un agente, sin plan ni reunión; aprende y la siguiente ya usa la lección", { timeout: 60_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const L = await import("../src/server/missions/lessons");
  process.env.FAKE_CALLS = path.join(root, "quick-calls.log");
  const wait = async (id: string) => {
    let m = repo.getMission(id)!;
    for (let i = 0; i < 200 && !["done", "failed"].includes(m.status); i++) {
      await new Promise((r) => setTimeout(r, 150));
      m = repo.getMission(id)!;
    }
    return m;
  };
  const m = await wait((await orchestrator.createMission({ prompt: "Dame info sobre el pedido que termina en 201631", repositoryId: "auto", engine: "codex" })).id);
  assert.equal(m.status, "done", m.error ?? "");
  assert.equal(m.repositoryId, "none");
  assert.deepEqual(m.steps.map((s) => s.kind), ["agent"], "sin plan ni revisión");
  assert.match(m.summary ?? "", /entregado/);
  assert.doesNotMatch(m.summary ?? "", /LECCIÓN/);
  assert.ok(L.listLessons().some((l) => /numero_orden/.test(l.text)), "la lección quedó guardada");

  await wait((await orchestrator.createMission({ prompt: "Dame info sobre el pedido que termina en 201632", repositoryId: "auto", engine: "codex" })).id);
  const calls = fs.readFileSync(process.env.FAKE_CALLS!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.filter((c) => c.kind === "plan").length, 0, "nunca pasó por la planificación");
  assert.equal(calls.filter((c) => c.kind === "quick").at(-1).knowsLesson, true, "la segunda consulta recibió la lección");
});

test("en Automático toma de la misión el repo, la rama base y el nombre de rama pedidos", { timeout: 90_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const prompt = "Implementa los totales en `x/lrd-back`. Parte obligatoriamente desde `release/fase3.1`. No uses `release/fase2`. Crea la rama `agentic/feature/totales`. No tocar `lrd-front`.";
  const m0 = await orchestrator.createMission({ prompt, repositoryId: "auto", engine: "codex" });
  assert.equal(m0.repositoryId, "lrd-back");
  assert.equal(m0.baseBranch, "release/fase3.1");
  let m = m0;
  for (let i = 0; i < 300 && !["done", "failed"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(m0.id)!;
  }
  assert.equal(m.status, "done", m.error ?? "");
  assert.equal(m.branch, "agentic/feature/totales");
  assert.match(git(["branch", "--list", "agentic/feature/totales"], back), /agentic\/feature\/totales/);
});

test("GitHub Actions: espera el verde; si falla por la misión, el desarrollador corrige, se publica y queda en verde", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const wait = async (id: string) => {
    let m = repo.getMission(id)!;
    for (let i = 0; i < 400 && !["done", "failed"].includes(m.status); i++) {
      await new Promise((r) => setTimeout(r, 200));
      m = repo.getMission(id)!;
    }
    return m;
  };
  process.env.FAKE_GH_MODE = "fail-until-fix";
  const m = await wait((await orchestrator.createMission({ prompt: "Implementa el filtro en `x/lrd-front`", repositoryId: "lrd-front", engine: "codex" })).id);
  assert.equal(m.status, "done", m.error ?? "");
  const ci = m.ci.find((c) => c.repositoryId === "lrd-front")!;
  assert.equal(ci.state, "success");
  assert.equal(ci.attempts, 1, "hubo una corrección");
  assert.match(git(["show", "--stat", "--format=%s", `refs/heads/${m.branch}`], front), /fix\(ci\)[\s\S]*ci-fixed\.txt/, "el commit de corrección está publicado");
  assert.ok(m.steps.some((s) => s.kind === "ci" && s.status === "done"));

  // Si la rama no dispara workflows, se documenta y NO se declara verde.
  process.env.FAKE_GH_MODE = "none";
  const n = await wait((await orchestrator.createMission({ prompt: "Implementa el filtro en `x/lrd-front` otra vez", repositoryId: "lrd-front", engine: "codex" })).id);
  assert.equal(n.status, "done");
  assert.equal(n.ci[0].state, "none");
  assert.match(n.ci[0].detail, /No se declara verde/);
  delete process.env.FAKE_GH_MODE;
});

test("chat: pedir un cambio sobre una misión terminada lo aplica en su misma rama, lo publica y espera Actions", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const { eventBus } = await import("../src/server/events/AgentEventBus");
  let m = repo.getMission((await orchestrator.createMission({ prompt: "Implementa el filtro por origen en `x/lrd-front`", repositoryId: "lrd-front", engine: "codex" })).id)!;
  for (let i = 0; i < 400 && !["done", "failed"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(m.id)!;
  }
  assert.equal(m.status, "done", m.error ?? "");
  const before = m.commitSha;
  const notes: string[] = [];
  const onMsg = (msg: { kind: string; event?: { type: string; agentId: string | null; provider: string; detail: string | null } }) => {
    const e = msg.event;
    if (msg.kind === "event" && e && e.type === "AGENT_MESSAGE" && e.agentId === "mica" && e.provider === "system") notes.push(e.detail ?? "");
  };
  eventBus.on("message", onMsg);
  const off = () => eventBus.off("message", onMsg);
  await orchestrator.chat("mica", "Cambia el texto del botón del filtro a 'Origen'", m.id, "codex");
  for (let i = 0; i < 200 && !notes.length; i++) await new Promise((r) => setTimeout(r, 200));
  off();
  assert.match(notes[0] ?? "", /Listo: commit .* en `agentic\/.*` \(publicado\)\. GitHub Actions: ✅ en verde/);
  const after = repo.getMission(m.id)!;
  assert.equal(after.status, "done");
  assert.notEqual(after.commitSha, before);
  assert.equal(after.branch, m.branch, "misma rama de la misión");
  assert.match(git(["show", "--stat", "--format=%s", `refs/heads/${m.branch}`], front), /ajuste por chat[\s\S]*chat-change\.txt/);
  // Aprendió de la corrección del usuario.
  const L = await import("../src/server/missions/lessons");
  assert.ok(L.listLessons().some((l) => l.source === "correccion" && /textos visibles de los filtros/.test(l.text)), "lección aprendida de la corrección");
});

test("publicar por chat: integra commits remotos nuevos; si un hook bloquea, explica el motivo y 'publica los cambios' reintenta", { timeout: 150_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const { eventBus } = await import("../src/server/events/AgentEventBus");
  let m = repo.getMission((await orchestrator.createMission({ prompt: "Implementa el badge de origen en `x/lrd-front`", repositoryId: "lrd-front", engine: "codex" })).id)!;
  for (let i = 0; i < 400 && !["done", "failed"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(m.id)!;
  }
  assert.equal(m.status, "done", m.error ?? "");
  const notes: string[] = [];
  const onMsg = (msg: { kind: string; event?: { type: string; agentId: string | null; provider: string; detail: string | null } }) => {
    const e = msg.event;
    if (msg.kind === "event" && e && e.type === "AGENT_MESSAGE" && e.agentId === "mica" && e.provider === "system") notes.push(e.detail ?? "");
  };
  eventBus.on("message", onMsg);
  const nextNote = async () => {
    const n = notes.length;
    for (let i = 0; i < 300 && notes.length === n; i++) await new Promise((r) => setTimeout(r, 200));
    return notes[n] ?? "";
  };

  // 1) Alguien publicó otro commit en la rama de la misión: se integra y se publica igual (sin --force).
  const other = path.join(root, "otro-dev");
  git(["clone", "-q", "--branch", m.branch!, front, other], root);
  fs.writeFileSync(path.join(other, "de-otro-dev.txt"), "x\n");
  git(["add", "-A"], other);
  git(["-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "commit de otro dev"], other);
  git(["push", "-q", "origin", `HEAD:refs/heads/${m.branch}`], other);
  await orchestrator.chat("mica", "Cambia el color del badge de Rappi", m.id, "codex");
  assert.match(await nextNote(), /Listo: commit .*\(publicado\)/);
  const log = git(["log", "--format=%s", `refs/heads/${m.branch}`], front);
  assert.match(log, /commit de otro dev/);
  assert.match(log, /ajuste por chat/);

  // 2) Un hook pre-push bloquea: se explica por qué y el commit queda guardado.
  const hook = path.join(root, "ws", "repos", "lrd-front", ".git", "hooks", "pre-push");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho 'husky - pre-push hook: lint failed' >&2\nexit 1\n", { mode: 0o755 });
  await orchestrator.chat("mica", "Cambia el texto del badge OTRO a 'Otro'", m.id, "codex");
  const blocked = await nextNote();
  assert.match(blocked, /hook de git del repositorio \(pre-push\) bloqueó la publicación/);
  assert.match(blocked, /publica los cambios/);

  // 3) Resuelto el hook, "publica los cambios" publica lo pendiente sin despertar al agente.
  fs.rmSync(hook);
  await orchestrator.chat("mica", "publica los cambios", m.id, "codex");
  assert.match(await nextNote(), /Listo: commit .*\(publicado\)/);
  eventBus.off("message", onMsg);
  const local = git(["rev-parse", "HEAD"], repo.getMission(m.id)!.worktree!);
  assert.equal(git(["rev-parse", `refs/heads/${m.branch}`], front), local, "lo publicado es lo último de la carpeta de la misión");
});

test("'valida el CI #502 y corrígelo': parte de la rama donde corrió ese run, no de la base por defecto", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  process.env.FAKE_GH_RUN_BRANCH = "feature/venta-salon";
  let m = repo.getMission((await orchestrator.createMission({ prompt: "valida el CI Frontend Quality feat: add SalonCheckoutDrawer #502 en Github y corrigelo", repositoryId: "lrd-front", engine: "codex" })).id)!;
  for (let i = 0; i < 400 && !["done", "failed"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(m.id)!;
  }
  delete process.env.FAKE_GH_RUN_BRANCH;
  assert.equal(m.status, "done", m.error ?? "");
  assert.equal(m.baseBranch, "feature/venta-salon");
  assert.match(m.branch ?? "", /^agentic\//, "la corrección va en una rama agentic/… nueva (no se toca la feature sin pedirlo)");
  // La rama publicada sale de feature/venta-salon.
  const mergeBase = git(["merge-base", `refs/heads/${m.branch}`, "refs/heads/feature/venta-salon"], front);
  assert.equal(mergeBase, git(["rev-parse", "refs/heads/feature/venta-salon"], front));
});

test("'en la misma rama': la corrección va directo a la rama del run; y 'hazlo directo en esa rama' por chat mueve una entrega agentic/", { timeout: 180_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const { eventBus } = await import("../src/server/events/AgentEventBus");
  const wait = async (id: string) => {
    let m = repo.getMission(id)!;
    for (let i = 0; i < 400 && !["done", "failed"].includes(m.status); i++) {
      await new Promise((r) => setTimeout(r, 200));
      m = repo.getMission(id)!;
    }
    return m;
  };
  process.env.FAKE_GH_RUN_BRANCH = "feature/venta-salon";

  // 1) Pedido directo desde el inicio: publicar directo en la rama requiere tu aprobación.
  const a0 = await orchestrator.createMission({ prompt: "Corrige el CI Frontend Quality #502 en la misma rama", repositoryId: "lrd-front", engine: "codex" });
  assert.equal(a0.taskKind, "ci-fix", "se aplica la guía de corrección de CI");
  const approval = await openQuestion(a0.id);
  assert.equal(approval.kind, "approval");
  assert.match(approval.context ?? "", /DIRECTO en `feature\/venta-salon`/);
  assert.equal(repo.getMission(a0.id)!.status, "waiting");
  orchestrator.answerQuestion(a0.id, approval.id, "sí, dale");
  const a = await wait(a0.id);
  assert.equal(a.status, "done", a.error ?? "");
  assert.equal(a.branch, "feature/venta-salon", "entrega directa en la rama del run");
  assert.equal(git(["rev-parse", "refs/heads/feature/venta-salon"], front), a.commitSha);
  assert.doesNotMatch(git(["branch", "--list", `agentic/*${a.id}*`], front), /agentic/, "no se creó rama agentic/");

  // 2) Entregada en agentic/… y luego se pide por chat pasarla directo a la rama.
  const b = await wait((await orchestrator.createMission({ prompt: "Corrige el CI Frontend Quality #502", repositoryId: "lrd-front", engine: "codex" })).id);
  assert.equal(b.status, "done", b.error ?? "");
  assert.match(b.branch ?? "", /^agentic\//);
  const notes: string[] = [];
  const onMsg = (msg: { kind: string; event?: { type: string; agentId: string | null; provider: string; detail: string | null } }) => {
    const e = msg.event;
    if (msg.kind === "event" && e && e.type === "AGENT_MESSAGE" && e.agentId === "atlas" && e.provider === "system") notes.push(e.detail ?? "");
  };
  eventBus.on("message", onMsg);
  await orchestrator.chat("atlas", "pero te dije que hagas los cambios directos en esa rama", b.id, "codex");
  for (let i = 0; i < 300 && !notes.length; i++) await new Promise((r) => setTimeout(r, 200));
  eventBus.off("message", onMsg);
  delete process.env.FAKE_GH_RUN_BRANCH;
  assert.match(notes[0] ?? "", /ya están directo en `feature\/venta-salon`.*GitHub Actions: ✅/s);
  const after = repo.getMission(b.id)!;
  assert.equal(after.branch, "feature/venta-salon");
  assert.equal(git(["rev-parse", "refs/heads/feature/venta-salon"], front), git(["rev-parse", "HEAD"], after.worktree!));
});

/** Espera a que la misión tenga una pregunta abierta y la devuelve. */
async function openQuestion(id: string) {
  const repo = await import("../src/server/database/repo");
  for (let i = 0; i < 400; i++) {
    const q = repo.getMission(id)?.questions.find((x) => x.status === "open");
    if (q) return q;
    const st = repo.getMission(id)?.status;
    if (st === "done" || st === "failed") throw new Error(`la misión terminó (${st}) sin preguntar`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("nunca preguntó");
}
async function finished(id: string) {
  const repo = await import("../src/server/database/repo");
  let m = repo.getMission(id)!;
  for (let i = 0; i < 400 && !["done", "failed", "cancelled"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(id)!;
  }
  return m;
}

test("pregunta al usuario: el agente pausa su paso, respondes por su chat y continúa con tu respuesta", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const m0 = await orchestrator.createMission({ prompt: "Implementa los totales en la API PRUEBA_PREGUNTA", repositoryId: "lrd-back", engine: "codex" });
  const q = await openQuestion(m0.id);
  assert.equal(q.kind, "question");
  assert.equal(q.agentId, "diego");
  assert.match(q.text, /IGV/);
  assert.deepEqual(q.options, ["Con IGV", "Sin IGV"]);
  const paused = repo.getMission(m0.id)!;
  assert.equal(paused.status, "waiting");
  assert.equal(paused.steps.find((s) => s.id === q.stepId)?.status, "waiting");

  // Lo que escribes en el chat del agente que espera es la respuesta.
  await orchestrator.chat("diego", "Sin IGV", m0.id, "codex");
  const m = await finished(m0.id);
  assert.equal(m.status, "done", m.error ?? "");
  assert.equal(m.questions[0].status, "answered");
  assert.equal(m.questions[0].answer, "Sin IGV");
  assert.equal(git(["show", `refs/heads/${m.branch}:respuesta.txt`], back), "Sin IGV", "el agente continuó con la respuesta");
});

test("secretos: no se publica una clave; eliges que el agente la quite y recién ahí se publica", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const m0 = await orchestrator.createMission({ prompt: "Implementa los totales en la API PRUEBA_SECRETO", repositoryId: "lrd-back", engine: "codex" });
  const q = await openQuestion(m0.id);
  assert.equal(q.kind, "approval");
  assert.match(q.context ?? "", /aws\.js:1 — AWS access key/);
  assert.doesNotMatch(q.context ?? "", /AKIAIOSFODNN7ABCDEFG/, "nunca se muestra la clave completa");
  assert.match(q.options[0], /^Que (Diego|Mica) lo quite$/);
  orchestrator.answerQuestion(m0.id, q.id, q.options[0]);
  const m = await finished(m0.id);
  assert.equal(m.status, "done", m.error ?? "");
  assert.ok(m.pushed);
  const published = git(["show", `refs/heads/${m.branch}:aws.js`], back);
  assert.match(published, /process\.env\.AWS_KEY/);
  assert.doesNotMatch(git(["log", "-p", `refs/heads/${m.branch}`], back), /AKIAIOSFODNN7ABCDEFG/, "la clave nunca llegó a un commit");
});

test("migraciones: sin tu aprobación el commit queda local y no se publica", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const m0 = await orchestrator.createMission({ prompt: "Implementa los totales en la API PRUEBA_MIGRACION", repositoryId: "lrd-back", engine: "codex" });
  const q = await openQuestion(m0.id);
  assert.equal(q.kind, "approval");
  assert.match(q.context ?? "", /migración[\s\S]*database\/migrations\/2026_09_30_add_totales\.php/);
  orchestrator.answerQuestion(m0.id, q.id, "no");
  const m = await finished(m0.id);
  assert.equal(m.status, "done", m.error ?? "");
  assert.ok(m.commitSha && m.branch?.startsWith("agentic/"), "commit local");
  assert.equal(m.pushed, false);
  assert.equal(git(["branch", "--list", m.branch!], back), "", "no llegó a GitHub");
});

test("biblioteca: la misión deja su resumen, los informes y tu decisión; la siguiente misión parecida los consulta", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const lib = await import("../src/server/library");
  // La misión con pregunta de antes ya dejó documentos: resumen, informes de tarea y la decisión (IGV).
  const docs = lib.searchLibrary({ q: "totales IGV" });
  const kinds = new Set(docs.map((d) => d.kind));
  assert.ok(kinds.has("mision") && kinds.has("informe") && kinds.has("decision"), [...kinds].join(","));
  const decision = docs.find((d) => d.kind === "decision")!;
  assert.match(decision.body, /IGV[\s\S]*Respuesta:\*\* Sin IGV/);
  assert.ok(!lib.searchLibrary({ q: "AKIA" }).some((d) => d.kind === "decision"), "las alertas de secretos no se guardan como decisión");
  const missionDoc = docs.find((d) => d.kind === "mision" && /PRUEBA_PREGUNTA/.test(d.body))!;
  assert.match(missionDoc.body, /\*\*Entrega:\*\*[\s\S]*agentic\//);

  process.env.FAKE_CALLS = path.join(root, "library-calls.log");
  const m = await finished((await orchestrator.createMission({ prompt: "Implementa los totales con IGV en la API de reportes", repositoryId: "lrd-back", engine: "codex" })).id);
  assert.equal(m.status, "done", m.error ?? "");
  const calls = fs.readFileSync(process.env.FAKE_CALLS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.find((c) => c.kind === "plan")?.knowsLibrary, true, "Atlas consultó la biblioteca al planificar");
  assert.ok(calls.some((c) => c.kind === "agent" && c.knowsLibrary), "los agentes también");
  // No se consulta a sí misma, y no se duplican documentos al volver a guardar el mismo paso.
  const again = lib.searchLibrary({ q: m.id });
  assert.equal(again.filter((d) => d.title.startsWith(`Misión #${m.id}`)).length, 1);
});

test("QA sin su entorno (sin MySQL de pruebas): no se culpa al código; se valida con GitHub Actions al publicar", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  // Sin publicar: el QA no se puede correr y la misión lo dice claro, sin mandar a nadie a "corregir".
  const a = await finished((await orchestrator.createMission({ prompt: "Implementa los totales en la API, no publiques", repositoryId: "lrd-api", engine: "codex" })).id);
  assert.equal(a.status, "failed");
  assert.match(a.error ?? "", /QA no se pudo correr \(entorno, no el código\): no hay MySQL en 127\.0\.0\.1:1/);
  assert.ok(!repo.missionEvents(a.id).some((e) => /Corregir falla de QA/.test(e.title)), "no se le pasó la falla al desarrollador");

  // Publicando: el QA local se omite con aviso y GitHub Actions es quien valida.
  const b = await finished((await orchestrator.createMission({ prompt: "Implementa los totales en la API", repositoryId: "lrd-api", engine: "codex" })).id);
  assert.equal(b.status, "done", b.error ?? "");
  assert.ok(repo.missionEvents(b.id).some((e) => /QA local no disponible: se validará con GitHub Actions/.test(e.title)));
  assert.equal(b.ci[0]?.state, "success");

  // Con una base que sí "existe" (sqlite), las variables del CI llegan a los comandos de QA y pasan.
  process.env.QA_TEST_DB = "sqlite";
  const c = await finished((await orchestrator.createMission({ prompt: "Implementa los totales en la API otra vez", repositoryId: "lrd-api", engine: "codex" })).id);
  delete process.env.QA_TEST_DB;
  assert.equal(c.status, "done", c.error ?? "");
  assert.ok(c.steps.some((s) => s.kind === "qa" && /QA OK/.test(s.result ?? "")), "QA corrió con APP_ENV del CI");
});

test("chat: el agente analiza el pedido; una pregunta no cambia nada aunque nombre archivos, y un pedido de revertir sí se aplica", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  const m = await finished((await orchestrator.createMission({ prompt: "Implementa el filtro de canal en `x/lrd-front`", repositoryId: "lrd-front", engine: "codex" })).id);
  assert.equal(m.status, "done", m.error ?? "");
  const understood = async (n: number) => {
    for (let i = 0; i < 300; i++) {
      const evs = repo.missionEvents(m.id).filter((e) => (e.metadata as { chatAction?: string } | null)?.chatAction);
      if (evs.length >= n) return evs.at(-1)!;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("no declaró qué entendió");
  };
  // Una pregunta que menciona archivos y "cambios": solo responde.
  await orchestrator.chat("mica", "¿por qué tocaste composer.json y qué cambios hiciste ahí?", m.id, "codex");
  assert.equal(((await understood(1)).metadata as { chatAction: string }).chatAction, "respuesta");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(repo.getMission(m.id)!.commitSha, m.commitSha, "no hubo commit");
  // "Revierte…" (que antes caía en solo lectura): el agente entiende que es un cambio y la oficina lo publica.
  await orchestrator.chat("mica", "Revierte el texto del filtro a como estaba", m.id, "codex");
  assert.equal(((await understood(2)).metadata as { chatAction: string }).chatAction, "cambio");
  for (let i = 0; i < 300 && repo.getMission(m.id)!.commitSha === m.commitSha; i++) await new Promise((r) => setTimeout(r, 200));
  assert.notEqual(repo.getMission(m.id)!.commitSha, m.commitSha, "se hizo commit del cambio");
});

test("limpieza: se borra el worktree de una misión cuyo trabajo ya está en la rama principal (merge o squash); el resto se conserva", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const { cleanupOld, mergedInto } = await import("../src/server/maintenance");
  const merged = await finished((await orchestrator.createMission({ prompt: "Implementa el resumen por canal en `x/lrd-front`", repositoryId: "lrd-front", engine: "codex" })).id);
  const squashed = await finished((await orchestrator.createMission({ prompt: "Implementa el total por mesa en `x/lrd-front`", repositoryId: "lrd-front", engine: "codex" })).id);
  const pending = await finished((await orchestrator.createMission({ prompt: "Implementa el filtro por mozo en `x/lrd-front`", repositoryId: "lrd-front", engine: "codex" })).id);
  for (const m of [merged, squashed, pending]) assert.ok(m.pushed && m.worktree && fs.existsSync(m.worktree), m.error ?? "");

  // En GitHub: la primera se integra con merge normal y la segunda con squash; la tercera sigue pendiente.
  const dev = path.join(root, "dev-merge");
  git(["clone", "-q", "--branch", "release/fase2", front, dev], root);
  const id = ["-c", "user.name=d", "-c", "user.email=d@d"];
  git([...id, "merge", "-q", "--no-edit", `origin/${merged.branch}`], dev);
  git([...id, "merge", "-q", "--squash", "-X", "theirs", `origin/${squashed.branch}`], dev);
  git([...id, "commit", "-qm", "squash: total por mesa"], dev);
  git(["push", "-q", "origin", "HEAD:refs/heads/release/fase2"], dev);

  const preview = await cleanupOld({ dryRun: true, days: 0, graceMs: 0, isActive: () => false });
  const byMission = new Map(preview.removed.filter((r) => r.kind === "worktree").map((r) => [r.missionId, r.reason]));
  assert.equal(byMission.get(merged.id), "ya está en release/fase2");
  assert.equal(byMission.get(squashed.id), "ya está en release/fase2", "también con squash");
  assert.ok(!byMission.has(pending.id), "la que no está integrada se conserva");
  assert.ok(fs.existsSync(merged.worktree!), "la vista previa no borra");

  await cleanupOld({ days: 0, graceMs: 0, isActive: () => false });
  assert.ok(!fs.existsSync(merged.worktree!) && !fs.existsSync(squashed.worktree!), "se borraron");
  assert.ok(fs.existsSync(pending.worktree!));
  assert.equal(await mergedInto(pending.worktree!, ["release/fase2"]), null);
  // La rama local agentic/… integrada se borra del clon (en GitHub sigue).
  const clone = path.join(root, "ws", "repos", "lrd-front");
  assert.equal(git(["branch", "--list", merged.branch!], clone), "");
  assert.match(git(["branch", "--list", merged.branch!], front), /agentic\//, "en el remoto se conserva");
});

test("tokens y modelo por rol: cada paso registra su consumo; planificar y revisar van con menos esfuerzo; la respuesta a una pregunta no reenvía todo", { timeout: 120_000 }, async () => {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  process.env.FAKE_CALLS = path.join(root, "tokens-calls.log");
  const m0 = await orchestrator.createMission({ prompt: "Implementa el ticket promedio en la API PRUEBA_PREGUNTA", repositoryId: "lrd-back", engine: "codex" });
  const q = await openQuestion(m0.id);
  orchestrator.answerQuestion(m0.id, q.id, "Con IGV");
  const m = await finished(m0.id);
  assert.equal(m.status, "done", m.error ?? "");

  // Consumo: total de la misión, por motor y por paso (lo que informa el motor en cada turno).
  assert.ok(m.usage && m.usage.total.calls >= 4 && m.usage.total.input >= 4000, JSON.stringify(m.usage));
  assert.equal(m.usage.total.cached, m.usage.total.calls * 400);
  assert.ok(m.usage.byProvider.codex);
  const plan = m.steps.find((s) => s.kind === "plan")!;
  assert.equal(plan.usage?.calls, 1);
  assert.ok(m.steps.filter((s) => s.kind === "agent").every((s) => (s.usage?.calls ?? 0) >= 1));

  // Modelo por rol: planificar y revisar con esfuerzo medio; implementar con el de la cuenta.
  const calls = fs.readFileSync(process.env.FAKE_CALLS!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.find((c) => c.kind === "plan")?.effort, "medium");
  assert.ok(calls.filter((c) => c.kind === "review").every((c) => c.effort === "medium"), "revisiones con esfuerzo medio");
  assert.ok(calls.filter((c) => c.kind === "agent" && !c.followUp).every((c) => c.effort === null), "implementar: el de la cuenta");
  // Tras la pregunta, el agente recibió solo la respuesta (corta), no todo el pedido otra vez.
  const follow = calls.find((c) => c.followUp);
  const first = calls.find((c) => c.kind === "question");
  assert.ok(follow && first && follow.chars < first.chars / 2, `respuesta corta: ${follow?.chars} vs ${first?.chars}`);
});
