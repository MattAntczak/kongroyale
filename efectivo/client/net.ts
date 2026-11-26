// The client's link to a host. A bot match runs the Sim right here in the page (LocalLink); an online room talks to
// efectivo/server.ts over a WebSocket (WsLink). The game only ever sees the Link interface, so both behave the same.

import { Sim, TICK_HZ } from "../shared/sim";
import type { ClientMsg, Difficulty, HostMsg } from "../shared/proto";

export interface Link {
  send(m: ClientMsg): void;
  onMessage: (m: HostMsg) => void;
  onClose: (reason: string) => void;
  close(): void;
}

export class LocalLink implements Link {
  onMessage: (m: HostMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private sim: Sim;
  private id = 0;
  private timer = 0;
  private last = performance.now();
  private acc = 0;
  private tick = 0;

  constructor(name: string, difficulty: Difficulty, bots: number) {
    this.sim = new Sim({ bots: true, difficulty, seed: (Math.random() * 2 ** 31) | 0, maxPlayers: bots + 1 });
    this.id = this.sim.addHuman(name);
    queueMicrotask(() => this.onMessage({ t: "welcome", id: this.id, room: "LOKALNY", fragLimit: 25 }));
    this.timer = window.setInterval(() => this.run(), 4);
  }

  private run() {
    const now = performance.now();
    this.acc += Math.min(250, now - this.last) / 1000;
    this.last = now;
    let steps = 0;
    while (this.acc >= 1 / TICK_HZ && steps++ < 6) {
      this.acc -= 1 / TICK_HZ;
      this.sim.step(1 / TICK_HZ);
      this.tick++;
      const evs = this.sim.drainEvents();
      if (evs.length) this.onMessage({ t: "ev", evs });
      if (this.tick % 3 === 0) { const s = this.sim.snapshot(this.id); if (s) this.onMessage(s); }
    }
  }

  send(m: ClientMsg) { this.sim.receive(this.id, m); }
  close() { clearInterval(this.timer); }
}

export class WsLink implements Link {
  onMessage: (m: HostMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private ws: WebSocket;
  private closed = false;

  constructor(name: string, room: string) {
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/efws";
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.send({ t: "join", name, room });
    this.ws.onmessage = (e) => { try { this.onMessage(JSON.parse(String(e.data))); } catch { /* ignore a bad frame */ } };
    this.ws.onclose = () => { if (!this.closed) this.onClose("Połączenie z serwerem zostało zerwane."); };
    this.ws.onerror = () => { if (!this.closed) this.onClose("Nie można połączyć się z serwerem efectivo ARENA."); this.closed = true; };
  }

  send(m: ClientMsg) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  close() { this.closed = true; this.ws.close(); }
}
