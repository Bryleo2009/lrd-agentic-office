import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Lectura mínima del config.toml de Codex (solo encabezados de sección y `enabled`), para saber
 * de dónde viene cada servidor MCP: definido en [mcp_servers.<n>] o aportado por un plugin
 * ([plugins."<nombre>@<origen>"]). Nunca se leen ni se exponen valores (env, tokens, rutas).
 */
export interface CodexConfigInfo {
  mcpServers: string[];
  enabledPlugins: string[];
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function parseCodexConfig(toml: string): CodexConfigInfo {
  const mcp = new Set<string>();
  const plugins = new Map<string, boolean>();
  let plugin: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (h) {
      plugin = null;
      const key = h[1];
      const m = key.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))$/);
      if (m) mcp.add(m[1] ?? m[2] ?? m[3]);
      const p = key.match(/^plugins\.(?:"([^"]+)"|'([^']+)'|([\w@-]+))$/);
      if (p) {
        plugin = p[1] ?? p[2] ?? p[3];
        plugins.set(plugin, true);
      }
      continue;
    }
    const en = line.match(/^enabled\s*=\s*(true|false)\b/);
    if (en && plugin) plugins.set(plugin, en[1] === "true");
  }
  return { mcpServers: [...mcp], enabledPlugins: [...plugins].filter(([, on]) => on).map(([k]) => k) };
}

export function readCodexConfig(): CodexConfigInfo | null {
  try {
    return parseCodexConfig(fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Plugin que aporta el servidor MCP `server` (p. ej. lrd → "lrd-connector@personal").
 * Coincide por nombre: el nombre del plugin (antes de @) empieza con el del servidor o lo contiene
 * como palabra. Si hay 0 o varias coincidencias devuelve null (no se adivina).
 */
export function pluginForServer(server: string, cfg: CodexConfigInfo): string | null {
  const s = server.toLowerCase();
  const hits = cfg.enabledPlugins.filter((p) => {
    const name = p.split("@")[0].toLowerCase();
    return name === s || name.startsWith(`${s}-`) || name.startsWith(`${s}_`) || new RegExp(`(^|[-_])${s.replace(/[^\w-]/g, "")}([-_]|$)`).test(name);
  });
  return hits.length === 1 ? hits[0] : null;
}
