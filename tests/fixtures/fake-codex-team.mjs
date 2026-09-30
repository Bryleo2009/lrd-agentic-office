#!/usr/bin/env node
// Codex falso "de equipo": planifica back + front en paralelo, edita archivos y responde.
import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const has = (s) => a.includes(s);
if (has("--version")) { console.log("codex-cli 0.159.2"); process.exit(0); }
if (a[0] === "exec" && has("--help")) { console.log("--json --cd --sandbox --skip-git-repo-check --color resume  If not provided as an argument (or if `-` is used), instructions are read from stdin"); process.exit(0); }
if (a[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (a[0] === "mcp") { console.log("[]"); process.exit(0); }
if (a[0] !== "exec") process.exit(0);

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const engine = process.env.FAKE_ENGINE || "codex";
  // Límite de uso simulado: FAKE_LIMIT_ENGINE=codex y FAKE_LIMIT_ON=<texto del prompt>
  if (process.env.FAKE_LIMIT_ENGINE === engine && process.env.FAKE_LIMIT_ON && input.includes(process.env.FAKE_LIMIT_ON)) {
    console.log(JSON.stringify({ type: "thread.started", thread_id: `th_${process.pid}` }));
    console.log(JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again in 45 minutes." }));
    process.exit(1);
  }
  const log = (o) => process.env.FAKE_CALLS && fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ ...o, engine, pid: process.pid, resumed: input.includes("se interrumpió"), knowsLesson: input.includes("Lecciones de misiones anteriores") }) + "\n");
  const say = (text) => {
    console.log(JSON.stringify({ type: "thread.started", thread_id: `th_${process.pid}` }));
    console.log(JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
  };
  if (input.includes("SOLO planificar")) {
    log({ kind: "plan" });
    const plan = { deliverable: "code_change", checklist: ["Endpoint GET /api/totales", "Pantalla de totales en el front"], steps: [
      { id: "s1", agent: "diego", title: "Endpoint de totales", task: "Agregar endpoint GET /api/totales", dependsOn: [], writes: true, repo: "lrd-back" },
      { id: "s2", agent: "mica", title: "Pantalla de totales", task: "Mostrar totales de GET /api/totales", dependsOn: [], writes: true, repo: "lrd-front" },
    ] };
    return say("```json\n" + JSON.stringify(plan) + "\n```");
  }
  if (input.includes("te pide un CAMBIO")) {
    fs.writeFileSync(path.join(process.cwd(), "chat-change.txt"), "ajuste pedido por chat\n");
    log({ kind: "chat-change" });
    return say("Hecho: ajusté el texto del filtro.\nLECCIÓN: Los textos visibles de los filtros van en español y con mayúscula inicial.\nRESUMEN: cambio aplicado");
  }
  if (input.includes("GitHub Actions falló en")) {
    fs.writeFileSync(path.join(process.cwd(), "ci-fixed.txt"), "arreglado\n");
    log({ kind: "ci-fix" });
    return say("Corregí lo que rompía el lint.\nRESUMEN: CI corregido");
  }
  if (input.includes("La revisión de secretos encontró")) {
    fs.writeFileSync(path.join(process.cwd(), "aws.js"), "export const AWS_KEY = process.env.AWS_KEY;\n");
    log({ kind: "secret-fix" });
    return say("Moví la clave a una variable de entorno.\nRESUMEN: secreto quitado");
  }
  // Pregunta al usuario (solo el paso del back, y solo hasta recibir la respuesta).
  if (input.includes("PRUEBA_PREGUNTA") && input.includes("Tu tarea (Endpoint de totales)") && !input.includes("Su respuesta:")) {
    log({ kind: "question" });
    return say("Revisé el endpoint; hay dos formatos posibles.\nPREGUNTA: ¿Los totales van con IGV o sin IGV?\nOPCIONES: Con IGV | Sin IGV");
  }
  if (input.includes("Puedes modificar archivos")) {
    const who = input.includes("Tu tarea (Pantalla de totales)") ? "front" : "back";
    const t0 = Date.now();
    log({ kind: "agent", who });
    setTimeout(() => {
      fs.appendFileSync(path.join(process.cwd(), `cambio-${who}.txt`), `hecho por ${who} ${Date.now()}\n`);
      const answer = input.match(/Su respuesta: "([^"]+)"/)?.[1];
      if (answer) fs.writeFileSync(path.join(process.cwd(), "respuesta.txt"), answer + "\n");
      if (input.includes("PRUEBA_SECRETO") && who === "back") fs.writeFileSync(path.join(process.cwd(), "aws.js"), 'export const AWS_KEY = "AKIAIOSFODNN7ABCDEFG";\n');
      if (input.includes("PRUEBA_MIGRACION") && who === "back") {
        fs.mkdirSync(path.join(process.cwd(), "database", "migrations"), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), "database", "migrations", "2026_09_30_add_totales.php"), "<?php // migración\n");
      }
      fs.appendFileSync(process.env.FAKE_TIMELINE, JSON.stringify({ who, start: t0, end: Date.now(), cwd: process.cwd() }) + "\n");
      say(`Listo en ${who}.\nHECHO: ${who === "back" ? 1 : 2}\nRESUMEN: cambio aplicado en ${who}`);
    }, Number(process.env.FAKE_AGENT_MS ?? 1500));
    return;
  }
  if (input.includes("Tu tarea (Consulta rápida)")) {
    log({ kind: "quick" });
    return say("Pedido 201631: entregado a las 13:05.\nLECCIÓN: Para ubicar un pedido por número busca en numero_orden y correlativo a la vez.\nRESUMEN: pedido encontrado y entregado");
  }
  log({ kind: "review" });
  say(`Revisé los cambios de ambos repositorios; todo coherente.${input.includes("VERIFICADO: <número>") ? "\nVERIFICADO: 1\nVERIFICADO: 2" : ""}\nRESUMEN: back y front listos`);
});
