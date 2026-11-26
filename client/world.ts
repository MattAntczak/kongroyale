// Draws the efectivo warehouse from shared/map.ts: floor with zone markings, walls and dock doors, high-bay racks
// filled with pallets, pallet stacks, packing tables, drums, the office, forklifts, the UWB anchor network and the
// pickups. Every texture is drawn on a canvas at start-up, so the hall needs no downloaded assets.
//
// Draw calls are what an integrated GPU pays for, so repeated things go through an Instancer, static boxes that share a
// tiling texture are merged into one mesh (BoxBatch), and every flat sign, logo and door shares one atlas (Decals).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BOXES, HALL, LADDERS, PICKUPS, ZONES, layout, type PickupKind } from "../shared/map";
import type { Mission } from "../shared/proto";
import { gunModel } from "./human";

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

// ------------------------------------------------------------------ the depot's plan, read back from its walls

/** A doorway or a short passage between two rooms of the depot, in metres. `alongZ`: you walk through it along z. */
interface Door { x0: number; x1: number; z0: number; z1: number; alongZ: boolean }

/** Is there a wall at (x, z)? The depot's walls sit on a 1 m grid (shared/map.ts), so a byte per cell is enough. */
function wallGrid(): (x: number, z: number) => boolean {
  const GW = Math.round(HALL.x1 - HALL.x0), GH = Math.round(HALL.z1 - HALL.z0), cells = new Uint8Array(GW * GH);
  for (const b of BOXES) {
    if (b.kind !== "wall") continue;
    for (let z = Math.max(HALL.z0, b.z0); z < Math.min(HALL.z1, b.z1); z++) for (let x = Math.max(HALL.x0, b.x0); x < Math.min(HALL.x1, b.x1); x++) cells[(z - HALL.z0) * GW + (x - HALL.x0)] = 1;
  }
  return (x, z) => { const i = Math.floor(x - HALL.x0), j = Math.floor(z - HALL.z0); return i < 0 || j < 0 || i >= GW || j >= GH || cells[j * GW + i] === 1; };
}

/**
 * The doorways are not in the layout, only the walls are. A doorway is an open strip at most 6 m wide that keeps its
 * width for up to 14 m and opens into a room at both ends (every room is wider than that).
 */
function findDoors(solid: (x: number, z: number) => boolean): Door[] {
  const out: Door[] = [];
  for (const alongZ of [true, false]) {
    const n0 = alongZ ? HALL.z0 : HALL.x0, n1 = alongZ ? HALL.z1 : HALL.x1, m0 = alongZ ? HALL.x0 : HALL.z0, m1 = alongZ ? HALL.x1 : HALL.z1;
    const at = (n: number, m: number) => alongZ ? solid(m + 0.5, n + 0.5) : solid(n + 0.5, m + 0.5);
    let live = new Map<number, { a: number; b: number; s: number; e: number }>();
    const found: { a: number; b: number; s: number; e: number }[] = [];
    for (let n = n0; n < n1; n++) {
      const next = new Map<number, { a: number; b: number; s: number; e: number }>();
      for (let m = m0; m < m1;) {
        if (at(n, m)) { m++; continue; }
        let e = m; while (e < m1 && !at(n, e)) e++;
        if (e - m <= 6) {
          const key = (m - m0) * 4096 + (e - m0), prev = live.get(key);
          if (prev) { prev.e = n + 1; next.set(key, prev); } else { const r = { a: m, b: e, s: n, e: n + 1 }; found.push(r); next.set(key, r); }
        }
        m = e;
      }
      live = next;
    }
    for (const r of found) {
      const mid = (r.a + r.b) >> 1;
      if (r.e - r.s > 14 || at(r.s - 1, mid) || at(r.e, mid)) continue;
      out.push(alongZ ? { x0: r.a, x1: r.b, z0: r.s, z1: r.e, alongZ } : { x0: r.s, x1: r.e, z0: r.a, z1: r.b, alongZ });
    }
  }
  return out;
}

/** Where the lamp strips hang: a grid, in the depot denser (the rooms are small) and never inside a wall. */
function lampSpots(solid: ((x: number, z: number) => boolean) | null): [number, number][] {
  const out: [number, number][] = [], sx = solid ? 11.5 : 19.5, sz = solid ? 10 : 19.5;
  for (let x = HALL.x0 + (solid ? 6.5 : 9); x < HALL.x1; x += sx) for (let z = HALL.z0 + (solid ? 5 : 6.5); z < HALL.z1; z += sz) {
    if (solid && (solid(x, z) || solid(x - 1.6, z) || solid(x + 1.6, z))) continue;
    out.push([x, z]);
  }
  return out;
}

// ------------------------------------------------------------------ floor

function floorTexture(doors: Door[], lamps: [number, number][]) {
  const depot = layout().kind === "depot";
  const PX = depot ? 14 : 7; // pixels per metre (the whole floor is one texture: 3780 px across in the hall)
  const W = (HALL.x1 - HALL.x0) * PX, H = (HALL.z1 - HALL.z0) * PX;
  const X = (x: number) => (x - HALL.x0) * PX, Z = (z: number) => (z - HALL.z0) * PX;
  return canvasTex(W, H, (g) => {
    g.fillStyle = "#5a5c60"; g.fillRect(0, 0, W, H);
    // trowel marks and stains
    for (let i = 0; i < 320; i++) {
      const r = 20 + Math.random() * 140;
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      const a = Math.random() * 0.07;
      gr.addColorStop(0, Math.random() < 0.55 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a * 0.6})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.save(); g.translate(Math.random() * W, Math.random() * H); g.fillStyle = gr; g.fillRect(-r, -r, r * 2, r * 2); g.restore();
    }
    noise(g, W, H, 0.08, 60000);
    // each slab between the expansion joints is poured separately: a slightly different grey, then the joint every 5 m
    for (let x = HALL.x0; x < HALL.x1; x += 5) for (let z = HALL.z0; z < HALL.z1; z += 5) {
      const v = Math.random(); g.fillStyle = v < 0.5 ? `rgba(0,0,0,${v * 0.07})` : `rgba(255,255,255,${(v - 0.5) * 0.05})`;
      g.fillRect(X(x), Z(z), 5 * PX, 5 * PX);
    }
    g.strokeStyle = "rgba(0,0,0,0.3)"; g.lineWidth = 1;
    for (let x = HALL.x0; x <= HALL.x1; x += 5) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), H); g.stroke(); }
    for (let z = HALL.z0; z <= HALL.z1; z += 5) { g.beginPath(); g.moveTo(0, Z(z)); g.lineTo(W, Z(z)); g.stroke(); }
    // tyre marks: pairs of faint arcs where forklifts turned
    g.lineCap = "round"; g.lineWidth = Math.max(1.5, 0.2 * PX);
    for (let i = 0; i < (depot ? 90 : 280); i++) {
      const x = Math.random() * W, y = Math.random() * H, r = (3 + Math.random() * 14) * PX, a0 = Math.random() * 6.28, da = 0.3 + Math.random() * 1.1;
      g.strokeStyle = `rgba(14,13,12,${0.05 + Math.random() * 0.1})`;
      for (const dr of [0, 1.1 * PX]) { g.beginPath(); g.arc(x, y, r + dr, a0, a0 + da); g.stroke(); }
    }
    g.lineCap = "butt";
    // a pale pool of light under every lamp strip (the lamps themselves are unlit boxes, not light sources)
    for (const [lx, lz] of lamps) {
      const r = 7 * PX, gr = g.createRadialGradient(X(lx), Z(lz), 0, X(lx), Z(lz), r);
      gr.addColorStop(0, "rgba(255,246,226,0.085)"); gr.addColorStop(1, "rgba(255,246,226,0)");
      g.fillStyle = gr; g.fillRect(X(lx) - r, Z(lz) - r, r * 2, r * 2);
    }
    // zones: a light tint and a thin edge line (the name comes later, small)
    for (const zn of ZONES) {
      g.fillStyle = zn.color + (depot ? "10" : "1c");
      g.fillRect(X(zn.x0), Z(zn.z0), (zn.x1 - zn.x0) * PX, (zn.z1 - zn.z0) * PX);
      g.strokeStyle = zn.color + (depot ? "88" : "cc"); g.lineWidth = (depot ? 0.1 : 0.12) * PX;
      const m = depot ? 0.45 * PX : 4;
      g.strokeRect(X(zn.x0) + m, Z(zn.z0) + m, (zn.x1 - zn.x0) * PX - 2 * m, (zn.z1 - zn.z0) * PX - 2 * m);
    }
    // hatching in the hazardous area
    const hz = ZONES.find((z) => z.name.startsWith("STREFA"));
    if (hz) {
    g.save(); g.beginPath(); g.rect(X(hz.x0), Z(hz.z0), (hz.x1 - hz.x0) * PX, 0.8 * PX); g.clip();
    g.fillStyle = "#e5b50a"; g.fillRect(X(hz.x0), Z(hz.z0), (hz.x1 - hz.x0) * PX, 0.8 * PX);
    g.fillStyle = "#111"; for (let x = X(hz.x0) - 40; x < X(hz.x1) + 40; x += 28) { g.beginPath(); g.moveTo(x, Z(hz.z0)); g.lineTo(x + 14, Z(hz.z0)); g.lineTo(x + 14 + 19, Z(hz.z0) + 0.8 * PX); g.lineTo(x + 19, Z(hz.z0) + 0.8 * PX); g.fill(); }
    g.restore();
    }
    // doorways: the floor is worn dark where everybody walks, and the threshold is hatched "keep clear"
    for (const d of doors) {
      const cx = X((d.x0 + d.x1) / 2), cz = Z((d.z0 + d.z1) / 2), w = (d.x1 - d.x0) * PX, h = (d.z1 - d.z0) * PX, r = Math.max(w, h) / 2 + 3.5 * PX;
      const gr = g.createRadialGradient(cx, cz, 0, cx, cz, r);
      gr.addColorStop(0, "rgba(22,20,17,0.3)"); gr.addColorStop(0.5, "rgba(22,20,17,0.14)"); gr.addColorStop(1, "rgba(22,20,17,0)");
      g.fillStyle = gr; g.fillRect(cx - r, cz - r, r * 2, r * 2);
      g.save(); g.beginPath(); g.rect(X(d.x0), Z(d.z0), w, h); g.clip();
      g.strokeStyle = "rgba(240,196,0,0.5)"; g.lineWidth = 0.14 * PX;
      for (let k = -h; k < w; k += 0.8 * PX) { g.beginPath(); g.moveTo(X(d.x0) + k, Z(d.z0)); g.lineTo(X(d.x0) + k + h, Z(d.z0) + h); g.stroke(); }
      g.restore();
      g.strokeStyle = "rgba(240,196,0,0.7)"; g.lineWidth = 0.12 * PX; g.strokeRect(X(d.x0), Z(d.z0), w, h);
    }
    // the railway track: ballast, sleepers and two rails
    const rl = layout().rails;
    if (rl) {
      const len = (rl.x1 - rl.x0) * PX;
      g.fillStyle = "#37322d"; g.fillRect(X(rl.x0), Z(rl.z - 1.55), len, 3.1 * PX);
      // gravel: thousands of small stones, light and dark
      for (let i = 0; i < 16000; i++) {
        const v = 30 + Math.random() * 75 | 0; g.fillStyle = `rgb(${v + 6},${v + 2},${v})`;
        g.fillRect(X(rl.x0) + Math.random() * len, Z(rl.z - 1.55) + Math.random() * 3.1 * PX, 1 + Math.random() * 2.2, 1 + Math.random() * 2.2);
      }
      for (let x = rl.x0 + 0.3; x < rl.x1; x += 0.65) {
        const l = 17 + Math.random() * 9; g.fillStyle = `hsl(27,${22 + Math.random() * 10}%,${l}%)`; g.fillRect(X(x), Z(rl.z - 1.25), 0.26 * PX, 2.5 * PX);
        g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(X(x) + 0.26 * PX, Z(rl.z - 1.25), 1, 2.5 * PX); // a shadow line, so the sleeper stands out of the gravel
      }
      for (const dz of [-0.72, 0.72]) {
        g.fillStyle = "#3a2c22"; g.fillRect(X(rl.x0), Z(rl.z + dz) - 0.09 * PX, len, 0.18 * PX); // rusty foot
        g.fillStyle = "#aeb4bd"; g.fillRect(X(rl.x0), Z(rl.z + dz) - 0.04 * PX, len, 0.08 * PX); // polished head
        g.fillStyle = "rgba(255,255,255,0.55)"; g.fillRect(X(rl.x0), Z(rl.z + dz) - 0.01 * PX, len, 1);
      }
      g.strokeStyle = "rgba(240,196,0,0.85)"; g.lineWidth = 0.12 * PX; g.setLineDash([1.2 * PX, 0.8 * PX]);
      for (const dz of [-2, 2]) { g.beginPath(); g.moveTo(X(rl.x0), Z(rl.z + dz)); g.lineTo(X(rl.x1), Z(rl.z + dz)); g.stroke(); }
      g.setLineDash([]);
      // two level crossings, where the barriers on both sides of the track leave a gap (buildDepot's barrier rows)
      g.fillStyle = "rgba(240,240,240,0.6)";
      for (const cx of [-21, 17]) for (let z = rl.z - 3.4; z < rl.z + 3.2; z += 0.8) g.fillRect(X(cx - 1), Z(z), 2 * PX, 0.4 * PX);
    }
    // the depot's docks: a green pedestrian lane along the wall the passages come out of
    const yard = depot ? ZONES.find((z) => z.name === "DOKI") : undefined;
    if (yard) {
      g.fillStyle = "rgba(16,185,129,0.2)"; g.fillRect(X(yard.x0 + 1), Z(yard.z0 + 0.8), (yard.x1 - yard.x0 - 2) * PX, 1.5 * PX);
      g.fillStyle = "rgba(240,240,240,0.6)";
      for (const dz of [0.8, 2.3]) g.fillRect(X(yard.x0 + 1), Z(yard.z0 + dz) - 0.05 * PX, (yard.x1 - yard.x0 - 2) * PX, 0.1 * PX);
    }
    // yellow aisle lines in front of every rack and around stacks
    g.strokeStyle = "rgba(240,196,0,0.85)"; g.lineWidth = 1.6;
    for (const b of BOXES) {
      if (b.kind !== "rack" && b.kind !== "stack" && b.kind !== "table") continue;
      const m = b.kind === "rack" ? 0.35 : 0.25;
      g.strokeRect(X(b.x0 - m), Z(b.z0 - m), (b.x1 - b.x0 + 2 * m) * PX, (b.z1 - b.z0 + 2 * m) * PX);
    }
    // walkway arrows along the main aisle
    if (!depot) {
    g.fillStyle = "rgba(245,245,247,0.55)";
    for (let x = HALL.x0 + 8; x < HALL.x1 - 4; x += 18) {
      g.save(); g.translate(X(x), Z(0)); g.scale(PX / 10, PX / 10); g.beginPath(); g.moveTo(-18, -10); g.lineTo(6, -10); g.lineTo(6, -20); g.lineTo(26, 0); g.lineTo(6, 20); g.lineTo(6, 10); g.lineTo(-18, 10); g.closePath(); g.fill(); g.restore();
    }
    g.strokeStyle = "rgba(245,245,247,0.5)"; g.setLineDash([0.9 * PX, 0.6 * PX]); g.lineWidth = 1.6;
    for (const z of [-4.2, 4.2]) { g.beginPath(); g.moveTo(X(HALL.x0), Z(z)); g.lineTo(X(HALL.x1), Z(z)); g.stroke(); }
    g.setLineDash([]);
    }
    // zone names: in the depot small stencils in a corner (the wall signs carry the name), in the hall big ones
    g.textAlign = "left"; g.textBaseline = "top";
    for (const zn of ZONES) {
      g.font = `600 ${Math.round((depot ? 1.1 : 4) * PX)}px Inter, -apple-system, sans-serif`;
      g.fillStyle = depot ? "rgba(245,245,247,0.22)" : "rgba(245,245,247,0.3)";
      const tx = X(zn.x0) + (depot ? 1.1 : 0.8) * PX, tz = Z(zn.z0) + (zn.name.startsWith("STREFA") ? 1.3 : depot ? 1.0 : 0.6) * PX;
      g.fillText(zn.name, tx, tz);
    }
    // pickup pads
    for (const p of PICKUPS) {
      g.strokeStyle = "rgba(71,79,255,0.75)"; g.lineWidth = 1.5;
      g.beginPath(); g.arc(X(p.x), Z(p.z), 0.9 * PX, 0, Math.PI * 2); g.stroke();
    }
  });
}

