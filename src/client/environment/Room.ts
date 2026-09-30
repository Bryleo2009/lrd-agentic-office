import { Container, Graphics } from "pixi.js";
import { depth, iso } from "../office/iso";
import { floorQuad, floorText, planeX, planeY, poly } from "./draw";
import { MAP_H, MAP_W, PARTITIONS, ROOMS } from "./OfficeMap";

const WALL_H = 104;
const GLASS_H = 46;

/** Losa base, pisos por sala, líneas de baldosa y rótulos pintados. */
export function buildFloor(): Container {
  const c = new Container();
  const g = new Graphics();
  // Losa con espesor (caras frontales)
  const T = 16;
  poly(g, [iso(0, MAP_H), iso(MAP_W, MAP_H), iso(MAP_W, MAP_H, -T), iso(0, MAP_H, -T)], 0xcbd5e1);
  poly(g, [iso(MAP_W, 0), iso(MAP_W, MAP_H), iso(MAP_W, MAP_H, -T), iso(MAP_W, 0, -T)], 0xa9b6c8);
  poly(g, [iso(0, MAP_H, -T + 3), iso(MAP_W, MAP_H, -T + 3), iso(MAP_W, MAP_H, -T), iso(0, MAP_H, -T)], 0x94a3b8, 0.5);
  floorQuad(g, 0, 0, MAP_W, MAP_H, 0xe9edf3);
  for (const r of ROOMS) floorQuad(g, r.x0, r.y0, r.x1, r.y1, r.floor);
  // Alfombras / zonas
  floorQuad(g, 2.4, 16.8, 9.2, 22.2, 0xe4e0f5, 0.9); // alfombra sala de misión
  floorQuad(g, 30.6, 19.4, 34.6, 23.7, 0xeadfcd, 0.9); // alfombra lounge
  floorQuad(g, 3.2, 1.2, 7.8, 3.2, 0xdbeafe, 0.7); // zona pantalla de control
  // Franja central del pasillo
  floorQuad(g, 1, 11.9, 35, 12.1, 0xcfd8e3, 0.8);
  c.addChild(g);

  // Líneas de baldosa (muy sutiles)
  const grid = new Graphics();
  for (let x = 1; x < MAP_W; x++) {
    const a = iso(x, 0.02);
    const b = iso(x, MAP_H - 0.02);
    grid.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  for (let y = 1; y < MAP_H; y++) {
    const a = iso(0.02, y);
    const b = iso(MAP_W - 0.02, y);
    grid.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  grid.stroke({ width: 1, color: 0x94a3b8, alpha: 0.09 });
  c.addChild(grid);

  for (const r of ROOMS) if (r.label) c.addChild(floorText(r.label, r.labelPos.x, r.labelPos.y, 24));
  c.addChild(floorText("PASILLO", 23.5, 12.9, 18, 0x64748b, 0.18));
  return c;
}

/** Muros exteriores traseros con ventanales (y=0 y x=0). */
export function buildBackWalls(): Container {
  const c = new Container();
  const g = new Graphics();
  const th = 0.28;
  // Muro a lo largo de x (y = 0), cara visible hacia +y
  poly(g, [iso(-th, -th, WALL_H), iso(MAP_W, -th, WALL_H), iso(MAP_W, 0, WALL_H), iso(0, 0, WALL_H)], 0xf8fafc); // tapa
  planeX(g, 0, MAP_W, 0, 0, WALL_H, 0xeef2f7);
  planeY(g, -th, 0, MAP_W, 0, WALL_H, 0xd5dde8);
  // Muro a lo largo de y (x = 0), cara visible hacia +x
  poly(g, [iso(-th, -th, WALL_H), iso(0, 0, WALL_H), iso(0, MAP_H, WALL_H), iso(-th, MAP_H, WALL_H)], 0xf8fafc);
  planeY(g, 0, MAP_H, 0, 0, WALL_H, 0xe2e8f0);
  planeX(g, -th, 0, MAP_H, 0, WALL_H, 0xcbd5e1);
  // Zócalo
  planeX(g, 0, MAP_W, 0.01, 0, 6, 0xcbd5e1);
  planeY(g, 0, MAP_H, 0.01, 0, 6, 0xc3cedb);

  // Ventanales
  const windowsX: [number, number][] = [
    [0.6, 1.8],
    [8.2, 9.6],
    [10.6, 14.8],
    [20.6, 22.2],
    [24.4, 26.6],
    [34.2, 35.6],
  ];
  for (const [a, b] of windowsX) drawWindowX(g, a, b);
  const windowsY: [number, number][] = [
    [1, 4.6],
    [9.2, 13.6],
    [14.6, 16.4],
    [23.2, 25.4],
  ];
  for (const [a, b] of windowsY) drawWindowY(g, a, b);
  // Luz de techo en muro
  planeX(g, 0, MAP_W, 0.01, WALL_H - 4, WALL_H, 0xffffff, 0.8);
  planeY(g, 0, MAP_H, 0.01, WALL_H - 4, WALL_H, 0xffffff, 0.7);
  c.addChild(g);
  c.zIndex = -100000;
  return c;
}

function drawWindowX(g: Graphics, a: number, b: number) {
  planeX(g, a, b, 0.012, 22, WALL_H - 12, 0x9ecbe8);
  planeX(g, a, b, 0.013, 22, 48, 0xc7e3f4, 0.6);
  // reflejo diagonal
  poly(g, [iso(a + 0.25, 0.014, WALL_H - 12), iso(a + 0.7, 0.014, WALL_H - 12), iso(a + 0.2, 0.014, 22), iso(a, 0.014, 22), iso(a, 0.014, 30)], 0xffffff, 0.35);
  for (let x = a; x <= b + 0.001; x += (b - a) / Math.max(1, Math.round((b - a) / 1.1))) planeX(g, x - 0.03, x + 0.03, 0.015, 22, WALL_H - 12, 0xf8fafc);
  planeX(g, a - 0.05, b + 0.05, 0.015, 20, 23, 0xf8fafc);
  planeX(g, a - 0.05, b + 0.05, 0.015, WALL_H - 13, WALL_H - 10, 0xf8fafc);
}

function drawWindowY(g: Graphics, a: number, b: number) {
  planeY(g, a, b, 0.012, 22, WALL_H - 12, 0x93c2e0);
  planeY(g, a, b, 0.013, 22, 48, 0xbfdcf0, 0.6);
  poly(g, [iso(0.014, b - 0.25, WALL_H - 12), iso(0.014, b - 0.7, WALL_H - 12), iso(0.014, b - 0.2, 22), iso(0.014, b, 22), iso(0.014, b, 30)], 0xffffff, 0.3);
  for (let y = a; y <= b + 0.001; y += (b - a) / Math.max(1, Math.round((b - a) / 1.1))) planeY(g, y - 0.03, y + 0.03, 0.015, 22, WALL_H - 12, 0xf1f5f9);
  planeY(g, a - 0.05, b + 0.05, 0.015, 20, 23, 0xf1f5f9);
  planeY(g, a - 0.05, b + 0.05, 0.015, WALL_H - 13, WALL_H - 10, 0xf1f5f9);
}

/** Particiones de cristal: un segmento por celda para ordenar profundidad con personajes. */
export function buildPartitions(): Container[] {
  const out: Container[] = [];
  for (const p of PARTITIONS) {
    for (let i = p.from; i < p.to; i++) {
      const isDoor = p.doors.some(([a, b]) => i >= a && i < b);
      const g = new Graphics();
      const c = new Container();
      if (p.axis === "x") {
        const y = p.at + 0.5;
        if (!isDoor) {
          planeX(g, i, i + 1, y, 0, 5, 0xb6c2d1);
          planeX(g, i, i + 1, y, 5, GLASS_H, 0xbfe3f2, 0.28);
          poly(g, [iso(i + 0.15, y, GLASS_H - 4), iso(i + 0.45, y, GLASS_H - 4), iso(i + 0.3, y, 8), iso(i + 0.05, y, 8)], 0xffffff, 0.22);
          planeX(g, i, i + 1, y, GLASS_H - 2.5, GLASS_H, 0x7dd3fc, 0.95);
          if (i % 2 === 0) planeX(g, i - 0.03, i + 0.03, y, 0, GLASS_H, 0xcbd5e1);
        }
        const doorStart = p.doors.some(([a]) => i === a);
        const doorEnd = p.doors.some(([, b]) => i + 1 === b);
        if (isDoor && doorStart) planeX(g, i - 0.06, i + 0.02, y, 0, GLASS_H + 4, 0x94a3b8);
        if (isDoor && doorEnd) planeX(g, i + 0.98, i + 1.06, y, 0, GLASS_H + 4, 0x94a3b8);
        if (isDoor) floorQuad(g, i, p.at + 0.1, i + 1, p.at + 0.9, 0xdbe3ec, 0.9);
        c.zIndex = depth(i + 0.5, y, 200);
      } else {
        const x = p.at + 0.5;
        if (!isDoor) {
          planeY(g, i, i + 1, x, 0, 5, 0xa9b6c6);
          planeY(g, i, i + 1, x, 5, GLASS_H, 0xb4dcee, 0.28);
          poly(g, [iso(x, i + 0.85, GLASS_H - 4), iso(x, i + 0.55, GLASS_H - 4), iso(x, i + 0.7, 8), iso(x, i + 0.95, 8)], 0xffffff, 0.2);
          planeY(g, i, i + 1, x, GLASS_H - 2.5, GLASS_H, 0x7dd3fc, 0.95);
          if (i % 2 === 0) planeY(g, i - 0.03, i + 0.03, x, 0, GLASS_H, 0xcbd5e1);
        }
        c.zIndex = depth(x, i + 0.5, 200);
      }
      c.addChild(g);
      out.push(c);
    }
  }
  return out;
}
