import type { AgentId } from "../../shared/types";
import { POIS, type PoiDef } from "../environment/OfficeMap";
import { pick, rand, type Facing, type Vec } from "../office/iso";
import type { Action } from "./AgentAnimator";
import { CancelToken, type AgentEntity } from "./AgentEntity";

export type AmbientState =
  | "IDLE_DESK"
  | "IDLE_STANDING"
  | "WALKING"
  | "READING"
  | "COFFEE"
  | "TALKING"
  | "RETURNING"
  | "SITTING"
  | "THINKING";

export interface Seat {
  id: string;
  pos: Vec;
  facing: Facing;
  approach: Vec;
  seatHeight: number;
}

/** Lo que el mundo ofrece a los cerebros de los agentes. */
export interface WorldApi {
  entity(id: AgentId): AgentEntity;
  entities(): AgentEntity[];
  deskSeat(id: AgentId): Seat;
  poiSeat(p: PoiDef): Seat;
  reserve(poiId: string, who: AgentId): boolean;
  release(poiId: string, who: AgentId): void;
  reservedBy(poiId: string): AgentId | null;
  visitSpot(target: AgentEntity, from: AgentEntity): Vec | null;
  isAmbient(id: AgentId): boolean;
  engage(target: AgentId, with_: AgentEntity, seconds: number, action?: Action): boolean;
  roomOf(id: AgentId): string;
}

type Routine = "desk" | "coffee" | "visit" | "board" | "stretch" | "sofa" | "window" | "shelf";

/**
 * Máquina de estados de vida autónoma. Rutinas con duraciones naturales, sin cambios caóticos.
 * Ejemplo: IDLE_DESK → STAND → WALK → COFFEE → TALK → RETURN → SIT.
 */
export class AgentFSM {
  state: AmbientState = "IDLE_DESK";
  routine: Routine = "desk";
  private last: Routine = "stretch"; // la primera rutina es de escritorio (breve)
  private first = true;
  /** Número de comportamientos ambientales (no escritorio) ejecutados — para validación. */
  behaviors = 0;
  readonly history: { t: number; routine: Routine }[] = [];

  constructor(private e: AgentEntity, private w: WorldApi) {}

