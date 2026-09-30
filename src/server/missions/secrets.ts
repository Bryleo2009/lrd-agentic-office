/**
 * Revisión de secretos antes de publicar: busca en las líneas AGREGADAS del diff claves, tokens y
 * archivos de credenciales. Si encuentra algo, la oficina no hace commit/push sin tu decisión.
 */

export interface SecretFinding {
  file: string;
  line: number | null;
  kind: string;
  /** Fragmento con el valor enmascarado (nunca se muestra el secreto completo). */
  preview: string;
}

const PATTERNS: [string, RegExp][] = [
  ["Clave privada", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Token de GitHub", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["Token de Slack", /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/],
  ["API key de Anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["API key de OpenAI", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["Clave de Stripe", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ["API key de Google", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["Cadena de conexión con contraseña", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"]{6,}@[^\s'"]+/i],
];

/** Asignación de un valor literal a algo que se llama contraseña/secreto/token. */
const ASSIGN = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|client[_-]?secret|auth)[A-Za-z0-9_.-]*)["']?\s*(?:=|:|=>)\s*["']([^"'\s]{8,})["']/i;

/** Valores que claramente no son secretos reales. */
const PLACEHOLDER = /^(?:\$\{?[\w.]+\}?|<[^>]+>|%[\w]+%|x{4,}|\*{4,}|changeme|change_me|your[_-]?\w*|example\w*|dummy\w*|test\w*|fake\w*|placeholder|secret|password|null|undefined|none|todo|redacted)$/i;
const CODE_REF = /\b(?:env|getenv|process\.env|import\.meta\.env|config|settings|os\.environ|ENV\[|secrets\.)/;

/** Archivos que no deberían publicarse. */
const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.(?!example|sample|template|dist|defaults)[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks)|credentials\.json|service-account[\w.-]*\.json|\.npmrc|\.pypirc|\.netrc)$/i;

const mask = (s: string) => (s.length <= 8 ? "••••" : `${s.slice(0, 4)}••••${s.slice(-2)}`);

/** Busca secretos en un diff unificado (solo líneas agregadas) y en la lista de archivos cambiados. */
export function scanSecrets(patch: string, files: string[] = []): SecretFinding[] {
  const out: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (f: SecretFinding) => {
    const k = `${f.file}:${f.line}:${f.kind}`;
    if (!seen.has(k) && out.length < 20) {
      seen.add(k);
      out.push(f);
    }
  };
  for (const f of files) if (SECRET_FILES.test(f.replace(/\\/g, "/"))) add({ file: f, line: null, kind: "Archivo de credenciales", preview: f });

  let file = "";
  let line = 0;
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+ (?:b\/)?/, "").trim();
      continue;
    }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) {
      line = Number(h[1]) - 1;
      continue;
    }
    if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    line++;
    if (!raw.startsWith("+")) continue;
    const text = raw.slice(1);
    if (/\.(?:lock|snap|svg|min\.js|map)$|package-lock\.json$|yarn\.lock$|composer\.lock$/i.test(file)) continue;
    for (const [kind, re] of PATTERNS) {
      const m = text.match(re);
      if (m) add({ file, line, kind, preview: text.trim().replace(m[0], mask(m[0])).slice(0, 160) });
    }
    const a = text.match(ASSIGN);
    if (a && !PLACEHOLDER.test(a[2]) && !CODE_REF.test(text) && !/^[a-z]+(?:[._-][a-z]+)*$/.test(a[2]) && /\d|[A-Z].*[a-z]|[^\w]/.test(a[2]))
      add({ file, line, kind: `Valor literal en ${a[1]}`, preview: text.trim().replace(a[2], mask(a[2])).slice(0, 160) });
  }
  return out;
}

/** Archivos de migraciones de base de datos entre los cambiados. */
export function migrationFiles(files: string[]): string[] {
  return files.filter((f) => /(?:^|\/)(?:database\/migrations|migrations|migrate|db\/migrate|prisma\/migrations|alembic\/versions|flyway|liquibase)\/|\.sql$/i.test(f.replace(/\\/g, "/")));
}
