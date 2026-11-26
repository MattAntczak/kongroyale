// A warehouse worker: hard hat or cap, hi-vis jacket in the group's colour with reflective bands, work trousers with
// knee pads, boots, gloves, a cardboard launcher. Built from primitives so it needs no model files; animated by code
// (walk swing from speed, aim pitch, a fall when eliminated).
//
// Cheap by construction: every body part is ONE merged geometry, built once per variant at module level and shared by
// all Human instances, and everything is drawn with ONE material whose colours come from a small atlas (uv = a cell of
// the atlas). A player is 5 draw calls plus 2 for the launcher, whatever the amount of detail.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WeaponId } from "../shared/weapons";

/** Vest colours: the warehouse workers wear hi-vis orange, the efectivo technicians efectivo blue. */
export const TEAM_COLORS = [0xff6a00, 0x474fff] as const;
export const TEAM_CSS = ["#ff6a00", "#474fff"] as const;
const SKIN_TONES = [0xf1c7a5, 0xd9a47c, 0xa8724f, 0xe8b996, 0x8a5a3c];

type G = THREE.BufferGeometry;

// ---------------------------------------------------------------- the atlas: one cell per surface
// 8 x 4 cells of 64 px. Three canvases with the same layout: colour, emissive (the colour dimmed by `e`) and
// roughness/metalness, so the reflective bands, the glossy hard hat and the glowing scanner windows all live in one
// material.
const CELL = 64, COLS = 8, ROWS = 4, PAD = 3;
const TROUSERS = 0, BOOT = 1, SOLE = 2, SHIRT = 3, VEST = 4 /* +team */, REFLECT = 6, HAT = 7 /* +team */, SKIN = 9 /* +tone, 5 */,
  GLOVE = 14, DARK = 15, GLOW = 16, TAPE = 17, FLUTE = 18, BARCODE = 19, WOOD = 20, FUSE = 21, SPARK = 22, HAIR = 23, BELT = 24,
  TAG = 30 /* two cells wide */;
/** [colour, emissive share, roughness, metalness] */
const CELLS: Record<number, [number, number, number, number]> = {
  [TROUSERS]: [0x2f3848, 0, 0.85, 0], [BOOT]: [0x1b1b1e, 0, 0.55, 0], [SOLE]: [0x54483a, 0, 0.9, 0], [SHIRT]: [0x3a3d44, 0, 0.8, 0],
  [VEST]: [TEAM_COLORS[0], 0.2, 0.6, 0], [VEST + 1]: [TEAM_COLORS[1], 0.28, 0.6, 0],
  [REFLECT]: [0xe4e8ee, 0.14, 0.22, 0.65],
  [HAT]: [0xffd400, 0.05, 0.3, 0], [HAT + 1]: [0xf5f5f7, 0, 0.3, 0],
  [SKIN]: [SKIN_TONES[0], 0, 0.7, 0], [SKIN + 1]: [SKIN_TONES[1], 0, 0.7, 0], [SKIN + 2]: [SKIN_TONES[2], 0, 0.7, 0],
  [SKIN + 3]: [SKIN_TONES[3], 0, 0.7, 0], [SKIN + 4]: [SKIN_TONES[4], 0, 0.7, 0],
  [GLOVE]: [0x3c3f47, 0, 0.8, 0], [DARK]: [0x101013, 0, 0.28, 0.4], [GLOW]: [0x6a72ff, 1, 0.3, 0],
  [TAPE]: [0xd9c9a3, 0, 0.4, 0], [FLUTE]: [0xb58e5c, 0, 0.9, 0], [BARCODE]: [0xf2f0ea, 0.06, 0.6, 0], [WOOD]: [0xcdb084, 0, 0.8, 0],
  [FUSE]: [0x8d8474, 0, 0.9, 0], [SPARK]: [0xffb020, 1, 0.5, 0], [HAIR]: [0x2a1d14, 0, 0.9, 0], [BELT]: [0x5a4630, 0, 0.6, 0],
  [TAG]: [0x0a0a0c, 0.3, 0.4, 0.2], [TAG + 1]: [0x0a0a0c, 0.3, 0.4, 0.2],
};
const css = (c: number) => "#" + c.toString(16).padStart(6, "0");

