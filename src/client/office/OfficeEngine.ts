import { Application, Container, Rectangle } from "pixi.js";
import { AGENTS } from "../../shared/agents";
import type { AgentId, AgentProfile, Appearance as AppearanceT } from "../../shared/types";
import { AgentBrain } from "../agents/AgentBrain";
import { AgentEntity } from "../agents/AgentEntity";
import type { Action } from "../agents/AgentAnimator";
import { buildRigView, DEFAULT_APPEARANCE, type Appearance } from "../agents/CharacterRig";
import type { Seat, WorldApi } from "../agents/AgentFSM";
import { MAP_H, MAP_W, POIS, roomAt, STATIONS, stationGeometry, stationOf, type PoiDef } from "../environment/OfficeMap";
import { CollisionMap } from "../navigation/CollisionMap";
import { NavigationGraph } from "../navigation/NavigationGraph";
import { CameraController } from "./CameraController";
import { iso, type Vec } from "./iso";
import { OfficeScene } from "./OfficeScene";

async function loadAppearance(id: AgentId): Promise<Appearance> {
  try {
    const r = await fetch(`/characters/${id}/character.json`);
    if (!r.ok) throw new Error(String(r.status));
    return { ...DEFAULT_APPEARANCE, ...(await r.json()) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * Motor de la oficina (PixiJS). Controla mapa, personajes, animaciones, pathfinding y cámara.
 * React no participa en el loop: sólo llama a métodos públicos (select, fit, focusAgent).
 */
export class OfficeEngine {
  app = new Application();
  readonly world = new Container();
  readonly overlay = new Container();
  scene!: OfficeScene;
  camera!: CameraController;
  nav!: NavigationGraph;
  collision!: CollisionMap;
  readonly entities = new Map<AgentId, AgentEntity>();
  readonly brains = new Map<AgentId, AgentBrain>();
  private reservations = new Map<string, AgentId>();
  private selected: AgentId | null = null;
  private onSelectCb: ((id: AgentId | null) => void) | null = null;
  private onGlLostCb: ((lost: boolean) => void) | null = null;
  private time = 0;
  private started = performance.now();
  private meetingSeats = new Map<AgentId, string>();
  private fpsSamples: number[] = [];
  private appearances = new Map<AgentId, Appearance>();
  private portraits = new Map<AgentId, string>();
  private profileKeys = new Map<AgentId, string>();

  async init(el: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: el,
      antialias: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: "webgl",
    });
    el.appendChild(this.app.canvas);
    // Si la GPU pierde el contexto WebGL el canvas queda transparente (pantalla azul): avisar.
    this.app.canvas.addEventListener("webglcontextlost", () => this.onGlLostCb?.(true));
    this.app.canvas.addEventListener("webglcontextrestored", () => this.onGlLostCb?.(false));
    this.collision = new CollisionMap();
    this.nav = new NavigationGraph(this.collision);
    this.scene = new OfficeScene();
    this.world.addChild(this.scene.floor, this.scene.objects, this.overlay);
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointertap", (e) => {
      if (e.target === this.app.stage && !this.camera.wasDrag()) this.select(null);
    });

    const top = iso(0, 0, 110);
    const left = iso(0, MAP_H);
    const right = iso(MAP_W, 0);
    const bottom = iso(MAP_W, MAP_H, -16);
    this.camera = new CameraController(this.world, el, { x: left.x, y: top.y, w: right.x - left.x, h: bottom.y - top.y });

    const appearances = await Promise.all(AGENTS.map((a) => loadAppearance(a.id)));
    const api = this.worldApi();
    AGENTS.forEach((def, i) => {
      this.appearances.set(def.id, appearances[i]);
      const st = stationOf(def.id);
      const e = new AgentEntity(def, appearances[i], st.seat, this.nav);
      // empieza sentado en su puesto
      const seat = this.deskSeat(def.id);
      e.seat = { ...seat };
      e.animator.seatHeight = seat.seatHeight;
      e.animator.sitTarget = 1;
      e.animator.sit = 1;
      e.face(seat.facing);
      e.setAction("type");
      e.renderer.onClick(() => {
        if (!this.camera.wasDrag()) this.select(def.id);
      });
      this.scene.objects.addChild(e.renderer.body);
      this.overlay.addChild(e.renderer.overlay);
      this.entities.set(def.id, e);
      this.brains.set(def.id, new AgentBrain(e, api));
    });
    const all = [...this.entities.values()];
    for (const e of all) e.others = all;

    this.camera.fit(true);
    window.addEventListener("resize", this.onResize);
    this.app.ticker.minFPS = 2; // no recortar deltaMS en equipos lentos (la simulación usa sub-pasos)
    this.app.ticker.add((tk) => {
      // Simulación desacoplada del framerate: sub-pasos de ≤ 50 ms (tiempo de juego = tiempo real).
      const real = Math.min(0.5, tk.deltaMS / 1000);
      this.fpsSamples.push(real);
      if (this.fpsSamples.length > 120) this.fpsSamples.shift();
      const steps = Math.max(1, Math.ceil(real / 0.05));
      for (let i = 0; i < steps; i++) this.simulate(real / steps);
      this.render(real);
    });
    (window as any).__office = this;
  }

  private onResize = () => {
    setTimeout(() => this.camera.fit(), 50);
  };

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.camera?.destroy();
    this.app.destroy(true, { children: true });
  }

  private simulate(dt: number): void {
    this.time += dt;
    for (const b of this.brains.values()) b.update(dt);
    for (const e of this.entities.values()) e.update(dt, this.camera.zoom);
  }

  private render(dt: number): void {
    this.camera.update(dt);
    this.scene.update(dt, this.time);
    // Monitores: brillo según actividad real (fuerte) o ambiental (suave)
    for (const [id, e] of this.entities) {
      const desk = this.scene.desks.get(id);
      if (!desk) continue;
      const b = this.brains.get(id)!;
      const atDesk = e.seat?.id === `${id}_desk`;
      const act = e.animator.action;
      const real = b.real && b.real.where === "desk";
      const level = atDesk ? (real ? (act === "type" || act === "read" || act === "test" ? 1 : 0.7) : act === "type" ? 0.3 : 0.12) : 0;
      desk.setActive(level, b.real?.tone === "blocked" ? 0xf87171 : 0x67e8f9);
    }
  }

  /** Aplica la personalización del equipo (nombre, color, apariencia) en vivo. */
  applyTeam(team: AgentProfile[]): void {
    for (const p of team) {
      const e = this.entities.get(p.id);
      if (!e) continue;
      const key = JSON.stringify([p.name, p.color, p.appearance]);
      if (this.profileKeys.get(p.id) === key) continue;
      const first = !this.profileKeys.has(p.id);
      this.profileKeys.set(p.id, key);
      const prev = JSON.stringify(this.appearances.get(p.id));
      this.appearances.set(p.id, p.appearance);
      if (first && prev === JSON.stringify(p.appearance) && e.renderer.def.name === p.name && e.renderer.def.color === p.color) continue;
      e.renderer.setProfile(p, p.appearance);
      this.portraits.delete(p.id);
    }
  }

  // ---------------- API para React ----------------

  onSelect(cb: (id: AgentId | null) => void): void {
    this.onSelectCb = cb;
  }

  onContextLost(cb: (lost: boolean) => void): void {
    this.onGlLostCb = cb;
  }

  select(id: AgentId | null): void {
    if (this.selected === id) return;
    if (this.selected) this.entities.get(this.selected)?.renderer.setSelected(false);
    this.selected = id;
    if (id) this.entities.get(id)?.renderer.setSelected(true);
    this.onSelectCb?.(id);
  }

  fit(): void {
    this.camera.fit();
  }

  focusAgent(id: AgentId): void {
    const e = this.entities.get(id);
    if (!e) return;
    const p = iso(e.pos.x, e.pos.y, 30);
    this.camera.focus(p.x, p.y, 1.45);
  }

  setInsets(insets: Partial<CameraController["insets"]>): void {
    Object.assign(this.camera.insets, insets);
  }

  brain(id: AgentId): AgentBrain | undefined {
    return this.brains.get(id);
  }

  entity(id: AgentId): AgentEntity | undefined {
    return this.entities.get(id);
  }

  /** Retrato del personaje (render real del rig) para el drawer. */
  async portrait(id: AgentId, override?: AppearanceT): Promise<string> {
    const cached = override ? null : this.portraits.get(id);
    if (cached) return cached;
    const a = override ?? this.appearances.get(id) ?? DEFAULT_APPEARANCE;
    const v = buildRigView(a, false);
    const c = new Container();
    v.root.scale.set(2.4);
    v.armNear.upper.rotation = -0.25;
    v.armNear.lower.rotation = -0.9;
    c.addChild(v.root);
    const url = await this.app.renderer.extract.base64({ target: c, frame: new Rectangle(-44, -168, 96, 96), resolution: 2 });
    c.destroy({ children: true });
    if (!override) this.portraits.set(id, url);
    return url;
  }

  // ---------------- asientos y reservas ----------------

  deskSeat(id: AgentId): Seat {
    const s = stationOf(id);
    const g = stationGeometry(s);
    return { id: `${id}_desk`, pos: s.seat, facing: s.facing, approach: g.approach, seatHeight: 14 };
  }

  poiSeat(p: PoiDef): Seat {
    return { id: p.id, pos: p.pos, facing: p.facing, approach: this.nav.seatApproach(p), seatHeight: p.seatHeight ?? 12 };
  }

  assignMeetingSeat(id: AgentId, preferHead = false): Seat {
    const existing = this.meetingSeats.get(id);
    if (existing) return this.poiSeat(POIS.find((p) => p.id === existing)!);
    const taken = new Set(this.meetingSeats.values());
    const order = preferHead ? ["meet_e", "meet_n2", "meet_s2", "meet_n1", "meet_s1", "meet_n3", "meet_s3", "meet_w"] : ["meet_n2", "meet_s2", "meet_n1", "meet_s1", "meet_n3", "meet_s3", "meet_w", "meet_e"];
    const pid = order.find((o) => !taken.has(o)) ?? "meet_w";
    this.meetingSeats.set(id, pid);
    return this.poiSeat(POIS.find((p) => p.id === pid)!);
  }

  releaseMeetingSeat(id: AgentId): void {
    this.meetingSeats.delete(id);
  }

  private visitSpot(target: AgentEntity, from: AgentEntity): Vec | null {
    const occupied = (p: Vec) => [...this.entities.values()].some((o) => o !== from && o !== target && Math.hypot(o.pos.x - p.x, o.pos.y - p.y) < 0.6);
    const cands: Vec[] = [];
    if (target.seat && target.seat.id === `${target.id}_desk`) {
      const g = stationGeometry(stationOf(target.id));
      cands.push(g.visitA, g.visitB, g.approach);
    }
    const dx = from.pos.x - target.pos.x;
    const dy = from.pos.y - target.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    for (let k = 0; k < 8; k++) {
      const a = Math.atan2(dy / d, dx / d) + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 4);
      cands.push({ x: target.pos.x + Math.cos(a) * 1.05, y: target.pos.y + Math.sin(a) * 1.05 });
    }
    const ok = cands.filter((p) => this.collision.isWalkablePoint(p) && !occupied(p));
    ok.sort((a, b) => Math.hypot(a.x - from.pos.x, a.y - from.pos.y) - Math.hypot(b.x - from.pos.x, b.y - from.pos.y));
    return ok[0] ?? null;
  }

  private worldApi(): WorldApi {
    return {
      entity: (id) => this.entities.get(id)!,
      entities: () => [...this.entities.values()],
      deskSeat: (id) => this.deskSeat(id),
      poiSeat: (p) => this.poiSeat(p),
      reserve: (poi, who) => {
        const cur = this.reservations.get(poi);
        if (cur && cur !== who) return false;
        this.reservations.set(poi, who);
        return true;
      },
      release: (poi, who) => {
        if (this.reservations.get(poi) === who) this.reservations.delete(poi);
      },
      reservedBy: (poi) => this.reservations.get(poi) ?? null,
      visitSpot: (t, f) => this.visitSpot(t, f),
      isAmbient: (id) => {
        const b = this.brains.get(id);
        return !!b && !b.hasRealTask();
      },
      engage: (target, with_, secs, action?: Action) => this.brains.get(target)?.engage(with_, secs, action) ?? false,
      roomOf: (id) => STATIONS.find((s) => s.owner === id)?.room ?? "corridor",
    };
  }

  // ---------------- métricas (validación visual) ----------------

  metrics() {
    const now = performance.now();
    const avgDt = this.fpsSamples.reduce((a, b) => a + b, 0) / Math.max(1, this.fpsSamples.length);
    return {
      seconds: (now - this.started) / 1000,
      fps: avgDt > 0 ? 1 / avgDt : 0,
      agents: [...this.entities.values()].map((e) => {
        const b = this.brains.get(e.id)!;
        const cell = { x: Math.floor(e.pos.x), y: Math.floor(e.pos.y) };
        return {
          id: e.id,
          visible: e.renderer.body.visible,
          pos: { ...e.pos },
          inBlockedCell: !e.seat && !e.isMoving() ? this.collision.isBlocked(cell.x, cell.y) : false,
          seated: !!e.seat,
          walked: e.walked,
          sits: e.sitCount,
          stands: e.standCount,
          turns: e.turnCount,
          collisionViolations: e.collisionViolations,
          behaviors: b.fsm.behaviors,
          routines: b.fsm.history.map((h) => h.routine),
          state: b.fsm.state,
          mode: b.modeName,
          action: e.animator.action,
          room: roomAt(e.pos)?.id ?? "corridor",
        };
      }),
    };
  }
}
