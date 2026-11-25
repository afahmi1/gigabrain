// Lightning bolts: precomputed, contained branching discharge channels. Pure geometry (no three.js, no DOM), shared by the scene and the node tests.
//
// Two kinds of bolt, both precomputed at layout/load time and only ANIMATED at runtime (see bolts.ts / impulse.ts):
//  - LINK bolts, one per real wikilink: the main channel runs from the source soma down its axon to the chosen terminal, along the link's routed
//    fibre and up the target dendrite to the target soma. The routed part is made jagged with midpoint displacement (Reed & Wyvill 1994) on two
//    scales, and short forks branch off it (stepped-leader look). Linked notes visibly arc to each other; the channel dims toward the middle of
//    the brain (centreDim: light from deep inside the translucent tissue is attenuated), so routes gathering in the centre do not dominate.
//  - AMBIENT bolts (decorative): seeded over the whole cortex, per hemisphere and lobe and area weighted, a few on the cerebellum and brainstem, and
//    grown as a stepped leader crawling tangentially through the cortical shell just beneath the surface. Each growth step is DBM-like
//    (Niemeyer, Pietronero & Wiesmann 1984): candidate sites are chosen with probability ~ phi^eta, where phi approximates the potential by
//    attraction to a ground point and shielding by the channel already grown (point-charge superposition in the spirit of Kim & Lin), which
//    gives the familiar one-channel-races-ahead, short-side-branch structure. No Laplace solve, nothing per frame.
// Containment: EVERY segment of every bolt is verified against the exterior-boundary distance (field.depthE) at VERIFY_STEP spacing, at least at the
// link-route level (margin + SLACK/2) for link bolts and at margin + SLACK for ambient bolts. A segment that fails is never emitted: the generator
// shrinks the displacement, falls back to the already verified route, or stops that branch.
import { Field, V3 } from "./field";
import { SLACK, VERIFY_STEP } from "./contain";
import { rng, fnv } from "./layout";

export const BOLT_LINK = 0, BOLT_AMBIENT = 1;
/** Ambient bins: 0-3 left frontal/parietal/temporal/occipital, 4-7 right, 8 cerebellum, 9 brainstem. */
export const LOBES = ["frontal", "parietal", "temporal", "occipital"] as const;
export const BIN_CEREBELLUM = 8, BIN_BRAINSTEM = 9, BINS = 10;
export const binName = (b: number) => (b === BIN_CEREBELLUM ? "cerebellum" : b === BIN_BRAINSTEM ? "brainstem" : (b < 4 ? "L-" : "R-") + LOBES[b % 4]);

export interface Bolt {
  kind: number;              // BOLT_LINK | BOLT_AMBIENT
  n: number;                 // nodes; segment i (1..n-1) joins parent[i] -> i
  pos: Float32Array;         // 3n, world (brain) space
  parent: Int32Array;        // -1 at the root
  arr: Float32Array;         // leader arrival 0..1 (the stepped leader front sweeps it; main channel end = 1)
  w: Float32Array;           // luminance weight of the segment ending at node i: main channel 1, forks dimmer with branch depth (Kim & Lin)
  fork: Uint16Array;         // 0 = main channel, else the id of the top-level fork the node belongs to (per-strike fork subsets)
  nrm: Float32Array | null;  // 3n outward surface normal (ambient: far-side dimming), null for link bolts
  mainLength: number; length: number; center: V3; radius: number; forks: number;
  bin: number;               // ambient bin (-1 for link bolts)
  src: number; dst: number; edge: number; // link bolts: oriented note indices and graph edge index (-1 for ambient)
}

// ---------------------------------------------------------------- small vector helpers
const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const gauss = (r: () => number) => (r() + r() + r() + r() - 2) / 0.577; // ~N(0,1), bounded
/** Random unit vector perpendicular to d. */
function perp(d: V3, r: () => number): V3 {
  const a = r() * Math.PI * 2, ref: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm([ref[1] * d[2] - ref[2] * d[1], ref[2] * d[0] - ref[0] * d[2], ref[0] * d[1] - ref[1] * d[0]]), v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const c = Math.cos(a), s = Math.sin(a); return [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s];
}
/** Direction deviated from d by an angle ~ |N(0, sigma)| (radians) about a random perpendicular axis. */
function deviate(d: V3, sigma: number, r: () => number): V3 { const p = perp(norm(d), r), t = Math.tan(Math.min(1.35, Math.abs(gauss(r)) * sigma)); return norm([d[0] + p[0] * t, d[1] + p[1] * t, d[2] + p[2] * t]); }

