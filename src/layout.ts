// Deterministic procedural layouts. Positions depend only on the note path (stable as the vault grows).
// Colour slots come from the shared memory scope (./scope), so the plugin and the memory server agree on them.
import { SLOTS, type Folder } from "./scope";
export type { Folder } from "./scope";
export type V3 = [number, number, number];
export const FOLDERS: Folder[] = [...SLOTS];
export const FOLDER_COLOR: Record<Folder, V3> = {
  topics: [0.184, 0.827, 0.878],     // cyan #2FD3E0
  projects: [1.0, 0.478, 0.239],    // orange #FF7A3D
  memories: [0.643, 0.42, 1.0],      // violet #A46BFF
};
/** Display labels per colour slot. Defaults match the default scope; setFolderLabels() applies the configured folder names. */
export const FOLDER_LABEL: Record<Folder, string> = { topics: "Topics", projects: "Projects", memories: "Memories" };
export function setFolderLabels(folders: string[]) {
  FOLDERS.forEach((f, i) => { const n = folders[i]; FOLDER_LABEL[f] = n ? n.charAt(0).toUpperCase() + n.slice(1) : (f.charAt(0).toUpperCase() + f.slice(1)); });
}

export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => (r() + r() + r() - 1.5) / 0.5;

// ---- Procedural brain scaffold (illustrative, NOT an anatomical scan) ----
const BAND: Record<Folder, [number, number]> = { topics: [0.15, 0.95], projects: [-0.35, 0.2], memories: [-0.95, -0.3] };
const AX: V3 = [0.62, 0.78, 1.15];
export const BRAIN_REGION_CENTER: Record<Folder, V3> = { topics: [0, 0.2, 0.65], projects: [0, 0.55, -0.05], memories: [0, 0.2, -0.72] };

export function foldField(x: number, y: number, z: number): number {
  let f = 0.05 * Math.sin(11 * x + 5 * y + 2 * z) * Math.cos(9 * z - 3 * x);
  f += 0.035 * Math.sin(17 * y + 13 * z + 2 * x) * Math.cos(7 * x);
  f += 0.02 * Math.sin(29 * x + 23 * z) * Math.sin(19 * y);
  const sylv = Math.exp(-(((y + 0.12) / 0.11) ** 2)) * Math.min(1, Math.max(0, (x - 0.25) * 2.5)) * (z > -0.5 && z < 0.7 ? 1 : 0.3);
  return f - 0.1 * sylv;
}
export function cortexPoint(dx: number, dy: number, dz: number, side: number, depth: number): V3 {
  const f = foldField(dx, dy, dz);
  const r = depth * (1 + f);
  const yy = dy < 0 ? dy * 0.55 : dy;
  return [side * (HALF_GAP + AX[0] * dx * r), AX[1] * yy * r + 0.05, AX[2] * dz * r];
}
/** Half-width of the longitudinal fissure between the hemispheres (brain units). */
export const HALF_GAP = 0.07;
const CORTEX_MIN = 0.74, CORTEX_MAX = 1.12; // allowed relative depth after relaxation
/** Normalised cortex radius of a brain-space point (1.0 is the nominal surface; folds add about +-0.1). */
export function cortexRadius(p: V3): number {
  const qx = (Math.abs(p[0]) - HALF_GAP) / AX[0];
  const yy = (p[1] - 0.05) / AX[1], qy = yy < 0 ? yy / 0.55 : yy;
  return Math.hypot(qx, qy, p[2] / AX[2]);
}
/** Hemisphere bounds used by layout and tests: outside the fissure gap and inside the (fold-padded) cortex ellipsoid. */
export function inHemisphereBounds(p: V3): boolean {
  if (Math.abs(p[0]) < HALF_GAP - 1e-6) return false;
  const r = cortexRadius(p);
  return r <= 1.2 && r >= 0.55;
}
function clampToCortex(p: V3, side: number): V3 {
  const ax = Math.max(HALF_GAP, side * p[0]);
  let qx = (ax - HALF_GAP) / AX[0];
  const yy = (p[1] - 0.05) / AX[1];
  let qy = yy < 0 ? yy / 0.55 : yy, qz = p[2] / AX[2];
  const rho = Math.hypot(qx, qy, qz);
  if (rho > 1e-6) {
    const k = rho < CORTEX_MIN ? CORTEX_MIN / rho : rho > CORTEX_MAX ? CORTEX_MAX / rho : 1;
    qx *= k; qy *= k; qz *= k;
  }
  return [side * (HALF_GAP + AX[0] * qx), AX[1] * (qy < 0 ? qy * 0.55 : qy) + 0.05, AX[2] * qz];
}
/**
 * Deterministic brain layout: seeded per-note start positions, then a FIXED number of relaxation
 * passes that pull linked notes (same hemisphere) part-way together, with a soft cortex-shell boundary
 * and a hard fissure gap. Only direct neighbours of a changed note move, so adding a note is stable.
 * Idea: d3-force custom bounding force + fixed tick count (https://d3js.org/d3-force/simulation).
 */
