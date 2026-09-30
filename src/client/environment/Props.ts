import { Container, Graphics, Text } from "pixi.js";
import { depth, iso } from "../office/iso";
import { isoBox, isoEllipse, planeX, planeY, poly, wallTextX, wallTextY } from "./draw";
import type { PropDef } from "./OfficeMap";

export interface PropView {
  container: Container;
  update?(dt: number, t: number): void;
}

const WHITE = { top: 0xfbfcfe, left: 0xe2e8f0, right: 0xcbd5e1 };
const GREY = { top: 0xe2e8f0, left: 0xcbd5e1, right: 0x94a3b8 };

export function buildProp(p: PropDef): PropView {
  const c = new Container();
  const g = new Graphics();
  c.addChild(g);
  c.zIndex = depth(p.x + p.w / 2, p.y + p.d / 2, 400);
  let update: PropView["update"];
  switch (p.kind) {
    case "plant":
    case "plant_small": {
      const big = p.kind === "plant";
      const cx = p.x + p.w / 2;
      const cy = p.y + p.d / 2;
      isoEllipse(g, cx + 0.05, cy + 0.08, 0.28, 0.28, 0, 0x0f172a, 0.08);
      const r = big ? 0.26 : 0.2;
      isoBox(g, cx - r, cy - r, r * 2, r * 2, 0, big ? 16 : 12, { top: 0x78716c, left: 0xf5f5f4, right: 0xd6d3d1 });
      const leaves = new Graphics();
      const base = iso(cx, cy, big ? 16 : 12);
      const greens = [0x16a34a, 0x22c55e, 0x15803d, 0x4ade80];
      const n = big ? 9 : 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = big ? 9 : 6;
        const x = base.x + Math.cos(a) * rr;
        const y = base.y - (big ? 16 : 10) + Math.sin(a) * rr * 0.6 - (i % 3) * 4;
        leaves.poly([x, y - 9, x + 7, y, x, y + 6, x - 7, y]).fill(greens[i % greens.length]);
      }
      leaves.poly([base.x, base.y - (big ? 40 : 28), base.x + 8, base.y - (big ? 22 : 14), base.x - 8, base.y - (big ? 22 : 14)]).fill(0x22c55e);
      c.addChild(leaves);
      let t0 = Math.random() * 10;
      update = (dt) => {
        t0 += dt;
        leaves.skew.x = Math.sin(t0 * 0.8) * 0.02;
      };
      break;
    }
    case "bookshelf": {
      isoBox(g, p.x, p.y, p.w, p.d, 0, 66, { top: 0xf1f5f9, left: 0xd8dee8, right: 0xbac4d2 });
      const colors = [0x3b82f6, 0xef4444, 0xf59e0b, 0x10b981, 0x8b5cf6, 0x0ea5e9, 0x64748b];
      for (let s = 0; s < 4; s++) {
        const z = 6 + s * 15;
        planeY(g, p.y + 0.05, p.y + p.d - 0.05, p.x + p.w + 0.001, z, z + 12, 0x94a3b8, 0.35);
        let y = p.y + 0.1;
        let k = s;
        while (y < p.y + p.d - 0.15) {
          const bw = 0.08 + ((k * 37) % 5) * 0.02;
          planeY(g, y, y + bw, p.x + p.w + 0.002, z, z + 8 + ((k * 13) % 4), colors[k % colors.length], 0.9);
          y += bw + 0.02;
          k++;
        }
      }
      break;
    }
    case "rack": {
      isoBox(g, p.x + 0.05, p.y + 0.05, p.w - 0.1, p.d - 0.1, 0, 82, { top: 0x334155, left: 0x1e293b, right: 0x0f172a });
      const leds = new Graphics();
      const pts: { x: number; y: number; on: number; col: number }[] = [];
      for (let row = 0; row < 9; row++)
        for (let i = 0; i < 4; i++) {
          const q = iso(p.x + 0.2 + i * 0.16, p.y + p.d - 0.05 + 0.001, 10 + row * 8);
          pts.push({ x: q.x, y: q.y, on: Math.random(), col: Math.random() < 0.8 ? 0x22c55e : 0x38bdf8 });
        }
      for (let row = 0; row < 9; row++) planeX(g, p.x + 0.1, p.x + p.w - 0.1, p.y + p.d - 0.049, 7 + row * 8, 8 + row * 8, 0x475569);
      c.addChild(leds);
      let acc = 0;
      update = (dt) => {
        acc += dt;
        if (acc < 0.12) return;
        acc = 0;
        leds.clear();
        for (const l of pts) {
          if (Math.random() < 0.18) l.on = Math.random();
          if (l.on > 0.35) leds.rect(l.x - 1, l.y - 1, 2.4, 1.6).fill({ color: l.col, alpha: 0.95 });
        }
      };
      break;
    }
    case "test_bench": {
      isoBox(g, p.x, p.y, p.w, p.d, 22, 3, WHITE);
      isoBox(g, p.x + 0.1, p.y + 0.1, 0.08, p.d - 0.2, 0, 22, GREY);
      isoBox(g, p.x + p.w - 0.18, p.y + 0.1, 0.08, p.d - 0.2, 0, 22, GREY);
      const screens = new Graphics();
      const n = 3;
      const lines: { i: number; w: number; col: number }[][] = [[], [], []];
      c.addChild(screens);
      let acc = 0;
      let state: "idle" | "running" | "pass" | "fail" = "idle";
      (c as any).setState = (s: typeof state) => (state = s);
      const draw = () => {
        screens.clear();
        for (let k = 0; k < n; k++) {
          const x0 = p.x + 0.25 + k * 1.2;
          const x1 = x0 + 1.0;
          const y = p.y + 0.35;
          isoBox(screens, x0, y - 0.04, 1.0, 0.06, 26, 26, { top: 0x475569, left: 0x1f2937, right: 0x111827 });
          planeX(screens, x0 + 0.05, x1 - 0.05, y + 0.021, 28, 50, state === "fail" ? 0x2a0f14 : 0x0b1a2a);
          const ls = lines[k];
          for (let j = 0; j < ls.length; j++) {
            const l = ls[j];
            planeX(screens, x0 + 0.1, x0 + 0.1 + l.w, y + 0.022, 47 - j * 2.6, 48.2 - j * 2.6, l.col, 0.9);
          }
          const statusCol = state === "pass" ? 0x22c55e : state === "fail" ? 0xef4444 : state === "running" ? 0xf59e0b : 0x38bdf8;
          planeX(screens, x0 + 0.05, x1 - 0.05, y + 0.022, 28, 29.5, statusCol, 0.95);
        }
      };
      update = (dt) => {
        acc += dt;
        const speed = state === "running" ? 0.09 : 0.7;
        if (acc < speed) return;
        acc = 0;
        for (let k = 0; k < n; k++) {
          const ls = lines[k];
          const col = state === "fail" && Math.random() < 0.4 ? 0xf87171 : state === "pass" ? 0x4ade80 : Math.random() < 0.8 ? 0x67e8f9 : 0xa5b4fc;
          ls.unshift({ i: 0, w: 0.2 + Math.random() * 0.65, col });
          if (ls.length > 7) ls.pop();
        }
        draw();
      };
      draw();
      break;
    }
    case "coffee_counter": {
      isoBox(g, p.x, p.y, p.w, p.d, 0, 30, { top: 0xf5f5f4, left: 0xa8a29e, right: 0x8b857f });
      planeX(g, p.x + 0.05, p.x + p.w - 0.05, p.y + p.d + 0.001, 4, 28, 0xb9a48a, 0.5);
      // cafetera
      isoBox(g, p.x + 0.4, p.y + 0.15, 0.55, 0.5, 30, 22, { top: 0x44403c, left: 0x292524, right: 0x1c1917 });
      const led = iso(p.x + 0.55, p.y + 0.65 + 0.001, 44);
      g.circle(led.x, led.y, 1.6).fill(0xef4444);
      isoBox(g, p.x + 1.4, p.y + 0.2, 0.45, 0.4, 30, 18, { top: 0xd6d3d1, left: 0xa8a29e, right: 0x78716c });
      for (let i = 0; i < 4; i++) isoBox(g, p.x + 2.3 + i * 0.2, p.y + 0.35, 0.12, 0.12, 30, 6, { top: 0x78350f, left: 0xffffff, right: 0xe7e5e4 });
      isoBox(g, p.x + 3.2, p.y + 0.2, 0.5, 0.5, 30, 3, { top: 0xf59e0b, left: 0xd97706, right: 0xb45309 });
      break;
    }
    case "water": {
      isoBox(g, p.x + 0.1, p.y + 0.05, p.w - 0.2, p.d - 0.1, 0, 30, { top: 0xf8fafc, left: 0xe2e8f0, right: 0xcbd5e1 });
      const top = iso(p.x + p.w / 2, p.y + p.d / 2, 30);
      g.roundRect(top.x - 7, top.y - 20, 14, 20, 5).fill({ color: 0x7dd3fc, alpha: 0.75 });
      g.roundRect(top.x - 4, top.y - 18, 3, 14, 2).fill({ color: 0xffffff, alpha: 0.5 });
      break;
    }
    case "high_table": {
      const cx = p.x + p.w / 2;
      const cy = p.y + p.d / 2;
      isoEllipse(g, cx, cy, 0.25, 0.25, 0, 0x0f172a, 0.08);
      const a = iso(cx, cy, 0);
      const b = iso(cx, cy, 36);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 3, color: 0x64748b });
      g.ellipse(b.x, b.y, 22, 11).fill(0xfafaf9).stroke({ width: 1, color: 0xd6d3d1 });
      g.ellipse(b.x, b.y + 2, 22, 11).fill({ color: 0xa8a29e, alpha: 0.4 });
      g.ellipse(b.x, b.y, 22, 11).fill(0xfafaf9);
      break;
    }
    case "sofa": {
      const col = { top: 0x94a3b8, left: 0x64748b, right: 0x475569 };
      isoBox(g, p.x, p.y + 0.35, p.w, p.d - 0.35, 0, 13, col);
      isoBox(g, p.x, p.y + p.d - 0.3, p.w, 0.3, 0, 30, { top: 0xa3b1c2, left: 0x64748b, right: 0x4b5563 });
      isoBox(g, p.x - 0.05, p.y + 0.3, 0.3, p.d - 0.3, 0, 21, col);
      isoBox(g, p.x + p.w - 0.25, p.y + 0.3, 0.3, p.d - 0.3, 0, 21, col);
      isoBox(g, p.x + 0.4, p.y + p.d - 0.5, 0.45, 0.18, 13, 12, { top: 0xfbbf24, left: 0xf59e0b, right: 0xd97706 });
      c.zIndex = depth(p.x + p.w / 2, p.y + p.d - 0.1, 400);
      break;
    }
    case "coffee_table": {
      isoBox(g, p.x, p.y, p.w, p.d, 10, 3, { top: 0xd6bfa0, left: 0xb08d62, right: 0x96744b });
      isoBox(g, p.x + 0.1, p.y + 0.1, 0.06, 0.06, 0, 10, GREY);
      isoBox(g, p.x + p.w - 0.16, p.y + p.d - 0.16, 0.06, 0.06, 0, 10, GREY);
      isoBox(g, p.x + 0.5, p.y + 0.3, 0.14, 0.14, 13, 6, { top: 0x78350f, left: 0xffffff, right: 0xe5e7eb });
      poly(g, [iso(p.x + 0.9, p.y + 0.2, 13.2), iso(p.x + 1.4, p.y + 0.2, 13.2), iso(p.x + 1.4, p.y + 0.6, 13.2), iso(p.x + 0.9, p.y + 0.6, 13.2)], 0x3b82f6, 0.8);
      break;
    }
    case "meeting_table": {
      isoEllipse(g, p.x + p.w / 2, p.y + p.d / 2 + 0.2, 1.4, 0.6, 0, 0x0f172a, 0.06);
      isoBox(g, p.x + 0.5, p.y + 0.6, 0.1, 0.1, 0, 22, GREY);
      isoBox(g, p.x + p.w - 0.6, p.y + 0.6, 0.1, 0.1, 0, 22, GREY);
      isoBox(g, p.x + 0.5, p.y + p.d - 0.7, 0.1, 0.1, 0, 22, GREY);
      isoBox(g, p.x + p.w - 0.6, p.y + p.d - 0.7, 0.1, 0.1, 0, 22, GREY);
      isoBox(g, p.x, p.y, p.w, p.d, 22, 3.5, { top: 0xfbfcfe, left: 0xd9e0e8, right: 0xc4cedb });
      planeX(g, p.x, p.x + p.w, p.y + p.d + 0.001, 22, 23.5, 0x8b5cf6, 0.8);
      // laptops y papeles
      for (const [lx, ly] of [
        [p.x + 0.9, p.y + 0.35],
        [p.x + 2.6, p.y + 0.35],
        [p.x + 1.8, p.y + p.d - 0.75],
      ]) {
        isoBox(g, lx, ly, 0.5, 0.35, 25.5, 1.2, { top: 0xcbd5e1, left: 0x94a3b8, right: 0x64748b });
      }
      poly(g, [iso(p.x + 3.6, p.y + 1.1, 25.7), iso(p.x + 4.1, p.y + 1.0, 25.7), iso(p.x + 4.2, p.y + 1.5, 25.7), iso(p.x + 3.7, p.y + 1.6, 25.7)], 0xffffff);
      break;
    }
    case "printer": {
      isoBox(g, p.x, p.y, p.w, p.d, 0, 22, { top: 0xe5e7eb, left: 0xd1d5db, right: 0x9ca3af });
      isoBox(g, p.x + 0.1, p.y + 0.1, p.w - 0.2, p.d - 0.2, 22, 8, { top: 0xf3f4f6, left: 0xd1d5db, right: 0xa1a1aa });
      poly(g, [iso(p.x + 0.25, p.y + 0.2, 30.2), iso(p.x + p.w - 0.25, p.y + 0.2, 30.2), iso(p.x + p.w - 0.25, p.y + p.d - 0.3, 30.2), iso(p.x + 0.25, p.y + p.d - 0.3, 30.2)], 0xffffff);
      break;
    }
    case "cabinet": {
      isoBox(g, p.x, p.y, p.w, p.d, 0, 34, { top: 0xf1f5f9, left: 0xdfe5ec, right: 0xc5cfdb });
      if (p.w >= p.d) for (let i = 0; i < 3; i++) planeX(g, p.x + 0.1, p.x + p.w - 0.1, p.y + p.d + 0.001, 6 + i * 10, 6.8 + i * 10, 0x94a3b8, 0.6);
      else for (let i = 0; i < 3; i++) planeY(g, p.y + 0.1, p.y + p.d - 0.1, p.x + p.w + 0.001, 6 + i * 10, 6.8 + i * 10, 0x94a3b8, 0.6);
      isoBox(g, p.x + 0.2, p.y + 0.15, 0.3, 0.25, 34, 12, { top: 0x16a34a, left: 0xf5f5f4, right: 0xd6d3d1 });
      break;
    }
    case "whiteboard": {
      planeX(g, p.x, p.x + p.w, 0.02, 34, 84, 0xffffff);
      planeX(g, p.x - 0.04, p.x + p.w + 0.04, 0.021, 32, 34, 0x94a3b8);
      planeX(g, p.x - 0.04, p.x + p.w + 0.04, 0.021, 84, 86, 0xcbd5e1);
      const s = new Graphics();
      const strokes: [number, number, number, number][] = [
        [0.3, 76, 1.8, 76],
        [0.3, 72, 1.3, 72],
        [0.3, 66, 2.2, 66],
        [2.6, 78, 3.9, 70],
        [2.6, 70, 3.9, 78],
      ];
      for (const [x0, z0, x1, z1] of strokes) {
        const a = iso(p.x + x0, 0.03, z0);
        const b = iso(p.x + x1, 0.03, z1);
        s.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1.6, color: 0x1d4ed8, alpha: 0.8 });
      }
      const boxes: [number, number, number][] = [
        [0.4, 44, 0xfde047],
        [1.0, 46, 0xf9a8d4],
        [1.6, 43, 0x86efac],
        [2.3, 47, 0x93c5fd],
        [3.4, 44, 0xfde047],
      ];
      for (const [x0, z0, col] of boxes) planeX(s, p.x + x0, p.x + x0 + 0.42, 0.03, z0, z0 + 11, col);
      const arrowA = iso(p.x + 1.9, 0.03, 60);
      const arrowB = iso(p.x + 2.5, 0.03, 60);
      s.moveTo(arrowA.x, arrowA.y).lineTo(arrowB.x, arrowB.y).stroke({ width: 1.6, color: 0xdc2626 });
      c.addChild(s);
      c.zIndex = -5;
      break;
    }
    case "wall_screen": {
      c.zIndex = -5;
      break;
    }
  }
  return { container: c, update };
}

