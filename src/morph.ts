// Neuron morphologies per note. Fully deterministic from the note path hash.
//  - procedural: Cuntz et al. 2010 style growth (https://doi.org/10.1371/journal.pcbi.1000877): seeded carrier points inside a
//    cell-type envelope, greedy minimum spanning tree with balancing factor bf from the soma (cost = euclid + bf * pathlength),
//    Rall-like radius taper. Axon with optional myelin internodes and terminal boutons.
//  - template: seeded rotation / scale / jitter of a real SWC cell from morphologies.json (consumed once that asset exists).
// Morphologies are DECORATION of a note. They never connect two notes; links are drawn separately from real graph edges.
import { fnv, rng, V3 } from "./layout";
import { PALETTE } from "./palette";

export type CellType = "pyramidal" | "stellate" | "purkinje" | "interneuron";
export const CELL_TYPES: CellType[] = ["pyramidal", "stellate", "purkinje", "interneuron"];
export const KIND_DENDRITE = 0, KIND_AXON = 1, KIND_MYELIN = 2, KIND_BOUTON = 3;
export const GROUPS = 8;

export interface Morph {
  type: CellType; source: "procedural" | "template";
  n: number;
  pos: Float32Array;       // 3n, soma-relative, oriented into the brain frame, scene units
  rad: Float32Array;       // n radii (scene units)
  parent: Int32Array;      // -1 at the soma node (index 0)
  kind: Uint8Array;        // kind of the segment parent[i] -> i
  s: Float32Array;         // arc length from the soma along the path
  group: Uint8Array;       // primary dendrite subtree id (0..7); axon nodes use 0
  gmax: Float32Array;      // GROUPS+1: max arc length per dendrite group; [GROUPS] = axon length
  somaR: number; reach: number;
  axonTerminals: number[]; dendTips: number[];
  segments: number; dendSegments: number;
}
export interface SwcCell { id: string; type: CellType; source?: string; license?: string; points: number[][]; }

export interface MorphOpts {
  type: CellType; reach: number; hub: number;       // hub 0..1 from degree
  normal: V3; depth: number;                         // outward normal at the soma and distance to the surface (scene units)
  carriers?: number; radiusMul?: number; somaR?: number; templates?: SwcCell[]; maxPoints?: number;
}
const mix32 = (h: number) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
export function cellTypeFor(id: string, region: "cortex" | "cerebellum", degree: number): CellType {
  if (region === "cerebellum") return "purkinje";
  const h = mix32(fnv("t:" + id)) % 100;
  if (degree >= 5) return h < 82 ? "pyramidal" : "interneuron"; // well-connected notes are projection neurons
  return h < 55 ? "pyramidal" : h < 72 ? "stellate" : "interneuron";
}
export const hubOf = (degree: number) => Math.min(1, Math.sqrt(Math.max(0, degree)) / 3.2);
export const reachFor = (degree: number) => (0.078 + 0.075 * hubOf(degree)) * PALETTE.neuronScale;
export const somaRadiusFor = (degree: number) => (0.0105 + 0.017 * hubOf(degree)) * PALETTE.somaScale;

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Orthonormal frame (x, y=normal, z) with a seeded roll about the normal. */
export function frameFrom(normal: V3, roll: number): [V3, V3, V3] {
  const y = norm(normal), ref: V3 = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x0 = norm(cross(ref, y)), z0 = cross(y, x0), c = Math.cos(roll), s = Math.sin(roll);
  return [[x0[0] * c + z0[0] * s, x0[1] * c + z0[1] * s, x0[2] * c + z0[2] * s], y, [z0[0] * c - x0[0] * s, z0[1] * c - x0[1] * s, z0[2] * c - x0[2] * s]];
}
const toWorld = (f: [V3, V3, V3], p: V3, k: number): V3 => [k * (f[0][0] * p[0] + f[1][0] * p[1] + f[2][0] * p[2]), k * (f[0][1] * p[0] + f[1][1] * p[1] + f[2][1] * p[2]), k * (f[0][2] * p[0] + f[1][2] * p[1] + f[2][2] * p[2])];

/** Mutable tree used while growing. Invariant: parent index < child index. */
class Tree {
  P: V3[] = [[0, 0, 0]]; R: number[] = [0]; par: number[] = [-1]; kind: number[] = [0];
  add(p: V3, parent: number, kind: number, r = 0): number { this.P.push(p); this.R.push(r); this.par.push(parent); this.kind.push(kind); return this.P.length - 1; }
}

