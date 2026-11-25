// Containment: everything that glows stays inside the brain. Pure functions on the signed distance field (no three.js, no DOM), shared by the
// scene and by the node tests that run them against the real brain asset.
//  - clipMorph: truncate neuron branches where they would cross the margin (descendants dropped)
//  - Router: white-matter-like routing of wikilinks through the interior (corpus callosum between hemispheres, peduncles to the cerebellum)
//  - containSomas / insetSurfacePoints: projection of positions into the interior
import { Field, V3 } from "./field";
import { Morph, GROUPS, KIND_DENDRITE } from "./morph";

/** Samples closer together than this (fraction of a voxel) are verified on every polyline; tests sample at 0.5 voxel. */
export const VERIFY_STEP = 0.25;
/** Extra depth the generators require on top of the margin so the test lattice (different sample positions) can never find a violation. */
export const SLACK = 0.2; // voxels

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------- arbors
export interface ClipResult { morph: Morph; cut: number; dropped: number; }
/** Truncate every branch at the first point whose depth drops below `minDepth`; the part beyond (and all descendants) is removed. `base` = soma position. */
export function clipMorph(m: Morph, base: V3, f: Field, minDepth = f.margin + SLACK * f.h): ClipResult {
  const n = m.n, state = new Uint8Array(n), pos = new Float32Array(m.pos), step = f.h * VERIFY_STEP; let cut = 0, dropped = 0; state[0] = 1;
  for (let i = 1; i < n; i++) {
    const p = m.parent[i]; if (state[p] !== 1) { state[i] = 0; dropped++; continue; }
    const ax = base[0] + pos[p * 3], ay = base[1] + pos[p * 3 + 1], az = base[2] + pos[p * 3 + 2], dx = m.pos[i * 3] - pos[p * 3], dy = m.pos[i * 3 + 1] - pos[p * 3 + 1], dz = m.pos[i * 3 + 2] - pos[p * 3 + 2];
    const len = Math.hypot(dx, dy, dz), ns = Math.max(1, Math.ceil(len / step)); let good = ns;
    for (let s = 1; s <= ns; s++) { const t = s / ns; if (f.depthE(ax + dx * t, ay + dy * t, az + dz * t) < minDepth) { good = s - 1; break; } }
    if (good === ns) { state[i] = 1; continue; }
    const t = good / ns;
    if (t * len < step * 2) { state[i] = 0; dropped++; cut++; continue; } // nothing meaningful survives of this segment
    pos[i * 3] = pos[p * 3] + dx * t; pos[i * 3 + 1] = pos[p * 3 + 1] + dy * t; pos[i * 3 + 2] = pos[p * 3 + 2] + dz * t; state[i] = 2; cut++;
  }
  if (!cut && !dropped) return { morph: m, cut: 0, dropped: 0 };
  const map = new Int32Array(n).fill(-1); let k = 0; for (let i = 0; i < n; i++) if (state[i]) map[i] = k++;
  const pp = new Float32Array(k * 3), rad = new Float32Array(k), parent = new Int32Array(k), kind = new Uint8Array(k), s = new Float32Array(k), group = new Uint8Array(k), gmax = new Float32Array(GROUPS + 1), cc = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const j = map[i]; if (j < 0) continue;
    pp.set([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], j * 3); rad[j] = m.rad[i]; kind[j] = m.kind[i]; group[j] = m.group[i]; parent[j] = i === 0 ? -1 : map[m.parent[i]];
    if (j > 0) { const q = parent[j]; s[j] = s[q] + dist([pp[j * 3], pp[j * 3 + 1], pp[j * 3 + 2]], [pp[q * 3], pp[q * 3 + 1], pp[q * 3 + 2]]); cc[q]++; if (kind[j] === KIND_DENDRITE) gmax[group[j]] = Math.max(gmax[group[j]], s[j]); else gmax[GROUPS] = Math.max(gmax[GROUPS], s[j]); }
  }
  const axonTerminals: number[] = [], dendTips: number[] = []; let dendSegments = 0;
  for (let j = 1; j < k; j++) { if (kind[j] === KIND_DENDRITE) dendSegments++; if (cc[j] === 0) (kind[j] === KIND_DENDRITE ? dendTips : axonTerminals).push(j); }
  return { morph: { ...m, n: k, pos: pp, rad, parent, kind, s, group, gmax, axonTerminals, dendTips, segments: k - 1, dendSegments }, cut, dropped };
}
/** Absolute positions of every node of a morph. */
export function morphWorldPoints(m: Morph, base: V3): V3[] { const o: V3[] = []; for (let i = 0; i < m.n; i++) o.push([base[0] + m.pos[i * 3], base[1] + m.pos[i * 3 + 1], base[2] + m.pos[i * 3 + 2]]); return o; }

