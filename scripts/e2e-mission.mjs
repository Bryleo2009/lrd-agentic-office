/**
 * Prueba de aceptación end-to-end con motor REAL:
 * abre la oficina en Chromium, crea una misión por la API, sigue los eventos reales por WebSocket
 * y toma capturas de la oficina reaccionando.
 *
 * node scripts/e2e-mission.mjs <url> "<prompt>" <repoId> <base> <engine>
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const [, , url = "http://127.0.0.1:4173/", prompt = "Valida el CI de lrd-front y corrige el problema.", repositoryId = "auto", baseBranch = "", engine = "codex", allowMcp = "false"] = process.argv;
const out = ".validation";
fs.mkdirSync(out, { recursive: true });
const exe = process.env.PLAYWRIGHT_CHROMIUM ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__office && window.__office.entities.size === 8, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const res = await fetch(new URL("/api/missions", url), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt, repositoryId, baseBranch: baseBranch || null, engine, allowMcp: allowMcp === "true" }),
});
const mission = await res.json();
if (!res.ok) {
  console.error("No se pudo crear la misión:", mission);
  process.exit(1);
}
console.log(`Misión ${mission.id} → repo ${mission.repositoryId} (${mission.repoSelection}) · base ${mission.baseBranch || "-"} · rama ${mission.branch} · MCP ${mission.allowMcp}`);

const t0 = Date.now();
let shots = 0;
let lastShot = 0;
let seen = 0;
let final = null;
const visualSamples = [];
while (Date.now() - t0 < 15 * 60_000) {
  const evs = await (await fetch(new URL(`/api/missions/${mission.id}/events`, url))).json();
  for (const e of evs.slice(seen)) if (!["COMMAND_OUTPUT", "TEST_OUTPUT"].includes(e.type)) console.log(`${e.timestamp.slice(11, 19)} ${(e.agentId ?? "-").padEnd(6)} ${e.type.padEnd(18)} ${e.title}`);
  seen = evs.length;
  const vis = await page.evaluate(() => window.__office.metrics().agents.map((a) => `${a.id}:${a.mode}/${a.action}`).join(" "));
  visualSamples.push({ t: (Date.now() - t0) / 1000, vis });
  if (Date.now() - lastShot > 9000 && shots < 14) {
    await page.screenshot({ path: `${out}/mission-${String(shots).padStart(2, "0")}.png` });
    shots++;
    lastShot = Date.now();
  }
  const m = await (await fetch(new URL(`/api/missions/${mission.id}`, url))).json();
  if (["done", "failed", "cancelled"].includes(m.status)) {
    final = m;
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/mission-final.png` });
    break;
  }
  await page.waitForTimeout(1500);
}
fs.writeFileSync(`${out}/mission-visual.json`, JSON.stringify(visualSamples, null, 1));
console.log("\nEstado final:", final?.status, "| rama:", final?.branch, "| commit:", final?.commitSha, "| push:", final?.pushed, "| error:", final?.error ?? "-");
console.log("Pasos:", final?.steps.map((s) => `${s.agentId}:${s.kind}:${s.status}`).join(", "));
console.log("Errores JS:", errors.length ? errors : "ninguno");
await browser.close();
process.exit(final?.status === "done" ? 0 : 1);
