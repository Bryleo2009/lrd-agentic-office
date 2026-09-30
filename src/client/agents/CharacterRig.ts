import { Container, Graphics } from "pixi.js";

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: "side_part" | "curly" | "ponytail" | "bun" | "bob" | "buzz" | "wavy" | "long";
  outfit: "blazer" | "hoodie" | "sweater" | "shirt" | "polo" | "blouse";
  shirt: string;
  shirtAccent: string;
  pants: string;
  shoes: string;
  accessory: "none" | "glasses" | "headphones" | "headset" | "badge" | "earrings";
  height: number;
  build: number;
  beard?: boolean;
  renderer?: "rig" | "spritesheet";
}

export const DEFAULT_APPEARANCE: Appearance = {
  skin: "#e0ac82",
  hair: "#2b1d16",
  hairStyle: "side_part",
  outfit: "shirt",
  shirt: "#3b82f6",
  shirtAccent: "#dbeafe",
  pants: "#334155",
  shoes: "#111827",
  accessory: "none",
  height: 1,
  build: 1,
};

const hex = (s: string) => parseInt(s.replace("#", ""), 16);

export function shade(color: number, f: number): number {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const m = (c: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f))));
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

// Medidas base (px) — pies en (0,0)
export const RIG = {
  HIP_Y: -25,
  THIGH: 12.5,
  SHIN: 12.5,
  SHOULDER_Y: -43.5,
  UPPER: 10,
  FORE: 9.5,
  NECK_Y: -47,
  HEAD_R: 8.4,
};

export interface Limb {
  upper: Container;
  lower: Container;
}

export interface RigView {
  root: Container;
  legNear: Limb;
  legFar: Limb;
  armNear: Limb;
  armFar: Limb;
  torso: Container;
  head: Container;
  heldTablet: Container;
  heldCup: Container;
  heldClipboard: Container;
}