let palMat: THREE.MeshStandardMaterial | null = null;
/** The one material of every character and of the launchers' tape, plastic and labels. Built on first use (needs a DOM). */
function pal(): THREE.MeshStandardMaterial {
  if (palMat) return palMat;
  const mk = () => { const c = document.createElement("canvas"); c.width = COLS * CELL; c.height = ROWS * CELL; return c; };
  const col = mk(), emi = mk(), orm = mk();
  const g = col.getContext("2d")!, ge = emi.getContext("2d")!, go = orm.getContext("2d")!;
  g.fillStyle = "#808080"; g.fillRect(0, 0, col.width, col.height);
  ge.fillStyle = "#000"; ge.fillRect(0, 0, emi.width, emi.height);
  go.fillStyle = "rgb(0,200,0)"; go.fillRect(0, 0, orm.width, orm.height);
  const at = (i: number): [number, number] => [(i % COLS) * CELL, Math.floor(i / COLS) * CELL];
  for (const k in CELLS) {
    const [x, y] = at(+k), [c, , r, m] = CELLS[k];
    g.fillStyle = css(c); g.fillRect(x, y, CELL, CELL);
    go.fillStyle = `rgb(0,${Math.round(r * 255)},${Math.round(m * 255)})`; go.fillRect(x, y, CELL, CELL);
  }
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  { // packing tape: glossy streaks along the roll
    const [x, y] = at(TAPE);
    g.fillStyle = "rgba(255,255,255,0.2)"; for (let k = 0; k < 6; k++) g.fillRect(x, y + 5 + k * 10, CELL, 2);
    g.fillStyle = "rgba(90,70,30,0.18)"; g.fillRect(x, y, CELL, 3); g.fillRect(x, y + CELL - 3, CELL, 3);
  }
  { // the cut edge of corrugated board: a wave between two liners
    const [x, y] = at(FLUTE);
    g.fillStyle = "#45331e"; g.fillRect(x, y + 10, CELL, CELL - 20);
    g.strokeStyle = "#cfa873"; g.lineWidth = 2.5; g.beginPath();
    for (let px = 0; px <= CELL; px++) g.lineTo(x + px, y + 32 + Math.sin(px / CELL * Math.PI * 2 * 10) * 18);
    g.stroke();
    g.fillStyle = "#b58e5c"; g.fillRect(x, y, CELL, 11); g.fillRect(x, y + CELL - 11, CELL, 11);
  }
  { // a shipping label
    const [x, y] = at(BARCODE);
    g.fillStyle = "#111";
    for (let px = 7; px < CELL - 8;) { const w = 1 + Math.floor(rnd() * 3); g.fillRect(x + px, y + 8, w, 34); px += w + 1 + Math.floor(rnd() * 3); }
    for (let k = 0; k < 9; k++) g.fillRect(x + 8 + k * 5.4, y + 47, 3, 6);
  }
  { // pallet wood: grain
    const [x, y] = at(WOOD);
    g.strokeStyle = "rgba(110,80,40,0.35)"; g.lineWidth = 1;
    for (let k = 0; k < 9; k++) { const yy = y + 4 + k * 7 + rnd() * 3; g.beginPath(); g.moveTo(x, yy); g.bezierCurveTo(x + 20, yy + rnd() * 4 - 2, x + 44, yy + rnd() * 4 - 2, x + CELL, yy); g.stroke(); }
  }
  { // the efectivo tag: the wordmark on black with the accent dot
    const [x, y] = at(TAG);
    g.fillStyle = "#f5f5f7"; g.font = "700 27px Inter, -apple-system, 'Segoe UI', sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText("efectivo", x + 8, y + 33, 94);
    g.fillStyle = css(TEAM_COLORS[1]); g.beginPath(); g.arc(x + 114, y + 40, 6, 0, Math.PI * 2); g.fill();
  }
  for (const k in CELLS) {
    const e = CELLS[k][1]; if (!e) continue;
    const [x, y] = at(+k);
    ge.globalAlpha = e; ge.drawImage(col, x, y, CELL, CELL, x, y, CELL, CELL);
  }
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    // no mip chain: the cells are flat colours, and lower mips would bleed one cell into the next
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    return t;
  };
  const o = tex(orm, false);
  palMat = new THREE.MeshStandardMaterial({ map: tex(col, true), emissive: 0xffffff, emissiveMap: tex(emi, true), roughness: 1, metalness: 1, roughnessMap: o, metalnessMap: o });
  return palMat;
}