/** Exact-distance check of a straight segment at VERIFY_STEP spacing (same sample positions as contain.minDepthAlong), early exit. */
export function segOK(f: Field, a: ArrayLike<number>, b: ArrayLike<number>, need: number): boolean {
  if (f.depthE(a[0], a[1], a[2]) < need || f.depthE(b[0], b[1], b[2]) < need) return false;
  const l = dist3(a, b), n = Math.ceil(l / (f.h * VERIFY_STEP));
  for (let s = 1; s < n; s++) { const t = s / n; if (f.depthE(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t) < need) return false; }
  return true;
}
/** Depth every generated bolt keeps: ambient bolts use the arbor standard, link bolts the link-route standard (their fallback IS the verified route). */
export const ambientNeed = (f: Field) => f.margin + SLACK * f.h;
export const linkNeed = (f: Field) => f.margin + 0.5 * SLACK * f.h;

// ---------------------------------------------------------------- tree builder
class Tree {
  p: number[] = []; par: number[] = []; s: number[] = []; lvl: number[] = []; fk: number[] = []; nr: number[] = [];
  get n() { return this.par.length; }
  at(i: number): V3 { return [this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]]; }
  add(q: ArrayLike<number>, parent: number, level: number, fork: number): number {
    const i = this.par.length; this.p.push(q[0], q[1], q[2]); this.par.push(parent); this.lvl.push(level); this.fk.push(fork);
    this.s.push(parent < 0 ? 0 : this.s[parent] + Math.hypot(q[0] - this.p[parent * 3], q[1] - this.p[parent * 3 + 1], q[2] - this.p[parent * 3 + 2])); return i;
  }
  /** Freeze into a Bolt: arrival from arc length (forks lag the main channel), luminance weights by branch depth, bounds. */
  finish(kind: number, mainEnd: number, f: Field | null, extra: { bin?: number; src?: number; dst?: number; edge?: number }): Bolt {
    const n = this.n, pos = Float32Array.from(this.p), parent = Int32Array.from(this.par), arr = new Float32Array(n), w = new Float32Array(n), fork = new Uint16Array(n);
    const mainLen = Math.max(1e-6, this.s[mainEnd]); let length = 0;
    // arc length where each fork leaves the main channel / its parent branch, and the branch's own extent (for tapering)
    const base = new Float64Array(n), ext = new Map<number, number>();
    for (let i = 0; i < n; i++) { const p = this.par[i]; base[i] = p < 0 ? 0 : this.lvl[p] < this.lvl[i] ? this.s[p] : base[p]; if (this.lvl[i] > 0) { const k = this.lvl[i] * 100000 + this.fk[i]; ext.set(k, Math.max(ext.get(k) ?? 0, this.s[i] - base[i])); } }
    for (let i = 0; i < n; i++) {
      const p = this.par[i], lv = this.lvl[i]; fork[i] = this.fk[i]; if (p >= 0) length += this.s[i] - this.s[p];
      if (lv === 0) { arr[i] = Math.min(1, this.s[i] / mainLen); w[i] = 1; continue; }
      const along = this.s[i] - base[i], e = ext.get(lv * 100000 + this.fk[i]) || 1e-6, t = Math.min(1, along / e);
      arr[i] = Math.min(0.985, base[i] / mainLen + 0.85 * along / mainLen);
      w[i] = (lv === 1 ? 0.55 : 0.32) * (1 - 0.45 * t);
    }
    const c: V3 = [0, 0, 0]; for (let i = 0; i < n; i++) { c[0] += pos[i * 3] / n; c[1] += pos[i * 3 + 1] / n; c[2] += pos[i * 3 + 2] / n; }
    let rad = 0; for (let i = 0; i < n; i++) rad = Math.max(rad, Math.hypot(pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]));
    let nrm: Float32Array | null = null;
    if (f) { nrm = new Float32Array(n * 3); const g: V3 = [0, 0, 0]; for (let i = 0; i < n; i++) { gradE(f, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], g); nrm[i * 3] = -g[0]; nrm[i * 3 + 1] = -g[1]; nrm[i * 3 + 2] = -g[2]; } }
    const forks = new Set(this.fk.filter((x, i) => this.lvl[i] > 0)).size;
    return { kind, n, pos, parent, arr, w, fork, nrm, mainLength: mainLen, length, center: c, radius: rad, forks, bin: extra.bin ?? -1, src: extra.src ?? -1, dst: extra.dst ?? -1, edge: extra.edge ?? -1 };
  }
}

// ---------------------------------------------------------------- fractal jag (Reed & Wyvill midpoint displacement)
/** One level of midpoint displacement: every segment longer than `minLen` gets a displaced midpoint when both halves verify (else a smaller one, else none). */
export function subdivide(f: Field, pts: V3[], r: () => number, need: number, amp: number, minLen: number): V3[] {
  const out: V3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = dist3(a, b);
    if (l >= minLen) {
      const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), p = perp(d, r), g = gauss(r) * amp * l, m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      for (const k of [1, 0.45]) { const q: V3 = [m[0] + p[0] * g * k, m[1] + p[1] * g * k, m[2] + p[2] * g * k]; if (segOK(f, a, q, need) && segOK(f, q, b, need)) { out.push(q); break; } } // else: keep the verified segment as is
    }
    out.push(b);
  }
  return out;
}
export interface JagOpts { anchor: number; amp: number; levels: number; subAmp: number; minLen: number; }
/** Large-scale jag of a verified route: anchors every ~`anchor` of arc length are displaced sideways and joined by straight chords when every chord
 *  verifies; where a chord fails both of its anchors fall back to the route and the ORIGINAL route vertices between them are kept (already verified).
 *  Then `levels` of midpoint displacement add the fine jag. Endpoints never move. */