/** Pantalla mural del Centro de Misiones con contenido vivo (eventos reales). */
export class MissionWallScreen {
  readonly container = new Container();
  private lines: Text[] = [];
  private header: Text;
  private status: Graphics;
  private t = 0;

  constructor(private x0: number, private x1: number) {
    const g = new Graphics();
    planeX(g, x0 - 0.06, x1 + 0.06, 0.02, 30, 92, 0x1e293b);
    planeX(g, x0, x1, 0.022, 33, 89, 0x0b1220);
    planeX(g, x0, x1, 0.023, 86, 89, 0x0ea5e9, 0.9);
    this.container.addChild(g);
    this.header = wallTextX("CENTRO DE MISIONES · LRD", x0 + 0.15, 0.024, 84, 7, 0x7dd3fc, "700");
    this.container.addChild(this.header);
    for (let i = 0; i < 6; i++) {
      const t = wallTextX("", x0 + 0.15, 0.024, 74 - i * 7, 6, 0xcbd5e1, "400");
      this.lines.push(t);
      this.container.addChild(t);
    }
    this.status = new Graphics();
    this.container.addChild(this.status);
    this.setLines(["Esperando misión…", "Motores: comprobando", "", "", "", ""], "idle");
    this.container.zIndex = -4;
  }

  setLines(lines: string[], state: "idle" | "running" | "done" | "failed"): void {
    for (let i = 0; i < this.lines.length; i++) {
      const s = lines[i] ?? "";
      this.lines[i].text = s.length > 46 ? s.slice(0, 45) + "…" : s;
    }
    const col = state === "running" ? 0xf59e0b : state === "done" ? 0x22c55e : state === "failed" ? 0xef4444 : 0x38bdf8;
    this.status.clear();
    const p = iso(this.x1 - 0.3, 0.024, 84);
    this.status.circle(p.x, p.y + 3, 2.4).fill(col);
  }

  update(dt: number): void {
    this.t += dt;
    this.status.alpha = 0.6 + 0.4 * Math.sin(this.t * 3);
  }
}

/** Pantalla de la sala de misión (muro x=0). */
export function buildMeetingScreen(y0: number, y1: number): Container {
  const c = new Container();
  const g = new Graphics();
  planeY(g, y0 - 0.06, y1 + 0.06, 0.02, 30, 84, 0x1e293b);
  planeY(g, y0, y1, 0.022, 33, 81, 0x0f1b2d);
  planeY(g, y0, y1, 0.023, 33, 35, 0x8b5cf6, 0.9);
  c.addChild(g);
  c.addChild(wallTextY("SALA DE MISIÓN", 0.024, y1 - 0.3, 74, 8, 0xc4b5fd));
  const bars = new Graphics();
  for (let i = 0; i < 5; i++) planeY(bars, y1 - 0.4 - i * 0.7, y1 - 0.4 - i * 0.7 - 0.45, 0.024, 40, 44 + i * 5, 0x38bdf8, 0.7);
  c.addChild(bars);
  c.zIndex = -4;
  return c;
}