/** Construye una vista del rig: frente (3/4 hacia la derecha) o espalda (3/4 hacia arriba-derecha). */
export function buildRigView(a: Appearance, back: boolean): RigView {
  const b = a.build;
  const skin = hex(a.skin);
  const hair = hex(a.hair);
  const shirt = hex(a.shirt);
  const accent = hex(a.shirtAccent);
  const pants = hex(a.pants);
  const shoes = hex(a.shoes);
  const longSleeve = a.outfit !== "polo";
  const root = new Container();

  // ---------- piernas ----------
  const mkLeg = (x: number, near: boolean): Limb => {
    const upper = new Container();
    upper.position.set(x, RIG.HIP_Y);
    const gu = new Graphics();
    const pc = near ? pants : shade(pants, -0.18);
    gu.roundRect(-3.5 * b, -1.5, 7 * b, RIG.THIGH + 3, 3.2).fill(pc);
    upper.addChild(gu);
    const lower = new Container();
    lower.position.set(0, RIG.THIGH);
    const gl = new Graphics();
    gl.roundRect(-3.1 * b, -1, 6.2 * b, RIG.SHIN - 1, 3).fill(pc);
    gl.roundRect(-3.6 * b, RIG.SHIN - 3.6, 9.2 * b, 4.4, 2.2).fill(near ? shoes : shade(shoes, -0.15));
    gl.roundRect(-3.6 * b, RIG.SHIN - 0.9, 9.2 * b, 1.3, 0.6).fill({ color: 0xffffff, alpha: 0.35 });
    lower.addChild(gl);
    upper.addChild(lower);
    return { upper, lower };
  };

  // ---------- brazos ----------
  const mkArm = (x: number, near: boolean): Limb => {
    const upper = new Container();
    upper.position.set(x, RIG.SHOULDER_Y);
    const sc = near ? shirt : shade(shirt, -0.2);
    const gu = new Graphics();
    gu.roundRect(-3.2, -2, 6.4, RIG.UPPER + 3, 3.2).fill(sc);
    upper.addChild(gu);
    const lower = new Container();
    lower.position.set(0, RIG.UPPER);
    const gl = new Graphics();
    gl.roundRect(-2.8, -1, 5.6, RIG.FORE, 2.8).fill(longSleeve ? sc : near ? skin : shade(skin, -0.12));
    if (longSleeve) gl.roundRect(-2.9, RIG.FORE - 2.4, 5.8, 1.6, 0.8).fill(shade(sc, -0.15));
    gl.circle(0, RIG.FORE + 0.8, 2.7).fill(near ? skin : shade(skin, -0.12));
    lower.addChild(gl);
    upper.addChild(lower);
    return { upper, lower };
  };

  const shadowG = new Graphics();
  shadowG.ellipse(1, 0, 12 * b, 5.2).fill({ color: 0x1e293b, alpha: 0.16 });

  const legFar = mkLeg(-3.4 * b, false);
  const legNear = mkLeg(3.6 * b, true);
  const armFar = mkArm(back ? 7.6 * b : -7.4 * b, false);
  const armNear = mkArm(back ? -7.4 * b : 7.8 * b, true);

  // ---------- torso ----------
  const torso = new Container();
  const t = new Graphics();
  const tw = 18 * b;
  t.roundRect(-8.6 * b, -28.5, 17.2 * b, 6.5, 3).fill(pants); // cadera
  t.roundRect(-tw / 2, -47.5, tw, 22, 6.5).fill(shirt);
  t.roundRect(tw / 2 - 6 * b, -46.5, 5.4 * b, 20, 5).fill({ color: 0x000000, alpha: 0.13 }); // sombreado
  t.roundRect(-tw / 2 + 1, -46.5, 3, 18, 2).fill({ color: 0xffffff, alpha: 0.12 }); // brillo
  if (!back) {
    switch (a.outfit) {
      case "blazer":
        t.poly([-3, -47.5, 3.2, -47.5, 0.2, -36]).fill(accent);
        t.poly([-0.6, -44.5, 1, -44.5, 1.2, -35.5, 0.2, -34, -0.8, -35.5]).fill(0x1f2937);
        t.poly([-3.4, -47.5, -0.2, -38, -5.2, -43]).fill(shade(shirt, 0.12));
        t.poly([3.6, -47.5, 0.6, -38, 5.6, -43]).fill(shade(shirt, -0.08));
        t.circle(1.5, -31, 0.9).fill(shade(shirt, 0.3));
        t.circle(1.5, -28.8, 0.9).fill(shade(shirt, 0.3));
        break;
      case "hoodie":
        t.roundRect(-7.2 * b, -49.5, 14.4 * b, 5.5, 2.8).fill(shade(shirt, -0.12));
        t.roundRect(-5.5 * b, -33.5, 11 * b, 5.2, 2.2).fill(shade(shirt, -0.1));
        t.rect(-1.8, -44.5, 0.8, 6).fill(accent);
        t.rect(1.6, -44.5, 0.8, 5).fill(accent);
        break;
      case "sweater":
        t.ellipse(0.5, -46.8, 4.6, 1.8).fill(accent);
        t.roundRect(-tw / 2, -28.5, tw, 2.6, 1.2).fill(shade(shirt, -0.14));
        break;
      case "shirt":
        t.poly([-3.2, -47.5, 0, -44, -1.2, -42.5, -4.4, -46]).fill(accent);
        t.poly([3.6, -47.5, 0.4, -44, 1.6, -42.5, 4.8, -46]).fill(accent);
        for (let i = 0; i < 4; i++) t.circle(0.4, -41 + i * 3.6, 0.6).fill(shade(shirt, 0.35));
        break;
      case "polo":
        t.poly([-3.8, -47.8, 0, -44.2, -1.4, -42.4, -5, -45.8]).fill(accent);
        t.poly([4.2, -47.8, 0.4, -44.2, 1.8, -42.4, 5.4, -45.8]).fill(accent);
        t.rect(-0.3, -44, 1.2, 5).fill(shade(shirt, -0.15));
        break;
      case "blouse":
        t.poly([-3.4, -47.5, 3.8, -47.5, 0.3, -41.5]).fill(skin);
        t.poly([-3.4, -47.5, 0.3, -41.5, -0.6, -41, -4.6, -46.5]).fill(accent);
        t.poly([3.8, -47.5, 0.3, -41.5, 1.2, -41, 5, -46.5]).fill(accent);
        break;
    }
    if (a.accessory === "badge") {
      t.moveTo(-3.5, -47).lineTo(-1, -38).lineTo(1.8, -47).stroke({ width: 0.9, color: 0x1d4ed8 });
      t.roundRect(-3, -38.5, 4.4, 5.6, 0.9).fill(0xffffff);
      t.rect(-2.3, -37.3, 3, 1.3).fill(0x10b981);
    }
  } else {
    if (a.outfit === "hoodie") t.roundRect(-6.5 * b, -50, 13 * b, 8.5, 4).fill(shade(shirt, -0.14));
    else t.roundRect(-4.8, -48.2, 9.6, 2.4, 1.2).fill(a.outfit === "blazer" ? shade(shirt, -0.1) : accent);
  }
  // cuello
  t.roundRect(-2.6, -50.5, 5.4, 5, 2).fill(shade(skin, -0.08));
  torso.addChild(t);

  // ---------- cabeza ----------
  const head = new Container();
  head.position.set(0.5, RIG.NECK_Y);
  const hb = new Graphics(); // pelo detrás
  const hf = new Graphics(); // cara
  const hh = new Graphics(); // pelo delante + accesorios
  const R = RIG.HEAD_R;
  const cy = -8.8;
  drawHairBack(hb, a.hairStyle, hair, back, R, cy);
  hf.circle(1, cy, R).fill(skin);
  hf.ellipse(1.6, cy + 4.6, R * 0.78, R * 0.5).fill(skin); // mandíbula
  if (!back) {
    hf.ellipse(-4.6, cy + 0.6, 2.1, 2.7).fill(shade(skin, -0.14)); // oreja
    hf.ellipse(3.3, cy - 0.3, 1.05, 1.55).fill(0x1f2430);
    hf.ellipse(7.1, cy - 0.3, 1.0, 1.5).fill(0x1f2430);
    hf.circle(3.6, cy - 0.8, 0.35).fill(0xffffff);
    hf.circle(7.3, cy - 0.8, 0.35).fill(0xffffff);
    hf.roundRect(2.1, cy - 3.3, 2.6, 0.8, 0.4).fill(shade(hair, 0.1));
    hf.roundRect(6.1, cy - 3.3, 2.4, 0.8, 0.4).fill(shade(hair, 0.1));
    hf.ellipse(8.9, cy + 1.6, 0.9, 1.1).fill(shade(skin, -0.12)); // nariz
    hf.moveTo(4.2, cy + 4.3).quadraticCurveTo(5.8, cy + 5.6, 7.4, cy + 4.3).stroke({ width: 0.9, color: 0x9a3b3b, alpha: 0.85 });
    hf.circle(2.3, cy + 2.8, 1.5).fill({ color: 0xf87171, alpha: 0.18 });
    hf.circle(8.4, cy + 2.8, 1.2).fill({ color: 0xf87171, alpha: 0.18 });
    if (a.beard) hf.ellipse(4, cy + 5.2, 6.4, 3.6).fill({ color: hair, alpha: 0.55 });
  } else {
    hf.ellipse(-4.3, cy + 0.9, 2, 2.6).fill(shade(skin, -0.14));
  }
  drawHairFront(hh, a.hairStyle, hair, back, R, cy);
  drawAccessory(hh, a.accessory, back, R, cy);
  head.addChild(hb, hf, hh);

  // ---------- objetos en mano ----------
  const heldTablet = new Container();
  const tg = new Graphics();
  tg.roundRect(-2, -10, 11, 14, 2).fill(0x1e293b);
  tg.roundRect(-1, -9, 9, 12, 1.4).fill(0x67e8f9);
  tg.rect(0.5, -7, 6, 0.8).fill({ color: 0x0e7490, alpha: 0.7 });
  tg.rect(0.5, -5, 4.5, 0.8).fill({ color: 0x0e7490, alpha: 0.7 });
  tg.rect(0.5, -3, 5.5, 0.8).fill({ color: 0x0e7490, alpha: 0.7 });
  heldTablet.addChild(tg);
  heldTablet.position.set(1, RIG.FORE - 1);
  heldTablet.visible = false;

  const heldCup = new Container();
  const cg = new Graphics();
  cg.roundRect(-2.4, -6, 5.2, 6.5, 1.4).fill(0xffffff);
  cg.roundRect(-2.4, -6, 5.2, 1.4, 0.7).fill(0x92400e);
  cg.circle(3.4, -3, 1.6).stroke({ width: 1, color: 0xffffff });
  heldCup.addChild(cg);
  heldCup.position.set(1.5, RIG.FORE + 0.5);
  heldCup.visible = false;

  const heldClipboard = new Container();
  const kg = new Graphics();
  kg.roundRect(-2, -11, 10, 13, 1.2).fill(0x92400e);
  kg.rect(-0.8, -9.5, 7.6, 10.5).fill(0xffffff);
  kg.rect(1.5, -12, 3, 2).fill(0x94a3b8);
  kg.moveTo(0.3, -6).lineTo(1.3, -5).lineTo(3, -7.5).stroke({ width: 0.9, color: 0x10b981 });
  kg.moveTo(0.3, -2.5).lineTo(1.3, -1.5).lineTo(3, -4).stroke({ width: 0.9, color: 0x10b981 });
  heldClipboard.addChild(kg);
  heldClipboard.position.set(1, RIG.FORE - 1);
  heldClipboard.visible = false;

  armNear.lower.addChild(heldTablet, heldCup, heldClipboard);

  // Orden de dibujo
  if (!back) root.addChild(shadowG, armFar.upper, legFar.upper, legNear.upper, torso, head, armNear.upper);
  else root.addChild(shadowG, legFar.upper, legNear.upper, armNear.upper, armFar.upper, torso, head);
  if (back) {
    // en vista de espalda los brazos quedan a los lados del torso
    root.setChildIndex(armFar.upper, root.children.length - 1);
  }

  return { root, legNear, legFar, armNear, armFar, torso, head, heldTablet, heldCup, heldClipboard };
}