// ---------------------------------------------------------------- polylines
export function polyLength(p: V3[]) { let l = 0; for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]); return l; }
/** Resample at (about) uniform spacing; endpoints kept. */
export function resample(p: V3[], spacing: number): V3[] {
  const L = polyLength(p), n = Math.max(1, Math.ceil(L / spacing)), out: V3[] = [[p[0][0], p[0][1], p[0][2]]]; if (L < 1e-9) { out.push([p[p.length - 1][0], p[p.length - 1][1], p[p.length - 1][2]]); return out; }
  let seg = 0, acc = 0;
  for (let k = 1; k < n; k++) {
    const target = (k / n) * L; while (seg < p.length - 2 && acc + dist(p[seg], p[seg + 1]) < target) { acc += dist(p[seg], p[seg + 1]); seg++; }
    const sl = dist(p[seg], p[seg + 1]) || 1e-12, t = Math.min(1, Math.max(0, (target - acc) / sl)); out.push([p[seg][0] + (p[seg + 1][0] - p[seg][0]) * t, p[seg][1] + (p[seg + 1][1] - p[seg][1]) * t, p[seg][2] + (p[seg + 1][2] - p[seg][2]) * t]);
  }
  out.push([p[p.length - 1][0], p[p.length - 1][1], p[p.length - 1][2]]); return out;
}
/** Minimum depth over a polyline sampled at `stepWorld` spacing (default VERIFY_STEP voxels). */
export function minDepthAlong(f: Field, p: V3[], stepWorld = f.h * VERIFY_STEP): number {
  let m = Infinity;
  for (let i = 0; i < p.length; i++) {
    m = Math.min(m, f.depthE(p[i][0], p[i][1], p[i][2])); if (i === 0) continue;
    const a = p[i - 1], b = p[i], l = dist(a, b), n = Math.ceil(l / stepWorld);
    for (let s = 1; s < n; s++) { const t = s / n; m = Math.min(m, f.depthE(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)); }
  }
  return m;
}
function catmull(w: V3[], per = 16): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < w.length - 1; i++) {
    const p0 = w[Math.max(0, i - 1)], p1 = w[i], p2 = w[i + 1], p3 = w[Math.min(w.length - 1, i + 2)];
    for (let s = 0; s < per; s++) { const t = s / per, t2 = t * t, t3 = t2 * t; out.push([0, 1, 2].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)) as V3); }
  }
  out.push([w[w.length - 1][0], w[w.length - 1][1], w[w.length - 1][2]]); return out;
}
const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------------------------------------------------------------- routing
export type Region3 = "L" | "R" | "C";
export interface RouteResult { pts: V3[]; length: number; astar: boolean; ok: boolean; minDepth: number; }
interface Anchors { ccArch: V3[]; th: Record<number, V3>; up: Record<number, V3>; bsTop: V3 | null; cbA: Record<number, V3>; cbMid: Record<number, V3>; cbEnd: Record<number, V3>; core: Record<number, V3>; cbCore: V3; cx: number; }

/** Routes links through the interior. Same hemisphere: bow toward the hemisphere's deep core. Across hemispheres: through the corpus callosum arch. Cerebrum to
 *  cerebellum: via the diencephalon, brainstem and cerebellar peduncle. Violating samples are pushed inward along the depth gradient, smoothed, re-projected and
 *  verified; if that still fails an A* search on the voxel grid (preferring depth) is used. */
