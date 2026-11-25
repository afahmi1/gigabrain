// Signed distance field of the brain volume: generation (build time, and a runtime fallback for assets without a shipped field).
// The field is built from exactly the meshes that are rendered (cortex_lh, cortex_rh, cerebellum, brainstem plus generated internal bridge
// volumes), so "inside the field" and "inside the drawn brain" are the same region. Positive depth = inside, in world units.
import { Field, FieldBridge, FieldHeader, V3 } from "./field";

export interface RawMesh { pos: ArrayLike<number>; idx: ArrayLike<number>; }
export const VOXEL = 2 / 128;       // voxel edge in world units (the brain is about 2.0 units long)
export const Q = 16;                // stored units per voxel
const PAD = 8;

/** Signed volume / 6; the sign tells the winding: negative = inside-out (must invert a parity fill). */
export function signedVolume(m: RawMesh): number { const P = m.pos, I = m.idx; let v = 0; for (let t = 0; t < I.length; t += 3) { const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3; v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6; } return v; }
export function meshBounds(m: RawMesh): { min: V3; max: V3 } {
  const min: V3 = [1e9, 1e9, 1e9], max: V3 = [-1e9, -1e9, -1e9], p = m.pos;
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < min[k]) min[k] = p[i + k]; if (p[i + k] > max[k]) max[k] = p[i + k]; }
  return { min, max };
}

/** Internal bridge volumes that make the brain one connected piece: corpus callosum (deep arch between the medial walls), diencephalon / cerebral
 *  peduncles (cerebrum to brainstem) and cerebellar peduncles (brainstem to cerebellum). Placed from the mesh bounding boxes, so any asset with the
 *  same part names gets sensible tracts. All numbers are fractions of the part sizes. */
export function makeBridges(b: Record<string, RawMesh>): FieldBridge[] {
  const out: FieldBridge[] = [];
  const cer = ["cortex_lh", "cortex_rh"].filter((k) => b[k]).map((k) => meshBounds(b[k]));
  if (!cer.length) return out;
  const cmin: V3 = [Math.min(...cer.map((c) => c.min[0])), Math.min(...cer.map((c) => c.min[1])), Math.min(...cer.map((c) => c.min[2]))];
  const cmax: V3 = [Math.max(...cer.map((c) => c.max[0])), Math.max(...cer.map((c) => c.max[1])), Math.max(...cer.map((c) => c.max[2]))];
  const W = cmax[0] - cmin[0], H = cmax[1] - cmin[1], L = cmax[2] - cmin[2], cx = (cmax[0] + cmin[0]) / 2;
  const Y = (f: number) => cmin[1] + f * H, Z = (f: number) => cmin[2] + f * L;
  const rCC = Math.min(0.1, 0.075 * H), arch: [number, number][] = [[0.70, 0.57], [0.65, 0.64], [0.55, 0.70], [0.45, 0.71], [0.38, 0.66], [0.33, 0.57]]; // (z fraction, y fraction) genu .. splenium
  const hx = 0.13 * W;
  arch.forEach(([zf, yf], i) => { out.push({ a: [cx - hx, Y(yf), Z(zf)], b: [cx + hx, Y(yf), Z(zf)], r: rCC, name: "cc" }); if (i) { /* consecutive slabs overlap through their radius */ } });
  const bs = b.brainstem ? meshBounds(b.brainstem) : null, cb = b.cerebellum ? meshBounds(b.cerebellum) : null;
  const rDi = Math.min(0.09, 0.07 * H);
  if (bs) {
    const bx = (bs.min[0] + bs.max[0]) / 2, bz = (bs.min[2] + bs.max[2]) / 2, bh = bs.max[1] - bs.min[1];
    const top: V3 = [bx, bs.max[1] - 0.28 * bh, bz]; // attach at the pons (deepest part of the brainstem), not the thin midbrain
    for (const s of [-1, 1]) {
      const th: V3 = [cx + s * 0.075 * W, Y(0.47), Z(0.47)], up: V3 = [cx + s * 0.06 * W, Y(0.66), Z(0.52)];
      out.push({ a: top, b: th, r: rDi, name: "dienc" }, { a: th, b: up, r: rDi, name: "dienc" });
    }
    if (cb) {
      const cbx = (cb.max[0] - cb.min[0]) / 2, cby = (cb.min[1] + cb.max[1]) / 2, cbz = cb.min[2] + 0.62 * (cb.max[2] - cb.min[2]), rCb = Math.min(0.09, 0.33 * (cb.max[1] - cb.min[1]));
      for (const s of [-1, 1]) {
        const a: V3 = [bx + s * 0.02, bs.min[1] + 0.74 * bh, bz - 0.05], mid: V3 = [bx + s * 0.35 * cbx, cby, cbz + 0.02], end: V3 = [bx + s * 0.45 * cbx, cby, cb.min[2] + 0.45 * (cb.max[2] - cb.min[2])];
        out.push({ a, b: mid, r: rCb, name: "cbp" }, { a: mid, b: end, r: rCb, name: "cbp" });
      }
    }
  }
  return out;
}