function carriersFor(type: CellType, r: () => number, nc: number, apical: number): V3[] {
  const out: V3[] = [];
  const unit = (): V3 => { const z = 2 * r() - 1, a = r() * 2 * Math.PI, s = Math.sqrt(1 - z * z); return [s * Math.cos(a), z, s * Math.sin(a)]; };
  if (type === "pyramidal") {
    const nBasal = Math.round(nc * 0.55), nApical = nc - nBasal;
    for (let i = 0; i < nBasal; i++) { const u = unit(), k = 0.3 + 0.7 * Math.cbrt(r()); out.push([u[0] * 0.8 * k, -0.12 + u[1] * 0.42 * k, u[2] * 0.8 * k]); }
    for (let i = 0; i < nApical; i++) {
      const t = i < 4 ? (i + 1) / 5 : Math.pow(r(), 0.65), y = 0.12 + t * (apical - 0.12), tuft = Math.max(0, (y / apical - 0.62) / 0.38), lat = 0.04 + 0.6 * tuft * apical;
      const a = r() * 2 * Math.PI, rr = lat * Math.sqrt(r()); out.push([Math.cos(a) * rr, y, Math.sin(a) * rr]);
    }
  } else if (type === "stellate") {
    for (let i = 0; i < nc; i++) { const u = unit(), k = 0.3 + 0.7 * Math.cbrt(r()); out.push([u[0] * k, u[1] * k, u[2] * k]); }
  } else if (type === "purkinje") { // flat fan in the x-y plane, thin in z
    for (let i = 0; i < nc; i++) {
      const th = (r() * 2 - 1) * 1.25, rr = i < 3 ? 0.2 + 0.2 * i : 0.35 + 0.8 * Math.sqrt(r());
      out.push([Math.sin(th) * rr * 1.1, 0.1 + Math.cos(th) * rr, (r() - 0.5) * 0.1]);
    }
  } else { // interneuron: bitufted, two opposing cones
    for (let i = 0; i < nc; i++) {
      const sgn = r() < 0.5 ? 1 : -1, y = sgn * (0.15 + 0.9 * Math.pow(r(), 0.8)), lat = 0.05 + 0.32 * Math.abs(y), a = r() * 2 * Math.PI, rr = lat * Math.sqrt(r());
      out.push([Math.cos(a) * rr, y, Math.sin(a) * rr]);
    }
  }
  return out;
}