/** Point a primitive's uvs into one atlas cell (its own 0..1 uvs are kept inside the cell, so patterned cells work). */
function paint(geo: G, cell: number, span = 1): G {
  const uv = geo.attributes.uv, W = COLS * CELL, H = ROWS * CELL;
  const u0 = ((cell % COLS) * CELL + PAD) / W, uw = (span * CELL - PAD * 2) / W;
  const v0 = 1 - ((Math.floor(cell / COLS) + 1) * CELL - PAD) / H, vh = (CELL - PAD * 2) / H;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + Math.min(1, Math.max(0, uv.getX(i))) * uw, v0 + Math.min(1, Math.max(0, uv.getY(i))) * vh);
  return geo;
}
const part = (geo: G, cell: number, x = 0, y = 0, z = 0) => paint(geo, cell).translate(x, y, z);
const merged = (parts: G[]) => { const m = mergeGeometries(parts)!; for (const p of parts) p.dispose(); return m; };
const mesh = (geo: G, mat: THREE.Material) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; return m; };

// ---------------------------------------------------------------- cardboard
let kraftTex: THREE.CanvasTexture | null = null;
/** Corrugated board seen from the face: the flutes show through the liner as faint parallel lines. Near white, so it
 *  only modulates whatever colour the material has (the first-person material is a little lighter than the world one). */
function kraftTexture() {
  if (kraftTex) return kraftTex;
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f3ede4"; g.fillRect(0, 0, 128, 128);
  for (let x = 0; x < 128; x += 8) {
    g.fillStyle = "rgba(70,45,15,0.13)"; g.fillRect(x, 0, 2, 128);
    g.fillStyle = "rgba(255,255,255,0.5)"; g.fillRect(x + 4, 0, 2, 128);
  }
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 260; k++) { g.fillStyle = `rgba(${rnd() < 0.5 ? "60,40,15" : "255,250,240"},${0.05 + rnd() * 0.1})`; g.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 5, 1); }
  kraftTex = new THREE.CanvasTexture(c);
  kraftTex.colorSpace = THREE.SRGBColorSpace; kraftTex.wrapS = kraftTex.wrapT = THREE.RepeatWrapping; kraftTex.anisotropy = 4;
  return kraftTex;
}
let cardboardMat: THREE.MeshStandardMaterial | null = null;
const skinned = new WeakMap<THREE.Material, THREE.Material>();
/** The cardboard material: ours, or the caller's own with the corrugated texture added (one copy per caller material). */
function cardboardFor(mat?: THREE.Material): THREE.Material {
  if (!mat) return cardboardMat ??= new THREE.MeshStandardMaterial({ color: 0xb58e5c, roughness: 0.9, map: kraftTexture() });
  let m = skinned.get(mat);
  if (!m) {
    m = mat.clone();
    if (m instanceof THREE.MeshStandardMaterial && !m.map) m.map = kraftTexture();
    skinned.set(mat, m);
  }
  return m;
}

const KRAFT_PER_M = 5;
/** Place a cardboard piece and give it uvs from its position (a baked triplanar map), so the flutes have the same
 *  pitch on every piece whatever its size, and run along the launcher on its top and sides. */
function kraft(geo: G, x = 0, y = 0, z = 0, rx = 0): G {
  if (rx) geo.rotateX(rx);
  geo.translate(x, y, z);
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ax >= ay && ax >= az) uv.setXY(i, p.getY(i) * KRAFT_PER_M, p.getZ(i) * KRAFT_PER_M);
    else if (ay >= az) uv.setXY(i, p.getX(i) * KRAFT_PER_M, p.getZ(i) * KRAFT_PER_M);
    else uv.setXY(i, p.getX(i) * KRAFT_PER_M, p.getY(i) * KRAFT_PER_M);
  }
  return geo;
}

// ---------------------------------------------------------------- the launchers
const gunGeos = new Map<WeaponId, [G, G]>();
/** [cardboard, details] of one launcher. Barrel along -z, the grip under the origin: the sizes and the muzzle positions
 *  are the ones the first-person view (client/game.ts) places its hand and its flash by. */