/** Closed capsule mesh (cylinder with hemispherical caps). Circumscribes the true capsule so the mesh is never smaller than the field. */
export function capsuleMesh(a: V3, b: V3, r: number, radial = 14, rings = 4): RawMesh {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d) || 1e-9, w: V3 = [d[0] / l, d[1] / l, d[2] / l];
  const ref: V3 = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [ref[1] * w[2] - ref[2] * w[1], ref[2] * w[0] - ref[0] * w[2], ref[0] * w[1] - ref[1] * w[0]]; const ul = Math.hypot(...u); u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const rr = r / Math.cos(Math.PI / radial), pos: number[] = [], idx: number[] = [];
  // rings from the pole at a, around a's hemisphere to its equator, then b's equator and hemisphere to the pole at b
  const ring: { c: V3; k: number; s: number }[] = [];
  for (let i = 0; i <= rings; i++) { const th = -Math.PI / 2 + (i / rings) * (Math.PI / 2); ring.push({ c: a, k: Math.sin(th), s: Math.cos(th) }); }
  for (let i = 0; i <= rings; i++) { const th = (i / rings) * (Math.PI / 2); ring.push({ c: b, k: Math.sin(th), s: Math.cos(th) }); }
  for (const R of ring) for (let j = 0; j < radial; j++) {
    const ang = (j / radial) * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang), s = R.s * rr;
    pos.push(R.c[0] + w[0] * R.k * rr + (u[0] * cs + v[0] * sn) * s, R.c[1] + w[1] * R.k * rr + (u[1] * cs + v[1] * sn) * s, R.c[2] + w[2] * R.k * rr + (u[2] * cs + v[2] * sn) * s);
  }
  for (let i = 0; i + 1 < ring.length; i++) for (let j = 0; j < radial; j++) {
    const a0 = i * radial + j, a1 = i * radial + (j + 1) % radial, b0 = (i + 1) * radial + j, b1 = (i + 1) * radial + (j + 1) % radial;
    idx.push(a0, a1, b0, a1, b1, b0);
  }
  return { pos, idx };
}

interface Grid { h: number; origin: V3; dims: [number, number, number]; }
const vi = (g: Grid, i: number, j: number, k: number) => (k * g.dims[1] + j) * g.dims[0] + i;

