// Geometry-only helper: distance to the EXTERIOR boundary of the rendered tissue union (parts + anatomical bridge capsules).
// Surface samples that lie inside another rendered solid (a part buried in a bridge, a bridge cap buried in a part) are hidden and are NOT boundary.
// Sample spacing is subtracted from every distance, so the result is a conservative lower bound of the true exterior distance. Margins are never weakened.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { Field, FieldBridge } from "./field";
import { capsuleMesh } from "./sdfgen";

export interface SurfMesh { name: string; pos: ArrayLike<number>; idx: ArrayLike<number>; solid: boolean; }
export interface ExteriorStats { samples: number; maxDepth: number; nearFrac: number; mainCore: number; accepted: boolean; }
const SPACING = 0.006, RMAX = 0.16, GS = 0.009, HIDE_EPS = 0.002;

export function segDist(x: number, y: number, z: number, a: number[], b: number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], l2 = dx * dx + dy * dy + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / l2));
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t, z - a[2] - dz * t);
}
const mkBvh = (pos: ArrayLike<number>, idx: ArrayLike<number>) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(pos as ArrayLike<number>), 3)); g.setIndex(Array.from(idx as ArrayLike<number>)); return new MeshBVH(g); };

/** Exact Euclidean distance transform of the (node-quantised) exterior sample set on a coarse grid; queries use the rigorous Lipschitz lower bound
 *  d(p) >= max over the 8 surrounding nodes of (D_node - |p - node|) - quantisation - sample spacing, so every answer is <= the true exterior distance. O(1) per query, no ring scans. */
export class ExteriorIndex {
  stats: ExteriorStats; private D: Float32Array; private o = [0, 0, 0]; private n = [1, 1, 1]; private q = 0;
  constructor(public pts: Float32Array) {
    const np = pts.length / 3, mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (let i = 0; i < pts.length; i++) { const a = i % 3; mn[a] = Math.min(mn[a], pts[i]); mx[a] = Math.max(mx[a], pts[i]); }
    const pad = RMAX + 2 * GS; for (let a = 0; a < 3; a++) { this.o[a] = np ? mn[a] - pad : 0; this.n[a] = np ? Math.ceil((mx[a] - mn[a] + 2 * pad) / GS) + 1 : 1; }
    const [nx, ny, nz] = this.n, INF = 1e10, f = new Float32Array(nx * ny * nz).fill(INF);
    for (let i = 0; i < np; i++) f[(Math.round((pts[i * 3 + 2] - this.o[2]) / GS) * ny + Math.round((pts[i * 3 + 1] - this.o[1]) / GS)) * nx + Math.round((pts[i * 3] - this.o[0]) / GS)] = 0;
    this.q = 0.5 * Math.sqrt(3) * GS;  // a sample is within half a node diagonal of the node that stands for it
    const m = Math.max(nx, ny, nz), fl = new Float64Array(m), d = new Float64Array(m), z = new Float64Array(m + 1), v = new Int32Array(m);
    const line = (len: number) => { let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
      for (let qq = 1; qq < len; qq++) { let s = ((fl[qq] + qq * qq) - (fl[v[k]] + v[k] * v[k])) / (2 * qq - 2 * v[k]); while (s <= z[k]) { k--; s = ((fl[qq] + qq * qq) - (fl[v[k]] + v[k] * v[k])) / (2 * qq - 2 * v[k]); } k++; v[k] = qq; z[k] = s; z[k + 1] = Infinity; }
      k = 0; for (let qq = 0; qq < len; qq++) { while (z[k + 1] < qq) k++; d[qq] = (qq - v[k]) * (qq - v[k]) + fl[v[k]]; } };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const base = (k * ny + j) * nx; for (let i = 0; i < nx; i++) fl[i] = f[base + i]; line(nx); for (let i = 0; i < nx; i++) f[base + i] = d[i]; }
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { for (let j = 0; j < ny; j++) fl[j] = f[(k * ny + j) * nx + i]; line(ny); for (let j = 0; j < ny; j++) f[(k * ny + j) * nx + i] = d[j]; }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { for (let k = 0; k < nz; k++) fl[k] = f[(k * ny + j) * nx + i]; line(nz); for (let k = 0; k < nz; k++) f[(k * ny + j) * nx + i] = d[k]; }
    for (let i = 0; i < f.length; i++) f[i] = Math.min(RMAX + 2 * GS, Math.sqrt(f[i]) * GS);
    this.D = f; this.stats = { samples: np, maxDepth: 0, nearFrac: 0, mainCore: 0, accepted: false };
  }
  /** Conservative (never larger than the true) distance to the exterior boundary, capped near RMAX. */
  dist(x: number, y: number, z: number): number {
    const [nx, ny, nz] = this.n, fx = (x - this.o[0]) / GS, fy = (y - this.o[1]) / GS, fz = (z - this.o[2]) / GS, i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
    if (i0 < 0 || j0 < 0 || k0 < 0 || i0 + 1 >= nx || j0 + 1 >= ny || k0 + 1 >= nz) return RMAX;
    let best = -1e9; for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) { const val = this.D[((k0 + dk) * ny + (j0 + dj)) * nx + i0 + di] - GS * Math.hypot(fx - i0 - di, fy - j0 - dj, fz - k0 - dk); if (val > best) best = val; }
    return Math.max(0, Math.min(best, RMAX) - this.q - 0.7 * SPACING);
  }
}