function gunGeo(w: WeaponId): [G, G] {
  let r = gunGeos.get(w);
  if (r) return r;
  const k: G[] = [], d: G[] = [];
  const kb = (sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0) => { k.push(kraft(new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx)); };
  const db = (c: number, sx: number, sy: number, sz: number, x: number, y: number, z: number) => { d.push(part(new THREE.BoxGeometry(sx, sy, sz), c, x, y, z)); };
  const tube = (c: number, rad: number, len: number, x: number, y: number, z: number, seg = 10) => { d.push(part(new THREE.CylinderGeometry(rad, rad, len, seg, 1, true).rotateX(Math.PI / 2), c, x, y, z)); };
  /** a scanner head (the beep): a dark plastic housing with a glowing window looking down the barrel */
  const scanner = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    db(DARK, sx, sy, sz, x, y, z);
    db(GLOW, sx * 0.66, sy * 0.5, 0.004, x, y, z - sz / 2 - 0.001);
    db(TAPE, sx + 0.005, sy + 0.005, sz * 0.25, x, y, z + sz * 0.2);
  };
  /** the read-out on the back, the part the shooter looks at */
  const readout = (sx: number, sy: number, x: number, y: number, z: number) => {
    db(DARK, sx + 0.025, sy + 0.025, 0.004, x, y, z + 0.002);
    db(GLOW, sx, sy, 0.004, x, y, z + 0.004);
  };
  if (w === "rifle") {
    kb(0.12, 0.13, 0.42, 0, 0, -0.05);                                              // body box
    k.push(kraft(new THREE.CylinderGeometry(0.05, 0.05, 0.32, 10), 0, 0.01, -0.4, Math.PI / 2)); // a postal tube
    kb(0.06, 0.15, 0.08, 0, -0.12, 0.02, 0.2);                                      // grip
    kb(0.14, 0.14, 0.12, 0, 0.02, 0.24);                                            // shoulder box
    kb(0.07, 0.12, 0.1, 0, -0.11, -0.14);                                           // the box of boxes
    db(TAPE, 0.126, 0.136, 0.05, 0, 0, -0.19); db(TAPE, 0.126, 0.136, 0.05, 0, 0, 0.09);
    db(TAPE, 0.04, 0.004, 0.42, 0, 0.0665, -0.05);
    for (const s of [-1, 1]) d.push(part(new THREE.BoxGeometry(0.42, 0.004, 0.01).rotateY(Math.PI / 2), FLUTE, s * 0.055, 0.066, -0.05));
    tube(TAPE, 0.052, 0.04, 0, 0.01, -0.3); tube(TAPE, 0.053, 0.025, 0, 0.01, -0.548);
    d.push(part(new THREE.CircleGeometry(0.045, 10).rotateY(Math.PI), DARK, 0, 0.01, -0.5605));
    scanner(0.06, 0.045, 0.1, 0, 0.082, -0.49);
    readout(0.05, 0.03, 0, 0.03, 0.3);
    db(FLUTE, 0.14, 0.012, 0.004, 0, 0.084, 0.302); db(FLUTE, 0.14, 0.012, 0.004, 0, -0.044, 0.302);
    db(BARCODE, 0.08, 0.003, 0.08, 0, 0.0915, 0.24);
  } else if (w === "pistol") {
    // a label gun: a small box with a roll of barcode labels on top and a slot for a mouth
    kb(0.08, 0.09, 0.22, 0, 0, -0.05);
    kb(0.06, 0.13, 0.07, 0, -0.09, 0.03, 0.18);
    d.push(part(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 12).rotateZ(Math.PI / 2), BARCODE, 0, 0.075, 0.0)); // the roll
    d.push(part(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6).rotateZ(Math.PI / 2), DARK, 0, 0.075, 0.0));
    db(BARCODE, 0.05, 0.003, 0.13, 0, 0.0465, -0.09);                                // the strip of labels fed to the mouth
    db(TAPE, 0.085, 0.095, 0.04, 0, 0, -0.11);
    db(DARK, 0.06, 0.012, 0.003, 0, 0.02, -0.1612);                                  // the mouth: a slot
    scanner(0.055, 0.035, 0.07, 0, -0.062, -0.12);
    db(FLUTE, 0.08, 0.01, 0.003, 0, 0.04, 0.0612); db(FLUTE, 0.08, 0.01, 0.003, 0, -0.04, 0.0612);
    db(BARCODE, 0.003, 0.05, 0.07, -0.0412, 0, -0.03);
  } else if (w === "sniper") {
    // the long one: a carpet tube on a narrow box, a shoulder box, and a scope made of a kitchen-roll tube
    kb(0.1, 0.11, 0.5, 0, 0, -0.05);
    k.push(kraft(new THREE.CylinderGeometry(0.036, 0.036, 0.62, 10), 0, 0.01, -0.53, Math.PI / 2));
    kb(0.06, 0.15, 0.08, 0, -0.12, 0.06, 0.2);                                      // grip
    kb(0.12, 0.15, 0.16, 0, -0.005, 0.3);                                           // shoulder box
    kb(0.05, 0.05, 0.16, 0, -0.07, -0.34);                                          // fore-end
    k.push(kraft(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 10), 0, 0.115, -0.04, Math.PI / 2)); // the scope
    for (const z of [-0.14, 0.06]) { db(TAPE, 0.035, 0.04, 0.025, 0, 0.075, z); tube(TAPE, 0.032, 0.025, 0, 0.115, z, 10); }
    d.push(part(new THREE.CircleGeometry(0.026, 10), GLOW, 0, 0.115, 0.1105));       // the eyepiece glows toward the shooter
    d.push(part(new THREE.CircleGeometry(0.026, 10).rotateY(Math.PI), DARK, 0, 0.115, -0.1905));
    db(TAPE, 0.105, 0.115, 0.05, 0, 0, -0.24); db(TAPE, 0.105, 0.115, 0.05, 0, 0, 0.12);
    tube(TAPE, 0.038, 0.04, 0, 0.01, -0.45); tube(TAPE, 0.039, 0.03, 0, 0.01, -0.825);
    d.push(part(new THREE.CircleGeometry(0.032, 10).rotateY(Math.PI), DARK, 0, 0.01, -0.8405));
    scanner(0.05, 0.04, 0.08, 0, -0.045, -0.78);
    db(FLUTE, 0.12, 0.012, 0.004, 0, 0.066, 0.382); db(FLUTE, 0.12, 0.012, 0.004, 0, -0.076, 0.382);
    db(BARCODE, 0.003, 0.06, 0.1, -0.0512, 0, 0.0);
  } else if (w === "grenade") {
    kb(0.2, 0.16, 0.2, 0, -0.02, -0.12);                                            // a taped parcel, held ready to throw
    db(TAPE, 0.05, 0.165, 0.205, 0, -0.02, -0.12); db(TAPE, 0.205, 0.163, 0.05, 0, -0.02, -0.12);
    db(BARCODE, 0.06, 0.003, 0.05, 0.062, 0.0615, -0.062);
    db(FLUTE, 0.2, 0.01, 0.003, 0, 0.052, -0.0185);
    db(TAPE, 0.03, 0.004, 0.03, -0.055, 0.062, -0.165);
    d.push(part(new THREE.CylinderGeometry(0.006, 0.006, 0.08, 5).rotateX(0.5), FUSE, -0.055, 0.097, -0.155));
    d.push(part(new THREE.SphereGeometry(0.013, 5, 3), SPARK, -0.055, 0.132, -0.136));
  } else {
    kb(0.2, 0.15, 0.5, 0, 0, -0.12);                                                // a wide box: the pallet launcher
    kb(0.07, 0.15, 0.08, 0, -0.13, 0.05, 0.18);
    kb(0.12, 0.05, 0.14, 0, -0.098, -0.24);                                         // fore-end
    db(TAPE, 0.205, 0.035, 0.51, 0, 0, -0.12);
    db(TAPE, 0.16, 0.12, 0.06, 0, 0, -0.39);                                        // mouth rim
    db(DARK, 0.13, 0.09, 0.004, 0, 0, -0.4205);
    for (const z of [-0.22, -0.11, 0]) db(WOOD, 0.21, 0.012, 0.05, 0, 0.081, z);     // pallet slats
    scanner(0.08, 0.045, 0.08, 0, 0.0975, -0.33);
    readout(0.06, 0.03, 0, 0.04, 0.13);
    db(FLUTE, 0.2, 0.007, 0.004, 0, 0.0715, 0.132); db(FLUTE, 0.2, 0.012, 0.004, 0, -0.069, 0.132);
    db(BARCODE, 0.09, 0.003, 0.07, 0, 0.0765, 0.08);
  }
  r = [merged(k), merged(d)];
  gunGeos.set(w, r);
  return r;
}

