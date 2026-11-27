// Short-lived effects: the cardboard boxes in flight, the scraps of cardboard where one lands, and the scanner flash
// at the launcher. Everything is pooled up front so a firefight allocates nothing per shot.
//
// The boxes here are only what the player sees: the host flies the real ones (shared/sim.ts). Both use the same
// speed and gravity, so a box drawn here lands where the host's box lands.

import * as THREE from "three";
import { BOX_GRAVITY, BOX_LIFE_S, GRENADE_FUSE_S, GRENADE_GRAVITY, WEAPONS, type WeaponId } from "../shared/weapons";

const MAX_BOXES = 320;
const MAX_BITS = 700;  // crumbs: points, one draw call
const MAX_CHIPS = 300; // larger scraps: tumbling quads, one draw call
const MAX_PUFFS = 24;  // dust rings on the floor, one draw call
const MAX_GLINTS = 12; // scanner blinks at the launchers, one draw call
const FLASH_S = 0.07;
const BIG_BURST = 30;  // bits() with this many or more is a grenade going off

/** First thing a box meets along a step: distance (≤ seg) and whether it was a player. */
export type BoxHitTest = (x: number, y: number, z: number, dx: number, dy: number, dz: number, seg: number, team: number, owner: number) => { t: number; player: boolean };

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** One face of a parcel. The boxes are small and spin fast, so everything on it is bold: tape, a label, dark edges. */
function parcelTexture() {
  return canvasTexture(256, (g) => {
    g.fillStyle = "#c39a63"; g.fillRect(0, 0, 256, 256);
    // corrugation showing through the liner, and some fibre
    for (let x = 0; x < 256; x += 6) { g.fillStyle = "rgba(90,60,25,0.07)"; g.fillRect(x, 0, 2, 256); }
    for (let i = 0; i < 1400; i++) { g.fillStyle = Math.random() < 0.5 ? "rgba(255,240,210,0.08)" : "rgba(60,35,10,0.08)"; g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 3, 1); }
    // the flap seam under the tape, then the tape itself with a glossy streak
    g.fillStyle = "rgba(60,35,10,0.45)"; g.fillRect(0, 126, 256, 3);
    g.fillStyle = "rgba(226,196,140,0.9)"; g.fillRect(0, 104, 256, 48);
    g.fillStyle = "rgba(255,250,235,0.45)"; g.fillRect(0, 110, 256, 6);
    g.fillStyle = "rgba(120,85,40,0.35)"; g.fillRect(0, 103, 256, 2); g.fillRect(0, 151, 256, 2);
    // shipping label with a barcode
    g.fillStyle = "#f7f7f4"; g.fillRect(132, 166, 108, 74);
    g.fillStyle = "#1f6feb"; g.fillRect(132, 166, 108, 12);
    g.fillStyle = "#111"; g.font = "700 15px Menlo, monospace"; g.fillText("efectivo", 140, 196);
    for (let i = 0, x = 140; x < 230; i++) { const w = 2 + ((i * 7) % 5); g.fillRect(x, 204, w, 28); x += w + 2 + (i % 3); }
    // "this side up" arrows
    g.fillStyle = "rgba(40,25,10,0.75)";
    for (const x of [28, 66]) { g.fillRect(x + 7, 40, 8, 40); g.beginPath(); g.moveTo(x - 2, 44); g.lineTo(x + 11, 22); g.lineTo(x + 24, 44); g.fill(); }
    g.fillRect(22, 84, 68, 5);
    // worn, darker edges so the box reads as a box against a bright floor
    const e = g.createLinearGradient(0, 0, 256, 0);
    e.addColorStop(0, "rgba(50,30,10,0.5)"); e.addColorStop(0.07, "rgba(50,30,10,0)"); e.addColorStop(0.93, "rgba(50,30,10,0)"); e.addColorStop(1, "rgba(50,30,10,0.5)");
    g.fillStyle = e; g.fillRect(0, 0, 256, 256);
    g.save(); g.translate(128, 128); g.rotate(Math.PI / 2); g.translate(-128, -128); g.fillRect(0, 0, 256, 256); g.restore();
  });
}

