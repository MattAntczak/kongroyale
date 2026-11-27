// Movement, collision and ray tests for efectivo ARENA. Shared by the browser (own-player prediction, tracers) and the
// game host (bots, validation, hit tests), so both see the same walls.

import { BOXES, HALL, LADDERS, type Box, type Ladder } from "./map";

export const PLAYER_R = 0.35;
export const PLAYER_H = 1.75;
export const EYE_H = 1.62;
/** Crouched: a shorter body (a smaller target for thrown boxes) and a lower eye. */
export const CROUCH_H = 1.2;
export const CROUCH_EYE_H = 1.1;
export const HEAD_H = 0.3;
export const GRAVITY = 22;
/** A plain jump lifts the feet about 1.05 m: not quite onto a 1.25 m pallet stack, which takes a crouch-jump. */
export const JUMP_V = 6.8;
/** Crouching in the air pulls the legs up by this much (the feet rise, the head stays): the crouch-jump. */
export const TUCK = 0.35;
// Ground movement in the Quake/Half-Life manner: friction slows a body every tick (never by less than STOP_SPEED's
// worth, so the last metre per second goes quickly), and acceleration adds speed along the wish direction only up
// to the wish speed. Letting go glides to a stop in ~0.4 s; pressing the opposite key stops in ~0.1 s.
/** Running speed with the lightest launcher in hand (m/s); every launcher scales it (weapons.ts `run`). */
export const RUN_SPEED = 4.8;
/** Shift: a quiet walk; Ctrl / C: crouched. Shares of the launcher's running speed. */
export const WALK_MUL = 0.52;
export const CROUCH_MUL = 0.34;
export const FRICTION = 4;
export const STOP_SPEED = 2.5;
export const ACCEL = 5.5;
const ACCEL_FLOOR = 3;
/** In the air the wish speed is capped this low: a little steering (air strafing), no running away (bunny hops). */
export const AIR_ACCEL = 10;
export const AIR_WISH = 0.75;
/** Landing keeps this share of the horizontal speed; a jump within LAND_S of a landing is this much weaker. */
export const LAND_KEEP = 0.75;
export const LAND_S = 0.3;
export const LAND_JUMP = 0.85;
/** Nothing on foot goes faster horizontally than this, however it strafes in the air (the host checks against it). */
export const MAX_FOOT_SPEED = RUN_SPEED * 1.25;
/** The fastest a body on foot loses horizontal speed without running into something (m/s²): friction at the top
 *  speed plus the full acceleration of a counter-strafe. The host bounds a claimed stop with it. */
export const STOP_DECEL = FRICTION * MAX_FOOT_SPEED + ACCEL * RUN_SPEED;
/** Running (louder than this) makes footsteps; walking and crouching do not. */
export const STEP_SPEED = 3;
export const STEP_H = 0.45;
/** Speed up and down a ladder (m/s). Coming down is slow enough to be safe. */
export const CLIMB_SPEED = 3.4;

export interface Body {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  /** Crouched (the short body); `tucked`: crouched in the air with the legs pulled up. */
  crouch?: boolean;
  tucked?: boolean;
  /** Seconds since the last landing from a jump (a jump right after one is weaker); in the air after a jump. */
  landed?: number;
  hopped?: boolean;
  /** How far a crouch in the air has moved the feet since the owner last looked (the client keeps its eye steady). */
  shift?: number;
}

export interface MoveInput {
  /** Wish direction in world space (any length; clamped to 1). */
  mx: number; mz: number;
  jump: boolean;
  /** Running speed for the launcher in hand (weapons.ts maxSpeed); RUN_SPEED when left out. */
  speed?: number;
  /** Shift: walk quietly. */
  walk?: boolean;
  /** Ctrl / C: crouch (stays crouched under anything too low to stand up in). */
  crouch?: boolean;
  /** Use ladders: push toward the rack to climb. Bots leave this off and stay on the floor. */
  climb?: boolean;
}

/** Height of a body right now. */
export const bodyH = (p: { crouch?: boolean }) => (p.crouch ? CROUCH_H : PLAYER_H);
/** Eye height above the feet. */
export const eyeH = (crouch: boolean | undefined) => (crouch ? CROUCH_EYE_H : EYE_H);

/** The ladder whose zone holds a player at (x, y, z), if any. */
export function ladderAt(x: number, y: number, z: number): Ladder | null {
  for (const l of LADDERS) if (x > l.x0 - 0.1 && x < l.x1 + 0.1 && z > l.z0 && z < l.z1 && y < l.top + 0.05) return l;
  return null;
}

