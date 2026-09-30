import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Backend falso con el mismo contrato que lrd-back: /oauth/token (client_credentials) y /api/v1/integrations/codex/*.
const ORDERS = [{ id: 7, numero_orden: "ORD-RDMI-260930123604", serie: "B001", correlativo: "000123", created_at: "2026-09-30 12:36:04" }];
const calls: { path: string; body?: any; auth?: string }[] = [];
let tokenN = 0;
let expireNext = false;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url!, "http://x");
    const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ path: url.pathname, body, auth: req.headers.authorization });
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (url.pathname === "/oauth/token") {
      if (body.client_secret !== "s3cret" || body.grant_type !== "client_credentials" || body.scope !== "database:read") return json(401, { error: "invalid_client" });
      return json(200, { token_type: "Bearer", expires_in: 900, access_token: `tok${++tokenN}` });
    }
    if (req.headers.authorization !== `Bearer tok${tokenN}` || expireNext) {
      expireNext = false;
      return json(401, { message: "Unauthenticated." });
    }
    const p = url.pathname.replace("/api/v1/integrations/codex", "");
    if (p === "/auth-check") return json(200, { success: true, scope: "database:read" });
    if (p === "/schema") return json(200, { success: true, data: { tables: [{ name: "cabecera_ordens" }] } });
    if (p === "/query") {
      const like = String(body.bindings?.[0] ?? "").replace(/%/g, "");
      const from = body.bindings?.[2];
      const rows = ORDERS.filter((o) => (o.numero_orden.includes(like) || o.correlativo.includes(like)) && (!from || o.created_at.slice(0, 10) === from));
      return json(200, { success: true, data: { rows, row_count: rows.length, truncated: false } });
    }
    const m = p.match(/^\/orders\/(.+)$/);
    if (m) {
      const o = ORDERS.find((x) => x.numero_orden === decodeURIComponent(m[1]));
      return o ? json(200, { success: true, data: { order: o, products: [] } }) : json(404, { success: false, message: `La orden ${m[1]} no existe.`, error: { type: "not_found" } });
    }
    json(404, { message: "Not Found" });
  });
});

async function mcp(env: Record<string, string>, args: string[] = []) {
  const p = spawn(process.execPath, ["mcp/lrd-data/server.mjs", ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (v: any) => void>();
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve);
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, a: Record<string, unknown> = {}) => {
    const r = await rpc("tools/call", { name, arguments: a });
    return { isError: r.result.isError, text: r.result.content[0].text as string, data: (() => { try { return JSON.parse(r.result.content[0].text); } catch { return null; } })() };
  };
  return { rpc, call, close: () => p.kill() };
}

test("MCP local de LRD: OAuth client_credentials, solo lectura y órdenes con LIKE", { timeout: 30_000 }, async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-mcp-"));
  fs.writeFileSync(path.join(dir, "lrd-mcp.json"), JSON.stringify({ targets: { production: { baseUrl: base, clientId: "c1", clientSecret: "s3cret" }, qa: { baseUrl: base, clientId: "c2", clientSecret: "otro" } } }));
  const s = await mcp({ LRD_MCP_CONFIG: path.join(dir, "lrd-mcp.json") });
  try {
    const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.serverInfo.name, "lrd-data");
    const tools = (await s.rpc("tools/list")).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name), ["lrd_list_targets", "lrd_find_order", "lrd_order_get", "lrd_query_schema", "lrd_select"]);
    assert.ok(tools.every((t: any) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false));

    // Solo lectura: se rechaza localmente, sin tocar el backend.
    const before = calls.length;
    for (const sql of ["UPDATE cabecera_ordens SET estado = 1", "SELECT 1; DELETE FROM pagos", "select * from x -- y"]) assert.equal((await s.call("lrd_select", { sql })).isError, true, sql);
    assert.equal(calls.length, before, "nada llegó al backend");

    // Solo los últimos dígitos: lrd_order_get da 404 exacto, la ubica con LIKE y trae el detalle completo.
    const got = await s.call("lrd_order_get", { numero_orden: "260930123604" });
    assert.equal(got.isError, false, got.text);
    assert.equal(got.data.numero_orden, "ORD-RDMI-260930123604");
    assert.equal(got.data.resolvedFrom, "260930123604");
    assert.equal(got.data.data.order.id, 7);
    const q = calls.filter((c) => c.path.endsWith("/query"));
    assert.match(q[0].body.sql, /numero_orden LIKE \? OR correlativo LIKE \?[\s\S]*created_at >= \?/);
    assert.equal(q[0].body.bindings[0], "%260930123604%");

    // lrd_find_order: la fecha del número (260930 → 2026-09-30) se prueba antes que "sin fecha".
    const f = await s.call("lrd_find_order", { numero: "123604" });
    assert.equal(f.data.found, true);
    const g = await s.call("lrd_find_order", { numero: "260930123604" });
    assert.match(g.data.searched, /2026-09-30/);

    // Un token vencido se renueva solo (una vez); el token se reutiliza entre llamadas.
    const tokensBefore = tokenN;
    expireNext = true;
    assert.equal((await s.call("lrd_query_schema")).data.success, true);
    assert.equal(tokenN, tokensBefore + 1);

    // QA con credenciales malas: error claro, sin exponer el secreto.
    const qa = await s.call("lrd_query_schema", { target: "qa" });
    assert.equal(qa.isError, true);
    assert.match(qa.text, /OAuth \(qa\) falló con HTTP 401/);
    assert.doesNotMatch(qa.text, /otro|s3cret/);
  } finally {
    s.close();
  }

  // --only qa: entorno fijo, sin parámetro "target".
  const only = await mcp({ LRD_MCP_CONFIG: path.join(dir, "lrd-mcp.json") }, ["--only", "qa"]);
  try {
    const tools = (await only.rpc("tools/list")).result.tools;
    assert.equal(tools.find((t: any) => t.name === "lrd_select").inputSchema.properties.target, undefined);
  } finally {
    only.close();
    server.close();
  }
});

test("la oficina reconoce lrd-pr como Producción y lrd-qa como QA", async () => {
  const { mcpEnv, mcpRules } = await import("../src/server/missions/MissionPlanner");
  assert.equal(mcpEnv("lrd-pr"), "Producción");
  assert.equal(mcpEnv("lrd-qa"), "QA");
  assert.equal(mcpEnv("lrd-prices"), null);
  assert.match(mcpRules(["lrd-pr", "lrd-qa"]), /lrd-pr = Producción, lrd-qa = QA/);
});
