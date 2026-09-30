const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);

/**
 * Traduce fallos técnicos (código de salida, stderr, mensajes de la API) a mensajes
 * que una persona entiende: qué pasó y qué puede hacer. El detalle técnico se conserva al final.
 */
export interface Explained {
  /** Frase corta: qué pasó. */
  title: string;
  /** Qué hacer al respecto. */
  hint: string;
}

type Rule = { re: RegExp; explain: (engine: string, fix: string, text: string) => Explained };

const RULES: Rule[] = [
  {
    // Va primero: un config.toml roto impide arrancar y su mensaje puede mencionar MCP, red, etc.
    re: /error loading config|config\.toml|invalid transport|missing field .?(command|url)/i,
    explain: (e, fix, text) => {
      const server = text.match(/mcp_servers\.([\w-]+)/)?.[1];
      const file = fix === "codex" ? "~/.codex/config.toml" : "la configuración de Claude Code";
      return server
        ? {
            title: `${e} no pudo leer su configuración: el servidor MCP «${server}» está mal definido`,
            hint: `En ${file}, la sección [mcp_servers.${server}] necesita \`command\` (servidor local) o \`url\` (servidor remoto), y tu versión de ${e} debe soportar ese tipo. Corrígela o coméntala, o actualiza ${e}. Si no tienes esa sección, «${server}» viene de un plugin de ${e} que la oficina no pudo identificar para desactivarlo: permite ese servidor de datos en la misión o desactiva el plugin. Puedes comprobarlo con \`${fix} mcp list\`.`,
          }
        : { title: `${e} no pudo leer su configuración`, hint: `Revisa ${file}: tiene un valor inválido. El detalle técnico indica la línea.` };
    },
  },
  {
    re: /not logged in|please (log ?in|login)|unauthori[sz]ed|\b401\b|invalid[_ ]api[_ ]key|authentication|expired.*token|token.*expired|refresh token/i,
    explain: (e, fix) => ({ title: `${e} no tiene la sesión iniciada`, hint: `Abre una terminal y ejecuta \`${fix} login\`; luego vuelve a lanzar la misión.` }),
  },
  {
    re: /rate.?limit|\b429\b|usage limit|quota|too many requests|insufficient_quota|limit reached|hit your .*limit/i,
    explain: (e) => ({ title: `${e} alcanzó su límite de uso`, hint: "Espera unos minutos o cambia el motor de la misión al otro (Codex ↔ Claude Code)." }),
  },
  {
    re: /overloaded|\b52[09]\b|\b50[234]\b|service unavailable|internal server error/i,
    explain: (e) => ({ title: `El servicio de ${e} está saturado o caído`, hint: "No es un problema de tu código. Reintenta en unos minutos o usa el otro motor." }),
  },
  {
    re: /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|stream (disconnected|error)|network|socket hang up|connection (reset|closed|error)/i,
    explain: (e) => ({ title: `${e} perdió la conexión a internet`, hint: "Revisa tu conexión (o VPN/proxy) y vuelve a intentar." }),
  },
  {
    re: /context (length|window)|maximum context|too many tokens|prompt is too long|input is too long/i,
    explain: (e) => ({ title: `La tarea superó la memoria de trabajo de ${e}`, hint: "Divide la misión en partes más pequeñas o lánzala de nuevo para empezar con una sesión limpia." }),
  },
  {
    re: /model.{0,40}(not found|does not exist|not supported|unsupported|not available|no access)/i,
    explain: (e) => ({ title: `El modelo configurado para ${e} no está disponible`, hint: "Revisa el modelo en la configuración del CLI (o quítalo para usar el predeterminado)." }),
  },
  {
    re: /unexpected argument|unknown (option|flag|argument)|unrecognized (option|argument)|invalid value for/i,
    explain: (e, fix) => ({ title: `Tu versión de ${e} no reconoce una opción que usa la oficina`, hint: `Actualiza el CLI (${fix === "codex" ? "`npm i -g @openai/codex`" : "`claude update`"}) y reinicia la oficina.` }),
  },
  {
    re: /mcp.{0,80}(fail|error|could not|couldn.t|timed? ?out|exited|not found)/i,
    explain: (e) => ({ title: `Un servidor de datos (MCP) no pudo arrancar en ${e}`, hint: "Lanza la misión sin datos MCP o revisa la configuración de ese servidor." }),
  },
  {
    re: /not a git repository/i,
    explain: (e) => ({ title: `${e} no encontró el repositorio de trabajo`, hint: "Revisa la ruta del repositorio en Ajustes y vuelve a lanzar la misión." }),
  },
  {
    re: /EACCES|EPERM|operation not permitted|permission denied|access is denied/i,
    explain: (e) => ({ title: `El sistema bloqueó un acceso que ${e} necesitaba`, hint: "Puede ser un antivirus o permisos de carpeta. Revisa que la carpeta de trabajo sea tuya y no esté bloqueada." }),
  },
];

