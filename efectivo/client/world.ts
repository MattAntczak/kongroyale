// Draws the efectivo warehouse from shared/map.ts: floor with zone markings, walls and dock doors, high-bay racks
// filled with pallets, pallet stacks, packing tables, drums, the office, forklifts, the UWB anchor network and the
// pickups. Every texture is drawn on a canvas at start-up, so the hall needs no downloaded assets.

import * as THREE from "three";
import { ANCHORS, BOXES, DOCKS, HALL, PICKUPS, ZONES, type Box, type PickupKind } from "../shared/map";

const ACCENT = 0x474fff;

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, amount: number, n: number) {
  for (let i = 0; i < n; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * amount})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

// ------------------------------------------------------------------ floor

function floorTexture() {
  const PX = 24; // pixels per metre
  const W = (HALL.x1 - HALL.x0) * PX, H = (HALL.z1 - HALL.z0) * PX;
  const X = (x: number) => (x - HALL.x0) * PX, Z = (z: number) => (z - HALL.z0) * PX;
  return canvasTex(W, H, (g) => {
    g.fillStyle = "#3b3c40"; g.fillRect(0, 0, W, H);
    // trowel marks and stains
    for (let i = 0; i < 260; i++) {
      const r = 20 + Math.random() * 140;
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      const a = Math.random() * 0.06;
      gr.addColorStop(0, Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a * 0.6})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.save(); g.translate(Math.random() * W, Math.random() * H); g.fillStyle = gr; g.fillRect(-r, -r, r * 2, r * 2); g.restore();
    }
    noise(g, W, H, 0.08, 60000);
    // expansion joints every 5 m
    g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 1.5;
    for (let x = HALL.x0; x <= HALL.x1; x += 5) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), H); g.stroke(); }
    for (let z = HALL.z0; z <= HALL.z1; z += 5) { g.beginPath(); g.moveTo(0, Z(z)); g.lineTo(W, Z(z)); g.stroke(); }
    // zones: a light tint, a solid edge line, the name painted on the floor
    for (const zn of ZONES) {
      g.fillStyle = zn.color + "1c";
      g.fillRect(X(zn.x0), Z(zn.z0), (zn.x1 - zn.x0) * PX, (zn.z1 - zn.z0) * PX);
      g.strokeStyle = zn.color + "cc"; g.lineWidth = 0.12 * PX;
      g.strokeRect(X(zn.x0) + 4, Z(zn.z0) + 4, (zn.x1 - zn.x0) * PX - 8, (zn.z1 - zn.z0) * PX - 8);
    }
    // hatching in the hazardous area
    const hz = ZONES.find((z) => z.name.startsWith("STREFA"))!;
    g.save(); g.beginPath(); g.rect(X(hz.x0), Z(hz.z0), (hz.x1 - hz.x0) * PX, 0.8 * PX); g.clip();
    g.fillStyle = "#e5b50a"; g.fillRect(X(hz.x0), Z(hz.z0), (hz.x1 - hz.x0) * PX, 0.8 * PX);
    g.fillStyle = "#111"; for (let x = X(hz.x0) - 40; x < X(hz.x1) + 40; x += 28) { g.beginPath(); g.moveTo(x, Z(hz.z0)); g.lineTo(x + 14, Z(hz.z0)); g.lineTo(x + 14 + 19, Z(hz.z0) + 0.8 * PX); g.lineTo(x + 19, Z(hz.z0) + 0.8 * PX); g.fill(); }
    g.restore();
    // yellow aisle lines in front of every rack and around stacks
    g.strokeStyle = "rgba(240,196,0,0.85)"; g.lineWidth = 0.1 * PX;
    for (const b of BOXES) {
      if (b.kind !== "rack" && b.kind !== "stack" && b.kind !== "table") continue;
      const m = b.kind === "rack" ? 0.35 : 0.25;
      g.strokeRect(X(b.x0 - m), Z(b.z0 - m), (b.x1 - b.x0 + 2 * m) * PX, (b.z1 - b.z0 + 2 * m) * PX);
    }
    // walkway arrows along the main aisle
    g.fillStyle = "rgba(245,245,247,0.55)";
    for (let x = -36; x < 36; x += 8) {
      g.save(); g.translate(X(x), Z(0)); g.beginPath(); g.moveTo(-18, -10); g.lineTo(6, -10); g.lineTo(6, -20); g.lineTo(26, 0); g.lineTo(6, 20); g.lineTo(6, 10); g.lineTo(-18, 10); g.closePath(); g.fill(); g.restore();
    }
    g.strokeStyle = "rgba(245,245,247,0.5)"; g.setLineDash([0.9 * PX, 0.6 * PX]); g.lineWidth = 0.1 * PX;
    for (const z of [-4.2, 4.2]) { g.beginPath(); g.moveTo(X(-40), Z(z)); g.lineTo(X(40), Z(z)); g.stroke(); }
    g.setLineDash([]);
    // zone names
    g.textAlign = "left"; g.textBaseline = "top";
    for (const zn of ZONES) {
      g.font = `600 ${Math.round(0.9 * PX)}px Inter, -apple-system, sans-serif`;
      g.fillStyle = "rgba(245,245,247,0.32)";
      const tx = X(zn.x0) + 0.8 * PX, tz = Z(zn.z0) + (zn.name.startsWith("STREFA") ? 1.3 : 0.6) * PX;
      g.fillText(zn.name, tx, tz);
    }
    // pickup pads
    for (const p of PICKUPS) {
      g.strokeStyle = "rgba(71,79,255,0.75)"; g.lineWidth = 0.08 * PX;
      g.beginPath(); g.arc(X(p.x), Z(p.z), 0.9 * PX, 0, Math.PI * 2); g.stroke();
    }
  });
}

