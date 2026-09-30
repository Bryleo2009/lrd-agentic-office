import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { isAgentId } from "../shared/agents";
import type { EngineChoice, Snapshot } from "../shared/types";
import { MissionError, orchestrator } from "./agents/AgentOrchestrator";
import { sessions as _sessions } from "./agents/AgentSession";
import { config, loadRepositories, PROJECT_ROOT, publicConfig } from "./config";
import * as repo from "./database/repo";
import { eventBus } from "./events/AgentEventBus";
import { assertApiDisabled } from "./runtime/ApiExecutor";
import { installShutdownHooks, reapOrphans } from "./runtime/childRegistry";
import { addLesson, deleteLesson, listLessons } from "./missions/lessons";
import { runtime } from "./runtime/RuntimeDetector";
import { registerWs } from "./websocket/wsHub";
import { repositoriesWithLocal, resetProfile, setRepoPath, team, updateProfile } from "./settings";

void _sessions;

// Red de seguridad: un error inesperado se registra, pero no tumba la oficina.
process.on("uncaughtException", (e) => console.error("[lrd] error no controlado:", e));
process.on("unhandledRejection", (e) => console.error("[lrd] promesa rechazada:", e));
assertApiDisabled();

const app = Fastify({ logger: { level: config.isProd ? "info" : "warn" } });
await app.register(fastifyWebsocket);

async function snapshot(): Promise<Snapshot> {
  return {
    runtime: runtime.snapshot(),
    missions: repo.listMissions(30),
    repositories: await repositoriesWithLocal(),
    config: publicConfig(),
    recentEvents: repo.recentEvents(250),
    sessions: repo.listSessions(60),
    team: team(),
  };
}

registerWs(app, snapshot);

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  const status = err instanceof MissionError ? err.statusCode : err.statusCode ?? 500;
  reply.status(status).send({ error: err.message });
});

app.get("/api/health", async () => ({ ok: true }));

// Memoria del equipo (lecciones aprendidas)
app.get("/api/lessons", async () => listLessons());
app.post("/api/lessons", async (req, reply) => {
  const b = (req.body ?? {}) as { text?: string; scope?: string };
  const l = b.text ? addLesson(String(b.text), String(b.scope || "general"), "usuario") : null;
  if (!l) return reply.code(400).send({ error: "La lección está vacía o es muy corta" });
  return l;
});
app.delete("/api/lessons/:id", async (req) => ({ ok: deleteLesson((req.params as { id: string }).id) }));
app.get("/api/snapshot", async () => snapshot());

app.get("/api/runtime", async (req) => {
  const force = (req.query as { force?: string }).force === "1";
  const rt = await runtime.detect(force);
  eventBus.broadcast({ kind: "runtime", runtime: rt });
  return rt;
});

app.get("/api/missions", async () => repo.listMissions(50));
app.get("/api/missions/:id", async (req, reply) => {
  const m = repo.getMission((req.params as { id: string }).id);
  return m ?? reply.status(404).send({ error: "Misión no encontrada" });
});
app.get("/api/missions/:id/events", async (req) => repo.missionEvents((req.params as { id: string }).id));

app.post("/api/missions", async (req) => {
  const b = (req.body ?? {}) as { prompt?: string; repositoryId?: string | null; baseBranch?: string | null; engine?: EngineChoice; allowMcp?: boolean; mcpServers?: string[] };
  const engine: EngineChoice = b.engine === "codex" || b.engine === "claude" ? b.engine : "auto";
  return orchestrator.createMission({ prompt: b.prompt ?? "", repositoryId: b.repositoryId ?? "auto", baseBranch: b.baseBranch || null, engine, allowMcp: !!b.allowMcp, mcpServers: Array.isArray(b.mcpServers) ? b.mcpServers.map(String) : undefined });
});

app.post("/api/missions/:id/cancel", async (req) => {
  await orchestrator.cancelMission((req.params as { id: string }).id);
  return { ok: true };
});

