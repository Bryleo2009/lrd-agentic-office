import { AnimatedSprite, Assets, Container, Graphics, Spritesheet, Text, TextStyle, type Texture } from "pixi.js";
import type { AgentDefinition } from "../../shared/types";
import type { Facing } from "../office/iso";
import { AgentAnimator } from "./AgentAnimator";
import { buildRigView, type Appearance, type RigView } from "./CharacterRig";

export type StatusTone = "none" | "work" | "test" | "talk" | "blocked" | "success" | "think";

const TONE_COLOR: Record<StatusTone, number> = {
  none: 0x94a3b8,
  work: 0x0ea5e9,
  test: 0x10b981,
  talk: 0x8b5cf6,
  blocked: 0xef4444,
  success: 0x22c55e,
  think: 0x6366f1,
};

const TAG_STYLE = new TextStyle({ fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: "600", fill: 0x0f172a });
const BUBBLE_STYLE = new TextStyle({ fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: "500", fill: 0x0f172a, wordWrap: true, wordWrapWidth: 190, lineHeight: 14 });

interface BubbleReq {
  text: string;
  tone: StatusTone;
  duration: number;
}

/**
 * Representación visual de un agente: rig (o spritesheet), anillo de estado en el piso,
 * etiqueta con nombre y burbuja de actividad (en la capa overlay para que siempre sea legible).
 */
export class AgentRenderer {
  readonly body = new Container(); // en capa de objetos (ordenado por profundidad)
  readonly overlay = new Container(); // etiqueta + burbuja
  readonly animator = new AgentAnimator();
  private rigRoot = new Container();
  private front: RigView;
  private back: RigView;
  private ring = new Graphics();
  private tag = new Container();
  private tagBg = new Graphics();
  private tagDot = new Graphics();
  private bubble = new Container();
  private bubbleBg = new Graphics();
  private bubbleText: Text;
  private bubbleTime = 0;
  private bubbleDur = 0;
  private bubbleQueue: BubbleReq[] = [];
  private tone: StatusTone = "none";
  private ringPulse = 0;
  private selected = false;
  private hover = false;
  facing: Facing = 0;
  private sprites: Partial<Record<string, AnimatedSprite>> | null = null;
  private currentSprite: AnimatedSprite | null = null;

  constructor(readonly def: AgentDefinition, appearance: Appearance) {
    this.front = buildRigView(appearance, false);
    this.back = buildRigView(appearance, true);
    const sc = appearance.height;
    this.rigRoot.scale.set(sc);
    this.rigRoot.addChild(this.front.root, this.back.root);
    this.back.root.visible = false;
    this.body.addChild(this.ring, this.rigRoot);

    // Etiqueta
    const name = new Text({ text: def.name, style: TAG_STYLE, resolution: 3 });
    name.position.set(16, -7.5);
    const w = name.width + 26;
    this.tagBg.roundRect(0, -10.5, w, 21, 10.5).fill({ color: 0xffffff, alpha: 0.95 }).stroke({ width: 1, color: 0xe2e8f0 });
    this.tagDot.circle(9, 0, 3.6).fill(parseInt(def.color.slice(1), 16));
    this.tag.addChild(this.tagBg, this.tagDot, name);
    this.tag.pivot.set(w / 2, 0);
    this.overlay.addChild(this.tag);

    // Burbuja
    this.bubbleText = new Text({ text: "", style: BUBBLE_STYLE, resolution: 3 });
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.bubble.visible = false;
    this.overlay.addChild(this.bubble);

    this.body.eventMode = "static";
    this.body.cursor = "pointer";
    this.body.hitArea = { contains: (x: number, y: number) => x > -14 && x < 14 && y > -68 && y < 4 };
    this.body.on("pointerover", () => (this.hover = true));
    this.body.on("pointerout", () => (this.hover = false));
    this.tag.eventMode = "static";
    this.tag.cursor = "pointer";

    if (appearance.renderer === "spritesheet") void this.loadSpritesheet();
  }

  onClick(fn: () => void): void {
    this.body.on("pointertap", fn);
    this.tag.on("pointertap", fn);
  }

  /** Arte reemplazable: assets/characters/<id>/spritesheet.json */
  private async loadSpritesheet(): Promise<void> {
    try {
      const sheet = (await Assets.load(`/characters/${this.def.id}/spritesheet.json`)) as Spritesheet;
      const anims = sheet.animations as Record<string, Texture[]>;
      this.sprites = {};
      for (const [k, frames] of Object.entries(anims)) {
        const s = new AnimatedSprite(frames);
        s.anchor.set(0.5, 1);
        s.animationSpeed = 0.15;
        s.visible = false;
        this.sprites[k] = s;
        this.rigRoot.addChild(s);
      }
      this.front.root.visible = false;
      this.back.root.visible = false;
    } catch {
      this.sprites = null; // sin spritesheet: se mantiene el rig
    }
  }

  setSelected(v: boolean): void {
    this.selected = v;
  }

  setTone(t: StatusTone): void {
    this.tone = t;
  }

  getTone(): StatusTone {
    return this.tone;
  }

