/* npm run doctor — verifica herramientas locales. No exige API keys. */
import fs from "node:fs";
import { config, loadRepositories } from "../src/server/config";
import { run } from "../src/server/runtime/processUtils";
import { CodexCliExecutor } from "../src/server/runtime/CodexCliExecutor";
import { ClaudeCodeExecutor } from "../src/server/runtime/ClaudeCodeExecutor";
import { GitHubAdapter } from "../src/server/integrations/github/GitHubAdapter";

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);

console.log("\nLRD Agentic Office · doctor\n");

const major = Number(process.versions.node.split(".")[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (se requiere ≥ 20)`);

const g = await run("git", ["--version"]);
g.code === 0 ? ok(g.stdout.trim()) : bad("Git no encontrado");

const gh = await new GitHubAdapter().status();
if (!gh.installed) warn("GitHub CLI (gh) no instalado — push/PR no disponibles (https://cli.github.com)");
else if (gh.authenticated) ok(`gh autenticado${gh.user ? ` como ${gh.user}` : ""}`);
else warn("gh instalado pero no autenticado — ejecuta: gh auth login");

const codex = await new CodexCliExecutor().checkAvailability(true);
if (!codex.enabled) warn("Codex deshabilitado (CODEX_ENABLED=false)");
else if (!codex.installed) bad(`Codex CLI no instalado — ${codex.message}`);
else {
  ok(`Codex instalado (${codex.version})`);
  codex.authenticated ? ok(`Codex autenticado${codex.authDetail ? ` · ${codex.authDetail}` : ""}`) : bad(codex.message);
  info(`flags: ${Object.entries(codex.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
}

const claude = await new ClaudeCodeExecutor().checkAvailability(true);
if (!claude.enabled) warn("Claude Code deshabilitado (CLAUDE_ENABLED=false)");
else if (!claude.installed) bad("Claude Code: NO DISPONIBLE");
else {
  ok(`Claude Code instalado (${claude.version})`);
  claude.authenticated === true
    ? ok(`Claude Code autenticado${claude.authDetail ? ` · ${claude.authDetail}` : ""}`)
    : claude.authenticated === null
      ? warn(claude.message)
      : bad(claude.message);
  info(`flags: ${Object.entries(claude.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
}

const usable = [codex, claude].filter((s) => s.enabled && s.installed && s.authenticated !== false);
console.log("");
usable.length ? ok(`Motores IA disponibles: ${usable.map((s) => s.label).join(", ")}`) : bad("Ningún motor IA disponible. Se necesita al menos Codex CLI o Claude Code autenticado.");
console.log(`  API fallback: ${config.allowPaidApiFallback ? "\x1b[33mENABLED\x1b[0m" : "disabled"}`);
console.log(`  Motor por defecto: ${config.aiEngineDefault}`);
console.log(`  Push: ${config.githubPushEnabled ? "enabled" : "disabled"} · PR: ${config.githubPrEnabled ? "enabled" : "disabled"}`);
console.log(`  Workspace: ${config.workspaceRoot}`);

if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
  warn("Hay API keys en el entorno; se eliminan del entorno de los CLIs mientras ALLOW_PAID_API_FALLBACK=false.");

const { repositories } = loadRepositories();
console.log("\n  Repositorios:");
for (const r of repositories) {
  if (!r.enabled) {
    info(`· ${r.github} (deshabilitado)`);
    continue;
  }
  const res = await run("git", ["ls-remote", "--heads", r.cloneUrl, ...r.allowedBases], { timeoutMs: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (res.code !== 0) {
    bad(`${r.github}: sin acceso (${(res.stderr || res.error || "").trim().split(/\r?\n/)[0]})`);
    continue;
  }
  const found = r.allowedBases.filter((b) => res.stdout.includes(`refs/heads/${b}`));
  const missing = r.allowedBases.filter((b) => !found.includes(b));
  missing.length ? warn(`${r.github}: ramas ${found.join(", ")} · faltan ${missing.join(", ")}`) : ok(`${r.github}: ${found.join(", ")}`);
}
if (!fs.existsSync(".env")) warn("No existe .env (se usan valores por defecto). Copia .env.example a .env");
console.log("");
process.exit(usable.length ? 0 : 1);
