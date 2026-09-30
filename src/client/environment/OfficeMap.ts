import type { AgentId } from "../../shared/types";
import { FACING_VEC, type Facing, type Vec } from "../office/iso";

export const MAP_W = 36;
export const MAP_H = 26;

export interface RoomDef {
  id: string;
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  floor: number;
  labelPos: Vec;
}

/** Partición de cristal que ocupa una fila o columna de celdas, con huecos de puerta. */
export interface PartitionDef {
  axis: "x" | "y"; // "x": corre a lo largo de x en la fila `at`; "y": a lo largo de y en la columna `at`
  at: number;
  from: number;
  to: number; // exclusivo
  doors: [number, number][]; // rangos [a, b) sin pared
}

export interface StationDef {
  id: string;
  owner: AgentId;
  seat: Vec; // punto donde se sienta
  facing: Facing;
  monitors: 1 | 2;
  room: string;
}

export interface PoiDef {
  id: string;
  pos: Vec;
  facing: Facing;
  kind: "stand" | "seat";
  room: string;
  /** seat height (px) para asientos */
  seatHeight?: number;
  approachFrom?: "front" | "back";
}

export type PropKind =
  | "plant"
  | "plant_small"
  | "bookshelf"
  | "rack"
  | "coffee_counter"
  | "sofa"
  | "coffee_table"
  | "meeting_table"
  | "high_table"
  | "printer"
  | "cabinet"
  | "water"
  | "whiteboard"
  | "wall_screen"
  | "test_bench";

export interface PropDef {
  kind: PropKind;
  x: number;
  y: number;
  w: number;
  d: number;
  blocks: boolean;
  facing?: Facing;
}

export const ROOMS: RoomDef[] = [
  { id: "control", label: "CONTROL", x0: 1, y0: 1, x1: 9, y1: 10, floor: 0xeef4fb, labelPos: { x: 1.8, y: 8.2 } },
  { id: "engineering", label: "INGENIERÍA", x0: 10, y0: 1, x1: 25, y1: 10, floor: 0xf1f4f8, labelPos: { x: 11.0, y: 8.3 } },
  { id: "qa", label: "QA · LABORATORIO", x0: 26, y0: 1, x1: 35, y1: 10, floor: 0xecf7f3, labelPos: { x: 26.6, y: 8.4 } },
  { id: "corridor", label: "", x0: 1, y0: 10, x1: 35, y1: 14, floor: 0xe3e8ef, labelPos: { x: 0, y: 0 } },
  { id: "mission", label: "SALA DE MISIÓN", x0: 1, y0: 14, x1: 11, y1: 25, floor: 0xf1effa, labelPos: { x: 1.8, y: 23.9 } },
  { id: "operations", label: "OPERACIONES", x0: 12, y0: 14, x1: 26, y1: 25, floor: 0xfbf5ee, labelPos: { x: 12.8, y: 23.9 } },
  { id: "lounge", label: "LOUNGE · CAFÉ", x0: 27, y0: 14, x1: 35, y1: 25, floor: 0xf6efe4, labelPos: { x: 27.8, y: 23.9 } },
];

export const PARTITIONS: PartitionDef[] = [
  { axis: "x", at: 10, from: 1, to: 35, doors: [[4, 6], [14, 16], [20, 22], [29, 31]] },
  { axis: "x", at: 13, from: 1, to: 35, doors: [[5, 7], [15, 17], [21, 23], [32, 34]] },
  { axis: "y", at: 9, from: 1, to: 10, doors: [] },
  { axis: "y", at: 25, from: 1, to: 10, doors: [] },
  { axis: "y", at: 11, from: 14, to: 25, doors: [] },
  { axis: "y", at: 26, from: 14, to: 25, doors: [] },
];

export const STATIONS: StationDef[] = [
  { id: "atlas_desk", owner: "atlas", seat: { x: 5, y: 4.5 }, facing: 1, monitors: 2, room: "control" },
  { id: "diego_desk", owner: "diego", seat: { x: 13, y: 5.5 }, facing: 1, monitors: 2, room: "engineering" },
  { id: "mica_desk", owner: "mica", seat: { x: 17.5, y: 5.5 }, facing: 1, monitors: 2, room: "engineering" },
  { id: "nora_desk", owner: "nora", seat: { x: 22, y: 5.5 }, facing: 1, monitors: 1, room: "engineering" },
  { id: "vega_desk", owner: "vega", seat: { x: 29.5, y: 6 }, facing: 0, monitors: 2, room: "qa" },
  { id: "rafa_desk", owner: "rafa", seat: { x: 13.5, y: 17 }, facing: 0, monitors: 1, room: "operations" },
  { id: "piero_desk", owner: "piero", seat: { x: 18.5, y: 17 }, facing: 0, monitors: 1, room: "operations" },
  { id: "fiona_desk", owner: "fiona", seat: { x: 22.5, y: 17 }, facing: 0, monitors: 2, room: "operations" },
];

