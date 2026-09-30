import { useEffect, useRef, useState } from "react";

/**
 * Ventana flotante movible (arrastrando el encabezado) y redimensionable (esquina), que recuerda su
 * posición y tamaño en este navegador. Mismo comportamiento que el chat y la tablet.
 */
export function useFloating(storageKey: string, open: boolean) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; w: number; h: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      return v && typeof v.x === "number" ? v : null;
    } catch {
      return null;
    }
  });
  const save = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }));
    } catch {
      /* sin almacenamiento */
    }
  };
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(save);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const style = pos
    ? { left: Math.max(0, Math.min(pos.x, window.innerWidth - 260)), top: Math.max(60, Math.min(pos.y, window.innerHeight - 140)), width: pos.w, height: pos.h }
    : undefined;
  const headProps = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button, select, input, textarea, a")) return;
      const r = ref.current!.getBoundingClientRect();
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag.current || !ref.current) return;
      const r = ref.current.getBoundingClientRect();
      setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy, w: r.width, h: r.height });
    },
    onPointerUp: () => {
      drag.current = null;
      save();
    },
  };
  return { ref, style, headProps };
}

/** "hace 5 min", "hace 3 h", "hace 2 días". */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `hace ${d} día${d === 1 ? "" : "s"}`;
}