function drawHairBack(g: Graphics, style: Appearance["hairStyle"], c: number, back: boolean, R: number, cy: number) {
  switch (style) {
    case "long":
      g.roundRect(-9.5, cy - 4, 14, 21, 7).fill(shade(c, -0.1));
      break;
    case "bob":
      g.roundRect(-8.8, cy - 5, 14.5, 14, 6).fill(shade(c, -0.08));
      break;
    case "ponytail":
      g.ellipse(-9.2, cy + 3.5, 3.4, 7.5).fill(shade(c, -0.1));
      g.circle(-7, cy - 3, 2.4).fill(shade(c, 0.2));
      break;
    case "bun":
      g.circle(-5.2, cy - 8.8, 4.6).fill(c);
      break;
    case "wavy":
      g.ellipse(-3, cy + 1.5, 7.6, 8.5).fill(shade(c, -0.08));
      break;
    default:
      break;
  }
  if (back && style === "ponytail") g.ellipse(-2, cy + 6.5, 3.2, 7).fill(shade(c, -0.1));
}

function drawHairFront(g: Graphics, style: Appearance["hairStyle"], c: number, back: boolean, R: number, cy: number) {
  const hl = shade(c, 0.22);
  if (back) {
    // casquete completo
    g.circle(1, cy - 0.5, R + 0.6).fill(c);
    g.ellipse(1, cy + 3.5, R * 0.95, R * 0.55).fill(c);
    if (style === "long") g.roundRect(-8.4, cy, 18.5, 16, 7).fill(c);
    if (style === "bob") g.roundRect(-8.2, cy, 18.5, 9, 5).fill(c);
    if (style === "buzz") g.circle(1, cy - 0.5, R + 0.2).fill({ color: shade(c, 0.1), alpha: 0.4 });
    if (style === "curly") for (let i = 0; i < 9; i++) g.circle(-6 + (i % 5) * 3.6, cy - 6 + Math.floor(i / 5) * 5, 3).fill(i % 2 ? c : hl);
    if (style === "bun") g.circle(0.5, cy - 10.5, 4.6).fill(c);
    g.ellipse(3, cy - 6, 3.2, 1.6).fill({ color: 0xffffff, alpha: 0.12 });
    return;
  }
  switch (style) {
    case "side_part":
      g.ellipse(0.2, cy - 5.2, R + 0.9, 5.6).fill(c);
      g.ellipse(-4, cy - 1, 4.8, 6.2).fill(c);
      g.poly([-2, cy - 8, 10.2, cy - 6.2, 9.8, cy - 3.2, 3, cy - 4.6]).fill(c);
      g.ellipse(2, cy - 8.2, 4, 1.4).fill({ color: hl, alpha: 0.7 });
      break;
    case "curly":
      for (let i = 0; i < 11; i++) {
        const ang = Math.PI + (i / 10) * Math.PI * 1.05;
        g.circle(1 + Math.cos(ang) * (R - 0.5), cy - 1 + Math.sin(ang) * (R - 0.5), 3.1).fill(i % 3 === 0 ? hl : c);
      }
      g.circle(-4.5, cy + 1.5, 3).fill(c);
      break;
    case "ponytail":
      g.ellipse(0.5, cy - 5, R + 0.8, 5.4).fill(c);
      g.ellipse(-4.3, cy - 0.8, 4.2, 5.5).fill(c);
      g.poly([0, cy - 8, 9.6, cy - 5, 8, cy - 3.4, 2, cy - 5]).fill(c);
      g.ellipse(2.5, cy - 8, 3.4, 1.2).fill({ color: hl, alpha: 0.7 });
      break;
    case "bun":
      g.ellipse(0.8, cy - 5.4, R + 0.6, 5).fill(c);
      g.ellipse(-4.2, cy - 1, 4, 5.2).fill(c);
      g.ellipse(2.5, cy - 8, 3.5, 1.2).fill({ color: hl, alpha: 0.6 });
      break;
    case "bob":
      g.ellipse(0.8, cy - 5, R + 1.2, 5.6).fill(c);
      g.roundRect(-8.4, cy - 4, 6.4, 12.5, 3).fill(c);
      g.poly([1, cy - 8, 10.6, cy - 4.6, 10.2, cy - 1.4, 4, cy - 4]).fill(c);
      g.ellipse(2.8, cy - 8.4, 4, 1.3).fill({ color: hl, alpha: 0.7 });
      break;
    case "buzz":
      g.ellipse(0.6, cy - 4.6, R + 0.2, 5).fill({ color: c, alpha: 0.85 });
      g.ellipse(-4, cy - 1.2, 3.8, 4.8).fill({ color: c, alpha: 0.85 });
      break;
    case "wavy":
      g.ellipse(0.6, cy - 5.4, R + 1.4, 6).fill(c);
      g.circle(8.6, cy - 4.2, 2.6).fill(c);
      g.circle(-5.6, cy - 1, 4.4).fill(c);
      g.circle(-5.4, cy + 4, 3.2).fill(c);
      g.ellipse(2.5, cy - 8.6, 3.8, 1.3).fill({ color: hl, alpha: 0.6 });
      break;
    case "long":
      g.ellipse(0.8, cy - 5.2, R + 1.1, 5.8).fill(c);
      g.roundRect(-8.8, cy - 4, 7, 20, 3.5).fill(c);
      g.poly([0.4, cy - 8.4, 10.4, cy - 5.2, 9.6, cy - 2.2, 3, cy - 4.4]).fill(c);
      g.ellipse(2.5, cy - 8.4, 4, 1.3).fill({ color: hl, alpha: 0.65 });
      break;
  }
}

