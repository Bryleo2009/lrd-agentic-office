import fs from "node:fs";
import path from "node:path";
import type { AgentId, EngineChoice, Provider, RuntimeStatus } from "../../shared/types";
import { config } from "../config";
import type { AgentExecutor } from "./AgentExecutor";
import { ClaudeCodeExecutor } from "./ClaudeCodeExecutor";
import { CodexCliExecutor } from "./CodexCliExecutor";
import { hiddenMcp, profile } from "../settings";

interface Saturation {
  until: number;
  reason: string;
}

const HEALTH_FILE = () => path.join(config.workspaceRoot, "engine-health.json");

/**
 * Registro de motores (Codex CLI y Claude Code) y enrutador entre ellos:
 * - recuerda temporalmente qué motor está saturado (límite de uso / servicio caído) y no lo usa hasta que vuelva;
 * - reparte los pasos en modo Automático al motor menos cargado (back y front en paralelo usan ambos);
 * - permite pedir "el otro motor" para la revisión cruzada.
 * La API de pago queda como extensión futura (ver ApiExecutor.ts), desactivada.
 */
export class RuntimeDetector {
  readonly executors: Record<Provider, AgentExecutor> = {
    codex: new CodexCliExecutor(),
    claude: new ClaudeCodeExecutor(),
  };
  private last: RuntimeStatus[] = [];
  private saturated = new Map<Provider, Saturation>();
  private load: Record<Provider, number> = { codex: 0, claude: 0 };
  private turn = 0;
  private loaded = false;

  async detect(force = false): Promise<RuntimeStatus[]> {
    this.last = await Promise.all([this.executors.codex.checkAvailability(force), this.executors.claude.checkAvailability(force)]);
    return this.snapshot();
  }

  /** Estado de los motores, incluida la saturación temporal. */
  snapshot(): RuntimeStatus[] {
    this.restore();
    const hidden = new Set(hiddenMcp());
    return this.last.map((s) => {
      const sat = this.saturationOf(s.provider);
      return {
        ...s,
        mcpServers: s.mcpServers.map((m) => ({ ...m, hidden: hidden.has(m.name) })),
        saturatedUntil: sat ? new Date(sat.until).toISOString() : null,
        saturationReason: sat?.reason ?? null,
      };
    });
  }

  /** Instalado, habilitado y con sesión (sin mirar la saturación). */
  isUsable(p: Provider): boolean {
    const s = this.last.find((x) => x.provider === p);
    return !!s && s.enabled && s.installed && s.authenticated !== false;
  }

  /** Usable y no saturado en este momento. */
  isAvailable(p: Provider): boolean {
    return this.isUsable(p) && !this.saturationOf(p);
  }

  other(p: Provider): Provider {
    return p === "codex" ? "claude" : "codex";
  }

  // ---------------- saturación temporal ----------------

  saturationOf(p: Provider): Saturation | null {
    this.restore();
    const s = this.saturated.get(p);
    if (!s) return null;
    if (Date.now() >= s.until) {
      this.saturated.delete(p);
      this.persist();
      return null;
    }
    return s;
  }

  markSaturated(p: Provider, reason: string, ms: number): Saturation {
    const s = { until: Date.now() + Math.max(60_000, ms), reason };
    this.saturated.set(p, s);
    this.persist();
    return s;
  }

  clearSaturation(p: Provider): void {
    if (this.saturated.delete(p)) this.persist();
  }

  private restore(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(HEALTH_FILE(), "utf8")) as Partial<Record<Provider, Saturation>>;
      for (const p of ["codex", "claude"] as Provider[]) {
        const s = raw[p];
        if (s && s.until > Date.now()) this.saturated.set(p, s);
      }
    } catch {
      /* sin archivo: nada saturado */
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(HEALTH_FILE()), { recursive: true });
      fs.writeFileSync(HEALTH_FILE(), JSON.stringify(Object.fromEntries(this.saturated), null, 2));
    } catch {
      /* no crítico */
    }
  }

  // ---------------- carga y elección ----------------

  /** Registra un trabajo en curso en el motor; devuelve cómo liberarlo. Síncrono, para que la elección sea atómica. */
  acquire(p: Provider): () => void {
    this.load[p]++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.load[p] = Math.max(0, this.load[p] - 1);
    };
  }

  loadOf(p: Provider): number {
    return this.load[p];
  }

  /** Motor de una misión nueva: el elegido; en Automático, el por defecto. Si está saturado y el otro no, el otro. */
  resolve(choice: EngineChoice): Provider {
    const want: Provider = choice === "codex" || choice === "claude" ? choice : config.aiEngineDefault;
    if (!this.isAvailable(want) && this.isAvailable(this.other(want))) return this.other(want);
    return want;
  }

  /**
   * Motor para un paso de un agente.
   * - Motor fijado en la misión (Codex / Claude): ese, salvo que esté saturado y el otro no.
   * - Automático: la preferencia del agente (perfil o AGENT_ENGINES) si está disponible; si no, el menos
   *   cargado (con ENGINE_STRATEGY=mix, por defecto) o el de la misión (single).
   * - `avoid`: preferir el otro motor (revisión cruzada: que revise uno distinto al que implementó).
   */
  choose(o: { agentId: AgentId; missionProvider: Provider; engine: EngineChoice; avoid?: Provider | null; prefer?: Provider | null }): Provider {
    const avail = (["codex", "claude"] as Provider[]).filter((p) => this.isAvailable(p));
    const fallback = (p: Provider) => (this.isAvailable(p) || !avail.length ? p : avail[0]);
    if (o.avoid && avail.includes(this.other(o.avoid))) return this.other(o.avoid);
    if (o.engine === "codex" || o.engine === "claude") return fallback(o.engine);
    if (o.prefer && avail.includes(o.prefer)) return o.prefer;
    const pref = profile(o.agentId).engine ?? config.agentEngines[o.agentId];
    if (pref && avail.includes(pref)) return pref;
    if (avail.length === 0) return o.missionProvider;
    if (avail.length === 1) return avail[0];
    if (config.engineStrategy !== "mix") return fallback(o.missionProvider);
    // Reparto: el menos cargado; si empatan, se alterna (empezando por el de la misión).
    if (this.load.codex !== this.load.claude) return this.load.codex < this.load.claude ? "codex" : "claude";
    const first = this.turn++ % 2 === 0 ? o.missionProvider : this.other(o.missionProvider);
    return first;
  }

  /** Compatibilidad: motor efectivo de un agente en una misión. */
  forAgent(agentId: AgentId, missionProvider: Provider, engineChoice: EngineChoice): Provider {
    return this.choose({ agentId, missionProvider, engine: engineChoice });
  }

  get(p: Provider): AgentExecutor {
    return this.executors[p];
  }
}

export const runtime = new RuntimeDetector();