export function brainLayout(nodes: { id: string; folder: Folder }[], edges: { a: number; b: number }[], passes = 2, k = 0.22): V3[] {
  const seed = nodes.map((n) => brainStarPos(n.id, n.folder));
  let cur = seed.map((p) => [p[0], p[1], p[2]] as V3);
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) { adj[e.a].push(e.b); adj[e.b].push(e.a); }
  for (let pass = 0; pass < passes; pass++) {
    const next: V3[] = cur.map((p) => p);
    for (let i = 0; i < nodes.length; i++) {
      const side = seed[i][0] < 0 ? -1 : 1;
      let sx = 0, sy = 0, sz = 0, c = 0;
      for (const j of adj[i]) if ((seed[j][0] < 0 ? -1 : 1) === side) { sx += cur[j][0]; sy += cur[j][1]; sz += cur[j][2]; c++; }
      if (!c) continue;
      const p = cur[i];
      next[i] = clampToCortex([p[0] + k * (sx / c - p[0]), p[1] + k * (sy / c - p[1]), p[2] + k * (sz / c - p[2])], side);
    }
    cur = next;
  }
  return cur;
}
export function dirInBand(r: () => number, lo: number, hi: number): V3 {
  const z = lo + (hi - lo) * r();
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = (-0.38 + 0.88 * r()) * Math.PI;
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}
/** Hemisphere (-1 left, +1 right) from an avalanche-mixed path hash, so similar file names still split about 50/50. */
export function hemisphereOf(path: string): number {
  let h = fnv("h:" + path);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) & 0x100 ? 1 : -1;
}
export function brainStarPos(path: string, folder: Folder): V3 {
  const r = rng(fnv("b:" + path));
  const d = dirInBand(r, BAND[folder][0], BAND[folder][1]);
  const side = hemisphereOf(path);
  return cortexPoint(d[0], d[1], d[2], side, 0.88 + 0.15 * r()); // slightly varied depth: neurons inside the shell
}
// ---- Universe layout: one spiral galaxy per folder ----
const GCENTER: Record<Folder, V3> = {
  topics: [0, 0.3, -6.2],
  projects: [5.6, -0.2, 3.4],
  memories: [-5.6, 0.1, 3.4],
};
export const UNIVERSE_REGION_CENTER = GCENTER;
const TILT: Record<Folder, number> = { topics: 0.35, projects: -0.3, memories: 0.2 };
export function galaxyPoint(r: () => number, folder: Folder, radius = 3.4): V3 {
  const u = r();
  const rad = 0.2 + radius * Math.pow(u, 0.62);
  const ang = (r() < 0.5 ? 0 : Math.PI) + rad * 1.15 + gauss(r) * 0.22 * (1.4 - rad / radius);
  const x = rad * Math.cos(ang), z = rad * Math.sin(ang);
  const y = gauss(r) * 0.11 * (1.3 - rad / (radius * 1.1));
  const t = TILT[folder], c = GCENTER[folder];
  return [c[0] + x, c[1] + y * Math.cos(t) - z * Math.sin(t), c[2] + y * Math.sin(t) + z * Math.cos(t)];
}
export function universeStarPos(path: string, folder: Folder): V3 {
  return galaxyPoint(rng(fnv("u:" + path)), folder, 3.2);
}