// ------------------------------------------------------------------ materials

/**
 * One wall texture for 6 m of wall, bottom to top (v = 0 at the floor, 1 at the top of the wall). Plain walls are
 * painted precast concrete with a dark plinth and an efectivo-blue line; the cold store has white insulated panels.
 */
function wallTexture(cold: boolean) {
  const W = 512, H = 1024, wallH = HALL.h + 1, my = H / wallH, mx = W / 6, Y = (m: number) => H - m * my;
  return canvasTex(W, H, (g) => {
    // a blotch that wraps around the left and right edge, so the texture tiles along the wall
    const blotch = (x: number, y: number, r: number, col: string) => {
      for (const ox of [-W, 0, W]) {
        const gr = g.createRadialGradient(x + ox, y, 0, x + ox, y, r); gr.addColorStop(0, col); gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr; g.fillRect(x + ox - r, y - r, r * 2, r * 2);
      }
    };
    if (cold) {
      g.fillStyle = "#e6eff5"; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 14; i++) blotch(Math.random() * W, Math.random() * H, 60 + Math.random() * 120, `rgba(120,160,190,${Math.random() * 0.08})`);
      // sandwich panels 1 m wide: a groove at each seam with a lit edge beside it, and faint micro-ribs in between
      g.fillStyle = "rgba(60,95,125,0.06)"; for (let x = 0; x < W; x += mx / 6) g.fillRect(x, 0, 1.5, H);
      for (let x = 0; x < W; x += mx) {
        g.fillStyle = "rgba(30,55,80,0.4)"; g.fillRect(x, 0, 2.5, H);
        g.fillStyle = "rgba(255,255,255,0.6)"; g.fillRect(x + 2.5, 0, 2, H);
        g.fillStyle = "rgba(30,55,80,0.1)"; g.fillRect(x - 5, 0, 5, H);
      }
      g.fillStyle = "#38bdf8"; g.fillRect(0, Y(2.5), W, 0.18 * my);
      g.fillStyle = "rgba(0,0,0,0.12)"; g.fillRect(0, Y(2.5) + 0.18 * my, W, 2);
      // frost creeping up from the floor, then a stainless kick plate
      const fr = g.createLinearGradient(0, Y(1.5), 0, Y(0)); fr.addColorStop(0, "rgba(150,200,235,0)"); fr.addColorStop(1, "rgba(150,200,235,0.4)");
      g.fillStyle = fr; g.fillRect(0, Y(1.5), W, 1.5 * my);
      g.fillStyle = "#7f8b97"; g.fillRect(0, Y(0.32), W, 0.32 * my);
      g.fillStyle = "rgba(255,255,255,0.45)"; g.fillRect(0, Y(0.32), W, 2);
      g.fillStyle = "rgba(0,0,0,0.3)"; for (let x = mx / 2; x < W; x += mx / 2) { g.beginPath(); g.arc(x, Y(0.16), 2, 0, 6.3); g.fill(); }
      noise(g, W, H, 0.035, 5000);
      return;
    }
    g.fillStyle = "#c5c2b8"; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 26; i++) blotch(Math.random() * W, Math.random() * H, 40 + Math.random() * 130, Math.random() < 0.6 ? `rgba(70,62,50,${Math.random() * 0.1})` : `rgba(255,255,255,${Math.random() * 0.09})`);
    // dust and rain streaks running down from the roof
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * W, len = (0.15 + Math.random() * 0.4) * H, w = 2 + Math.random() * 7;
      const gr = g.createLinearGradient(0, 0, 0, len); gr.addColorStop(0, `rgba(60,52,42,${0.05 + Math.random() * 0.1})`); gr.addColorStop(1, "rgba(60,52,42,0)");
      g.fillStyle = gr; g.fillRect(x, 0, w, len);
    }
    // precast panels 3 m wide with a joint half-way up, and the plugged lifting holes
    for (let x = 0; x < W; x += mx * 3) { g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(x, 0, 2.5, H); g.fillStyle = "rgba(255,255,255,0.22)"; g.fillRect(x + 2.5, 0, 1.5, H); }
    g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(0, Y(wallH / 2), W, 2.5); g.fillStyle = "rgba(255,255,255,0.2)"; g.fillRect(0, Y(wallH / 2) + 2.5, W, 1.5);
    g.fillStyle = "rgba(0,0,0,0.2)";
    for (let x = mx * 0.75; x < W; x += mx * 1.5) for (const m of [0.3, 0.45, 0.8, 0.95]) { g.beginPath(); g.arc(x, Y(wallH * m), 3, 0, 6.3); g.fill(); }
    // grime settling on the plinth, the plinth with scuffs from pallets, the blue line
    const gr = g.createLinearGradient(0, Y(2.4), 0, Y(1.1)); gr.addColorStop(0, "rgba(50,44,36,0)"); gr.addColorStop(1, "rgba(50,44,36,0.2)");
    g.fillStyle = gr; g.fillRect(0, Y(2.4), W, 1.3 * my);
    g.fillStyle = "#3a3d43"; g.fillRect(0, Y(1.0), W, my);
    g.strokeStyle = "rgba(190,190,185,0.16)"; g.lineWidth = 1.5;
    for (let i = 0; i < 40; i++) { const x = Math.random() * W, y = Y(Math.random() * 0.9); g.beginPath(); g.moveTo(x, y); g.lineTo(x + 10 + Math.random() * 50, y + (Math.random() - 0.5) * 6); g.stroke(); }
    const fl = g.createLinearGradient(0, Y(0.3), 0, Y(0)); fl.addColorStop(0, "rgba(0,0,0,0)"); fl.addColorStop(1, "rgba(0,0,0,0.35)");
    g.fillStyle = fl; g.fillRect(0, Y(0.3), W, 0.3 * my);
    g.fillStyle = "#474fff"; g.fillRect(0, Y(1.14), W, 0.14 * my);
    g.fillStyle = "rgba(255,255,255,0.2)"; g.fillRect(0, Y(1.14), W, 1.5);
    noise(g, W, H, 0.05, 7000);
  }, [1, 1]);
}

