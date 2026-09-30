import type { Container } from "pixi.js";
import { clamp, damp } from "./iso";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pan / zoom / fit-to-office con ratón, trackpad y táctil. Zoom limitado. */
export class CameraController {
  zoom = 1;
  private targetZoom = 1;
  x = 0;
  y = 0;
  private tx = 0;
  private ty = 0;
  minZoom = 0.35;
  maxZoom = 2.6;
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinch = 0;
  private dragging = false;
  private moved = 0;
  /** Padding inferior/superior ocupado por la UI (px). */
  insets = { top: 70, bottom: 64, left: 16, right: 16 };

  constructor(private world: Container, private el: HTMLElement, private bounds: Bounds) {
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
    el.style.touchAction = "none";
  }

  destroy(): void {
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
  }

  /** true si el último gesto fue un arrastre (para no seleccionar agentes al soltar). */
  wasDrag(): boolean {
    return this.moved > 6;
  }

  fit(immediate = false): void {
    const vw = this.el.clientWidth - this.insets.left - this.insets.right;
    const vh = this.el.clientHeight - this.insets.top - this.insets.bottom;
    const z = clamp(Math.min(vw / this.bounds.w, vh / this.bounds.h) * 0.97, this.minZoom, this.maxZoom);
    this.targetZoom = z;
    this.tx = this.insets.left + vw / 2 - (this.bounds.x + this.bounds.w / 2) * z;
    this.ty = this.insets.top + vh / 2 - (this.bounds.y + this.bounds.h / 2) * z;
    if (immediate) {
      this.zoom = z;
      this.x = this.tx;
      this.y = this.ty;
      this.apply();
    }
  }

  focus(sx: number, sy: number, zoom?: number): void {
    const z = clamp(zoom ?? Math.max(this.targetZoom, 1.2), this.minZoom, this.maxZoom);
    this.targetZoom = z;
    const vw = this.el.clientWidth;
    const vh = this.el.clientHeight;
    this.tx = vw * 0.42 - sx * z;
    this.ty = vh * 0.5 - sy * z;
  }

  private zoomAt(factor: number, px: number, py: number): void {
    const nz = clamp(this.targetZoom * factor, this.minZoom, this.maxZoom);
    const wx = (px - this.tx) / this.targetZoom;
    const wy = (py - this.ty) / this.targetZoom;
    this.targetZoom = nz;
    this.tx = px - wx * nz;
    this.ty = py - wy * nz;
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (e.ctrlKey) {
      // pinch de trackpad
      this.zoomAt(Math.exp(-e.deltaY * 0.012), px, py);
    } else if (e.deltaMode === 0 && Math.abs(e.deltaX) > 0.5) {
      // desplazamiento con dos dedos en trackpad
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
    } else {
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(Math.exp(-dy * 0.0016), px, py);
    }
  };

  private onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragging = true;
    this.moved = 0;
    if (this.pointers.size === 2) this.lastPinch = this.pinchDist();
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev || !this.dragging) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const d = this.pinchDist();
      if (this.lastPinch > 0) {
        const pts = [...this.pointers.values()];
        const r = this.el.getBoundingClientRect();
        this.zoomAt(d / this.lastPinch, (pts[0].x + pts[1].x) / 2 - r.left, (pts[0].y + pts[1].y) / 2 - r.top);
      }
      this.lastPinch = d;
      this.moved += 10;
      return;
    }
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.tx += dx;
    this.ty += dy;
    this.x += dx;
    this.y += dy;
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.lastPinch = 0;
    if (this.pointers.size === 0) this.dragging = false;
  };

  private pinchDist(): number {
    const p = [...this.pointers.values()];
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }

  update(dt: number): void {
    this.zoom = damp(this.zoom, this.targetZoom, 14, dt);
    this.x = damp(this.x, this.tx, 16, dt);
    this.y = damp(this.y, this.ty, 16, dt);
    this.apply();
  }

  private apply(): void {
    this.world.scale.set(this.zoom);
    this.world.position.set(this.x, this.y);
  }
}
