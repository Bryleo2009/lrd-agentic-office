import { Graphics, Matrix, Text, TextStyle } from "pixi.js";
import { iso, type Vec } from "../office/iso";

export function poly(g: Graphics, pts: Vec[], color: number, alpha = 1): void {
  g.poly(pts.flatMap((p) => [p.x, p.y])).fill({ color, alpha });
}

export interface BoxColors {
  top: number;
  left: number; // cara que mira +y (SO)
  right: number; // cara que mira +x (SE)
  alpha?: number;
}

/** Caja isométrica: huella [x, x+w] × [y, y+d], desde altura z0 con altura h (px). */
export function isoBox(g: Graphics, x: number, y: number, w: number, d: number, z0: number, h: number, c: BoxColors): void {
  const a = c.alpha ?? 1;
  const B0 = iso(x + w, y, z0);
  const C0 = iso(x + w, y + d, z0);
  const D0 = iso(x, y + d, z0);
  const A1 = iso(x, y, z0 + h);
  const B1 = iso(x + w, y, z0 + h);
  const C1 = iso(x + w, y + d, z0 + h);
  const D1 = iso(x, y + d, z0 + h);
  poly(g, [D1, C1, C0, D0], c.left, a);
  poly(g, [B1, C1, C0, B0], c.right, a);
  poly(g, [A1, B1, C1, D1], c.top, a);
}

/** Plano vertical a lo largo de x (en y fija). */
export function planeX(g: Graphics, x0: number, x1: number, y: number, z0: number, z1: number, color: number, alpha = 1): void {
  poly(g, [iso(x0, y, z1), iso(x1, y, z1), iso(x1, y, z0), iso(x0, y, z0)], color, alpha);
}

/** Plano vertical a lo largo de y (en x fija). */
export function planeY(g: Graphics, y0: number, y1: number, x: number, z0: number, z1: number, color: number, alpha = 1): void {
  poly(g, [iso(x, y0, z1), iso(x, y1, z1), iso(x, y1, z0), iso(x, y0, z0)], color, alpha);
}

export function floorQuad(g: Graphics, x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1, z = 0): void {
  poly(g, [iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z)], color, alpha);
}

export function isoEllipse(g: Graphics, cx: number, cy: number, rx: number, ry: number, z: number, color: number, alpha = 1): void {
  const c = iso(cx, cy, z);
  g.ellipse(c.x, c.y, (rx + ry) * 22, (rx + ry) * 11).fill({ color, alpha });
}

/** Texto pintado sobre el piso (dirección +x). */
export function floorText(text: string, x: number, y: number, size = 26, color = 0x64748b, alpha = 0.32): Text {
  const t = new Text({
    text,
    style: new TextStyle({ fontFamily: "Inter, system-ui, sans-serif", fontSize: size, fontWeight: "800", fill: color, letterSpacing: 5 }),
    resolution: 2,
  });
  t.alpha = alpha;
  const p = iso(x, y);
  // x del texto → +x del mundo (1, 0.5); y del texto → +y del mundo (-1, 0.5)
  t.setFromMatrix(new Matrix(0.72, 0.36, -0.72, 0.36, p.x, p.y));
  return t;
}

/** Texto sobre un muro paralelo a x (cara visible +y). */
export function wallTextX(text: string, x: number, y: number, z: number, size: number, color: number, weight: "400" | "600" | "700" = "600"): Text {
  const t = new Text({
    text,
    style: new TextStyle({ fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: size, fontWeight: weight, fill: color }),
    resolution: 3,
  });
  const p = iso(x, y, z);
  t.setFromMatrix(new Matrix(1, 0.5, 0, 1, p.x, p.y));
  return t;
}

/** Texto sobre un muro paralelo a y (cara visible +x). Se lee de y mayor a y menor. */
export function wallTextY(text: string, x: number, y: number, z: number, size: number, color: number): Text {
  const t = new Text({
    text,
    style: new TextStyle({ fontFamily: "Inter, system-ui, sans-serif", fontSize: size, fontWeight: "700", fill: color, letterSpacing: 2 }),
    resolution: 3,
  });
  const p = iso(x, y, z);
  t.setFromMatrix(new Matrix(1, -0.5, 0, 1, p.x, p.y));
  return t;
}
