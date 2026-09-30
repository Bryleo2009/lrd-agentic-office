import type { AgentId } from "../../shared/types";
import { POIS } from "../environment/OfficeMap";
import type { Vec } from "../office/iso";
import type { Action } from "./AgentAnimator";
import { CancelToken, type AgentEntity } from "./AgentEntity";
import type { StatusTone } from "./AgentRenderer";
import { AgentFSM, type Seat, type WorldApi } from "./AgentFSM";

/** Punto del pasillo frente a la sala de control, bien visible, desde donde Atlas saluda. */
const CALL_SPOT: Vec = { x: 5.5, y: 11.8 };

export type Station = "desk" | "qa_terminal" | "mission_screen" | "meeting";

export type Scenario =
  | { kind: "handoff"; to: AgentId; text: string }
  | { kind: "celebrate"; text?: string }
  | { kind: "blocked"; text: string };

export interface RealState {
  where: Station;
  action: Action;
  tone: StatusTone;
}

/**
 * Árbitro entre vida ambiental y actividad real:
 *   if runtime.hasRealTask(): stopAmbientBehavior(); executeRealBehavior();
 *   else executeAmbientBehavior();
 */
export class AgentBrain {
  readonly fsm: AgentFSM;
  /** Estado real deseado (derivado de eventos reales). null = sin tarea real. */
  real: RealState | null = null;
  private scenarios: Scenario[] = [];
  private token: CancelToken | null = null;
  private running = false;
  private mode: "ambient" | "real" | "engaged" = "ambient";
  private engagedUntil = 0;
  private engagedWith: AgentEntity | null = null;
  private clock = 0;
  meetingSeat: Seat | null = null;
  private holdUntil = 0;
  /** Llamando al usuario (informe pendiente): texto de la burbuja que repite mientras saluda. */
  private calling: string | null = null;
  private lastCallSay = -99;
  /** Métricas para validación */
  realActions = 0;

  constructor(readonly e: AgentEntity, private w: WorldApi) {
    this.fsm = new AgentFSM(e, w);
  }

  /** true si está sentado en su asiento de reunión desde hace al menos `sec` segundos. */
  meetingReadyFor(sec: number): boolean {
    return !!this.meetingSeat && this.e.seat?.id === this.meetingSeat.id && performance.now() - this.e.seatedAt > sec * 1000;
  }

  hasRealTask(): boolean {
    return this.real !== null || this.scenarios.length > 0 || this.clock < this.holdUntil || this.calling !== null;
  }

  /**
   * Llamar la atención del usuario: sale al pasillo, mira al frente y saluda con la mano,
   * repitiendo `text` cada pocos segundos hasta que se llame a setCalling(null).
   * Una tarea real (nueva misión) tiene prioridad; al terminarla vuelve a llamar.
   */
  setCalling(text: string | null): void {
    if (text === this.calling) return;
    const was = this.calling;
    this.calling = text;
    this.e.renderer.setAttention(text !== null);
    if (text) {
      this.lastCallSay = -99;
      if (this.mode !== "real") this.preempt();
    } else if (was && !this.real) {
      this.e.setAction("idle");
      this.e.renderer.setTone("none");
    }
  }

  get isCalling(): boolean {
    return this.calling !== null;
  }

  get modeName() {
    return this.mode;
  }

  /** Activa/actualiza el estado real (interrumpe lo ambiental). */
  setReal(state: Partial<RealState> & { where?: Station }): void {
    const prev = this.real;
    this.real = {
      where: state.where ?? prev?.where ?? "desk",
      action: state.action ?? prev?.action ?? "type",
      tone: state.tone ?? prev?.tone ?? "work",
    };
    this.e.renderer.setTone(this.real.tone);
    if (this.mode !== "real") this.preempt();
    else if (!this.e.isMoving() && this.atStation(this.real.where)) this.applyAction();
  }

  clearReal(holdSeconds = 0): void {
    this.real = null;
    this.holdUntil = this.clock + holdSeconds;
    if (!this.scenarios.length) this.e.renderer.setTone("none");
  }

  pushScenario(s: Scenario): void {
    this.scenarios.push(s);
    if (this.mode !== "real") this.preempt();
  }

  /** Otro agente se acerca a hablar: detenerse, mirarlo y conversar. */
  engage(other: AgentEntity, seconds: number, action: Action = "talk"): boolean {
    if (this.calling) return false;
    if (this.mode === "real" && this.real && this.real.where !== "desk") return false;
    if (this.mode === "ambient") {
      this.token?.cancel();
      this.e.interrupt();
      this.mode = "engaged";
    }
    this.engagedWith = other;
    this.engagedUntil = this.clock + seconds;
    if (!this.e.isSeated()) this.e.faceTowards(other.pos);
    this.e.setAction(action);
    return true;
  }

  private preempt(): void {
    this.token?.cancel();
    this.e.interrupt();
    this.mode = "real";
    this.running = false;
  }

