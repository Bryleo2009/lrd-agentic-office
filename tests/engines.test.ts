import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Codex y Claude Code (ambos simulados) disponibles a la vez, con dos repos git reales.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-engines-"));
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
function makeRepo(name: string): string {
  const bare = path.join(root, `${name}.git`);
  git(["init", "-q", "--bare", bare], root);
  const seed = path.join(root, `${name}-seed`);
  git(["clone", "-q", bare, seed], root);
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name, scripts: { build: "node -e 0" } }));
  fs.mkdirSync(path.join(seed, "node_modules"));
  fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules\n");
  git(["add", "-A"], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], seed);
  git(["push", "-q", "origin", "HEAD:refs/heads/release/fase2"], seed);
  return bare;
}
const back = makeRepo("lrd-back");
const front = makeRepo("lrd-front");
fs.writeFileSync(
  path.join(root, "repos.json"),
  JSON.stringify({
    repositories: [
      { id: "lrd-back", name: "lrd-back", github: "x/lrd-back", cloneUrl: back, shortName: "back", kind: "backend", enabled: true, allowedBases: ["release/fase2"], defaultBase: "release/fase2" },
      { id: "lrd-front", name: "lrd-front", github: "x/lrd-front", cloneUrl: front, shortName: "front", kind: "frontend", enabled: true, allowedBases: ["release/fase2"], defaultBase: "release/fase2" },
    ],
    protectedBranches: ["main", "release/fase2"],
  }),
);
const calls = path.join(root, "calls.log");
Object.assign(process.env, {
  LRD_WORKSPACE_ROOT: path.join(root, "ws"),
  LRD_REPOS_FILE: path.join(root, "repos.json"),
  CODEX_COMMAND: path.resolve("tests/fixtures/fake-codex-team.mjs"),
  CLAUDE_COMMAND: path.resolve("tests/fixtures/fake-claude.mjs"),
  CLAUDE_ENABLED: "true",
  CODEX_ENABLED: "true",
  AI_ENGINE_DEFAULT: "codex",
  VISUAL_PACING_MS: "0",
  GITHUB_PUSH_ENABLED: "true",
  GH_COMMAND: path.resolve("tests/fixtures/fake-gh.mjs"),
  FAKE_GH_REPOS: JSON.stringify({ "x/lrd-back": back, "x/lrd-front": front }),
  CI_POLL_SEC: "1",
  FAKE_TIMELINE: path.join(root, "timeline.log"),
  FAKE_CALLS: calls,
  FAKE_AGENT_MS: "800",
  CODEX_HOME: path.join(root, "codex-home"),
});
const readCalls = () => fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function run(prompt: string) {
  const { orchestrator } = await import("../src/server/agents/AgentOrchestrator");
  const repo = await import("../src/server/database/repo");
  let m = repo.getMission((await orchestrator.createMission({ prompt, repositoryId: "lrd-back+lrd-front", engine: "auto" })).id)!;
  for (let i = 0; i < 500 && !["done", "failed"].includes(m.status); i++) {
    await new Promise((r) => setTimeout(r, 200));
    m = repo.getMission(m.id)!;
  }
  return m;
}