app.post("/api/agents/:id/chat", async (req) => {
  const id = (req.params as { id: string }).id;
  if (!isAgentId(id)) throw new MissionError("Agente desconocido", 404);
  const b = (req.body ?? {}) as { message?: string; missionId?: string | null; engine?: EngineChoice };
  if (!b.message?.trim()) throw new MissionError("Mensaje vacío");
  await orchestrator.chat(id, b.message.trim(), b.missionId ?? null, b.engine === "codex" || b.engine === "claude" ? b.engine : "auto");
  return { ok: true };
});

app.get("/api/agents/:id/events", async (req) => {
  const id = (req.params as { id: string }).id;
  if (!isAgentId(id)) throw new MissionError("Agente desconocido", 404);
  return repo.agentEvents(id, 200);
});

// ---------------- equipo (personalización) ----------------
app.get("/api/team", async () => team());
app.put("/api/team/:id", async (req) => {
  const id = (req.params as { id: string }).id;
  if (!isAgentId(id)) throw new MissionError("Agente desconocido", 404);
  const p = updateProfile(id, (req.body ?? {}) as Parameters<typeof updateProfile>[1]);
  eventBus.broadcast({ kind: "team", team: team() });
  return p;
});
app.post("/api/team/:id/reset", async (req) => {
  const id = (req.params as { id: string }).id;
  if (!isAgentId(id)) throw new MissionError("Agente desconocido", 404);
  const p = resetProfile(id);
  eventBus.broadcast({ kind: "team", team: team() });
  return p;
});

// ---------------- repositorios: ruta local en esta PC ----------------
app.get("/api/repositories", async () => repositoriesWithLocal());
app.put("/api/repositories/:id/local-path", async (req) => {
  const id = (req.params as { id: string }).id;
  const b = (req.body ?? {}) as { path?: string | null };
  const status = await setRepoPath(id, b.path ?? null);
  const repositories = await repositoriesWithLocal();
  eventBus.broadcast({ kind: "repositories", repositories });
  return { status, repositories };
});

app.get("/api/events/:id", async (req, reply) => {
  const e = repo.getEvent((req.params as { id: string }).id);
  return e ?? reply.status(404).send({ error: "Evento no encontrado" });
});

// ---------------- cliente ----------------
if (config.isProd) {
  const dist = path.join(PROJECT_ROOT, "dist/client");
  if (!fs.existsSync(dist)) {
    console.error("Falta dist/client. Ejecuta: npm run build");
    process.exit(1);
  }
  await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.status(404).send({ error: "No encontrado" });
    return reply.sendFile("index.html");
  });
} else {
  const middie = (await import("@fastify/middie")).default;
  await app.register(middie);
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(PROJECT_ROOT, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { port: config.port + 20000 } },
    appType: "spa",
  });
  app.use((req: any, res: any, next: () => void) => {
    if (req.url?.startsWith("/api") || req.url?.startsWith("/ws")) return next();
    vite.middlewares(req, res, next);
  });
}

// Procesos de agentes/QA que quedaron vivos de una ejecución anterior se cierran antes de retomar nada.
installShutdownHooks();
const reaped = reapOrphans();
if (reaped) console.log(`[lrd] Se cerraron ${reaped} proceso(s) de agentes que quedaron de la ejecución anterior.`);

await runtime.detect(true);
await app.listen({ port: config.port, host: config.host });

// Misiones que estaban en curso cuando se detuvo el servidor: se retoman desde donde quedaron.
const resumed = await orchestrator.resumeInterrupted().catch((e) => {
  console.error("[lrd] No se pudieron retomar misiones:", e);
  return [] as string[];
});
if (resumed.length) console.log(`[lrd] Retomando ${resumed.length} misión(es) interrumpida(s): ${resumed.join(", ")}`);

const rt = runtime.snapshot();
const line = (s: (typeof rt)[number]) => `${s.installed && s.authenticated !== false ? "✓" : "✗"} ${s.label.padEnd(12)} ${s.version ?? ""} ${s.message}`;
console.log(`
  LRD Agentic Office  →  http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}

  ${rt.map(line).join("\n  ")}
  API fallback: ${config.allowPaidApiFallback ? "ENABLED" : "disabled"} · push ${config.githubPushEnabled ? "on" : "off"} · PR ${config.githubPrEnabled ? "on" : "off"}
  Workspace: ${config.workspaceRoot}
`);
