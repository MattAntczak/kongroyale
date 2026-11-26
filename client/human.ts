// A warehouse worker: hard hat, hi-vis vest in the group's colour, work trousers, a cardboard launcher. Built from boxes so it needs
// no model files; animated by code (walk swing from speed, aim pitch, a fall when eliminated).

import * as THREE from "three";
import type { WeaponId } from "../shared/weapons";

/** Vest colours: Grupa A wears efectivo blue, Grupa B hi-vis orange. */
export const TEAM_COLORS = [0x474fff, 0xff6a00] as const;
export const TEAM_CSS = ["#474fff", "#ff6a00"] as const;
const SKIN = [0xf1c7a5, 0xd9a47c, 0xa8724f, 0xe8b996, 0x8a5a3c];

const box = (sx: number, sy: number, sz: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
};

const trousers = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.85 });
const boots = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7 });
const shirt = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.8 });
const reflect = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.2, metalness: 0.6, emissive: 0x303030 });

const cardboard = new THREE.MeshStandardMaterial({ color: 0xb58e5c, roughness: 0.9 });
const tape = new THREE.MeshStandardMaterial({ color: 0xd9c9a3, roughness: 0.5 });
const scanGlass = new THREE.MeshBasicMaterial({ color: 0x474fff });

/**
 * A cardboard launcher: a taped box body, a tube to throw the boxes through, a grip and a little scanner window at the
 * back (the beep). `mat` replaces the cardboard, for the first-person view's lighting.
 */
export function gunModel(w: WeaponId, mat: THREE.Material = cardboard): THREE.Group {
  const g = new THREE.Group();
  if (w === "rifle") {
    g.add(box(0.12, 0.13, 0.42, mat, 0, 0, -0.05));          // body box
    g.add(box(0.125, 0.03, 0.43, tape, 0, 0.05, -0.05));      // tape
    g.add(box(0.1, 0.1, 0.32, mat, 0, 0.01, -0.4));           // tube
    g.add(box(0.06, 0.15, 0.08, mat, 0, -0.12, 0.02));        // grip
    g.add(box(0.14, 0.14, 0.12, mat, 0, 0.02, 0.24));         // shoulder box
    g.add(box(0.05, 0.03, 0.005, scanGlass, 0, 0.03, 0.302)); // scanner window
  } else if (w === "pistol") {
    g.add(box(0.08, 0.09, 0.22, mat, 0, 0, -0.05));
    g.add(box(0.085, 0.025, 0.225, tape, 0, 0.03, -0.05));
    g.add(box(0.06, 0.13, 0.07, mat, 0, -0.09, 0.03));
    g.add(box(0.04, 0.02, 0.005, scanGlass, 0, 0.02, 0.062));
  } else {
    g.add(box(0.2, 0.15, 0.5, mat, 0, 0, -0.12));             // a wide box: the pallet launcher
    g.add(box(0.205, 0.035, 0.51, tape, 0, 0.0, -0.12));
    g.add(box(0.16, 0.12, 0.06, tape, 0, 0, -0.39));          // mouth rim
    g.add(box(0.07, 0.15, 0.08, mat, 0, -0.13, 0.05));
    g.add(box(0.06, 0.03, 0.005, scanGlass, 0, 0.04, 0.131));
  }
  return g;
}

export class Human {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private upper = new THREE.Group();
  private legL: THREE.Group; private legR: THREE.Group;
  private armL: THREE.Group; private armR: THREE.Group;
  private gun: THREE.Group | null = null;
  private gunId: WeaponId | null = null;
  private phase = 0;
  private fall = 0;
  private label: THREE.Sprite;
  private lastX = 0; private lastZ = 0; private speed = 0;

