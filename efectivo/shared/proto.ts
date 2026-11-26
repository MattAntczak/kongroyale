// Messages between an efectivo ARENA client and its host (the Node server, or the in-browser host for bot matches).
// JSON over one WebSocket: eight players at 20 snapshots a second is small enough not to need a binary format.

import type { PickupKind } from "./map";
import type { WeaponId } from "./weapons";

export type Difficulty = "easy" | "normal" | "hard";

// client -> host
export type ClientMsg =
  | { t: "join"; name: string; room: string }
  | { t: "state"; x: number; y: number; z: number; yaw: number; pitch: number; moving: boolean; spawn: number }
  | { t: "shoot"; w: WeaponId; yaw: number; pitch: number; dirs: number[]; view: number }
  | { t: "reload" }
  | { t: "switch"; w: WeaponId }
  | { t: "chat"; text: string };

export interface PlayerSnap {
  id: number; n: string; bot: boolean; c: number;
  x: number; y: number; z: number; yaw: number; pitch: number;
  hp: number; alive: boolean; w: WeaponId; k: number; d: number;
  /** Seconds since this player last fired (shows them on the Live map). */
  fired: number;
}

export interface SelfSnap {
  hp: number; alive: boolean; w: WeaponId;
  mag: Record<WeaponId, number>; res: Record<WeaponId, number>; owned: WeaponId[];
  /** Bumped every respawn and every forced correction: the client takes the host's position when it changes. */
  spawn: number; x: number; y: number; z: number; yaw: number;
  reloading: boolean; respawnIn: number; geo: number; killedBy: string;
}

export type Ev =
  | { k: "shot"; id: number; w: WeaponId; o: [number, number, number]; ends: number[] }
  | { k: "hit"; by: number; on: number; dmg: number; head: boolean; x: number; y: number; z: number }
  | { k: "kill"; by: number; on: number; w: WeaponId; head: boolean }
  | { k: "pick"; id: number; p: number; kind: PickupKind }
  | { k: "join"; name: string }
  | { k: "leave"; name: string }
  | { k: "chat"; name: string; text: string }
  | { k: "end"; winner: string }
  | { k: "start" };

// host -> client
export type HostMsg =
  | { t: "welcome"; id: number; room: string; fragLimit: number }
  | { t: "snap"; time: number; phase: "play" | "end"; left: number; players: PlayerSnap[]; pickups: boolean[]; me: SelfSnap }
  | { t: "ev"; evs: Ev[] }
  | { t: "error"; text: string };
