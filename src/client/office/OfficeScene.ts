import { Container } from "pixi.js";
import { AGENTS } from "../../shared/agents";
import type { AgentId } from "../../shared/types";
import { buildChair } from "../environment/Chair";
import { buildDesk, type DeskView } from "../environment/Desk";
import { POIS, PROPS, STATIONS } from "../environment/OfficeMap";
import { buildMeetingScreen, buildProp, MissionWallScreen, type PropView } from "../environment/Props";
import { buildBackWalls, buildFloor, buildPartitions } from "../environment/Room";

/** Construye la escena estática y expone los elementos vivos (monitores, banco de pruebas, pantalla de misión). */
export class OfficeScene {
  readonly floor = new Container();
  readonly objects = new Container();
  readonly desks = new Map<AgentId, DeskView>();
  readonly missionScreen: MissionWallScreen;
  private props: PropView[] = [];
  testBench: Container | null = null;

  constructor() {
    this.objects.sortableChildren = true;
    this.floor.addChild(buildFloor());
    this.objects.addChild(buildBackWalls());
    for (const p of buildPartitions()) this.objects.addChild(p);

    this.missionScreen = new MissionWallScreen(2, 7.5);
    this.objects.addChild(this.missionScreen.container);
    this.objects.addChild(buildMeetingScreen(17, 22));

    for (const s of STATIONS) {
      const def = AGENTS.find((a) => a.id === s.owner)!;
      const desk = buildDesk(s, parseInt(def.color.slice(1), 16));
      this.desks.set(s.owner, desk);
      this.objects.addChild(desk.container);
      for (const part of buildChair(s.seat, s.facing, 0x334155, 14)) this.objects.addChild(part);
    }
    for (const p of POIS) {
      if (p.room === "mission" && p.kind === "seat") for (const part of buildChair(p.pos, p.facing, 0x6d5bd0, 14)) this.objects.addChild(part);
    }
    for (const p of PROPS) {
      const v = buildProp(p);
      this.props.push(v);
      this.objects.addChild(v.container);
      if (p.kind === "test_bench") this.testBench = v.container;
    }
  }

  setTestBench(state: "idle" | "running" | "pass" | "fail"): void {
    (this.testBench as any)?.setState?.(state);
  }

  update(dt: number, t: number): void {
    for (const p of this.props) p.update?.(dt, t);
    this.missionScreen.update(dt);
  }
}
