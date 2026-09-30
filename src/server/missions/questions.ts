import { norm } from "./MissionPlanner";

/**
 * Preguntas al usuario: un agente que no puede avanzar sin un dato que solo el usuario decide
 * responde con una línea "PREGUNTA: …" (y opcionalmente "OPCIONES: a | b | c"). La oficina pausa
 * ese paso, se lo muestra al usuario y, con la respuesta, el agente continúa.
 */

/** Instrucción para los prompts: cuándo (y cuándo no) preguntar. */
export const ASK_RULE = `Si te falta un dato IMPRESCINDIBLE que solo el usuario puede decidir (una ambigüedad real que cambia el resultado y que no puedes resolver leyendo el código o los datos), NO adivines: responde SOLO con una línea "PREGUNTA: …" (una pregunta concreta) y, si aplica, otra "OPCIONES: a | b | c", y termina ahí. La misión se pausa hasta que responda. Si puedes decidir razonablemente, decide, sigue y explica el supuesto en tu resumen.`;

export interface AskedQuestion {
  text: string;
  options: string[];
  /** Respuesta sin las líneas PREGUNTA/OPCIONES. */
  rest: string;
}

/** Extrae la pregunta de una respuesta del agente (si la hay). */
export function extractQuestion(text: string): AskedQuestion | null {
  let q: string | null = null;
  let options: string[] = [];
  const rest = text
    .split(/\r?\n/)
    .filter((line) => {
      const m = line.match(/^\s*[-•]?\s*\**\s*PREGUNTA\s*\**\s*:\s*\**\s*(.+)$/i);
      if (m && !q) {
        q = m[1].replace(/\*+$/, "").trim();
        return false;
      }
      const o = line.match(/^\s*[-•]?\s*\**\s*OPCIONES\s*\**\s*:\s*\**\s*(.+)$/i);
      if (o) {
        options = o[1]
          .split(/\s*[|;]\s*/)
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 5);
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  if (!q || (q as string).length < 4) return null;
  return { text: (q as string).slice(0, 600), options, rest };
}

/** Clave estable de una pregunta (paso + texto normalizado). */
export function questionKey(scope: string, text: string): string {
  return `${scope}:${norm(text)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 120)}`;
}

/**
 * Interpreta la respuesta a una aprobación: devuelve el índice de la opción elegida.
 * Acepta el texto exacto del botón, su inicio, o respuestas naturales ("sí, dale" / "no").
 * `yes` y `no` son los índices de las opciones que significan aprobar y rechazar.
 */
export function pickOption(answer: string, options: string[], yes = 0, no = options.length - 1): number {
  const a = norm(answer).trim();
  const byText = options.findIndex((o) => norm(o) === a);
  if (byText >= 0) return byText;
  const prefix = options.findIndex((o) => a.length >= 3 && (norm(o).startsWith(a) || a.startsWith(norm(o))));
  if (prefix >= 0) return prefix;
  const partial = options.findIndex((o) => {
    const head = norm(o).split(/[:(—-]/)[0].trim();
    return head.length >= 4 && a.includes(head);
  });
  if (partial >= 0) return partial;
  if (/^(no\b|nop|nada|cancela|deten|detén|espera|mejor no|rechaz)/.test(a)) return no;
  if (/^(si\b|sí\b|ok\b|okay|dale|adelante|aprueb|apruebo|publica|hazlo|de acuerdo|va\b|claro|confirm)/.test(a)) return yes;
  return -1;
}
