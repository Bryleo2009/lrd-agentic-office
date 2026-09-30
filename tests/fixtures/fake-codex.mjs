#!/usr/bin/env node
// Codex falso para pruebas: rechaza desactivar node_repl (herramienta integrada) y sale sin leer stdin.
const a = process.argv.slice(2);
const has = (s) => a.includes(s);
if (has("--version")) { console.log("codex-cli 0.159.2"); process.exit(0); }
if (a[0] === "exec" && has("--help")) { console.log("--json --cd --sandbox --skip-git-repo-check --color resume  If not provided as an argument (or if `-` is used), instructions are read from stdin"); process.exit(0); }
if (a[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
// FAKE_LRD_ONLY_IN: lrd solo existe en el config.toml de esa carpeta (como un config de proyecto).
const lrdHere = !process.env.FAKE_LRD_ONLY_IN || process.cwd() === process.env.FAKE_LRD_ONLY_IN;
if (a[0] === "mcp") { console.log(JSON.stringify([...(lrdHere ? [{ name: "lrd", enabled: true, transport: { type: "stdio" } }] : []), { name: "node_repl", enabled: true, transport: { type: "stdio" } }])); process.exit(0); }
if (a[0] === "exec") {
  if (a.includes("mcp_servers.node_repl.enabled=false")) {
    process.stderr.write("Error loading config: invalid mcp_servers.node_repl: missing field `command`\n");
    process.exit(1);
  }
  if (a.includes("mcp_servers.lrd.enabled=false") && (!lrdHere || process.env.FAKE_LRD_BROKEN || process.env.FAKE_LRD_PLUGIN)) {
    process.stderr.write("Error loading config.toml: invalid transport\nin `mcp_servers.lrd`\n");
    process.exit(1);
  }
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    const lrdOff = a.includes("mcp_servers.lrd.enabled=false") || a.includes("plugins.lrd-connector@personal.enabled=false");
    console.log(JSON.stringify({ type: "thread.started", thread_id: "th_test" }));
    console.log(JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: `OK len=${input.length} lrdOff=${lrdOff}` } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
  });
}
