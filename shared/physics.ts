// Movement, collision and ray tests for efectivo ARENA. Shared by the browser (own-player prediction, tracers) and the
// game host (bots, validation, hit tests), so both see the same walls.

import { BOXES, HALL, LADDERS, type Box, type Ladder } from "./map";

export const PLAYER_R = 0.35;
export const PLAYER_H = 1.75;
export const EYE_H = 1.62;
export const HEAD_H = 0.3;
export const GRAVITY = 22;
export const JUMP_V = 7.6;
export const WALK_SPEED = 5.2;
export const SPRINT_SPEED = 7.6;
export const STEP_H = 0.45;
/** Speed up and down a ladder (m/s). Coming down is slow enough to be safe. */
export const CLIMB_SPEED = 3.4;

export interface Body {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
}

export interface MoveInput {
  /** Wish direction in world space (any length; clamped to 1). */
  mx: number; mz: number;
  jump: boolean;
  sprint: boolean;
  /** Use ladders: push toward the rack to climb. Bots leave this off and stay on the floor. */
  climb?: boolean;
}

/** The ladder whose zone holds a player at (x, y, z), if any. */
export function ladderAt(x: number, y: number, z: number): Ladder | null {
  for (const l of LADDERS) if (x > l.x0 - 0.1 && x < l.x1 + 0.1 && z > l.z0 && z < l.z1 && y < l.top + 0.05) return l;
  return null;
}

/** Moving obstacles (the forklifts), refreshed every tick by whoever runs the world. */
let DYN: readonly Box[] = [];
export function setDynamicBoxes(list: readonly Box[]) { DYN = list; }

const overlaps = (b: Box, x: number, y: number, z: number) =>
  x + PLAYER_R > b.x0 && x - PLAYER_R < b.x1 && z + PLAYER_R > b.z0 && z - PLAYER_R < b.z1 && y + PLAYER_H > b.y0 && y < b.y1;

/** True when a player standing at (x, y, z) would be inside something; `moving` also counts the forklifts. */
export function blocked(x: number, y: number, z: number, moving = true): boolean {
  for (const b of BOXES) if (overlaps(b, x, y, z)) return true;
  if (moving) for (const b of DYN) if (overlaps(b, x, y, z)) return true;
  return false;
}

/** Static and moving boxes together, in that order. */
function* allBoxes(): Generator<Box> { yield* BOXES; yield* DYN; }

function moveAxis(p: Body, axis: 0 | 2, d: number) {
  if (d === 0) return;
  if (axis === 0) p.x += d; else p.z += d;
  for (const b of allBoxes()) {
    if (!overlaps(b, p.x, p.y, p.z)) continue;
    // step up onto something low (a pallet edge, a kerb) if there is head room
    const rise = b.y1 - p.y;
    if (p.onGround && rise > 0 && rise <= STEP_H && !blocked(p.x, b.y1 + 0.001, p.z)) { p.y = b.y1 + 0.001; continue; }
    if (axis === 0) { p.x = d > 0 ? b.x0 - PLAYER_R - 0.0005 : b.x1 + PLAYER_R + 0.0005; p.vx = 0; }
    else { p.z = d > 0 ? b.z0 - PLAYER_R - 0.0005 : b.z1 + PLAYER_R + 0.0005; p.vz = 0; }
  }
}