/** A soft ring of dust: white with alpha, the material tints it. */
function puffTexture() {
  return canvasTexture(128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,0.12)"); r.addColorStop(0.55, "rgba(255,255,255,0.35)"); r.addColorStop(0.8, "rgba(255,255,255,0.9)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    // break the ring up so it is not a perfect circle
    g.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 26; i++) { const a = Math.random() * 6.28, d = 34 + Math.random() * 28, s = 5 + Math.random() * 9; const h = g.createRadialGradient(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 0, 64 + Math.cos(a) * d, 64 + Math.sin(a) * d, s); h.addColorStop(0, "rgba(0,0,0,0.6)"); h.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = h; g.fillRect(0, 0, 128, 128); }
  });
}

/** The scanner's blink: a blue-white core with the thin horizontal line a barcode scanner draws. Additive, so black is clear. */
function glintTexture() {
  return canvasTexture(64, (g) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, 64, 64);
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    r.addColorStop(0, "#ffffff"); r.addColorStop(0.18, "#cfe0ff"); r.addColorStop(0.5, "rgba(70,110,255,0.35)"); r.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    const l = g.createLinearGradient(0, 0, 64, 0);
    l.addColorStop(0, "rgba(0,0,0,0)"); l.addColorStop(0.5, "rgba(235,242,255,0.95)"); l.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = l; g.fillRect(0, 31, 64, 2);
  });
}