/** Parity ray casting along +z. Exact for watertight meshes. Returns the number of columns with an odd crossing count (0 for a closed mesh). */
function voxelizeParity(m: RawMesh, g: Grid, mask: Uint8Array, span = false, stat?: { cols: number; multi: number }): number {
  const [nx, ny, nz] = g.dims, { h, origin } = g, ex = 0.0123 * h, ey = 0.0071 * h, P = m.pos, I = m.idx, cols = new Map<number, number[]>();
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - origin[0] - ex) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - origin[0] - ex) / h - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - origin[1] - ey) / h - 0.5)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - origin[1] - ey) / h - 0.5));
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay); if (Math.abs(det) < 1e-18) continue;
    for (let i = i0; i <= i1; i++) {
      const x = origin[0] + (i + 0.5) * h + ex;
      for (let j = j0; j <= j1; j++) {
        const y = origin[1] + (j + 0.5) * h + ey, u = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / det, v = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / det;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const key = i * ny + j; let arr = cols.get(key); if (!arr) cols.set(key, (arr = [])); arr.push(az + u * (bz - az) + v * (cz - az));
      }
    }
  }
  let odd = 0;
  cols.forEach((arr, key) => {
    if (stat) { stat.cols++; if (arr.length >= 2) stat.multi++; }
    arr.sort((p, q) => p - q); const i = Math.floor(key / ny), j = key % ny; if (arr.length % 2) { odd++; if (!span) arr.pop(); }
    if (span && arr.length > 2) arr.splice(1, arr.length - 2); // span mode: fill from the first to the last hit (robust for meshes with holes)
    for (let q = 0; q + 1 < arr.length; q += 2) {
      const k0 = Math.max(0, Math.ceil((arr[q] - origin[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((arr[q + 1] - origin[2]) / h - 0.5));
      for (let k = k0; k <= k1; k++) mask[vi(g, i, j, k)] = 1;
    }
  });
  return odd;
}

/** Visual hull for meshes that are not watertight: a voxel is inside when the span between the first and last surface hit contains it along all three axes. */
function voxelizeHull(m: RawMesh, g: Grid, mask: Uint8Array) {
  const [nx, ny, nz] = g.dims, N = nx * ny * nz, acc = new Uint8Array(N).fill(1), P = m.pos, bb = meshBounds(m);
  for (let ax = 0; ax < 3; ax++) {
    const a = ax, b = (ax + 1) % 3, c = (ax + 2) % 3, pp = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) { pp[i] = P[i + b]; pp[i + 1] = P[i + c]; pp[i + 2] = P[i + a]; }
    const gp: Grid = { h: g.h, origin: [g.origin[b], g.origin[c], g.origin[a]], dims: [g.dims[b], g.dims[c], g.dims[a]] }, tmp = new Uint8Array(N), st = { cols: 0, multi: 0 };
    voxelizeParity({ pos: pp, idx: m.idx }, gp, tmp, true, st);
    if (st.multi < 0.5 * st.cols) continue; // this direction does not cross the surface twice (open end): it carries no information
    const dims = g.dims, dp = gp.dims;
    for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) { const o = [i, j, k]; if (!tmp[(o[a] * dp[1] + o[c]) * dp[0] + o[b]]) acc[vi(g, i, j, k)] = 0; }
  }
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { // always stay inside the mesh bounding box
    const v = vi(g, i, j, k); if (!acc[v]) continue; const x = g.origin[0] + (i + 0.5) * g.h, y = g.origin[1] + (j + 0.5) * g.h, z = g.origin[2] + (k + 0.5) * g.h;
    if (x >= bb.min[0] && x <= bb.max[0] && y >= bb.min[1] && y <= bb.max[1] && z >= bb.min[2] && z <= bb.max[2]) mask[v] = 1;
  }
}

