import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Entorno aislado: un repositorio "remoto" (bare) y tu clon local con estructura propia.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-projects-"));
Object.assign(process.env, {
  LRD_WORKSPACE_ROOT: path.join(root, "ws"),
  LRD_REPOS_FILE: path.join(root, "repos.json"),
});
fs.writeFileSync(
  path.join(root, "repos.json"),
  JSON.stringify({
    repositories: [
      { id: "lrd-back", name: "lrd-back", github: "Bryleo2009/lrd-back", cloneUrl: "x", shortName: "back", kind: "backend", enabled: true, allowedBases: ["main"], defaultBase: "main", checkCommand: "bash scripts/check-backend" },
      { id: "ofsystem", name: "OfSystem", github: "Bryleo2009/OfSystem", cloneUrl: "x", shortName: "ofsystem", enabled: false, allowedBases: ["main"], defaultBase: "main" },
    ],
    protectedBranches: ["main"],
  }),
);
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function makeClone(name: string, files: Record<string, string>, branches = ["main", "develop", "feature/x"]): string {
  const bare = path.join(root, `${name}.git`);
  git(["init", "-q", "--bare", bare], root);
  const clone = path.join(root, name);
  git(["clone", "-q", bare, clone], root);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(clone, f)), { recursive: true });
    fs.writeFileSync(path.join(clone, f), c);
  }
  git(["add", "-A"], clone);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], clone);
  for (const b of branches) git(["push", "-q", "origin", `HEAD:refs/heads/${b}`], clone);
  return clone;
}