  /** `ally` marks a teammate of the viewer: their name tag is drawn in the group colour. */
  constructor(name: string, colorIdx: number, bot: boolean, team: number, readonly ally: boolean) {
    const vest = TEAM_COLORS[team & 1];
    const vestMat = new THREE.MeshStandardMaterial({ color: vest, roughness: 0.6, emissive: vest, emissiveIntensity: 0.15 });
    const skin = new THREE.MeshStandardMaterial({ color: SKIN[(colorIdx * 7 + name.length) % SKIN.length], roughness: 0.7 });
    const hatMat = new THREE.MeshStandardMaterial({ color: bot ? 0xf5f5f7 : 0xffd400, roughness: 0.35 });

    this.root.add(this.hips);
    this.hips.position.y = 0.92;
    const leg = (x: number) => {
      const g = new THREE.Group(); g.position.set(x, 0, 0);
      g.add(box(0.17, 0.82, 0.2, trousers, 0, -0.41, 0));
      g.add(box(0.19, 0.12, 0.3, boots, 0, -0.86, -0.04));
      g.add(box(0.175, 0.05, 0.205, reflect, 0, -0.62, 0));
      this.hips.add(g); return g;
    };
    this.legL = leg(-0.11); this.legR = leg(0.11);
    this.hips.add(this.upper);
    this.upper.add(box(0.44, 0.6, 0.24, shirt, 0, 0.3, 0));
    this.upper.add(box(0.46, 0.5, 0.26, vestMat, 0, 0.33, 0));
    this.upper.add(box(0.465, 0.05, 0.265, reflect, 0, 0.22, 0));
    this.upper.add(box(0.465, 0.05, 0.265, reflect, 0, 0.42, 0));
    // the back of the vest carries the efectivo tag: a little accent LED
    const tag = box(0.08, 0.12, 0.03, new THREE.MeshStandardMaterial({ color: 0x0a0a0a }), 0.14, 0.5, -0.135);
    tag.add(new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), new THREE.MeshBasicMaterial({ color: 0x474fff })));
    this.upper.add(tag);
    const head = new THREE.Group(); head.position.set(0, 0.72, 0);
    head.add(box(0.22, 0.25, 0.22, skin, 0, 0, 0));
    head.add(box(0.2, 0.05, 0.02, new THREE.MeshStandardMaterial({ color: 0x111111 }), 0, 0.03, -0.115)); // eyes / glasses
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
    hat.position.y = 0.1; hat.scale.set(1, 0.85, 1.1); hat.castShadow = true; head.add(hat);
    head.add(box(0.3, 0.02, 0.36, hatMat, 0, 0.1, -0.03));
    this.upper.add(head);
    const arm = (x: number) => {
      const g = new THREE.Group(); g.position.set(x, 0.55, 0);
      g.add(box(0.12, 0.55, 0.13, vestMat, 0, -0.27, 0));
      g.add(box(0.1, 0.1, 0.1, skin, 0, -0.58, 0));
      this.upper.add(g); return g;
    };
    this.armL = arm(-0.29); this.armR = arm(0.29);

    // name tag
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const g = c.getContext("2d")!;
    g.font = "500 30px Inter, -apple-system, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    const tw = Math.min(250, g.measureText(name).width + 40);
    g.fillStyle = ally ? (team ? "#ff6a00" : "#474fff") : "#ffffff"; g.beginPath(); g.roundRect((256 - tw) / 2, 8, tw, 48, 12); g.fill();
    g.fillStyle = ally ? "#ffffff" : "#1e293b"; g.fillText(name, 128, 33);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
    this.label.scale.set(1.0, 0.25, 1); this.label.position.y = 2.15;
    this.root.add(this.label);
  }

  setWeapon(w: WeaponId) {
    if (w === this.gunId) return;
    if (this.gun) this.armR.remove(this.gun);
    this.gun = gunModel(w);
    this.gun.rotation.x = -Math.PI / 2; // barrel along the arm
    this.gun.position.set(0, -0.62, -0.06);
    this.armR.add(this.gun);
    this.gunId = w;
  }

  /** Place and animate. yaw 0 faces −Z. */
  update(x: number, y: number, z: number, yaw: number, pitch: number, alive: boolean, dt: number, showLabel: boolean, sit = false) {
    const moved = Math.hypot(x - this.lastX, z - this.lastZ);
    this.lastX = x; this.lastZ = z;
    const sp = dt > 0 ? Math.min(10, moved / dt) : 0;
    this.speed += (sp - this.speed) * Math.min(1, dt * 10);
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
    this.phase += dt * this.speed * 1.9;
    const swing = Math.sin(this.phase) * Math.min(0.75, this.speed * 0.11);
    this.legL.rotation.x = sit ? 1.45 : swing; this.legR.rotation.x = sit ? 1.45 : -swing;
    // arms hold the gun up toward the aim
    const aim = Math.PI / 2 + pitch;
    this.armR.rotation.set(aim, 0, 0);
    this.armL.rotation.set(aim, 0, 0.45);
    this.armL.position.x = -0.22;
    this.upper.rotation.x = pitch * 0.25;
    this.hips.position.y = 0.92 + Math.abs(Math.cos(this.phase)) * Math.min(0.05, this.speed * 0.008);
    this.fall = alive ? 0 : Math.min(1, this.fall + dt * 2.5);
    this.root.rotation.x = -this.fall * Math.PI / 2 * 0.95;
    this.root.position.y = y + this.fall * 0.15;
    this.label.visible = showLabel && alive;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
      if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose(); }
    });
  }
}