/** Moving obstacles (the forklifts), refreshed every tick by whoever runs the world. */
let DYN: readonly Box[] = [];
export function setDynamicBoxes(list: readonly Box[]) { DYN = list; }

const overlaps = (b: Box, x: number, y: number, z: number, h: number) =>
  x + PLAYER_R > b.x0 && x - PLAYER_R < b.x1 && z + PLAYER_R > b.z0 && z - PLAYER_R < b.z1 && y + h > b.y0 && y < b.y1;

/** True when a player standing at (x, y, z) would be inside something; `moving` also counts the forklifts, `h` is the
 *  body's height (crouched or not). */
export function blocked(x: number, y: number, z: number, moving = true, h = PLAYER_H): boolean {
  if (y + h > HALL.h) return true;
  for (const b of BOXES) if (overlaps(b, x, y, z, h)) return true;
  if (moving) for (const b of DYN) if (overlaps(b, x, y, z, h)) return true;
  return false;
}

/** True when something holds up feet at (x, y, z): the floor or the top of a box just below. The host's own way to
 *  tell a jumping player from a standing one, whatever the client says. */
export function supported(x: number, y: number, z: number): boolean {
  if (y <= 0.03) return true;
  for (const b of BOXES) {
    if (y - b.y1 > -0.02 && y - b.y1 < 0.08 && x + PLAYER_R > b.x0 && x - PLAYER_R < b.x1 && z + PLAYER_R > b.z0 && z - PLAYER_R < b.z1) return true;
  }
  return false;
}

/** Static and moving boxes together, in that order. */
function* allBoxes(): Generator<Box> { yield* BOXES; yield* DYN; }

function moveAxis(p: Body, axis: 0 | 2, d: number) {
  if (d === 0) return;
  const h = bodyH(p);
  if (axis === 0) p.x += d; else p.z += d;
  for (const b of allBoxes()) {
    if (!overlaps(b, p.x, p.y, p.z, h)) continue;
    // step up onto something low (a pallet edge, a kerb) if there is head room
    const rise = b.y1 - p.y;
    if (p.onGround && rise > 0 && rise <= STEP_H && !blocked(p.x, b.y1 + 0.001, p.z, true, h)) { p.y = b.y1 + 0.001; continue; }
    if (axis === 0) { p.x = d > 0 ? b.x0 - PLAYER_R - 0.0005 : b.x1 + PLAYER_R + 0.0005; p.vx = 0; }
    else { p.z = d > 0 ? b.z0 - PLAYER_R - 0.0005 : b.z1 + PLAYER_R + 0.0005; p.vz = 0; }
  }
}

/** Quake-style acceleration: add speed along `(wx, wz)` (unit) until the velocity's share along it reaches `cap`.
 *  The rate never drops below ACCEL_FLOOR's worth, or a slow wish (a crouch) could not beat the friction floor. */
function accelerate(p: Body, wx: number, wz: number, wish: number, accel: number, cap: number, dt: number) {
  const add = cap - (p.vx * wx + p.vz * wz);
  if (add <= 0) return;
  const a = Math.min(add, accel * Math.max(wish, ACCEL_FLOOR) * dt);
  p.vx += wx * a; p.vz += wz * a;
}

/** Crouch and stand up. Standing needs head room; in the air a tucked body lets its legs down again. */
function duck(p: Body, want: boolean) {
  if (want && !p.crouch) {
    p.crouch = true;
    // in the air the legs come up instead of the head going down: the feet rise by TUCK, if there is room above
    if (!p.onGround && !blocked(p.x, p.y + TUCK, p.z, true, CROUCH_H)) { p.y += TUCK; p.tucked = true; p.shift = (p.shift ?? 0) + TUCK; }
    return;
  }
  if (!want && p.crouch) {
    // stand up: in the air a tucked body first tries to drop its legs back (head where it was), then grows upward
    const tries = p.tucked && !p.onGround ? [p.y - TUCK, p.y] : [p.y];
    for (const y of tries) {
      if (y < 0 || blocked(p.x, y, p.z, true, PLAYER_H)) continue;
      p.shift = (p.shift ?? 0) + y - p.y;
      p.y = y; p.crouch = false; p.tucked = false;
      return;
    }
  }
}

