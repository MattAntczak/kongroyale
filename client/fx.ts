// Short-lived effects: the cardboard boxes in flight, the scraps of cardboard where one lands, and the scanner flash
// at the launcher. Everything is pooled up front so a firefight allocates nothing per shot.
//
// The boxes here are only what the player sees: the host flies the real ones (shared/sim.ts). Both use the same
// speed and gravity, so a box drawn here lands where the host's box lands.

import * as THREE from "three";
import { BOX_GRAVITY, BOX_LIFE_S, GRENADE_FUSE_S, GRENADE_GRAVITY, WEAPONS, type WeaponId } from "../shared/weapons";
import { cardboardTexture } from "./world";

const MAX_BOXES = 320;
const MAX_BITS = 700;

/** First thing a box meets along a step: distance (≤ seg) and whether it was a player. */
export type BoxHitTest = (x: number, y: number, z: number, dx: number, dy: number, dz: number, seg: number, team: number, owner: number) => { t: number; player: boolean };

export class Fx {
  private boxMesh: THREE.InstancedMesh;
  private bx = new Float32Array(MAX_BOXES * 3);
  private bv = new Float32Array(MAX_BOXES * 3);
  private brot = new Float32Array(MAX_BOXES * 3);
  private bspin = new Float32Array(MAX_BOXES * 3);
  private bsize = new Float32Array(MAX_BOXES);
  private bage = new Float32Array(MAX_BOXES).fill(-1);
  private bteam = new Int8Array(MAX_BOXES);
  private bowner = new Int32Array(MAX_BOXES);
  private bnade = new Uint8Array(MAX_BOXES);
  private bnext = 0;
  private bitGeo = new THREE.BufferGeometry();
  private bitPos = new Float32Array(MAX_BITS * 3);
  private bitVel = new Float32Array(MAX_BITS * 3);
  private bitCol = new Float32Array(MAX_BITS * 3);
  private bitLife = new Float32Array(MAX_BITS);
  private bitNext = 0;
  private flash: THREE.PointLight;
  private flashLife = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(scene: THREE.Scene, private hitTest: BoxHitTest) {
    this.boxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: cardboardTexture("#b58e5c", true), roughness: 0.85 }), MAX_BOXES);
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxMesh.frustumCulled = false;
    this.boxMesh.castShadow = true;
    for (let i = 0; i < MAX_BOXES; i++) this.hide(i);
    scene.add(this.boxMesh);
    this.bitGeo.setAttribute("position", new THREE.BufferAttribute(this.bitPos, 3));
    this.bitGeo.setAttribute("color", new THREE.BufferAttribute(this.bitCol, 3));
    const bitMat = new THREE.PointsMaterial({ size: 0.06, vertexColors: true });
    // a scrap right in front of the camera would fill the screen: cap its size in pixels
    bitMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace("#include <fog_vertex>", "#include <fog_vertex>\n  gl_PointSize = min(gl_PointSize, 9.0);"); };
    const pts = new THREE.Points(this.bitGeo, bitMat);
    pts.frustumCulled = false;
    this.bitPos.fill(-100);
    scene.add(pts);
    // the launcher's scan: a short blue-white light, like a barcode scanner's flash
    this.flash = new THREE.PointLight(0x9aa0ff, 0, 8, 2);
    scene.add(this.flash);
  }

  private hide(i: number) {
    this.m.makeScale(0, 0, 0);
    this.boxMesh.setMatrixAt(i, this.m);
  }

  /** Launch one visual box from (x, y, z) along a unit direction. */
  launch(x: number, y: number, z: number, dx: number, dy: number, dz: number, w: WeaponId, team: number, owner: number) {
    const i = this.bnext; this.bnext = (i + 1) % MAX_BOXES;
    const def = WEAPONS[w];
    this.bx[i * 3] = x; this.bx[i * 3 + 1] = y; this.bx[i * 3 + 2] = z;
    this.bv[i * 3] = dx * def.speed; this.bv[i * 3 + 1] = dy * def.speed; this.bv[i * 3 + 2] = dz * def.speed;
    for (let k = 0; k < 3; k++) { this.brot[i * 3 + k] = Math.random() * 6.28; this.bspin[i * 3 + k] = (Math.random() - 0.5) * 18; }
    this.bsize[i] = def.size; this.bage[i] = 0; this.bteam[i] = team; this.bowner[i] = owner; this.bnade[i] = w === "grenade" ? 1 : 0;
  }

  /** A burst of cardboard scraps (and a little packing paper). */
  bits(x: number, y: number, z: number, n: number) {
    for (let k = 0; k < n; k++) {
      const i = this.bitNext; this.bitNext = (i + 1) % MAX_BITS;
      this.bitPos[i * 3] = x; this.bitPos[i * 3 + 1] = y; this.bitPos[i * 3 + 2] = z;
      this.bitVel[i * 3] = (Math.random() - 0.5) * 4; this.bitVel[i * 3 + 1] = Math.random() * 3.2; this.bitVel[i * 3 + 2] = (Math.random() - 0.5) * 4;
      this.bitLife[i] = 0.4 + Math.random() * 0.5;
      const paper = Math.random() < 0.25;
      const c = paper ? [0.93, 0.93, 0.9] : [0.62 + Math.random() * 0.1, 0.45 + Math.random() * 0.08, 0.27];
      this.bitCol.set(c, i * 3);
    }
  }

  muzzle(x: number, y: number, z: number) {
    this.flash.position.set(x, y, z);
    this.flash.intensity = 4;
    this.flashLife = 0.05;
  }

  update(dt: number) {
    for (let i = 0; i < MAX_BOXES; i++) {
      if (this.bage[i] < 0) continue;
      this.bage[i] += dt;
      const o = i * 3;
      this.bv[o + 1] -= (this.bnade[i] ? GRENADE_GRAVITY : BOX_GRAVITY) * dt;
      const sp = Math.hypot(this.bv[o], this.bv[o + 1], this.bv[o + 2]);
      const dx = this.bv[o] / sp, dy = this.bv[o + 1] / sp, dz = this.bv[o + 2] / sp, seg = sp * dt;
      const hit = this.hitTest(this.bx[o], this.bx[o + 1], this.bx[o + 2], dx, dy, dz, seg, this.bteam[i], this.bowner[i]);
      this.bx[o] += dx * hit.t; this.bx[o + 1] += dy * hit.t; this.bx[o + 2] += dz * hit.t;
      if (hit.t < seg || this.bage[i] > (this.bnade[i] ? GRENADE_FUSE_S : BOX_LIFE_S)) {
        if (hit.t < seg) this.bits(this.bx[o], this.bx[o + 1], this.bx[o + 2], hit.player ? 6 : 4);
        this.bage[i] = -1; this.hide(i); continue;
      }
      for (let k = 0; k < 3; k++) this.brot[o + k] += this.bspin[o + k] * dt;
      this.e.set(this.brot[o], this.brot[o + 1], this.brot[o + 2]);
      this.q.setFromEuler(this.e);
      const sz = this.bsize[i];
      this.m.compose(this.p.set(this.bx[o], this.bx[o + 1], this.bx[o + 2]), this.q, this.s.set(sz, sz * 0.8, sz));
      this.boxMesh.setMatrixAt(i, this.m);
    }
    this.boxMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < MAX_BITS; i++) {
      if (this.bitLife[i] <= 0) continue;
      this.bitLife[i] -= dt;
      if (this.bitLife[i] <= 0) { this.bitPos[i * 3 + 1] = -100; continue; }
      this.bitVel[i * 3 + 1] -= 9.8 * dt;
      this.bitPos[i * 3] += this.bitVel[i * 3] * dt;
      this.bitPos[i * 3 + 1] = Math.max(0.02, this.bitPos[i * 3 + 1] + this.bitVel[i * 3 + 1] * dt);
      this.bitPos[i * 3 + 2] += this.bitVel[i * 3 + 2] * dt;
    }
    this.bitGeo.attributes.position.needsUpdate = true;
    this.bitGeo.attributes.color.needsUpdate = true;
    if (this.flashLife > 0) { this.flashLife -= dt; if (this.flashLife <= 0) this.flash.intensity = 0; }
  }
}
