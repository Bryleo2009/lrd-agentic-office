import { damp } from "../office/iso";
import type { RigView } from "./CharacterRig";

export type Action = "idle" | "type" | "read" | "think" | "talk" | "test" | "celebrate" | "blocked" | "coffee";

interface Pose {
  thighN: number;
  thighF: number;
  shinN: number;
  shinF: number;
  upperN: number;
  foreN: number;
  upperF: number;
  foreF: number;
  bodyY: number;
  headRot: number;
  headY: number;
  lean: number;
}

const ZERO: Pose = { thighN: 0, thighF: 0, shinN: 0, shinF: 0, upperN: 0, foreN: 0, upperF: 0, foreF: 0, bodyY: 0, headRot: 0, headY: 0, lean: 0 };

/**
 * Mezcla poses paramétricas: caminar (por distancia), sentarse/levantarse (blend), y acciones de brazos/cabeza.
 * No usa React ni CSS: sólo transforma los contenedores del rig cada frame.
 */
export class AgentAnimator {
  action: Action = "idle";
  /** 0 = de pie, 1 = sentado (se anima con blend). */
  sit = 0;
  sitTarget = 0;
  seatHeight = 12;
  /** 0..1 peso de la caminata (según velocidad). */
  walkWeight = 0;
  walkPhase = 0;
  private t = Math.random() * 100;
  private pose: Pose = { ...ZERO };
  private actionTime = 0;
  private glance = 0;
  private glanceTarget = 0;
  private glanceTimer = 2 + Math.random() * 4;
  bounce = 0;

  setAction(a: Action): void {
    if (a !== this.action) {
      this.action = a;
      this.actionTime = 0;
    }
  }

  update(dt: number, views: RigView[]): void {
    this.t += dt;
    this.actionTime += dt;
    this.sit = damp(this.sit, this.sitTarget, 7, dt);
    if (Math.abs(this.sit - this.sitTarget) < 0.002) this.sit = this.sitTarget;

    this.glanceTimer -= dt;
    if (this.glanceTimer <= 0) {
      this.glanceTimer = 2.5 + Math.random() * 5;
      this.glanceTarget = Math.random() < 0.55 ? 0 : (Math.random() - 0.5) * 0.22;
    }
    this.glance = damp(this.glance, this.glanceTarget, 4, dt);

    const target = this.targetPose();
    const k = 12;
    const p = this.pose;
    for (const key of Object.keys(p) as (keyof Pose)[]) p[key] = damp(p[key], target[key], k, dt);

    // Caminata dirigida por distancia (sin patinaje)
    const w = this.walkWeight;
    const s = Math.sin(this.walkPhase);
    const c = Math.cos(this.walkPhase);
    const walk: Pose = {
      thighN: -0.55 * s,
      thighF: 0.55 * s,
      shinN: 0.75 * Math.max(0, c) + 0.1,
      shinF: 0.75 * Math.max(0, -c) + 0.1,
      upperN: 0.42 * s,
      foreN: -0.35,
      upperF: -0.42 * s,
      foreF: -0.35,
      bodyY: -1.7 * Math.abs(c) + 0.6,
      headRot: 0,
      headY: 0,
      lean: 0.05,
    };
    const mix = (a: number, b: number) => a * (1 - w) + b * w;

    const sit = this.sit;
    const breathe = Math.sin(this.t * 2.1) * 0.012;
    for (const v of views) {
      if (!v.root.visible) continue;
      v.legNear.upper.rotation = mix(p.thighN, walk.thighN) * (1 - sit) + -1.45 * sit;
      v.legFar.upper.rotation = mix(p.thighF, walk.thighF) * (1 - sit) + -1.4 * sit;
      v.legNear.lower.rotation = mix(p.shinN, walk.shinN) * (1 - sit) + 1.5 * sit;
      v.legFar.lower.rotation = mix(p.shinF, walk.shinF) * (1 - sit) + 1.45 * sit;
      v.armNear.upper.rotation = mix(p.upperN, walk.upperN);
      v.armNear.lower.rotation = mix(p.foreN, walk.foreN);
      v.armFar.upper.rotation = mix(p.upperF, walk.upperF);
      v.armFar.lower.rotation = mix(p.foreF, walk.foreF);
      const sitDrop = sit * (25 - this.seatHeight - 3);
      const bodyY = mix(p.bodyY, walk.bodyY) + sitDrop - this.bounce;
      v.torso.y = bodyY;
      v.torso.scale.y = 1 + breathe;
      v.torso.rotation = mix(p.lean, walk.lean) * 0.4;
      v.head.y = -47 + bodyY + p.headY + breathe * -20;
      v.head.rotation = p.headRot + this.glance * (1 - w);
      v.armNear.upper.y = -43.5 + bodyY;
      v.armFar.upper.y = -43.5 + bodyY;
      // Las piernas cuelgan desde la cadera, que baja al sentarse
      v.legNear.upper.y = -25 + sitDrop - this.bounce;
      v.legFar.upper.y = -25 + sitDrop - this.bounce;
      v.heldTablet.visible = this.action === "read";
      v.heldCup.visible = this.action === "coffee";
      v.heldClipboard.visible = this.action === "test" && this.sit < 0.5 && this.walkWeight < 0.3 && this.standingTest;
    }
  }

