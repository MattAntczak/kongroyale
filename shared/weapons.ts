// The cardboard launchers of efectivo ARENA (the Paczkownik throws barcode labels): every shot is a real little box that flies (with a touch of gravity) and
// hits whatever it meets first. Tunables only; the host applies them (shared/sim.ts), the client mirrors the cadence,
// spread and flight for feel.

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
  /** Cone half-angle (radians) standing still, and extra while moving or airborne. */
  spread: number;
  moveSpread: number;
  pellets: number;
  /** Full damage up to range / 2 of flight, falling to half at `range`; boxes are cleared beyond it. */
  range: number;
  reloadS: number;
  /** Camera kick per shot (radians). */
  kick: number;
  /** Muzzle speed of each box (m/s). */
  speed: number;
  /** Edge of each flying box (m), for the client's model. */
  size: number;
  /** Magnification of the sight on the right mouse button (1 = none). From 3 up it is a scope with its own view. */
  zoom: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: { name: "Kartonomiot", dmg: 17, headMul: 1.8, rpm: 560, auto: true, mag: 30, reserve: 120, spread: 0.008, moveSpread: 0.03, pellets: 1, range: 90, reloadS: 2.0, kick: 0.01, speed: 110, size: 0.13, zoom: 2 },
  pistol: { name: "Paczkownik", dmg: 16, headMul: 2.0, rpm: 300, auto: false, mag: 12, reserve: 999, spread: 0.005, moveSpread: 0.02, pellets: 1, range: 80, reloadS: 1.35, kick: 0.018, speed: 115, size: 0.11, zoom: 1.3 },
  shotgun: { name: "Paletówka", dmg: 15, headMul: 1.4, rpm: 70, auto: false, mag: 6, reserve: 24, spread: 0.07, moveSpread: 0.03, pellets: 8, range: 28, reloadS: 2.5, kick: 0.05, speed: 75, size: 0.09, zoom: 1 },
  // the long launcher with the scope: one heavy parcel at a time, slow to throw again, found on the map like the Paletówka
  sniper: { name: "Dalekomiot", dmg: 100, headMul: 2.0, rpm: 42, auto: false, mag: 5, reserve: 15, spread: 0.001, moveSpread: 0.06, pellets: 1, range: 230, reloadS: 2.8, kick: 0.05, speed: 240, size: 0.12, zoom: 4 },
  // the cardboard grenade: one bigger parcel thrown in an arc; it bursts where it lands (GRENADE_* below). `mag` is
  // how many a player carries, `dmg` the damage at the centre of the burst
  grenade: { name: "Kartonowy granat", dmg: 125, headMul: 1, rpm: 45, auto: false, mag: 2, reserve: 0, spread: 0.01, moveSpread: 0.02, pellets: 1, range: 70, reloadS: 0, kick: 0.03, speed: 24, size: 0.26, zoom: 1 },
};

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
/** Aiming through the sight steadies the launcher: the spread shrinks to this share. */
export const AIM_SPREAD = 0.35;

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