/**
 * A cardboard launcher, hand-made from boxes and tape: a taped body, a tube or a mouth to throw the boxes through, a
 * grip, a barcode-scanner head at the muzzle and a glowing read-out at the back (the beep). `mat` replaces the
 * cardboard, for the first-person view's lighting. Two meshes over shared geometry: do not dispose their geometry.
 */
export function gunModel(w: WeaponId, mat?: THREE.Material): THREE.Group {
  const g = new THREE.Group(), [k, d] = gunGeo(w);
  g.add(mesh(k, cardboardFor(mat)), mesh(d, pal()));
  return g;
}

// ---------------------------------------------------------------- the body, one geometry per part and variant
const TORSO_Z = 0.58;                                    // torso depth / width
const vestR = (y: number) => 0.215 + (y - 0.11) * 0.07;  // the jacket tapers: wider at the shoulders
/** A strip lying on the jacket: a slice of a slightly larger cone, so it follows the taper and cannot z-fight.
 *  `th` is its heading (0 = the back, PI = the chest), `half` its half width in radians. */
function onVest(y0: number, y1: number, cell: number, th = 0, half = Math.PI, segs = 12, lift = 0.005, span = 1): G {
  const geo = new THREE.CylinderGeometry(vestR(y1) + lift, vestR(y0) + lift, y1 - y0, segs, 1, true, th - half, half * 2);
  return paint(geo, cell, span).scale(1, 1, TORSO_Z).translate(0, (y0 + y1) / 2, 0);
}

