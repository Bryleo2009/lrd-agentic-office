import { Container, Graphics } from "pixi.js";
import { depth, FACING_VEC, iso, type Facing, type Vec } from "../office/iso";
import { isoBox } from "./draw";

/** Silla de oficina con respaldo detrás del agente sentado. */
export function buildChair(seat: Vec, facing: Facing, color = 0x334155, seatH = 14): Container[] {
  const c = new Container();
  const g = new Graphics();
  const back = new Container();
  const gb = new Graphics();
  const f = FACING_VEC[facing];
  const base = iso(seat.x, seat.y);
  // sombra y base estrella
  g.ellipse(base.x, base.y, 15, 7).fill({ color: 0x0f172a, alpha: 0.1 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const p = iso(seat.x + Math.cos(a) * 0.26, seat.y + Math.sin(a) * 0.26, 1.5);
    g.moveTo(base.x, base.y - 2).lineTo(p.x, p.y).stroke({ width: 2, color: 0x475569 });
    g.circle(p.x, p.y + 1, 1.4).fill(0x1e293b);
  }
  const col = iso(seat.x, seat.y, seatH - 2);
  g.moveTo(base.x, base.y - 2).lineTo(col.x, col.y).stroke({ width: 2.4, color: 0x64748b });
  // asiento
  isoBox(g, seat.x - 0.26, seat.y - 0.26, 0.52, 0.52, seatH - 3, 3.5, { top: lighten(color, 0.25), left: color, right: darken(color, 0.25) });
  // respaldo (detrás, opuesto a la dirección de mirada)
  const bx = seat.x - f.x * 0.3;
  const by = seat.y - f.y * 0.3;
  if (facing === 1 || facing === 3) {
    isoBox(gb, bx - 0.24, by - 0.04, 0.48, 0.08, seatH + 2, 20, { top: lighten(color, 0.3), left: lighten(color, 0.08), right: darken(color, 0.2) });
  } else {
    isoBox(gb, bx - 0.04, by - 0.24, 0.08, 0.48, seatH + 2, 20, { top: lighten(color, 0.3), left: lighten(color, 0.08), right: darken(color, 0.2) });
  }
  // brazo del respaldo
  const bp = iso(bx, by, seatH);
  const bt = iso(bx, by, seatH + 3);
  gb.moveTo(bp.x, bp.y).lineTo(bt.x, bt.y).stroke({ width: 2, color: 0x475569 });
  c.addChild(g);
  back.addChild(gb);
  // El asiento siempre queda debajo del agente sentado; el respaldo se ordena por su posición.
  c.zIndex = depth(seat.x, seat.y, 300);
  back.zIndex = depth(bx, by, 360);
  return [c, back];
}

function lighten(c: number, f: number) {
  const r = (c >> 16) & 255,
    g = (c >> 8) & 255,
    b = c & 255;
  return (Math.round(r + (255 - r) * f) << 16) | (Math.round(g + (255 - g) * f) << 8) | Math.round(b + (255 - b) * f);
}
function darken(c: number, f: number) {
  const r = (c >> 16) & 255,
    g = (c >> 8) & 255,
    b = c & 255;
  return (Math.round(r * (1 - f)) << 16) | (Math.round(g * (1 - f)) << 8) | Math.round(b * (1 - f));
}
