import type { AgentDefinition, AgentId } from "../../shared/types";
import type { NavigationGraph } from "../navigation/NavigationGraph";
import { clamp, depth, dist, FACING_VEC, iso, lerp, type Facing, type Vec } from "../office/iso";
import type { Action } from "./AgentAnimator";
import { AgentRenderer, type StatusTone } from "./AgentRenderer";
import type { Appearance } from "./CharacterRig";

export class CancelToken {
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
}

interface SeatState {
  pos: Vec;
  facing: Facing;
  approach: Vec;
  seatHeight: number;
  id: string;
}

interface Lerp {
  from: Vec;
  to: Vec;
  t: number;
  dur: number;
  resolve: () => void;
}

const MAX_SPEED = 1.85; // tiles/s
const ACCEL = 3.2;
const DECEL = 2.6;
const STRIDE = 1.15; // tiles por ciclo completo (2 pasos)

/**
 * Entidad física de un agente: posición, caminata con aceleración/deceleración siguiendo el path A*,
 * giro, sentarse/levantarse con transición, y primitivas async (walkTo, sitAt, standUp, wait) cancelables.
 */
export class AgentEntity {
  readonly id: AgentId;
  pos: Vec;
  facing: Facing = 1;
  speed = 0;
  path: Vec[] = [];
  seat: SeatState | null = null;
  /** Momento (ms) en que se sentó por última vez. */
  seatedAt = 0;
  readonly renderer: AgentRenderer;
  private moveResolve: ((ok: boolean) => void) | null = null;
  private moveToken: CancelToken | null = null;
  private lerp: Lerp | null = null;
  private waits: { t: number; resolve: (ok: boolean) => void; token: CancelToken }[] = [];
  private blockedFor = 0;
  private turnHold = 0;
  /** Otros agentes (para ceder el paso). */
  others: AgentEntity[] = [];
  /** Distancia total caminada (métrica de validación). */
  walked = 0;
  sitCount = 0;
  /** Frames caminando dentro de una celda bloqueada (debe ser 0). */
  collisionViolations = 0;
  standCount = 0;
  turnCount = 0;

  constructor(readonly def: AgentDefinition, appearance: Appearance, start: Vec, private nav: NavigationGraph) {
    this.id = def.id;
    this.pos = { ...start };
    this.renderer = new AgentRenderer(def, appearance);
    this.renderer.setFacing(this.facing);
  }

  get animator() {
    return this.renderer.animator;
  }

  setAction(a: Action): void {
    this.renderer.animator.setAction(a);
  }

  say(text: string, tone: StatusTone = "none", dur?: number): void {
    this.renderer.say(text, tone, dur);
  }

  face(f: Facing): void {
    if (f !== this.facing) {
      this.facing = f;
      this.turnCount++;
      this.renderer.setFacing(f);
    }
  }

  faceTowards(p: Vec): void {
    const dx = p.x - this.pos.x;
    const dy = p.y - this.pos.y;
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return;
    this.face(screenFacing(dx, dy, this.facing));
  }

  isSeated(): boolean {
    return this.seat !== null;
  }

  isMoving(): boolean {
    return this.path.length > 0 || this.lerp !== null;
  }

  // ---------------- primitivas async ----------------

  wait(sec: number, token: CancelToken): Promise<boolean> {
    return new Promise((resolve) => this.waits.push({ t: sec, resolve, token }));
  }

  async walkTo(target: Vec, token: CancelToken): Promise<boolean> {
    if (token.cancelled) return false;
    if (this.seat) {
      const ok = await this.standUp(token);
      if (!ok) return false;
    }
    if (dist(this.pos, target) < 0.08) return true;
    const path = this.nav.path(this.pos, target);
    if (!path) return false;
    this.cancelMove();
    this.path = path.slice(1);
    this.moveToken = token;
    return new Promise((resolve) => (this.moveResolve = resolve));
  }

  async sitAt(seat: { id: string; pos: Vec; facing: Facing; approach: Vec; seatHeight: number }, token: CancelToken): Promise<boolean> {
    if (this.seat?.id === seat.id) {
      this.face(seat.facing);
      return true;
    }
    if (!(await this.walkTo(seat.approach, token))) return false;
    this.face(seat.facing);
    if (!(await this.wait(0.15, token))) return false;
    this.animator.seatHeight = seat.seatHeight;
    this.animator.sitTarget = 1;
    this.sitCount++;
    await this.lerpTo(seat.pos, 0.5);
    this.seat = { ...seat };
    this.seatedAt = performance.now();
    return !token.cancelled;
  }

  async standUp(_token?: CancelToken): Promise<boolean> {
    if (!this.seat) return true;
    const s = this.seat;
    this.seat = null;
    this.animator.sitTarget = 0;
    this.standCount++;
    await this.lerpTo(s.approach, 0.45);
    return true;
  }

  private lerpTo(to: Vec, dur: number): Promise<void> {
    return new Promise((resolve) => {
      this.lerp = { from: { ...this.pos }, to: { ...to }, t: 0, dur, resolve };
    });
  }

  cancelMove(): void {
    if (this.moveResolve) {
      const r = this.moveResolve;
      this.moveResolve = null;
      r(false);
    }
    this.path = [];
    this.moveToken = null;
  }

  /** Detiene todo lo ambiental en curso (la actividad real toma el control). */
  interrupt(): void {
    this.cancelMove();
    for (const w of this.waits) w.resolve(false);
    this.waits = [];
  }

