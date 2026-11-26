// The cardboard launchers of efectivo ARENA: every shot is a real little box that flies (with a touch of gravity) and
// hits whatever it meets first. Tunables only; the host applies them (shared/sim.ts), the client mirrors the cadence,
// spread and flight for feel.

export type WeaponId = "rifle" | "pistol" | "shotgun";

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
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: { name: "Kartonomiot", dmg: 17, headMul: 1.8, rpm: 560, auto: true, mag: 30, reserve: 120, spread: 0.008, moveSpread: 0.03, pellets: 1, range: 90, reloadS: 2.0, kick: 0.01, speed: 75, size: 0.13 },
  pistol: { name: "Paczkownik", dmg: 25, headMul: 2.0, rpm: 360, auto: false, mag: 12, reserve: 999, spread: 0.005, moveSpread: 0.02, pellets: 1, range: 70, reloadS: 1.35, kick: 0.018, speed: 85, size: 0.11 },
  shotgun: { name: "Paletówka", dmg: 13, headMul: 1.4, rpm: 70, auto: false, mag: 6, reserve: 24, spread: 0.07, moveSpread: 0.03, pellets: 8, range: 28, reloadS: 2.5, kick: 0.05, speed: 55, size: 0.09 },
};

/** Downward pull on flying boxes (m/s²): light enough to read as a throw, not a mortar. */
export const BOX_GRAVITY = 5;
/** How long a box flies before it is cleared, seconds. */
export const BOX_LIFE_S = 2.5;

export const WEAPON_ORDER: readonly WeaponId[] = ["rifle", "pistol", "shotgun"];

export function falloff(w: WeaponDef, d: number): number {
  if (d >= w.range) return 0;
  const half = w.range / 2;
  return d <= half ? 1 : 1 - 0.5 * (d - half) / half;
}