/** Cuntz-style greedy MST: pick (carrier, tree node) minimising euclid + bf * pathlen(node). Prim-like O(n^2). */
function growDendrite(t: Tree, carriers: V3[], r: () => number, bf: number, step: number) {
  const n = carriers.length, used = new Array<boolean>(n).fill(false), bestCost = new Array<number>(n).fill(Infinity), bestPar = new Array<number>(n).fill(0);
  const pl: number[] = [0], idxOf: number[] = [0]; // path length and tree index of grown nodes (node 0 = soma)
  const upd = (node: V3, pathLen: number, tIdx: number) => { for (let c = 0; c < n; c++) if (!used[c]) { const cost = dist(carriers[c], node) + bf * pathLen; if (cost < bestCost[c]) { bestCost[c] = cost; bestPar[c] = tIdx; } } };
  upd([0, 0, 0], 0, 0);
  for (let it = 0; it < n; it++) {
    let c = -1, bc = Infinity; for (let k = 0; k < n; k++) if (!used[k] && bestCost[k] < bc) { bc = bestCost[k]; c = k; }
    used[c] = true;
    const from = bestPar[c], p0 = t.P[from], p1 = carriers[c], d = dist(p0, p1), parts = Math.max(1, Math.round(d / step));
    let prev = from, len = pl[idxOf.indexOf(from)] ?? 0;
    for (let s = 1; s <= parts; s++) {
      const u = s / parts, w = s < parts ? 0.16 * d / parts : 0;
      const q: V3 = [p0[0] + (p1[0] - p0[0]) * u + (r() - 0.5) * w, p0[1] + (p1[1] - p0[1]) * u + (r() - 0.5) * w, p0[2] + (p1[2] - p0[2]) * u + (r() - 0.5) * w];
      const id = t.add(q, prev, KIND_DENDRITE); len += dist(t.P[prev], q); prev = id;
      if (s === parts) { pl.push(len); idxOf.push(id); upd(q, len, id); }
    }
  }
}
function growAxon(t: Tree, r: () => number, dir0: V3, reach: number, hub: number, myelin: boolean): number[] {
  const step = reach * 0.13, L = reach * (1.0 + 0.9 * r() + 0.5 * hub), steps = Math.max(6, Math.round(L / step));
  const jitter = (): V3 => [r() - 0.5, r() - 0.5, r() - 0.5];
  // main trunk: myelinated internodes of 2-3 segments with 1 unmyelinated node of Ranvier between
  let d = norm(dir0), node = t.add([d[0] * reach * 0.04, d[1] * reach * 0.04, d[2] * reach * 0.04], 0, KIND_AXON);
  let pos: V3 = [t.P[node][0], t.P[node][1], t.P[node][2]], run = 0, inMy = false;
  const trunk: number[] = [node];
  for (let i = 0; i < steps; i++) {
    const j = jitter(); d = norm([d[0] + 0.32 * j[0], d[1] + 0.32 * j[1], d[2] + 0.32 * j[2]]);
    pos = [pos[0] + d[0] * step, pos[1] + d[1] * step, pos[2] + d[2] * step];
    if (myelin && i >= 1 && i < steps - 2) { if (run <= 0) { inMy = !inMy; run = inMy ? 2 + Math.floor(r() * 2) : 1; } run--; } else inMy = false;
    node = t.add(pos, node, inMy ? KIND_MYELIN : KIND_AXON); trunk.push(node);
  }
  const ends: { node: number; pos: V3; dir: V3 }[] = [{ node, pos, dir: d }];
  const nCol = 1 + Math.floor(r() * 2 + hub);
  for (let c = 0; c < nCol; c++) { // collaterals
    const at = trunk[Math.floor(steps * (0.35 + 0.5 * r()))], side = norm(cross(d, jitter()));
    let dd = norm([d[0] * 0.6 + side[0] * 0.8, d[1] * 0.6 + side[1] * 0.8, d[2] * 0.6 + side[2] * 0.8]), pr = at, pp = t.P[at];
    const n = 2 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) { const j = jitter(); dd = norm([dd[0] + 0.4 * j[0], dd[1] + 0.4 * j[1], dd[2] + 0.4 * j[2]]); pp = [pp[0] + dd[0] * step, pp[1] + dd[1] * step, pp[2] + dd[2] * step]; pr = t.add(pp, pr, KIND_AXON); }
    ends.push({ node: pr, pos: pp, dir: dd });
  }
  const tips: number[] = []; // terminal twigs ending in boutons
  for (const e of ends) {
    const nb = 2 + Math.floor(r() * 2);
    for (let b = 0; b < nb; b++) {
      const j = jitter(), bd = norm([e.dir[0] + 1.1 * j[0], e.dir[1] + 1.1 * j[1], e.dir[2] + 1.1 * j[2]]);
      const mid = t.add([e.pos[0] + bd[0] * step * 0.7, e.pos[1] + bd[1] * step * 0.7, e.pos[2] + bd[2] * step * 0.7], e.node, KIND_AXON);
      tips.push(t.add([e.pos[0] + bd[0] * step * 1.2, e.pos[1] + bd[1] * step * 1.2, e.pos[2] + bd[2] * step * 1.2], mid, KIND_BOUTON));
    }
  }
  return tips;
}