/** The underside of the roof: dark-grey trapezoid sheet, 4 m per tile, with the shadow of a purlin every 2 m. */
function roofTexture() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = "#5a5f67"; g.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 16) {
      const gr = g.createLinearGradient(x, 0, x + 16, 0);
      gr.addColorStop(0, "rgba(0,0,0,0.32)"); gr.addColorStop(0.3, "rgba(255,255,255,0.1)"); gr.addColorStop(0.7, "rgba(255,255,255,0.1)"); gr.addColorStop(1, "rgba(0,0,0,0.32)");
      g.fillStyle = gr; g.fillRect(x, 0, 16, 256);
    }
    for (const y of [0, 128]) { g.fillStyle = "rgba(0,0,0,0.38)"; g.fillRect(0, y, 256, 9); g.fillStyle = "rgba(0,0,0,0.14)"; g.fillRect(0, y + 9, 256, 8); }
    noise(g, 256, 256, 0.05, 1800);
  }, [1, 1]);
}

/** A soft glow, drawn additively around a lamp strip. */
function glowTexture() {
  return canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(0.35, "rgba(255,255,255,0.16)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}

/**
 * A shipping container in grey, tinted per instance: the corrugated long side on the top half of the atlas, below it
 * the door end with its locking bars, the plain end and the roof. Only darker and lighter greys: the paint multiplies.
 */
function containerTexture() {
  return canvasTex(1024, 512, (g) => {
    g.fillStyle = "#e2e2e2"; g.fillRect(0, 0, 1024, 512);
    const ribs = (x0: number, y0: number, w: number, h: number, step: number) => {
      for (let x = x0; x < x0 + w; x += step) {
        const gr = g.createLinearGradient(x, 0, x + step, 0);
        gr.addColorStop(0, "rgba(0,0,0,0.3)"); gr.addColorStop(0.25, "rgba(0,0,0,0.04)"); gr.addColorStop(0.5, "rgba(255,255,255,0.14)"); gr.addColorStop(0.75, "rgba(0,0,0,0.04)"); gr.addColorStop(1, "rgba(0,0,0,0.3)");
        g.fillStyle = gr; g.fillRect(x, y0, Math.min(step, x0 + w - x), h);
      }
    };
    const frame = (x0: number, y0: number, w: number, h: number, post: number) => {
      g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(x0, y0, w, 12); g.fillRect(x0, y0 + h - 16, w, 16); g.fillRect(x0, y0, post, h); g.fillRect(x0 + w - post, y0, post, h);
      g.fillStyle = "rgba(255,255,255,0.18)"; g.fillRect(x0, y0 + 12, w, 1.5); g.fillRect(x0 + post, y0, 1.5, h);
      g.fillStyle = "rgba(0,0,0,0.45)"; for (const [cx, cy] of [[x0, y0], [x0 + w - post, y0], [x0, y0 + h - 16], [x0 + w - post, y0 + h - 16]]) g.fillRect(cx + 3, cy + 3, post - 6, 10); // corner castings
    };
    // long side, 12 m across
    ribs(0, 0, 1024, 256, 16); frame(0, 0, 1024, 256, 18);
    g.fillStyle = "rgba(0,0,0,0.55)"; for (const x of [380, 600]) g.fillRect(x, 244, 44, 9); // forklift pockets
    for (let i = 0; i < 30; i++) { // rust runs and scrapes
      const x = Math.random() * 1024, y = 12 + Math.random() * 120, len = 20 + Math.random() * 100;
      const gr = g.createLinearGradient(0, y, 0, y + len); gr.addColorStop(0, `rgba(40,20,5,${0.1 + Math.random() * 0.2})`); gr.addColorStop(1, "rgba(40,20,5,0)");
      g.fillStyle = gr; g.fillRect(x, y, 2 + Math.random() * 5, len);
    }
    // door end: two leaves, four locking bars with their cams and handles, hinges
    frame(0, 256, 256, 256, 14);
    g.fillStyle = "rgba(0,0,0,0.5)"; g.fillRect(126, 268, 4, 228);
    for (const x of [48, 96, 160, 208]) {
      g.fillStyle = "rgba(0,0,0,0.5)"; g.fillRect(x - 3, 266, 6, 232);
      g.fillStyle = "rgba(255,255,255,0.3)"; g.fillRect(x + 3, 266, 1.5, 232);
      g.fillStyle = "rgba(0,0,0,0.6)"; g.fillRect(x - 8, 266, 16, 8); g.fillRect(x - 8, 490, 16, 8); g.fillRect(x - 3, 400, 26, 6); g.fillRect(x + 19, 394, 6, 18);
    }
    g.fillStyle = "rgba(0,0,0,0.4)"; for (const y of [290, 345, 400, 455]) { g.fillRect(14, y, 16, 7); g.fillRect(226, y, 16, 7); }
    // plain end and roof
    ribs(256, 256, 256, 256, 20); frame(256, 256, 256, 256, 14);
    ribs(512, 256, 512, 256, 16); g.fillStyle = "rgba(0,0,0,0.22)"; g.fillRect(512, 256, 512, 256);
    g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(512, 256, 512, 8); g.fillRect(512, 504, 512, 8);
    noise(g, 1024, 512, 0.05, 6000);
  });
}

/** The covered goods wagon: plank sides with a sliding door, rust, and its markings (same atlas layout as a container). */
function wagonTexture() {
  return canvasTex(1024, 512, (g) => {
    const planks = (x0: number, y0: number, w: number, h: number) => {
      g.fillStyle = "#84341d"; g.fillRect(x0, y0, w, h);
      for (let x = x0; x < x0 + w; x += 12.8) { g.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.1})`; g.fillRect(x, y0, 12.8, h); g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(x, y0, 1.2, h); }
    };
    const rust = (x0: number, y0: number, w: number, h: number, n: number) => {
      g.save(); g.beginPath(); g.rect(x0, y0, w, h); g.clip();
      for (let i = 0; i < n; i++) {
        const x = x0 + Math.random() * w, y = y0 + Math.random() * h, r = 8 + Math.random() * 46;
        const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, Math.random() < 0.5 ? `rgba(35,14,6,${Math.random() * 0.4})` : `rgba(196,98,34,${Math.random() * 0.28})`); gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
        if (i % 3 === 0) { const sg = g.createLinearGradient(0, y, 0, y + 90); sg.addColorStop(0, "rgba(30,12,5,0.3)"); sg.addColorStop(1, "rgba(30,12,5,0)"); g.fillStyle = sg; g.fillRect(x, y, 2 + Math.random() * 4, 90); }
      }
      g.restore();
    };
    // side: 16 m across, 64 px per metre. Steel posts every 1.6 m, the door in the middle on its two rails
    planks(0, 0, 1024, 256);
    for (let x = 0; x <= 1024; x += 102.4) { g.fillStyle = "#5f2413"; g.fillRect(x - 5, 0, 10, 256); g.fillStyle = "rgba(255,255,255,0.12)"; g.fillRect(x - 5, 0, 1.5, 256); }
    g.fillStyle = "#73301c"; g.fillRect(400, 14, 224, 228);
    for (let x = 400; x < 624; x += 16) { g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(x, 14, 1.5, 228); }
    g.strokeStyle = "#4f1d0f"; g.lineWidth = 7; g.strokeRect(400, 14, 224, 228);
    g.lineWidth = 5; g.beginPath(); g.moveTo(404, 18); g.lineTo(620, 238); g.moveTo(620, 18); g.lineTo(404, 238); g.stroke();
    g.fillStyle = "#3a332e"; g.fillRect(380, 6, 500, 8); g.fillRect(380, 242, 500, 8); // door rails
    g.fillStyle = "#1f1b18"; g.fillRect(412, 120, 8, 44); g.fillRect(604, 110, 10, 30);
    rust(0, 0, 1024, 256, 90);
    g.fillStyle = "#3b1509"; g.fillRect(0, 0, 1024, 6); g.fillRect(0, 248, 1024, 8);
    g.fillStyle = "rgba(245,240,230,0.88)"; g.textBaseline = "middle"; g.textAlign = "left";
    g.font = "700 40px Inter, -apple-system, sans-serif"; g.fillText("efectivo", 120, 92);
    g.font = "600 17px Menlo, monospace"; g.fillText("EFC 21 51 0154 372-8", 120, 132); g.fillText("Gbs · 25,0 t · 68 m³", 120, 156);
    g.fillText("ZAJEZDNIA · TOR 1", 760, 104);
    g.strokeStyle = "rgba(245,240,230,0.8)"; g.lineWidth = 2; g.strokeRect(752, 120, 150, 54); g.font = "600 14px Menlo, monospace"; g.fillText("REV 11.26", 764, 138); g.fillText("12,6 m", 764, 158);
    // ends: planks, corner posts, a ladder; the roof: tarred sheet with ribs
    for (const x0 of [0, 256]) {
      planks(x0, 256, 256, 256); g.fillStyle = "#5f2413"; g.fillRect(x0, 256, 12, 256); g.fillRect(x0 + 244, 256, 12, 256); g.fillRect(x0 + 122, 256, 12, 256);
      g.fillStyle = "#2a2522"; g.fillRect(x0 + 40, 300, 4, 212); g.fillRect(x0 + 76, 300, 4, 212); for (let y = 320; y < 512; y += 36) g.fillRect(x0 + 40, y, 40, 4);
      rust(x0, 256, 256, 256, 20);
    }
    g.fillStyle = "#4a433d"; g.fillRect(512, 256, 512, 256);
    for (let x = 512; x < 1024; x += 51.2) { g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(x, 256, 4, 256); g.fillStyle = "rgba(255,255,255,0.1)"; g.fillRect(x + 4, 256, 2, 256); }
    rust(512, 256, 512, 256, 30);
    noise(g, 1024, 512, 0.06, 7000);
  });
}

/** Rough sawn planks for the big transport crate: 2 m per tile, eight boards and a batten. */
function plankTexture() {
  return canvasTex(256, 256, (g) => {
    for (let x = 0; x < 256; x += 32) {
      g.fillStyle = `hsl(31,${34 + Math.random() * 10}%,${40 + Math.random() * 10}%)`; g.fillRect(x, 0, 32, 256);
      g.strokeStyle = "rgba(70,40,15,0.22)"; g.lineWidth = 1;
      for (let i = 0; i < 5; i++) { const gx = x + 3 + Math.random() * 26; g.beginPath(); g.moveTo(gx, 0); g.bezierCurveTo(gx + 4, 80, gx - 4, 170, gx, 256); g.stroke(); }
      g.fillStyle = "rgba(0,0,0,0.42)"; g.fillRect(x, 0, 2, 256);
    }
    g.fillStyle = "rgba(60,35,12,0.35)"; g.fillRect(0, 226, 256, 30); g.fillStyle = "rgba(0,0,0,0.4)"; g.fillRect(0, 224, 256, 2);
    g.fillStyle = "rgba(20,20,20,0.6)"; for (let x = 16; x < 256; x += 32) { g.beginPath(); g.arc(x, 241, 2, 0, 6.3); g.fill(); }
    noise(g, 256, 256, 0.07, 2500);
  }, [1, 1]);
}

/** Steel tread plate, 1 m per tile: the mezzanine deck and its cladding. */
function treadTexture() {
  return canvasTex(128, 128, (g) => {
    g.fillStyle = "#5b6470"; g.fillRect(0, 0, 128, 128);
    g.lineWidth = 2.2; g.lineCap = "round";
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const cx = x * 16 + 8, cy = y * 16 + 8, d = (x + y) % 2 ? 4 : -4;
      g.strokeStyle = "rgba(255,255,255,0.2)"; g.beginPath(); g.moveTo(cx - 4, cy - d); g.lineTo(cx + 4, cy + d); g.stroke();
      g.strokeStyle = "rgba(0,0,0,0.28)"; g.beginPath(); g.moveTo(cx - 4, cy - d + 1.5); g.lineTo(cx + 4, cy + d + 1.5); g.stroke();
    }
    g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(0, 0, 128, 2); g.fillRect(0, 0, 2, 128);
    noise(g, 128, 128, 0.06, 900);
  }, [1, 1]);
}

export function cardboardTexture(tint: string, label: boolean) {
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
const tmpE = new THREE.Euler(), DULL = new THREE.Color(0x6b7078);

class Instancer {
  private items: { p: [number, number, number]; s: [number, number, number]; c: number; ry: number; rx: number }[] = [];
  constructor(private geo: THREE.BufferGeometry, private mat: THREE.Material, private shadows = true) {}
  /** `ry` turns the instance about the vertical, `rx` then tilts it (a sloped hand rail, a truss diagonal). */
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, color = 0xffffff, ry = 0, rx = 0) { this.items.push({ p: [x, y, z], s: [sx, sy, sz], c: color, ry, rx }); }
  build(scene: THREE.Object3D) {
    if (!this.items.length) return;
    const m = new THREE.InstancedMesh(this.geo, this.mat, this.items.length);
    this.items.forEach((it, i) => {
      tmpQ.setFromEuler(tmpE.set(it.rx, it.ry, 0, "YXZ"));
      tmpM.compose(tmpP.set(...it.p), tmpQ, tmpS.set(...it.s));
      m.setMatrixAt(i, tmpM);
      m.setColorAt(i, tmpC.setHex(it.c));
    });
    m.castShadow = this.shadows; m.receiveShadow = true;
    scene.add(m);
  }
}

/**
 * Static boxes merged into one mesh, with the texture laid out in metres of the world (`tu` along the wall or the
 * floor, `tv` up), so a tiling texture runs unbroken over boxes of any size and over the joints between them.
 */
class BoxBatch {
  private pos: number[] = []; private nor: number[] = []; private uv: number[] = []; private idx: number[] = [];
  constructor(private tu: number, private tv: number) {}
  private face(c: number[], nx: number, ny: number, nz: number) {
    const i = this.pos.length / 3;
    for (let k = 0; k < 12; k += 3) {
      const x = c[k], y = c[k + 1], z = c[k + 2];
      this.pos.push(x, y, z); this.nor.push(nx, ny, nz);
      if (ny) this.uv.push(x / this.tu, z / this.tu); else this.uv.push((nx ? z : x) / this.tu, y / this.tv);
    }
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, top = true, bottom = false) {
    this.face([x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1], 1, 0, 0);
    this.face([x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], -1, 0, 0);
    this.face([x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], 0, 0, 1);
    this.face([x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0], 0, 0, -1);
    if (top) this.face([x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0], 0, 1, 0);
    if (bottom) this.face([x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1], 0, -1, 0);
  }
  /** A single upright sheet across x at depth z, for a double-sided material. */
  sheet(x0: number, y0: number, x1: number, y1: number, z: number) { this.face([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], 0, 0, 1); }
  build(scene: THREE.Object3D, mat: THREE.Material, cast = false) {
    if (!this.idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; scene.add(m);
  }
}

/** A rectangle of the decal atlas: u0, v0, u1, v1. */
type Region = [number, number, number, number];

/**
 * Everything flat and one-off (wall signs, logos, dock doors, conveyor rollers) is drawn into one 1024 px atlas and
 * laid on the world as quads of a single mesh: one texture and one draw call, however many signs there are.
 */
class Decals {
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private cx = 0; private cy = 0; private rowH = 0;
  private pos: number[] = []; private nor: number[] = []; private uv: number[] = []; private idx: number[] = [];
  constructor(private size = 1024) { this.canvas.width = this.canvas.height = size; this.g = this.canvas.getContext("2d")!; }
  /** Reserve w × h pixels (rows, left to right) and draw into them. */
  region(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): Region {
    const PAD = 4, S = this.size, g = this.g;
    if (this.cx + w > S) { this.cx = 0; this.cy += this.rowH + PAD; this.rowH = 0; }
    if (this.cy + h > S) console.warn("world: the decal atlas is full");
    const x = this.cx, y = this.cy;
    g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(g, w, h); g.restore();
    this.cx += w + PAD; this.rowH = Math.max(this.rowH, h);
    return [(x + 0.5) / S, 1 - (y + h - 0.5) / S, (x + w - 0.5) / S, 1 - (y + 0.5) / S];
  }
  private push(r: Region, p: number[], nx: number, ny: number, nz: number) {
    const i = this.pos.length / 3;
    this.pos.push(...p); for (let k = 0; k < 4; k++) this.nor.push(nx, ny, nz);
    this.uv.push(r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  /** An upright quad centred on (x, y, z), facing +z when `ry` is 0 (the same turn as Object3D.rotation.y). */
  quad(r: Region, x: number, y: number, z: number, w: number, h: number, ry = 0) {
    const c = Math.cos(ry) * w / 2, s = Math.sin(ry) * w / 2;
    this.push(r, [x - c, y - h / 2, z + s, x + c, y - h / 2, z - s, x + c, y + h / 2, z - s, x - c, y + h / 2, z + s], Math.sin(ry), 0, Math.cos(ry));
  }
  /** A quad lying flat, facing up; the texture's u runs along x. */
  flat(r: Region, x: number, y: number, z: number, w: number, d: number) {
    this.push(r, [x - w / 2, y, z + d / 2, x + w / 2, y, z + d / 2, x + w / 2, y, z - d / 2, x - w / 2, y, z - d / 2], 0, 1, 0);
  }
  build(scene: THREE.Object3D) {
    if (!this.idx.length) return;
    const map = new THREE.CanvasTexture(this.canvas); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    // a cut-out, not a blend: no sorting, and it writes depth like any wall. The offset keeps it off the surface behind
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.receiveShadow = true; scene.add(m);
  }
}

/**
 * A unit box (standing on y = 0, long along x) whose faces read different parts of a 1024 × 512 atlas: the long sides
 * the top half, the +x end / the −x end / the roof the three parts of the bottom half (containerTexture, wagonTexture).
 */
function atlasBox(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  // BoxGeometry's faces come in the order +x, −x, +y, −y, +z, −z, four vertices each
  const parts: Region[] = [[0, 0, 0.25, 0.5], [0.25, 0, 0.5, 0.5], [0.5, 0, 1, 0.5], [0.5, 0, 1, 0.5], [0, 0.5, 1, 1], [0, 0.5, 1, 1]];
  for (let i = 0; i < 24; i++) { const r = parts[i >> 2]; uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1])); }
  geo.clearGroups();
  return geo;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const LOAD_TINTS = [0xb9bcc4, 0xb5a98f, 0xa89a80, 0x9aa3c2, 0x8f939b];

export interface WorldHandle {
  update(t: number): void;
  setPickups(active: boolean[]): void;
  /** Everything buildWorld added to the scene. */
  group: THREE.Group;
}

/** Build the current hall configuration (shared/map.ts `useLayout`) with the objects of this shift's mission. */
export function buildWorld(scene: THREE.Scene, mission: Mission): WorldHandle {
  const group = new THREE.Group();
  scene.add(group);

  const depot = layout().kind === "depot";
  const solid = depot ? wallGrid() : null;
  const doors = solid ? findDoors(solid) : [];
  const lampAt = lampSpots(solid);
  const lenX = HALL.x1 - HALL.x0, lenZ = HALL.z1 - HALL.z0, midX = (HALL.x0 + HALL.x1) / 2, midZ = (HALL.z0 + HALL.z1) / 2;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

  // floor and ceiling: the roof sheet is lit from below by the floor's bounce, so it is a dim grey and not a black void
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(lenX, lenZ), new THREE.MeshStandardMaterial({ map: floorTexture(doors, lampAt), roughness: 0.6, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(midX, 0, midZ);
  floor.receiveShadow = true;
  group.add(floor);
  const roofTex = roofTexture(); roofTex.repeat.set((lenX + 2) / 4, (lenZ + 2) / 4);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(lenX + 2, lenZ + 2), new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.85, metalness: 0.1 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(midX, HALL.h + 0.6, midZ);
  group.add(ceil);

  // shared by everything below: painted boxes, things that glow, one atlas for every sign and logo, hazard stripes
  const blocks = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.25 }));
  const glow = new Instancer(unitBox, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), false);
  const decals = new Decals();
  const hazard = new BoxBatch(0.7, 0.7);
  const cardboard = [cardboardTexture("#b58e5c", true), cardboardTexture("#a37b4b", false), cardboardTexture("#c49d6a", true)];
  const loads = cardboard.map((map) => new Instancer(unitBox, new THREE.MeshStandardMaterial({ map, roughness: 0.85 })));
  const FRAME = 0x1b1c20;

  // walls: every wall box in one mesh per finish. Plain walls are painted concrete; the depot's cold store is tinted
  // in the layout, and gets white insulated panels. The texture is laid in metres, so it runs on from box to box.
  const wallH = HALL.h + 1;
  const walls = new BoxBatch(6, wallH), coldWalls = new BoxBatch(6, wallH);
  for (const b of BOXES) if (b.kind === "wall") (b.color !== undefined ? coldWalls : walls).add(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, false);
  // The doorways are cut through the walls up to the roof. A lintel above 4.3 m turns each slot into a gate; it has no
  // collision (nothing in the game flies that high through a doorway on purpose), like everything else hung above 2.5 m.
  const LINTEL = 4.3;
  for (const d of doors) {
    const cx = (d.x0 + d.x1) / 2, cz = (d.z0 + d.z1) / 2, px = d.alongZ ? d.x0 - 0.5 : cx, pz = d.alongZ ? cz : d.z0 - 0.5;
    const cold = BOXES.some((b) => b.kind === "wall" && b.color !== undefined && px > b.x0 && px < b.x1 && pz > b.z0 && pz < b.z1);
    (cold ? coldWalls : walls).add(d.x0, LINTEL, d.z0, d.x1, wallH, d.z1, false, true);
    // a yellow/black edge on both faces of the wall: up the jambs (where the wall is flush there) and under the lintel
    const T = 0.02, S = 0.3;
    for (const s of [-1, 1]) {
      const f = s < 0 ? (d.alongZ ? d.z0 : d.x0) : (d.alongZ ? d.z1 : d.x1), a = Math.min(f, f + s * T), b = Math.max(f, f + s * T);
      const flush = (m: number) => d.alongZ ? solid!(m, f - s * 0.5) && !solid!(m, f + s * 0.5) : solid!(f - s * 0.5, m) && !solid!(f + s * 0.5, m);
      if (d.alongZ) {
        if (flush(d.x0 - 0.5)) hazard.add(d.x0 - S, 0, a, d.x0, LINTEL + S, b, false);
        if (flush(d.x1 + 0.5)) hazard.add(d.x1, 0, a, d.x1 + S, LINTEL + S, b, false);
        hazard.add(d.x0, LINTEL, a, d.x1, LINTEL + S, b, false);
      } else {
        if (flush(d.z0 - 0.5)) hazard.add(a, 0, d.z0 - S, b, LINTEL + S, d.z0, false);
        if (flush(d.z1 + 0.5)) hazard.add(a, 0, d.z1, b, LINTEL + S, d.z1 + S, false);
        hazard.add(a, LINTEL, d.z0, b, LINTEL + S, d.z1, false);
      }
    }
  }
  walls.build(group, new THREE.MeshStandardMaterial({ map: wallTexture(false), roughness: 0.85, metalness: 0 }));
  // tinted down a little: the white panels sit next to the lamps and were close to clipping
  if (depot) coldWalls.build(group, new THREE.MeshStandardMaterial({ map: wallTexture(true), color: 0xd9dfe6, roughness: 0.4, metalness: 0.15 }));
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe5b50a, roughness: 0.6 });

  // dock doors: a sectional door in a dark frame, its number, a signal lamp and two rubber bumpers. `ry` is the way the
  // door faces (as Object3D.rotation.y), `back` how far the frame stands off the wall behind the door's face.
  let doorArt: Region | undefined;
  const dockDoor = (x: number, z: number, ry: number, no: number, back: number) => {
    doorArt ??= decals.region(252, 200, (g, w, h) => {
      g.fillStyle = "#c9ccd2"; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 25) { g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(0, y, w, 2); g.fillStyle = "rgba(255,255,255,0.4)"; g.fillRect(0, y + 2, w, 1.5); g.fillStyle = "rgba(0,0,0,0.05)"; for (let k = 8; k < 25; k += 6) g.fillRect(0, y + k, w, 1); }
      g.fillStyle = "#1c2733"; for (let wx = 26; wx < w - 40; wx += 56) g.fillRect(wx, 56, 36, 14); // a row of windows
      g.fillStyle = "#e5b50a"; g.fillRect(0, h - 10, w, 10); g.fillStyle = "#111"; for (let k = 0; k < w; k += 20) g.fillRect(k, h - 10, 10, 10);
    });
    const nx = Math.sin(ry), nz = Math.cos(ry), rx = Math.cos(ry), rz = -Math.sin(ry);
    // an axis-aligned slab: `off` along the door, `d` out of the wall, w × hgt × t
    const slab = (off: number, d: number, y: number, w: number, hgt: number, t: number, color: number) => blocks.add(x + rx * off + nx * d, y, z + rz * off + nz * d, Math.abs(rx) * w + Math.abs(nx) * t, hgt, Math.abs(rz) * w + Math.abs(nz) * t, color);
    slab(0, -back / 2, 0, 3.7, 4.05, back, FRAME);
    decals.quad(doorArt, x + nx * 0.012, 1.9, z + nz * 0.012, 3.2, 3.8, ry);
    const tag = decals.region(124, 44, (g, w, h) => { g.fillStyle = "#0c0d10"; g.fillRect(0, 0, w, h); g.fillStyle = "#f5f5f7"; g.font = "700 34px Inter, -apple-system, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(`D${no}`, w / 2, h / 2 + 2); });
    decals.quad(tag, x + nx * 0.012, 4.55, z + nz * 0.012, 1.25, 0.44, ry);
    glow.add(x + rx * 0.95 + nx * 0.03, 4.47, z + rz * 0.95 + nz * 0.03, 0.16, 0.16, 0.16, no % 2 ? 0xff4d4d : 0x2ee08a);
    for (const off of [-1.5, 1.5]) slab(off, 0.1, 0.3, 0.25, 0.5, 0.2, 0x222326);
  };
  layout().docks.forEach((z, i) => dockDoor(HALL.x1 - 0.16, z, -Math.PI / 2, i + 1, 0.16));

  // blocks: the depot's containers, wagon, crane, conveyors, mezzanine and truck come from the layout as painted boxes.
  // They are recognised by paint and size and dressed up; what is not recognised stays a plain painted box.
  if (depot) {
    const glass = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.9 }), false);
    // wheels roll about x until turned: 1 m across and 1 m wide before scaling
    const wheels = new Instancer(new THREE.CylinderGeometry(0.5, 0.5, 1, 20).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.25 }));
    const boxGeo = atlasBox();
    const containers = new Instancer(boxGeo, new THREE.MeshStandardMaterial({ map: containerTexture(), roughness: 0.55, metalness: 0.3 }));
    const metal = new BoxBatch(1, 1), wood = new BoxBatch(2, 2);
    // weathered paint: the layout's pure colours come out neon under the brighter light, so pull them a third of the way to grey
    const dull = (c: number) => tmpC.setHex(c).lerp(DULL, 0.3).getHex();
    const PAINT = [0x1d4ed8, 0xc2410c, 0x15803d, 0xb91c1c, 0x0e7490], YELLOW = 0xf2c200, UNDER = 0x121316;
    const logo = (fg: string, line: string, sub: string) => (g: CanvasRenderingContext2D, w: number, h: number) => {
      g.fillStyle = fg; g.textAlign = "left"; g.textBaseline = "middle";
      g.font = `700 ${Math.round(h * 0.6)}px Inter, -apple-system, sans-serif`; g.fillText("efectivo", 6, h * 0.36, w * 0.66);
      g.font = `600 ${Math.round(h * 0.2)}px Menlo, monospace`; g.fillText(sub, 8, h * 0.84, w - 16);
      g.fillStyle = line; g.fillRect(8, h * 0.68, w * 0.62, h * 0.045);
    };
    const logoLight = decals.region(504, 120, logo("#f5f5f7", "#f5f5f7", "EFCU 482915 7 · 22G1 · MAX 30 480 KG"));
    const logoDark = decals.region(504, 120, logo("#15161a", "#474fff", "LOGISTYKA · GEO · CZAS PRACY"));
    const rollers = decals.region(60, 60, (g, w, h) => {
      g.fillStyle = "#2a2d32"; g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 20) { const gr = g.createLinearGradient(x + 2, 0, x + 18, 0); gr.addColorStop(0, "#565c66"); gr.addColorStop(0.4, "#d5dae2"); gr.addColorStop(1, "#4a4f58"); g.fillStyle = gr; g.fillRect(x + 2, 3, 16, h - 6); }
    });
    const extSign = decals.region(60, 60, (g, w, h) => {
      g.fillStyle = "#d01f1f"; g.fillRect(0, 0, w, h); g.strokeStyle = "#fff"; g.lineWidth = 3; g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = "#fff"; g.fillRect(24, 22, 14, 28); g.fillRect(28, 14, 6, 8); g.fillRect(34, 14, 12, 4); g.fillRect(44, 14, 3, 12);
    });
    const plain = (b: (typeof BOXES)[number], c: number) => blocks.add((b.x0 + b.x1) / 2, b.y0, (b.z0 + b.z1) / 2, b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0, c);
    // a yellow hand rail from (x0, z0) to (x1, z1) at deck height y: posts, a top rail and a knee rail. Thin, no collision
    const rail = (x0: number, z0: number, x1: number, z1: number, y: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 2)), ax = x1 !== x0;
      for (let i = 0; i <= n; i++) blocks.add(x0 + (x1 - x0) * i / n, y, z0 + (z1 - z0) * i / n, 0.05, 1.05, 0.05, YELLOW);
      for (const dy of [0.55, 1.03]) blocks.add((x0 + x1) / 2, y + dy, (z0 + z1) / 2, ax ? len : 0.04, 0.05, ax ? 0.04 : len, YELLOW);
    };
    const steps = BOXES.filter((b) => b.kind === "block" && b.color === YELLOW && b.y0 === 0 && b.y1 < 3);
    let dockNo = 0;

    for (const b of BOXES) {
      if (b.kind !== "block") continue;
      const sx = b.x1 - b.x0, sz = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, c = b.color ?? 0x94a3b8;
      const h = b.y1 - b.y0, long = Math.max(sx, sz), short = Math.min(sx, sz), alongX = sx >= sz, grounded = b.y0 === 0;
      if (grounded && near(short, 2.6) && near(long, 12) && (near(h, 2.6) || near(h, 5.2))) {
        // a 40 ft container, or two stacked (the upper one in another paint): corrugated sides, doors, a logo and an ID
        for (let l = 0; l * 2.6 < h - 0.1; l++) {
          containers.add(cx, l * 2.6, cz, 12, 2.6, 2.6, dull(l ? PAINT[(PAINT.indexOf(c) + 7) % 5] : c), alongX ? 0 : Math.PI / 2);
          const y = l * 2.6 + 1.5;
          if (alongX) { decals.quad(logoLight, cx + 2.4, y, b.z1 + 0.012, 5, 1.19, 0); decals.quad(logoLight, cx - 2.4, y, b.z0 - 0.012, 5, 1.19, Math.PI); }
          else { decals.quad(logoLight, b.x1 + 0.012, y, cz - 2.4, 5, 1.19, Math.PI / 2); decals.quad(logoLight, b.x0 - 0.012, y, cz + 2.4, 5, 1.19, -Math.PI / 2); }
        }
      } else if (grounded && c === 0x7c2d12 && alongX) {
        // the goods wagon. Its box is solid down to the floor, so the space under the body is filled with a dark,
        // slightly narrower mass (it reads as shadow) with the wheels and bogie frames on its faces.
        const FLOOR = 1.05, half = sz / 2 - 0.35;
        const body = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ map: wagonTexture(), roughness: 0.8, metalness: 0.15 }));
        body.position.set(cx, FLOOR, cz); body.scale.set(sx, h - FLOOR, sz); body.castShadow = body.receiveShadow = true; group.add(body);
        blocks.add(cx, FLOOR - 0.2, cz, sx, 0.2, sz - 0.1, 0x1f1a17);
        blocks.add(cx, 0, cz, sx - 0.8, FLOOR - 0.2, half * 2, UNDER);
        for (const bx of [b.x0 + 2.7, b.x1 - 2.7]) for (const s of [-1, 1]) {
          for (const dx of [-0.9, 0.9]) {
            wheels.add(bx + dx, 0.46, cz + s * (half + 0.07), 0.14, 0.92, 0.92, 0x2e3035, Math.PI / 2);
            wheels.add(bx + dx, 0.46, cz + s * (half + 0.08), 0.16, 0.3, 0.3, 0x7a808a, Math.PI / 2);
          }
          blocks.add(bx, 0.36, cz + s * (half + 0.17), 2.7, 0.2, 0.06, 0x2a2b30);
        }
      } else if (grounded && c === 0xa37b4b) {
        // the big transport crate: sawn planks and stencils
        wood.add(b.x0, 0, b.z0, b.x1, b.y1, b.z1);
        const art = decals.region(252, 124, (g, w, h2) => {
          g.fillStyle = "rgba(24,18,12,0.9)"; g.textAlign = "left"; g.textBaseline = "middle";
          g.font = "700 46px Inter, -apple-system, sans-serif"; g.fillText("efectivo", 4, 30, 170);
          g.font = "600 17px Menlo, monospace"; g.fillText("STREFA A · 25 000 kg", 6, 72); g.fillText("NIE PIĘTROWAĆ", 6, 98);
          for (const ax of [196, 226]) { g.beginPath(); g.moveTo(ax, 8); g.lineTo(ax + 13, 30); g.lineTo(ax + 5, 30); g.lineTo(ax + 5, 60); g.lineTo(ax - 5, 60); g.lineTo(ax - 5, 30); g.lineTo(ax - 13, 30); g.closePath(); g.fill(); }
          g.fillRect(180, 66, 62, 5);
        });
        const y = h * 0.55, w = Math.min(5.6, short * 0.6);
        decals.quad(art, cx, y, b.z1 + 0.012, w, w * 0.49, 0); decals.quad(art, cx, y, b.z0 - 0.012, w, w * 0.49, Math.PI);
        decals.quad(art, b.x1 + 0.012, y, cz, w, w * 0.49, Math.PI / 2); decals.quad(art, b.x0 - 0.012, y, cz, w, w * 0.49, -Math.PI / 2);
      } else if (grounded && c === 0xe5e7eb && long > 10 && !alongX) {
        // the truck's trailer, cab toward −z: box body on a chassis, a side skirt between the axles, three axles' worth
        // of wheels on each side (two under the back, two of the tractor under the front), mud flaps, marker lights
        const DECK = 1.15, R = 0.52;
        blocks.add(cx, DECK, cz, sx, h - DECK, sz, c);
        blocks.add(cx, DECK - 0.14, cz, sx - 0.06, 0.14, sz, 0x2a2c31);
        blocks.add(cx, 0, cz, sx - 0.8, DECK - 0.14, sz - 0.1, UNDER);
        for (const s of [-1, 1]) {
          const fx = s < 0 ? b.x0 : b.x1, wx = fx - s * 0.2;
          for (const wz of [b.z0 + 1.0, b.z0 + 2.35, b.z1 - 3.05, b.z1 - 1.7]) { wheels.add(wx, R, wz, 0.36, R * 2, R * 2, 0x101113); wheels.add(wx + s * 0.01, R, wz, 0.36, R * 0.95, R * 0.95, 0x9aa0a8); }
          blocks.add(fx - s * 0.04, 0.4, (b.z0 + 3.3 + b.z1 - 4.0) / 2, 0.05, DECK - 0.5, b.z1 - b.z0 - 7.3, 0xd3d6db);
          blocks.add(wx, 0.14, b.z1 - 0.95, 0.36, 0.62, 0.03, 0x0d0d0e);
          for (let mz = b.z0 + 0.8; mz < b.z1; mz += 2.4) glow.add(fx + s * 0.005, DECK + 0.04, mz, 0.02, 0.05, 0.16, 0xff8a1f);
          decals.quad(logoDark, fx + s * 0.012, DECK + (h - DECK) * 0.56, cz, 6.2, 1.48, s * Math.PI / 2);
        }
      } else if (grounded && c === 0x474fff && !alongX) {
        // the cab: windscreen and side windows, grille, bumper, headlights, a roof fairing, the front wheels in arches
        const SILL = 0.55, R = 0.5, wz = b.z0 + 1.35;
        blocks.add(cx, SILL, cz, sx, h - SILL, sz, c);
        blocks.add(cx, 0, cz, sx - 0.8, SILL, sz - 0.1, UNDER);
        blocks.add(cx, 0.2, b.z0 + 0.08, sx + 0.04, 0.32, 0.2, FRAME);
        blocks.add(cx, 0.72, b.z0 - 0.01, 1.3, 0.85, 0.03, 0x15161a);
        blocks.add(cx, h - 0.34, b.z0 - 0.07, sx - 0.16, 0.1, 0.18, 0x15161a);
        blocks.add(cx, h, cz + 0.5, sx - 0.3, 0.55, sz - 1.4, c); // above the box: no collision, well over head height
        glass.add(cx, 1.62, b.z0 - 0.012, sx - 0.3, 0.88, 0.03, 0x0d1626);
        for (const s of [-1, 1]) {
          const fx = s < 0 ? b.x0 : b.x1;
          glass.add(fx + s * 0.012, 1.7, b.z0 + 0.8, 0.03, 0.75, 1.05, 0x0d1626);
          glow.add(fx - s * 0.36, 0.74, b.z0 - 0.02, 0.42, 0.17, 0.04, 0xfff0c8);
          blocks.add(fx + s * 0.006, SILL, wz, 0.02, 0.62, 1.3, 0x0d0d0e);
          wheels.add(fx - s * 0.15, R, wz, 0.36, R * 2, R * 2, 0x101113); wheels.add(fx - s * 0.14, R, wz, 0.36, R * 0.95, R * 0.95, 0x9aa0a8);
        }
      } else if (grounded && c === 0x6b7280 && h < 1 && long >= 10 && alongX) {
        // a roller conveyor: closed sides (it is solid), side rails, legs, end stops, rollers and a few parcels on top
        plain(b, 0x565c66);
        for (const z of [b.z0 + 0.03, b.z1 - 0.03]) blocks.add(cx, h - 0.1, z, sx - 0.02, 0.16, 0.08, 0x30343a); // 1 cm proud of the body, so the faces do not fight
        for (let x = b.x0 + 0.6; x < b.x1; x += 2.4) blocks.add(x, 0, cz, 0.12, h - 0.1, sz + 0.05, 0x2a2d32);
        for (const x of [b.x0 + 0.02, b.x1 - 0.02]) blocks.add(x, 0, cz, 0.06, h + 0.08, sz + 0.06, YELLOW);
        for (let x = b.x0 + 0.3; x < b.x1 - 0.06; x += 0.48) decals.flat(rollers, x, h + 0.004, cz, 0.48, sz - 0.2);
        for (let x = b.x0 + 1 + Math.random(); x < b.x1 - 0.8; x += 1.5 + Math.random() * 1.6) pick(loads).add(x, h + 0.01, cz + (Math.random() - 0.5) * 0.2, 0.36 + Math.random() * 0.26, 0.18 + Math.random() * 0.24, 0.3 + Math.random() * 0.22, 0xffffff, (Math.random() - 0.5) * 0.5);
      } else if (grounded && c === 0x9ca3af && h < 1) {
        // a concrete track barrier with a painted top
        plain(b, c); hazard.add(b.x0 - 0.01, h - 0.16, b.z0 - 0.01, b.x1 + 0.01, h + 0.01, b.z1 + 0.01);
      } else if (grounded && c === 0x4b5563 && long >= 20) {
        // the mezzanine: tread plate, a striped edge, and hand rails wherever no stair lands on the deck
        metal.add(b.x0, 0, b.z0, b.x1, b.y1, b.z1);
        hazard.add(b.x0 - 0.012, b.y1 - 0.22, b.z0 - 0.012, b.x1 + 0.012, b.y1 + 0.004, b.z1 + 0.012, false);
        const mine = steps.filter((st) => near(st.z0, b.z1) && st.x0 >= b.x0 - 0.01 && st.x1 <= b.x1 + 0.01);
        let from = b.x0;
        for (const st of mine.sort((p, q) => p.x0 - q.x0)) { if (st.x0 - from > 0.5) rail(from, b.z1 - 0.04, st.x0, b.z1 - 0.04, b.y1); from = st.x1; }
        if (b.x1 - from > 0.5) rail(from, b.z1 - 0.04, b.x1, b.z1 - 0.04, b.y1);
        rail(b.x0 + 0.04, b.z0, b.x0 + 0.04, b.z1, b.y1); rail(b.x1 - 0.04, b.z0, b.x1 - 0.04, b.z1, b.y1);
        // a sloped rail down each side of a flight: from the deck to the end of the lowest step
        for (const top of mine) {
          const flight = steps.filter((st) => near(st.x0, top.x0) && near(st.x1, top.x1) && st.z0 >= b.z1 - 0.01);
          const zEnd = Math.max(...flight.map((st) => st.z1)), yEnd = Math.min(...flight.map((st) => st.y1));
          const run = zEnd - b.z1, drop = b.y1 - yEnd, len = Math.hypot(run, drop), tilt = Math.atan2(run, -drop);
          for (const x of [top.x0 + 0.04, top.x1 - 0.04]) {
            for (const dy of [0.55, 1.03]) blocks.add(x, b.y1 + dy, b.z1, 0.05, len, 0.05, YELLOW, 0, tilt);
            for (let i = 1; i <= 3; i++) blocks.add(x, b.y1 - drop * i / 3, b.z1 + run * i / 3, 0.05, 1.05, 0.05, YELLOW);
          }
        }
      } else if (grounded && c === 0xc9ccd2 && short < 0.3 && alongX) {
        // a dock door on the south or the north wall, facing into the building
        const south = cz > midZ;
        dockDoor(cx, south ? b.z0 : b.z1, south ? Math.PI : 0, ++dockNo, sz);
      } else if (c === YELLOW && h >= 6) {
        // a leg of the gantry crane: a striped guard at the bottom, a dark foot
        plain(b, c); hazard.add(b.x0 - 0.015, 0, b.z0 - 0.015, b.x1 + 0.015, 1.1, b.z1 + 0.015, false);
        blocks.add(cx, 0, cz, sx + 0.3, 0.12, sz + 0.3, 0x2a2c31);
      } else if (c === YELLOW && b.y0 > 5) {
        // the crane's beam: hazard stripes along its lower edge and underneath, the rating on both faces
        plain(b, c); hazard.add(b.x0 - 0.012, b.y0 - 0.012, b.z0 + 0.02, b.x1 + 0.012, b.y0 + 0.28, b.z1 - 0.02, false, true);
        const art = decals.region(252, 60, (g, w, h2) => { g.fillStyle = "#15161a"; g.textAlign = "center"; g.textBaseline = "middle"; g.font = "700 42px Inter, -apple-system, sans-serif"; g.fillText("efectivo · Q 10 t", w / 2, h2 / 2 + 2, w - 8); });
        for (const along of [0.25, 0.75]) {
          const z = b.z0 + sz * along;
          decals.quad(art, b.x1 + 0.014, b.y0 + 0.54, z, 1.9, 0.45, Math.PI / 2); decals.quad(art, b.x0 - 0.014, b.y0 + 0.54, z, 1.9, 0.45, -Math.PI / 2);
        }
      } else if (c === 0x1f2937 && b.y0 > 4) {
        // the hoist: two cables, the hook block and the hook, all above 2.5 m
        plain(b, c);
        for (const dz of [-0.14, 0.14]) blocks.add(cx, b.y0 - 1.4, cz + dz, 0.035, 1.4, 0.035, 0x0e0f11);
        blocks.add(cx, b.y0 - 1.85, cz, 0.3, 0.45, 0.5, YELLOW);
        blocks.add(cx, b.y0 - 2.1, cz, 0.08, 0.25, 0.08, 0x202226);
        blocks.add(cx, b.y0 - 2.18, cz + 0.11, 0.08, 0.08, 0.3, 0x202226);
        blocks.add(cx, b.y0 - 2.18, cz + 0.22, 0.08, 0.26, 0.08, 0x202226);
      } else plain(b, c);
    }

    // every room: its name on the north and the south wall, a fire extinguisher, a cable tray and a sprinkler main
    // under the roof. Signs and extinguishers sit flat on the wall; trays and pipes are above 6 m.
    const pipes = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.5 }), false);
    const wallRun = (xa: number, xb: number, z: number) => { for (let x = xa; x <= xb; x += 1) if (!solid!(x, z)) return false; return true; };
    for (const zn of ZONES) {
      const text = /^[AB] ·/.test(zn.name) ? `STREFA ${zn.name}` : zn.name, mid = (zn.x0 + zn.x1) / 2, wide = zn.x1 - zn.x0;
      const art = decals.region(504, 88, (g, w, h) => {
        g.fillStyle = "#14161a"; g.fillRect(0, 0, w, h); g.fillStyle = zn.color; g.fillRect(0, 0, 24, h); g.fillRect(0, h - 7, w, 7);
        g.fillStyle = "#f5f5f7"; g.font = "700 46px Inter, -apple-system, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(text, 44, h / 2 - 2, w - 60);
      });
      for (const [behind, face, ry] of [[zn.z0 - 0.5, zn.z0 + 0.012, 0], [zn.z1 + 0.5, zn.z1 - 0.012, Math.PI]]) {
        for (const off of [0, -7, 7, -14, 14]) {
          const x = mid + off;
          if (x - 4 < zn.x0 || x + 4 > zn.x1 || !wallRun(x - 3.6, x + 3.6, behind)) continue;
          decals.quad(art, x, 5.6, face, 7, 1.22, ry); break;
        }
      }
      for (const x of [zn.x0 + 2.4, zn.x1 - 2.4]) {
        if (!wallRun(x - 0.6, x + 0.6, zn.z0 - 0.5) || BOXES.some((b) => b.kind !== "wall" && x + 0.7 > b.x0 && x - 0.7 < b.x1 && zn.z0 + 0.9 > b.z0 && zn.z0 < b.z1)) continue;
        blocks.add(x, 0.75, zn.z0 + 0.1, 0.17, 0.5, 0.17, 0xd01f1f); blocks.add(x, 1.25, zn.z0 + 0.1, 0.06, 0.1, 0.06, 0x111214);
        decals.quad(extSign, x, 1.95, zn.z0 + 0.012, 0.36, 0.36, 0); break;
      }
      pipes.add(mid, 6.9, zn.z0 + 0.24, wide - 0.4, 0.07, 0.4, 0x4d525b);
      pipes.add(mid, 6.3, zn.z1 - 0.14, wide - 0.4, 0.1, 0.1, 0xb23a2e);
    }

    containers.build(group); wheels.build(group); glass.build(group); pipes.build(group);
    metal.build(group, new THREE.MeshStandardMaterial({ map: treadTexture(), roughness: 0.5, metalness: 0.6 }), true);
    wood.build(group, new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.9 }), true);
  } else {
    for (const b of BOXES) if (b.kind === "block") blocks.add((b.x0 + b.x1) / 2, b.y0, (b.z0 + b.z1) / 2, b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0, b.color ?? 0x94a3b8);
  }

  // under the roof: lattice trusses (two chords and a zigzag of diagonals, all one instanced mesh), lamp strips on
  // hangers with a soft glow around each, and strips of skylight between the trusses
  const truss = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.5 }), false);
  const TRUSS = 0x3d4048, pitch = depot ? 2 : 4, rise = 0.6, diag = Math.hypot(pitch, rise), lean = Math.atan2(pitch, rise);
  for (let x = HALL.x0 + 5; x < HALL.x1; x += 13) {
    truss.add(x, HALL.h - 0.28, midZ, 0.22, 0.14, lenZ, TRUSS); truss.add(x, HALL.h + 0.4, midZ, 0.22, 0.14, lenZ, TRUSS);
    for (let z = HALL.z0; z + 2 * pitch <= HALL.z1 + 0.01; z += 2 * pitch) {
      truss.add(x, HALL.h - 0.2, z, 0.09, diag, 0.09, TRUSS, 0, lean); truss.add(x, HALL.h - 0.2, z + 2 * pitch, 0.09, diag, 0.09, TRUSS, 0, -lean);
    }
  }
  const halos = new Instancer(unitBox, new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }), false);
  for (const [x, z] of lampAt) {
    truss.add(x, HALL.h - 0.16, z, 2.8, 0.12, 0.42, 0x1a1b1f);
    for (const dx of [-1.2, 1.2]) truss.add(x + dx, HALL.h - 0.05, z, 0.03, 0.62, 0.03, 0x1a1b1f);
    glow.add(x, HALL.h - 0.19, z, 2.6, 0.03, 0.3, 0xf6f7ff);
    halos.add(x, HALL.h - 0.215, z, 6.5, 0.004, 3.2, 0xfff0d2);
  }
  for (let x = HALL.x0 + 11.5; x < HALL.x1; x += 26) for (let z = HALL.z0 + 12; z < HALL.z1 - 6; z += depot ? 24 : 36) {
    if (solid && (solid(x, z) || solid(x, z - 4.4) || solid(x, z + 4.4))) continue;
    glow.add(x, HALL.h + 0.57, z, 1.6, 0.02, 9, 0xa9c2d8);
  }
  truss.build(group); halos.build(group);

  // racks: uprights, beams, a mesh back, pallets and loads on every level
  const rackUp = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 }));
  const beams = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 }));
  const palletMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const pallets = new Instancer(unitBox, palletMat);
  const wrapped = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.85 }));
  // the wire mesh between the two halves of every rack: one merged, double-sided sheet with 1.2 m to a tile
  const meshBacks = new BoxBatch(1.2, 1.2);
  const LEVELS = [0, 1.85, 3.7, 5.55, 7.4];
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.7, metalness: 0.4 });
  const loadOn = (x: number, y: number, z: number, maxH: number, ry = 0) => {
    pallets.add(x, y, z, 1.2, 0.14, 1.0, 0xb08a5c, ry);
    const r = Math.random();
    if (r < 0.1) return;
    const h = Math.min(maxH, 0.7 + Math.random() * 0.75);
    if (r < 0.35) wrapped.add(x, y + 0.14, z, 1.14, h, 0.96, pick(LOAD_TINTS), ry);
    else pick(loads).add(x, y + 0.14, z, 1.1, h, 0.94, 0xffffff, ry);
  };
  // the racks hold tens of thousands of loads: one wide load per bay side and level, drawn without casting shadows
  const rackPallets = new Instancer(unitBox, palletMat, false);
  const rackLoads = cardboard.map((map) => new Instancer(unitBox, new THREE.MeshStandardMaterial({ map, roughness: 0.85 }), false));
  const rackWrapped = new Instancer(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.85 }), false);
  const rackLoad = (x: number, y: number, z: number, w: number) => {
    rackPallets.add(x, y, z, w, 0.14, 1.0, 0xb08a5c);
    const r = Math.random();
    if (r < 0.12) return;
    const h = 0.7 + Math.random() * 0.75;
    if (r < 0.35) rackWrapped.add(x, y + 0.14, z, w - 0.06, h, 0.96, pick(LOAD_TINTS));
    else pick(rackLoads).add(x, y + 0.14, z, w - 0.1, h, 0.94);
  };
  for (const b of BOXES) {
    if (b.kind !== "rack") continue;
    const len = b.x1 - b.x0, bays = Math.max(1, Math.round(len / 2.7)), bay = len / bays;
    for (let i = 0; i <= bays; i++) {
      const x = b.x0 + i * bay;
      for (const z of [b.z0 + 0.05, b.z1 - 0.05, (b.z0 + b.z1) / 2 - 0.12, (b.z0 + b.z1) / 2 + 0.12]) rackUp.add(x, 0, z, 0.1, b.y1, 0.1, 0x2b4fd6);
    }
    const levels = LEVELS.filter((y) => y < b.y1 - 1.4);
    for (const y of levels.slice(1).concat([b.y1 - 0.1])) {
      for (const z of [b.z0 + 0.05, b.z1 - 0.05]) beams.add((b.x0 + b.x1) / 2, y - 0.14, z, len, 0.14, 0.07, 0xff6b1a);
    }
    meshBacks.sheet(b.x0, 0, b.x1, b.y1, (b.z0 + b.z1) / 2);
    for (let i = 0; i < bays; i++) {
      for (const y of levels) {
        for (const side of [-1, 1]) rackLoad(b.x0 + (i + 0.5) * bay, y + (y ? 0 : 0.02), (b.z0 + b.z1) / 2 + side * 0.6, bay - 0.3);
      }
    }
  }

  // perches: a deck with a yellow kick rail on the climbable racks, and their ladders
  for (const b of BOXES) {
    if (!b.climb) continue;
    const len = b.x1 - b.x0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, b.z1 - b.z0), deckMat); deck.position.set(cx, b.y1 - 0.03, cz); deck.receiveShadow = true; group.add(deck);
    for (const z of [b.z0 + 0.04, b.z1 - 0.04]) beams.add(cx, b.y1, z, len, 0.14, 0.05, 0xf2c200);
  }
  for (const l of LADDERS) {
    const x = l.dx > 0 ? l.x1 - 0.1 : l.x0 + 0.1, cz = (l.z0 + l.z1) / 2;
    for (const z of [cz - 0.26, cz + 0.26]) beams.add(x, 0, z, 0.06, l.top + 1.0, 0.06, 0xf2c200);
    for (let y = 0.3; y < l.top; y += 0.3) beams.add(x, y, cz, 0.04, 0.04, 0.5, 0xf2c200);
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
  const TABLE_TOP = 0xd8c7a6, STEEL = 0x8c9099;
  const rolls = new Instancer(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 16).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8b48a }), false);
  const screenMat = new THREE.MeshBasicMaterial({ map: canvasTex(256, 160, (g) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, 256, 160);
    g.fillStyle = "#1d1d1f"; g.fillRect(10, 10, 236, 140);
    g.strokeStyle = "#474fff"; g.lineWidth = 3; g.strokeRect(30, 30, 120, 90);
    for (let i = 0; i < 6; i++) { g.fillStyle = ["#3B82F6", "#8B5CF6", "#10B981", "#6366F1"][i % 4]; g.fillRect(40 + i * 17, 60 + (i % 3) * 14, 10, 10); }
    g.fillStyle = "#f5f5f7"; g.font = "600 14px Menlo, monospace"; g.fillText("efectivo", 165, 45);
    g.fillStyle = "#6EE7B7"; g.fillText("● LIVE", 165, 70);
  }) });
  const screens = new Instancer(unitBox, screenMat, false);
  for (const b of BOXES) {
    if (b.kind !== "table") continue;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, sx = b.x1 - b.x0, sz = b.z1 - b.z0;
    blocks.add(cx, b.y1 - 0.05, cz, sx, 0.05, sz, TABLE_TOP);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) blocks.add(cx + dx * (sx / 2 - 0.08), 0, cz + dz * (sz / 2 - 0.08), 0.06, b.y1 - 0.05, 0.06, STEEL);
    blocks.add(cx, 0.235, cz, sx - 0.1, 0.03, sz - 0.1, STEEL);
    screens.add(cx - 0.6, b.y1 + 0.125, cz - 0.35, 0.55, 0.35, 0.03);
    blocks.add(cx - 0.6, b.y1, cz - 0.37, 0.04, 0.2, 0.04, STEEL);
    pick(loads).add(cx + 0.5, b.y1, cz + 0.1, 0.5, 0.35, 0.4);
    pick(loads).add(cx + 0.2, b.y1, cz - 0.2, 0.35, 0.25, 0.3);
    rolls.add(cx - 0.1, b.y1 + 0.12, cz + 0.35, 1, 1, 1);
  }
  screens.build(group); rolls.build(group);

  // columns with a striped guard at the bottom
  for (const b of BOXES) {
    if (b.kind !== "column") continue;
    blocks.add((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2, b.x1 - b.x0, b.y1, b.z1 - b.z0, 0x5d6068);
    hazard.add(b.x0 - 0.03, 0, b.z0 - 0.03, b.x1 + 0.03, 1.2, b.z1 + 0.03);
  }

  // drums: one instanced barrel in three paints, the warning triangle from the decal atlas
  const drums = new Instancer(new THREE.CylinderGeometry(0.29, 0.29, 0.94, 20).translate(0, 0.47, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.5 }));
  const DRUM_PAINT = [0x2546c9, 0x1f6f4a, 0x9b1c1c];
  let warnSign: Region | undefined, di = 0;
  for (const b of BOXES) {
    if (b.kind !== "drum") continue;
    warnSign ??= decals.region(60, 60, (g, w, h) => {
      g.fillStyle = "#e5b50a"; g.beginPath(); g.moveTo(w / 2, 3); g.lineTo(w - 3, h - 6); g.lineTo(3, h - 6); g.closePath(); g.fill();
      g.fillStyle = "#111"; g.font = "700 32px Inter, sans-serif"; g.textAlign = "center"; g.textBaseline = "alphabetic"; g.fillText("!", w / 2, h - 12);
    });
    const x = (b.x0 + b.x1) / 2, z = (b.z0 + b.z1) / 2;
    drums.add(x, 0, z, 1, 1, 1, DRUM_PAINT[di++ % DRUM_PAINT.length]);
    decals.quad(warnSign, x, 0.55, z + 0.295, 0.28, 0.28);
  }
  drums.build(group);

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

  // partition walls: the wall finish on a low panel, with a yellow cap
  const panels = new BoxBatch(6, wallH);
  for (const b of BOXES) {
    if (b.kind !== "panel") continue;
    const sx = b.x1 - b.x0, sz = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    panels.add(b.x0, 0, b.z0, b.x1, b.y1, b.z1);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.02, 0.12, sz + 0.06), lineMat); cap.position.set(cx, b.y1 + 0.06, cz); group.add(cap);
  }
  panels.build(group, new THREE.MeshStandardMaterial({ map: wallTexture(false), color: 0xe4e8ee, roughness: 0.8, metalness: 0 }), true);

  // the local server: a black cabinet with efectivo-blue status lights, on a marked pad
  const blink: THREE.Mesh[] = [];
  const accentMat = new THREE.MeshBasicMaterial({ color: ACCENT });
  const ring = (x: number, z: number, r: number, color: number) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.12, r, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.03, z); group.add(m);
  };
  let serverNo = -1;
  for (const b of BOXES) {
    if (b.kind !== "server") continue;
    serverNo++;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, b.y1, b.z1 - b.z0), new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.35, metalness: 0.7 }));
    cab.position.set(cx, b.y1 / 2, cz); cab.castShadow = cab.receiveShadow = true; group.add(cab);
    // one label texture for the cabinet's four faces
    const labelMat = new THREE.MeshBasicMaterial({ map: labelTexture(`efectivo · SERWER ${"AB"[serverNo]}`, "#000000", "#f5f5f7", 512, 128, 40) });
    for (const [dx, dz, ry] of [[0.51, 0, Math.PI / 2], [-0.51, 0, -Math.PI / 2], [0, 0.51, 0], [0, -0.51, Math.PI]] as const) {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.2), labelMat);
      label.position.set(cx + dx, 1.8, cz + dz); label.rotation.y = ry; group.add(label);
      for (let k = 0; k < 5; k++) {
        const led = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.035), accentMat);
        led.position.set(cx + dx, 0.5 + k * 0.22, cz + dz); led.rotation.y = ry; group.add(led); blink.push(led);
      }
    }
    if (mission === "server") ring(cx, cz, 3, ACCENT);
  }

  // mission "tags": the charging stations that take the watch tags, and the delivery waiting by the docks
  if (mission === "tags") {
    const caseMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.5 });
    const dockMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.4 });
    layout().stations.forEach((st, si) => {
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 0.8), dockMat); base.position.set(st.x, 0.5, st.z); base.castShadow = base.receiveShadow = true; group.add(base);
      // rows of watch tags on their chargers: a black face on a strap, a blue dot when charged
      for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) {
        const tag = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.12), caseMat); tag.position.set(st.x - 0.62 + i * 0.25, 1.02, st.z - 0.18 + j * 0.36); group.add(tag);
        const dot = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.035, 0.04), accentMat); dot.position.copy(tag.position); dot.position.y += 0.005; group.add(dot); if ((i + j) % 2) blink.push(dot);
      }
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.3), new THREE.MeshBasicMaterial({ map: labelTexture(`STACJA ${"AB"[si]}`, "#16a34a", "#ffffff", 512, 112, 60), side: THREE.DoubleSide }));
      sign.position.set(st.x, 1.75, st.z); group.add(sign);
      ring(st.x, st.z, 3, 0x16a34a);
    });
  }

  // wire cage
  for (const b of BOXES) {
    if (b.kind !== "cage") continue;
    const t = meshTexture(); t.repeat.set((b.x1 - b.x0) / 0.6, (b.y1 - b.y0) / 0.6);
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0), new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4 }));
    m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2); group.add(m);
    for (let i = 0; i < 6; i++) pick(loads).add(b.x0 + 0.4 + (i % 3) * 1.25, 0, b.z0 + 0.45 + Math.floor(i / 3) * 0.55, 0.7, 0.5 + Math.random() * 0.8, 0.45);
  }

  // UWB anchors with a pulsing accent LED
  const ledMat = new THREE.MeshBasicMaterial({ color: ACCENT });
  const anchorMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.4 });
  const leds: THREE.Mesh[] = [];
  for (const [x, z] of layout().anchors) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.28), anchorMat);
    const onWall = Math.abs(x) > HALL.x1 - 1 || Math.abs(z) > HALL.z1 - 1;
    a.position.set(x + (onWall ? 0 : 0.45), Math.min(8, HALL.h - 1), z); group.add(a);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), ledMat); led.position.set(a.position.x, a.position.y - 0.1, a.position.z); group.add(led); leds.push(led);
  }

  blocks.build(group); glow.build(group); decals.build(group);
  meshBacks.build(group, new THREE.MeshStandardMaterial({ map: meshTexture(), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 }));
  hazard.build(group, new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.6 }));
  rackUp.build(group); beams.build(group); pallets.build(group); wrapped.build(group);
  rackPallets.build(group); rackWrapped.build(group);
  for (const l of rackLoads) l.build(group);
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
      for (let i = 0; i < blink.length; i++) blink[i].visible = Math.sin(t * 4 + i * 1.7) > -0.4;
      for (let i = 0; i < pickups.length; i++) { pickups[i].rotation.y = t * 1.6 + i; pickups[i].position.y = 0.85 + Math.sin(t * 2 + i) * 0.08; }
    },
    setPickups(active: boolean[]) { for (let i = 0; i < pickups.length; i++) pickups[i].visible = !!active[i]; },
  };
}

/** The forklift's parts, merged into one geometry per material and built once: every forklift shares them. */
let liftParts: [THREE.BufferGeometry, THREE.Material][] | undefined;

/**
 * A drivable forklift, built around its centre with the forks toward +X (shared/vehicle.ts): body, counterweight,
 * driver's seat under the roof frame, mast and forks, and a rear platform for the thrower to stand on.
 * About thirty boxes, but six draw calls: a hall with ten forklifts would otherwise spend 300 calls on them.
 */
export function forkliftModel(): THREE.Group {
  if (!liftParts) {
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45, metalness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.6, metalness: 0.4 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.9 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x6b6f77, metalness: 0.8, roughness: 0.35 });
    const stripe = new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.6 });
    const lit = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const by = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, color?: number) => {
      const g = geo.clone().translate(x, y, z);
      if (color !== undefined) { // lamps of different colours share the unlit material through vertex colours
        const n = g.getAttribute("position").count, col = new Float32Array(n * 3); tmpC.setHex(color);
        for (let i = 0; i < n; i++) col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      }
      (by.get(mat) ?? by.set(mat, []).get(mat)!).push(g);
    };
    const box = (sx: number, sy: number, sz: number) => new THREE.BoxGeometry(sx, sy, sz);
    add(box(1.7, 0.9, 1.15), yellow, -0.15, 0.75, 0);
    add(box(1.5, 0.08, 1.17), dark, -0.15, 0.36, 0); // skirt under the body
    add(box(0.5, 0.8, 1.15), dark, -0.95, 0.8, 0); // counterweight
    add(box(0.5, 0.45, 0.5), dark, -0.25, 1.35, 0); // seat
    add(box(0.1, 0.5, 0.46), dark, -0.48, 1.6, 0); // seat back
    add(box(0.06, 0.5, 0.06).rotateZ(-0.5), dark, 0.32, 1.4, 0); // steering column
    add(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 14).rotateZ(Math.PI / 2 - 0.5), dark, 0.2, 1.63, 0); // and its wheel
    for (const [x, z] of [[-0.85, -0.5], [-0.85, 0.5], [0.45, -0.5], [0.45, 0.5]]) add(box(0.05, 1.1, 0.05), dark, x, 1.75, z);
    add(box(1.4, 0.06, 1.1), dark, -0.2, 2.3, 0);
    for (const z of [-0.36, 0.36]) add(box(0.12, 2.2, 0.14), dark, 0.75, 1.1, z); // mast: two channels and three cross bars
    for (const y of [0.25, 1.2, 2.15]) add(box(0.1, 0.1, 0.72), dark, 0.75, y, 0);
    add(box(0.05, 2.0, 0.08), steel, 0.75, 1.1, 0); // lift cylinder
    add(box(0.06, 0.5, 0.95), dark, 0.84, 0.42, 0); // fork carriage
    for (const z of [-0.3, 0.3]) { add(box(1.0, 0.06, 0.12), steel, 1.3, 0.12, z); add(box(0.06, 0.5, 0.12), steel, 0.83, 0.37, z); }
    const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 18).rotateX(Math.PI / 2), hub = new THREE.CylinderGeometry(0.13, 0.13, 0.22, 12).rotateX(Math.PI / 2);
    for (const [x, z] of [[-0.7, -0.6], [-0.7, 0.6], [0.4, -0.6], [0.4, 0.6]]) { add(wheel, tyre, x, 0.3, z); add(hub, yellow, x, 0.3, z); }
    add(new THREE.SphereGeometry(0.08, 10, 8), lit, -0.6, 2.38, 0, 0xf59e0b); // beacon
    for (const z of [-0.45, 0.45]) { add(box(0.05, 0.09, 0.14), lit, 0.5, 2.22, z, 0xfff4d6); add(box(0.03, 0.1, 0.12), lit, -1.21, 0.95, z * 0.95, 0xff3b30); }
    // the thrower's platform with a hand rail
    add(box(0.6, 0.08, 1.1), stripe, -1.25, 1.41, 0);
    add(box(0.3, 0.25, 0.9), dark, -1.25, 1.27, 0); // riser on the counterweight
    for (const z of [-0.5, 0.5]) add(box(0.04, 0.6, 0.04), dark, -1.52, 1.75, z);
    add(box(0.04, 0.04, 1.04), dark, -1.52, 2.05, 0);
    liftParts = [...by].map(([mat, geos]) => { const merged = mergeGeometries(geos); for (const q of geos) q.dispose(); return [merged, mat]; });
  }
  const g = new THREE.Group();
  for (const [geo, mat] of liftParts) { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = !(mat instanceof THREE.MeshBasicMaterial); g.add(m); }
  return g;
}

function pickupMesh(kind: PickupKind): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  if (kind === "med") {
    add(new THREE.BoxGeometry(0.5, 0.36, 0.22), new THREE.MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.4 }));
    const cross = new THREE.MeshBasicMaterial({ color: 0x12b76a });
    add(new THREE.BoxGeometry(0.22, 0.07, 0.23), cross); add(new THREE.BoxGeometry(0.07, 0.22, 0.23), cross);
  } else if (kind === "ammo") {
    // a refill: a little stack of flat-packed boxes
    const m = new THREE.MeshStandardMaterial({ map: cardboardTexture("#b58e5c", false), roughness: 0.85 });
    add(new THREE.BoxGeometry(0.4, 0.14, 0.3), m, 0, -0.08, 0);
    add(new THREE.BoxGeometry(0.34, 0.12, 0.26), m, 0.02, 0.05, 0).rotation.y = 0.3;
    add(new THREE.BoxGeometry(0.22, 0.1, 0.18), m, -0.02, 0.16, 0).rotation.y = -0.2;
  } else if (kind === "shotgun") {
    const g2 = gunModel("shotgun"); g2.scale.setScalar(1.3); g2.rotation.y = Math.PI / 2; g.add(g2);
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