export const POIS: PoiDef[] = [
  { id: "mission_screen", pos: { x: 4.5, y: 1.9 }, facing: 3, kind: "stand", room: "control" },
  { id: "control_shelf", pos: { x: 2.3, y: 7.0 }, facing: 2, kind: "stand", room: "control" },
  { id: "whiteboard", pos: { x: 17.2, y: 1.9 }, facing: 3, kind: "stand", room: "engineering" },
  { id: "whiteboard_2", pos: { x: 18.6, y: 2.1 }, facing: 3, kind: "stand", room: "engineering" },
  { id: "eng_printer", pos: { x: 23.2, y: 2.4 }, facing: 3, kind: "stand", room: "engineering" },
  { id: "qa_terminal", pos: { x: 30.5, y: 2.8 }, facing: 3, kind: "stand", room: "qa" },
  { id: "qa_terminal_2", pos: { x: 32.2, y: 2.8 }, facing: 3, kind: "stand", room: "qa" },
  { id: "coffee_1", pos: { x: 28.6, y: 15.6 }, facing: 3, kind: "stand", room: "lounge" },
  { id: "coffee_2", pos: { x: 30.4, y: 15.6 }, facing: 3, kind: "stand", room: "lounge" },
  { id: "water", pos: { x: 33.5, y: 16.4 }, facing: 0, kind: "stand", room: "lounge" },
  { id: "high_table_a", pos: { x: 28.3, y: 20.9 }, facing: 0, kind: "stand", room: "lounge" },
  { id: "high_table_b", pos: { x: 30.5, y: 20.9 }, facing: 2, kind: "stand", room: "lounge" },
  { id: "sofa_1", pos: { x: 32.0, y: 22.35 }, facing: 3, kind: "seat", room: "lounge", seatHeight: 12, approachFrom: "front" },
  { id: "sofa_2", pos: { x: 33.3, y: 22.35 }, facing: 3, kind: "seat", room: "lounge", seatHeight: 12, approachFrom: "front" },
  { id: "ops_cabinet", pos: { x: 16.5, y: 22.4 }, facing: 1, kind: "stand", room: "operations" },
  { id: "corridor_window", pos: { x: 8.0, y: 11.6 }, facing: 2, kind: "stand", room: "corridor" },
  // Sala de misión: asientos alrededor de la mesa
  { id: "meet_n1", pos: { x: 4.2, y: 17.35 }, facing: 1, kind: "seat", room: "mission", seatHeight: 14 },
  { id: "meet_n2", pos: { x: 5.8, y: 17.35 }, facing: 1, kind: "seat", room: "mission", seatHeight: 14 },
  { id: "meet_n3", pos: { x: 7.4, y: 17.35 }, facing: 1, kind: "seat", room: "mission", seatHeight: 14 },
  { id: "meet_s1", pos: { x: 4.2, y: 21.65 }, facing: 3, kind: "seat", room: "mission", seatHeight: 14 },
  { id: "meet_s2", pos: { x: 5.8, y: 21.65 }, facing: 3, kind: "seat", room: "mission", seatHeight: 14 },
  { id: "meet_s3", pos: { x: 7.4, y: 21.65 }, facing: 3, kind: "seat", room: "mission", seatHeight: 14 },
  { id: "meet_e", pos: { x: 9.1, y: 19.5 }, facing: 2, kind: "seat", room: "mission", seatHeight: 14 },
  { id: "meet_w", pos: { x: 2.3, y: 19.5 }, facing: 0, kind: "seat", room: "mission", seatHeight: 14 },
];