let labelTex: THREE.CanvasTexture | null = null;
/** A shipping label: white paper, a barcode, a line of digits. One texture for every label in flight. */
function labelTexture(): THREE.CanvasTexture {
  if (labelTex) return labelTex;
  const c = document.createElement("canvas"); c.width = 128; c.height = 80;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fbfbf8"; g.fillRect(0, 0, 128, 80);
  g.fillStyle = "#111";
  let x = 10;
  for (const w of [3, 1, 2, 1, 4, 1, 1, 3, 2, 1, 1, 4, 2, 1, 3, 1, 2, 2, 1, 3, 1, 1, 4, 1, 2]) { if (x + w > 118) break; g.fillRect(x, 10, w, 46); x += w + 2; }
  g.font = "600 13px monospace"; g.textAlign = "center"; g.fillText("5 901234 123457", 64, 72);
  labelTex = new THREE.CanvasTexture(c); labelTex.colorSpace = THREE.SRGBColorSpace;
  return labelTex;
}

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
  /** The Paczkownik throws barcode labels: the same flight, drawn as a flat white sticker. */
  private labelMesh: THREE.InstancedMesh;
  private blabel = new Uint8Array(MAX_BOXES);
  private bnext = 0;
  private boxesLive = false;
  private bitGeo = new THREE.BufferGeometry();
  private bitPos = new Float32Array(MAX_BITS * 3);
  private bitVel = new Float32Array(MAX_BITS * 3);
  private bitCol = new Float32Array(MAX_BITS * 3);
  private bitSize = new Float32Array(MAX_BITS);  // what the shader draws: bitBase, shrinking at the end of the life
  private bitBase = new Float32Array(MAX_BITS);
  private bitLife = new Float32Array(MAX_BITS);
  private bitNext = 0;
  private bitsLive = false;
  private chipMesh: THREE.InstancedMesh;
  private cPos = new Float32Array(MAX_CHIPS * 3);
  private cVel = new Float32Array(MAX_CHIPS * 3);
  private cRot = new Float32Array(MAX_CHIPS * 3);
  private cSpin = new Float32Array(MAX_CHIPS * 3);
  private cSize = new Float32Array(MAX_CHIPS * 2);
  private cLife = new Float32Array(MAX_CHIPS);
  private cNext = 0;
  private chipsLive = false;
  private puffMesh: THREE.InstancedMesh;
  private puffFade = new Float32Array(MAX_PUFFS);
  private uPos = new Float32Array(MAX_PUFFS * 3);
  private uRad = new Float32Array(MAX_PUFFS * 2); // radius at the start and at the end
  private uAge = new Float32Array(MAX_PUFFS).fill(-1);
  private uDur = new Float32Array(MAX_PUFFS);
  private uNext = 0;
  private puffsLive = false;
  private glintGeo = new THREE.BufferGeometry();
  private gPos = new Float32Array(MAX_GLINTS * 3);
  private gCol = new Float32Array(MAX_GLINTS * 3);
  private gLife = new Float32Array(MAX_GLINTS);
  private gNext = 0;
  private glintsLive = false;
  private flash: THREE.PointLight;
  private flashLife = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(scene: THREE.Scene, private hitTest: BoxHitTest) {
    this.boxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: parcelTexture(), roughness: 0.82 }), MAX_BOXES);
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxMesh.frustumCulled = false;
    this.boxMesh.castShadow = true;
    // the colour buffer has to exist before the first render, or the material compiles without it
    for (let i = 0; i < MAX_BOXES; i++) { this.hide(i); this.boxMesh.setColorAt(i, this.c.setRGB(1, 1, 1)); }
    scene.add(this.boxMesh);
    this.labelMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: labelTexture(), roughness: 0.6, emissive: 0xffffff, emissiveMap: labelTexture(), emissiveIntensity: 0.35 }), MAX_BOXES);
    this.labelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.labelMesh.frustumCulled = false;
    for (let i = 0; i < MAX_BOXES; i++) this.hide(i);
    scene.add(this.labelMesh);

    this.bitGeo.setAttribute("position", new THREE.BufferAttribute(this.bitPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.bitGeo.setAttribute("color", new THREE.BufferAttribute(this.bitCol, 3));
    this.bitGeo.setAttribute("aSize", new THREE.BufferAttribute(this.bitSize, 1).setUsage(THREE.DynamicDrawUsage));
    const bitMat = new THREE.PointsMaterial({ size: 0.06, vertexColors: true });
    // each crumb has its own size (and shrinks away at the end instead of popping out); one right in front of the
    // camera would fill the screen, so its size in pixels is capped
    bitMat.onBeforeCompile = (sh) => {
      sh.vertexShader = "attribute float aSize;\n" + sh.vertexShader
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;")
        .replace("#include <fog_vertex>", "#include <fog_vertex>\n  gl_PointSize = min(gl_PointSize, 12.0);");
    };
    const pts = new THREE.Points(this.bitGeo, bitMat);
    pts.frustumCulled = false;
    this.bitPos.fill(-100);
    scene.add(pts);

    // the larger scraps: opaque two-sided quads that tumble, land flat and shrink away. No blending, so no overdraw cost
    this.chipMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), MAX_CHIPS);
    this.chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chipMesh.frustumCulled = false;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_CHIPS; i++) { this.chipMesh.setMatrixAt(i, this.m); this.chipMesh.setColorAt(i, this.c.setRGB(1, 1, 1)); }
    scene.add(this.chipMesh);

    // dust rings: flat on the floor, growing and fading. The fade is per instance, which the stock material cannot do
    const puffGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    puffGeo.setAttribute("aFade", new THREE.InstancedBufferAttribute(this.puffFade, 1).setUsage(THREE.DynamicDrawUsage));
    const puffMat = new THREE.MeshBasicMaterial({ map: puffTexture(), color: 0xb9ab95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    puffMat.onBeforeCompile = (sh) => {
      sh.vertexShader = "attribute float aFade;\nvarying float vFade;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFade = aFade;");
      sh.fragmentShader = "varying float vFade;\n" + sh.fragmentShader.replace("vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vec4( diffuse, opacity * vFade );");
    };
    this.puffMesh = new THREE.InstancedMesh(puffGeo, puffMat, MAX_PUFFS);
    this.puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffMesh.frustumCulled = false;
    for (let i = 0; i < MAX_PUFFS; i++) this.puffMesh.setMatrixAt(i, this.m);
    this.puffMesh.visible = false; // nothing to draw until the first puff
    scene.add(this.puffMesh);

    // the launcher's scan: a short blue-white light, like a barcode scanner's flash, and a small bright blink at the
    // launcher itself (additive points: they fade by going dark)
    this.glintGeo.setAttribute("position", new THREE.BufferAttribute(this.gPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.glintGeo.setAttribute("color", new THREE.BufferAttribute(this.gCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.gPos.fill(-100);
    const glintMat = new THREE.PointsMaterial({ size: 0.55, map: glintTexture(), vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
    // the player's own blink is under a metre from the camera: keep it a blink, not a screen-filling flare
    glintMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace("#include <fog_vertex>", "#include <fog_vertex>\n  gl_PointSize = min(gl_PointSize, 56.0);"); };
    const glints = new THREE.Points(this.glintGeo, glintMat);
    glints.frustumCulled = false;
    scene.add(glints);
    this.flash = new THREE.PointLight(0xb4c8ff, 0, 8, 2);
    scene.add(this.flash);
  }

  private hide(i: number) {
    this.m.makeScale(0, 0, 0);
    this.boxMesh.setMatrixAt(i, this.m);
    this.labelMesh?.setMatrixAt(i, this.m);
  }

  /** Launch one visual box from (x, y, z) along a unit direction; returns its slot (for reaim). */
  launch(x: number, y: number, z: number, dx: number, dy: number, dz: number, w: WeaponId, team: number, owner: number) {
    const i = this.bnext; this.bnext = (i + 1) % MAX_BOXES;
    if (this.bage[i] >= 0) this.hide(i); // recycled while still flying: clear it in both meshes, its kind may change
    const def = WEAPONS[w];
    this.bx[i * 3] = x; this.bx[i * 3 + 1] = y; this.bx[i * 3 + 2] = z;
    this.bv[i * 3] = dx * def.speed; this.bv[i * 3 + 1] = dy * def.speed; this.bv[i * 3 + 2] = dz * def.speed;
    for (let k = 0; k < 3; k++) { this.brot[i * 3 + k] = Math.random() * 6.28; this.bspin[i * 3 + k] = (Math.random() - 0.5) * 18; }
    this.bsize[i] = def.size; this.bage[i] = 0; this.bteam[i] = team; this.bowner[i] = owner; this.bnade[i] = w === "grenade" ? 1 : 0;
    this.blabel[i] = w === "pistol" ? 1 : 0;
    // every parcel a slightly different cardboard; the grenade is a darker, redder one so it can be told apart in the air
    const v = 0.88 + Math.random() * 0.2;
    this.boxMesh.setColorAt(i, w === "grenade" ? this.c.setRGB(1, 0.62, 0.5) : this.c.setRGB(v, v, v * 0.97));
    this.boxMesh.instanceColor!.needsUpdate = true;
    this.boxesLive = true;
    return i;
  }

  /**
   * Put box `i` (launched by `owner`) on another line from (ox, oy, oz) along (dx, dy, dz), where it would be by now:
   * our own predicted throw, moved onto the host's line when its "shot" event arrives. A box the host's line would
   * already have stopped against a wall or a player is cleared.
   */
  reaim(i: number, owner: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
    if (i < 0 || this.bage[i] < 0 || this.bowner[i] !== owner) return;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-6)) return;
    dx /= len; dy /= len; dz /= len;
    // the launch speed: the velocity now with the gravity of its flight so far taken back out
    const t = this.bage[i], g = this.bnade[i] ? GRENADE_GRAVITY : BOX_GRAVITY;
    const sp = Math.hypot(this.bv[i * 3], this.bv[i * 3 + 1] + g * t, this.bv[i * 3 + 2]), run = sp * t;
    if (run > 0.05 && this.hitTest(ox, oy, oz, dx, dy, dz, run, this.bteam[i], owner).t < run - 0.05) { this.bage[i] = -1; this.hide(i); return; }
    this.bx[i * 3] = ox + dx * run; this.bx[i * 3 + 1] = oy + dy * run - 0.5 * g * t * t; this.bx[i * 3 + 2] = oz + dz * run;
    this.bv[i * 3] = dx * sp; this.bv[i * 3 + 1] = dy * sp - g * t; this.bv[i * 3 + 2] = dz * sp;
  }

  /** A burst of cardboard scraps (and a little packing paper). A big count is a grenade: larger scraps, thrown further. */
  bits(x: number, y: number, z: number, n: number) {
    const big = n >= BIG_BURST, sv = big ? 2.2 : 1;
    for (let k = 0; k < n; k++) {
      const i = this.bitNext; this.bitNext = (i + 1) % MAX_BITS;
      const o = i * 3;
      this.bitPos[o] = x; this.bitPos[o + 1] = y; this.bitPos[o + 2] = z;
      this.bitVel[o] = (Math.random() - 0.5) * 4 * sv; this.bitVel[o + 1] = Math.random() * 3.2 * (big ? 1.7 : 1); this.bitVel[o + 2] = (Math.random() - 0.5) * 4 * sv;
      this.bitLife[i] = (big ? 0.6 : 0.4) + Math.random() * (big ? 0.8 : 0.5);
      this.bitBase[i] = this.bitSize[i] = (0.6 + Math.random() * 0.9) * (big ? 1.4 : 1);
      this.kraft(Math.random() < 0.25);
      this.bitCol[o] = this.c.r; this.bitCol[o + 1] = this.c.g; this.bitCol[o + 2] = this.c.b;
    }
    this.bitGeo.attributes.color.needsUpdate = true;
    this.bitsLive = true;
    const chips = big ? Math.min(36, n >> 1) : Math.min(3, n);
    for (let k = 0; k < chips; k++) {
      const i = this.cNext; this.cNext = (i + 1) % MAX_CHIPS;
      const o = i * 3;
      this.cPos[o] = x; this.cPos[o + 1] = Math.max(y, 0.06); this.cPos[o + 2] = z; // above the floor, so it gets to fall and settle
      this.cVel[o] = (Math.random() - 0.5) * 3.4 * sv; this.cVel[o + 1] = 0.6 + Math.random() * 3 * (big ? 1.8 : 1); this.cVel[o + 2] = (Math.random() - 0.5) * 3.4 * sv;
      for (let a = 0; a < 3; a++) { this.cRot[o + a] = Math.random() * 6.28; this.cSpin[o + a] = (Math.random() - 0.5) * 22; }
      const sz = (0.045 + Math.random() * 0.06) * (big ? 1.9 : 1);
      this.cSize[i * 2] = sz; this.cSize[i * 2 + 1] = sz * (0.45 + Math.random() * 0.5);
      this.cLife[i] = (big ? 1.1 : 0.7) + Math.random() * 0.7;
      this.chipMesh.setColorAt(i, this.kraft(Math.random() < 0.2));
    }
    if (chips) { this.chipMesh.instanceColor!.needsUpdate = true; this.chipsLive = true; }
    // dust: a grenade always kicks some up (under it when it goes off in the air), a box only when it lands near the floor
    if (big) this.puff(x, y > 1.2 ? y - 0.1 : 0.04, z, 0.5, 3.6, 0.75);
    else if (y < 0.45) this.puff(x, 0.04, z, 0.12, 0.5, 0.4);
  }

  /** A cardboard brown (or packing-paper white) in this.c. */
  private kraft(paper: boolean) {
    return paper ? this.c.setRGB(0.93, 0.93, 0.9) : this.c.setRGB(0.62 + Math.random() * 0.1, 0.45 + Math.random() * 0.08, 0.27);
  }

  private puff(x: number, y: number, z: number, r0: number, r1: number, dur: number) {
    const i = this.uNext; this.uNext = (i + 1) % MAX_PUFFS;
    this.uPos[i * 3] = x; this.uPos[i * 3 + 1] = y + (i % 6) * 0.002; this.uPos[i * 3 + 2] = z; // stacked rings must not fight for depth
    this.uRad[i * 2] = r0; this.uRad[i * 2 + 1] = r1; this.uAge[i] = 0; this.uDur[i] = dur;
    this.puffsLive = true; this.puffMesh.visible = true;
  }

  muzzle(x: number, y: number, z: number) {
    this.flash.position.set(x, y, z);
    this.flash.intensity = 5;
    this.flashLife = FLASH_S;
    const i = this.gNext; this.gNext = (i + 1) % MAX_GLINTS;
    this.gPos[i * 3] = x; this.gPos[i * 3 + 1] = y; this.gPos[i * 3 + 2] = z;
    this.gLife[i] = FLASH_S;
    this.glintsLive = true;
  }

  update(dt: number) {
    // buffers go to the GPU only while something is alive (and once more after, to draw the last one gone)
    if (this.boxesLive) {
      let live = false;
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
        live = true;
        for (let k = 0; k < 3; k++) this.brot[o + k] += this.bspin[o + k] * dt;
        this.e.set(this.brot[o], this.brot[o + 1], this.brot[o + 2]);
        this.q.setFromEuler(this.e);
        const sz = this.bsize[i];
        if (this.blabel[i]) this.s.set(sz * 2.4, sz * 0.06, sz * 1.5); else this.s.set(sz, sz * 0.8, sz);
        this.m.compose(this.p.set(this.bx[o], this.bx[o + 1], this.bx[o + 2]), this.q, this.s);
        (this.blabel[i] ? this.labelMesh : this.boxMesh).setMatrixAt(i, this.m);
      }
      this.boxMesh.instanceMatrix.needsUpdate = true;
      this.labelMesh.instanceMatrix.needsUpdate = true;
      this.boxesLive = live;
    }
    if (this.bitsLive) {
      let live = false;
      for (let i = 0; i < MAX_BITS; i++) {
        if (this.bitLife[i] <= 0) continue;
        this.bitLife[i] -= dt;
        if (this.bitLife[i] <= 0) { this.bitPos[i * 3 + 1] = -100; continue; }
        live = true;
        this.bitVel[i * 3 + 1] -= 9.8 * dt;
        this.bitPos[i * 3] += this.bitVel[i * 3] * dt;
        this.bitPos[i * 3 + 1] = Math.max(0.02, this.bitPos[i * 3 + 1] + this.bitVel[i * 3 + 1] * dt);
        this.bitPos[i * 3 + 2] += this.bitVel[i * 3 + 2] * dt;
        this.bitSize[i] = this.bitBase[i] * Math.min(1, this.bitLife[i] * 4); // shrink away over the last quarter second
      }
      this.bitGeo.attributes.position.needsUpdate = true;
      this.bitGeo.attributes.aSize.needsUpdate = true;
      this.bitsLive = live;
    }
    if (this.chipsLive) {
      let live = false;
      const drag = Math.max(0, 1 - 1.4 * dt); // flat cardboard does not fly like a stone
      for (let i = 0; i < MAX_CHIPS; i++) {
        if (this.cLife[i] <= 0) continue;
        this.cLife[i] -= dt;
        if (this.cLife[i] <= 0) { this.m.makeScale(0, 0, 0); this.chipMesh.setMatrixAt(i, this.m); continue; }
        live = true;
        const o = i * 3, floor = 0.022 + (i % 8) * 0.002; // scraps lying on each other must not fight for depth
        if (this.cPos[o + 1] > floor) {
          this.cVel[o] *= drag; this.cVel[o + 2] *= drag;
          this.cVel[o + 1] -= 9.8 * dt;
          this.cPos[o] += this.cVel[o] * dt; this.cPos[o + 1] += this.cVel[o + 1] * dt; this.cPos[o + 2] += this.cVel[o + 2] * dt;
          for (let k = 0; k < 3; k++) this.cRot[o + k] += this.cSpin[o + k] * dt;
          if (this.cPos[o + 1] <= floor) { this.cPos[o + 1] = floor; this.cRot[o] = Math.PI / 2; this.cRot[o + 1] = 0; } // landed: lie flat
        }
        const k = Math.min(1, this.cLife[i] * 4);
        this.q.setFromEuler(this.e.set(this.cRot[o], this.cRot[o + 1], this.cRot[o + 2]));
        this.m.compose(this.p.set(this.cPos[o], this.cPos[o + 1], this.cPos[o + 2]), this.q, this.s.set(this.cSize[i * 2] * k, this.cSize[i * 2 + 1] * k, 1));
        this.chipMesh.setMatrixAt(i, this.m);
      }
      this.chipMesh.instanceMatrix.needsUpdate = true;
      this.chipsLive = live;
    }
    if (this.puffsLive) {
      let live = false;
      this.q.identity();
      for (let i = 0; i < MAX_PUFFS; i++) {
        if (this.uAge[i] < 0) continue;
        this.uAge[i] += dt;
        const k = this.uAge[i] / this.uDur[i];
        if (k >= 1) { this.uAge[i] = -1; this.puffFade[i] = 0; this.m.makeScale(0, 0, 0); this.puffMesh.setMatrixAt(i, this.m); continue; }
        live = true;
        const r = this.uRad[i * 2] + (this.uRad[i * 2 + 1] - this.uRad[i * 2]) * (1 - (1 - k) * (1 - k)); // fast at first, then settling
        this.puffFade[i] = 0.5 * (1 - k) * (1 - k);
        this.m.compose(this.p.set(this.uPos[i * 3], this.uPos[i * 3 + 1], this.uPos[i * 3 + 2]), this.q, this.s.set(r, 1, r));
        this.puffMesh.setMatrixAt(i, this.m);
      }
      this.puffMesh.instanceMatrix.needsUpdate = true;
      this.puffMesh.geometry.attributes.aFade.needsUpdate = true;
      this.puffsLive = this.puffMesh.visible = live;
    }
    if (this.glintsLive) {
      let live = false;
      for (let i = 0; i < MAX_GLINTS; i++) {
        if (this.gLife[i] <= 0) continue;
        this.gLife[i] -= dt;
        const k = Math.max(0, this.gLife[i] / FLASH_S);
        if (k > 0) live = true; else this.gPos[i * 3 + 1] = -100;
        this.gCol[i * 3] = this.gCol[i * 3 + 1] = this.gCol[i * 3 + 2] = k;
      }
      this.glintGeo.attributes.position.needsUpdate = true;
      this.glintGeo.attributes.color.needsUpdate = true;
      this.glintsLive = live;
    }
    if (this.flashLife > 0) { this.flashLife -= dt; this.flash.intensity = Math.max(0, 5 * this.flashLife / FLASH_S); }
  }
}