  // ---------------- frame ----------------

  update(dt: number, zoom: number): void {
    // esperas
    if (this.waits.length) {
      const keep: typeof this.waits = [];
      for (const w of this.waits) {
        if (w.token.cancelled) {
          w.resolve(false);
          continue;
        }
        w.t -= dt;
        if (w.t <= 0) w.resolve(true);
        else keep.push(w);
      }
      this.waits = keep;
    }

    // transición sentarse/levantarse
    if (this.lerp) {
      const l = this.lerp;
      l.t += dt;
      const k = clamp(l.t / l.dur, 0, 1);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.pos = { x: lerp(l.from.x, l.to.x, e), y: lerp(l.from.y, l.to.y, e) };
      if (k >= 1) {
        this.lerp = null;
        l.resolve();
      }
    }

    // caminata
    if (this.path.length && !this.lerp) {
      if (this.moveToken?.cancelled) {
        this.cancelMove();
      } else {
        this.stepAlongPath(dt);
      }
    } else if (!this.lerp) {
      this.speed = Math.max(0, this.speed - DECEL * 2 * dt);
    }

    const walkW = clamp(this.speed / MAX_SPEED, 0, 1);
    this.animator.walkWeight = walkW < 0.04 ? 0 : Math.min(1, walkW * 1.35);

    const sp = iso(this.pos.x, this.pos.y);
    const sitting = this.seat || this.animator.sit > 0.5;
    this.renderer.body.zIndex = depth(this.pos.x, this.pos.y, sitting ? 350 : 500);
    this.renderer.update(dt, sp.x, sp.y, zoom);
  }

  private stepAlongPath(dt: number): void {
    const target = this.path[0];
    const remainingTotal = this.remaining();
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const d = Math.hypot(dx, dy);

    // Ceder el paso a otro agente justo delante
    let yieldFactor = 1;
    if (d > 0.01) {
      const ux = dx / d;
      const uy = dy / d;
      for (const o of this.others) {
        if (o === this || o.seat) continue;
        const ox = o.pos.x - this.pos.x;
        const oy = o.pos.y - this.pos.y;
        const od = Math.hypot(ox, oy);
        if (od < 0.75 && (ox * ux + oy * uy) / (od || 1) > 0.55) {
          yieldFactor = od < 0.45 ? 0 : 0.35;
          break;
        }
      }
    }
    if (yieldFactor < 1) {
      this.blockedFor += dt;
      if (this.blockedFor > 1.4) yieldFactor = 0.6; // no bloquear para siempre
    } else this.blockedFor = 0;

    const desired = Math.min(MAX_SPEED, Math.sqrt(2 * DECEL * Math.max(0, remainingTotal))) * yieldFactor;
    if (this.speed < desired) this.speed = Math.min(desired, this.speed + ACCEL * dt);
    else this.speed = Math.max(desired, this.speed - DECEL * 1.6 * dt);
    // Pausa breve al girar bruscamente
    if (this.turnHold > 0) {
      this.turnHold -= dt;
      this.speed *= 0.6;
    }
    const minSpeed = remainingTotal > 0.02 ? 0.18 * yieldFactor : 0;
    const v = Math.max(this.speed, minSpeed);
    let step = v * dt;

    if (d > 0.001) {
      const nf = screenFacing(dx, dy, this.facing);
      if (nf !== this.facing) {
        const opposite = (nf + 2) % 4 === this.facing;
        this.face(nf);
        if (opposite) this.turnHold = 0.12;
      }
    }

    if (step >= d) {
      this.pos = { ...target };
      step -= d;
      this.path.shift();
      this.advancePhase(d);
      if (!this.path.length) {
        this.speed = 0;
        const r = this.moveResolve;
        this.moveResolve = null;
        this.moveToken = null;
        r?.(true);
      }
    } else {
      this.pos = { x: this.pos.x + (dx / d) * step, y: this.pos.y + (dy / d) * step };
      this.advancePhase(step);
    }
    if (this.nav.collision.isBlocked(Math.floor(this.pos.x), Math.floor(this.pos.y))) this.collisionViolations++;
  }

  private advancePhase(moved: number): void {
    this.walked += moved;
    this.animator.walkPhase += (moved / STRIDE) * Math.PI * 2;
  }

  private remaining(): number {
    let total = 0;
    let p = this.pos;
    for (const w of this.path) {
      total += dist(p, w);
      p = w;
    }
    return total;
  }

  screenPos(): Vec {
    return iso(this.pos.x, this.pos.y);
  }
}

/** Dirección de mirada con histéresis para no parpadear entre vistas en diagonales puras. */
export function screenFacing(dx: number, dy: number, prev: Facing): Facing {
  const sx = dx - dy;
  const sy = dx + dy;
  const len = Math.hypot(sx, sy) || 1;
  const nx = sx / len;
  const ny = sy / len;
  const score = (f: Facing) => {
    const v = FACING_VEC[f];
    const fx = v.x - v.y;
    const fy = v.x + v.y;
    return (nx * fx + ny * fy) / Math.SQRT2;
  };
  let best: Facing = prev;
  let bestScore = -Infinity;
  for (const f of [0, 1, 2, 3] as Facing[]) {
    const s = score(f);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  return score(prev) > bestScore - 0.12 ? prev : best;
}
