#!/usr/bin/env node
// gh falso para pruebas de GitHub Actions. Lee el commit real de la rama en el repo "remoto" local.
// FAKE_GH_REPOS: {"x/lrd-back": "/ruta/lrd-back.git"}
// FAKE_GH_MODE: green (por defecto) | fail-until-fix (rojo hasta que el commit tenga ci-fixed.txt) | none (no hay workflows)
import { execFileSync } from "node:child_process";
const a = process.argv.slice(2);
const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
const mode = process.env.FAKE_GH_MODE || "green";
const repos = JSON.parse(process.env.FAKE_GH_REPOS || "{}");
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
if (a[0] === "--version") { console.log("gh version 2.99.0"); process.exit(0); }
if (a[0] === "run" && a[1] === "list" && (arg("--json") ?? "").includes("number")) {
  // Runs históricos del repo (para ubicar "CI #502"): FAKE_GH_RUN_BRANCH es la rama donde corrió.
  console.log(JSON.stringify([{ number: 502, headBranch: process.env.FAKE_GH_RUN_BRANCH || "feature/x", headSha: "f1d2d747aaaa", workflowName: "Frontend Quality" }, { number: 502, headBranch: "otra", headSha: "b", workflowName: "Backend Quality" }]));
  process.exit(0);
}
if (a[0] === "run" && a[1] === "list") {
  if (arg("--workflow")) { console.log(JSON.stringify([{ conclusion: "success" }])); process.exit(0); } // la base está en verde
  if (mode === "none") { console.log("[]"); process.exit(0); }
  const bare = repos[arg("-R")];
  let sha;
  try { sha = git(["rev-parse", `refs/heads/${arg("--branch")}`], bare); } catch { console.log("[]"); process.exit(0); }
  let fixed = true;
  if (mode === "fail-until-fix") { try { git(["cat-file", "-e", `${sha}:ci-fixed.txt`], bare); } catch { fixed = false; } }
  console.log(JSON.stringify([{ databaseId: 42, status: "completed", conclusion: fixed ? "success" : "failure", workflowName: "frontend-quality", headSha: sha, url: `https://github.com/${arg("-R")}/actions/runs/42` }]));
  process.exit(0);
}
if (a[0] === "run" && a[1] === "view") { console.log("lint:check\nError: falta el archivo ci-fixed.txt (regla de la prueba)"); process.exit(0); }
process.exit(0);