const f0 = (f: Field) => !!f.r6;
export class Router {
  private walkC?: Int8Array;
  readonly an: Anchors;
  stats = { routes: 0, pushed: 0, astar: 0, failed: 0, bowed: 0 };
  private stamp: Int32Array | null = null; private closedStamp: Int32Array | null = null; private gScore: Float32Array | null = null; private from: Int32Array | null = null; private tick = 0;
  constructor(readonly f: Field) { this.an = this.anchors(); }
  private anchors(): Anchors {
    const f = this.f, B = f.bridges, cc = B.filter((b) => b.name === "cc"), mid = (b: { a: V3; b: V3 }): V3 => [(b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2, (b.a[2] + b.b[2]) / 2];
    const ccArch = cc.map(mid).sort((a, b) => a[2] - b[2]);
    const cx = ccArch.length ? ccArch[0][0] : (f.origin[0] + f.dims[0] * f.h / 2);
    const th: Record<number, V3> = {}, up: Record<number, V3> = {}, cbA: Record<number, V3> = {}, cbMid: Record<number, V3> = {}, cbEnd: Record<number, V3> = {}; let bsTop: V3 | null = null;
    const di = B.filter((b) => b.name === "dienc"); for (let i = 0; i + 1 < di.length; i += 2) { const s = di[i].b[0] < cx ? -1 : 1; bsTop = di[i].a; th[s] = di[i].b; up[s] = di[i + 1].b; }
    const cb = B.filter((b) => b.name === "cbp"); for (let i = 0; i + 1 < cb.length; i += 2) { const s = cb[i].b[0] < cx ? -1 : 1; cbA[s] = cb[i].a; cbMid[s] = cb[i].b; cbEnd[s] = cb[i + 1].b; }
    // deep core of each hemisphere / cerebellum: mean of the deepest voxels of the main core on that side
    const core: Record<number, V3> = {}; const acc: Record<string, number[]> = { "-1": [0, 0, 0, 0], "1": [0, 0, 0, 0], c: [0, 0, 0, 0] }; const c: V3 = [0, 0, 0], [nx, ny, nz] = f.dims, thr = Math.round(0.11 / f.h * f.q);
    const ends = cb.filter((_, i) => i % 2 === 1).map((b) => b.b), cbc: V3 | null = ends.length ? [ends.reduce((a, b) => a + b[0], 0) / ends.length, ends.reduce((a, b) => a + b[1], 0) / ends.length, ends.reduce((a, b) => a + b[2], 0) / ends.length] : null;
    for (let v = 0; v < nx * ny * nz; v += 3) { if (f.data[v] < thr) continue; f.centerOf(v, c); if (!f.inMainCore(c, f.margin)) continue; const inCb = cbc && c[1] < cbc[1] + 0.14 && c[2] < (bsTop ? bsTop[2] - 0.1 : -0.25) ; const a = inCb ? acc.c : acc[c[0] < cx ? "-1" : "1"]; a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; a[3]++; }
    for (const s of [-1, 1]) { const a = acc[String(s)]; core[s] = a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : [cx + s * 0.25, 0.05, 0]; }
    const cbCore: V3 = acc.c[3] ? [acc.c[0] / acc.c[3], acc.c[1] / acc.c[3], acc.c[2] / acc.c[3]] : (cbc ?? [cx, -0.6, -0.5]);
    return { ccArch, th, up, bsTop, cbA, cbMid, cbEnd, core, cbCore, cx };
  }
  /** Skeleton waypoints (the tract) for a link; the smooth curve through them is then made valid. */
  private waypoints(p0: V3, p1: V3, r0: Region3, r1: Region3): V3[] {
    const a = this.an, side = (r: Region3, p: V3) => (r === "C" ? (p[0] < a.cx ? -1 : 1) : r === "L" ? -1 : 1);
    if (r0 !== "C" && r1 !== "C") {
      if (r0 === r1) { const c = a.core[side(r0, p0)], m = mix(p0, p1, 0.5), d = dist(p0, p1), l = dist(m, c) || 1, k = Math.min(0.45 * d, 0.9 * l) / l; return [p0, mix(p0, mix(m, c, k), 0.5), mix(m, c, k), mix(mix(m, c, k), p1, 0.5), p1]; }
      const arch = a.ccArch; if (!arch.length) return [p0, mix(p0, p1, 0.5), p1];
      const zc = Math.min(arch[arch.length - 1][2], Math.max(arch[0][2], (p0[2] + p1[2]) / 2)); let j = 0; while (j < arch.length - 2 && arch[j + 1][2] < zc) j++;
      const t = (zc - arch[j][2]) / ((arch[j + 1][2] - arch[j][2]) || 1), m = mix(arch[j], arch[j + 1], Math.min(1, Math.max(0, t))), s0 = side(r0, p0), s1 = side(r1, p1);
      const e0: V3 = [a.cx + s0 * 0.09, m[1], m[2]], e1: V3 = [a.cx + s1 * 0.09, m[1], m[2]], w0 = mix(mix(p0, e0, 0.5), a.core[s0], 0.35), w1 = mix(mix(p1, e1, 0.5), a.core[s1], 0.35);
      return [p0, w0, e0, [a.cx, m[1], m[2]], e1, w1, p1];
    }
    if (r0 === "C" && r1 === "C") { const m = mix(p0, p1, 0.5), c = a.cbCore, d = dist(p0, p1), l = dist(m, c) || 1, k = Math.min(0.4 * d, 0.9 * l) / l, b = mix(m, c, k); return [p0, mix(p0, b, 0.5), b, mix(b, p1, 0.5), p1]; }
    // cerebrum <-> cerebellum: both orientations share one tract; build from the cerebral end
    const flip = r0 === "C", pc = flip ? p1 : p0, pb = flip ? p0 : p1, sc = side(flip ? r1 : r0, pc), sb = side("C", pb);
    const w: V3[] = [pc, mix(mix(pc, a.core[sc], 0.5), a.th[sc] ?? a.core[sc], 0.3)];
    if (a.th[sc]) w.push(a.th[sc]); if (a.bsTop) w.push(a.bsTop); if (a.cbA[sb]) w.push(a.cbA[sb]); if (a.cbMid[sb]) w.push(a.cbMid[sb]); if (a.cbEnd[sb]) w.push(mix(a.cbMid[sb], a.cbEnd[sb], 0.6));
    w.push(mix(w[w.length - 1], pb, 0.5), pb); if (flip) w.reverse(); return w;
  }
  private pushIn(p: V3, target: number): boolean {
    const f = this.f, g: V3 = [0, 0, 0];
    for (let it = 0; it < 14; it++) { const d = f.depthE(p[0], p[1], p[2]); if (d >= target) return true; f.grad(p[0], p[1], p[2], g); if (!g[0] && !g[1] && !g[2]) return false; const st = Math.min(2 * f.h, (target - d) + 0.1 * f.h); p[0] += g[0] * st; p[1] += g[1] * st; p[2] += g[2] * st; }
    return f.depthE(p[0], p[1], p[2]) >= target;
  }
  private fix(dense: V3[], target: number): { pts: V3[]; ok: boolean } {
    const f = this.f; let pts = dense.map((p) => [p[0], p[1], p[2]] as V3);
    for (let round = 0; round < 4; round++) {
      let bad = 0; for (let i = 1; i < pts.length - 1; i++) if (f.depthE(pts[i][0], pts[i][1], pts[i][2]) < target) { bad++; this.pushIn(pts[i], target + 0.15 * f.h); }
      if (!bad && round === 0) return { pts, ok: true };
      for (let pass = 0; pass < 3; pass++) { const nx = pts.map((p) => [p[0], p[1], p[2]] as V3); for (let i = 1; i < pts.length - 1; i++) for (let k = 0; k < 3; k++) nx[i][k] = 0.25 * pts[i - 1][k] + 0.5 * pts[i][k] + 0.25 * pts[i + 1][k]; pts = nx; }
      for (let i = 1; i < pts.length - 1; i++) this.pushIn(pts[i], target + 0.15 * f.h);
      pts = resample(pts, f.h * 0.5);
      if (minDepthAlong(f, pts) >= target) return { pts, ok: true };
    }
    return { pts, ok: minDepthAlong(f, pts) >= target };
  }
  /** A* on the voxel grid over the interior at depth >= margin + 1 voxel (so straight steps between cell centres stay above the margin), preferring depth. */
  /** A* over the certified R6 interior (6-neighbour steps between centres whose exact depth keeps target+0.5h); entry/exit are the nearest R6 cell reachable by a straight verified segment. */
  private astar6(p0: V3, p1: V3, target: number): V3[] | null {
    const f = this.f, r6 = f.r6!, [nx, ny, nz] = f.dims, N = nx * ny * nz, E = r6.E, lab = r6.lab, main = r6.main;
    if (!this.stamp) { this.stamp = new Int32Array(N); this.closedStamp = new Int32Array(N); this.gScore = new Float32Array(N); this.from = new Int32Array(N); }
    const stamp = this.stamp, closedS = this.closedStamp!, g = this.gScore!, from = this.from!, tk = ++this.tick;
    const near6 = (p: V3): number => { const i0 = Math.round((p[0] - f.origin[0]) / f.h - 0.5), j0 = Math.round((p[1] - f.origin[1]) / f.h - 0.5), k0 = Math.round((p[2] - f.origin[2]) / f.h - 0.5); let best = -1, bd = 1e9, fb = -1, fbd = 1e9;
      for (let R = 0; R <= 30 && best < 0; R++) for (let k = k0 - R; k <= k0 + R; k++) for (let j = j0 - R; j <= j0 + R; j++) for (let i = i0 - R; i <= i0 + R; i++) { if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz || Math.max(Math.abs(i - i0), Math.abs(j - j0), Math.abs(k - k0)) !== R) continue; const v = (k * ny + j) * nx + i; if (lab[v] !== main) continue; const dd = (i - i0) ** 2 + (j - j0) ** 2 + (k - k0) ** 2; if (dd < fbd) { fbd = dd; fb = v; } if (dd < bd && minDepthAlong(f, [p, f.centerOf(v)]) >= target) { bd = dd; best = v; } }
      return best >= 0 ? best : fb; };
    const s = near6(p0), e = near6(p1); if (s < 0 || e < 0) return null;
    const ec = f.centerOf(e), heap: number[] = [], key: number[] = [], c: V3 = [0, 0, 0];
    const push = (v: number, k: number) => { heap.push(v); key.push(k); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (key[p] <= key[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; [key[p], key[i]] = [key[i], key[p]]; i = p; } };
    const pop = () => { const v = heap[0], lv = heap.pop()!, lk = key.pop()!; if (heap.length) { heap[0] = lv; key[0] = lk; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && key[l] < key[m]) m = l; if (r < heap.length && key[r] < key[m]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; [key[m], key[i]] = [key[i], key[m]]; i = m; } } return v; };
    stamp[s] = tk; g[s] = 0; from[s] = -1; push(s, 0); let found = false;
    while (heap.length) {
      const v = pop(); if (closedS[v] === tk) continue; closedS[v] = tk; if (v === e) { found = true; break; }
      for (const w of [v - 1, v + 1, v - nx, v + nx, v - nx * ny, v + nx * ny]) {
        if (w < 0 || w >= N || closedS[w] === tk || lab[w] !== main) continue;
        const ng = g[v] + f.h * (1 + 3 * Math.max(0, (0.12 - E[w]) / 0.12));
        if (stamp[w] !== tk || ng < g[w]) { stamp[w] = tk; g[w] = ng; from[w] = v; f.centerOf(w, c); push(w, ng + dist(c, ec)); }
      }
    }
    if (!found) return null;
    const cells: V3[] = []; for (let v = e; v >= 0; v = from[v]) cells.push(f.centerOf(v)); cells.reverse();
    return [p0, ...cells, p1];
  }
  private astar(p0: V3, p1: V3, target: number): V3[] | null {
    if (f0(this.f)) return this.astar6(p0, p1, target);
    const f = this.f, [nx, ny, nz] = f.dims, N = nx * ny * nz, strict = Math.round((target + f.h) / f.h * f.q);
    if (!this.stamp) { this.stamp = new Int32Array(N); this.closedStamp = new Int32Array(N); this.gScore = new Float32Array(N); this.from = new Int32Array(N); }
    const stamp = this.stamp, closedS = this.closedStamp!, g = this.gScore!, from = this.from!, tk = ++this.tick, d = f.data, { label, main } = f.coreMask(f.margin);
    // a cell is walkable only if the grid says interior AND the exterior-boundary distance at its centre keeps `target` plus one voxel (>= the 0.87-voxel half-step: distance is 1-Lipschitz, so straight steps stay above target); cached per Router
    const wc = this.walkC ??= new Int8Array(N), reserve = target + f.h, cc: V3 = [0, 0, 0];
    const walk = (v: number): boolean => { if (d[v] < strict || label[v] !== main) return false; let q = wc[v]; if (!q) { f.centerOf(v, cc); q = wc[v] = f.depthE(cc[0], cc[1], cc[2]) >= reserve ? 1 : 2; } return q === 1; };
    const near = (p: V3): number => { // nearest allowed voxel within a few voxels
      const i0 = Math.round((p[0] - f.origin[0]) / f.h - 0.5), j0 = Math.round((p[1] - f.origin[1]) / f.h - 0.5), k0 = Math.round((p[2] - f.origin[2]) / f.h - 0.5); let best = -1, bd = 1e9;
      for (let R = 0; R <= 14 && best < 0; R++) for (let k = k0 - R; k <= k0 + R; k++) for (let j = j0 - R; j <= j0 + R; j++) for (let i = i0 - R; i <= i0 + R; i++) { if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue; if (Math.max(Math.abs(i - i0), Math.abs(j - j0), Math.abs(k - k0)) !== R) continue; const v = (k * ny + j) * nx + i; if (!walk(v)) continue; const dd = (i - i0) ** 2 + (j - j0) ** 2 + (k - k0) ** 2; if (dd < bd) { bd = dd; best = v; } }
      return best;
    };
    const s = near(p0), e = near(p1); if (s < 0 || e < 0) return null;
    const ec = f.centerOf(e), heap: number[] = [], key: number[] = []; // binary heap of voxel ids keyed by f-score
    const push = (v: number, k: number) => { heap.push(v); key.push(k); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (key[p] <= key[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; [key[p], key[i]] = [key[i], key[p]]; i = p; } };
    const pop = () => { const v = heap[0], lv = heap.pop()!, lk = key.pop()!; if (heap.length) { heap[0] = lv; key[0] = lk; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && key[l] < key[m]) m = l; if (r < heap.length && key[r] < key[m]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; [key[m], key[i]] = [key[i], key[m]]; i = m; } } return v; };
    stamp[s] = tk; g[s] = 0; from[s] = -1; push(s, 0); const c: V3 = [0, 0, 0], pref = 0.12; let found = false, expansions = 0;
    while (heap.length) {
      const v = pop(); if (closedS[v] === tk) continue; closedS[v] = tk; if (v === e) { found = true; break; } if (++expansions > 1_500_000) break;
      const i = v % nx, j = ((v / nx) | 0) % ny, k = (v / (nx * ny)) | 0;
      for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj && !dk) continue; const x = i + di, y = j + dj, z = k + dk; if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const w = (z * ny + y) * nx + x; if (closedS[w] === tk || !walk(w)) continue;
        const step = Math.hypot(di, dj, dk) * f.h, depthW = d[w] * f.h / f.q, ng = g[v] + step * (1 + 3 * Math.max(0, (pref - depthW) / pref));
        if (stamp[w] !== tk || ng < g[w]) { stamp[w] = tk; g[w] = ng; from[w] = v; f.centerOf(w, c); push(w, ng + dist(c, ec)); }
      }
    }
    if (!found) return null;
    const cells: V3[] = []; for (let v = e; v >= 0; v = from[v]) cells.push(f.centerOf(v)); cells.reverse();
    return [p0, ...cells, p1];
  }
  route(p0: V3, p1: V3, r0: Region3, r1: Region3): RouteResult {
    const f = this.f, target = f.margin + SLACK * f.h; this.stats.routes++;
    const w = this.waypoints(p0, p1, r0, r1); if (r0 === r1 && r0 !== "C") this.stats.bowed++;
    let dense = resample(catmull(w), f.h * 0.5); dense[0] = [p0[0], p0[1], p0[2]]; dense[dense.length - 1] = [p1[0], p1[1], p1[2]];
    let fx = this.fix(dense, target), astar = false;
    if (!fx.ok) {
      this.stats.astar++; astar = true; const path = this.astar(p0, p1, target);
      if (path) { const raw = resample(path, f.h * 0.5); const sm = this.fix(raw, target); fx = sm.ok ? sm : (minDepthAlong(f, raw) >= target ? { pts: raw, ok: true } : sm); }
    }
    if (!fx.ok) this.stats.failed++; else if (minDepthAlong(f, dense) < target) this.stats.pushed++;
    const pts = fx.pts; return { pts, length: polyLength(pts), astar, ok: fx.ok, minDepth: minDepthAlong(f, pts) };
  }
  /** Re-sample a valid dense route into `seg`+ segments (more when chords of the coarse polyline would cut a corner), uniform in arc length. Returns the rendered polyline. */
  coarse(r: RouteResult, seg: number): V3[] {
    const f = this.f, target = f.margin + SLACK * f.h * 0.5; let n = seg;
    for (; n <= 512; n *= 2) { const q = resample(r.pts, polyLength(r.pts) / n); q[0] = r.pts[0]; q[q.length - 1] = r.pts[r.pts.length - 1]; if (minDepthAlong(f, q) >= target) return q; }
    return r.pts;
  }
}

