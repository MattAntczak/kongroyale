// The cardboard launchers of efectivo ARENA (the Paczkownik throws barcode labels): every shot is a real little box that flies (with a touch of gravity) and
// hits whatever it meets first. Tunables only; the host applies them (shared/sim.ts), the client mirrors the cadence,
// spread and flight for feel.

import { RUN_SPEED } from "./physics";

export type WeaponId = "rifle" | "pistol" | "shotgun" | "sniper" | "grenade";

export interface WeaponDef {
  name: string;
  /** Damage per box at close range. */
  dmg: number;
  headMul: number;
  /** Rounds per minute. */
  rpm: number;
  auto: boolean;
  mag: number;
  /** Reserve ammo given at spawn / by an ammo crate. */
  reserve: number;
  /** Accuracy (cone half-angles, radians). `spread`: the first throw standing still (the pellet cone of the Paletówka);
   *  `hip`: extra without the sight (the Dalekomiot is only accurate scoped); `shotSpread`: extra per throw of a burst,
   *  up to `heatMax` throws' worth, recovering at `recover` throws a second once the trigger rests; `moveSpread`:
   *  extra at full running speed (it grows with the square of the speed, so walking costs little); `airSpread`: extra
   *  off the ground. `sightMul` scales it all while looking through the sight. */
  spread: number;
  hip: number;
  shotSpread: number;
  heatMax: number;
  recover: number;
  moveSpread: number;
  airSpread: number;
  sightMul: number;
  /** Running speed with this launcher in hand, a share of RUN_SPEED. */
  run: number;
  pellets: number;
  /** Full damage up to range / 2 of flight, falling to half at `range`; boxes are cleared beyond it. */
  range: number;
  reloadS: number;
  /** Camera shake per shot, for the feel only; the recoil itself is RECOIL below. */
  kick: number;
  /** Muzzle speed of each box (m/s). */
  speed: number;
  /** Edge of each flying box (m), for the client's model. */
  size: number;
  /** Magnification of the sight on the right mouse button (1 = none). From 3 up it is a scope with its own view. */
  zoom: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  // the rifle: a dead-on first throw, a spray that opens up and climbs (RECOIL), steadier through the 2x sight
  rifle: { name: "Kartonomiot", dmg: 17, headMul: 1.8, rpm: 560, auto: true, mag: 30, reserve: 120, spread: 0.0025, hip: 0, shotSpread: 0.0042, heatMax: 12, recover: 26, moveSpread: 0.075, airSpread: 0.2, sightMul: 0.75, run: 0.88, pellets: 1, range: 90, reloadS: 2.0, kick: 0.01, speed: 110, size: 0.13, zoom: 2 },
  // the label gun: accurate when tapped, wild when clicked fast or thrown on the run
  pistol: { name: "Paczkownik", dmg: 16, headMul: 2.0, rpm: 300, auto: false, mag: 12, reserve: 999, spread: 0.003, hip: 0, shotSpread: 0.011, heatMax: 5, recover: 12, moveSpread: 0.045, airSpread: 0.12, sightMul: 0.85, run: 1, pellets: 1, range: 80, reloadS: 1.35, kick: 0.018, speed: 115, size: 0.11, zoom: 1.3 },
  shotgun: { name: "Paletówka", dmg: 15, headMul: 1.4, rpm: 70, auto: false, mag: 6, reserve: 24, spread: 0.065, hip: 0, shotSpread: 0.01, heatMax: 2, recover: 4, moveSpread: 0.03, airSpread: 0.06, sightMul: 1, run: 0.88, pellets: 8, range: 28, reloadS: 2.5, kick: 0.05, speed: 75, size: 0.09, zoom: 1 },
  // the long launcher with the scope: one heavy parcel at a time, slow to throw again; dead-on only scoped and still
  sniper: { name: "Dalekomiot", dmg: 100, headMul: 2.0, rpm: 42, auto: false, mag: 5, reserve: 15, spread: 0.0012, hip: 0.085, shotSpread: 0.02, heatMax: 1, recover: 1.2, moveSpread: 0.16, airSpread: 0.3, sightMul: 1, run: 0.84, pellets: 1, range: 230, reloadS: 2.8, kick: 0.05, speed: 240, size: 0.12, zoom: 4 },
  // the cardboard grenade: one bigger parcel thrown in an arc; it bursts where it lands (GRENADE_* below). `mag` is
  // how many a player carries, `dmg` the damage at the centre of the burst
  grenade: { name: "Kartonowy granat", dmg: 125, headMul: 1, rpm: 45, auto: false, mag: 2, reserve: 0, spread: 0.01, hip: 0, shotSpread: 0, heatMax: 0, recover: 1, moveSpread: 0.02, airSpread: 0.02, sightMul: 1, run: 1, pellets: 1, range: 70, reloadS: 0, kick: 0.03, speed: 24, size: 0.26, zoom: 1 },
};