export function jagRoute(f: Field, route: V3[], r: () => number, need: number, o: JagOpts): V3[] {
  const n = route.length; if (n < 2) return route.map((p) => [p[0], p[1], p[2]] as V3);
  const cum = [0]; for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist3(route[i - 1], route[i]));
  const L = cum[n - 1], k = Math.max(1, Math.round(L / o.anchor)), idx: number[] = [0];
  for (let a = 1, j = 1; a < k; a++) { const tgt = (L * a) / k; while (j < n - 1 && cum[j] < tgt) j++; if (j > idx[idx.length - 1] && j < n - 1) idx.push(j); }
  idx.push(n - 1);
  const D: V3[] = idx.map((ii, a) => {
    const p = route[ii]; if (a === 0 || a === idx.length - 1) return p;
    const t = norm([route[Math.min(n - 1, ii + 1)][0] - route[ii - 1][0], route[Math.min(n - 1, ii + 1)][1] - route[ii - 1][1], route[Math.min(n - 1, ii + 1)][2] - route[ii - 1][2]]), q = perp(t, r), s = gauss(r) * o.amp * (L / k);
    return [p[0] + q[0] * s, p[1] + q[1] * s, p[2] + q[2] * s];
  });
  const disp = idx.map((_, a) => a > 0 && a < idx.length - 1);
  for (let it = 0; it <= idx.length; it++) {
    let changed = false;
    for (let a = 1; a < idx.length; a++) { if (!disp[a - 1] && !disp[a]) continue; const A = disp[a - 1] ? D[a - 1] : route[idx[a - 1]], B = disp[a] ? D[a] : route[idx[a]]; if (!segOK(f, A, B, need)) { disp[a - 1] = disp[a] = false; changed = true; } }
    if (!changed) break;
  }
  let pts: V3[] = [[route[0][0], route[0][1], route[0][2]]];
  for (let a = 1; a < idx.length; a++) {
    if (!disp[a - 1] && !disp[a]) { for (let q = idx[a - 1] + 1; q <= idx[a]; q++) pts.push([route[q][0], route[q][1], route[q][2]]); }
    else pts.push(disp[a] ? D[a] : [route[idx[a]][0], route[idx[a]][1], route[idx[a]][2]]);
  }
  for (let lv = 0; lv < o.levels; lv++) pts = subdivide(f, pts, r, need, o.subAmp * Math.pow(0.75, lv), o.minLen * Math.pow(0.5, lv));
  return pts;
}

// ---------------------------------------------------------------- branches
interface BranchOpts { step: number; sigma: number; need: number; maxNodes: number; }
/** Constrained random walk (a fork of the stepped leader): every step verified; up to 6 tries per step with growing deviation, else the branch stops. */
function growBranch(f: Field, T: Tree, from: number, dir: V3, len: number, level: number, fork: number, r: () => number, o: BranchOpts, spawn?: (node: number, dir: V3) => void): number {
  let cur = from, d = norm(dir), gone = 0, made = 0;
  while (gone < len && T.n < o.maxNodes) {
    let ok = false; const P = T.at(cur);
    for (let att = 0; att < 6 && !ok; att++) {
      const nd = deviate(d, o.sigma * (att < 3 ? 1 : 1.9), r), st = o.step * (0.7 + 0.6 * r()), c: V3 = [P[0] + nd[0] * st, P[1] + nd[1] * st, P[2] + nd[2] * st];
      if (!segOK(f, P, c, o.need)) continue;
      cur = T.add(c, cur, level, fork); d = nd; gone += st; made++; ok = true; spawn?.(cur, d);
    }
    if (!ok) break;
  }
  return made;
}

