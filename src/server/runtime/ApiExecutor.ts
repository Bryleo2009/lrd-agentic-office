/**
 * Extensión FUTURA: ejecución vía API de pago (OpenAI / Anthropic).
 *
 * DESACTIVADA. No existe ninguna llamada HTTP a api.openai.com ni api.anthropic.com en este proyecto.
 * Sólo podría habilitarse si el usuario configura explícitamente:
 *   AI_PROVIDER_MODE=api  y  ALLOW_PAID_API_FALLBACK=true
 * y se implementa una clase que cumpla AgentExecutor. Hasta entonces, cualquier intento lanza error.
 */
import { config } from "../config";

export function assertApiDisabled(): void {
  if (config.aiProviderMode !== "cli" && !config.allowPaidApiFallback) {
    throw new Error("AI_PROVIDER_MODE distinto de 'cli' requiere ALLOW_PAID_API_FALLBACK=true explícito.");
  }
}

export const API_EXECUTOR_AVAILABLE = false as const;
