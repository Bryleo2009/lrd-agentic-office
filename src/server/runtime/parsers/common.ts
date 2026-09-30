import path from "node:path";

export type CommandKind = "test" | "build" | "read" | "search" | "git" | "other";

const TEST_RE =
  /\b(php\s+artisan\s+test|phpunit|pest|jest|vitest|pytest|mocha|karma|ng\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test)\b/i;
const BUILD_RE = /\b(npm|pnpm|yarn)\s+(run\s+)?build\b|\bng\s+build\b|\bvite\s+build\b|\btsc\b(?!.*--version)|\bnpm\s+run\s+(lint|typecheck)\b/i;
const READ_RE = /^\s*(?:cat|nl\s+-ba|head|tail|less|bat)\s+(?:-[\w-]+\s+)*['"]?([^\s'"|;&]+)|^\s*sed\s+-n\s+['"]?[\d,]+p['"]?\s+['"]?([^\s'"|;&]+)/;
const SEARCH_RE = /^\s*(rg|grep|ag|ack|find|fd|git\s+grep|ls)\b/;

/** Quita envoltorios tipo `bash -lc "..."`. */
export function unwrapShell(cmd: string | string[]): string {
  let c = Array.isArray(cmd) ? cmd : [cmd];
  if (c.length >= 3 && /(^|\/)(ba|z)?sh$/.test(c[0]) && /^-\w*c$/.test(c[1])) return c.slice(2).join(" ");
  const s = c.join(" ");
  const m = s.match(/^(?:\/\S+\/)?(?:ba|z)?sh\s+-\w*c\s+(['"])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

export function classifyCommand(raw: string): { kind: CommandKind; file?: string } {
  const cmd = raw.trim();
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