test("enrutador: menos cargado, alterna en empate, 'el otro' para revisar y evita el saturado", async () => {
  const { runtime } = await import("../src/server/runtime/RuntimeDetector");
  const { saturationFrom } = await import("../src/server/runtime/humanize");
  await runtime.detect(true);
  assert.ok(runtime.isAvailable("codex") && runtime.isAvailable("claude"));
  const a = runtime.choose({ agentId: "diego", missionProvider: "codex", engine: "auto" });
  const relA = runtime.acquire(a);
  const b = runtime.choose({ agentId: "mica", missionProvider: "codex", engine: "auto" });
  assert.notEqual(a, b, "con uno ocupado, el siguiente va al otro motor");
  relA();
  assert.equal(runtime.choose({ agentId: "atlas", missionProvider: "codex", engine: "auto", avoid: "codex" }), "claude");
  assert.equal(runtime.choose({ agentId: "atlas", missionProvider: "codex", engine: "codex", avoid: "codex" }), "claude", "revisa el otro aunque la misión fije motor");

  runtime.markSaturated("claude", "llegó a su límite de uso", 60_000);
  assert.equal(runtime.choose({ agentId: "mica", missionProvider: "claude", engine: "claude" }), "codex", "motor fijado pero saturado: usa el otro");
  assert.ok(runtime.snapshot().find((s) => s.provider === "claude")?.saturatedUntil);
  runtime.clearSaturation("claude");

  const now = new Date("2026-09-30T10:00:00");
  assert.equal(saturationFrom("You've hit your usage limit. Try again in 2 hours 15 minutes.", 1_800_000, now)?.ms, 8_100_000);
  assert.equal(saturationFrom("Claude AI usage limit reached|resets 3pm", 1_800_000, now)?.ms, 5 * 3_600_000);
  assert.equal(saturationFrom("429 Too Many Requests. retry-after: 120", 1_800_000, now)?.ms, 120_000);
  assert.equal(saturationFrom("overloaded_error: Overloaded", 1_800_000, now)?.ms, 300_000);
  assert.equal(saturationFrom("SyntaxError en Console.vue", 1_800_000, now), null);
});

test("back + front: Codex y Claude trabajan en paralelo y cada uno revisa lo del otro", { timeout: 120_000 }, async () => {
  const m = await run("Implementa los totales: endpoint en la API y pantalla en el front");
  assert.equal(m.status, "done", m.error ?? "");
  const impl = m.steps.filter((s) => s.kind === "agent");
  assert.deepEqual(new Set(impl.map((s) => s.provider)), new Set(["codex", "claude"]), "se repartieron entre los dos motores");
  for (const x of m.steps.filter((s) => s.kind === "xreview")) {
    const writer = impl.find((s) => s.repositoryId === x.repositoryId)!;
    assert.notEqual(x.provider, writer.provider, `revisión cruzada de ${x.repositoryId}: revisa el otro motor`);
  }
  const t = fs.readFileSync(path.join(root, "timeline.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const [x, y] = t.slice(-2);
  assert.ok(x.start < y.end && y.start < x.end, "en paralelo");
});

test("límite de uso: el paso sigue con el otro motor, y se recuerda que está saturado", { timeout: 120_000 }, async () => {
  const { runtime } = await import("../src/server/runtime/RuntimeDetector");
  process.env.FAKE_LIMIT_ENGINE = "codex";
  process.env.FAKE_LIMIT_ON = "Endpoint de totales";
  const m = await run("Implementa los totales otra vez: endpoint en la API y pantalla en el front");
  delete process.env.FAKE_LIMIT_ENGINE;
  delete process.env.FAKE_LIMIT_ON;
  assert.equal(m.status, "done", m.error ?? "");
  const diego = m.steps.find((s) => s.kind === "agent" && s.title === "Endpoint de totales")!;
  assert.equal(diego.provider, "claude", "Diego terminó con Claude tras el límite de Codex");
  const sat = runtime.saturationOf("codex");
  assert.ok(sat && sat.until - Date.now() > 40 * 60_000, "Codex queda saturado ~45 min (lo que dijo su mensaje)");
  assert.ok(fs.existsSync(path.join(root, "ws", "engine-health.json")), "se guarda para sobrevivir a reinicios");

  // Mientras Codex está saturado, la siguiente misión no lo usa en absoluto.
  const before = readCalls().length;
  const n = await run("Implementa los totales por tercera vez: endpoint en la API y pantalla en el front");
  assert.equal(n.status, "done", n.error ?? "");
  const after = readCalls().slice(before);
  assert.ok(after.length > 0 && after.every((c) => c.engine === "claude"), "todo con Claude mientras Codex está saturado");
  runtime.clearSaturation("codex");
});