function drawAccessory(g: Graphics, acc: Appearance["accessory"], back: boolean, R: number, cy: number) {
  switch (acc) {
    case "glasses":
      if (back) {
        g.moveTo(-4, cy - 0.8).lineTo(-8, cy - 0.3).stroke({ width: 0.9, color: 0x111827 });
        break;
      }
      g.roundRect(1.4, cy - 2.4, 4, 3.4, 1.2).stroke({ width: 0.9, color: 0x111827 });
      g.roundRect(5.9, cy - 2.4, 3.8, 3.4, 1.2).stroke({ width: 0.9, color: 0x111827 });
      g.moveTo(5.4, cy - 1).lineTo(5.9, cy - 1).stroke({ width: 0.8, color: 0x111827 });
      g.moveTo(1.4, cy - 1.2).lineTo(-3.4, cy - 0.6).stroke({ width: 0.8, color: 0x111827 });
      break;
    case "headphones":
      g.arc(1, cy - 0.5, R + 1.5, Math.PI * 1.05, Math.PI * 1.95).stroke({ width: 2.2, color: 0x111827 });
      g.roundRect(back ? 6.5 : -7, cy - 2, 4.4, 6.2, 2).fill(0x111827);
      g.roundRect(back ? 7.3 : -6.2, cy - 1, 2.6, 4.2, 1.3).fill(0x0ea5e9);
      break;
    case "headset":
      g.arc(1, cy - 0.5, R + 1.1, Math.PI * 1.1, Math.PI * 1.9).stroke({ width: 1.4, color: 0x1f2937 });
      g.roundRect(back ? 6.8 : -6.8, cy - 1.6, 3.8, 5, 1.8).fill(0x1f2937);
      if (!back) g.moveTo(-4.5, cy + 2.8).quadraticCurveTo(-1, cy + 7.5, 4, cy + 5.5).stroke({ width: 1.1, color: 0x1f2937 });
      if (!back) g.circle(4.2, cy + 5.4, 1.1).fill(0xf97316);
      break;
    case "earrings":
      if (!back) g.circle(-4.4, cy + 3.8, 1.1).fill(0xfbbf24);
      break;
    default:
      break;
  }
}