// ---- Decorative dust (NOT notes). Fixed seed => identical every run. ----
export interface Dust { brain: Float32Array; uni: Float32Array; color: Float32Array; rand: Float32Array; size: Float32Array; count: number; }
export function makeDust(count: number): Dust {
  const r = rng(0xa57c0);
  const brain = new Float32Array(count * 3), uni = new Float32Array(count * 3), color = new Float32Array(count * 3);
  const rand = new Float32Array(count), size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const kind = r();
    let p: V3;
    let zc = 0;
    if (kind < 0.66) { // cortex shell
      const d = dirInBand(r, -1, 1);
      zc = d[2];
      p = cortexPoint(d[0], d[1], d[2], r() < 0.5 ? -1 : 1, 0.94 + 0.08 * r());
    } else if (kind < 0.82) { // interior volume
      const d = dirInBand(r, -1, 1); zc = d[2];
      p = cortexPoint(d[0], d[1], d[2], r() < 0.5 ? -1 : 1, 0.25 + 0.65 * Math.cbrt(r()));
    } else if (kind < 0.9) { // cerebellum (striated)
      const a = r() * Math.PI * 2, b = Math.acos(2 * r() - 1);
      const x = Math.sin(b) * Math.cos(a), y = Math.cos(b), z = Math.sin(b) * Math.sin(a);
      p = [0.5 * x, -0.5 + 0.22 * y * (1 + 0.08 * Math.sin(40 * y)), -0.9 + 0.3 * z]; zc = -0.9;
    } else if (kind < 0.94) { // brainstem
      const a = r() * 6.283, h = r();
      p = [0.09 * Math.cos(a), -0.45 - 0.45 * h, -0.2 - 0.08 * h + 0.09 * Math.sin(a)]; zc = 0;
    } else { // faint halo around the form
      const a = r() * 6.283, b = Math.acos(2 * r() - 1), rr = 1.4 + 0.8 * r();
      p = [rr * Math.sin(b) * Math.cos(a) * 0.9, rr * Math.cos(b) * 0.7, rr * Math.sin(b) * Math.sin(a) * 1.1]; zc = Math.sin(a);
    }
    brain.set(p, i * 3);
    // universe: galaxy arms + diffuse background
    let q: V3; let fold: Folder = FOLDERS[Math.floor(r() * 3)];
    if (r() < 0.8) q = galaxyPoint(r, fold, 4.3);
    else { const a = r() * 6.283, b = Math.acos(2 * r() - 1), rr = 7 + 14 * r(); q = [rr * Math.sin(b) * Math.cos(a), rr * Math.cos(b) * 0.5, rr * Math.sin(b) * Math.sin(a)]; }
    uni.set(q, i * 3);
    const bf: Folder = zc > 0.3 ? "topics" : zc < -0.35 ? "memories" : "projects";
    const c = FOLDER_COLOR[r() < 0.5 ? bf : fold];
    const m = 0.35 + 0.35 * r(); // desaturate toward blue-white, keep dim
    color[i * 3] = c[0] * m + 0.25 * (1 - m); color[i * 3 + 1] = c[1] * m + 0.3 * (1 - m); color[i * 3 + 2] = c[2] * m + 0.45 * (1 - m);
    rand[i] = r(); size[i] = 0.6 + 1.1 * r() * r();
  }
  return { brain, uni, color, rand, size, count };
}

// ---- Placement interface (shared by the procedural scaffold and the real brain mesh) ----
export type Region = "cortex" | "cerebellum";
export interface Placement { pos: V3; normal: V3; depth: number; region: Region; }
export type Placer = (path: string, folder: Folder) => Placement;
export const CB_C: V3 = [0, -0.42, -0.8], CB_R: V3 = [0.5, 0.2, 0.3];
const mixH = (h: number) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
/** About one in eight memories notes lives in the cerebellum (Purkinje-like cells). Deterministic from the path only. */
export function inCerebellum(path: string, folder: Folder): boolean { return folder === "memories" && mixH(fnv("cb:" + path)) % 8 === 0; }
export function cerebellumPoint(path: string): V3 {
  const r = rng(fnv("cbp:" + path)), z = 2 * r() - 1, a = r() * 2 * Math.PI, s = Math.sqrt(1 - z * z), k = 0.55 + 0.35 * Math.cbrt(r());
  return [CB_C[0] + CB_R[0] * k * s * Math.cos(a), CB_C[1] + CB_R[1] * k * z, CB_C[2] + CB_R[2] * k * s * Math.sin(a)];
}
/** Outward unit normal of the procedural cortex ellipsoid at a brain-space point. */
export function cortexNormal(p: V3): V3 {
  const sx = p[0] < 0 ? -1 : 1, qx = (Math.abs(p[0]) - HALF_GAP) / AX[0], yy = (p[1] - 0.05) / AX[1], qy = yy < 0 ? yy / 0.55 : yy, qz = p[2] / AX[2];
  const n: V3 = [sx * qx / AX[0], (yy < 0 ? qy / 0.55 : qy) / AX[1], qz / AX[2]], l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
/** Procedural fallback placer used until a real brain mesh is loaded (positions equal the 0.2.1 layout for cortex notes). */
export function proceduralPlacement(pos: V3, region: Region): Placement {
  if (region === "cerebellum") { const n: V3 = [(pos[0] - CB_C[0]) / CB_R[0] ** 2, (pos[1] - CB_C[1]) / CB_R[1] ** 2, (pos[2] - CB_C[2]) / CB_R[2] ** 2], l = Math.hypot(...n) || 1;
    return { pos, normal: [n[0] / l, n[1] / l, n[2] / l], depth: 0.07, region }; }
  const rho = cortexRadius(pos);
  return { pos, normal: cortexNormal(pos), depth: Math.max(0.03, Math.min(0.4, (1.03 - rho) * 0.75)), region };
}