// ---------------------------------------------------------------- link bolts
export interface LinkInput { src: number; dst: number; edge: number; chainA: V3[]; route: V3[]; chainB: V3[]; }
export interface LinkOpts { jag: JagOpts; forks: number; forkLen: [number, number]; subFork: number; step: number; maxNodes: number; box?: { min: V3; max: V3 }; }
export function linkOpts(detail: number): LinkOpts {
  const d = Math.max(0.2, Math.min(1, detail));
  return { jag: { anchor: 0.075, amp: 0.2, levels: d >= 0.6 ? 2 : 1, subAmp: 0.24, minLen: 0.012 }, forks: Math.round(1 + 4 * d), forkLen: [0.035, 0.05 + 0.08 * d], subFork: d >= 0.6 ? 0.3 : 0, step: 0.018, maxNodes: Math.round(140 + 260 * d) };
}
/** The link bolt of one real edge. `chainA` soma->axon terminal, `route` terminal->dendrite tip (the verified link route), `chainB` tip->soma. */
export function linkBolt(f: Field, inp: LinkInput, o: LinkOpts, seed: number): Bolt {
  const r = rng(seed), need = linkNeed(f), T = new Tree();
  const route = inp.route.length >= 2 ? jagRoute(f, inp.route, r, need, o.jag) : inp.route;
  const same = (a: V3, b: V3) => dist3(a, b) < 1e-7;
  const main: V3[] = []; const push = (p: V3) => { if (!main.length || !same(main[main.length - 1], p)) main.push(p); };
  inp.chainA.forEach(push); const r0 = main.length; route.forEach(push); const r1 = main.length; inp.chainB.forEach(push);
  let prev = -1; const ids: number[] = []; for (const p of main) { prev = T.add(p, prev, 0, 0); ids.push(prev); }
  const mainEnd = prev;
  // forks leave the routed part (between 12% and 88% of it), spaced apart, deviating 25-60 degrees from the channel
  const lo = r0 + Math.floor((r1 - r0) * 0.12), hi = r0 + Math.floor((r1 - r0) * 0.88), want = o.forks, used: number[] = []; let forkId = 1;
  for (let k = 0, tries = 0; k < want && hi - lo > 2 && tries < want * 4; tries++) {
    const at = lo + Math.floor(r() * (hi - lo)); if (used.some((u) => Math.abs(u - at) < Math.max(2, (hi - lo) / (want + 2)))) continue;
    const A = T.at(ids[Math.max(0, at - 1)]), B = T.at(ids[Math.min(ids.length - 1, at + 1)]), t = norm([B[0] - A[0], B[1] - A[1], B[2] - A[2]]);
    const ang = (25 + 35 * r()) * Math.PI / 180, p = perp(t, r), dir = norm([t[0] + p[0] * Math.tan(ang), t[1] + p[1] * Math.tan(ang), t[2] + p[2] * Math.tan(ang)]);
    const len = o.forkLen[0] + (o.forkLen[1] - o.forkLen[0]) * r(), id = forkId++;
    const subs: [number, V3][] = [];
    const made = growBranch(f, T, ids[at], dir, len, 1, id, r, { step: o.step, sigma: 0.42, need, maxNodes: o.maxNodes }, (node, d) => { if (o.subFork > 0 && r() < o.subFork * 0.35) subs.push([node, d]); });
    if (made) { used.push(at); k++; for (const [node, d] of subs.slice(0, 2)) growBranch(f, T, node, deviate(d, 0.9, r), len * (0.3 + 0.3 * r()), 2, id, r, { step: o.step * 0.8, sigma: 0.45, need, maxNodes: o.maxNodes }); }
  }
  const b = T.finish(BOLT_LINK, mainEnd, null, { src: inp.src, dst: inp.dst, edge: inp.edge });
  for (let i = 0; i < b.n; i++) { const x = b.pos[i * 3], y = b.pos[i * 3 + 1], z = b.pos[i * 3 + 2]; b.w[i] *= o.box ? centreDim(x, y, z, o.box) : depthDim(f.depthE(x, y, z)); }
  return b;
}
/** Light from deep inside the translucent tissue is attenuated: full brightness in the cortical shell, down to 25% in the deep white matter. */
export const depthDim = (d: number) => { const t = Math.max(0, Math.min(1, (d - 0.11) / 0.17)); return 1 - 0.75 * t * t * (3 - 2 * t); };
/** Same idea measured against the cerebrum's outer envelope (ellipsoid of the cortex bounds), so the corpus callosum and the hemisphere cores, which
 *  sit in the middle of the brain even where a fissure is near, are dim too: a link arcs brightly near its two notes and dives faintly through the
 *  centre, and the middle of the brain does not become the brightest place just because notes and routes gather there. 1 in the shell, 0.22 deep. */
export function centreDim(x: number, y: number, z: number, box: { min: V3; max: V3 }): number {
  const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2], rr = [(box.max[0] - box.min[0]) / 2, (box.max[1] - box.min[1]) / 2, (box.max[2] - box.min[2]) / 2];
  const rho = Math.hypot((x - c[0]) / rr[0], (y - c[1]) / rr[1], (z - c[2]) / rr[2]), t = Math.max(0, Math.min(1, (0.82 - rho) / 0.27));
  return 1 - 0.78 * t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- ambient bolts
