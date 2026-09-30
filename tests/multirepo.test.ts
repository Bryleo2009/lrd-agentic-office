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
  return bare;
}
// Cada script de QA deja constancia de cuándo corrió, para comprobar que van en paralelo.
const qaLog = path.join(root, "qa.log");
const slow = (tag: string) => `node -e "const t=Date.now();setTimeout(()=>{require('fs').appendFileSync(process.env.QA_LOG, JSON.stringify({tag:'${tag}',start:t,end:Date.now()})+'\\\\n')},1200)"`;
const back = makeRepo("lrd-back", { name: "back", scripts: { build: slow("build"), test: slow("test") } });
const front = makeRepo("lrd-front", { name: "front", scripts: { build: slow("front-build") } });
fs.writeFileSync(
  path.join(root, "repos.json"),
  JSON.stringify({
    repositories: [
      { id: "lrd-back", name: "lrd-back", github: "x/lrd-back", cloneUrl: back, shortName: "back", kind: "backend", enabled: true, allowedBases: ["release/fase2", "release/fase3.1"], defaultBase: "release/fase2",
        qaStages: [["npm run build", "npm test"], [slow("after")]] },
      { id: "lrd-front", name: "lrd-front", github: "x/lrd-front", cloneUrl: front, shortName: "front", kind: "frontend", enabled: true, allowedBases: ["release/fase2"], defaultBase: "release/fase2" },
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
