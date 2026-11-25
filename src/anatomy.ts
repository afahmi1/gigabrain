// Decorative brain silhouette geometry (procedural, NOT anatomical, NOT notes, NOT links).
// Hemisphere shells + sulci/gyri contour lines (marching squares on layout.foldField), cerebellum and brainstem hints.
// Idea: BrainNet Viewer style subdued bilateral surface behind a ball-and-stick network (https://github.com/mingruixia/BrainNet-Viewer).
import { V3, cortexPoint, foldField, CB_C, CB_R } from "./layout";

export interface Mesh { pos: number[]; idx: number[]; }
const PI = Math.PI;
const dirAt = (u: number, v: number): V3 => {
  const z = -0.985 + 1.97 * u, s = Math.sqrt(1 - z * z), phi = (-0.38 + 0.88 * v) * PI;
  return [s * Math.cos(phi), s * Math.sin(phi), z];
};
function gridIdx(nu: number, nv: number, idx: number[]) {
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
}
export function cortexMesh(side: number, nu = 44, nv = 32): Mesh {
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const d = dirAt(i / nu, j / nv); pos.push(...cortexPoint(d[0], d[1], d[2], side, 1.07)); }
  gridIdx(nu, nv, idx);
  return { pos, idx };
}
/** Sulci/gyri hint: iso-contours of the fold field on the cortex surface. Returns segment pairs (6 floats per segment). */
export function gyriLines(side: number, nu = 110, nv = 80, levels = [-0.045, -0.025, -0.008, 0.01, 0.03, 0.05]): number[] {
  const F: number[][] = [], D: V3[][] = [];
  for (let i = 0; i <= nu; i++) { F.push([]); D.push([]); for (let j = 0; j <= nv; j++) { const d = dirAt(i / nu, j / nv); D[i].push(d); F[i].push(foldField(d[0], d[1], d[2])); } }
  const out: number[] = [];
  const pt = (i: number, j: number, i2: number, j2: number, lv: number): V3 => {
    const f1 = F[i][j], f2 = F[i2][j2], t = (lv - f1) / (f2 - f1);
    const a = D[i][j], b = D[i2][j2];
    const d: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const l = Math.hypot(...d) || 1;
    return cortexPoint(d[0] / l, d[1] / l, d[2] / l, side, 1.085);
  };
  for (const lv of levels) for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const c = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]]; // around the cell
    const hits: V3[] = [];
    for (let k = 0; k < 4; k++) {
      const [a0, a1] = c[k], [b0, b1] = c[(k + 1) % 4];
      const fa = F[a0][a1], fb = F[b0][b1];
      if ((fa < lv) !== (fb < lv)) hits.push(pt(a0, a1, b0, b1, lv));
    }
    for (let h = 0; h + 1 < hits.length; h += 2) out.push(...hits[h], ...hits[h + 1]);
  }
  return out;
}
function ellipsoid(c: V3, r: V3, nu = 24, nv = 32): Mesh {
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const th = (i / nu) * PI, ph = (j / nv) * 2 * PI;
    pos.push(c[0] + r[0] * Math.sin(th) * Math.cos(ph), c[1] + r[1] * Math.cos(th), c[2] + r[2] * Math.sin(th) * Math.sin(ph));
  }
  gridIdx(nu, nv, idx);
  return { pos, idx };
}
export const cerebellumMesh = (): Mesh => ellipsoid(CB_C, CB_R);
/** Folia hint: horizontal rings around the cerebellum. */
export function cerebellumLines(rings = 13, seg = 48): number[] {
  const out: number[] = [];
  for (let k = 1; k < rings; k++) {
    const ty = -0.92 + (1.84 * k) / rings, rr = Math.sqrt(1 - ty * ty);
    let prev: V3 | null = null;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * 2 * PI;
      const p: V3 = [CB_C[0] + CB_R[0] * 1.01 * rr * Math.cos(a), CB_C[1] + CB_R[1] * 1.01 * ty, CB_C[2] + CB_R[2] * 1.01 * rr * Math.sin(a)];
      if (prev) out.push(...prev, ...p);
      prev = p;
    }
  }
  return out;
}
export function brainstemMesh(rings = 10, seg = 16): Mesh {
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings, y = -0.28 - 0.62 * t, z = -0.18 - 0.16 * t, r = 0.1 - 0.035 * t;
    for (let j = 0; j <= seg; j++) { const a = (j / seg) * 2 * PI; pos.push(r * Math.cos(a), y, z + r * Math.sin(a)); }
  }
  gridIdx(rings, seg, idx);
  return { pos, idx };
}