export type Part = "cortex_lh" | "cortex_rh" | "cerebellum" | "brainstem";
export interface AmbientSource {
  /** Area-weighted point on a part's surface with its outward normal and curvature (negative = sulcus), or null when the part does not exist. */
  sample(part: Part, r: () => number): { pos: V3; nrm: V3; curv: number } | null;
  area(part: Part): number;
  cortexBox: { min: V3; max: V3 };
}
/** Coarse lobe of a cerebral point (illustrative stratification only; folders are not brain regions). zn: back 0 .. front 1, yn: bottom 0 .. top 1. */
export function lobeOf(p: ArrayLike<number>, box: { min: V3; max: V3 }): number {
  const zn = (p[2] - box.min[2]) / Math.max(1e-6, box.max[2] - box.min[2]), yn = (p[1] - box.min[1]) / Math.max(1e-6, box.max[1] - box.min[1]);
  if (zn < 0.22) return 3;                       // occipital
  if (yn < 0.4 && zn < 0.68) return 2;           // temporal (inferior, below the Sylvian level)
  if (zn > 0.56) return 0;                       // frontal
  return 1;                                      // parietal
}
export interface AmbientOpts { count: number; detail: number; }
export interface AmbientResult { bolts: Bolt[]; binArea: number[]; binCount: number[]; tries: number; }
interface GrowOpts { L: number; step: number; lo: number; hi: number; eta: number; pBranch: [number, number]; maxNodes: number; need: number; }
/** DBM-like stepped leader through the shell lo..hi below the surface, starting at `seed`, heading along `tangent` toward a ground point at distance L. */
function growAmbient(f: Field, seed: V3, tangent: V3, o: GrowOpts, r: () => number): { T: Tree; mainEnd: number; reached: boolean } {
  const T = new Tree(); T.add(seed, -1, 0, 0);
  const G: V3 = [seed[0] + tangent[0] * o.L, seed[1] + tangent[1] * o.L, seed[2] + tangent[2] * o.L];
  const CELL = 0.03, hash = new Map<number, number[]>(), key = (x: number, y: number, z: number) => ((Math.floor(x / CELL) + 512) * 1024 + (Math.floor(y / CELL) + 512)) * 1024 + (Math.floor(z / CELL) + 512);
  const index = (i: number) => { const k = key(T.p[i * 3], T.p[i * 3 + 1], T.p[i * 3 + 2]); const a = hash.get(k); if (a) a.push(i); else hash.set(k, [i]); };
  index(0);
  /** shielding: 1 far from the existing channel (other branches), -> 0 on top of it (the pattern is an equipotential, phi = 0) */
  const shield = (c: V3, self: number, fork: number) => {
    let m = 1; const cx = Math.floor(c[0] / CELL), cy = Math.floor(c[1] / CELL), cz = Math.floor(c[2] / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const a = hash.get(((cx + dx + 512) * 1024 + (cy + dy + 512)) * 1024 + (cz + dz + 512)); if (!a) continue;
      for (const j of a) { if (j === self || (T.fk[j] === fork && Math.abs(j - self) < 4)) continue; const d = Math.hypot(T.p[j * 3] - c[0], T.p[j * 3 + 1] - c[1], T.p[j * 3 + 2] - c[2]); m = Math.min(m, d / (2.2 * o.step)); } }
    return Math.max(0.02, Math.min(1, m));
  };
  const g: V3 = [0, 0, 0];
  /** keep the crawl inside the shell: bend the radial component toward the band centre (exact exterior distance; the voxel grid is eroded in the cerebellum) */
  const steer = (dep: number, d: V3): V3 => {
    if (!g[0] && !g[1] && !g[2]) return d;
    const rad = d[0] * g[0] + d[1] * g[1] + d[2] * g[2], mid = (o.lo + o.hi) / 2, want = Math.max(-0.45, Math.min(0.45, ((mid - dep) / (o.hi - o.lo)) * 1.4));
    return norm([d[0] + g[0] * (want - rad * 0.8), d[1] + g[1] * (want - rad * 0.8), d[2] + g[2] * (want - rad * 0.8)]);
  };
  interface Tip { node: number; dir: V3; level: number; fork: number; budget: number; gone: number; }
  const tips: Tip[] = [{ node: 0, dir: tangent, level: 0, fork: 0, budget: o.L * 1.5, gone: 0 }];
  let forkSeq = 1, mainEnd = 0, best = dist3(seed, G), reached = false, after = 0;
  for (let iter = 0; iter < 900 && tips.length && T.n < o.maxNodes; iter++) {
    if (reached && ++after > 40) break;
    // DBM competition between tips: the main leader (nearest the ground) grows most often, side branches stall
    const wt = tips.map((t) => (t.level === 0 ? 1 : 0.45 * (1 - t.gone / t.budget) + 0.05) ** o.eta), tot = wt.reduce((a, b) => a + b, 0); let x = r() * tot, k = 0; while (k < tips.length - 1 && x > wt[k]) { x -= wt[k]; k++; }
    const t = tips[k], P = T.at(t.node), cands: { c: V3; d: V3; st: number; phi: number }[] = [], depP = f.depthE(P[0], P[1], P[2]); gradE(f, P, g);
    for (let q = 0; q < 7; q++) {
      let d = deviate(t.dir, t.level === 0 ? 0.5 : 0.55, r);
      if (t.level === 0) { const toG = norm([G[0] - P[0], G[1] - P[1], G[2] - P[2]]); d = norm([d[0] + toG[0] * 0.3, d[1] + toG[1] * 0.3, d[2] + toG[2] * 0.3]); }
      d = steer(depP, d); const st = o.step * (0.75 + 0.5 * r()), c: V3 = [P[0] + d[0] * st, P[1] + d[1] * st, P[2] + d[2] * st], dep = f.depthE(c[0], c[1], c[2]);
      if (dep < o.lo || dep > o.hi + 0.02) continue;
      const att = t.level === 0 ? Math.max(0.03, 1 - dist3(c, G) / (o.L * 1.25)) : 0.6;
      cands.push({ c, d, st, phi: att * shield(c, t.node, t.fork) });
    }
    let chosen: (typeof cands)[number] | null = null;
    while (cands.length) { // phi^eta roulette; the chosen site must verify against the exact distance, else it is removed and the draw repeats
      const cw = cands.map((q) => q.phi ** o.eta), ct = cw.reduce((a, b) => a + b, 0); let y = r() * ct, j = 0; while (j < cands.length - 1 && y > cw[j]) { y -= cw[j]; j++; }
      if (segOK(f, P, cands[j].c, o.need)) { chosen = cands[j]; break; } cands.splice(j, 1);
    }
    if (!chosen) { tips.splice(k, 1); continue; }
    const id = T.add(chosen.c, t.node, t.level, t.fork); index(id); t.node = id; t.dir = chosen.d; t.gone += chosen.st;
    if (t.level === 0) { const dg = dist3(chosen.c, G); if (dg < best) { best = dg; } mainEnd = id; if (dg < o.step * 1.3) { reached = true; tips.splice(k, 1); continue; } }
    if (t.gone >= t.budget) { tips.splice(k, 1); continue; }
    if (t.level < 2 && r() < o.pBranch[t.level]) {
      const p = perp(t.dir, r), ang = (30 + 35 * r()) * Math.PI / 180, nd = steer(depP, norm([t.dir[0] + p[0] * Math.tan(ang), t.dir[1] + p[1] * Math.tan(ang), t.dir[2] + p[2] * Math.tan(ang)]));
      tips.push({ node: id, dir: nd, level: t.level + 1, fork: t.level === 0 ? forkSeq++ : t.fork, budget: o.L * (t.level === 0 ? 0.18 + 0.26 * r() : 0.07 + 0.1 * r()), gone: 0 });
    }
  }
  return { T, mainEnd, reached };
}
/** Unit gradient of the exact exterior distance (central differences, points into the tissue). */
function gradE(f: Field, p: ArrayLike<number>, out: V3): V3 {
  const e = f.h * 0.75, gx = f.depthE(p[0] + e, p[1], p[2]) - f.depthE(p[0] - e, p[1], p[2]), gy = f.depthE(p[0], p[1] + e, p[2]) - f.depthE(p[0], p[1] - e, p[2]), gz = f.depthE(p[0], p[1], p[2] + e) - f.depthE(p[0], p[1], p[2] - e), l = Math.hypot(gx, gy, gz);
  if (l < 1e-9) { out[0] = out[1] = out[2] = 0; return out; } out[0] = gx / l; out[1] = gy / l; out[2] = gz / l; return out;
}
/** Decorative ambient bolts over the whole cerebrum (both hemispheres, all four lobes, cortex shell), plus a few small ones in the cerebellum and brainstem.
 *  Counts per bin are proportional to the bin's cortical surface area with a floor, so every lobe of both hemispheres always has bolts. Deterministic. */
