// Forklifts you can drive: one player drives, a second stands on the rear platform and throws boxes. The driver's
// browser predicts the forklift with stepVehicle and the host checks every reported pose against the same rules, so
// both share this file. The body collides as two circles along its length; rotation `yaw` 0 = forks toward +X, the
// same convention as the hall boxes and three.js `rotation.y`.

import { BOXES, type Box } from "./map";

export const VEH_LEN = 2.6;
export const VEH_W = 1.3;
/** Height of the body for walking into it (with the roof frame). */
export const VEH_H = 2.3;
/** Height that stops thrown boxes: the body and counterweight. Above it riders are exposed. */
export const VEH_SHOT_H = 1.2;
export const VEH_MAX_SPEED = 8.5;
export const VEH_REVERSE_SPEED = 3.5;
/** How close (metres, centre to centre) a player has to be to get on. */
export const VEH_USE_R = 2.6;

/** Seats in the forklift's own frame: x along the forks, y up (the rider's feet), z to the side. */
export const SEATS = [
  { x: -0.25, y: 0.65, z: 0 }, // driver, sitting
  { x: -1.25, y: 1.45, z: 0 }, // thrower, on the raised rear platform: sees over the driver's hard hat
] as const;

/** How fast a thrower on the rear platform counts as moving for the spread of a throw: half the forklift's speed
 *  (the platform carries them, their legs do not run; never "in the air"). Host and client use the same. */
export const rideSpeed = (v: VehicleState) => Math.abs(v.speed) * 0.5;

export interface VehicleState { x: number; z: number; yaw: number; speed: number }

const CIRCLE_R = 0.72;
const CIRCLE_OFF = 0.62;

/** World position of a seat. */
export function seatPos(v: VehicleState, seat: number, out: number[]) {
  const s = SEATS[seat];
  const fx = Math.cos(v.yaw), fz = -Math.sin(v.yaw);
  out[0] = v.x + fx * s.x - fz * s.z; out[1] = s.y; out[2] = v.z + fz * s.x + fx * s.z;
}

/** The axis-aligned box around the forklift (walking and thrown boxes collide with it). */
export function vehicleBox(v: VehicleState, out: Box) {
  const c = Math.abs(Math.cos(v.yaw)), s = Math.abs(Math.sin(v.yaw));
  const hx = (c * VEH_LEN + s * VEH_W) / 2 * 0.92, hz = (s * VEH_LEN + c * VEH_W) / 2 * 0.92;
  out.x0 = v.x - hx; out.x1 = v.x + hx; out.z0 = v.z - hz; out.z1 = v.z + hz; out.y0 = 0; out.y1 = VEH_H;
  out.shotY1 = VEH_SHOT_H;
  return out;
}

const centres = [0, 0, 0, 0];
function circles(v: VehicleState) {
  const fx = Math.cos(v.yaw), fz = -Math.sin(v.yaw);
  centres[0] = v.x + fx * CIRCLE_OFF; centres[1] = v.z + fz * CIRCLE_OFF;
  centres[2] = v.x - fx * CIRCLE_OFF; centres[3] = v.z - fz * CIRCLE_OFF;
}

/** Push the forklift out of the hall's boxes and other forklifts; true when it touched something. */
function resolve(v: VehicleState, others: readonly VehicleState[]): boolean {
  let hit = false;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let k = 0; k < 4; k += 2) {
      circles(v);
      const cx = centres[k], cz = centres[k + 1];
      for (const b of BOXES) {
        if (b.y0 > 1.5) continue;
        const px = Math.max(b.x0, Math.min(cx, b.x1)), pz = Math.max(b.z0, Math.min(cz, b.z1));
        const dx = cx - px, dz = cz - pz, d = Math.hypot(dx, dz);
        if (d >= CIRCLE_R) continue;
        if (d < 1e-6) { // centre inside the box: push out along the shallowest side
          const l = cx - b.x0, r = b.x1 - cx, t = cz - b.z0, bo = b.z1 - cz, m = Math.min(l, r, t, bo);
          if (m === l) v.x -= l + CIRCLE_R; else if (m === r) v.x += r + CIRCLE_R; else if (m === t) v.z -= t + CIRCLE_R; else v.z += bo + CIRCLE_R;
        } else { v.x += dx / d * (CIRCLE_R - d); v.z += dz / d * (CIRCLE_R - d); }
        hit = moved = true;
      }
      for (const o of others) {
        if (o === v) continue;
        const dx = v.x - o.x, dz = v.z - o.z, d = Math.hypot(dx, dz), min = VEH_W + 0.2;
        if (d < min && d > 1e-6) { v.x += dx / d * (min - d) * 0.5; v.z += dz / d * (min - d) * 0.5; hit = moved = true; }
      }
    }
    if (!moved) break;
  }
  return hit;
}

/** One step of driving: throttle and steer in −1…1. Returns true when it bumped into something. */
export function stepVehicle(v: VehicleState, throttle: number, steer: number, dt: number, others: readonly VehicleState[] = []): boolean {
  if (throttle > 0) v.speed = Math.min(VEH_MAX_SPEED, v.speed + (v.speed < 0 ? 14 : 6) * throttle * dt);
  else if (throttle < 0) v.speed = Math.max(-VEH_REVERSE_SPEED, v.speed + (v.speed > 0 ? 14 : 5) * throttle * dt);
  else v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), 5 * dt);
  // forklifts steer with the rear wheels: tight turns, and the turn follows the direction of travel
  const turn = steer * Math.min(1, Math.abs(v.speed) / 2) * 1.9 * Math.sign(v.speed || 1);
  v.yaw += turn * dt;
  if (v.yaw > Math.PI) v.yaw -= Math.PI * 2; else if (v.yaw < -Math.PI) v.yaw += Math.PI * 2;
  v.x += Math.cos(v.yaw) * v.speed * dt;
  v.z += -Math.sin(v.yaw) * v.speed * dt;
  const hit = resolve(v, others);
  if (hit) v.speed *= 0.4;
  return hit;
}

/** True when the forklift at this pose overlaps a wall, rack or stack by more than a hair. */
export function vehicleBlocked(v: VehicleState): boolean {
  circles(v);
  for (let k = 0; k < 4; k += 2) {
    const cx = centres[k], cz = centres[k + 1];
    for (const b of BOXES) {
      if (b.y0 > 1.5) continue;
      const px = Math.max(b.x0, Math.min(cx, b.x1)), pz = Math.max(b.z0, Math.min(cz, b.z1));
      if (Math.hypot(cx - px, cz - pz) < CIRCLE_R - 0.08) return true;
    }
  }
  return false;
}
