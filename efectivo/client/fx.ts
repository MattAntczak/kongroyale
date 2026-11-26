// Short-lived effects: bullet tracers, impact sparks and the muzzle flash light. Everything is pooled up front so a
// firefight allocates nothing per shot.

import * as THREE from "three";

const MAX_TRACERS = 96;
const MAX_SPARKS = 600;

export class Fx {
  private tracerGeo = new THREE.BufferGeometry();
  private tracerPos = new Float32Array(MAX_TRACERS * 6);
  private tracerCol = new Float32Array(MAX_TRACERS * 6);
  private tracerLife = new Float32Array(MAX_TRACERS);
  private tracerNext = 0;
  private sparkGeo = new THREE.BufferGeometry();
  private sparkPos = new Float32Array(MAX_SPARKS * 3);
  private sparkVel = new Float32Array(MAX_SPARKS * 3);
  private sparkCol = new Float32Array(MAX_SPARKS * 3);
  private sparkLife = new Float32Array(MAX_SPARKS);
  private sparkNext = 0;
  private flash: THREE.PointLight;
  private flashLife = 0;

  constructor(scene: THREE.Scene) {
    this.tracerGeo.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3));
    this.tracerGeo.setAttribute("color", new THREE.BufferAttribute(this.tracerCol, 3));
    const lines = new THREE.LineSegments(this.tracerGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    lines.frustumCulled = false;
    scene.add(lines);
    this.sparkGeo.setAttribute("position", new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkGeo.setAttribute("color", new THREE.BufferAttribute(this.sparkCol, 3));
    const pts = new THREE.Points(this.sparkGeo, new THREE.PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.frustumCulled = false;
    scene.add(pts);
    this.flash = new THREE.PointLight(0xffc27a, 0, 9, 2);
    scene.add(this.flash);
  }

  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, mine: boolean) {
    const i = this.tracerNext; this.tracerNext = (i + 1) % MAX_TRACERS;
    // start a little ahead of the muzzle so our own tracer does not fill the screen
    const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz) || 1;
    const s = Math.min(mine ? 1.2 : 0.4, d * 0.5);
    this.tracerPos.set([ax + dx / d * s, ay + dy / d * s, az + dz / d * s, bx, by, bz], i * 6);
    this.tracerLife[i] = 0.07;
    this.paintTracer(i, 1);
  }

  private paintTracer(i: number, a: number) {
    const c = this.tracerCol;
    c[i * 6] = 1 * a; c[i * 6 + 1] = 0.85 * a; c[i * 6 + 2] = 0.55 * a;
    c[i * 6 + 3] = 1 * a * 0.4; c[i * 6 + 4] = 0.8 * a * 0.4; c[i * 6 + 5] = 0.5 * a * 0.4;
  }

  sparks(x: number, y: number, z: number, n: number, warm: boolean) {
    for (let k = 0; k < n; k++) {
      const i = this.sparkNext; this.sparkNext = (i + 1) % MAX_SPARKS;
      this.sparkPos[i * 3] = x; this.sparkPos[i * 3 + 1] = y; this.sparkPos[i * 3 + 2] = z;
      this.sparkVel[i * 3] = (Math.random() - 0.5) * 4; this.sparkVel[i * 3 + 1] = Math.random() * 3; this.sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 4;
      this.sparkLife[i] = 0.25 + Math.random() * 0.25;
      if (warm) { this.sparkCol[i * 3] = 1; this.sparkCol[i * 3 + 1] = 0.7; this.sparkCol[i * 3 + 2] = 0.3; }
      else { this.sparkCol[i * 3] = 0.9; this.sparkCol[i * 3 + 1] = 0.15; this.sparkCol[i * 3 + 2] = 0.12; }
    }
  }

  muzzle(x: number, y: number, z: number) {
    this.flash.position.set(x, y, z);
    this.flash.intensity = 6;
    this.flashLife = 0.05;
  }

  update(dt: number) {
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.tracerLife[i] <= 0) continue;
      this.tracerLife[i] -= dt;
      if (this.tracerLife[i] <= 0) { this.tracerPos.fill(0, i * 6, i * 6 + 6); this.paintTracer(i, 0); }
      else this.paintTracer(i, this.tracerLife[i] / 0.07);
    }
    this.tracerGeo.attributes.position.needsUpdate = true;
    this.tracerGeo.attributes.color.needsUpdate = true;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      if (this.sparkLife[i] <= 0) { this.sparkPos[i * 3 + 1] = -100; continue; }
      this.sparkVel[i * 3 + 1] -= 9.8 * dt;
      this.sparkPos[i * 3] += this.sparkVel[i * 3] * dt;
      this.sparkPos[i * 3 + 1] += this.sparkVel[i * 3 + 1] * dt;
      this.sparkPos[i * 3 + 2] += this.sparkVel[i * 3 + 2] * dt;
    }
    this.sparkGeo.attributes.position.needsUpdate = true;
    if (this.flashLife > 0) { this.flashLife -= dt; if (this.flashLife <= 0) this.flash.intensity = 0; }
  }
}
