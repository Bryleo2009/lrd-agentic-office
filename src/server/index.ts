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
import { runtime } from "./runtime/RuntimeDetector";
import { registerWs } from "./websocket/wsHub";

void _sessions;
assertApiDisabled();

const app = Fastify({ logger: { level: config.isProd ? "info" : "warn" } });
await app.register(fastifyWebsocket);

async function snapshot(): Promise<Snapshot> {
  return {
    runtime: runtime.snapshot(),
    missions: repo.listMissions(30),
    repositories: loadRepositories().repositories,
    config: publicConfig(),
    recentEvents: repo.recentEvents(250),
    sessions: repo.listSessions(60),
  };
}

registerWs(app, snapshot);

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  const status = err instanceof MissionError ? err.statusCode : err.statusCode ?? 500;
  reply.status(status).send({ error: err.message });
});

app.get("/api/health", async () => ({ ok: true }));
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
  const b = (req.body ?? {}) as { prompt?: string; repositoryId?: string; baseBranch?: string; engine?: EngineChoice };
  if (!b.repositoryId) throw new MissionError("Falta repositoryId");
  const engine: EngineChoice = b.engine === "codex" || b.engine === "claude" ? b.engine : "auto";
  return orchestrator.createMission({ prompt: b.prompt ?? "", repositoryId: b.repositoryId, baseBranch: b.baseBranch, engine });
});

app.post("/api/missions/:id/cancel", async (req) => {
  await orchestrator.cancelMission((req.params as { id: string }).id);
  return { ok: true };
});

app.post("/api/agents/:id/chat", async (req) => {
  const id = (req.params as { id: string }).id;
  if (!isAgentId(id)) throw new MissionError("Agente desconocido", 404);
  const b = (req.body ?? {}) as { message?: string; missionId?: string | null };
  if (!b.message?.trim()) throw new MissionError("Mensaje vacío");
  await orchestrator.chat(id, b.message.trim(), b.missionId ?? null);
  return { ok: true };
});

app.get("/api/agents/:id/events", async (req) => {
  const id = (req.params as { id: string }).id;
  if (!isAgentId(id)) throw new MissionError("Agente desconocido", 404);
  return repo.agentEvents(id, 200);
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

await runtime.detect(true);
await app.listen({ port: config.port, host: config.host });

const rt = runtime.snapshot();
const line = (s: (typeof rt)[number]) => `${s.installed && s.authenticated !== false ? "✓" : "✗"} ${s.label.padEnd(12)} ${s.version ?? ""} ${s.message}`;
console.log(`
  LRD Agentic Office  →  http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}

  ${rt.map(line).join("\n  ")}
  API fallback: ${config.allowPaidApiFallback ? "ENABLED" : "disabled"} · push ${config.githubPushEnabled ? "on" : "off"} · PR ${config.githubPrEnabled ? "on" : "off"}
  Workspace: ${config.workspaceRoot}
`);