export function ambientBolts(f: Field, src: AmbientSource, o: AmbientOpts): AmbientResult {
  const need = ambientNeed(f), detail = Math.max(0.3, Math.min(1, o.detail)), box = src.cortexBox;
  const hemis: Part[] = ["cortex_lh", "cortex_rh"], has = (p: Part) => src.area(p) > 0;
  // cortical area per bin (area-weighted surface samples)
  const binArea = new Array(BINS).fill(0), r0 = rng(0x1b0175);
  for (const [hi, part] of hemis.entries()) { if (!has(part)) continue; const A = src.area(part), N = 1500; for (let i = 0; i < N; i++) { const s = src.sample(part, r0); if (s) binArea[hi * 4 + lobeOf(s.pos, box)] += A / N; } }
  const cer = binArea.slice(0, 8).reduce((a, b) => a + b, 0) || 1;
  const binCount = new Array(BINS).fill(0), nCb = has("cerebellum") ? Math.max(1, Math.round(o.count * 0.06)) : 0, nBs = has("brainstem") && o.count >= 40 ? Math.max(1, Math.round(o.count * 0.015)) : 0;
  const nCer = Math.max(8, o.count - nCb - nBs), floor = Math.max(2, Math.round(nCer * 0.04));
  for (let b = 0; b < 8; b++) binCount[b] = binArea[b] > 0 ? Math.max(floor, Math.round((nCer * binArea[b]) / cer)) : 0;
  binCount[BIN_CEREBELLUM] = nCb; binCount[BIN_BRAINSTEM] = nBs;
  const bolts: Bolt[] = []; let tries = 0;
  for (let b = 0; b < BINS; b++) for (let k = 0; k < binCount[b]; k++) {
    const r = rng(fnv("bolt:" + b + ":" + k)), part: Part = b < 4 ? "cortex_lh" : b < 8 ? "cortex_rh" : b === BIN_CEREBELLUM ? "cerebellum" : "brainstem";
    const small = b >= 8, L0 = small ? (b === BIN_BRAINSTEM ? 0.08 + 0.05 * r() : 0.11 + 0.08 * r()) : (0.26 + 0.3 * r()) * (0.75 + 0.25 * detail);
    const lo = need + 0.004, hi = small ? lo + 0.035 : lo + 0.07;
    let made: Bolt | null = null;
    for (let attempt = 0; attempt < 10 && !made; attempt++) {
      tries++;
      let s: { pos: V3; nrm: V3; curv: number } | null = null;
      for (let q = 0; q < 60; q++) { const c = src.sample(part, r); if (!c) break; if (b < 8 && lobeOf(c.pos, box) !== b % 4) continue; if (c.curv < -0.15 && q < 40) continue; s = c; break; }
      if (!s) break;
      // below the folded pial surface the exterior distance only reaches the band under the sulcal fundi: inset, then walk up the distance gradient
      const d0 = small ? 0.09 + 0.04 * r() : 0.09 + 0.06 * r(), q0: V3 = [s.pos[0] - s.nrm[0] * d0, s.pos[1] - s.nrm[1] * d0, s.pos[2] - s.nrm[2] * d0];
      let seed: V3 = q0;
      if (f.depthE(q0[0], q0[1], q0[2]) < lo + 0.006) { const pr = f.project(q0, lo + 0.012); if (dist3(pr, q0) > 0.12) continue; seed = [pr[0], pr[1], pr[2]]; }
      const ds = f.depthE(seed[0], seed[1], seed[2]); if (ds < lo || ds > hi + 0.02) continue;
      const gg = gradE(f, seed, [0, 0, 0]); if (!gg[0] && !gg[1] && !gg[2]) continue;
      const tg = perp(gg, r), L = L0 * (attempt < 5 ? 1 : 0.7);
      const gr = growAmbient(f, seed, tg, { L, step: small ? 0.016 : 0.022, lo, hi, eta: 2, pBranch: [0.2 + 0.08 * detail, 0.12 * detail], maxNodes: Math.round((small ? 70 : 150) * (0.6 + 0.4 * detail)), need }, r);
      if (gr.T.n < 5 || gr.T.s[gr.mainEnd] < L * (attempt < 5 ? 0.45 : 0.3)) continue;
      // fine jag on every branch (verified midpoint displacement), then freeze
      const T2 = jagTree(f, gr.T, gr.mainEnd, r, need, detail >= 0.6 ? 0.26 : 0.2);
      made = T2.T.finish(BOLT_AMBIENT, T2.mainEnd, f, { bin: b });
    }
    if (made) bolts.push(made);
  }
  return { bolts, binArea, binCount, tries };
}
/** One ambient bolt grown from an explicit seed and heading (tests: adversarial seeds at the longitudinal fissure and the cerebrum-cerebellum gap). */
export function ambientBoltAt(f: Field, seed: V3, tangent: V3, o: { L: number; detail: number; small?: boolean; bin?: number; rngSeed: number }): Bolt | null {
  const r = rng(o.rngSeed), need = ambientNeed(f), lo = need + 0.004, hi = o.small ? lo + 0.035 : lo + 0.07, detail = Math.max(0.3, Math.min(1, o.detail));
  const gr = growAmbient(f, seed, norm(tangent), { L: o.L, step: o.small ? 0.016 : 0.022, lo, hi, eta: 2, pBranch: [0.2 + 0.08 * detail, 0.12 * detail], maxNodes: Math.round((o.small ? 70 : 150) * (0.6 + 0.4 * detail)), need }, r);
  if (gr.T.n < 2) return null;
  const T2 = jagTree(f, gr.T, gr.mainEnd, r, need, detail >= 0.6 ? 0.26 : 0.2);
  return T2.T.finish(BOLT_AMBIENT, T2.mainEnd, f, { bin: o.bin ?? -1 });
}
/** Midpoint displacement on every segment of a tree (one level): each verified displaced midpoint becomes a new node between parent and child. */
function jagTree(f: Field, T: Tree, mainEnd: number, r: () => number, need: number, amp: number): { T: Tree; mainEnd: number } {
  const out = new Tree(), map = new Int32Array(T.n).fill(-1);
  for (let i = 0; i < T.n; i++) {
    const p = T.par[i], q = T.at(i);
    if (p < 0) { map[i] = out.add(q, -1, T.lvl[i], T.fk[i]); continue; }
    const a = T.at(p), l = dist3(a, q); let parent = map[p];
    if (l > 0.008) {
      const d = norm([q[0] - a[0], q[1] - a[1], q[2] - a[2]]), pp = perp(d, r), g = gauss(r) * amp * l, m: V3 = [(a[0] + q[0]) / 2 + pp[0] * g, (a[1] + q[1]) / 2 + pp[1] * g, (a[2] + q[2]) / 2 + pp[2] * g];
      if (segOK(f, a, m, need) && segOK(f, m, q, need)) parent = out.add(m, parent, T.lvl[i], T.fk[i]);
    }
    map[i] = out.add(q, parent, T.lvl[i], T.fk[i]);
  }
  return { T: out, mainEnd: map[mainEnd] };
}

