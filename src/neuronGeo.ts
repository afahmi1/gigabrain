// Build one merged GPU geometry from many morphologies (tubes or lines). No per-frame rebuild: pulses are shader-driven from the
// per-vertex arc length `aS` and per-neuron event texture.
// Tube mode: every segment is a straight tube with a parent-aligned frame (no twist). Myelin = a thin axon core plus a short thicker straight
// sleeve with gaps (nodes of Ranvier). Boutons = a thin twig ending in a small low-poly icosphere.
import { Morph, KIND_BOUTON, KIND_MYELIN, KIND_AXON, GROUPS } from "./morph";
import { V3 } from "./layout";

export interface NeuronGeo {
  pos: Float32Array; nrm: Float32Array | null; neuron: Float32Array; s: Float32Array; info: Float32Array; index: Uint32Array | null;
  vertices: number; segments: number; boutons: number; sleeves: number;
}
export interface GeoOpts {
  tube: boolean; radial: number; radiusMul: number;
  offsets?: V3[];            // world offsets per morph (decor neurons live in world space)
  rand?: number[];           // per-neuron random 0..1 (info.w)
  startIndex?: number;       // value written into aNeuron for morph 0
}
// icosahedron (detail 0): 12 vertices, 20 faces
const T = (1 + Math.sqrt(5)) / 2, IL = Math.hypot(1, T);
const ICO_V: V3[] = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]].map((v) => [v[0] / IL, v[1] / IL, v[2] / IL] as V3);
const ICO_F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];

/** info = (segment kind, dendrite group, max arc length of that group / axon, per-neuron random) */
export function buildNeuronGeo(morphs: Morph[], o: GeoOpts): NeuronGeo {
  let segs = 0, bout = 0, sleeves = 0;
  for (const m of morphs) { segs += m.segments; for (let i = 1; i < m.n; i++) { if (m.kind[i] === KIND_BOUTON) bout++; else if (m.kind[i] === KIND_MYELIN) sleeves++; } }
  const R = o.tube ? Math.max(3, o.radial) : 0;
  const nTube = segs + sleeves, V = o.tube ? nTube * 2 * R + bout * 12 : segs * 2, I = o.tube ? nTube * R * 6 + bout * 60 : 0;
  const pos = new Float32Array(V * 3), nrm = o.tube ? new Float32Array(V * 3) : null, neuron = new Float32Array(V), s = new Float32Array(V), info = new Float32Array(V * 4);
  const index = o.tube ? new Uint32Array(I) : null;
  let v = 0, ii = 0;
  morphs.forEach((m, mi) => {
    const off = o.offsets?.[mi] ?? [0, 0, 0], nid = (o.startIndex ?? 0) + mi, rnd = o.rand?.[mi] ?? 0;
    const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, arc: number, k: number, g: number, gm: number) => {
      const vi = v * 3; pos[vi] = x + off[0]; pos[vi + 1] = y + off[1]; pos[vi + 2] = z + off[2]; if (nrm) { nrm[vi] = nx; nrm[vi + 1] = ny; nrm[vi + 2] = nz; }
      neuron[v] = nid; s[v] = arc; info[v * 4] = k; info[v * 4 + 1] = g; info[v * 4 + 2] = gm; info[v * 4 + 3] = rnd; return v++;
    };
    /** straight tube from a to b (world-free coordinates relative to soma), radius ra at a and rb at b */
    const tube = (a: V3, b: V3, ra: number, rb: number, sa: number, sb: number, k: number, g: number, gm: number) => {
      const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2], l = Math.hypot(ax, ay, az) || 1, dx = ax / l, dy = ay / l, dz = az / l;
      const ref: V3 = Math.abs(dy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let ux = ref[1] * dz - ref[2] * dy, uy = ref[2] * dx - ref[0] * dz, uz = ref[0] * dy - ref[1] * dx; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux, base = v;
      for (const end of [0, 1]) for (let q = 0; q < R; q++) {
        const ang = (q / R) * Math.PI * 2, c = Math.cos(ang), sn = Math.sin(ang), nx = ux * c + wx * sn, ny = uy * c + wy * sn, nz = uz * c + wz * sn, p = end ? b : a, r = end ? rb : ra;
        vert(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r, nx, ny, nz, end ? sb : sa, k, g, gm);
      }
      for (let q = 0; q < R; q++) { const q1 = (q + 1) % R, a0 = base + q, a1 = base + q1, b0 = base + R + q, b1 = base + R + q1; index![ii++] = a0; index![ii++] = a1; index![ii++] = b0; index![ii++] = a1; index![ii++] = b1; index![ii++] = b0; }
    };
    const ball = (c: V3, r: number, arc: number, k: number, g: number, gm: number) => {
      const base = v; for (const q of ICO_V) vert(c[0] + q[0] * r, c[1] + q[1] * r, c[2] + q[2] * r, q[0], q[1], q[2], arc, k, g, gm);
      for (let f = 0; f < ICO_F.length; f++) index![ii++] = base + ICO_F[f];
    };
    for (let i = 1; i < m.n; i++) {
      const p = m.parent[i], k = m.kind[i], g = m.group[i], gm = k === 0 ? m.gmax[g] : m.gmax[GROUPS];
      const A: V3 = [m.pos[p * 3], m.pos[p * 3 + 1], m.pos[p * 3 + 2]], B: V3 = [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
      if (!o.tube) { vert(A[0], A[1], A[2], 0, 0, 0, m.s[p], k, g, gm); vert(B[0], B[1], B[2], 0, 0, 0, m.s[i], k, g, gm); continue; }
      const rc = Math.max(1e-5, m.rad[i] * o.radiusMul), rpar = m.kind[p] === KIND_MYELIN ? rc : m.rad[p] > 0 ? m.rad[p] * o.radiusMul : rc * 1.6;
      if (k === KIND_BOUTON) { const rt = Math.max(1e-5, Math.min(rpar, rc * 0.45)); tube(A, B, rt, rt, m.s[p], m.s[i], KIND_AXON, g, gm); ball(B, rc * 0.62, m.s[i], KIND_BOUTON, g, gm); }
      else if (k === KIND_MYELIN) {
        const ra = rc / 2.3, a: V3 = [A[0] + (B[0] - A[0]) * 0.1, A[1] + (B[1] - A[1]) * 0.1, A[2] + (B[2] - A[2]) * 0.1], b: V3 = [A[0] + (B[0] - A[0]) * 0.9, A[1] + (B[1] - A[1]) * 0.9, A[2] + (B[2] - A[2]) * 0.9];
        tube(A, B, ra, ra, m.s[p], m.s[i], KIND_AXON, g, gm);                                          // thin axon core runs the full length
        tube(a, b, rc * 0.9, rc * 0.9, m.s[p] + (m.s[i] - m.s[p]) * 0.1, m.s[p] + (m.s[i] - m.s[p]) * 0.9, KIND_MYELIN, g, gm); // straight sleeve with node gaps
      } else tube(A, B, Math.max(1e-5, rpar), rc, m.s[p], m.s[i], k, g, gm);
    }
  });
  void KIND_AXON;
  return { pos, nrm, neuron, s, info, index, vertices: v, segments: segs, boutons: bout, sleeves };
}
