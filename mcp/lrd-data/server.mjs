#!/usr/bin/env node
/**
 * LRD Data — servidor MCP local (stdio, sin dependencias) para Codex / Claude Code.
 *
 *   Codex ──MCP──► este proceso ──OAuth client_credentials──► lrd-back /api/v1/integrations/codex/* ──► BD solo lectura
 *
 * Guarda client_id/client_secret de cada entorno (Producción y QA), pide tokens de 15 min a /oauth/token
 * (scope database:read), los renueva solo y expone únicamente herramientas de LECTURA.
 *
 * Configuración (nunca en el repo): %USERPROFILE%\.lrd-agentic-office\lrd-mcp.json (o LRD_MCP_CONFIG)
 *   { "targets": {
 *       "production": { "baseUrl": "https://back.rollsdediego.com",    "clientId": "…", "clientSecret": "…" },
 *       "qa":         { "baseUrl": "https://back.qa.rollsdediego.com", "clientId": "…", "clientSecret": "…" } } }
 * o variables de entorno: LRD_PRODUCTION_CLIENT_ID / LRD_PRODUCTION_CLIENT_SECRET / LRD_PRODUCTION_URL (igual con LRD_QA_*).
 *
 * Uso: node server.mjs [--only production|qa]
 *   --only fija el entorno: así se registran dos servidores (lrd-pr y lrd-qa) y la oficina sabe cuál es cuál.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_URLS = { production: "https://back.rollsdediego.com", qa: "https://back.qa.rollsdediego.com" };
const API = "/api/v1/integrations/codex";
const HTTP_TIMEOUT_MS = Number(process.env.LRD_MCP_TIMEOUT_MS ?? 30_000);
const MAX_TEXT = 60_000;

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  const v = i >= 0 ? argv[i + 1] : process.env.LRD_MCP_ONLY;
  return v ? normTarget(v) : null;
})();

function normTarget(v) {
  const t = String(v ?? "").trim().toLowerCase();
  if (["production", "prod", "pr", "produccion", "producción"].includes(t)) return "production";
  if (["qa", "test", "staging"].includes(t)) return "qa";
  return t;
}

const log = (...a) => process.stderr.write(`[lrd-data] ${a.join(" ")}\n`);

// ---------------------------------------------------------------- configuración
function loadTargets() {
  const file = process.env.LRD_MCP_CONFIG || path.join(os.homedir(), ".lrd-agentic-office", "lrd-mcp.json");
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, "utf8")).targets ?? {};
  } catch (e) {
    if (e.code !== "ENOENT") log(`No se pudo leer ${file}: ${e.message}`);
  }
  const out = {};
  for (const name of new Set([...Object.keys(DEFAULT_URLS), ...Object.keys(fromFile)])) {
    const key = normTarget(name);
    const f = fromFile[name] ?? {};
    const E = (s) => process.env[`LRD_${key.toUpperCase()}_${s}`];
    const t = {
      name: key,
      baseUrl: String(E("URL") || f.baseUrl || DEFAULT_URLS[key] || "").replace(/\/+$/, ""),
      clientId: E("CLIENT_ID") || f.clientId || "",
      clientSecret: E("CLIENT_SECRET") || f.clientSecret || "",
      scope: f.scope || "database:read",
    };
    if (t.baseUrl && t.clientId && t.clientSecret && (!only || key === only)) out[key] = t;
  }
  return { file, targets: out };
}
const { file: CONFIG_FILE, targets: TARGETS } = loadTargets();
const targetNames = Object.keys(TARGETS);

// ---------------------------------------------------------------- HTTP + OAuth
const tokens = new Map(); // target → { token, exp }

async function http(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

async function token(t, force = false) {
  const cached = tokens.get(t.name);
  if (!force && cached && cached.exp > Date.now() + 30_000) return cached.token;
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: t.clientId, client_secret: t.clientSecret, scope: t.scope });
  const r = await http(`${t.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
  if (r.status !== 200 || !r.body?.access_token) {
    tokens.delete(t.name);
    throw new Error(`OAuth (${t.name}) falló con HTTP ${r.status}: ${r.body?.error_description ?? r.body?.message ?? r.body?.error ?? "sin detalle"}`);
  }
  tokens.set(t.name, { token: r.body.access_token, exp: Date.now() + Number(r.body.expires_in ?? 900) * 1000 });
  return r.body.access_token;
}

/** Llamada autenticada a la API de consultas; si el token venció (401), se renueva una vez. */
async function api(t, method, route, { query, json } = {}) {
  const url = new URL(`${t.baseUrl}${API}${route}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const r = await http(url, {
      method,
      headers: { authorization: `Bearer ${await token(t, attempt > 0)}`, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
    if (r.status === 401 && attempt === 0) continue;
    return { ...r, environment: t.name };
  }
}

// ---------------------------------------------------------------- guardas de solo lectura
const FORBIDDEN = /\b(insert|update|delete|replace|merge|upsert|alter|drop|truncate|create|rename|grant|revoke|call|exec|execute|lock|unlock|set|load|handler|into\s+outfile|into\s+dumpfile)\b/i;

/** Rechazo local (el backend valida de nuevo): una sola sentencia SELECT/WITH, sin comentarios. */
export function checkSelect(sql) {
  const s = String(sql ?? "").trim().replace(/;\s*$/, "");
  if (!s) return "La consulta está vacía.";
  if (/--|#|\/\*|\*\//.test(s)) return "No se permiten comentarios en la consulta.";
  if (s.includes(";")) return "Solo una sentencia por consulta.";
  if (!/^(select|with)\b/i.test(s)) return "Solo se permiten consultas SELECT (o WITH … SELECT).";
  if (FORBIDDEN.test(s.replace(/'(?:[^'\\]|\\.)*'/g, "''"))) return "La consulta contiene una operación que no es de lectura.";
  return null;
}

// ---------------------------------------------------------------- búsqueda de órdenes (siempre LIKE)
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
/** Hoy en Lima (las órdenes se guardan en hora local). */
const todayLima = () => new Intl.DateTimeFormat("en-CA", { timeZone: process.env.LRD_TZ || "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** Si el número termina en 12 dígitos AAMMDDhhmmss (…260930123604 → 2026-09-30), ese día es buen candidato. */
export function dateFromNumber(numero) {
  const digits = String(numero).match(/(\d{12,})$/)?.[1];
  const m = digits ? digits.slice(-12, -6) : null;
  if (!m) return null;
  const y = 2000 + Number(m.slice(0, 2));
  const mo = Number(m.slice(2, 4));
  const d = Number(m.slice(4, 6));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  return date.getMonth() === mo - 1 ? ymd(date) : null;
}

/** Ventanas de búsqueda: el día pedido (u hoy), el día del número, los últimos 7 días y sin fecha. */
export function searchWindows(numero, fecha, today = todayLima()) {
  const out = [];
  const add = (from, to, label) => !out.some((w) => w.from === from && w.to === to) && out.push({ from, to, label });
  if (fecha) add(fecha, addDays(fecha, 1), `el ${fecha}`);
  else add(today, addDays(today, 1), `hoy (${today})`);
  const fromNumber = dateFromNumber(numero);
  if (fromNumber && fromNumber !== fecha && fromNumber <= today) add(fromNumber, addDays(fromNumber, 1), `el ${fromNumber} (fecha del número)`);
  add(addDays(today, -7), addDays(today, 1), "los últimos 7 días");
  add(null, null, "sin filtro de fecha");
  return out;
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function findOrder(t, numero, fecha) {
  const n = String(numero ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(n)) throw new Error("El número de orden debe tener 3 a 80 caracteres (letras, dígitos, - o _).");
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error("La fecha debe ser AAAA-MM-DD.");
  const like = `%${likeEscape(n)}%`;
  const tried = [];
  for (const w of searchWindows(n, fecha)) {
    const dateSql = w.from ? " AND created_at >= ? AND created_at < ?" : "";
    const sql = `SELECT id, numero_orden, serie, correlativo, tipo_pedido, sucursal_codigo, metodo_envio, valor_final, created_at FROM cabecera_ordens WHERE (numero_orden LIKE ? OR correlativo LIKE ?)${dateSql} ORDER BY id DESC LIMIT 5`;
    const bindings = [like, like, ...(w.from ? [w.from, w.to] : [])];
    const r = await api(t, "POST", "/query", { json: { sql, bindings } });
    if (r.status !== 200 || !r.body?.success) return { found: false, environment: t.name, error: r.body?.message ?? `HTTP ${r.status}`, tried: [...tried, w.label] };
    tried.push(w.label);
    const rows = r.body.data?.rows ?? [];
    if (rows.length) return { found: true, environment: t.name, searched: w.label, matches: rows, tried };
  }
  return { found: false, environment: t.name, tried, note: `Sin coincidencias con LIKE '%${n}%' en numero_orden ni correlativo.` };
}

// ---------------------------------------------------------------- herramientas
const targetProp = only
  ? {}
  : { target: { type: "string", enum: targetNames.length ? targetNames : ["production", "qa"], description: "Entorno: production (Producción) o qa. Por defecto production." } };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const envLabel = only ? ` Entorno fijo: ${only === "production" ? "Producción" : only.toUpperCase()}.` : "";

const TOOLS = [
  {
    name: "lrd_list_targets",
    description: `Entornos de datos LRD configurados (Producción / QA) y si la autenticación funciona.${envLabel}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "lrd_find_order",
    description: `Busca órdenes SIEMPRE con LIKE sobre numero_orden y correlativo (el prefijo tipo ORD-XXXX- varía; sirve el número entero o solo los últimos dígitos). Primero en la fecha indicada u hoy (Lima), luego la fecha AAMMDD del número, luego los últimos 7 días y al final sin fecha. Máx. 5 coincidencias.${envLabel}`,
    inputSchema: {
      type: "object",
      properties: { ...targetProp, numero: { type: "string", description: "Número de orden completo o sus últimos dígitos." }, fecha: { type: "string", description: "Opcional, AAAA-MM-DD." } },
      required: ["numero"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "lrd_order_get",
    description: `Detalle de una orden (cabecera enmascarada, productos, trazabilidad, pagos, envíos). Si el número no es exacto, primero la ubica con LIKE y, si hay una sola coincidencia, trae su detalle.${envLabel}`,
    inputSchema: { type: "object", properties: { ...targetProp, numero_orden: { type: "string" } }, required: ["numero_orden"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "lrd_query_schema",
    description: `Lista las tablas, o columnas/índices/llaves de una tabla.${envLabel}`,
    inputSchema: { type: "object", properties: { ...targetProp, table: { type: "string", description: "Opcional: nombre de la tabla." } }, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "lrd_select",
    description: `Ejecuta UNA consulta SELECT (o WITH … SELECT) de solo lectura con parámetros (?). El backend limita filas y tiempo. Para buscar órdenes usa LIKE (o lrd_find_order).${envLabel}`,
    inputSchema: {
      type: "object",
      properties: { ...targetProp, sql: { type: "string" }, bindings: { type: "array", items: { type: ["string", "number", "boolean", "null"] }, maxItems: 100 } },
      required: ["sql"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

function pickTarget(args) {
  if (!targetNames.length)
    throw new Error(`No hay entornos configurados. Crea ${CONFIG_FILE} con clientId/clientSecret de Producción y/o QA (ver mcp/lrd-data/README.md).`);
  const want = only ?? normTarget(args?.target || "production");
  const t = TARGETS[want];
  if (!t) throw new Error(`El entorno "${want}" no está configurado. Disponibles: ${targetNames.join(", ")}.`);
  return t;
}

const result = (r) => {
  const { status, body, environment } = r;
  return { environment, status, ...(body && typeof body === "object" ? body : { body }) };
};

async function callTool(name, args = {}) {
  switch (name) {
    case "lrd_list_targets": {
      const out = [];
      for (const t of Object.values(TARGETS)) {
        try {
          const r = await api(t, "GET", "/auth-check");
          out.push({ target: t.name, baseUrl: t.baseUrl, ok: r.status === 200 && !!r.body?.success, status: r.status, message: r.body?.message ?? null });
        } catch (e) {
          out.push({ target: t.name, baseUrl: t.baseUrl, ok: false, message: e.message });
        }
      }
      return { targets: out, fixed: only, configFile: CONFIG_FILE };
    }
    case "lrd_find_order":
      return findOrder(pickTarget(args), args.numero, args.fecha);
    case "lrd_order_get": {
      const t = pickTarget(args);
      const n = String(args.numero_orden ?? "").trim();
      if (!/^[A-Za-z0-9_-]{5,80}$/.test(n)) throw new Error("numero_orden inválido.");
      const r = await api(t, "GET", `/orders/${encodeURIComponent(n)}`);
      if (r.status !== 404) return result(r);
      // Número incompleto (sin prefijo): ubicarla con LIKE antes de concluir que no existe.
      const f = await findOrder(t, n);
      if (f.found && f.matches.length === 1 && f.matches[0].numero_orden !== n) {
        const full = f.matches[0].numero_orden;
        return { ...result(await api(t, "GET", `/orders/${encodeURIComponent(full)}`)), resolvedFrom: n, numero_orden: full, searched: f.searched };
      }
      return { ...result(r), note: f.found ? `No hay una orden con número exacto "${n}"; coincidencias con LIKE (${f.searched}):` : `No existe con número exacto ni con LIKE '%${n}%' (${f.tried.join(", ")}).`, matches: f.matches ?? [] };
    }
    case "lrd_query_schema":
      return result(await api(pickTarget(args), "GET", "/schema", { query: { table: args.table } }));
    case "lrd_select": {
      const err = checkSelect(args.sql);
      if (err) throw new Error(err);
      const bindings = Array.isArray(args.bindings) ? args.bindings : [];
      return result(await api(pickTarget(args), "POST", "/query", { json: { sql: String(args.sql).trim().replace(/;\s*$/, ""), bindings } }));
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC (MCP sobre stdio)
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (res) => id !== undefined && send({ jsonrpc: "2.0", id, result: res });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: only ? `lrd-data-${only}` : "lrd-data", version: "1.0.0" },
        instructions:
          "Datos LRD de solo lectura. Órdenes: busca siempre con lrd_find_order (LIKE, primero hoy); lrd_order_get solo con el número completo o deja que lo resuelva. Un 404 es 'no encontrado', no una herramienta rota.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      try {
        const data = await callTool(name, params?.arguments ?? {});
        const text = JSON.stringify(data, null, 2);
        const isError = data && typeof data === "object" && (data.success === false || (typeof data.status === "number" && data.status >= 400 && data.status !== 404));
        return reply({ content: [{ type: "text", text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(recortado)` : text }], isError: !!isError });
      } catch (e) {
        return reply({ content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default:
      if (method?.startsWith("notifications/")) return;
      return fail(-32601, `Método no soportado: ${method}`);
  }
}

if (process.env.LRD_MCP_NO_STDIO !== "1") {
  if (!targetNames.length) log(`Sin entornos configurados: crea ${CONFIG_FILE} (ver mcp/lrd-data/README.md).`);
  else log(`Entornos: ${targetNames.join(", ")}${only ? ` (fijo: ${only})` : ""}`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m).catch((e) => log(e.stack ?? e.message));
  });
  rl.on("close", () => process.exit(0));
}