// ---------------------------------------------------------------- verification + packing
/** A link bolt with no segments (a fail-closed link that must never strike, or a link without a field). */
export function emptyBolt(src: number, dst: number, edge: number): Bolt {
  return { kind: BOLT_LINK, n: 1, pos: new Float32Array(3), parent: Int32Array.of(-1), arr: new Float32Array(1), w: Float32Array.of(1), fork: new Uint16Array(1), nrm: null, mainLength: 0, length: 0, center: [0, 0, 0], radius: 0, forks: 0, bin: -1, src, dst, edge };
}
/** Sample every segment of a bolt at <= `step` and count samples below `level` (tests, diag). Main channel and forks are reported separately. */
export function sampleBolt(f: Field, b: Bolt, step: number, level: number): { main: number; mainOut: number; fork: number; forkOut: number; min: number } {
  const r = { main: 0, mainOut: 0, fork: 0, forkOut: 0, min: Infinity };
  for (let i = 1; i < b.n; i++) {
    const p = b.parent[i], ax = b.pos[p * 3], ay = b.pos[p * 3 + 1], az = b.pos[p * 3 + 2], bx = b.pos[i * 3], by = b.pos[i * 3 + 1], bz = b.pos[i * 3 + 2];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / step)), main = b.fork[i] === 0;
    for (let s = 0; s <= n; s++) { const u = s / n, d = f.depthE(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u); if (d < r.min) r.min = d; if (main) { r.main++; if (d < level) r.mainOut++; } else { r.fork++; if (d < level) r.forkOut++; } }
  }
  return r;
}
/** Segment count of a set of bolts. */
export const segmentCount = (bolts: Bolt[]) => bolts.reduce((a, b) => a + Math.max(0, b.n - 1), 0);
/** Normal packed as three 8-bit channels in one float (exact in float32); -1 = no normal. */
export const packNormal = (x: number, y: number, z: number) => Math.round((x * 0.5 + 0.5) * 255) + 256 * Math.round((y * 0.5 + 0.5) * 255) + 65536 * Math.round((z * 0.5 + 0.5) * 255);
export const SEG_TEXELS = 3;
/** GPU layout: 3 RGBA texels per segment: (P.xyz, arrival at P), (Q.xyz, arrival at Q), (bolt row, weight, fork id, packed normal). Bolt b owns the
 *  contiguous segment range first[b] .. first[b] + count[b]. Pure data (the scene uploads it once; nothing is rebuilt per frame). */