  /** true → test con portapapeles; false → test tecleando en terminal */
  standingTest = false;

  private targetPose(): Pose {
    const t = this.t;
    const at = this.actionTime;
    const p: Pose = { ...ZERO, upperN: 0.05 * Math.sin(t * 1.3), upperF: -0.04 * Math.sin(t * 1.1), foreN: -0.12, foreF: -0.1 };
    this.bounce = 0;
    switch (this.action) {
      case "idle":
        if (this.sit > 0.5) {
          p.upperN = -0.35;
          p.foreN = -0.75;
          p.upperF = -0.3;
          p.foreF = -0.7;
        }
        break;
      case "type": {
        p.upperN = -0.5 + 0.05 * Math.sin(t * 17);
        p.foreN = -1.12 + 0.12 * Math.sin(t * 19);
        p.upperF = -0.45 + 0.05 * Math.cos(t * 16);
        p.foreF = -1.08 + 0.12 * Math.cos(t * 21);
        p.headRot = 0.05 + 0.02 * Math.sin(t * 0.7);
        p.lean = 0.06;
        break;
      }
      case "read":
        p.upperN = -0.62;
        p.foreN = -1.55 + 0.03 * Math.sin(t * 1.5);
        p.upperF = -0.5;
        p.foreF = -1.4;
        p.headRot = 0.14;
        p.headY = 0.4;
        break;
      case "think":
        p.upperN = -0.25;
        p.foreN = -2.55 + 0.05 * Math.sin(t * 1.2);
        p.upperF = 0.1;
        p.foreF = -1.3;
        p.headRot = -0.1 + 0.04 * Math.sin(t * 0.9);
        break;
      case "talk":
        p.upperN = -0.45 + 0.3 * Math.sin(t * 3.1);
        p.foreN = -1.0 + 0.35 * Math.sin(t * 4.3 + 1);
        p.upperF = -0.12 + 0.12 * Math.sin(t * 2.3 + 2);
        p.foreF = -0.5;
        p.headRot = 0.05 * Math.sin(t * 5.5);
        p.headY = 0.5 * Math.sin(t * 6);
        break;
      case "test":
        if (this.standingTest) {
          p.upperN = -0.62;
          p.foreN = -1.5;
          p.upperF = -0.3 + 0.25 * Math.max(0, Math.sin(t * 2.4));
          p.foreF = -1.9;
          p.headRot = 0.12 + 0.05 * Math.sin(t * 2.4);
        } else {
          p.upperN = -0.55 + 0.05 * Math.sin(t * 15);
          p.foreN = -1.15 + 0.1 * Math.sin(t * 18);
          p.upperF = -0.5;
          p.foreF = -1.1 + 0.1 * Math.cos(t * 17);
          p.headRot = 0.03 * Math.sin(t * 3);
        }
        break;
      case "celebrate": {
        const phase = Math.min(1, at / 0.3);
        p.upperN = -2.75 * phase + 0.15 * Math.sin(t * 9);
        p.foreN = -0.35;
        p.upperF = -2.6 * phase + 0.15 * Math.cos(t * 9);
        p.foreF = -0.3;
        p.headRot = -0.12;
        if (this.sit < 0.3 && at < 1.6) this.bounce = Math.abs(Math.sin(at * 7.5)) * 5 * (1 - at / 1.6);
        break;
      }
      case "blocked":
        p.upperN = -2.4;
        p.foreN = -2.3;
        p.upperF = -2.3;
        p.foreF = -2.2;
        p.headRot = 0.08 * Math.sin(t * 8) * Math.max(0, 1 - at / 2.5) + 0.1;
        p.headY = 0.8;
        break;
      case "coffee": {
        const sip = Math.max(0, Math.sin(t * 0.8)) > 0.85 ? 1 : 0;
        p.upperN = -0.25 - sip * 0.5;
        p.foreN = -1.7 - sip * 0.6;
        p.headRot = -0.05 * sip;
        break;
      }
    }
    return p;
  }
}
