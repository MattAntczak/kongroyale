// Weapon stats for efectivo ARENA. Tunables only; the host applies them (shared/sim.ts), the client mirrors the cadence
// and spread for feel.

export type WeaponId = "rifle" | "pistol" | "shotgun";

export interface WeaponDef {
  name: string;
  /** Damage per pellet at close range. */
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
  /** Full damage up to range / 2, falling to half at `range`, nothing beyond. */
  range: number;
  reloadS: number;
  /** Camera kick per shot (radians). */
  kick: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: { name: "Karabin", dmg: 17, headMul: 1.8, rpm: 620, auto: true, mag: 30, reserve: 120, spread: 0.008, moveSpread: 0.03, pellets: 1, range: 90, reloadS: 2.0, kick: 0.012 },
  pistol: { name: "Pistolet", dmg: 25, headMul: 2.0, rpm: 380, auto: false, mag: 12, reserve: 999, spread: 0.005, moveSpread: 0.02, pellets: 1, range: 70, reloadS: 1.35, kick: 0.02 },
  shotgun: { name: "Strzelba", dmg: 12, headMul: 1.4, rpm: 72, auto: false, mag: 6, reserve: 24, spread: 0.065, moveSpread: 0.03, pellets: 9, range: 28, reloadS: 2.5, kick: 0.06 },
};

export const WEAPON_ORDER: readonly WeaponId[] = ["rifle", "pistol", "shotgun"];

export function falloff(w: WeaponDef, d: number): number {
  if (d >= w.range) return 0;
  const half = w.range / 2;
  return d <= half ? 1 : 1 - 0.5 * (d - half) / half;
}
