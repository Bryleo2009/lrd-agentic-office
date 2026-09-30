import type { Vec } from "../office/iso";
import type { CollisionMap } from "./CollisionMap";

/**
 * A* 8-direccional sobre la grilla, sin cortar esquinas, con suavizado por línea de visión.
 * Devuelve waypoints en coordenadas de mundo (centros de celda + destino exacto).
 */
export class Pathfinder {
  constructor(private map: CollisionMap) {}

  find(from: Vec, to: Vec): Vec[] | null {
    const m = this.map;
    const s = m.nearestWalkable(Math.floor(from.x), Math.floor(from.y));
    const g = m.nearestWalkable(Math.floor(to.x), Math.floor(to.y));
    const W = m.w;
    const H = m.h;
    const idx = (x: number, y: number) => y * W + x;
    const start = idx(s.x, s.y);
    const goal = idx(g.x, g.y);
    const gScore = new Float32Array(W * H).fill(Infinity);
    const came = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    const heap = new MinHeap();
    gScore[start] = 0;
    heap.push(start, this.h(s.x, s.y, g.x, g.y));
    const dirs = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ];
    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % W;
      const cy = (cur - cx) / W;
      for (const [dx, dy, cost] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (m.isBlocked(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (m.isBlocked(cx + dx, cy) || m.isBlocked(cx, cy + dy))) continue; // sin corner cutting
        const n = idx(nx, ny);
        if (closed[n]) continue;
        const ng = gScore[cur] + cost;
        if (ng < gScore[n]) {
          gScore[n] = ng;
          came[n] = cur;
          heap.push(n, ng + this.h(nx, ny, g.x, g.y));
        }
      }
    }
    if (!found) return null;
    const cells: Vec[] = [];
    for (let c = goal; c !== -1; c = came[c]) {
      const x = c % W;
      cells.push({ x: x + 0.5, y: (c - x) / W + 0.5 });
      if (c === start) break;
    }
    cells.reverse();
    // punto exacto de destino (si es transitable o está pegado a la celda meta)
    const pts: Vec[] = [{ x: from.x, y: from.y }, ...cells.slice(1)];
    pts.push({ x: to.x, y: to.y });
    return this.smooth(pts);
  }

  private h(ax: number, ay: number, bx: number, by: number): number {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  }

  /** String-pulling: elimina waypoints intermedios cuando hay paso libre con margen. */
  private smooth(pts: Vec[]): Vec[] {
    if (pts.length <= 2) return pts;
    const out: Vec[] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.map.hasClearance(pts[i], pts[j], 0.28)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}

class MinHeap {
  private k: number[] = [];
  private p: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, pri: number) {
    this.k.push(key);
    this.p.push(pri);
    let i = this.k.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.p[par] <= this.p[i]) break;
      this.swap(i, par);
      i = par;
    }
  }
  pop(): number {
    const top = this.k[0];
    const lk = this.k.pop()!;
    const lp = this.p.pop()!;
    if (this.k.length) {
      this.k[0] = lk;
      this.p[0] = lp;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.k.length && this.p[l] < this.p[m]) m = l;
        if (r < this.k.length && this.p[r] < this.p[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.k[a], this.k[b]] = [this.k[b], this.k[a]];
    [this.p[a], this.p[b]] = [this.p[b], this.p[a]];
  }
}