// ------------------------------------------------------------------ materials

function wallTexture() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = "#7e8187"; g.fillRect(0, 0, 256, 512);
    for (let x = 0; x < 256; x += 16) {
      const gr = g.createLinearGradient(x, 0, x + 16, 0);
      gr.addColorStop(0, "rgba(0,0,0,0.25)"); gr.addColorStop(0.5, "rgba(255,255,255,0.12)"); gr.addColorStop(1, "rgba(0,0,0,0.25)");
      g.fillStyle = gr; g.fillRect(x, 0, 16, 512);
    }
    noise(g, 256, 512, 0.06, 3000);
  }, [1, 1]);
}

function cardboardTexture(tint: string, label: boolean) {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = tint; g.fillRect(0, 0, 256, 256);
    noise(g, 256, 256, 0.07, 2500);
    g.fillStyle = "rgba(220,200,160,0.55)"; g.fillRect(118, 0, 20, 256); // tape
    g.strokeStyle = "rgba(0,0,0,0.25)"; g.lineWidth = 3; g.strokeRect(2, 2, 252, 252);
    if (label) {
      g.fillStyle = "#f5f5f7"; g.fillRect(150, 170, 92, 64);
      g.fillStyle = "#111"; g.font = "600 15px Menlo, monospace"; g.fillText("efectivo", 158, 192);
      for (let i = 0; i < 9; i++) g.fillRect(158 + i * 8, 202, i % 3 ? 3 : 5, 22);
    }
  });
}

function stripeTexture() {
  return canvasTex(128, 128, (g) => {
    g.fillStyle = "#e5b50a"; g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#111";
    for (let i = -128; i < 256; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 16, 0); g.lineTo(i + 16 + 128, 128); g.lineTo(i + 128, 128); g.fill(); }
  }, [1, 1]);
}

function meshTexture() {
  return canvasTex(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = "#9aa0a8"; g.lineWidth = 2;
    for (let i = 0; i <= 128; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
  }, [1, 1]);
}

