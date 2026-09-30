import { MAP_H, MAP_W, PARTITIONS, PROPS, STATIONS, stationGeometry } from "../environment/OfficeMap";
import type { Vec } from "../office/iso";

/** Grilla de celdas bloqueadas derivada del floorplan (muros, particiones, escritorios, sillas, props). */
export class CollisionMap {
  readonly w = MAP_W;
  readonly h = MAP_H;
  private blocked: Uint8Array;

  constructor() {
    this.blocked = new Uint8Array(this.w * this.h);
    // Borde exterior (muros y margen frontal)
    for (let x = 0; x < this.w; x++) {
      this.set(x, 0);
      this.set(x, this.h - 1);
    }
    for (let y = 0; y < this.h; y++) {
      this.set(0, y);
      this.set(this.w - 1, y);
    }
    // Particiones con puertas
    for (const p of PARTITIONS) {
      for (let i = p.from; i < p.to; i++) {
        if (p.doors.some(([a, b]) => i >= a && i < b)) continue;
        if (p.axis === "x") this.set(i, p.at);
        else this.set(p.at, i);
      }
    }
    for (const s of STATIONS) {
      const g = stationGeometry(s);
      this.blockRect(g.deskRect);
      this.blockRect(g.chairRect);
    }
    for (const pr of PROPS) if (pr.blocks) this.blockRect({ x0: pr.x, y0: pr.y, x1: pr.x + pr.w, y1: pr.y + pr.d });
  }

  private set(x: number, y: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.blocked[y * this.w + x] = 1;
  }

  private blockRect(r: { x0: number; y0: number; x1: number; y1: number }): void {
    const e = 0.02;
    for (let y = Math.floor(r.y0 + e); y <= Math.floor(r.y1 - e); y++) for (let x = Math.floor(r.x0 + e); x <= Math.floor(r.x1 - e); x++) this.set(x, y);
  }

  isBlocked(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return true;
    return this.blocked[y * this.w + x] === 1;
  }

  isWalkablePoint(p: Vec): boolean {
    return !this.isBlocked(Math.floor(p.x), Math.floor(p.y));
  }

  /** Línea de visión "gruesa": el segmento y un margen lateral no tocan celdas bloqueadas. */
  hasClearance(a: Vec, b: Vec, radius = 0.3): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const nx = -dy / len;
    const ny = dx / len;
    const steps = Math.ceil(len / 0.1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      for (const o of [-radius, 0, radius]) {
        if (this.isBlocked(Math.floor(x + nx * o), Math.floor(y + ny * o))) return false;
      }
    }
    return true;
  }

  nearestWalkable(cx: number, cy: number): { x: number; y: number } {
    if (!this.isBlocked(cx, cy)) return { x: cx, y: cy };
    for (let r = 1; r < 8; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!this.isBlocked(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
        }
    return { x: cx, y: cy };
  }
}