/** The scoped Dalekomiot slows its carrier further (a share of RUN_SPEED). */
export const SCOPED_RUN = 0.6;
/** Running speed (m/s) with a launcher in hand. */
export function maxSpeed(w: WeaponId, scoped = false): number {
  return RUN_SPEED * (w === "sniper" && scoped ? SCOPED_RUN : WEAPONS[w].run);
}

// ---------------------------------------------------------------- accuracy and recoil
// Shared by the client (its crosshair and its own prediction) and the host (which decides every throw). `heat` counts
// the throws of the current burst; it rests while the trigger works and drains RECOVER_DELAY after the last throw.
// The recoil is a view punch: the throw goes where the view plus the punch points, the camera shows the same, and the
// player can pull the mouse down against it. It springs back once the trigger rests.

export interface AimState {
  /** Throws in the current burst (fractional while it drains). */
  heat: number;
  /** View punch, radians: up (pitch) and left (yaw, positive turns left). */
  pp: number; py: number;
  /** Time of the last throw, and the time the state was last brought up to date (any clock, seconds). */
  last: number; t: number;
}
export const newAim = (): AimState => ({ heat: 0, pp: 0, py: 0, last: -99, t: 0 });
export function resetAim(a: AimState) { a.heat = 0; a.pp = 0; a.py = 0; a.last = -99; }

/** The rest after a throw before the burst starts to cool, on top of the launcher's own cadence. */
export const RECOVER_DELAY = 0.06;
/** The punch springs back with this time constant once the trigger rests (seconds). */
export const PUNCH_TAU = 0.11;
/** Crouched and standing still: the steadiest stance. */
export const CROUCH_STEADY = 0.75;

/** Bring an aim state up to `now`: once the trigger has rested, the burst cools and the punch springs back. */
export function settleAim(a: AimState, w: WeaponDef, now: number) {
  const dt = now - a.t;
  a.t = now;
  if (!(dt > 0)) return;
  const rest = now - a.last - 60 / w.rpm - RECOVER_DELAY;
  if (rest <= 0) return;
  const s = Math.min(dt, rest);
  a.heat = Math.max(0, a.heat - s * w.recover);
  const k = Math.exp(-s / PUNCH_TAU);
  a.pp *= k; a.py *= k;
  if (Math.abs(a.pp) + Math.abs(a.py) < 1e-4) { a.pp = 0; a.py = 0; }
}

/** The cone half-angle (radians) of the next throw. `speed` horizontal m/s; `sight`: looking through the sight. */
export function aimCone(w: WeaponDef, a: AimState, speed: number, air: boolean, crouch: boolean, sight: boolean): number {
  const run = Math.min(1.3, speed / RUN_SPEED);
  let c = w.spread + (sight ? 0 : w.hip) + w.shotSpread * Math.min(a.heat, w.heatMax) + w.moveSpread * run * run + (air ? w.airSpread : 0);
  if (crouch && !air && speed < 0.6) c *= CROUCH_STEADY;
  return sight ? c * w.sightMul : c;
}