/** Exterior surface samples of the rendered union. `hint(x,y,z)` (optional) marks capsule samples buried in solids whose parity is unreliable (the open cerebellum). */
export function buildExterior(parts: SurfMesh[], bridges: FieldBridge[], hint?: (x: number, y: number, z: number) => boolean): ExteriorIndex {
  const solids = parts.filter((p) => p.solid).map((p) => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (let i = 0; i < p.pos.length; i++) { const a = i % 3; mn[a] = Math.min(mn[a], p.pos[i]); mx[a] = Math.max(mx[a], p.pos[i]); } return { name: p.name, bvh: mkBvh(p.pos, p.idx), mn, mx }; });
  const ray = new THREE.Ray(), dir = new THREE.Vector3(0.5731, 0.3217, 0.7522).normalize();
  const inSolid = (x: number, y: number, z: number, skip: string) => { for (const s of solids) { if (s.name === skip || x < s.mn[0] || x > s.mx[0] || y < s.mn[1] || y > s.mx[1] || z < s.mn[2] || z > s.mx[2]) continue; ray.origin.set(x, y, z); ray.direction.copy(dir); if ((s.bvh.raycast(ray, THREE.DoubleSide) as unknown[]).length % 2 === 1) return true; } return false; };
  const inCap = (x: number, y: number, z: number, skipIdx: number) => { for (let i = 0; i < bridges.length; i++) if (i !== skipIdx && segDist(x, y, z, bridges[i].a, bridges[i].b) < bridges[i].r - HIDE_EPS) return true; return false; };
  const out: number[] = [], seen = new Set<number>(), inv = 1 / (SPACING * 0.75);
  const add = (x: number, y: number, z: number, skip: string, capIdx: number) => {
    const k = ((Math.floor(x * inv) + 1024) * 2048 + (Math.floor(y * inv) + 1024)) * 2048 + (Math.floor(z * inv) + 1024); if (seen.has(k)) return; seen.add(k);
    if (inCap(x, y, z, capIdx) || inSolid(x, y, z, skip) || (capIdx >= 0 && hint && hint(x, y, z))) return; out.push(x, y, z);
  };
  const tris = (pos: ArrayLike<number>, idx: ArrayLike<number>, skip: string, capIdx: number) => {
    for (let t = 0; t < idx.length; t += 3) {
      const A = idx[t] * 3, B = idx[t + 1] * 3, C = idx[t + 2] * 3, e = Math.max(Math.hypot(pos[A] - pos[B], pos[A + 1] - pos[B + 1], pos[A + 2] - pos[B + 2]), Math.hypot(pos[B] - pos[C], pos[B + 1] - pos[C + 1], pos[B + 2] - pos[C + 2]), Math.hypot(pos[A] - pos[C], pos[A + 1] - pos[C + 1], pos[A + 2] - pos[C + 2]));
      const n = Math.min(40, Math.max(1, Math.ceil(e / (SPACING * 0.8))));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) { const u = i / n, v = j / n, w = 1 - u - v; add(pos[A] * w + pos[B] * u + pos[C] * v, pos[A + 1] * w + pos[B + 1] * u + pos[C + 1] * v, pos[A + 2] * w + pos[B + 2] * u + pos[C + 2] * v, skip, capIdx); }
    }
  };
  for (const p of parts) tris(p.pos, p.idx, p.name, -1);
  bridges.forEach((b, i) => { const c = capsuleMesh(b.a, b.b, b.r); tris(c.pos, c.idx, "", i); });
  return new ExteriorIndex(new Float32Array(out));
}

/** Accept a shipped field only against the real exterior surface: it must never claim depth at the visible boundary, must hug it, and must have a real interior. */
export function acceptField(f: Field, e: ExteriorIndex): boolean {
  const n = e.pts.length / 3, step = Math.max(1, Math.floor(n / 6000)), tol = 3 * f.h; let seen = 0, near = 0, maxD = -1e9;
  for (let i = 0; i < n; i += step) { const d = f.depth(e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]); seen++; if (d > maxD) maxD = d; if (Math.abs(d) <= tol) near++; }
  const core = f.coreInfo(f.margin).main; e.stats.maxDepth = maxD; e.stats.nearFrac = seen ? near / seen : 0; e.stats.mainCore = core;
  return (e.stats.accepted = n > 1000 && maxD <= tol && e.stats.nearFrac >= 0.85 && core > 1000);
}
