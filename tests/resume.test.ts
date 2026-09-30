import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Servidor REAL como proceso: se mata de golpe en medio de una misión y se vuelve a arrancar.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-resume-"));
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
const port = 4300 + Math.floor(Math.random() * 500);
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(port),
  LRD_WORKSPACE_ROOT: path.join(root, "ws"),
  LRD_REPOS_FILE: path.join(root, "repos.json"),
  CODEX_COMMAND: path.resolve("tests/fixtures/fake-codex-team.mjs"),
  CLAUDE_ENABLED: "false",
  AI_ENGINE_DEFAULT: "codex",
  VISUAL_PACING_MS: "0",
  GITHUB_PUSH_ENABLED: "true",
  FAKE_TIMELINE: path.join(root, "timeline.log"),
  FAKE_CALLS: calls,
  FAKE_AGENT_MS: "6000",
  CODEX_HOME: path.join(root, "codex-home"),
};

function startServer(): ChildProcess {
  // Un solo proceso (sin el envoltorio de tsx) para que SIGKILL mate de verdad al servidor.
  const p = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr!.on("data", (d) => process.env.DEBUG_RESUME && process.stderr.write(d));
  p.stdout!.on("data", () => undefined);
  p.stderr!.on("data", () => undefined);
  return p;
}
const api = async (p: string, init?: RequestInit) => (await fetch(`http://127.0.0.1:${port}${p}`, init)).json();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      /* servidor arrancando */
    }
    if (Date.now() - t0 > ms) throw new Error("tiempo agotado");
    await new Promise((r) => setTimeout(r, 250));
  }
}
const readCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("el servidor muere de golpe a mitad de misión y al volver la retoma desde donde quedó", { timeout: 120_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("usa señales POSIX");
  let server = startServer();
  await until(() => api("/api/health").then((h) => h?.ok ?? h), 30_000);
  const m0 = await api("/api/missions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Implementa los totales en la API y la pantalla", repositoryId: "lrd-back+lrd-front", engine: "codex" }) });
  assert.ok(m0.id, JSON.stringify(m0));

  // Esperar a que Diego y Mica estén editando y matar el servidor SIN aviso (como cerrar la ventana).
  const working = await until(() => Promise.resolve(readCalls().filter((c) => c.kind === "agent").length >= 2 && readCalls().filter((c) => c.kind === "agent")), 30_000);
  server.kill("SIGKILL");
  await new Promise((r) => server.once("exit", r));
  const orphans = working.map((c: { pid: number }) => c.pid).filter(alive);
  assert.ok(orphans.length > 0, "tras un SIGKILL los agentes (detached) siguen vivos: justo lo que hay que limpiar");

  // Arranca de nuevo: cierra los huérfanos y retoma.
  server = startServer();
  await until(() => api("/api/health"), 30_000);
  await until(() => Promise.resolve(orphans.every((p: number) => !alive(p))), 10_000);

  const done = await until(async () => {
    const m = await api(`/api/missions/${m0.id}`);
    return ["done", "failed"].includes(m?.status) && m;
  }, 60_000);
  server.kill("SIGTERM");
  assert.equal(done.status, "done", done.error);

  const c = readCalls();
  assert.equal(c.filter((x) => x.kind === "plan").length, 1, "no se vuelve a planificar");
  const second = c.filter((x) => x.kind === "agent" && x.resumed);
  assert.equal(second.length, 2, "Diego y Mica repiten su paso, avisados de que se retoma");
  assert.equal(done.repos.filter((r: { pushed: boolean }) => r.pushed).length, 2, "rama publicada en back y front");
  for (const bare of [back, front]) assert.match(git(["branch", "--list", "agentic/*"], bare), /agentic\//);
});
