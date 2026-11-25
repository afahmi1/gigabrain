// Generates the bundled brain meshes from scratch: assets/brain.glb (High/Balanced) and assets/brain_low.glb (Low).
// Every vertex is computed here from closed-form shapes and seeded noise. No scans, templates or third-party meshes,
// so the output is original work covered by this repository's licence (see assets/LICENSES.md).
//
// Parts (named like the runtime expects): cortex_lh, cortex_rh, cerebellum, brainstem.
// Attributes: POSITION, NORMAL, _CURV in [-1, 1] (negative = sulcus, positive = gyral crown).
// Frame: +X right, +Y up, +Z anterior; the cerebrum spans roughly x -0.81..0.81, y -0.72..0.72, z -1..1.
//
// The cortex is illustrative: a folded, two-hemisphere surface with frontal, temporal and occipital shaping,
// a lateral (Sylvian) fissure, a central sulcus and meandering gyri/sulci from domain-warped noise.
// It is not anatomically registered and does not depict any person's brain.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { cerebellumMesh } from "./lib/cerebellum-geometry.mjs";

const PI = Math.PI, TAU = 2 * PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const softMax = (a, b, k) => { const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1); return b + (a - b) * h + k * h * (1 - h); };

// ---------- seeded 3D gradient noise (classic Perlin construction; original implementation) ----------
function makeNoise(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const perm = new Uint8Array(512), p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const G = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10), lerp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y, z) => { const g = G[h % 12]; return g[0] * x + g[1] * y + g[2] * z; };
  return (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), xf = x - X, yf = y - Y, zf = z - Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255, u = fade(xf), v = fade(yf), w = fade(zf);
    const h = (i, j, k) => perm[perm[perm[xi + i] + yi + j] + zi + k];
    return lerp(
      lerp(lerp(grad(h(0, 0, 0), xf, yf, zf), grad(h(1, 0, 0), xf - 1, yf, zf), u), lerp(grad(h(0, 1, 0), xf, yf - 1, zf), grad(h(1, 1, 0), xf - 1, yf - 1, zf), u), v),
      lerp(lerp(grad(h(0, 0, 1), xf, yf, zf - 1), grad(h(1, 0, 1), xf - 1, yf, zf - 1), u), lerp(grad(h(0, 1, 1), xf, yf - 1, zf - 1), grad(h(1, 1, 1), xf - 1, yf - 1, zf - 1), u), v), w);
  };
}

// ---------- icosphere ----------
function icosphere(level) {
  const t = (1 + Math.sqrt(5)) / 2, pos = [];
  const add = (x, y, z) => { const l = Math.hypot(x, y, z); pos.push(x / l, y / l, z / l); return pos.length / 3 - 1; };
  [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].forEach((v) => add(...v));
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const cache = new Map(), mid = (a, b) => {
      const k = a < b ? a * 1e6 + b : b * 1e6 + a; let m = cache.get(k);
      if (m === undefined) { m = add(pos[a * 3] + pos[b * 3], pos[a * 3 + 1] + pos[b * 3 + 1], pos[a * 3 + 2] + pos[b * 3 + 2]); cache.set(k, m); }
      return m;
    };
    const next = [];
    for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    faces = next;
  }
  return { dirs: Float64Array.from(pos), faces: Uint32Array.from(faces.flat()) };
}

function vertexNormals(pos, idx) {
  const n = new Float64Array(pos.length);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const q of [a, b, c]) { n[q] += nx; n[q + 1] += ny; n[q + 2] += nz; }
  }
  for (let v = 0; v < n.length; v += 3) { const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1; n[v] /= l; n[v + 1] /= l; n[v + 2] /= l; }
  return n;
}
function faceNormal(pos, idx, f) {
  const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
  const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
  return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
}

// ---------- cerebral hemisphere (right hemisphere frame; the left one is mirrored) ----------
const noiseA = makeNoise(0x5eed01), noiseB = makeNoise(0x5eed02), noiseW = makeNoise(0x5eed03);
const MEDIAL = 0.02; // fissure (2 x MEDIAL/2 = 0.02) must stay wider than ~1 SDF voxel (0.0156) or the shipped field cannot verify the medial walls

/** Smooth base hemisphere for a unit direction (no folds). Lateral is +X. */
function hemiBase(dx, dy, dz) {
  // anteroposterior taper: blunt frontal pole, narrower occipital pole
  const back = smooth(-0.35, -1.0, dz), front = smooth(0.55, 1.0, dz);
  const rx = 0.50 * (1 - 0.18 * back - 0.08 * front), cx = 0.315;
  let x = cx + rx * dx;
  // dorsal dome and ventral profile: frontal (orbital) floor, low temporal lobe, raised occipital floor above the cerebellum
  const lateral = smooth(-0.15, 0.75, dx);
  const temporal = Math.exp(-(((dz - 0.02) / 0.34) ** 2)) * lateral;
  const ry = dy >= 0 ? 0.66 * (1 - 0.16 * back - 0.10 * front) : 0.36 + 0.33 * temporal - 0.03 * back + 0.04 * front * lateral;
  let y = 0.045 + ry * dy;
  // occipital floor rests on the tentorium above the cerebellum
  if (dz < -0.25) y = softMax(y, -0.42 + 0.10 * smooth(-0.55, -1.0, dz), 0.06);
  // anterior temporal pole pushes forward and down, below the frontal lobe
  let z = 0.99 * dz - 0.05 * temporal * (dy < 0 ? -dy : 0);
  z *= 1 - 0.03 * back;
  // flat medial wall along the longitudinal fissure
  x = softMax(x, MEDIAL, 0.035);
  return [x, y, z, dx];
}