  say(text: string, tone: StatusTone = "none", duration = 3.6): void {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const short = clean.length > 64 ? clean.slice(0, 62) + "…" : clean;
    const d = Math.max(2, Math.min(6, duration));
    // Si la burbuja actual lleva poco tiempo, se encola; si no, se reemplaza.
    if (this.bubble.visible && this.bubbleTime < 1.3) {
      this.bubbleQueue = [...this.bubbleQueue.slice(-1), { text: short, tone, duration: d }];
      return;
    }
    this.showBubble({ text: short, tone, duration: d });
  }

  private showBubble(b: BubbleReq): void {
    this.bubbleText.text = b.text;
    const w = Math.min(206, this.bubbleText.width + 20);
    const h = this.bubbleText.height + 12;
    const accent = b.tone === "none" ? 0x94a3b8 : TONE_COLOR[b.tone];
    this.bubbleBg.clear();
    this.bubbleBg.roundRect(-w / 2, -h, w, h, 9).fill({ color: 0xffffff, alpha: 0.97 }).stroke({ width: 1, color: 0xe2e8f0 });
    this.bubbleBg.roundRect(-w / 2, -h, 3.5, h, 2).fill(accent);
    this.bubbleBg.poly([-5, -0.5, 5, -0.5, 0, 6]).fill({ color: 0xffffff, alpha: 0.97 });
    this.bubbleText.position.set(-w / 2 + 12, -h + 6);
    this.bubble.visible = true;
    this.bubble.alpha = 0;
    this.bubble.scale.set(0.9);
    this.bubbleTime = 0;
    this.bubbleDur = b.duration;
  }

  setFacing(f: Facing): void {
    this.facing = f;
    const back = f === 2 || f === 3;
    const mirror = f === 1 || f === 2;
    this.rigRoot.scale.x = Math.abs(this.rigRoot.scale.x) * (mirror ? -1 : 1);
    if (!this.sprites) {
      this.front.root.visible = !back;
      this.back.root.visible = back;
    }
  }

  update(dt: number, screenX: number, screenY: number, zoom: number): void {
    this.body.position.set(screenX, screenY);
    if (this.sprites) this.updateSprites();
    else this.animator.update(dt, [this.front, this.back]);

    // Anillo de estado
    this.ringPulse += dt;
    this.ring.clear();
    const col = this.tone === "none" ? (this.selected ? 0x3b82f6 : 0) : TONE_COLOR[this.tone];
    if (this.tone !== "none" || this.selected || this.hover) {
      const pulse = 1 + 0.06 * Math.sin(this.ringPulse * 4);
      const c = col || 0x64748b;
      this.ring.ellipse(0, 0, 17 * pulse, 8.5 * pulse).stroke({ width: 2, color: c, alpha: 0.9 });
      this.ring.ellipse(0, 0, 17 * pulse, 8.5 * pulse).fill({ color: c, alpha: 0.12 });
    }

    // Overlay: etiqueta y burbuja siguen la cabeza (tamaño constante en pantalla)
    const headTop = screenY - 72 * this.rigRoot.scale.y + this.animator.sit * 10;
    const inv = 1 / Math.max(0.55, Math.min(1.6, zoom));
    this.tag.position.set(screenX, headTop - 6 * inv);
    this.tag.scale.set(inv * 0.95);
    this.tagBg.alpha = this.selected ? 1 : 0.96;
    if (this.bubble.visible) {
      this.bubbleTime += dt;
      const fadeIn = Math.min(1, this.bubbleTime / 0.18);
      const fadeOut = Math.min(1, (this.bubbleDur - this.bubbleTime) / 0.3);
      this.bubble.alpha = Math.max(0, Math.min(fadeIn, fadeOut));
      const s = (0.9 + 0.1 * fadeIn) * inv;
      this.bubble.scale.set(s);
      this.bubble.position.set(screenX, headTop - 22 * inv);
      if (this.bubbleTime >= this.bubbleDur) {
        this.bubble.visible = false;
        const next = this.bubbleQueue.shift();
        if (next) this.showBubble(next);
      }
    } else if (this.bubbleQueue.length) {
      this.showBubble(this.bubbleQueue.shift()!);
    }
  }

  private updateSprites(): void {
    if (!this.sprites) return;
    const dirs = ["se", "sw", "nw", "ne"];
    const moving = this.animator.walkWeight > 0.3;
    const base = moving ? "walk" : this.animator.sit > 0.5 && this.animator.action === "idle" ? "sit" : this.animator.action;
    const key = `${base}_${dirs[this.facing]}`;
    const s = this.sprites[key] ?? this.sprites[`idle_${dirs[this.facing]}`];
    if (s && s !== this.currentSprite) {
      if (this.currentSprite) {
        this.currentSprite.stop();
        this.currentSprite.visible = false;
      }
      s.visible = true;
      s.play();
      this.currentSprite = s;
    }
    this.rigRoot.scale.x = Math.abs(this.rigRoot.scale.x);
  }

  isBubbleVisible(): boolean {
    return this.bubble.visible;
  }
}