const HEAD_Y = 0.77;
const upperGeos = new Map<number, G>(), armGeos: G[] = [];
let legGeoC: G | null = null, caseGeoC: G | null = null;

/** Hips, jacket, head and headgear. Origin at the hips, facing -z. */
function upperGeo(team: number, tone: number): G {
  const key = team * 8 + tone;
  let r = upperGeos.get(key);
  if (r) return r;
  const V = VEST + team, S = SKIN + tone, H = HAT + team, hy = HEAD_Y, PI = Math.PI;
  const p: G[] = [];
  p.push(part(new THREE.CylinderGeometry(0.2, 0.19, 0.16, 10).scale(1, 1, 0.62), TROUSERS, 0, 0.04, 0));
  p.push(part(new THREE.CylinderGeometry(0.222, 0.222, 0.035, 12, 1, true).scale(1, 1, 0.6), BELT, 0, 0.095, 0));
  p.push(part(new THREE.BoxGeometry(0.05, 0.1, 0.09), BELT, 0.2, 0.03, 0));                       // tool pouch
  p.push(part(new THREE.CylinderGeometry(vestR(0.61), vestR(0.11), 0.5, 12).scale(1, 1, TORSO_Z), V, 0, 0.36, 0));
  p.push(part(new THREE.SphereGeometry(vestR(0.61), 12, 3, 0, PI * 2, 0, PI / 2).scale(1, 0.15, TORSO_Z), V, 0, 0.61, 0)); // shoulders
  p.push(onVest(0.215, 0.26, REFLECT), onVest(0.375, 0.42, REFLECT));                             // the two reflective bands
  for (const th of [PI - 0.5, PI + 0.5, -0.5, 0.5]) p.push(onVest(0.42, 0.61, REFLECT, th, 0.09, 1)); // and the braces
  p.push(onVest(0.12, 0.6, DARK, PI, 0.03, 1, 0.003));                                            // zip
  if (team === 1) {
    p.push(onVest(0.455, 0.54, TAG, 0, 0.36, 4, 0.006, 2));                                       // efectivo across the back
    p.push(onVest(0.295, 0.335, TAG, PI + 0.42, 0.17, 2, 0.006, 2));                              // and a small tag on the chest
  } else p.push(onVest(0.455, 0.53, BARCODE, 0, 0.2, 2, 0.006));                                  // the warehouse's own ID label
  p.push(part(new THREE.CylinderGeometry(0.07, 0.1, 0.04, 8), SHIRT, 0, 0.64, 0));                // collar
  p.push(part(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 8), S, 0, 0.66, 0));                  // neck
  p.push(part(new THREE.SphereGeometry(0.118, 10, 8).scale(0.92, 1.08, 1), S, 0, hy, 0));
  p.push(part(new THREE.BoxGeometry(0.026, 0.04, 0.03), S, 0, hy - 0.02, -0.115));                // nose
  p.push(part(new THREE.SphereGeometry(0.123, 8, 3, 0, PI, PI * 0.35, PI * 0.4).scale(0.92, 1.08, 1), HAIR, 0, hy, 0));
  if (team === 1) {
    // technicians: wrap-around safety glasses and a white cap with a blue button
    p.push(part(new THREE.CylinderGeometry(0.124, 0.124, 0.05, 8, 1, true, PI / 2 + 0.2, PI - 0.4).scale(0.93, 1, 1), DARK, 0, hy + 0.015, 0));
    p.push(part(new THREE.SphereGeometry(0.126, 12, 4, 0, PI * 2, 0, PI / 2).scale(1, 0.85, 1.04), H, 0, hy + 0.045, 0));
    p.push(part(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 10).scale(1, 1, 0.95), H, 0, hy + 0.05, -0.11));
    p.push(part(new THREE.SphereGeometry(0.014, 6, 4), V, 0, hy + 0.152, 0));
  } else {
    // workers: eyes and a yellow hard hat with a brim, a peak and a ridge
    for (const s of [-1, 1]) p.push(part(new THREE.BoxGeometry(0.026, 0.026, 0.02), DARK, s * 0.04, hy + 0.015, -0.104));
    p.push(part(new THREE.SphereGeometry(0.133, 12, 4, 0, PI * 2, 0, PI / 2).scale(1, 0.92, 1.12), H, 0, hy + 0.04, 0));
    p.push(part(new THREE.CylinderGeometry(0.15, 0.156, 0.014, 12).scale(1, 1, 1.12), H, 0, hy + 0.045, -0.012));
    p.push(part(new THREE.BoxGeometry(0.18, 0.014, 0.07), H, 0, hy + 0.045, -0.185));
    p.push(part(new THREE.SphereGeometry(0.133, 6, 4, 0, PI * 2, 0, PI / 2).scale(0.16, 0.98, 1), H, 0, hy + 0.04, 0));
  }
  r = merged(p);
  upperGeos.set(key, r);
  return r;
}