/** Narrow groove along the zero set of `s` (|grad s| ~ freq): -1 in the groove floor, 0 on the crowns. */
const groove = (s, w) => -Math.exp(-((s / w) ** 2));

/** Fold height (world units, along the base normal) and sulcal value at a base-surface point. */
function folds(x, y, z, medial) {
  const wx = 0.33 * noiseW(x * 2.1 + 7.3, y * 2.1, z * 2.1), wy = 0.33 * noiseW(x * 2.1, y * 2.1 + 3.1, z * 2.1 - 5.2), wz = 0.33 * noiseW(x * 2.1 - 1.7, y * 2.1 + 9.4, z * 2.1);
  const px = x + wx, py = y + wy, pz = z + wz;
  const primary = groove(noiseA(px * 4.6, py * 4.6, pz * 4.6), 0.085);
  const secondary = groove(noiseB(px * 9.5 + 11, py * 9.5, pz * 9.5), 0.075);
  // lateral (Sylvian) fissure: rises posteriorly above the temporal lobe, lateral surface only
  const lat = smooth(0.25, 0.6, x / 0.8);
  const sylv = groove(y - (-0.10 + 0.32 * clamp(0.22 - z, 0, 0.75) ** 1.25), 0.035) * lat * smooth(0.45, 0.25, z) * smooth(-0.62, -0.42, z);
  // central sulcus: from the dorsal midline slightly posterior, running down and forward
  const cs = groove(z - (-0.06 + 0.22 * clamp(0.62 - y, 0, 0.75)), 0.03) * smooth(-0.05, 0.12, y) * smooth(0.0, 0.08, x);
  const m = 1 - 0.65 * medial;
  const h = m * (0.030 * primary + 0.012 * secondary) + 0.040 * sylv + 0.030 * cs;
  const curv = clamp(1 + 2.2 * Math.min(primary * m, 1) * 0.9 + 1.4 * secondary * m + 2.5 * sylv + 2.2 * cs, -1, 1);
  return { h: h + 0.012 * m, curv };
}

function hemisphere(level, side) {
  const { dirs, faces } = icosphere(level), nv = dirs.length / 3;
  const base = new Float64Array(nv * 3), medial = new Float64Array(nv);
  for (let v = 0; v < nv; v++) { const [x, y, z, dx] = hemiBase(dirs[v * 3], dirs[v * 3 + 1], dirs[v * 3 + 2]); base.set([x, y, z], v * 3); medial[v] = smooth(-0.15, -0.5, dx); }
  const bn = vertexNormals(base, faces), pos = new Float64Array(nv * 3), curv = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = base[v * 3], y = base[v * 3 + 1], z = base[v * 3 + 2], f = folds(x, y, z, medial[v]);
    pos[v * 3] = x + bn[v * 3] * f.h; pos[v * 3 + 1] = y + bn[v * 3 + 1] * f.h; pos[v * 3 + 2] = z + bn[v * 3 + 2] * f.h; curv[v] = f.curv;
    pos[v * 3] = Math.max(pos[v * 3], MEDIAL * 0.5); // keep the medial wall off the midline
  }
  // folding must never flip a triangle against the smooth base surface
  let flipped = 0;
  for (let f = 0; f < faces.length; f += 3) { const a = faceNormal(base, faces, f), b = faceNormal(pos, faces, f); if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] <= 0) flipped++; }
  assert.equal(flipped, 0, `hemisphere level ${level}: ${flipped} folded triangles flipped`);
  const idx = Uint32Array.from(faces);
  if (side < 0) { for (let v = 0; v < nv; v++) pos[v * 3] = -pos[v * 3]; for (let f = 0; f < idx.length; f += 3) { const t = idx[f + 1]; idx[f + 1] = idx[f + 2]; idx[f + 2] = t; } }
  return { pos: Float32Array.from(pos), normal: Float32Array.from(vertexNormals(pos, idx)), curv, indices: idx };
}