test("detección: reconoce stacks distintos y propone QA", async () => {
  const { detectProject } = await import("../src/server/projects");
  const mk = (files: Record<string, string>) => {
    const d = fs.mkdtempSync(path.join(root, "det-"));
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), c);
    }
    return d;
  };
  const vue = detectProject(mk({ "package.json": JSON.stringify({ dependencies: { vue: "3" }, devDependencies: { vite: "5", typescript: "5" }, scripts: { lint: "eslint . --fix", "lint:check": "eslint .", "type-check": "vue-tsc", test: "vitest run", build: "vite build" } }), "pnpm-lock.yaml": "" }));
  assert.equal(vue.kind, "frontend");
  assert.match(vue.stack, /Vue \+ Vite · TypeScript · pnpm/);
  assert.deepEqual(vue.qaStages, [["pnpm run lint:check", "pnpm run type-check", "pnpm run test", "pnpm run build"]]);

  const nest = detectProject(mk({ "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "10" }, scripts: { lint: "eslint --fix", test: "jest" } }) }));
  assert.equal(nest.kind, "backend");
  // Un lint que corrige archivos no se usa para verificar.
  assert.deepEqual(nest.qaStages, [["npm test"]]);

  const laravel = detectProject(mk({ "composer.json": "{}", artisan: "", "package.json": JSON.stringify({ scripts: { build: "vite build" } }) }));
  assert.equal(laravel.kind, "backend");
  assert.match(laravel.stack, /^Laravel · PHP/);
  assert.deepEqual(laravel.qaStages.at(-1), ["npm run build"]);

  const spring = detectProject(mk({ "pom.xml": "<artifactId>spring-boot-starter</artifactId>" }));
  assert.equal(spring.kind, "backend");
  assert.match(spring.qaStages[0][0], /mvn -B verify/);
  assert.equal(detectProject(mk({ "go.mod": "module x" })).stack, "Go");
  assert.equal(detectProject(mk({ "Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">' })).kind, "backend");
  const django = detectProject(mk({ "manage.py": "", "requirements.txt": "django\nruff" }));
  assert.match(django.stack, /Django/);
  assert.ok(django.qaStages[0].some((c) => /manage\.py test/.test(c)));
  assert.equal(detectProject(mk({ "README.md": "hola" })).empty, true);
});

test("parseGithub entiende owner/repo, SSH y HTTPS", async () => {
  const { parseGithub } = await import("../src/server/projects");
  assert.equal(parseGithub("Bryleo2009/mi-api"), "Bryleo2009/mi-api");
  assert.equal(parseGithub("git@github.com:Bryleo2009/mi-api.git"), "Bryleo2009/mi-api");
  assert.equal(parseGithub("https://github.com/Bryleo2009/mi-api/"), "Bryleo2009/mi-api");
  assert.equal(parseGithub("no es un repo"), null);
});

test("agregar un proyecto propio: analiza la carpeta, lo guarda y queda disponible", async () => {
  const clone = makeClone("mi-api", {
    "package.json": JSON.stringify({ dependencies: { express: "4" }, scripts: { test: "node --test", build: "tsc" } }),
  });
  const { inspectProject, saveProject, removeProject } = await import("../src/server/projects");
  const { loadRepositories } = await import("../src/server/config");
  const { repoLocalPath } = await import("../src/server/settings");

  // Un repositorio distinto al del origin se rechaza: la oficina publica en origin.
  const wrong = await inspectProject({ path: clone, github: "Bryleo2009/otro" });
  assert.equal(wrong.ok, false);

  const r = await inspectProject({ path: clone });
  assert.equal(r.ok, true, r.message);
  const d = r.draft!;
  assert.equal(d.kind, "backend");
  assert.equal(d.defaultBase, "develop");
  assert.ok(d.allowedBases.includes("main") && d.allowedBases.includes("develop"));
  assert.ok(!d.allowedBases.includes("feature/x"));
  assert.ok(r.branches.includes("feature/x"));
  assert.deepEqual(d.protectedBranches, ["develop", "main"]);

  await saveProject({ ...d, notes: "No tocar src/legacy" }, d.localPath!);
  const saved = loadRepositories().repositories.find((x) => x.id === d.id)!;
  assert.equal(saved.enabled, true);
  assert.equal(saved.custom, true);
  assert.equal(saved.notes, "No tocar src/legacy");
  assert.equal(repoLocalPath(d.id), fs.realpathSync(clone));
  assert.ok(loadRepositories().protectedBranches.includes("develop"));

  // Nombre corto repetido → error claro, y nada cambia.
  await assert.rejects(saveProject({ ...d, id: "otro", shortName: "back" }, d.localPath!), /ya lo usa lrd-back/);

  await removeProject(d.id);
  assert.equal(loadRepositories().repositories.some((x) => x.id === d.id), false);
  assert.equal(repoLocalPath(d.id), null);
});

test("monorepo: detecta subproyectos y registra uno por su subcarpeta", async () => {
  const clone = makeClone("plataforma", {
    "README.md": "monorepo",
    "backend/composer.json": "{}",
    "backend/artisan": "",
    "frontend/package.json": JSON.stringify({ dependencies: { react: "18" }, scripts: { build: "vite build" } }),
  });
  const { inspectProject, saveProject } = await import("../src/server/projects");
  const { loadRepositories } = await import("../src/server/config");
  const top = await inspectProject({ path: clone });
  assert.equal(top.ok, true);
  assert.deepEqual(top.subprojects.map((s) => s.dir).sort(), ["backend", "frontend"]);

  // Apuntar directo a la subcarpeta la toma como carpeta de trabajo.
  const front = await inspectProject({ path: path.join(clone, "frontend") });
  assert.equal(front.draft!.workdir, "frontend");
  assert.equal(front.draft!.kind, "frontend");
  await saveProject(front.draft!, front.draft!.localPath!);
  const back = await inspectProject({ path: clone, workdir: "backend" });
  assert.equal(back.draft!.kind, "backend");
  assert.notEqual(back.draft!.id, front.draft!.id);
  assert.notEqual(back.draft!.shortName, front.draft!.shortName);
  await saveProject(back.draft!, back.draft!.localPath!);
  assert.equal(loadRepositories().repositories.filter((r) => r.github.endsWith("/plataforma")).length, 2);
});

test("un repositorio de config/repositories.json se activa y reutiliza su configuración", async () => {
  const clone = makeClone("OfSystem", { "package.json": JSON.stringify({ scripts: { build: "x" } }) }, ["main"]);
  git(["remote", "set-url", "origin", "git@github.com:Bryleo2009/OfSystem.git"], clone);
  git(["config", `url.${path.join(root, "OfSystem.git")}.insteadOf`, "git@github.com:Bryleo2009/OfSystem.git"], clone);
  const { inspectProject, saveProject, removeProject } = await import("../src/server/projects");
  const { loadRepositories } = await import("../src/server/config");
  const r = await inspectProject({ path: clone, github: "Bryleo2009/OfSystem" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.existing, true);
  assert.equal(r.draft!.id, "ofsystem");
  await saveProject(r.draft!, r.draft!.localPath!);
  assert.equal(loadRepositories().repositories.find((x) => x.id === "ofsystem")!.enabled, true);
  await removeProject("ofsystem");
  assert.equal(loadRepositories().repositories.find((x) => x.id === "ofsystem")!.enabled, false);
});

test("el equipo recibe tecnologías, subcarpeta e indicaciones del proyecto", async () => {
  const { projectBrief, buildPlannerPrompt } = await import("../src/server/missions/MissionPlanner");
  const repo = { id: "p", name: "p", github: "o/p", cloneUrl: "x", shortName: "p", enabled: true, allowedBases: ["main"], defaultBase: "main", stack: "Go", workdir: "api", notes: "Usa make test" };
  const b = projectBrief(repo);
  assert.match(b, /Tecnologías: Go/);
  assert.match(b, /subcarpeta `api`/);
  assert.match(b, /Usa make test/);
  assert.match(buildPlannerPrompt("arregla el login", repo, "main", []), /Usa make test/);
  assert.equal(projectBrief({ ...repo, stack: undefined, workdir: undefined, notes: undefined }), "");
});