function labelTexture(text: string, bg: string, fg: string, w = 512, h = 128, font = 64) {
  return canvasTex(w, h, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg; g.font = `600 ${font}px Inter, -apple-system, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, w / 2, h / 2 + 2);
  });
}

// ------------------------------------------------------------------ builders

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpC = new THREE.Color();

class Instancer {
  private items: { p: [number, number, number]; s: [number, number, number]; c: number; ry: number }[] = [];
  constructor(private geo: THREE.BufferGeometry, private mat: THREE.Material, private shadows = true) {}
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, color = 0xffffff, ry = 0) { this.items.push({ p: [x, y, z], s: [sx, sy, sz], c: color, ry }); }
  build(scene: THREE.Object3D) {
    if (!this.items.length) return;
    const m = new THREE.InstancedMesh(this.geo, this.mat, this.items.length);
    this.items.forEach((it, i) => {
      tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.ry);
      tmpM.compose(tmpP.set(...it.p), tmpQ, tmpS.set(...it.s));
      m.setMatrixAt(i, tmpM);
      m.setColorAt(i, tmpC.setHex(it.c));
    });
    m.castShadow = this.shadows; m.receiveShadow = true;
    scene.add(m);
  }
}

const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const LOAD_TINTS = [0xb9bcc4, 0xb5a98f, 0xa89a80, 0x9aa3c2, 0x8f939b];

export interface WorldHandle {
  update(t: number): void;
  setPickups(active: boolean[]): void;
  /** Lower-cased material name for footstep/impact feel: not used for gameplay. */
  group: THREE.Group;
}

export function buildWorld(scene: THREE.Scene): WorldHandle {
  const group = new THREE.Group();
  scene.add(group);

  // floor and ceiling
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALL.x1 - HALL.x0, HALL.z1 - HALL.z0), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.55, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((HALL.x0 + HALL.x1) / 2, 0, (HALL.z0 + HALL.z1) / 2);
  floor.receiveShadow = true;
  group.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(HALL.x1 - HALL.x0 + 2, HALL.z1 - HALL.z0 + 2), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(0, HALL.h + 0.6, 0);
  group.add(ceil);

  // walls: corrugated cladding with a dark plinth and a yellow line
  const wallTex = wallTexture();
  for (const b of BOXES) {
    if (b.kind !== "wall") continue;
    const sx = b.x1 - b.x0, sz = b.z1 - b.z0, len = Math.max(sx, sz);
    const t = wallTex.clone(); t.needsUpdate = true; t.repeat.set(len / 3, 1);
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, b.y1 - b.y0, sz), new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, metalness: 0.35 }));
    m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
    m.receiveShadow = true;
    group.add(m);
  }
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0x222326, roughness: 0.8 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe5b50a, roughness: 0.6 });
  const plinth = (x: number, z: number, sx: number, sz: number) => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.2, sz), plinthMat); a.position.set(x, 0.6, z); group.add(a);
    const l = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.01, 0.12, sz + 0.01), lineMat); l.position.set(x, 1.26, z); group.add(l);
  };
  plinth(0, HALL.z0 + 0.03, 80, 0.06); plinth(0, HALL.z1 - 0.03, 80, 0.06);
  plinth(HALL.x0 + 0.03, 0, 0.06, 50); plinth(HALL.x1 - 0.03, 0, 0.06, 50);

  // dock doors on the east wall
  const doorTex = canvasTex(256, 256, (g) => {
    g.fillStyle = "#c9ccd2"; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 12) { g.fillStyle = "rgba(0,0,0,0.22)"; g.fillRect(0, y, 256, 2); g.fillStyle = "rgba(255,255,255,0.25)"; g.fillRect(0, y + 3, 256, 1); }
  });
  DOCKS.forEach((z, i) => {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4.3, 3.8), new THREE.MeshStandardMaterial({ color: 0x1b1c20 }));
    frame.position.set(HALL.x1 - 0.06, 2.15, z); group.add(frame);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.8), new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.5, metalness: 0.4 }));
    door.rotation.y = -Math.PI / 2; door.position.set(HALL.x1 - 0.17, 1.95, z); group.add(door);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), new THREE.MeshBasicMaterial({ map: labelTexture(`D${i + 1}`, "#000000", "#f5f5f7", 256, 96, 60) }));
    sign.rotation.y = -Math.PI / 2; sign.position.set(HALL.x1 - 0.17, 4.6, z); group.add(sign);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: i % 2 ? 0x12b76a : 0xef4444 }));
    lamp.position.set(HALL.x1 - 0.15, 4.6, z + 0.9); group.add(lamp);
    const bumper = (dz: number) => { const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 0.25), plinthMat); b.position.set(HALL.x1 - 0.12, 0.4, z + dz); group.add(b); };
    bumper(-1.5); bumper(1.5);
  });

  // ceiling: trusses and lamp strips
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x2a2c31, metalness: 0.6, roughness: 0.5 });
  for (let x = HALL.x0 + 5; x < HALL.x1; x += 6.5) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.7, HALL.z1 - HALL.z0), trussMat); t.position.set(x, HALL.h + 0.2, 0); group.add(t);
  }
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xf4f6ff });
  const lampHousing = new THREE.MeshStandardMaterial({ color: 0x1a1b1f });
  for (let x = -34; x <= 34; x += 8.5) {
    for (const z of [-16, -6, 6, 16]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 0.42), lampHousing); h.position.set(x, HALL.h - 0.1, z); group.add(h);
      const l = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.03, 0.3), lampMat); l.position.set(x, HALL.h - 0.175, z); group.add(l);
    }
  }

  // racks: uprights, beams, a mesh back, pallets and loads on every level
  const rackUp = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 }));
  const beams = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 }));
  const palletMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const pallets = new Instancer(unitBox, palletMat);
  const cardboard = [cardboardTexture("#b58e5c", true), cardboardTexture("#a37b4b", false), cardboardTexture("#c49d6a", true)];
  const loads = cardboard.map((map) => new Instancer(unitBox, new THREE.MeshStandardMaterial({ map, roughness: 0.85 })));
  const wrapped = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.85 }));
  const meshBack = new THREE.MeshStandardMaterial({ map: meshTexture(), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 });
  const LEVELS = [0, 1.85, 3.7, 5.55];
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
  const loadOn = (x: number, y: number, z: number, maxH: number, ry = 0) => {
    pallets.add(x, y, z, 1.2, 0.14, 1.0, 0xb08a5c, ry);
    const r = Math.random();
    if (r < 0.1) return;
    const h = Math.min(maxH, 0.7 + Math.random() * 0.75);
    if (r < 0.35) wrapped.add(x, y + 0.14, z, 1.14, h, 0.96, pick(LOAD_TINTS), ry);
    else pick(loads).add(x, y + 0.14, z, 1.1, h, 0.94, 0xffffff, ry);
  };
  for (const b of BOXES) {
    if (b.kind !== "rack") continue;
    const len = b.x1 - b.x0, bays = Math.max(1, Math.round(len / 2.7)), bay = len / bays;
    for (let i = 0; i <= bays; i++) {
      const x = b.x0 + i * bay;
      for (const z of [b.z0 + 0.05, b.z1 - 0.05, (b.z0 + b.z1) / 2 - 0.12, (b.z0 + b.z1) / 2 + 0.12]) rackUp.add(x, 0, z, 0.1, b.y1, 0.1, 0x2b4fd6);
    }
    for (const y of LEVELS.slice(1).concat([7.1])) {
      for (const z of [b.z0 + 0.05, b.z1 - 0.05]) beams.add((b.x0 + b.x1) / 2, y - 0.14, z, len, 0.14, 0.07, 0xff6b1a);
    }
    const back = new THREE.Mesh(new THREE.PlaneGeometry(len, b.y1), meshBack);
    (back.material as THREE.MeshStandardMaterial).map!.repeat.set(len / 1.2, b.y1 / 1.2);
    back.position.set((b.x0 + b.x1) / 2, b.y1 / 2, (b.z0 + b.z1) / 2); group.add(back);
    for (let i = 0; i < bays; i++) {
      for (const y of LEVELS) {
        for (const side of [-1, 1]) {
          for (const k of [-0.5, 0.5]) {
            if (bay < 2.4 && k > 0) continue;
            loadOn(b.x0 + (i + 0.5 + k * 0.5) * bay, y + (y ? 0 : 0.02), (b.z0 + b.z1) / 2 + side * 0.6, 1.5);
          }
        }
      }
    }
  }

  // pallet stacks: layers of pallet + load, the top layer sometimes shorter
  for (const b of BOXES) {
    if (b.kind !== "stack") continue;
    const layers = Math.round((b.y1 - b.y0) / 1.25);
    const sx = b.x1 - b.x0, sz = b.z1 - b.z0;
    const nx = Math.max(1, Math.round(sx / 1.2)), nz = Math.max(1, Math.round(sz / 1.0));
    for (let l = 0; l < layers; l++) {
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = b.x0 + (i + 0.5) * sx / nx, z = b.z0 + (j + 0.5) * sz / nz, y = b.y0 + l * 1.25;
        pallets.add(x, y, z, sx / nx - 0.02, 0.14, sz / nz - 0.02, 0xb08a5c);
        const tint = Math.random();
        if (tint < 0.3) wrapped.add(x, y + 0.14, z, sx / nx - 0.04, 1.1, sz / nz - 0.04, pick(LOAD_TINTS));
        else pick(loads).add(x, y + 0.14, z, sx / nx - 0.06, 1.1, sz / nz - 0.06);
      }
    }
  }

  // packing tables with a screen and parcels
  const tableTop = new THREE.MeshStandardMaterial({ color: 0xd8c7a6, roughness: 0.7 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8c9099, roughness: 0.4, metalness: 0.7 });
  const screenMat = new THREE.MeshBasicMaterial({ map: canvasTex(256, 160, (g) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, 256, 160);
    g.fillStyle = "#1d1d1f"; g.fillRect(10, 10, 236, 140);
    g.strokeStyle = "#474fff"; g.lineWidth = 3; g.strokeRect(30, 30, 120, 90);
    for (let i = 0; i < 6; i++) { g.fillStyle = ["#3B82F6", "#8B5CF6", "#10B981", "#6366F1"][i % 4]; g.fillRect(40 + i * 17, 60 + (i % 3) * 14, 10, 10); }
    g.fillStyle = "#f5f5f7"; g.font = "600 14px Menlo, monospace"; g.fillText("efectivo", 165, 45);
    g.fillStyle = "#6EE7B7"; g.fillText("● LIVE", 165, 70);
  }) });
  for (const b of BOXES) {
    if (b.kind !== "table") continue;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, sx = b.x1 - b.x0, sz = b.z1 - b.z0;
    const top = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.05, sz), tableTop); top.position.set(cx, b.y1 - 0.025, cz); top.castShadow = top.receiveShadow = true; group.add(top);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, b.y1 - 0.05, 0.06), steel); leg.position.set(cx + dx * (sx / 2 - 0.08), (b.y1 - 0.05) / 2, cz + dz * (sz / 2 - 0.08)); group.add(leg);
    }
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(sx - 0.1, 0.03, sz - 0.1), steel); shelf.position.set(cx, 0.25, cz); group.add(shelf);
    const mon = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.35, 0.03), screenMat); mon.position.set(cx - 0.6, b.y1 + 0.3, cz - 0.35); group.add(mon);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.04), steel); post.position.set(cx - 0.6, b.y1 + 0.1, cz - 0.37); group.add(post);
    pick(loads).add(cx + 0.5, b.y1, cz + 0.1, 0.5, 0.35, 0.4);
    pick(loads).add(cx + 0.2, b.y1, cz - 0.2, 0.35, 0.25, 0.3);
    const rollGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.5, 16); rollGeo.rotateZ(Math.PI / 2);
    const roll = new THREE.Mesh(rollGeo, new THREE.MeshStandardMaterial({ color: 0xc8b48a })); roll.position.set(cx - 0.1, b.y1 + 0.12, cz + 0.35); group.add(roll);
  }

  // columns with a striped guard at the bottom
  const colMat = new THREE.MeshStandardMaterial({ color: 0x55585f, roughness: 0.5, metalness: 0.6 });
  const stripeMat = new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.6 });
  for (const b of BOXES) {
    if (b.kind !== "column") continue;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const c = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, b.y1, b.z1 - b.z0), colMat); c.position.set(cx, b.y1 / 2, cz); c.castShadow = c.receiveShadow = true; group.add(c);
    const g = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0 + 0.06, 1.2, b.z1 - b.z0 + 0.06), stripeMat); g.position.set(cx, 0.6, cz); group.add(g);
  }

  // drums
  const drumGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.94, 20).translate(0, 0.47, 0);
  const drumMats = [0x2546c9, 0x1f6f4a, 0x9b1c1c].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.5 }));
  const hazard = new THREE.MeshBasicMaterial({ map: canvasTex(128, 128, (g) => {
    g.fillStyle = "#e5b50a"; g.beginPath(); g.moveTo(64, 8); g.lineTo(120, 112); g.lineTo(8, 112); g.closePath(); g.fill();
    g.fillStyle = "#111"; g.font = "700 64px Inter, sans-serif"; g.textAlign = "center"; g.fillText("!", 64, 100);
  }), transparent: true });
  let di = 0;
  for (const b of BOXES) {
    if (b.kind !== "drum") continue;
    const d = new THREE.Mesh(drumGeo, drumMats[di++ % drumMats.length]); d.position.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2); d.castShadow = d.receiveShadow = true; group.add(d);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28), hazard); s.position.set(d.position.x, 0.55, d.position.z + 0.295); group.add(s);
  }

  // office: grey cladding, dark glass with a lit interior, a sign
  for (const b of BOXES) {
    if (b.kind !== "office") continue;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, sx = b.x1 - b.x0, sz = b.z1 - b.z0, h = b.y1;
    const body = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), new THREE.MeshStandardMaterial({ color: 0x2b2c31, roughness: 0.6, metalness: 0.2 }));
    body.position.set(cx, h / 2, cz); body.castShadow = body.receiveShadow = true; group.add(body);
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b0c10, emissive: 0x1a1f3a, roughness: 0.05, metalness: 0.9 });
    for (let x = b.x0 + 0.9; x < b.x1 - 0.5; x += 1.6) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), glass); win.position.set(x, 1.85, b.z0 - 0.01); win.rotation.y = Math.PI; group.add(win);
    }
    for (let z = b.z0 + 0.9; z < b.z1 - 0.5; z += 1.6) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), glass); win.position.set(b.x0 - 0.01, 1.85, z); win.rotation.y = -Math.PI / 2; group.add(win);
    }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.5), new THREE.MeshBasicMaterial({ map: labelTexture("BIURO ZMIANY", "#000000", "#f5f5f7") }));
    sign.position.set(cx, h + 0.4, b.z0 - 0.02); sign.rotation.y = Math.PI; group.add(sign);
  }

  // wire cage
  for (const b of BOXES) {
    if (b.kind !== "cage") continue;
    const t = meshTexture(); t.repeat.set((b.x1 - b.x0) / 0.6, (b.y1 - b.y0) / 0.6);
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0), new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4 }));
    m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2); group.add(m);
    for (let i = 0; i < 6; i++) pick(loads).add(b.x0 + 0.4 + (i % 3) * 1.25, 0, b.z0 + 0.45 + Math.floor(i / 3) * 0.55, 0.7, 0.5 + Math.random() * 0.8, 0.45);
  }

  // forklifts
  for (const b of BOXES) if (b.kind === "forklift") group.add(forklift(b));

  // UWB anchors with a pulsing accent LED
  const ledMat = new THREE.MeshBasicMaterial({ color: ACCENT });
  const anchorMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.4 });
  const leds: THREE.Mesh[] = [];
  for (const [x, z] of ANCHORS) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.28), anchorMat);
    const inX = Math.abs(x) > 39 ? -Math.sign(x) * 0.3 : 0.45, inZ = Math.abs(z) > 24 ? -Math.sign(z) * 0.3 : 0;
    a.position.set(x + inX, 8, z + inZ); group.add(a);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), ledMat); led.position.set(a.position.x, 7.9, a.position.z); group.add(led); leds.push(led);
  }

  rackUp.build(group); beams.build(group); pallets.build(group); wrapped.build(group);
  for (const l of loads) l.build(group);

  // pickups
  const pickups = PICKUPS.map((p) => {
    const m = pickupMesh(p.kind);
    m.position.set(p.x, 0.9, p.z);
    group.add(m);
    return m;
  });

  return {
    group,
    update(t: number) {
      const s = 0.6 + 0.4 * Math.sin(t * 3);
      for (const l of leds) l.scale.setScalar(0.8 + s * 0.5);
      for (let i = 0; i < pickups.length; i++) { pickups[i].rotation.y = t * 1.6 + i; pickups[i].position.y = 0.85 + Math.sin(t * 2 + i) * 0.08; }
    },
    setPickups(active: boolean[]) { for (let i = 0; i < pickups.length; i++) pickups[i].visible = !!active[i]; },
  };
}

function forklift(b: Box): THREE.Group {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.6, metalness: 0.4 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.9 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  add(new THREE.BoxGeometry(1.7, 0.9, 1.15), yellow, -0.15, 0.75, 0);
  add(new THREE.BoxGeometry(0.5, 0.8, 1.15), dark, -0.95, 0.8, 0); // counterweight
  add(new THREE.BoxGeometry(0.5, 0.45, 0.5), dark, -0.25, 1.35, 0); // seat
  for (const [x, z] of [[-0.85, -0.5], [-0.85, 0.5], [0.45, -0.5], [0.45, 0.5]]) add(new THREE.BoxGeometry(0.05, 1.1, 0.05), dark, x, 1.75, z);
  add(new THREE.BoxGeometry(1.4, 0.06, 1.1), dark, -0.2, 2.3, 0);
  add(new THREE.BoxGeometry(0.12, 2.2, 0.9), dark, 0.75, 1.1, 0); // mast
  add(new THREE.BoxGeometry(1.0, 0.06, 0.12), steelFork, 1.3, 0.12, -0.3);
  add(new THREE.BoxGeometry(1.0, 0.06, 0.12), steelFork, 1.3, 0.12, 0.3);
  const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 18); wheel.rotateX(Math.PI / 2);
  for (const [x, z] of [[-0.7, -0.6], [-0.7, 0.6], [0.4, -0.6], [0.4, 0.6]]) add(wheel, tyre, x, 0.3, z);
  const beacon = add(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: 0xf59e0b }), -0.6, 2.38, 0);
  beacon.castShadow = false;
  g.position.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  g.rotation.y = b.rot ?? 0;
  return g;
}
const steelFork = new THREE.MeshStandardMaterial({ color: 0x6b6f77, metalness: 0.8, roughness: 0.35 });

function pickupMesh(kind: PickupKind): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  if (kind === "med") {
    add(new THREE.BoxGeometry(0.5, 0.36, 0.22), new THREE.MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.4 }));
    const cross = new THREE.MeshBasicMaterial({ color: 0x12b76a });
    add(new THREE.BoxGeometry(0.22, 0.07, 0.23), cross); add(new THREE.BoxGeometry(0.07, 0.22, 0.23), cross);
  } else if (kind === "ammo") {
    add(new THREE.BoxGeometry(0.5, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0x4b5320, roughness: 0.6, metalness: 0.3 }));
    add(new THREE.BoxGeometry(0.52, 0.05, 0.31), new THREE.MeshStandardMaterial({ color: 0xe5b50a }), 0, 0.08, 0);
  } else if (kind === "shotgun") {
    const m = new THREE.MeshStandardMaterial({ color: 0x2a2b30, metalness: 0.7, roughness: 0.35 });
    add(new THREE.BoxGeometry(0.9, 0.08, 0.08), m); add(new THREE.BoxGeometry(0.3, 0.14, 0.07), new THREE.MeshStandardMaterial({ color: 0x6b4a2b }), -0.45, -0.04, 0);
    add(new THREE.BoxGeometry(0.25, 0.08, 0.09), new THREE.MeshStandardMaterial({ color: 0x6b4a2b }), 0.15, -0.07, 0);
  } else {
    // efectivo GEO: a black UWB tag with a glowing accent ring
    add(new THREE.BoxGeometry(0.32, 0.46, 0.1), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.2, metalness: 0.6 }));
    const ring = add(new THREE.TorusGeometry(0.1, 0.018, 8, 32), new THREE.MeshBasicMaterial({ color: ACCENT }), 0, 0.06, 0.055);
    ring.rotation.set(0, 0, 0);
  }
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.62, 40), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  halo.rotation.x = -Math.PI / 2; halo.position.y = -0.83;
  g.add(halo);
  return g;
}
