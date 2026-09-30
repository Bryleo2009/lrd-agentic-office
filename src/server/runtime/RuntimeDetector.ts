import type { AgentId, EngineChoice, Provider, RuntimeStatus } from "../../shared/types";
import { config } from "../config";
import type { AgentExecutor } from "./AgentExecutor";
import { ClaudeCodeExecutor } from "./ClaudeCodeExecutor";
import { CodexCliExecutor } from "./CodexCliExecutor";

/**
 * Registro de motores. AI_PROVIDER_MODE=cli → sólo CLIs oficiales.
 * La API de pago queda como extensión futura (ver ApiExecutor.ts), desactivada.
 */
export class RuntimeDetector {
  readonly executors: Record<Provider, AgentExecutor> = {
    codex: new CodexCliExecutor(),
    claude: new ClaudeCodeExecutor(),
  };
  private last: RuntimeStatus[] = [];

  async detect(force = false): Promise<RuntimeStatus[]> {
    this.last = await Promise.all([this.executors.codex.checkAvailability(force), this.executors.claude.checkAvailability(force)]);
    return this.last;
  }

  snapshot(): RuntimeStatus[] {
    return this.last;
  }

  isUsable(p: Provider): boolean {
    const s = this.last.find((x) => x.provider === p);
    return !!s && s.enabled && s.installed && s.authenticated !== false;
  }

  /** Resuelve el motor para una misión: explícito, o AI_ENGINE_DEFAULT en modo Automático. Sin fallback silencioso a API. */
  resolve(choice: EngineChoice): Provider {
    if (choice === "codex" || choice === "claude") return choice;
    return config.aiEngineDefault;
  }

  /** Motor efectivo para un agente dentro de una misión (AGENT_ENGINES permite mezclar). */
  forAgent(agentId: AgentId, missionProvider: Provider, engineChoice: EngineChoice): Provider {
    if (engineChoice !== "auto") return missionProvider;
    const pref = config.agentEngines[agentId];
    if (pref && this.isUsable(pref)) return pref;
    return missionProvider;
  }

  get(p: Provider): AgentExecutor {
    return this.executors[p];
  }
}

export const runtime = new RuntimeDetector();
