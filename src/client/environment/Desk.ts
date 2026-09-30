import { Container, Graphics } from "pixi.js";
import { depth, iso } from "../office/iso";
import { isoBox, planeX, planeY, poly } from "./draw";
import { stationGeometry, type StationDef } from "./OfficeMap";

const TOP_H = 26;

export interface DeskView {
  container: Container;
  glow: Graphics;
  setActive(level: number, color?: number): void;
}

/** Escritorio con monitores (se ve el dorso), teclado, taza y resplandor de pantalla cuando hay trabajo real. */
export function buildDesk(s: StationDef, accent: number): DeskView {
  const geo = stationGeometry(s);
  const r = geo.deskRect;
  const c = new Container();
  const g = new Graphics();
  const w = r.x1 - r.x0;
  const d = r.y1 - r.y0;
  // sombra
  poly(g, [iso(r.x0 + 0.08, r.y0 + 0.12), iso(r.x1 + 0.12, r.y0 + 0.12), iso(r.x1 + 0.12, r.y1 + 0.16), iso(r.x0 + 0.08, r.y1 + 0.16)], 0x0f172a, 0.07);
  // patas / paneles laterales
  const legC = { top: 0xcbd5e1, left: 0x94a3b8, right: 0x7c8a9e };
  const inset = 0.06;
  if (s.facing === 1 || s.facing === 3) {
    isoBox(g, r.x0 + inset, r.y0 + 0.1, 0.07, d - 0.2, 0, TOP_H - 2, legC);
    isoBox(g, r.x1 - inset - 0.07, r.y0 + 0.1, 0.07, d - 0.2, 0, TOP_H - 2, legC);
    // panel de modestia
    planeX(g, r.x0 + 0.1, r.x1 - 0.1, r.y1 - 0.12, 8, TOP_H - 2, 0xe2e8f0, 0.95);
  } else {
    isoBox(g, r.x0 + 0.1, r.y0 + inset, d > w ? w - 0.2 : 0.07, 0.07, 0, TOP_H - 2, legC);
    isoBox(g, r.x0 + 0.1, r.y1 - inset - 0.07, w - 0.2, 0.07, 0, TOP_H - 2, legC);
    planeY(g, r.y0 + 0.1, r.y1 - 0.1, r.x1 - 0.12, 8, TOP_H - 2, 0xdfe6ee, 0.95);
  }
  // tablero
  isoBox(g, r.x0, r.y0, w, d, TOP_H - 3, 3, { top: 0xfbfcfe, left: 0xdbe2ea, right: 0xc9d3de });
  // borde de color del agente
  if (s.facing === 1) planeX(g, r.x0, r.x1, r.y1 + 0.001, TOP_H - 3, TOP_H - 1.6, accent, 0.9);
  else planeY(g, r.y0, r.y1, r.x1 + 0.001, TOP_H - 3, TOP_H - 1.6, accent, 0.9);

  const glow = new Graphics();
  // monitores
  const f = geo.f;
  const side = geo.side;
  const mons = s.monitors === 2 ? [-0.36, 0.36] : [0];
  const farOff = 0.72; // desde el asiento hacia el fondo del escritorio
  for (const o of mons) {
    const cx = s.seat.x + f.x * (0.5 + farOff) + side.x * o;
    const cy = s.seat.y + f.y * (0.5 + farOff) + side.y * o;
    const half = 0.31;
    if (s.facing === 1 || s.facing === 3) {
      // pie
      isoBox(g, cx - 0.05, cy - 0.05, 0.1, 0.1, TOP_H, 7, { top: 0x475569, left: 0x334155, right: 0x1e293b });
      isoBox(g, cx - 0.15, cy - 0.12, 0.3, 0.2, TOP_H, 1.2, { top: 0x64748b, left: 0x475569, right: 0x334155 });
      // pantalla (vemos el dorso)
      isoBox(g, cx - half, cy - 0.03, half * 2, 0.06, TOP_H + 6, 21, { top: 0x475569, left: 0x2b3545, right: 0x1f2937 });
      planeX(g, cx - half + 0.05, cx + half - 0.05, cy + 0.031, TOP_H + 9, TOP_H + 24, 0x334155);
      // resplandor que se escapa por los bordes
      planeX(glow, cx - half - 0.05, cx + half + 0.05, cy - 0.04, TOP_H + 5, TOP_H + 28, 0x67e8f9, 1);
    } else {
      isoBox(g, cx - 0.05, cy - 0.05, 0.1, 0.1, TOP_H, 7, { top: 0x475569, left: 0x334155, right: 0x1e293b });
      isoBox(g, cx - 0.12, cy - 0.15, 0.2, 0.3, TOP_H, 1.2, { top: 0x64748b, left: 0x475569, right: 0x334155 });
      isoBox(g, cx - 0.03, cy - half, 0.06, half * 2, TOP_H + 6, 21, { top: 0x475569, left: 0x2b3545, right: 0x1f2937 });
      planeY(g, cy - half + 0.05, cy + half - 0.05, cx + 0.031, TOP_H + 9, TOP_H + 24, 0x334155);
      planeY(glow, cy - half - 0.05, cy + half + 0.05, cx - 0.04, TOP_H + 5, TOP_H + 28, 0x67e8f9, 1);
    }
  }
  // luz de pantalla sobre el escritorio (hacia el agente)
  const lx = s.seat.x + f.x * 0.9;
  const ly = s.seat.y + f.y * 0.9;
  const lp = iso(lx, ly, TOP_H);
  glow.ellipse(lp.x, lp.y, 30, 12).fill({ color: 0x67e8f9, alpha: 0.35 });
  glow.alpha = 0.12;

  // teclado, mouse, taza, papeles
  const kx = s.seat.x + f.x * 0.72;
  const ky = s.seat.y + f.y * 0.72;
  if (s.facing === 1 || s.facing === 3) {
    isoBox(g, kx - 0.26, ky - 0.08, 0.52, 0.16, TOP_H, 1.6, { top: 0xe2e8f0, left: 0xcbd5e1, right: 0x94a3b8 });
    isoBox(g, kx + 0.36, ky - 0.05, 0.08, 0.12, TOP_H, 1.4, { top: 0xf1f5f9, left: 0xcbd5e1, right: 0x94a3b8 });
    isoBox(g, kx - 0.78, ky + 0.05, 0.12, 0.12, TOP_H, 6, { top: 0x78350f, left: 0xffffff, right: 0xe5e7eb });
    poly(g, [iso(kx + 0.5, ky + 0.15, TOP_H + 0.5), iso(kx + 0.85, ky + 0.1, TOP_H + 0.5), iso(kx + 0.9, ky + 0.4, TOP_H + 0.5), iso(kx + 0.55, ky + 0.45, TOP_H + 0.5)], 0xffffff);
  } else {
    isoBox(g, kx - 0.08, ky - 0.26, 0.16, 0.52, TOP_H, 1.6, { top: 0xe2e8f0, left: 0xcbd5e1, right: 0x94a3b8 });
    isoBox(g, kx - 0.05, ky + 0.36, 0.12, 0.08, TOP_H, 1.4, { top: 0xf1f5f9, left: 0xcbd5e1, right: 0x94a3b8 });
    isoBox(g, kx + 0.05, ky - 0.8, 0.12, 0.12, TOP_H, 6, { top: 0x78350f, left: 0xffffff, right: 0xe5e7eb });
  }
  c.addChild(g, glow);
  c.zIndex = depth(geo.deskCenter.x, geo.deskCenter.y, 400);

  return {
    container: c,
    glow,
    setActive(level: number, color = 0x67e8f9) {
      glow.tint = color;
      glow.alpha = 0.12 + level * 0.6;
    },
  };
}
