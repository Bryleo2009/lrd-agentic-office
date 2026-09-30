/** Proyección isométrica 2:1. Coordenadas de mundo en tiles (continuas). */
export const TW = 64;
export const TH = 32;

export interface Vec {
  x: number;
  y: number;
}

export function iso(x: number, y: number, h = 0): Vec {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) - h };
}

/** Inversa (h = 0). */
export function unIso(sx: number, sy: number): Vec {
  const a = sx / (TW / 2);
  const b = sy / (TH / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Orden de profundidad: más abajo en pantalla = delante. */
export function depth(x: number, y: number, bias = 0): number {
  return Math.round((x + y) * 1000 + bias);
}

/** 0=SE(+x) 1=SW(+y) 2=NW(-x) 3=NE(-y) */
export type Facing = 0 | 1 | 2 | 3;

export const FACING_VEC: Record<Facing, Vec> = {
  0: { x: 1, y: 0 },
  1: { x: 0, y: 1 },
  2: { x: -1, y: 0 },
  3: { x: 0, y: -1 },
};

export function facingFromVec(dx: number, dy: number, prev: Facing = 0): Facing {
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return prev;
  // Dirección en pantalla para elegir la vista más natural.
  const sx = dx - dy; // derecha +
  const sy = dx + dy; // abajo +
  if (sy >= 0) return sx >= 0 ? 0 : 1;
  return sx >= 0 ? 3 : 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Suavizado exponencial independiente del framerate. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