/** Turn a Tree into the typed-array Morph, computing arc length, groups, radii (Rall-like taper), tips and terminals. */
function finalize(t: Tree, type: CellType, source: Morph["source"], reach: number, somaR: number, radiusMul: number, axonFrac = 0.42): Morph {
  const n = t.P.length, pos = new Float32Array(n * 3), parent = new Int32Array(n), kind = new Uint8Array(n), s = new Float32Array(n), group = new Uint8Array(n), rad = new Float32Array(n);
  const childCount = new Int32Array(n);
  for (let i = 0; i < n; i++) { pos.set(t.P[i], i * 3); parent[i] = t.par[i]; kind[i] = t.kind[i]; if (i > 0) childCount[t.par[i]]++; }
  let gnext = 0; const gmax = new Float32Array(GROUPS + 1);
  for (let i = 1; i < n; i++) {
    const p = parent[i]; s[i] = s[p] + dist(t.P[p], t.P[i]);
    if (kind[i] === KIND_DENDRITE) { group[i] = p === 0 ? (gnext++) % GROUPS : group[p]; gmax[group[i]] = Math.max(gmax[group[i]], s[i]); }
    else gmax[GROUPS] = Math.max(gmax[GROUPS], s[i]);
  }
  // radii: Rall-like (sum of child radii^1.5) bottom up on dendrites; taper on the axon
  const base = reach * 0.034 * radiusMul, tipR = base * 0.2, raw = new Float64Array(n);
  for (let i = n - 1; i >= 1; i--) if (kind[i] === KIND_DENDRITE) { if (childCount[i] === 0) raw[i] = tipR; const p = parent[i]; if (p > 0) raw[p] = Math.pow(Math.pow(raw[p], 1.5) + Math.pow(raw[i], 1.5), 1 / 1.5); }
  let mx = 0; for (let i = 1; i < n; i++) if (kind[i] === KIND_DENDRITE) mx = Math.max(mx, raw[i]);
  const ax = base * axonFrac, axL = Math.max(1e-6, gmax[GROUPS]);
  for (let i = 1; i < n; i++) {
    if (kind[i] === KIND_DENDRITE) rad[i] = Math.max(tipR * 0.7, (raw[i] / (mx || 1)) * base * (1 - 0.6 * (s[i] / Math.max(1e-6, gmax[group[i]]))));
    else { const taper = 1 - 0.45 * Math.min(1, s[i] / axL); rad[i] = kind[i] === KIND_MYELIN ? ax * 2.3 : kind[i] === KIND_BOUTON ? ax * 2.6 : ax * taper; }
  }
  const axonTerminals: number[] = [], dendTips: number[] = []; let dendSegments = 0;
  for (let i = 1; i < n; i++) { if (kind[i] === KIND_DENDRITE) dendSegments++; if (childCount[i] === 0) (kind[i] === KIND_DENDRITE ? dendTips : axonTerminals).push(i); }
  return { type, source, n, pos, rad, parent, kind, s, group, gmax, somaR, reach, axonTerminals, dendTips, segments: n - 1, dendSegments };
}

/** Procedural neuron (Cuntz-style MST). Output is in the brain frame: canonical +Y is mapped onto the outward normal. */
export function proceduralMorph(id: string, o: MorphOpts): Morph {
  const r = rng(fnv("m:" + id)), reach = o.reach, hub = o.hub, type = o.type;
  const apical = Math.max(0.55, Math.min(1.5, (o.depth * 1.15) / reach));
  const mulT = type === "purkinje" ? 1.55 : type === "stellate" ? 0.85 : type === "interneuron" ? 0.75 : 1;
  const nc = Math.max(8, Math.round((20 + 34 * hub) * mulT * (o.carriers ?? 1)));
  const carriers = carriersFor(type, r, nc, apical);
  const t = new Tree();
  growDendrite(t, carriers, r, 0.4, 0.2);
  const down: V3 = type === "pyramidal" || type === "purkinje" ? [(r() - 0.5) * 0.4, -1, (r() - 0.5) * 0.4] : (() => { const z = 2 * r() - 1, a = r() * 6.283, s = Math.sqrt(1 - z * z); return [s * Math.cos(a), z, s * Math.sin(a)] as V3; })();
  const myel = type === "pyramidal" || type === "purkinje" || (type === "interneuron" && fnv("my:" + id) % 2 === 0);
  growAxon(t, r, norm(down), 1, hub, myel);
  // scale canonical -> scene units and rotate into the brain frame
  const f = frameFrom(o.normal, r() * Math.PI * 2);
  for (let i = 0; i < t.P.length; i++) t.P[i] = toWorld(f, t.P[i], reach);
  return finalize(t, type, "procedural", reach, o.somaR ?? somaRadiusFor(Math.round((hub * 3.2) ** 2)), o.radiusMul ?? 1);
}

