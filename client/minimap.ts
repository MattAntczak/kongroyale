// The efectivo Live map in the HUD corner: the hall drawn like the efectivo dashboard (zones, racks, stock), your
// own tag, your group's tags always (their UWB tags are on our network), and enemies only while they are firing —
// or all of them while efectivo GEO runs.

import { BOXES, HALL, LAYOUT, ZONES, sites } from "../shared/map";
import type { PlayerSnap } from "../shared/proto";
import type { VehicleState } from "../shared/vehicle";

// the map is 544 px wide; its height and scale follow the current building
const W = 544;
let H = 0, sx = 1, sz = 1, sized = -1;
function size() {
  if (sized === LAYOUT) return;
  sized = LAYOUT;
  H = Math.round(W * (HALL.z1 - HALL.z0) / (HALL.x1 - HALL.x0));
  sx = W / (HALL.x1 - HALL.x0); sz = H / (HALL.z1 - HALL.z0);
}
const X = (x: number) => (x - HALL.x0) * sx, Z = (z: number) => (z - HALL.z0) * sz;
const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

const bases: (HTMLCanvasElement | undefined)[] = [];

function drawBase(): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f8fafc"; g.fillRect(0, 0, W, H);
  for (const zn of ZONES) {
    g.fillStyle = zn.color + "1a"; g.fillRect(X(zn.x0), Z(zn.z0), (zn.x1 - zn.x0) * sx, (zn.z1 - zn.z0) * sz);
    g.strokeStyle = zn.color + "66"; g.lineWidth = 1; g.strokeRect(X(zn.x0) + 0.5, Z(zn.z0) + 0.5, (zn.x1 - zn.x0) * sx - 1, (zn.z1 - zn.z0) * sz - 1);
  }
  for (const b of BOXES) {
    if (b.kind === "wall" && (b.x1 <= HALL.x0 || b.x0 >= HALL.x1 || b.z1 <= HALL.z0 || b.z0 >= HALL.z1)) continue;
    if (b.y0 > 2) continue;
    g.fillStyle = b.kind === "wall" ? (b.color ? "#7ea6bd" : "#475569") : b.kind === "block" ? hex(b.color ?? 0x94a3b8) : b.climb ? "#474fff" : b.kind === "rack" ? "#cbd5e1" : b.kind === "column" || b.kind === "panel" ? "#94a3b8" : b.kind === "server" ? "#0f172a" : "#e2e8f0";
    g.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * sx, (b.z1 - b.z0) * sz);
  }
  return c;
}

const TEAM_RGB = ["255,106,0", "71,79,255"];

/** What the round adds to the map: the case on the floor, the point that is starting up. */
export interface MapMission { mission: "server" | "tags"; case: [number, number] | null; armed: number }

export function drawMinimap(ctx: CanvasRenderingContext2D, players: PlayerSnap[], vehicles: VehicleState[], myId: number, myTeam: number, me: { x: number; z: number; yaw: number }, geo: boolean, t: number, mm: MapMission) {
  size();
  if (ctx.canvas.height !== H) { ctx.canvas.height = H; ctx.canvas.style.height = `${Math.round(280 * H / W)}px`; }
  const base = bases[LAYOUT] ?? (bases[LAYOUT] = drawBase());
  ctx.drawImage(base, 0, 0);
  // points A and B (the one that is starting up pulses), and the case of tags when it lies on the floor
  sites(mm.mission).forEach((p, i) => {
    if (mm.armed === i) { const k = (t * 1.5) % 1; ctx.strokeStyle = `rgba(240,68,56,${1 - k})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), 10 + k * 28, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = mm.armed === i ? "#f04438" : "#0f172a"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(X(p.x) - 11, Z(p.z) - 11, 22, 22, 5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "700 15px Inter, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("AB"[i], X(p.x), Z(p.z) + 1);
  });
  if (mm.case) { ctx.fillStyle = "#f59e0b"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(mm.case[0]), Z(mm.case[1]), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  // forklifts: small dark bodies, like the vehicle markers on the Live map
  for (const v of vehicles) {
    ctx.save(); ctx.translate(X(v.x), Z(v.z)); ctx.rotate(-v.yaw);
    ctx.fillStyle = "#1e293b"; ctx.beginPath(); ctx.roundRect(-2.6 * sx / 2, -1.3 * sz / 2, 2.6 * sx, 1.3 * sz, 3); ctx.fill();
    ctx.fillStyle = "#f59e0b"; ctx.fillRect(2.6 * sx / 2 - 3, -1.3 * sz / 2 + 2, 3, 1.3 * sz - 4);
    ctx.restore();
  }
  for (const p of players) {
    if (p.id === myId || !p.alive) continue;
    if (p.tm === myTeam) {
      ctx.fillStyle = `rgba(${TEAM_RGB[p.tm & 1]},1)`;
      ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
      continue;
    }
    // whoever carries watch tags is on the UWB network: always visible
    const show = geo || p.carry || p.fired < 0.8;
    if (!show) continue;
    const a = geo || p.carry ? 1 : 1 - p.fired / 0.8;
    ctx.fillStyle = `rgba(240,68,56,${0.18 * a})`;
    ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(240,68,56,${a})`;
    ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), 5, 0, Math.PI * 2); ctx.fill();
  }
  // own tag: an accent dot with a pulsing halo and a view cone
  const mx = X(me.x), mz = Z(me.z);
  const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
  const cone = ctx.createRadialGradient(mx, mz, 0, mx, mz, 60);
  cone.addColorStop(0, "rgba(71,79,255,0.45)"); cone.addColorStop(1, "rgba(71,79,255,0)");
  ctx.fillStyle = cone;
  ctx.beginPath(); ctx.moveTo(mx, mz);
  const a0 = Math.atan2(fz, fx);
  ctx.arc(mx, mz, 60, a0 - 0.55, a0 + 0.55); ctx.closePath(); ctx.fill();
  const pulse = (t * 0.8) % 1;
  ctx.strokeStyle = `rgba(71,79,255,${0.7 * (1 - pulse)})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(mx, mz, 6 + pulse * 16, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowColor = "rgba(71,79,255,0.9)"; ctx.shadowBlur = 10;
  ctx.fillStyle = myTeam === 0 ? "#ff6a00" : "#474fff"; ctx.beginPath(); ctx.arc(mx, mz, 6, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mx, mz, 6, 0, Math.PI * 2); ctx.stroke();
}