/** One leg, hanging from the hip joint at the origin: trousers, knee pad, reflective band, boot. */
function legGeo(): G {
  if (legGeoC) return legGeoC;
  const p: G[] = [];
  p.push(part(new THREE.CylinderGeometry(0.1, 0.078, 0.8, 8), TROUSERS, 0, -0.39, 0));
  p.push(part(new THREE.CylinderGeometry(0.089, 0.086, 0.045, 8, 1, true), REFLECT, 0, -0.62, 0));
  p.push(part(new THREE.BoxGeometry(0.1, 0.11, 0.03), DARK, 0, -0.42, -0.085));
  p.push(part(new THREE.CylinderGeometry(0.088, 0.092, 0.14, 8), BOOT, 0, -0.79, 0));
  p.push(part(new THREE.CapsuleGeometry(0.07, 0.15, 3, 8).rotateX(Math.PI / 2).scale(1, 0.9, 1), BOOT, 0, -0.85, -0.05));
  p.push(part(new THREE.BoxGeometry(0.15, 0.03, 0.29), SOLE, 0, -0.905, -0.05));
  return legGeoC = merged(p);
}

/** One arm, hanging from the shoulder joint at the origin: jacket sleeve, reflective band, work glove. */
function armGeo(team: number): G {
  if (armGeos[team]) return armGeos[team];
  const V = VEST + team, p: G[] = [];
  p.push(part(new THREE.SphereGeometry(0.075, 8, 5), V));
  p.push(part(new THREE.CapsuleGeometry(0.06, 0.38, 3, 8), V, 0, -0.245, 0));
  p.push(part(new THREE.CylinderGeometry(0.064, 0.064, 0.04, 8, 1, true), REFLECT, 0, -0.36, 0));
  p.push(part(new THREE.CylinderGeometry(0.058, 0.063, 0.035, 8), GLOVE, 0, -0.5, 0));
  p.push(part(new THREE.CapsuleGeometry(0.05, 0.05, 3, 8), GLOVE, 0, -0.565, 0));
  return armGeos[team] = merged(p);
}

