// Runtime side of the brain signed distance field: trilinear depth, gradient, projection into the interior, connected-core labelling.
// Depth is in WORLD units, positive inside the brain, negative outside. Everything that glows must stay at depth >= MARGIN.
export type V3 = [number, number, number];
export interface FieldBridge { a: V3; b: V3; r: number; name: string; }
export interface FieldHeader { version: 1; h: number; origin: V3; dims: [number, number, number]; q: number; bridges: FieldBridge[]; [extra: string]: unknown; }

/** World-unit margin every glowing element keeps below the surface: max(2 voxels, half the ribbon width plus glow radius). */
export const RIBBON_HALF = 0.008, GLOW_RADIUS = 0.04;
export const marginFor = (h: number) => Math.max(2 * h, RIBBON_HALF + GLOW_RADIUS);
const MAGIC = 0x46445350; // "PSDF"

export class Field {
  readonly h: number; readonly origin: V3; readonly dims: [number, number, number]; readonly q: number; readonly bridges: FieldBridge[];
  readonly margin: number; readonly fadeBand: number;
  private nx: number; private ny: number; private nz: number; private inv: number;
  private cores = new Map<string, { label: Int32Array; main: number; size: number; count: number }>();
  /** Counters (tests, diag): projections that needed the grid search or the A* path fallback. */
  stats = { projected: 0, searched: 0, projectFailed: 0 };
  /** Exact signed distance source (BVH on the real meshes). When set, projection/clipping use true distance, not the voxel EDT (which cannot resolve thin sulci). */
  exact?: { dist: (x: number, y: number, z: number) => number } | null;
  constructor(readonly header: FieldHeader, readonly data: Int16Array) {
    this.h = header.h; this.origin = header.origin; this.dims = header.dims; this.q = header.q; this.bridges = header.bridges ?? [];
    [this.nx, this.ny, this.nz] = header.dims; this.inv = this.h / this.q;     // stored int -> world units
    this.margin = marginFor(this.h); this.fadeBand = 2 * this.h;
  }
  /** Raw depth in world units at voxel (i,j,k); outside the grid it is the (negative) distance to the grid box. */
  private vox(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) { // outside the grid: clamp (the border is far outside the brain)
      i = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i; j = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j; k = k < 0 ? 0 : k >= this.nz ? this.nz - 1 : k;
    }
    return this.data[(k * this.ny + j) * this.nx + i] * this.inv;
  }
  /** Exact distance when available, else the voxel EDT (which may overestimate near thin sulci). */
  depthE(x: number, y: number, z: number): number { return this.exact ? this.exact.dist(x, y, z) : this.depth(x, y, z); }
  /** Trilinear depth (world units). Positive inside. */
  depth(x: number, y: number, z: number): number {
    const h = this.h, o = this.origin, fx = (x - o[0]) / h - 0.5, fy = (y - o[1]) / h - 0.5, fz = (z - o[2]) / h - 0.5;
    // far outside the grid: distance to the grid box dominates (keeps the field monotone so projection can walk back in)
    const bx = Math.max(-fx - 0.5, fx - (this.nx - 0.5), 0), by = Math.max(-fy - 0.5, fy - (this.ny - 0.5), 0), bz = Math.max(-fz - 0.5, fz - (this.nz - 0.5), 0);
    const ob = Math.hypot(bx, by, bz);
    if (ob > 0) { const cx = Math.min(this.nx - 1, Math.max(0, fx)), cy = Math.min(this.ny - 1, Math.max(0, fy)), cz = Math.min(this.nz - 1, Math.max(0, fz)); return this.trilinear(cx, cy, cz) - ob * h; }
    return this.trilinear(fx, fy, fz);
  }
  private trilinear(fx: number, fy: number, fz: number): number {
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), tx = fx - i, ty = fy - j, tz = fz - k;
    const c000 = this.vox(i, j, k), c100 = this.vox(i + 1, j, k), c010 = this.vox(i, j + 1, k), c110 = this.vox(i + 1, j + 1, k);
    const c001 = this.vox(i, j, k + 1), c101 = this.vox(i + 1, j, k + 1), c011 = this.vox(i, j + 1, k + 1), c111 = this.vox(i + 1, j + 1, k + 1);
    const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx, x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
    return y0 + (y1 - y0) * tz;
  }
  depthV(p: ArrayLike<number>) { return this.depth(p[0], p[1], p[2]); }
  /** Unit gradient of depth (points toward the interior). Zero vector on a flat spot. */
  grad(x: number, y: number, z: number, out: V3 = [0, 0, 0]): V3 {
    const e = this.h * 0.75;
    const gx = this.depth(x + e, y, z) - this.depth(x - e, y, z), gy = this.depth(x, y + e, z) - this.depth(x, y - e, z), gz = this.depth(x, y, z + e) - this.depth(x, y, z - e), l = Math.hypot(gx, gy, gz);
    if (l < 1e-9) { out[0] = out[1] = out[2] = 0; return out; }
    out[0] = gx / l; out[1] = gy / l; out[2] = gz / l; return out;
  }
  /** Intensity fade 0..1 for a glowing element at depth d: 0 at the margin, 1 at margin + fade band. */
  fade(d: number): number { const t = (d - this.margin) / this.fadeBand; return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }

  // ---- connected core: the region at depth >= minDepth, labelled; the largest piece is the usable interior ----
  private core(minDepth: number) {
    const key = minDepth.toFixed(5); let c = this.cores.get(key); if (c) return c;
    const { nx, ny, nz } = this, N = nx * ny * nz, thr = Math.round(minDepth / this.inv), d = this.data, label = new Int32Array(N); let id = 0, main = 0, mainSize = 0, count = 0;
    const st: number[] = [];
    for (let s = 0; s < N; s++) {
      if (d[s] < thr || label[s]) continue; id++; let n = 0; st.length = 0; st.push(s); label[s] = id;
      while (st.length) {
        const v = st.pop()!; n++; const i = v % nx, j = ((v / nx) | 0) % ny, k = (v / (nx * ny)) | 0;
        if (i > 0 && d[v - 1] >= thr && !label[v - 1]) { label[v - 1] = id; st.push(v - 1); } if (i < nx - 1 && d[v + 1] >= thr && !label[v + 1]) { label[v + 1] = id; st.push(v + 1); }
        if (j > 0 && d[v - nx] >= thr && !label[v - nx]) { label[v - nx] = id; st.push(v - nx); } if (j < ny - 1 && d[v + nx] >= thr && !label[v + nx]) { label[v + nx] = id; st.push(v + nx); }
        if (k > 0 && d[v - nx * ny] >= thr && !label[v - nx * ny]) { label[v - nx * ny] = id; st.push(v - nx * ny); } if (k < nz - 1 && d[v + nx * ny] >= thr && !label[v + nx * ny]) { label[v + nx * ny] = id; st.push(v + nx * ny); }
      }
      count++; if (n > mainSize) { mainSize = n; main = id; }
    }
    c = { label, main, size: mainSize, count }; this.cores.set(key, c); return c;
  }
  /** Voxel index of a world point (nearest voxel centre), or -1 outside the grid. */
  voxelOf(x: number, y: number, z: number): number {
    const i = Math.round((x - this.origin[0]) / this.h - 0.5), j = Math.round((y - this.origin[1]) / this.h - 0.5), k = Math.round((z - this.origin[2]) / this.h - 0.5);
    return i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz ? -1 : (k * this.ny + j) * this.nx + i;
  }
  centerOf(v: number, out: V3 = [0, 0, 0]): V3 { const i = v % this.nx, j = ((v / this.nx) | 0) % this.ny, k = (v / (this.nx * this.ny)) | 0; out[0] = this.origin[0] + (i + 0.5) * this.h; out[1] = this.origin[1] + (j + 0.5) * this.h; out[2] = this.origin[2] + (k + 0.5) * this.h; return out; }
  /** Is the point in the main connected interior (depth >= minDepth)? */
  inMainCore(p: ArrayLike<number>, minDepth: number): boolean {
    const c = this.core(minDepth), v = this.voxelOf(p[0], p[1], p[2]); return v >= 0 && c.label[v] === c.main;
  }
  /** Labels of the connected pieces of the region at depth >= minDepth, and the label of the largest. */
  coreMask(minDepth: number): { label: Int32Array; main: number } { const c = this.core(minDepth); return { label: c.label, main: c.main }; }
  /** Number of voxels in the main core and number of separate pieces (tests). */
  coreInfo(minDepth: number) { const c = this.core(minDepth); return { main: c.size, pieces: c.count }; }
  /** Voxel of the main core nearest to p (shell search). */
  nearestCore(p: ArrayLike<number>, minDepth: number, out: V3 = [0, 0, 0]): V3 {
    const c = this.core(minDepth), { nx, ny, nz } = this; this.stats.searched++;
    const ci = Math.max(0, Math.min(nx - 1, Math.round((p[0] - this.origin[0]) / this.h - 0.5))), cj = Math.max(0, Math.min(ny - 1, Math.round((p[1] - this.origin[1]) / this.h - 0.5))), ck = Math.max(0, Math.min(nz - 1, Math.round((p[2] - this.origin[2]) / this.h - 0.5)));
    let best = -1, bd = Infinity; const maxR = Math.max(nx, ny, nz);
    for (let R = 0; R <= maxR; R++) {
      if (best >= 0 && R > Math.sqrt(bd) + 1) break;
      for (let k = Math.max(0, ck - R); k <= Math.min(nz - 1, ck + R); k++) for (let j = Math.max(0, cj - R); j <= Math.min(ny - 1, cj + R); j++) for (let i = Math.max(0, ci - R); i <= Math.min(nx - 1, ci + R); i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== R) continue;
        const v = (k * ny + j) * nx + i; if (c.label[v] !== c.main) continue; const dd = (i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2; if (dd < bd) { bd = dd; best = v; }
      }
    }
    if (best < 0) { out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; }
    return this.centerOf(best, out);
  }
  /** Certified routable interior ("R6"): voxels whose EXACT centre distance is >= target + 0.5h, 6-connected, largest component. One definition shared by soma projection and A*:
   *  a straight step between 6-adjacent centres then stays >= target (exact distance is 1-Lipschitz, half step = 0.5h). Built once per asset after `exact` is set. */
  r6: { E: Float32Array; lab: Int32Array; main: number; size: number; comps: number; target: number } | null = null;
  buildR6(slack = 0.2): void {
    const { nx, ny, nz } = this, N = nx * ny * nz, h = this.h, inv = h / this.q, M = this.margin, target = M + slack * h, E = new Float32Array(N).fill(-1), c: V3 = [0, 0, 0];
    for (let v = 0; v < N; v++) { if (this.data[v] * inv < M - h) continue; this.centerOf(v, c); E[v] = this.depthE(c[0], c[1], c[2]); }
    const thr = target + 0.5 * h, lab = new Int32Array(N), sizes: number[] = [0], st: number[] = []; let id = 0;
    for (let s0 = 0; s0 < N; s0++) { if (lab[s0] || E[s0] < thr) continue; id++; let n = 0; st.length = 0; st.push(s0); lab[s0] = id;
      while (st.length) { const v = st.pop()!; n++; for (const w of [v - 1, v + 1, v - nx, v + nx, v - nx * ny, v + nx * ny]) if (w >= 0 && w < N && !lab[w] && E[w] >= thr) { lab[w] = id; st.push(w); } } sizes.push(n); }
    let main = 1; for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
    this.r6 = { E, lab, main, size: sizes[main] ?? 0, comps: id, target };
  }
  /** Nearest R6 main-component voxel centre whose exact depth >= need (optionally also grid depth >= margin). Null if none within the search shell. */
  nearestR6(p: ArrayLike<number>, need: number, gridToo: boolean, out: V3 = [0, 0, 0]): V3 | null {
    const r6 = this.r6!, { nx, ny, nz } = this, inv = this.h / this.q, M = this.margin;
    const cl = (v: number, n: number) => Math.max(0, Math.min(n - 1, v)); // far-outside points search from the nearest grid cell
    const i0 = cl(Math.round((p[0] - this.origin[0]) / this.h - 0.5), nx), j0 = cl(Math.round((p[1] - this.origin[1]) / this.h - 0.5), ny), k0 = cl(Math.round((p[2] - this.origin[2]) / this.h - 0.5), nz); let best = -1, bd = Infinity;
    for (let R = 0; R <= 90; R++) {
      if (best >= 0 && R > Math.sqrt(bd) + 1) break;
      for (let k = k0 - R; k <= k0 + R; k++) for (let j = j0 - R; j <= j0 + R; j++) for (let i = i0 - R; i <= i0 + R; i++) {
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz || Math.max(Math.abs(i - i0), Math.abs(j - j0), Math.abs(k - k0)) !== R) continue;
        const v = (k * ny + j) * nx + i; if (r6.lab[v] !== r6.main || r6.E[v] < need || (gridToo && this.data[v] * inv < M - 1e-6)) continue;
        const dd = (i - i0) ** 2 + (j - j0) ** 2 + (k - k0) ** 2; if (dd < bd) { bd = dd; best = v; }
      }
    }
    return best < 0 ? null : this.centerOf(best, out);
  }
  private projectR6(p: ArrayLike<number>, need: number, out: V3): V3 {
    const r6 = this.r6!; let x = p[0], y = p[1], z = p[2]; const M = this.margin, target = need + 0.35 * this.h, g: V3 = [0, 0, 0];
    const good = (a: number, b: number, c: number) => { const v = this.voxelOf(a, b, c); return v >= 0 && r6.lab[v] === r6.main && this.depthE(a, b, c) >= need && this.depth(a, b, c) >= M - 1e-6; };
    if (!good(x, y, z)) {
      this.stats.projected++; let ok = false;
      for (let it = 0; it < 24; it++) {
        if (good(x, y, z)) { ok = true; break; }
        const d = this.depthE(x, y, z); this.grad(x, y, z, g); if (g[0] === 0 && g[1] === 0 && g[2] === 0) break;
        const step = d < target ? Math.max(this.h * 0.5, target - d) : this.h; x += g[0] * Math.min(step, this.h * 6); y += g[1] * Math.min(step, this.h * 6); z += g[2] * Math.min(step, this.h * 6);
      }
      if (!ok) { const c = this.nearestR6([x, y, z], need, true, g) ?? this.nearestR6([x, y, z], need, false, g); if (c) { x = c[0]; y = c[1]; z = c[2]; } else this.stats.projectFailed++; }
    }
    out[0] = x; out[1] = y; out[2] = z; return out;
  }
  /**
   * Move p into the interior so that depth >= need (and it lies in the main connected core). Follows the depth gradient, then falls back to the
   * nearest core voxel. Returns the (possibly unchanged) point; `moved` tells whether it had to move.
   */
  project(p: ArrayLike<number>, need: number = this.margin, out: V3 = [0, 0, 0]): V3 {
    if (this.r6) return this.projectR6(p, need, out);
    let x = p[0], y = p[1], z = p[2];
    const target = need + 0.35 * this.h, g: V3 = [0, 0, 0], coreNeed = Math.min(need, this.margin);
    const good = (a: number, b: number, c: number) => this.depthE(a, b, c) >= need && this.depth(a, b, c) >= coreNeed - 1e-6 && this.inMainCore([a, b, c], coreNeed); // exterior-boundary distance AND the grid margin (the grid defines the connected core)
    let ok = good(x, y, z);
    if (!ok) {
      this.stats.projected++;
      for (let it = 0; it < 24; it++) {
        const d = Math.min(this.depthE(x, y, z), this.depth(x, y, z) + need - coreNeed); if (good(x, y, z)) { ok = true; break; }
        this.grad(x, y, z, g); if (g[0] === 0 && g[1] === 0 && g[2] === 0) break;
        const step = d < target ? Math.max(this.h * 0.5, target - d) : this.h; x += g[0] * Math.min(step, this.h * 6); y += g[1] * Math.min(step, this.h * 6); z += g[2] * Math.min(step, this.h * 6);
      }
      if (!ok) { const c = this.nearestCore([x, y, z], coreNeed, g); x = c[0]; y = c[1]; z = c[2]; // grid search; the voxel centre of the main core is at depth >= coreNeed
        for (let it = 0; it < 8 && this.depthE(x, y, z) < need; it++) { this.grad(x, y, z, g); x += g[0] * this.h; y += g[1] * this.h; z += g[2] * this.h; } // a little deeper if the soma needs more than the margin
        if (this.depthE(x, y, z) < need) this.stats.projectFailed++; }
    }
    out[0] = x; out[1] = y; out[2] = z; return out;
  }
}

// ---- file format: "PSDF", u32 version, u32 json length, json header (padded to 4), Int16 data ----
export function serializeField(f: Field): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(f.header)), pad = (4 - (json.length % 4)) % 4, out = new Uint8Array(12 + json.length + pad + f.data.byteLength), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 1, true); dv.setUint32(8, json.length + pad, true); out.set(json, 12); for (let i = 0; i < pad; i++) out[12 + json.length + i] = 0x20;
  out.set(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength), 12 + json.length + pad); return out;
}
export function parseField(buf: ArrayBuffer): Field {
  const dv = new DataView(buf); if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 1) throw new Error("not a brain field file");
  const jl = dv.getUint32(8, true), header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jl))) as FieldHeader, n = header.dims[0] * header.dims[1] * header.dims[2];
  if (buf.byteLength < 12 + jl + n * 2) throw new Error("brain field file truncated");
  return new Field(header, new Int16Array(buf.slice(12 + jl, 12 + jl + n * 2)));
}
