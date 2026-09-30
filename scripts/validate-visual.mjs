/**
 * Validación visual (sección 45): ejecuta la oficina ≥ 60 s en Chromium headless y verifica
 * con métricas del motor: 8 personajes, caminar, pathfinding sin atravesar muebles, sentarse/levantarse,
 * giros, interacción con estaciones, al menos un encuentro, nadie congelado.
 *
 * Uso: npm run dev   (en otra terminal)
 *      node scripts/validate-visual.mjs [url] [segundos]
 * Requiere playwright-core y un Chromium (PLAYWRIGHT_CHROMIUM o /opt/pw-browsers/chromium o el de Playwright).
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const seconds = Number(process.argv[3] ?? 65);
const outDir = ".validation";
fs.mkdirSync(outDir, { recursive: true });

const exe = process.env.PLAYWRIGHT_CHROMIUM ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__office && window.__office.entities.size === 8, null, { timeout: 30000 });

const samples = [];
const encounters = new Set();
const t0 = Date.now();
let shot = 0;
while ((Date.now() - t0) / 1000 < seconds) {
  const m = await page.evaluate(() => window.__office.metrics());
  samples.push(m);
  for (const a of m.agents) if (a.state === "TALKING" || a.mode === "engaged") encounters.add(a.id);
  const el = (Date.now() - t0) / 1000;
  if ((shot === 0 && el > 8) || (shot === 1 && el > 30) || (shot === 2 && el > seconds - 3)) {
    await page.screenshot({ path: `${outDir}/office-${Math.round(el)}s.png` });
    shot++;
  }
  await page.waitForTimeout(500);
}
const last = samples[samples.length - 1];
const first = samples[0];
const per = last.agents.map((a) => {
  const f = first.agents.find((x) => x.id === a.id);
  const positions = new Set(samples.map((s) => { const q = s.agents.find((x) => x.id === a.id); return `${q.pos.x.toFixed(1)},${q.pos.y.toFixed(1)}`; }));
  const actions = new Set(samples.map((s) => s.agents.find((x) => x.id === a.id).action));
  return {
    id: a.id,
    walked: +a.walked.toFixed(2),
    behaviors: a.behaviors,
    routines: a.routines,
    sits: a.sits,
    stands: a.stands,
    turns: a.turns,
    collisionViolations: a.collisionViolations,
    distinctPositions: positions.size,
    distinctActions: [...actions],
    frozen: positions.size <= 1 && actions.size <= 1,
    moved: a.walked - (f?.walked ?? 0) > 0,
  };
});

const checks = {
  "8 personajes visibles": last.agents.length === 8 && last.agents.every((a) => a.visible),
  "≥3 agentes con comportamiento ambiental": per.filter((p) => p.behaviors > 0).length >= 3,
  "caminata (pathfinding)": per.filter((p) => p.walked > 2).length >= 3,
  "sentarse": per.some((p) => p.sits > 0),
  "levantarse": per.some((p) => p.stands > 0),
  "girar": per.some((p) => p.turns > 2),
  "interacción con estaciones (animaciones)": per.every((p) => p.distinctActions.length >= 2),
  "al menos un encuentro entre agentes": encounters.size >= 2,
  "ningún agente atraviesa muebles": per.every((p) => p.collisionViolations === 0),
  "ningún agente congelado": per.every((p) => !p.frozen),
  "sin errores JS": errors.length === 0,
};
const report = { url, seconds, fpsHeadless: +last.fps.toFixed(1), checks, agents: per, encounters: [...encounters], errors };
fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