// ---------------------------------------------------------------- somas, sparkle
/** Project positions into the interior (depth >= need, main connected core). Returns the number that had to move. */
export function containPoint(f: Field, p: V3, need: number): { p: V3; moved: boolean } {
  const q = f.project(p, need), moved = dist(p, q) > 1e-6; return { p: moved ? q : [p[0], p[1], p[2]], moved };
}
/** Move surface points inward below the margin along their normals (then project); points that cannot be placed are dropped. Returns compacted arrays. */
export function insetSurfacePoints(f: Field, pos: Float32Array, nrm: Float32Array, rand: Float32Array, inset: number): { pos: Float32Array; nrm: Float32Array; rand: Float32Array; count: number; dropped: number } {
  const n = pos.length / 3, op: number[] = [], on: number[] = [], or: number[] = [], need = f.margin + SLACK * f.h; let dropped = 0; const g: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    let x = pos[i * 3] - nrm[i * 3] * inset, y = pos[i * 3 + 1] - nrm[i * 3 + 1] * inset, z = pos[i * 3 + 2] - nrm[i * 3 + 2] * inset;
    const ok = (a: number, b: number, c: number) => f.depthE(a, b, c) >= need && f.depth(a, b, c) >= f.margin - 1e-6; // exact exterior distance AND the grid margin
    for (let it = 0; it < 8 && !ok(x, y, z); it++) { f.grad(x, y, z, g); if (!g[0] && !g[1] && !g[2]) break; const st = Math.max(need - f.depthE(x, y, z), f.margin - f.depth(x, y, z)) + 0.1 * f.h; x += g[0] * st; y += g[1] * st; z += g[2] * st; }
    if (!ok(x, y, z)) { dropped++; continue; }
    op.push(x, y, z); on.push(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]); or.push(rand[i]);
  }
  return { pos: Float32Array.from(op), nrm: Float32Array.from(on), rand: Float32Array.from(or), count: or.length, dropped };
}