function rasterCapsule(mask: Uint8Array, g: Grid, a: V3, b: V3, r: number) {
  const [nx, ny, nz] = g.dims, { h, origin } = g, lo = [0, 1, 2].map((k) => Math.max(0, Math.floor((Math.min(a[k], b[k]) - r - origin[k]) / h))), hi = [nx, ny, nz].map((n, k) => Math.min(n - 1, Math.ceil((Math.max(a[k], b[k]) + r - origin[k]) / h)));
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
    const px = origin[0] + (i + 0.5) * h, py = origin[1] + (j + 0.5) * h, pz = origin[2] + (k + 0.5) * h;
    const t = Math.max(0, Math.min(1, ((px - a[0]) * d[0] + (py - a[1]) * d[1] + (pz - a[2]) * d[2]) / dd)), qx = px - a[0] - d[0] * t, qy = py - a[1] - d[1] * t, qz = pz - a[2] - d[2] * t;
    if (qx * qx + qy * qy + qz * qz <= r * r) mask[vi(g, i, j, k)] = 1;
  }
}

// Felzenszwalb-Huttenlocher squared Euclidean distance transform.
function edt1(f: Float64Array, n: number, v: Int32Array, z: Float64Array, out: Float64Array) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0; for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
}
function edt3(target: Uint8Array, g: Grid): Float64Array {
  const [nx, ny, nz] = g.dims, N = nx * ny * nz, f = new Float64Array(N), INF = 1e12;
  for (let i = 0; i < N; i++) f[i] = target[i] ? 0 : INF;
  const m = Math.max(nx, ny, nz), buf = new Float64Array(m), out = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const b = (k * ny + j) * nx; for (let i = 0; i < nx; i++) buf[i] = f[b + i]; edt1(buf, nx, v, z, out); for (let i = 0; i < nx; i++) f[b + i] = out[i]; }
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { for (let j = 0; j < ny; j++) buf[j] = f[(k * ny + j) * nx + i]; edt1(buf, ny, v, z, out); for (let j = 0; j < ny; j++) f[(k * ny + j) * nx + i] = out[j]; }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { for (let k = 0; k < nz; k++) buf[k] = f[(k * ny + j) * nx + i]; edt1(buf, nz, v, z, out); for (let k = 0; k < nz; k++) f[(k * ny + j) * nx + i] = out[k]; }
  return f;
}

export interface GenInfo { voxels: number; parts: Record<string, { voxels: number; method: "parity" | "hull" }>; bridges: number; }
/** Safety bias (voxels) subtracted from the stored depth: the voxel EDT can overestimate depth by up to ~1.25 voxel (measured in the narrow sulci of the procedural cortex), so a stored depth of d means the true distance is >= d. */
export const BIAS = 1.25;
function erodeMask(mask: Uint8Array, g: Grid, vox: number) {
  const N = mask.length, inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = mask[i] ? 0 : 1;
  const d = edt3(inv, g), r2 = vox * vox; for (let i = 0; i < N; i++) if (mask[i] && d[i] < r2) mask[i] = 0;
}
/** Build the field. `meshes` is one set of named meshes, or several LODs of the same brain: the region is the INTERSECTION over the LODs, so the margin holds at every quality level.
 *  `erode` removes a number of voxels from a named part (hull-built parts: the measured maximum groove depth). Spinal cord meshes are ignored. */