  private choose(): Routine {
    if (this.last !== "desk") return "desk";
    const room = this.w.roomOf(this.e.id);
    const weights: [Routine, number][] = [
      ["coffee", 3],
      ["visit", 3],
      ["board", room === "engineering" ? 2.5 : room === "qa" ? 2 : 0.8],
      ["stretch", 1.5],
      ["sofa", room === "operations" ? 1.6 : 0.8],
      ["window", 0.6],
      ["shelf", room === "control" ? 2 : 0],
    ];
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [k, wt] of weights) {
      r -= wt;
      if (r <= 0) return k;
    }
    return "coffee";
  }

  async run(token: CancelToken): Promise<void> {
    const r = this.choose();
    this.routine = r;
    this.last = r;
    if (r !== "desk") {
      this.behaviors++;
      this.history.push({ t: performance.now(), routine: r });
    }
    switch (r) {
      case "desk":
        await this.desk(token);
        break;
      case "coffee":
        await this.coffee(token);
        break;
      case "visit":
        await this.visit(token);
        break;
      case "board":
        await this.board(token);
        break;
      case "stretch":
        await this.stretch(token);
        break;
      case "sofa":
        await this.sofa(token);
        break;
      case "window":
        await this.standAt("corridor_window", "think", "THINKING", rand(4, 7), token);
        break;
      case "shelf":
        await this.standAt("control_shelf", "read", "READING", rand(5, 9), token);
        break;
    }
  }

  private async desk(token: CancelToken): Promise<void> {
    const e = this.e;
    if (!e.isSeated()) {
      this.state = "RETURNING";
      e.setAction("idle");
      if (!(await e.sitAt(this.w.deskSeat(e.id), token))) return;
    }
    this.state = "IDLE_DESK";
    const total = this.first ? rand(4, 22) : rand(14, 38);
    this.first = false;
    let elapsed = 0;
    while (elapsed < total && !token.cancelled) {
      const a: Action = pick(["type", "type", "type", "read", "think", "idle", "type"] as Action[]);
      e.setAction(a);
      this.state = a === "read" ? "READING" : a === "think" ? "THINKING" : "IDLE_DESK";
      const d = a === "type" ? rand(5, 11) : rand(3, 7);
      if (!(await e.wait(d, token))) return;
      elapsed += d;
    }
  }

  private async coffee(token: CancelToken): Promise<void> {
    const e = this.e;
    const spots = ["coffee_1", "coffee_2", "water"].filter((p) => !this.w.reservedBy(p));
    if (!spots.length) return this.stretch(token);
    const id = pick(spots);
    if (!this.w.reserve(id, e.id)) return;
    try {
      const p = POIS.find((x) => x.id === id)!;
      e.setAction("idle");
      this.state = "WALKING";
      if (!(await e.walkTo(p.pos, token))) return;
      e.face(p.facing);
      this.state = "COFFEE";
      e.setAction("idle");
      if (!(await e.wait(rand(1.5, 2.5), token))) return;
      e.setAction("coffee");
      // ¿alguien más en la cafetería? conversar
      const mate = this.w.entities().find((o) => o !== e && !o.isMoving() && Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < 2.6 && this.w.isAmbient(o.id));
      if (mate && Math.random() < 0.8) {
        e.faceTowards(mate.pos);
        this.state = "TALKING";
        e.setAction("talk");
        this.w.engage(mate.id, e, 5, "talk");
        if (!(await e.wait(rand(4, 6), token))) return;
        e.setAction("coffee");
      }
      if (!(await e.wait(rand(4, 8), token))) return;
    } finally {
      this.w.release(id, e.id);
      this.state = "RETURNING";
    }
  }

  private async visit(token: CancelToken): Promise<void> {
    const e = this.e;
    const room = this.w.roomOf(e.id);
    const others = this.w.entities().filter((o) => o !== e && this.w.isAmbient(o.id) && o.isSeated());
    if (!others.length) return this.stretch(token);
    const same = others.filter((o) => this.w.roomOf(o.id) === room);
    const target = same.length && Math.random() < 0.6 ? pick(same) : pick(others);
    const spot = this.w.visitSpot(target, e);
    if (!spot) return this.stretch(token);
    this.state = "WALKING";
    e.setAction("idle");
    if (!(await e.walkTo(spot, token))) return;
    if (!this.w.isAmbient(target.id)) return;
    e.faceTowards(target.pos);
    this.state = "TALKING";
    e.setAction("talk");
    const dur = rand(5, 9);
    this.w.engage(target.id, e, dur, "talk");
    if (!(await e.wait(dur, token))) return;
    e.setAction("idle");
    this.state = "RETURNING";
  }

  private async board(token: CancelToken): Promise<void> {
    const room = this.w.roomOf(this.e.id);
    const opts = room === "engineering" ? ["whiteboard", "whiteboard_2", "eng_printer"] : room === "qa" ? ["qa_terminal", "qa_terminal_2"] : room === "control" ? ["mission_screen", "control_shelf"] : ["ops_cabinet"];
    const free = opts.filter((p) => !this.w.reservedBy(p));
    if (!free.length) return this.stretch(token);
    const id = pick(free);
    await this.standAt(id, id.startsWith("qa_terminal") ? "type" : pick(["think", "read"] as Action[]), "THINKING", rand(5, 10), token);
  }

  private async standAt(poiId: string, action: Action, st: AmbientState, dur: number, token: CancelToken): Promise<void> {
    const e = this.e;
    if (!this.w.reserve(poiId, e.id)) return this.stretch(token);
    try {
      const p = POIS.find((x) => x.id === poiId)!;
      this.state = "WALKING";
      e.setAction("idle");
      if (!(await e.walkTo(p.pos, token))) return;
      e.face(p.facing);
      this.state = st;
      e.setAction(action);
      if (!(await e.wait(dur, token))) return;
      e.setAction("idle");
    } finally {
      this.w.release(poiId, e.id);
      this.state = "RETURNING";
    }
  }

  private async stretch(token: CancelToken): Promise<void> {
    const e = this.e;
    if (e.isSeated()) await e.standUp(token);
    this.state = "IDLE_STANDING";
    e.setAction("idle");
    if (!(await e.wait(rand(2.5, 4.5), token))) return;
    e.setAction("think");
    this.state = "THINKING";
    await e.wait(rand(1.5, 3), token);
    e.setAction("idle");
  }

  private async sofa(token: CancelToken): Promise<void> {
    const e = this.e;
    const free = ["sofa_1", "sofa_2", "high_table_a", "high_table_b"].filter((p) => !this.w.reservedBy(p));
    if (!free.length) return this.coffee(token);
    const id = pick(free);
    if (!this.w.reserve(id, e.id)) return;
    try {
      const p = POIS.find((x) => x.id === id)!;
      this.state = "WALKING";
      e.setAction("idle");
      if (p.kind === "seat") {
        if (!(await e.sitAt(this.w.poiSeat(p), token))) return;
        this.state = "SITTING";
      } else {
        if (!(await e.walkTo(p.pos, token))) return;
        e.face(p.facing);
        this.state = "IDLE_STANDING";
      }
      e.setAction(pick(["read", "coffee", "idle"] as Action[]));
      if (!(await e.wait(rand(8, 15), token))) return;
      e.setAction("idle");
      if (e.isSeated()) await e.standUp(token);
    } finally {
      this.w.release(id, e.id);
      this.state = "RETURNING";
    }
  }
}