// ---------- brainstem: closed loft from the medulla up into the midbrain, with an anterior pontine bulge ----------
function brainstem(strips, around) {
  const at = (u, a) => {
    const s = Math.sin(u), t = (s + 1) / 2, env = Math.cos(u) ** 0.32;
    const pons = Math.exp(-(((t - 0.52) / 0.13) ** 2)), mid = smooth(0.7, 1.0, t);
    const cy = -1.0 + 0.81 * t, cz = -0.165 + 0.07 * t;
    const rx = (0.064 + 0.046 * smooth(0.15, 0.6, t) + 0.024 * pons + 0.012 * mid) * env;
    const rf = (0.052 + 0.026 * smooth(0.1, 0.6, t) + 0.060 * pons) * env, rb = (0.058 + 0.016 * smooth(0.2, 0.7, t)) * env;
    const sa = Math.sin(a), ca = Math.cos(a), rz = sa > 0 ? rf : rb;
    // shallow longitudinal striations (pyramids, olives) as the curvature cue
    const ridge = 0.004 * Math.cos(4 * a) * env;
    return [(rx + ridge) * ca, cy, cz + (rz + ridge) * sa, 0.35 * Math.cos(4 * a) - 0.15 * pons];
  };
  const pos = [], curv = [], idx = [];
  const push = (p) => { pos.push(p[0], p[1], p[2]); curv.push(p[3]); };
  push(at(-PI / 2, 0));
  for (let i = 1; i < strips; i++) for (let j = 0; j < around; j++) push(at(PI * (i / strips - 0.5), TAU * j / around));
  const top = pos.length / 3; push(at(PI / 2, 0));
  for (let j = 0; j < around; j++) {
    const k = (j + 1) % around;
    idx.push(0, 1 + j, 1 + k);
    for (let i = 0; i < strips - 2; i++) { const o = 1 + i * around, r = o + around; idx.push(o + j, r + j, r + k, o + j, r + k, o + k); }
    idx.push(top - around + j, top, top - around + k);
  }
  const P = Float32Array.from(pos), I = Uint32Array.from(idx);
  return { pos: P, normal: Float32Array.from(vertexNormals(P, I)), curv: Float32Array.from(curv), indices: I };
}

/** Signed volume of a closed mesh (positive = outward winding). */
function volume(m) {
  let v = 0; const p = m.pos, I = m.indices;
  for (let f = 0; f < I.length; f += 3) {
    const a = I[f] * 3, b = I[f + 1] * 3, c = I[f + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

// ---------- GLB writer ----------
function glb(parts, generator) {
  const chunks = [], views = [], accessors = [], meshes = [], nodes = []; let off = 0;
  const view = (arr, target) => { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), pad = (4 - (b.length % 4)) % 4; chunks.push(b, Buffer.alloc(pad)); views.push({ buffer: 0, byteOffset: off, byteLength: b.length, target }); off += b.length + pad; return views.length - 1; };
  for (const [name, m] of parts) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.pos.length; i++) { const k = i % 3; mn[k] = Math.min(mn[k], m.pos[i]); mx[k] = Math.max(mx[k], m.pos[i]); }
    const a0 = accessors.length, count = m.pos.length / 3;
    accessors.push({ bufferView: view(m.pos, 34962), componentType: 5126, count, type: "VEC3", min: mn, max: mx });
    accessors.push({ bufferView: view(m.normal, 34962), componentType: 5126, count, type: "VEC3" });
    accessors.push({ bufferView: view(m.curv, 34962), componentType: 5126, count, type: "SCALAR" });
    accessors.push({ bufferView: view(m.indices, 34963), componentType: 5125, count: m.indices.length, type: "SCALAR" });
    meshes.push({ name, primitives: [{ attributes: { POSITION: a0, NORMAL: a0 + 1, _CURV: a0 + 2 }, indices: a0 + 3, mode: 4 }] });
    nodes.push({ name, mesh: meshes.length - 1 });
  }
  const json = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews: views, buffers: [{ byteLength: off }] };
  const text = Buffer.from(JSON.stringify(json)), jpad = Buffer.alloc((4 - (text.length % 4)) % 4, 0x20), bin = Buffer.concat(chunks);
  const head = Buffer.alloc(20); head.write("glTF"); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + text.length + jpad.length + bin.length, 8); head.writeUInt32LE(text.length + jpad.length, 12); head.write("JSON", 16);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length); bh.write("BIN\0", 4);
  return Buffer.concat([head, text, jpad, bh, bin]);
}

const LODS = [
  { file: "assets/brain.glb", cortex: 6, cb: [111, 164], bs: [72, 56] },
  { file: "assets/brain_low.glb", cortex: 5, cb: [53, 94], bs: [60, 40] },
];
mkdirSync("assets", { recursive: true });
for (const L of LODS) {
  const parts = [["cortex_lh", hemisphere(L.cortex, -1)], ["cortex_rh", hemisphere(L.cortex, 1)], ["cerebellum", cerebellumMesh(...L.cb)], ["brainstem", brainstem(...L.bs)]];
  for (const [n, m] of parts) assert(volume(m) > 0, `${n}: outward winding and positive volume`);
  const bytes = glb(parts, "Palace Atlas procedural brain (scripts/build-brain.mjs)");
  writeFileSync(L.file, bytes);
  console.log(`${L.file}: ${parts.map(([n, m]) => `${n} ${m.indices.length / 3} tris`).join(", ")} (${bytes.length} bytes)`);
}