/** The case of watch tags carried on the back. */
function caseGeo(): G {
  if (caseGeoC) return caseGeoC;
  const p: G[] = [];
  p.push(part(new THREE.BoxGeometry(0.34, 0.26, 0.16), DARK, 0, 0.34, 0.2));
  p.push(part(new THREE.BoxGeometry(0.1, 0.02, 0.03), DARK, 0, 0.48, 0.2));
  p.push(part(new THREE.BoxGeometry(0.2, 0.03, 0.01), GLOW, 0, 0.36, 0.285));
  p.push(part(new THREE.BoxGeometry(0.345, 0.02, 0.165), REFLECT, 0, 0.25, 0.2));
  return caseGeoC = merged(p);
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
  private idle: number;
  private fall = 0;
  private caseMesh: THREE.Mesh | null = null;
  private label: THREE.Sprite;
  private lastX = 0; private lastZ = 0; private speed = 0;

  /** `ally` marks a teammate of the viewer: their name tag is drawn in the group colour. */
  constructor(name: string, colorIdx: number, bot: boolean, team: number, readonly ally: boolean) {
    const tm = team & 1, mat = pal();
    void bot;
    this.idle = name.length * 1.7 + colorIdx; // so a row of idle players does not breathe in step

    this.root.add(this.hips);
    this.hips.position.y = 0.92;
    const limb = (parent: THREE.Group, geo: G, x: number, y: number) => {
      const g = new THREE.Group(); g.position.set(x, y, 0);
      g.add(mesh(geo, mat));
      parent.add(g); return g;
    };
    this.legL = limb(this.hips, legGeo(), -0.11, 0); this.legR = limb(this.hips, legGeo(), 0.11, 0);
    this.hips.add(this.upper);
    this.upper.add(mesh(upperGeo(tm, (colorIdx * 7 + name.length) % SKIN_TONES.length), mat));
    this.armL = limb(this.upper, armGeo(tm), -0.29, 0.55); this.armR = limb(this.upper, armGeo(tm), 0.29, 0.55);

    // name tag
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const g = c.getContext("2d")!;
    g.font = "500 30px Inter, -apple-system, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    const tw = Math.min(250, g.measureText(name).width + 40);
    g.fillStyle = ally ? TEAM_CSS[tm] : "#ffffff"; g.beginPath(); g.roundRect((256 - tw) / 2, 8, tw, 48, 12); g.fill();
    g.fillStyle = ally ? "#ffffff" : "#1e293b"; g.fillText(name, 128, 33);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
    this.label.scale.set(1.0, 0.25, 1); this.label.position.y = 2.15;
    this.root.add(this.label);
  }

  /** A case of watch tags on the back, while this player carries one. */
  setCarry(on: boolean) {
    if (on && !this.caseMesh) { this.caseMesh = mesh(caseGeo(), pal()); this.upper.add(this.caseMesh); }
    if (this.caseMesh) this.caseMesh.visible = on;
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
    this.idle += dt;
    const swing = Math.sin(this.phase) * Math.min(0.75, this.speed * 0.11);
    this.legL.rotation.x = sit ? 1.45 : swing; this.legR.rotation.x = sit ? 1.45 : -swing;
    // arms hold the gun up toward the aim; it bobs a little with each step
    const aim = Math.PI / 2 + pitch + (sit ? 0 : Math.sin(this.phase * 2) * Math.min(0.035, this.speed * 0.006));
    this.armR.rotation.set(aim, 0, 0);
    this.armL.rotation.set(aim, 0, 0.45);
    this.armL.position.x = -0.22;
    // the trunk leans into a run, turns a little against the stride and breathes when standing
    const run = sit ? 0 : Math.min(1, this.speed / 6);
    this.upper.rotation.set(pitch * 0.25 - run * 0.07, sit ? 0 : -swing * 0.06, 0);
    this.upper.position.y = Math.sin(this.idle * 1.8) * 0.004 * (1 - run);
    // (not on a forklift: a seated driver moves fast, and would bounce on the seat)
    this.hips.position.y = 0.92 + (sit ? 0 : Math.abs(Math.cos(this.phase)) * Math.min(0.05, this.speed * 0.008));
    this.fall = alive ? 0 : Math.min(1, this.fall + dt * 2.5);
    this.root.rotation.x = -this.fall * Math.PI / 2 * 0.95;
    this.root.position.y = y + this.fall * 0.15;
    this.label.visible = showLabel && alive;
  }

  /** Only the name tag is this player's own: the body and launcher geometry, the atlas and the materials are shared. */
  dispose() {
    this.label.material.map?.dispose(); this.label.material.dispose();
  }
}