export function generateField(meshes: Record<string, RawMesh> | Record<string, RawMesh>[], opts: { smooth?: boolean; bridges?: FieldBridge[]; extra?: Record<string, unknown>; erode?: Record<string, number> } = {}): { field: Field; info: GenInfo } {
  const lods = Array.isArray(meshes) ? meshes : [meshes], main = lods[0], names = ["cortex_lh", "cortex_rh", "cerebellum", "brainstem"].filter((n) => main[n]);
  const mn: V3 = [1e9, 1e9, 1e9], mx: V3 = [-1e9, -1e9, -1e9];
  for (const L of lods) for (const n of names) if (L[n]) { const b = meshBounds(L[n]); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); } }
  const h = VOXEL, origin = mn.map((v) => Math.floor(v / h - PAD) * h) as V3, dims = mx.map((v, k) => Math.ceil((v - origin[k]) / h + PAD)) as [number, number, number];
  const g: Grid = { h, origin, dims }, N = dims[0] * dims[1] * dims[2], mask = new Uint8Array(N), info: GenInfo = { voxels: 0, parts: {}, bridges: 0 };
  for (const n of names) {
    let acc: Uint8Array | null = null, method: "parity" | "hull" = "parity";
    for (const L of lods) {
      if (!L[n]) continue; const part = new Uint8Array(N), odd = voxelizeParity(L[n], g, part);
      if (odd > 0) { part.fill(0); voxelizeHull(L[n], g, part); method = "hull"; }
      if (!acc) acc = part; else for (let i = 0; i < N; i++) acc[i] &= part[i];
    }
    if (!acc) continue; const er = opts.erode?.[n] ?? 0; if (er > 0) erodeMask(acc, g, er);
    let c = 0; for (let i = 0; i < N; i++) if (acc[i]) { mask[i] = 1; c++; } info.parts[n] = { voxels: c, method };
  }
  const bridges = opts.bridges ?? makeBridges(main); info.bridges = bridges.length;
  for (const b of bridges) rasterCapsule(mask, g, b.a, b.b, b.r);
  const inv = new Uint8Array(N); for (let i = 0; i < N; i++) { inv[i] = mask[i] ? 0 : 1; if (mask[i]) info.voxels++; }
  const toIn = edt3(mask, g), toOut = edt3(inv, g); let sd = new Float32Array(N);
  for (let i = 0; i < N; i++) sd[i] = mask[i] ? Math.sqrt(toOut[i]) - 0.5 : -(Math.sqrt(toIn[i]) - 0.5);
  if (opts.smooth !== false) {
    const tmp = new Float32Array(N), [nx, ny, nz] = dims;
    for (let ax = 0; ax < 3; ax++) {
      const st = ax === 0 ? 1 : ax === 1 ? nx : nx * ny, len = dims[ax];
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = vi(g, i, j, k), c = [i, j, k][ax]; const a = c > 0 ? sd[v - st] : sd[v], b = c < len - 1 ? sd[v + st] : sd[v]; tmp[v] = (a + 2 * sd[v] + b) / 4; }
      sd = Float32Array.from(tmp);
    }
  }
  const data = new Int16Array(N); for (let i = 0; i < N; i++) data[i] = Math.max(-32000, Math.min(32000, Math.round((sd[i] - BIAS) * Q)));
  const header: FieldHeader = { version: 1, h, origin, dims, q: Q, bridges, bias: BIAS, ...(opts.extra ?? {}) };
  return { field: new Field(header, data), info };
}

/** Minimal GLB reader (positions and indices of every mesh, by mesh name). Build tools and tests only. */
export function readGlbMeshes(bytes: Uint8Array): Record<string, { pos: Float32Array; idx: Uint32Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), jl = dv.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jl))), bin = 20 + jl + 8, out: Record<string, { pos: Float32Array; idx: Uint32Array }> = {};
  for (const m of json.meshes) {
    const p = m.primitives[0], pa = json.accessors[p.attributes.POSITION], ia = json.accessors[p.indices], pv = json.bufferViews[pa.bufferView], iv = json.bufferViews[ia.bufferView];
    const pos = new Float32Array(pa.count * 3), po = bin + (pv.byteOffset || 0) + (pa.byteOffset || 0), idx = new Uint32Array(ia.count), io = bin + (iv.byteOffset || 0) + (ia.byteOffset || 0);
    for (let i = 0; i < pos.length; i++) pos[i] = dv.getFloat32(po + i * 4, true);
    for (let i = 0; i < idx.length; i++) idx[i] = ia.componentType === 5125 ? dv.getUint32(io + i * 4, true) : dv.getUint16(io + i * 2, true);
    if (signedVolume({ pos, idx }) < 0) for (let t = 0; t + 3 <= idx.length; t += 3) { const a = idx[t]; idx[t] = idx[t + 1]; idx[t + 1] = a; } // normalise to outward winding (parity then fills the interior)
    out[m.name] = { pos, idx };
  }
  return out;
}
