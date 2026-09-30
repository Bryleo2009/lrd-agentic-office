import type { AgentId } from "../../shared/types";
import { PARTITIONS, POIS, STATIONS, stationGeometry, type PoiDef } from "../environment/OfficeMap";
import { FACING_VEC, type Facing, type Vec } from "../office/iso";
import type { CollisionMap } from "./CollisionMap";
import { Pathfinder } from "./Pathfinder";

export interface NavNode {
  id: string;
  pos: Vec;
  kind: "desk" | "approach" | "door" | "corridor" | "poi" | "visit";
  facing?: Facing;
}

/**
 * Nodos semánticos con nombre (backend_desk, engineering_exit, corridor_01, qa_entry, meeting_table…)
 * sobre la grilla transitable. El recorrido real lo calcula el Pathfinder (A*), que pasa por puertas y pasillo.
 */
export class NavigationGraph {
  readonly nodes = new Map<string, NavNode>();
  readonly pathfinder: Pathfinder;

  constructor(readonly collision: CollisionMap) {
    this.pathfinder = new Pathfinder(collision);
    const alias: Partial<Record<AgentId, string>> = {
      atlas: "control_desk",
      diego: "backend_desk",
      mica: "frontend_desk",
      nora: "database_desk",
      vega: "qa_desk",
      rafa: "rappi_desk",
      piero: "pedidosya_desk",
      fiona: "finance_desk",
    };
    for (const s of STATIONS) {
      const g = stationGeometry(s);
      const name = alias[s.owner] ?? s.id;
      this.add({ id: name, pos: s.seat, kind: "desk", facing: s.facing });
      this.add({ id: `${name}_approach`, pos: g.approach, kind: "approach", facing: s.facing });
    }
    for (const p of POIS) this.add({ id: p.id, pos: p.pos, kind: "poi", facing: p.facing });
    // Puertas y pasillo
    const doorNames: Record<string, string> = {
      "10:4": "control_exit",
      "10:14": "engineering_exit",
      "10:20": "engineering_exit_2",
      "10:29": "qa_entry",
      "13:5": "mission_entry",
      "13:15": "operations_entry",
      "13:21": "operations_entry_2",
      "13:32": "lounge_entry",
    };
    for (const pt of PARTITIONS) {
      if (pt.axis !== "x") continue;
      for (const [a, b] of pt.doors) {
        const id = doorNames[`${pt.at}:${a}`] ?? `door_${pt.at}_${a}`;
        this.add({ id, pos: { x: (a + b) / 2, y: pt.at + 0.5 }, kind: "door" });
      }
    }
    for (let i = 0; i < 6; i++) this.add({ id: `corridor_0${i + 1}`, pos: { x: 3 + i * 6, y: 12 }, kind: "corridor" });
    this.add({ id: "meeting_table", pos: { x: 5.7, y: 19.5 }, kind: "poi" });
  }

  private add(n: NavNode) {
    this.nodes.set(n.id, n);
  }

  node(id: string): NavNode | undefined {
    return this.nodes.get(id);
  }

  /** Punto de acceso para un asiento POI. */
  seatApproach(p: PoiDef): Vec {
    const f = FACING_VEC[p.facing];
    const sign = p.approachFrom === "front" ? 1 : -1;
    return { x: p.pos.x + f.x * 0.95 * sign, y: p.pos.y + f.y * 0.95 * sign };
  }

  path(from: Vec, to: Vec): Vec[] | null {
    return this.pathfinder.find(from, to);
  }
}