/** Advance a body one step: friction and acceleration, crouching, jumping, ladders, gravity and collision. */
export function stepBody(p: Body, inp: MoveInput, dt: number) {
  let mx = inp.mx, mz = inp.mz;
  const len = Math.hypot(mx, mz);
  if (len > 1e-6) { mx /= len; mz /= len; }
  const want = Math.min(1, len);
  const wasGround = p.onGround;
  duck(p, !!inp.crouch);
  let wish = (inp.speed ?? RUN_SPEED) * want;
  if (p.crouch) wish *= CROUCH_MUL; else if (inp.walk) wish *= WALK_MUL;
  const lad = inp.climb ? ladderAt(p.x, p.y, p.z) : null;

  if (p.onGround) {
    // friction first, then the wish: what makes a stop quick and a counter-strafe quicker
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > 1e-4) {
      const drop = Math.max(sp, STOP_SPEED) * FRICTION * dt, k = Math.max(0, sp - drop) / sp;
      p.vx *= k; p.vz *= k;
    }
    if (want > 0) accelerate(p, mx, mz, wish, ACCEL, wish, dt);
    p.landed = (p.landed ?? 1) + dt;
  } else if (want > 0) {
    // on a ladder the hands give full control; in the air only a little
    if (lad) accelerate(p, mx, mz, wish, ACCEL, wish, dt);
    else accelerate(p, mx, mz, wish, AIR_ACCEL, Math.min(wish, AIR_WISH), dt);
  }
  const hs = Math.hypot(p.vx, p.vz);
  if (hs > MAX_FOOT_SPEED) { p.vx *= MAX_FOOT_SPEED / hs; p.vz *= MAX_FOOT_SPEED / hs; }

  if (inp.jump && p.onGround) {
    p.vy = JUMP_V * ((p.landed ?? 1) < LAND_S ? LAND_JUMP : 1); p.onGround = false; p.hopped = true;
  }
  // ladders: pushing toward the rack climbs; letting go slides down the rails at a safe speed
  if (lad && mx * lad.dx > 0.3) { p.vy = CLIMB_SPEED; p.onGround = false; }
  else if (lad && !p.onGround && !inp.jump) { p.vy = -CLIMB_SPEED; p.vx = 0; p.vz = 0; }
  else p.vy -= GRAVITY * dt;

  moveAxis(p, 0, p.vx * dt);
  moveAxis(p, 2, p.vz * dt);

  const h = bodyH(p);
  p.y += p.vy * dt;
  p.onGround = false;
  if (p.y <= 0) { p.y = 0; p.vy = 0; p.onGround = true; }
  for (const b of allBoxes()) {
    if (!overlaps(b, p.x, p.y, p.z, h)) continue;
    if (p.vy <= 0 && p.y - p.vy * dt >= b.y1 - 0.05) { p.y = b.y1; p.vy = 0; p.onGround = true; }
    else if (p.vy > 0) { p.y = b.y0 - h - 0.001; p.vy = 0; }
  }
  // standing exactly on a top surface counts as ground
  if (!p.onGround && p.vy <= 0) {
    for (const b of allBoxes()) {
      if (Math.abs(p.y - b.y1) < 0.002 && p.x + PLAYER_R > b.x0 && p.x - PLAYER_R < b.x1 && p.z + PLAYER_R > b.z0 && p.z - PLAYER_R < b.z1) { p.onGround = true; p.vy = 0; break; }
    }
  }
  if (p.y > HALL.h - h) { p.y = HALL.h - h; if (p.vy > 0) p.vy = 0; }
  if (p.onGround) {
    p.tucked = false;
    // landing from a jump costs speed, so hopping is never faster than running (walking off a ledge does not)
    if (!wasGround && p.hopped) { p.vx *= LAND_KEEP; p.vz *= LAND_KEEP; p.landed = 0; }
    p.hopped = false;
  }
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

/** How much wider a player is for a flying box than for a thin ray: the box has a size of its own, so grazing counts. */
export const BOX_HIT_PAD = 0.12;

/** Ray against a player standing at (x, y, z): 0 miss, 1 body, 2 head; distance written to out[0]. `pad` widens the
 *  body by that much on every side (the head by half of it, so headshots stay a skill); `h` is the body's height
 *  (CROUCH_H for a crouched player). */
export function rayPlayer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x: number, y: number, z: number, out: number[], pad = 0, h = PLAYER_H): number {
  const r = PLAYER_R * 0.85 + pad, hr = 0.16 + pad * 0.5;
  const th = rayBox(ox, oy, oz, dx, dy, dz, x - hr, y + h - HEAD_H, z - hr, x + hr, y + h + 0.02 + pad * 0.5, z + hr);
  const tb = rayBox(ox, oy, oz, dx, dy, dz, x - r, y, z - r, x + r, y + h - HEAD_H, z + r);
  if (th === Infinity && tb === Infinity) return 0;
  if (th <= tb) { out[0] = th; return 2; }
  out[0] = tb; return 1;
}

/** Unit view vector for a yaw (0 = looking toward −Z, positive turns left) and pitch (positive looks up). */
export function viewDir(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