/**
 * The Kartonomiot's recoil, one [up, sideways] step per throw of a burst (radians; sideways positive = left). Our own
 * pattern: it climbs hard for the first eight, then drifts left, swings right and comes back left while climbing
 * only a little. The same every time, so it can be learnt and pulled against.
 */
export const RIFLE_RECOIL: readonly (readonly [number, number])[] = [
  [0.004, 0], [0.009, 0.0005], [0.011, -0.0005], [0.012, 0.001], [0.012, 0], [0.011, -0.001], [0.011, 0.0005], [0.01, 0],
  [0.003, 0.006], [0.0025, 0.007], [0.002, 0.007], [0.002, 0.006], [0.002, 0.005], [0.0015, 0.004],
  [0.0015, -0.006], [0.0015, -0.008], [0.0015, -0.008], [0.001, -0.008], [0.001, -0.007], [0.001, -0.006], [0.001, -0.005],
  [0.001, 0.005], [0.001, 0.006], [0.001, 0.006], [0.001, 0.005], [0.0008, 0.004], [0.0008, 0.003], [0.0008, 0.002], [0.0008, 0.002], [0.0008, 0.001],
];

/** A throw: the burst heats up and the view punch grows by the launcher's recoil step. */
export function kickAim(a: AimState, id: WeaponId, now: number) {
  const n = Math.floor(a.heat);
  if (id === "rifle") { const [up, side] = RIFLE_RECOIL[Math.min(n, RIFLE_RECOIL.length - 1)]; a.pp += up; a.py += side; }
  // the others: a straight kick up, the Paczkownik's with a small sideways flick that alternates
  else if (id === "pistol") { a.pp += 0.014; a.py += n % 2 ? -0.003 : 0.003; }
  else if (id === "shotgun") a.pp += 0.045;
  else if (id === "sniper") a.pp += 0.04;
  a.heat += 1;
  a.last = now; a.t = now;
}

/** Nothing lies on the floor: launchers are bought, as in CS. The Paczkownik is everybody's and costs nothing. */
export const PRICES: Record<WeaponId, number> = { pistol: 0, rifle: 1800, shotgun: 1200, sniper: 3500, grenade: 300 };
/** What can be bought, in the order of the shop's keys 1…4. */
export const SHOP: readonly WeaponId[] = ["rifle", "shotgun", "sniper", "grenade"];
export const MONEY_START = 800, MONEY_MAX = 10000, MONEY_WIN = 3000, MONEY_LOSS = 1700, MONEY_KILL = 300, MONEY_POINT = 300;
/** The shop is open through the freeze and this many seconds into the round. */
export const BUY_S = 15;

/** Downward pull on flying boxes (m/s²): light enough to read as a throw, not a mortar. */
export const BOX_GRAVITY = 5;
/** How long a box flies before it is cleared, seconds. */
export const BOX_LIFE_S = 2.5;

export const WEAPON_ORDER: readonly WeaponId[] = ["rifle", "pistol", "shotgun", "sniper", "grenade"];

/** The grenade falls faster than a thrown box, bursts on impact or when its fuse runs out, and reaches this far. */
export const GRENADE_GRAVITY = 14;
export const GRENADE_FUSE_S = 3;
export const GRENADE_R = 8;

/** The low throwing angle that lands a grenade `d` metres away and `dy` metres above the hand (negative = below). */
export function lobPitch(d: number, dy: number): number {
  const v = WEAPONS.grenade.speed, g = GRENADE_GRAVITY;
  const disc = v ** 4 - g * (g * d * d + 2 * dy * v * v);
  return disc <= 0 ? Math.PI / 4 : Math.atan((v * v - Math.sqrt(disc)) / (g * d));
}

export function falloff(w: WeaponDef, d: number): number {
  if (d >= w.range) return 0;
  const half = w.range / 2;
  return d <= half ? 1 : 1 - 0.5 * (d - half) / half;
}
