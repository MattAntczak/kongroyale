// Messages between an efectivo ARENA client and its host (the Node server, or the in-browser host for bot matches).
// JSON over one WebSocket: up to ten players at 20 snapshots a second is small enough not to need a binary format.

import type { PickupKind } from "./map";
import type { WeaponId } from "./weapons";

export type Difficulty = "easy" | "normal" | "hard";
/** "server": the technicians connect a local server at A or B. "tags": they fit the watch tags at a station. */
export type Mission = "server" | "tags";

/** What the host of a room sets in the lobby. */
export interface Config {
  /** Bots in each team: [workers, technicians]. People come on top, up to 20 a team. */
  bots: [number, number];
  mission: Mission | "random";
  /** "depot": the railway depot (rooms around a track). "sort": the parcel sorting centre, a compact arena in the
   *  manner of a CS map. "hall": the big warehouse hall, one of its three configurations. */
  map: "depot" | "hall" | "sort";
  difficulty: Difficulty;
}

/** The state of the round. */
export interface ObjSnap {
  round: number;
  /** Rounds won by each lobby team, and whether the teams have traded roles (second half). */
  wins: [number, number]; swapped: boolean;
  /** Progress (0…1) of a connection being made, and of a disconnection. */
  plant: number; defuse: number;
  /** The point that is starting up (0 = A, 1 = B, -1 = none) and the seconds until it is up. */
  armed: number; boot: number;
  /** The case of watch tags when it lies on the floor. */
  case: [number, number] | null;
}

// client -> host
export type ClientMsg =
  | { t: "join"; name: string; room: string; /** 0 = workers, 1 = technicians, -1 = whichever has fewer people. */ team?: number }
  /** Our predicted position and view. `crouch`: crouched (when it is off the host checks there is room to stand). */
  | { t: "state"; x: number; y: number; z: number; yaw: number; pitch: number; moving: boolean; spawn: number; crouch?: boolean }
  /** A throw. The host decides its direction: the view (yaw, pitch, without the recoil punch) plus the host's own
   *  punch and spread for this player. `spd` and `air` are what the client saw (the host only lets them lower its
   *  own estimate a little); `sight`: through the sight; `n` numbers our throws, echoed in the "shot" event so the
   *  client can put its predicted boxes on the host's lines. */
  | { t: "shoot"; w: WeaponId; yaw: number; pitch: number; view: number; spd?: number; air?: boolean; sight?: boolean; n?: number }
  | { t: "reload" }
  | { t: "switch"; w: WeaponId }
  | { t: "chat"; text: string }
  /** Lobby: move to the other team; the host sets the shift up and starts it. */
  | { t: "team"; team: number }
  | { t: "config"; config: Config }
  | { t: "start" }
  /** Buy a launcher or a grenade (freeze time and the first seconds of a round). */
  | { t: "buy"; item: WeaponId }
  /** Holding E at the server (technicians). */
  | { t: "act"; on: boolean }
  /** E: get on the nearest forklift, or off the one we ride. */
  | { t: "use" }
  /** The driver's predicted forklift pose; `rev` is the last revision the host sent. */
  | { t: "drive"; x: number; z: number; yaw: number; speed: number; rev: number };

export interface PlayerSnap {
  id: number; n: string; bot: boolean; c: number;
  /** Role this half: 0 = warehouse workers, 1 = efectivo technicians. `g` is the lobby team (it never changes). */
  tm: number; g: number;
  /** Forklift ridden (-1 on foot) and seat (0 driver, 1 thrower). */
  veh: number; seat: number;
  /** Carrying a case of watch tags: their UWB signal shows on everyone's Live map. */
  carry: boolean;
  x: number; y: number; z: number; yaw: number; pitch: number;
  /** Crouched: drawn low, and hit with the shorter body. */
  crouch: boolean;
  hp: number; alive: boolean; w: WeaponId; k: number; d: number;
  /** Seconds since this player last fired (shows them on the Live map). */
  fired: number;
}

export interface VehicleSnap {
  id: number; x: number; z: number; yaw: number; speed: number;
  /** Driver and thrower ids, 0 when the seat is empty. */
  d: number; g: number;
}

export interface SelfSnap {
  hp: number; alive: boolean; w: WeaponId; team: number; group: number;
  veh: number; seat: number;
  /** Revision of our forklift's pose: when it changes, the driver takes the host's pose. */
  vrev: number;
  mag: Record<WeaponId, number>; res: Record<WeaponId, number>; owned: WeaponId[];
  /** Bumped every respawn and every forced correction: the client takes the host's position when it changes. */
  spawn: number; x: number; y: number; z: number; yaw: number;
  reloading: boolean; geo: number; killedBy: string; carry: boolean;
  /** Money for the shop, and whether the shop is open right now. */
  money: number; buy: boolean;
}

export type Ev =
  | { k: "shot"; id: number; w: WeaponId; o: [number, number, number]; /** Unit launch direction of each box, xyz. */ dirs: number[]; /** The shooter's own throw number (people only). */ n?: number }
  | { k: "hit"; by: number; on: number; dmg: number; head: boolean; x: number; y: number; z: number }
  | { k: "kill"; by: number; on: number; w: WeaponId; head: boolean }
  | { k: "pick"; id: number; p: number; kind: PickupKind }
  | { k: "ride"; id: number; /** -1 = got off */ veh: number; seat: number }
  | { k: "join"; name: string }
  | { k: "leave"; name: string }
  | { k: "chat"; name: string; text: string }
  /** A cardboard grenade burst here. */
  | { k: "boom"; x: number; y: number; z: number }
  | { k: "obj"; what: "plant" | "armed" | "defuse" | "defused" | "casepick" | "casedrop"; id: number; /** 0 = A, 1 = B */ site: number }
  | { k: "round"; n: number; swapped: boolean }
  /** `winner` is the role that won the round (0 workers, 1 technicians), `group` the lobby team that got the point. */
  | { k: "roundEnd"; winner: number; group: number; reason: "plant" | "defuse" | "time" | "out"; wins: [number, number] }
  /** The match is over: the lobby team that won it. */
  | { k: "end"; group: number; wins: [number, number]; mvp: string }
  | { k: "start"; layout: number; mission: Mission }
  | { k: "lobby" };

// host -> client
export type HostMsg =
  | { t: "welcome"; id: number; room: string }
  | { t: "snap"; time: number; phase: "lobby" | "brief" | "freeze" | "play" | "round" | "end"; left: number; layout: number; mission: Mission; obj: ObjSnap; config: Config; host: number; /** Team eliminations [Grupa A, Grupa B]. */ score: [number, number]; players: PlayerSnap[]; vehicles: VehicleSnap[]; pickups: boolean[]; me: SelfSnap }
  | { t: "ev"; evs: Ev[] }
  | { t: "error"; text: string };