/** Advance a body one step: acceleration toward the wish velocity, gravity, jumping and collision. */
export function stepBody(p: Body, inp: MoveInput, dt: number) {
  let mx = inp.mx, mz = inp.mz;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  const speed = inp.sprint ? SPRINT_SPEED : WALK_SPEED;
  const accel = p.onGround ? 14 : 3;
  const k = Math.min(1, accel * dt);
  p.vx += (mx * speed - p.vx) * k;
  p.vz += (mz * speed - p.vz) * k;
  if (inp.jump && p.onGround) { p.vy = JUMP_V; p.onGround = false; }
  // ladders: pushing toward the rack climbs; letting go slides down the rails at a safe speed
  const lad = inp.climb ? ladderAt(p.x, p.y, p.z) : null;
  if (lad && mx * lad.dx > 0.3) { p.vy = CLIMB_SPEED; p.onGround = false; }
  else if (lad && !p.onGround && !inp.jump) { p.vy = -CLIMB_SPEED; p.vx = 0; p.vz = 0; }
  else p.vy -= GRAVITY * dt;

  moveAxis(p, 0, p.vx * dt);
  moveAxis(p, 2, p.vz * dt);

  p.y += p.vy * dt;
  p.onGround = false;
  if (p.y <= 0) { p.y = 0; p.vy = 0; p.onGround = true; }
  for (const b of allBoxes()) {
    if (!overlaps(b, p.x, p.y, p.z)) continue;
    if (p.vy <= 0 && p.y - p.vy * dt >= b.y1 - 0.05) { p.y = b.y1; p.vy = 0; p.onGround = true; }
    else if (p.vy > 0) { p.y = b.y0 - PLAYER_H - 0.001; p.vy = 0; }
  }
  // standing exactly on a top surface counts as ground
  if (!p.onGround && p.vy <= 0) {
    for (const b of allBoxes()) {
      if (Math.abs(p.y - b.y1) < 0.002 && p.x + PLAYER_R > b.x0 && p.x - PLAYER_R < b.x1 && p.z + PLAYER_R > b.z0 && p.z - PLAYER_R < b.z1) { p.onGround = true; p.vy = 0; break; }
    }
  }
  if (p.y > HALL.h - PLAYER_H) { p.y = HALL.h - PLAYER_H; if (p.vy > 0) p.vy = 0; }
}

/** Ray against one axis-aligned box: entry distance, or Infinity. */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let tmin = 0, tmax = Infinity;
  if (Math.abs(dx) < 1e-9) { if (ox < x0 || ox > x1) return Infinity; }
  else { let a = (x0 - ox) / dx, b = (x1 - ox) / dx; if (a > b) [a, b] = [b, a]; tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); }
  if (Math.abs(dy) < 1e-9) { if (oy < y0 || oy > y1) return Infinity; }
  else { let a = (y0 - oy) / dy, b = (y1 - oy) / dy; if (a > b) [a, b] = [b, a]; tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); }
  if (Math.abs(dz) < 1e-9) { if (oz < z0 || oz > z1) return Infinity; }
  else { let a = (z0 - oz) / dz, b = (z1 - oz) / dz; if (a > b) [a, b] = [b, a]; tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); }
  return tmax >= tmin ? tmin : Infinity;
}

/** Distance along a unit ray to the first solid (walls, racks, floor, ceiling), capped at `max`. */
export function rayWorld(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
  let best = max;
  if (dy < 0) best = Math.min(best, -oy / dy);
  if (dy > 0) best = Math.min(best, (HALL.h - oy) / dy);
  for (const b of BOXES) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.x0, b.y0, b.z0, b.x1, b.y1, b.z1);
    if (t < best) best = t;
  }
  for (const b of DYN) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.x0, b.y0, b.z0, b.x1, b.shotY1 ?? b.y1, b.z1);
    if (t < best) best = t;
  }
  return best;
}

/** True when nothing solid lies between two points. */
export function lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return true;
  return rayWorld(ax, ay, az, dx / d, dy / d, dz / d, d) >= d - 1e-3;
}

/** Ray against a player standing at (x, y, z): 0 miss, 1 body, 2 head; distance written to out[0]. */
export function rayPlayer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x: number, y: number, z: number, out: number[]): number {
  const r = PLAYER_R * 0.85;
  const th = rayBox(ox, oy, oz, dx, dy, dz, x - 0.16, y + PLAYER_H - HEAD_H, z - 0.16, x + 0.16, y + PLAYER_H + 0.02, z + 0.16);
  const tb = rayBox(ox, oy, oz, dx, dy, dz, x - r, y, z - r, x + r, y + PLAYER_H - HEAD_H, z + r);
  if (th === Infinity && tb === Infinity) return 0;
  if (th <= tb) { out[0] = th; return 2; }
  out[0] = tb; return 1;
}

/** Unit view vector for a yaw (0 = looking toward −Z, positive turns left) and pitch (positive looks up). */
export function viewDir(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