function engineInfo(provider: "codex" | "claude"): { name: string; fix: string } {
  return provider === "codex" ? { name: "Codex", fix: "codex" } : { name: "Claude Code", fix: "claude" };
}

/** Última línea útil de un texto de error (sin trazas ni líneas vacías). */
export function lastUsefulLine(text: string): string {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s|^\s*\^|^node:internal|^-+$/.test(l));
  // Preferir la última línea que describe el error; una línea suelta como "in `x`" no dice nada.
  const errLine = [...lines].reverse().find((x) => /error|failed|invalid|cannot|could not|denied|not found/i.test(x));
  let l = errLine ?? lines[lines.length - 1] ?? "";
  const i = lines.lastIndexOf(l);
  if (i >= 0 && i + 1 < lines.length && lines[i + 1].length < 60) l = `${l} ${lines[i + 1]}`;
  return l.length > 200 ? l.slice(0, 199) + "…" : l;
}

/** Explica por qué un CLI (Codex / Claude Code) se detuvo. `code` es el código de salida del proceso, si lo hay. */
export function explainCliFailure(provider: "codex" | "claude", code: number | null | undefined, text: string): Explained {
  const { name, fix } = engineInfo(provider);
  for (const r of RULES) if (r.re.test(text)) return r.explain(name, fix, text);
  if (code === null || code === 137 || code === 143 || code === -9 || code === 3221225786)
    return { title: `${name} fue detenido desde fuera`, hint: "El proceso se cerró de golpe (falta de memoria, cierre de la terminal o un antivirus). Vuelve a lanzar la misión." };
  if (code === 127 || code === 9009)
    return { title: `No se encontró el programa ${fix}`, hint: `Instala ${name} o indica su ruta en ${fix === "codex" ? "CODEX_COMMAND" : "CLAUDE_COMMAND"} dentro de .env.` };
  const last = lastUsefulLine(text);
  if (last)
    return { title: `${name} se detuvo por un error`, hint: `Lo último que dijo fue: "${last}". Si se repite, prueba con el otro motor.` };
  return {
    title: `${name} se cerró sin explicar el motivo`,
    hint: `No dejó ningún mensaje. Suele pasar cuando la sesión de ${name} expiró: ejecuta \`${fix} login\` en una terminal, o cambia al otro motor.`,
  };
}

/** Detalle del evento: la explicación primero y el dato técnico al final, para quien lo necesite. */
export function explainedDetail(ex: Explained, code: number | null | undefined, raw: string): string {
  const tech = tail(raw || "", 2500).trim();
  const codeTxt = code === undefined ? "" : code === null ? " (proceso terminado por señal)" : ` (código de salida ${code})`;
  return `${ex.hint}${tech || codeTxt ? `\n\nDetalle técnico${codeTxt}:\n${tech || "(sin mensaje)"}` : ""}`;
}

/** Motivo legible de un comando de terminal que falló, según su código de salida. */
export function commandExitReason(exit: number | null | undefined): string {
  switch (exit) {
    case 127:
    case 9009:
      return "el comando no existe en esta máquina";
    case 126:
      return "el archivo no se puede ejecutar (permisos)";
    case 124:
      return "se agotó el tiempo";
    case 130:
      return "fue interrumpido";
    case 137:
    case 143:
    case null:
      return "fue detenido (memoria o cierre externo)";
    case 2:
      return "se usó de forma incorrecta (opciones o ruta inválidas)";
    default:
      return "terminó con errores";
  }
}

