import path from "node:path";

export type CommandKind = "test" | "build" | "read" | "search" | "git" | "other";

const TEST_RE =
  /\b(php\s+artisan\s+test|phpunit|pest|jest|vitest|pytest|mocha|karma|ng\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test)\b/i;
const BUILD_RE = /\b(npm|pnpm|yarn)\s+(run\s+)?build\b|\bng\s+build\b|\bvite\s+build\b|\btsc\b(?!.*--version)|\bnpm\s+run\s+(lint|typecheck)\b/i;
const READ_RE = /^\s*(?:cat|nl\s+-ba|head|tail|less|bat|type|get-content|gc)\s+(?:-[\w-]+\s+)*['"]?([^\s'"|;&]+)|^\s*sed\s+-n\s+['"]?[\d,]+p['"]?\s+['"]?([^\s'"|;&]+)/i;
const SEARCH_RE = /^\s*(rg|grep|ag|ack|find|fd|git\s+grep|ls|dir|get-childitem|gci|select-string|findstr)\b/i;

/**
 * Quita envoltorios de shell: `bash -lc "…"`, y en Windows `"…\\pwsh.exe" -Command "…"`,
 * `powershell.exe -NoProfile -Command '…'` o `cmd.exe /d /s /c "…"`.
 */
export function unwrapShell(cmd: string | string[]): string {
  const c = Array.isArray(cmd) ? cmd : [cmd];
  if (c.length >= 3 && /(^|\/)(ba|z)?sh$/.test(c[0]) && /^-\w*c$/.test(c[1])) return c.slice(2).join(" ");
  if (c.length >= 3 && /(pwsh|powershell)(\.exe)?$/i.test(c[0])) {
    const i = c.findIndex((a) => /^-(c|command)$/i.test(a));
    if (i >= 0) return c.slice(i + 1).join(" ");
  }
  const s = c.join(" ").trim();
  const m = s.match(/^(?:\/\S+\/)?(?:ba|z)?sh\s+-\w*c\s+(['"])([\s\S]*)\1$/);
  if (m) return m[2];
  // Windows: "C:\\…\\pwsh.exe" [-NoProfile …] -Command "…"
  const w = s.match(/^(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|\S*(?:pwsh|powershell)(?:\.exe)?)\s+(?:-\w+\s+)*?-(?:c|command)\s+([\s\S]+)$/i);
  if (w) return stripQuotes(w[1]);
  const k = s.match(/^(?:"[^"]*cmd(?:\.exe)?"|\S*cmd(?:\.exe)?)\s+(?:\/\w\s+)*\/c\s+([\s\S]+)$/i);
  if (k) return stripQuotes(k[1]);
  return s;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  return t;
}

/** El comando "de verdad" dentro de `cd x && …`, `Set-Location x; …` o una tubería. */
function mainCommand(cmd: string): string {
  const parts = cmd
    .split(/\s*(?:&&|;|\|\|)\s*/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(cd|set-location|sl|pushd|popd|\$env:|export|set)\b/i.test(p));
  return (parts[0] ?? cmd).split(/\s*\|\s*/)[0].trim();
}

const q = (s: string | undefined) => (s ? `«${s.length > 40 ? s.slice(0, 39) + "…" : s}»` : "");
const fileArg = (s: string) => {
  const m = s.match(/(?:^|\s)(?:-(?:Path|LiteralPath)\s+)?["']?([\w./\\:-]+\.[a-z0-9]{1,6})["']?(?:\s|$)/i);
  return m ? path.basename(m[1].replace(/\\/g, "/")) : "";
};

/**
 * Describe en palabras lo que hace un comando ("Leyendo Console.vue", "Pasando el linter"…),
 * para mostrarlo en la oficina en vez de la línea de terminal. El comando exacto queda en la Terminal.
 */
export function describeCommand(raw: string): string {
  const full = unwrapShell(raw).trim();
  const c = mainCommand(full);
  const l = c.toLowerCase();
  const arg = (re: RegExp) => c.match(re)?.[1];
  if (/check-backend/.test(l)) return "Corriendo el chequeo completo del back";
  if (/check-frontend/.test(l)) return "Corriendo el chequeo completo del front";
  if (/pint-changed|\bpint\b/.test(l)) return "Revisando el formato del código (Pint)";
  if (/migrate-ci|artisan\s+migrate/.test(l)) return "Probando las migraciones";
  if (/artisan\s+optimize:clear/.test(l)) return "Limpiando la caché de Laravel";
  if (/artisan\s+test|phpunit|\bpest\b|vitest|\bjest\b|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|pytest/.test(l)) return "Corriendo las pruebas";
  if (/lint|eslint/.test(l)) return "Pasando el linter";
  if (/type-?check|\btsc\b|vue-tsc/.test(l)) return "Verificando los tipos";
  if (/(npm|pnpm|yarn)\s+(run\s+)?build|vite\s+build/.test(l)) return "Compilando el proyecto";
  if (/(npm|pnpm|yarn)\s+(ci|install|i)\b|composer\s+install/.test(l)) return "Instalando dependencias";
  if (/composer\s+validate/.test(l)) return "Validando composer.json";
  if (/^php\s+-l\b/.test(l)) return `Revisando la sintaxis de ${fileArg(c) || "PHP"}`;
  if (/^git\s+status/.test(l)) return "Revisando qué archivos cambiaron";
  if (/^git\s+diff/.test(l)) return /--stat|--name/.test(l) ? "Mirando qué archivos se tocaron" : "Mirando los cambios";
  if (/^git\s+log/.test(l)) return "Revisando el historial de commits";
  if (/^git\s+show\s+\S+:\S+/.test(l)) return `Leyendo ${path.basename(arg(/git\s+show\s+\S+?:(\S+)/i) ?? "")} en otra rama`;
  if (/^git\s+show/.test(l)) return "Mirando un commit";
  if (/^git\s+blame/.test(l)) return `Viendo quién cambió ${fileArg(c)}`.trim();
  if (/^git\s+(branch|rev-parse|remote|ls-remote)/.test(l)) return "Verificando la rama";
  if (/^git\s+(ls-files|ls-tree)/.test(l)) return "Listando archivos del repositorio";
  if (/^git\s+grep|^(rg|grep|ag|ack|findstr)\b|select-string/.test(l)) {
    const pat = arg(/(?:-Pattern\s+|\s)["']([^"']+)["']/i) ?? arg(/^(?:git\s+grep|rg|grep|findstr)\s+(?:-\S+\s+)*([^\s-][^\s]*)/i);
    return `Buscando ${q(pat) || "en el código"}`.trim();
  }
  if (/^(cat|type|get-content|gc|head|tail|less|bat|nl)\b|^sed\s+-n/.test(l)) return `Leyendo ${fileArg(c) || "un archivo"}`;
  if (/^(ls|dir|get-childitem|gci|tree|find|fd)\b/.test(l)) {
    const d = arg(/(?:-Path\s+|\s)["']?((?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)*)["']?\s*$/i);
    return `Explorando ${d && !d.startsWith("-") ? d.replace(/\\/g, "/") : "la carpeta"}`;
  }
  if (/^graphify\b/.test(l)) return "Consultando el mapa del código (Graphify)";
  if (/^gh\s+run/.test(l)) return "Consultando GitHub Actions";
  if (/^gh\s+pr/.test(l)) return "Consultando el pull request";
  if (/^(curl|invoke-webrequest|invoke-restmethod|iwr|irm)\b/.test(l)) return "Consultando un servicio";
  if (/^(node|python3?|php)\s+-(e|c|r)\b/.test(l)) return "Haciendo una verificación rápida";
  if (/^(npm|npx|pnpm|yarn)\s+/.test(l)) return `Ejecutando ${c.split(/\s+/).slice(0, 3).join(" ")}`;
  const bin = path.basename(c.split(/\s+/)[0] ?? "").replace(/\.exe$/i, "");
  return bin ? `Ejecutando ${bin}` : "Ejecutando un comando";
}

export function classifyCommand(raw: string): { kind: CommandKind; file?: string } {
  const cmd = mainCommand(unwrapShell(raw.trim()));
  if (TEST_RE.test(cmd)) return { kind: "test" };
  if (BUILD_RE.test(cmd)) return { kind: "build" };
  if (/^\s*git\s/.test(cmd)) return { kind: "git" };
  const r = cmd.match(READ_RE);
  if (r) return { kind: "read", file: r[1] ?? r[2] };
  if (SEARCH_RE.test(cmd)) return { kind: "search" };
  return { kind: "other" };
}

export function base(p: string | undefined | null): string {
  if (!p) return "";
  return path.basename(p);
}

export function rel(p: string | undefined | null, cwd: string): string {
  if (!p) return "";
  const r = path.isAbsolute(p) ? path.relative(cwd, p) : p;
  return r.startsWith("..") ? p : r.split(path.sep).join("/");
}

export function firstLine(s: string, n = 140): string {
  const l = (s || "").trim().split(/\r?\n/).find((x) => x.trim()) ?? "";
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
}

export function clip(s: string, n = 4000): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} caracteres más)` : s;
}

/** Resumen corto de salida de tests/build para burbujas y terminal. */
export function summarizeOutput(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter((l) =>
    /(tests?:|passed|failed|failing|passing|error|✓|✗|PASS|FAIL|built in|Tests:|Assertions|OK \(|ERRORS!)/i.test(l),
  );
  return (interesting.length ? interesting.slice(-4) : lines.slice(-3)).join("\n");
}