export function packSegments(bolts: Bolt[]): { data: Float32Array; first: Int32Array; count: Int32Array; segments: number } {
  const segments = segmentCount(bolts), data = new Float32Array(segments * SEG_TEXELS * 4), first = new Int32Array(bolts.length), count = new Int32Array(bolts.length); let s = 0;
  bolts.forEach((b, bi) => {
    first[bi] = s; count[bi] = Math.max(0, b.n - 1);
    for (let i = 1; i < b.n; i++, s++) {
      const p = b.parent[i], o = s * SEG_TEXELS * 4;
      data[o] = b.pos[p * 3]; data[o + 1] = b.pos[p * 3 + 1]; data[o + 2] = b.pos[p * 3 + 2]; data[o + 3] = b.arr[p];
      data[o + 4] = b.pos[i * 3]; data[o + 5] = b.pos[i * 3 + 1]; data[o + 6] = b.pos[i * 3 + 2]; data[o + 7] = b.arr[i];
      data[o + 8] = bi; data[o + 9] = b.w[i]; data[o + 10] = b.fork[i]; data[o + 11] = b.nrm ? packNormal(b.nrm[i * 3], b.nrm[i * 3 + 1], b.nrm[i * 3 + 2]) : -1;
    }
  });
  return { data, first, count, segments };
}