/** Explica por qué falló una operación de git (sobre todo el push) y qué hacer. */
export function explainGitError(message: string, output = ""): Explained {
  const t = `${message}\n${output}`;
  if (/non-fast-forward|fetch first|\[rejected\]|updates were rejected/i.test(t))
    return { title: "GitHub rechazó la publicación: la rama remota tiene commits que tu copia no tiene", hint: "Alguien (u otro intento) publicó en esa rama. La oficina intenta integrarlos sola; si hubo conflicto, revisa la rama o pide el cambio en una misión nueva." };
  if (/GH006|protected branch|branch is protected/i.test(t))
    return { title: "GitHub no permite publicar en esa rama (está protegida)", hint: "Usa una rama agentic/… (la oficina nunca publica en ramas protegidas) o revisa las reglas del repositorio." };
  if (/permission denied \(publickey\)|authentication failed|could not read username|403|not authorized|denied to/i.test(t))
    return { title: "GitHub rechazó tus credenciales de git", hint: "Comprueba que en esta PC puedes hacer `git push` a ese repositorio (llave SSH o credenciales de Git). Luego pide \"publica los cambios\" en el chat." };
  if (/pre-push|husky|hook .*(failed|declined)|hook declined/i.test(t))
    return { title: "Un hook de git del repositorio (pre-push) bloqueó la publicación", hint: `El repo ejecuta verificaciones antes de publicar y alguna falló. ${lastUsefulLine(output) ? `Dijo: "${lastUsefulLine(output)}". ` : ""}Corrígelo (o pídeselo al agente) y vuelve a pedir que publique.` };
  if (/could not resolve host|unable to access|connection (timed out|refused|reset)|network/i.test(t))
    return { title: "No hubo conexión con GitHub al publicar", hint: "Revisa tu conexión y pide \"publica los cambios\" en el chat para reintentar." };
  if (/conflict/i.test(t)) return { title: "Hay conflictos con los cambios que ya estaban en la rama remota", hint: "Resuélvelos en la rama o lanza una misión nueva desde la rama actualizada." };
  const last = lastUsefulLine(output) || lastUsefulLine(message);
  return { title: "git no pudo completar la publicación", hint: last ? `Lo último que dijo git: "${last}".` : "Revisa el detalle técnico." };
}

/**
 * ¿El error significa que el motor está saturado (límite de uso o servicio caído)?
 * Devuelve cuánto evitarlo: lo que diga el mensaje ("try again in 2 hours", "resets at 3pm",
 * "retry after 120 seconds") o `defaultMs`. Un servicio saturado se evita menos tiempo que un límite de uso.
 */
export function saturationFrom(text: string, defaultMs: number, now = new Date()): { ms: number; reason: string } | null {
  const t = text || "";
  const limit = /rate.?limit|\b429\b|usage limit|quota|too many requests|insufficient_quota|limit reached|hit your .*limit|l[ií]mite de uso/i.test(t);
  const overloaded = !limit && /overloaded|\b52[09]\b|\b50[234]\b|service unavailable|saturad[oa]|capacity/i.test(t);
  if (!limit && !overloaded) return null;
  const reason = limit ? "llegó a su límite de uso" : "servicio saturado";
  let ms: number | null = null;
  const dur = t.match(/(?:try again|retry|resets?|vuelve|intenta de nuevo)[^\n]{0,20}?\bin\s+((?:\d+\s*(?:h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\s*(?:and\s*)?)+)/i);
  if (dur) {
    ms = 0;
    for (const m of dur[1].matchAll(/(\d+)\s*(h|m|s)/gi)) ms += Number(m[1]) * (m[2].toLowerCase() === "h" ? 3_600_000 : m[2].toLowerCase() === "m" ? 60_000 : 1000);
  }
  const after = t.match(/retry[- ]after[:\s]+(\d+)/i);
  if (!ms && after) ms = Number(after[1]) * 1000;
  const at = t.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!ms && at) {
    let h = Number(at[1]) % 24;
    if (at[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (at[3]?.toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, Number(at[2] ?? 0), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    ms = d.getTime() - now.getTime();
  }
  if (!ms) ms = overloaded ? Math.min(defaultMs, 5 * 60_000) : defaultMs;
  return { ms: Math.min(ms, 24 * 3_600_000), reason };
}