/** Template neuron: a real SWC cell (morphologies.json) with seeded rotation, scale and jitter. */
/** Keep only points connected to the soma (type 1) through parent links; fragments with parent -1 are dropped. Parent indexes are remapped. */
export function connectedSwc(points: number[][]): number[][] {
  const pts = points.slice(0, 1500), n = pts.length, ch: number[][] = pts.map(() => []); const seeds: number[] = [];
  pts.forEach((p, i) => { if (p[5] === 1) seeds.push(i); else if (p[4] >= 0 && p[4] < n && p[4] !== i) ch[p[4]].push(i); });
  if (!seeds.length) return [];
  const keep = new Uint8Array(n), order: number[] = []; const q = seeds.slice(); for (const i of seeds) keep[i] = 1;
  while (q.length) { const i = q.shift()!; order.push(i); for (const c of ch[i]) if (!keep[c]) { keep[c] = 1; q.push(c); } }
  const remap = new Int32Array(n).fill(-1); order.sort((a, b) => a - b).forEach((o, k) => (remap[o] = k));
  return order.map((o) => { const p = pts[o].slice(); p[4] = p[4] >= 0 && p[4] < n && keep[p[4]] ? remap[p[4]] : -1; return p; });
}
/** Thin an SWC point list to <= budget points by dropping every other node of unbranched chains (keeps branch points, tips, soma). */
export function decimateSwc(points: number[][], budget: number): number[][] {
  let pts = points.slice(0, 1500).map((p) => p.slice());
  for (let pass = 0; pass < 6 && pts.length > budget; pass++) {
    const cc = new Int32Array(pts.length); pts.forEach((p) => { if (p[4] >= 0 && p[4] < pts.length) cc[p[4]]++; });
    const drop = new Uint8Array(pts.length); let run = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], pa = p[4]; const chain = pa >= 0 && pa < pts.length && p[5] !== 1 && cc[i] === 1 && cc[pa] <= 1 && pts[pa][5] === p[5]; if (chain) { run++; if (run % 2 === 1) drop[i] = 1; } else run = 0; }
    const remap = new Int32Array(pts.length).fill(-1), up = new Int32Array(pts.length); let k = 0;
    for (let i = 0; i < pts.length; i++) { const pa = pts[i][4]; up[i] = pa >= 0 && pa < pts.length && drop[pa] ? up[pa] : pa; if (!drop[i]) remap[i] = k++; }
    if (k === pts.length) break;
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i++) if (!drop[i]) { const q = pts[i].slice(); const pa = up[i]; q[4] = pa >= 0 && pa < pts.length ? remap[pa] : -1; out.push(q); }
    pts = out;
  }
  // still too many: drop evenly spaced leaf nodes (safe: no re-parenting needed), repeat for newly exposed leaves
  for (let pass = 0; pass < 8 && pts.length > budget; pass++) {
    const cc = new Int32Array(pts.length); pts.forEach((p) => { if (p[4] >= 0 && p[4] < pts.length) cc[p[4]]++; });
    const leaves: number[] = []; for (let i = 1; i < pts.length; i++) if (cc[i] === 0 && pts[i][5] !== 1) leaves.push(i);
    const D = Math.min(leaves.length, pts.length - budget); if (!D) break;
    const drop = new Uint8Array(pts.length); for (let k = 0; k < D; k++) drop[leaves[Math.floor((k * leaves.length) / D)]] = 1;
    const remap = new Int32Array(pts.length).fill(-1); let k = 0; for (let i = 0; i < pts.length; i++) if (!drop[i]) remap[i] = k++;
    pts = pts.filter((_, i) => !drop[i]).map((p) => { const q = p.slice(); q[4] = q[4] >= 0 && q[4] < remap.length ? remap[q[4]] : -1; return q; });
  }
  return pts;
}
export function templateMorph(id: string, cell: SwcCell, o: MorphOpts): Morph {
  const r = rng(fnv("tm:" + id)), pts = decimateSwc(connectedSwc(cell.points), o.maxPoints ?? 1500);
  if (pts.length < 40) return proceduralMorph(id, o);
  const soma = pts.find((p) => p[5] === 1) ?? pts[0], so: V3 = [soma[0], soma[1], soma[2]];
  const isSoma = (i: number) => pts[i][5] === 1 || i === pts.indexOf(soma);
  // children lists for a BFS that guarantees parent-before-child order
  const ch: number[][] = pts.map(() => []); const roots: number[] = [];
  pts.forEach((p, i) => { const pa = p[4]; if (pa < 0 || pa >= pts.length || pa === i) roots.push(i); else ch[pa].push(i); });
  const order: number[] = []; const stack = roots.filter((i) => !isSoma(i)).concat(roots.filter(isSoma)); const seen = new Set<number>();
  const q = [...stack.reverse()]; while (q.length) { const i = q.shift()!; if (seen.has(i)) continue; seen.add(i); order.push(i); q.push(...ch[i]); }
  // orientation: mean direction of apical points (type 4), else all dendrite points, goes to +Y (stellate keeps its own axes)
  const dirPts = pts.filter((p) => p[5] === 4).length ? pts.filter((p) => p[5] === 4) : pts.filter((p) => p[5] === 3 || p[5] === 4);
  let m: V3 = [0, 0, 0]; for (const p of dirPts) { m[0] += p[0] - so[0]; m[1] += p[1] - so[1]; m[2] += p[2] - so[2]; } m = norm(m);
  // rotation taking m -> +Y (Rodrigues)
  const ax = cross(m, [0, 1, 0]), sinA = Math.hypot(ax[0], ax[1], ax[2]), cosA = m[1];
  const rotA = (v: V3): V3 => { if (o.type === "stellate" || sinA < 1e-6) return cosA < 0 && o.type !== "stellate" ? [v[0], -v[1], v[2]] : v; const k = norm(ax), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], c = cross(k, v); return [v[0] * cosA + c[0] * sinA + k[0] * d * (1 - cosA), v[1] * cosA + c[1] * sinA + k[1] * d * (1 - cosA), v[2] * cosA + c[2] * sinA + k[2] * d * (1 - cosA)]; };
  let ext = 1e-6; for (const p of pts) if (p[5] === 3 || p[5] === 4) ext = Math.max(ext, Math.hypot(p[0] - so[0], p[1] - so[1], p[2] - so[2]));
  const scale = (1.45 * (0.9 + 0.25 * r())) / ext; // arbor extent ~1.45 canonical reaches, then * reach
  const f = frameFrom(o.normal, r() * Math.PI * 2), jit = 0.012;
  const t = new Tree(), map = new Map<number, number>(); let hasAxon = false; const cut = new Set<number>(), maxR = 2.0; // real axons are millimetres long: keep only the local part (<= 2.3 canonical reaches), prune the rest with all descendants
  for (const i of order) {
    const p = pts[i]; if (isSoma(i)) { map.set(i, 0); continue; }
    if (cut.has(p[4])) { cut.add(i); continue; }
    const pa = map.get(p[4]) ?? 0, v = rotA([(p[0] - so[0]) * scale, (p[1] - so[1]) * scale, (p[2] - so[2]) * scale]);
    const w: V3 = [v[0] + (r() - 0.5) * jit, v[1] + (r() - 0.5) * jit, v[2] + (r() - 0.5) * jit];
    const pp = pa > 0 ? t.P[pa] : [0, 0, 0]; // also cut long hops (decimation artefacts) so no straight spikes leave the cell
    if (Math.hypot(v[0], v[1], v[2]) > maxR || Math.hypot(v[0] - pp[0], v[1] - pp[1], v[2] - pp[2]) > 0.5) { cut.add(i); continue; }
    const k = p[5] === 2 ? KIND_AXON : KIND_DENDRITE; if (k === KIND_AXON) hasAxon = true;
    map.set(i, t.add(w, pa, k));
  }
  if (!hasAxon) growAxon(t, r, [0, -1, 0], 1, o.hub, o.type !== "stellate");
  else { const cc = new Int32Array(t.P.length); for (let i = 1; i < t.P.length; i++) cc[t.par[i]]++; for (let i = 1; i < t.P.length; i++) if (t.kind[i] === KIND_AXON && cc[i] === 0) t.kind[i] = KIND_BOUTON; }
  for (let i = 0; i < t.P.length; i++) t.P[i] = toWorld(f, t.P[i], o.reach);
  const m2 = finalize(t, o.type, "template", o.reach, o.somaR ?? somaRadiusFor(Math.round((o.hub * 3.2) ** 2)), o.radiusMul ?? 1);
  return m2;
}

const usableCache = new WeakMap<SwcCell, boolean>();
/** A template is usable when at least 40 of its points are connected to the soma (broken or fragmented cells fall back to procedural). */
function usable(c: SwcCell): boolean { let u = usableCache.get(c); if (u === undefined) { u = connectedSwc(c.points).length >= 40; usableCache.set(c, u); } return u; }
/** Choose template (when a matching real cell exists) or procedural. Both deterministic from `id`. */
export function makeMorph(id: string, o: MorphOpts): Morph {
  const pool = o.templates?.filter((c) => c.type === o.type && usable(c)) ?? [];
  if (pool.length) return templateMorph(id, pool[mix32(fnv("pick:" + id)) % pool.length], o);
  return proceduralMorph(id, o);
}
/** Small, cheap background neuron (decor): few carriers, no myelin, own soma-less glyph. */
export function decorMorph(seed: string, reach: number, normal: V3, carriers: number): Morph {
  const type: CellType = (["pyramidal", "stellate", "interneuron"] as CellType[])[mix32(fnv("dt:" + seed)) % 3];
  return proceduralMorph("decor:" + seed, { type, reach, hub: 0, normal, depth: reach, carriers, radiusMul: 0.6 });
}