export const PROPS: PropDef[] = [
  // CONTROL
  { kind: "wall_screen", x: 2, y: 0, w: 5.5, d: 0.1, blocks: false },
  { kind: "bookshelf", x: 1, y: 5.5, w: 0.7, d: 3, blocks: true, facing: 0 },
  { kind: "plant", x: 7.6, y: 1.4, w: 0.9, d: 0.9, blocks: true },
  { kind: "plant_small", x: 1.3, y: 1.3, w: 0.7, d: 0.7, blocks: true },
  { kind: "plant", x: 7.8, y: 8.6, w: 0.9, d: 0.9, blocks: true },
  // INGENIERÍA
  { kind: "whiteboard", x: 15.5, y: 0, w: 4.5, d: 0.1, blocks: false },
  { kind: "printer", x: 22.6, y: 1.2, w: 1.2, d: 0.8, blocks: true },
  { kind: "plant", x: 10.4, y: 1.3, w: 0.9, d: 0.9, blocks: true },
  { kind: "plant", x: 24.1, y: 8.8, w: 0.8, d: 0.8, blocks: true },
  { kind: "plant_small", x: 10.3, y: 8.9, w: 0.7, d: 0.7, blocks: true },
  { kind: "cabinet", x: 12.4, y: 1.1, w: 2, d: 0.7, blocks: true },
  // QA
  { kind: "rack", x: 27, y: 1, w: 1, d: 1, blocks: true },
  { kind: "test_bench", x: 29.4, y: 1, w: 3.8, d: 0.9, blocks: true },
  { kind: "rack", x: 33.6, y: 1, w: 1, d: 1, blocks: true },
  { kind: "plant", x: 34.1, y: 8.7, w: 0.8, d: 0.8, blocks: true },
  { kind: "cabinet", x: 32.3, y: 6, w: 0.7, d: 2, blocks: true },
  // PASILLO
  { kind: "plant_small", x: 1.3, y: 11.2, w: 0.7, d: 0.7, blocks: true },
  { kind: "plant_small", x: 34.1, y: 11.2, w: 0.7, d: 0.7, blocks: true },
  { kind: "plant_small", x: 18.2, y: 11.1, w: 0.6, d: 0.6, blocks: true },
  // SALA DE MISIÓN
  { kind: "meeting_table", x: 3.2, y: 18.2, w: 5, d: 2.6, blocks: true },
  { kind: "wall_screen", x: 0, y: 17, w: 0.1, d: 5, blocks: false, facing: 0 },
  { kind: "plant", x: 9.8, y: 14.4, w: 0.9, d: 0.9, blocks: true },
  { kind: "plant", x: 9.8, y: 23.8, w: 0.9, d: 0.9, blocks: true },
  { kind: "plant_small", x: 1.3, y: 23.9, w: 0.7, d: 0.7, blocks: true },
  // OPERACIONES
  { kind: "cabinet", x: 15.2, y: 23.2, w: 2.6, d: 0.8, blocks: true },
  { kind: "printer", x: 19.6, y: 23.2, w: 1.2, d: 0.8, blocks: true },
  { kind: "plant", x: 12.4, y: 23.8, w: 0.9, d: 0.9, blocks: true },
  { kind: "plant", x: 25, y: 14.4, w: 0.8, d: 0.8, blocks: true },
  { kind: "plant_small", x: 24.9, y: 23.9, w: 0.7, d: 0.7, blocks: true },
  // LOUNGE
  { kind: "coffee_counter", x: 27.6, y: 14.1, w: 4, d: 0.9, blocks: true },
  { kind: "water", x: 34.1, y: 16, w: 0.75, d: 0.7, blocks: true },
  { kind: "high_table", x: 29.05, y: 20.5, w: 0.8, d: 0.8, blocks: true },
  { kind: "sofa", x: 31.2, y: 22.4, w: 3, d: 1.1, blocks: true, facing: 3 },
  { kind: "coffee_table", x: 31.8, y: 20.1, w: 1.8, d: 0.9, blocks: true },
  { kind: "plant", x: 34.1, y: 18.4, w: 0.8, d: 0.8, blocks: true },
  { kind: "plant_small", x: 27.4, y: 23.9, w: 0.7, d: 0.7, blocks: true },
];

/** Geometría derivada de una estación (escritorio delante, silla, punto de acceso). */
export function stationGeometry(s: StationDef) {
  const f = FACING_VEC[s.facing];
  const side = { x: -f.y, y: f.x }; // perpendicular
  const deskCenter = { x: s.seat.x + f.x * 1.0, y: s.seat.y + f.y * 1.0 };
  const deskRect = rectFrom(deskCenter, f, side, 0.5, 1.0);
  const chairRect = rectFrom(s.seat, f, side, 0.45, 0.45);
  const approach = { x: s.seat.x - f.x * 1.0, y: s.seat.y - f.y * 1.0 };
  const visitA = { x: s.seat.x - f.x * 0.25 + side.x * 1.45, y: s.seat.y - f.y * 0.25 + side.y * 1.45 };
  const visitB = { x: s.seat.x - f.x * 0.25 - side.x * 1.45, y: s.seat.y - f.y * 0.25 - side.y * 1.45 };
  return { f, side, deskCenter, deskRect, chairRect, approach, visitA, visitB };
}

function rectFrom(c: Vec, f: Vec, side: Vec, halfF: number, halfS: number) {
  const hx = Math.abs(f.x) * halfF + Math.abs(side.x) * halfS;
  const hy = Math.abs(f.y) * halfF + Math.abs(side.y) * halfS;
  return { x0: c.x - hx, y0: c.y - hy, x1: c.x + hx, y1: c.y + hy };
}

export function roomAt(p: Vec): RoomDef | undefined {
  return ROOMS.find((r) => r.id !== "corridor" && p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1);
}

export function stationOf(agent: AgentId): StationDef {
  return STATIONS.find((s) => s.owner === agent)!;
}

export function poi(id: string): PoiDef {
  const p = POIS.find((x) => x.id === id);
  if (!p) throw new Error(`POI desconocido ${id}`);
  return p;
}