  private atStation(where: Station): boolean {
    const target = this.stationTarget(where);
    if (target.seat) return this.e.seat?.id === target.seat.id;
    return !!target.pos && Math.hypot(this.e.pos.x - target.pos.x, this.e.pos.y - target.pos.y) < 0.15;
  }

  private stationTarget(where: Station): { seat?: Seat; pos?: Vec; facing?: 0 | 1 | 2 | 3 } {
    if (where === "desk") return { seat: this.w.deskSeat(this.e.id) };
    if (where === "meeting") return this.meetingSeat ? { seat: this.meetingSeat } : { seat: this.w.deskSeat(this.e.id) };
    const p = POIS.find((x) => x.id === where)!;
    return { pos: p.pos, facing: p.facing };
  }

  private applyAction(): void {
    if (!this.real) return;
    this.e.animator.standingTest = this.real.action === "test" && !this.e.isSeated() && this.real.where !== "qa_terminal";
    this.e.setAction(this.clock < this.engagedUntil ? "talk" : this.real.action);
    this.e.renderer.setTone(this.real.tone);
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.mode === "engaged") {
      if (this.hasRealTask()) {
        this.mode = "real";
        this.running = false;
      } else if (this.clock >= this.engagedUntil) {
        this.mode = "ambient";
        this.engagedWith = null;
        this.e.setAction("idle");
      } else {
        if (this.engagedWith && !this.e.isSeated()) this.e.faceTowards(this.engagedWith.pos);
        return;
      }
    }
    if (this.hasRealTask()) {
      if (this.mode === "ambient") this.preempt();
      if (!this.running) void this.runReal();
    } else {
      if (this.mode === "real" && !this.running) {
        this.mode = "ambient";
        this.e.renderer.setTone("none");
      }
      if (this.mode === "ambient" && !this.running) void this.runAmbient();
    }
  }

  private async runAmbient(): Promise<void> {
    this.running = true;
    const token = new CancelToken();
    this.token = token;
    try {
      await this.fsm.run(token);
    } finally {
      if (this.token === token) this.running = false;
    }
  }

  private async runReal(): Promise<void> {
    this.running = true;
    const token = new CancelToken();
    this.token = token;
    try {
      while (!token.cancelled && this.hasRealTask()) {
        const sc = this.scenarios.shift();
        if (sc) {
          await this.runScenario(sc, token);
          continue;
        }
        if (this.real) {
          if (!this.atStation(this.real.where)) {
            this.e.setAction("idle");
            const t = this.stationTarget(this.real.where);
            const ok = t.seat ? await this.e.sitAt(t.seat, token) : await this.e.walkTo(t.pos!, token);
            if (!ok) {
              if (token.cancelled) break;
              await this.e.wait(0.5, token);
              continue;
            }
            if (t.facing !== undefined) this.e.face(t.facing);
          }
          this.applyAction();
        } else if (this.calling) {
          if (Math.hypot(this.e.pos.x - CALL_SPOT.x, this.e.pos.y - CALL_SPOT.y) > 0.15) {
            this.e.setAction("idle");
            const ok = await this.e.walkTo(CALL_SPOT, token);
            if (!ok) {
              if (token.cancelled) break;
              await this.e.wait(0.5, token);
              continue;
            }
          }
          // Mientras caminaba, el usuario pudo haberle hecho clic (y el aviso ya no aplica).
          const text = this.calling;
          if (!text) continue;
          this.e.face(1);
          this.e.setAction("wave");
          this.e.renderer.setTone("success");
          if (this.clock - this.lastCallSay > 7) {
            this.lastCallSay = this.clock;
            this.e.say(text, "success", 5);
          }
        }
        await this.e.wait(0.3, token);
      }
    } finally {
      if (this.token === token) this.running = false;
    }
  }

  private async runScenario(sc: Scenario, token: CancelToken): Promise<void> {
    this.realActions++;
    const e = this.e;
    switch (sc.kind) {
      case "handoff": {
        const target = this.w.entity(sc.to);
        const spot = this.w.visitSpot(target, e);
        e.setAction("idle");
        e.renderer.setTone("talk");
        if (spot) await e.walkTo(spot, token);
        if (token.cancelled) return;
        e.faceTowards(target.pos);
        e.setAction("talk");
        e.say(sc.text, "talk", 4.5);
        this.w.engage(sc.to, e, 4.2, "talk");
        await e.wait(4.2, token);
        e.setAction("idle");
        e.renderer.setTone(this.real?.tone ?? "none");
        break;
      }
      case "celebrate":
        if (sc.text) e.say(sc.text, "success", 3.5);
        e.renderer.setTone("success");
        e.setAction("celebrate");
        await e.wait(2.2, token);
        e.setAction(this.real?.action ?? "idle");
        e.renderer.setTone(this.real?.tone ?? "none");
        break;
      case "blocked":
        e.say(sc.text, "blocked", 6);
        e.renderer.setTone("blocked");
        e.setAction("blocked");
        await e.wait(5, token);
        break;
    }
  }
}
