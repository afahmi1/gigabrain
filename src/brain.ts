// Brain mesh seam: parse brain.glb from bytes (Obsidian: vault.adapter.readBinary; demo: same-origin fetch), expose meshes by name
// and sample placement targets so note neurons sit INSIDE the cortex volume just beneath the surface.
// Expected asset: Y up, centred, ~2.0 units long, front (frontal pole) at +Z, left hemisphere at -X, meshes named exactly
// cortex_lh, cortex_rh, cerebellum, brainstem (optional spinal_cord) with POSITION, NORMAL and optional custom _CURV in [-1,1] (negative = sulcus).
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fnv, rng, V3, Folder, Placer, Placement, inCerebellum, hemisphereOf } from "./layout";
import { SPECTRUM_GLSL, specUniform } from "./neurons";
import { Field, parseField } from "./field";
import { generateField, capsuleMesh, RawMesh } from "./sdfgen";
import { MeshBVH } from "three-mesh-bvh";
import { buildExterior, acceptField, ExteriorIndex, ExteriorStats, SurfMesh } from "./exterior";
import type { AmbientSource, Part } from "./lightning";

export const MESH_NAMES = ["cortex_lh", "cortex_rh", "cerebellum", "brainstem", "spinal_cord"] as const;
/** Name of the generated internal bridge part (corpus callosum, diencephalon, cerebellar peduncles): rendered as tissue so the inside region equals the drawn brain. */
export const BRIDGE_NAME = "bridge";
interface Surf { mesh: THREE.Mesh; tri: Uint32Array; P: Float32Array; N: Float32Array; C: Float32Array | null; cdf: Float64Array; area: number; }
export interface BrainAsset {
  group: THREE.Group; meshes: Record<string, THREE.Mesh>; names: string[]; triangles: number; bbox: THREE.Box3;
  placer: Placer;
  /** Signed distance field of exactly the drawn volume (cerebrum, cerebellum, brainstem, bridges). Everything that glows must stay `field.margin` below the surface. */
  field: Field;
  /** true only when the shipped field bytes were accepted against the real exterior surface of the loaded meshes; a generated fallback field is never verified (B enables containment only when true). */
  fieldVerified: boolean;
  exteriorStats?: ExteriorStats;
  /** A point inside the tissue (decor neurons): beneath the surface by `depth` units. */
  tissuePoint(r: () => number, depthMin: number, depthMax: number): { pos: V3; normal: V3; region: "cortex" | "cerebellum" };
  /** Ray parity test against all closed meshes. O(triangles): tests and offline checks only. */
  contains(p: V3): boolean;
  /** Area-weighted deterministic surface samples (all meshes): positions, outward normals, per-point random. */
  surfaceSamples(count: number, seed: number): { pos: Float32Array; nrm: Float32Array; rand: Float32Array };
  /** Pull linked notes closer (bounded Jacobi steps), keep spacing, and re-snap every note into the shell of its own hemisphere. Cerebellum notes stay put. */
  relax(places: Placement[], edges: [number, number][], paths: string[]): Placement[];
  /** Area-weighted surface samples per named part (seeds for the decorative ambient lightning, stratified per hemisphere and lobe). */
  ambientSource(): AmbientSource;
  dispose(): void;
}
/** Make a closed mesh outward-consistent regardless of how it was exported: flip winding when the signed volume is negative, and flip
 *  vertex normals when they mostly point toward the centroid. Done in place on the geometry so rendering and sampling agree. Returns what changed. */
export function orientOutward(mesh: THREE.Mesh): { flippedWinding: boolean; flippedNormals: boolean } {
  mesh.updateMatrixWorld(true);
  const g = mesh.geometry as THREE.BufferGeometry, pa = g.getAttribute("position"), v = new THREE.Vector3(), n = pa.count;
  let idx = g.getIndex(); if (!idx) { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = i; g.setIndex(new THREE.BufferAttribute(a, 1)); idx = g.getIndex()!; }
  const P = new Float32Array(n * 3), c = [0, 0, 0]; for (let i = 0; i < n; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrixWorld); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; c[0] += v.x; c[1] += v.y; c[2] += v.z; }
  c[0] /= n; c[1] /= n; c[2] /= n;
  let vol = 0; const nt = idx.count / 3;
  for (let t = 0; t < nt; t++) { const a = idx.getX(t * 3) * 3, b = idx.getX(t * 3 + 1) * 3, d = idx.getX(t * 3 + 2) * 3;
    const ax = P[a] - c[0], ay = P[a + 1] - c[1], az = P[a + 2] - c[2], bx = P[b] - c[0], by = P[b + 1] - c[1], bz = P[b + 2] - c[2], dx = P[d] - c[0], dy = P[d + 1] - c[1], dz = P[d + 2] - c[2];
    vol += (ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx)) / 6; }
  let flippedWinding = false, flippedNormals = false;
  if (vol < 0) { for (let t = 0; t < nt; t++) { const i1 = t * 3 + 1, i2 = t * 3 + 2, x = idx.getX(i1); idx.setX(i1, idx.getX(i2)); idx.setX(i2, x); } idx.needsUpdate = true; flippedWinding = true; }
  const na = g.getAttribute("normal");
  if (!na) g.computeVertexNormals();
  const nn = g.getAttribute("normal"); let dot = 0; for (let i = 0; i < n; i++) dot += nn.getX(i) * (P[i * 3] - c[0]) + nn.getY(i) * (P[i * 3 + 1] - c[1]) + nn.getZ(i) * (P[i * 3 + 2] - c[2]);
  if (dot < 0 && na) { for (let i = 0; i < n; i++) nn.setXYZ(i, -nn.getX(i), -nn.getY(i), -nn.getZ(i)); nn.needsUpdate = true; flippedNormals = true; }
  return { flippedWinding, flippedNormals };
}
function surfaceOf(mesh: THREE.Mesh): Surf {
  mesh.updateMatrixWorld(true);
  const g = mesh.geometry as THREE.BufferGeometry, pa = g.getAttribute("position"), na = g.getAttribute("normal"), ca = g.getAttribute("_curv") ?? g.getAttribute("aCurv");
  const n = pa.count, P = new Float32Array(n * 3), N = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrixWorld); P.set([v.x, v.y, v.z], i * 3); }
  if (na) { const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld); for (let i = 0; i < n; i++) { v.fromBufferAttribute(na, i).applyMatrix3(nm).normalize(); N.set([v.x, v.y, v.z], i * 3); } }
  const idx = g.getIndex(), nt = idx ? idx.count / 3 : n / 3, tri = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) tri[i] = idx ? idx.getX(i) : i;
  const C = ca ? Float32Array.from({ length: n }, (_, i) => ca.getX(i)) : null;
  const cdf = new Float64Array(nt); let acc = 0;
  for (let t = 0; t < nt; t++) {
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    acc += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx); cdf[t] = acc;
  }
  return { mesh, tri, P, N, C, cdf, area: acc };
}
function sampleTri(s: Surf, r: () => number) {
  const x = r() * s.area; let lo = 0, hi = s.cdf.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (s.cdf[m] < x) lo = m + 1; else hi = m; }
  const a = s.tri[lo * 3], b = s.tri[lo * 3 + 1], c = s.tri[lo * 3 + 2], u = Math.sqrt(r()), v = r(), w0 = 1 - u, w1 = u * (1 - v), w2 = u * v;
  const pos: V3 = [0, 0, 0], nrm: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) { pos[k] = s.P[a * 3 + k] * w0 + s.P[b * 3 + k] * w1 + s.P[c * 3 + k] * w2; nrm[k] = s.N[a * 3 + k] * w0 + s.N[b * 3 + k] * w1 + s.N[c * 3 + k] * w2; }
  const l = Math.hypot(...nrm) || 1; nrm[0] /= l; nrm[1] /= l; nrm[2] /= l;
  const curv = s.C ? s.C[a] * w0 + s.C[b] * w1 + s.C[c] * w2 : 0;
  return { pos, nrm, curv };
}
const inBand = (f: Folder, zn: number, yn: number) => (f === "topics" ? zn >= 0.45 : f === "projects" ? zn >= 0.15 && zn <= 0.8 && yn >= 0.4 : zn <= 0.5);

export const BRAIN_VS = `attribute float aCurv; varying vec3 vN; varying vec3 vV; varying vec3 vW; varying float vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; vW = (modelMatrix * vec4(position, 1.0)).xyz; vC = aCurv; gl_Position = projectionMatrix * mv; }`;
// Dark tissue organ: lit by key + fill, cavity-darkened by sulcal depth (_CURV), micro surface noise, cool fresnel rim, partly translucent.
export const BRAIN_FS = `uniform vec3 uBase; uniform vec3 uRim; uniform float uAlpha; uniform float uCavity; uniform float uMicro; uniform float uTint; uniform float uFade; uniform float uRevealY; uniform vec3 uSpec[7];
varying vec3 vN; varying vec3 vV; varying vec3 vW; varying float vC;
${SPECTRUM_GLSL}
float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z); }
void main(){
  vec3 N = normalize(vN), V = normalize(vV);
  float grain = 0.5;
  if (uMicro > 0.5) {
    vec3 p = vW * 85.0; float n0 = vnoise(p); grain = n0;
    vec3 g = vec3(vnoise(p + vec3(0.6,0,0)) - n0, vnoise(p + vec3(0,0.6,0)) - n0, vnoise(p + vec3(0,0,0.6)) - n0);
    N = normalize(N + 0.5 * (mat3(viewMatrix) * g));
  }
  vec3 L1 = normalize(vec3(-0.45, 0.75, 0.55)), L2 = normalize(vec3(0.65, -0.25, 0.45));
  float diff = 0.05 + 1.2 * max(dot(N, L1), 0.0) + 0.28 * max(dot(N, L2), 0.0);
  float crown = smoothstep(-0.75, 0.45, vC);
  float cav = mix(1.0 - uCavity, 1.0, crown);                     // sulcal fundi noticeably darker
  float ndv = clamp(dot(N, V), 0.0, 1.0), rim = pow(1.0 - ndv, 4.0);
  vec3 base = mix(uBase, spectrum((1.2 - vW.z) / 2.4) * 0.55, uTint) * (0.88 + 0.24 * grain);
  vec3 col = base * diff * cav;
  col += vec3(0.6, 0.72, 0.95) * pow(max(dot(N, normalize(L1 + V)), 0.0), 34.0) * 0.32 * cav; // wet sheen on gyral crowns
  col += uRim * rim * 0.8;
  float a = mix(0.88, 1.0, rim) * mix(1.0, 1.25, 1.0 - cav) * uAlpha;
  a *= uFade * smoothstep(uRevealY, uRevealY - 0.14, vW.y);   // intro grow-in: fade per part, cortex revealed bottom to top
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, min(a, 1.0));
}`;

export async function parseBrainGLB(bytes: ArrayBuffer, fieldBytes?: ArrayBuffer | null): Promise<BrainAsset> {
  const gltf = await new Promise<any>((res, rej) => new GLTFLoader().parse(bytes, "", res, rej));
  const group = new THREE.Group(); group.add(gltf.scene);
  const meshes: Record<string, THREE.Mesh> = {};
  group.traverse((o: any) => { if (o.isMesh && (MESH_NAMES as readonly string[]).includes(o.name)) meshes[o.name] = o; });
  if (!meshes.cortex_lh && !meshes.cortex_rh) throw new Error("brain asset has no cortex_lh/cortex_rh meshes");
  group.updateMatrixWorld(true);
  let triangles = 0; const bbox = new THREE.Box3(); const surf: Record<string, Surf> = {};
  for (const [name, m] of Object.entries(meshes)) {
    const g = m.geometry as THREE.BufferGeometry;
    const cv = g.getAttribute("_curv"); if (cv && !g.getAttribute("aCurv")) g.setAttribute("aCurv", cv);
    if (!g.getAttribute("aCurv")) g.setAttribute("aCurv", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count), 1));
    orientOutward(m as THREE.Mesh);
    triangles += g.getIndex() ? g.getIndex()!.count / 3 : g.getAttribute("position").count / 3;
    bbox.union(new THREE.Box3().setFromObject(m)); surf[name] = surfaceOf(m);
  }
  // signed distance field: the shipped one when it matches these meshes, else generated from the loaded meshes (synthetic or low-poly assets)
  const rawOf = (m: THREE.Mesh): RawMesh => { const g = m.geometry as THREE.BufferGeometry, S = surfOf(m); void g; return { pos: S.P, idx: S.tri }; };
  const surfOf = (m: THREE.Mesh) => { const k = Object.keys(meshes).find((n) => meshes[n] === m)!; return surf[k]; };
  let field: Field | null = null;
  let verified = false, ext: ExteriorIndex | null = null;
  const partsOf = (): SurfMesh[] => Object.entries(meshes).filter(([n]) => n !== "spinal_cord" && n !== BRIDGE_NAME).map(([n, m]) => ({ name: n, pos: surfOf(m).P, idx: surfOf(m).tri, solid: true }));
  if (fieldBytes) { try { const f = parseField(fieldBytes), e = buildExterior(partsOf(), f.bridges, (x, y, z) => f.depth(x, y, z) >= 1.5 * f.h); if (acceptField(f, e)) { field = f; ext = e; verified = true; } } catch { field = null; } }
  if (!field) { const raws: Record<string, RawMesh> = {}; for (const [n, m] of Object.entries(meshes)) if (n !== "spinal_cord") raws[n] = rawOf(m); field = generateField(raws).field; const g = field; ext = buildExterior(partsOf(), g.bridges, (x, y, z) => g.depth(x, y, z) >= 1.5 * g.h); acceptField(g, ext); }
  // bridge part: one merged capsule mesh, drawn with the same tissue material (hidden inside the cortex by the depth pre-pass, visible only in gaps)
  const bvhSurfaces: RawMesh[] = [];
  if (field.bridges.length) {
    const pos: number[] = [], idx: number[] = []; for (const b of field.bridges) { const c = capsuleMesh(b.a, b.b, b.r), o = pos.length / 3; for (let q = 0; q < c.pos.length; q++) pos.push(c.pos[q]); for (let q = 0; q < c.idx.length; q++) idx.push(c.idx[q] + o); }
    const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3)); bg.setIndex(idx); bg.computeVertexNormals();
    const bm = new THREE.Mesh(bg, new THREE.MeshBasicMaterial()); bm.name = BRIDGE_NAME; group.add(bm); meshes[BRIDGE_NAME] = bm; group.updateMatrixWorld(true);
    bg.setAttribute("aCurv", new THREE.BufferAttribute(new Float32Array(pos.length / 3).fill(0.2), 1)); orientOutward(bm); triangles += idx.length / 3; bbox.union(new THREE.Box3().setFromObject(bm));
    bvhSurfaces.push({ pos, idx });
  }
  field.exact = { dist: (x: number, y: number, z: number) => (field!.depth(x, y, z) >= 0 ? 1 : -1) * ext!.dist(x, y, z) }; // distance to the EXTERIOR boundary of the rendered union (hidden/buried surfaces are not boundary)
  field.buildR6(); // one certified routable interior (exact depth), computed once per asset; soma projection and A* share it
  void bvhSurfaces;
  const cortexBox = new THREE.Box3(); for (const k of ["cortex_lh", "cortex_rh"]) if (meshes[k]) cortexBox.union(new THREE.Box3().setFromObject(meshes[k]));
  const zr = Math.max(1e-6, cortexBox.max.z - cortexBox.min.z), yr = Math.max(1e-6, cortexBox.max.y - cortexBox.min.y);
  const hemi = (side: number) => surf[side < 0 ? "cortex_lh" : "cortex_rh"] ?? surf.cortex_lh ?? surf.cortex_rh;
  const placer: Placer = (path, folder): Placement => {
    const r = rng(fnv("g:" + path)), cb = inCerebellum(path, folder) && surf.cerebellum;
    const s = cb ? surf.cerebellum : hemi(hemisphereOf(path)), side = hemisphereOf(path);
    let best: ReturnType<typeof sampleTri> | null = null;
    for (let tries = 0; tries < 64; tries++) {
      const c = sampleTri(s, r); best = c;
      if (cb) { if (c.curv >= -0.3 || tries > 30) break; continue; }
      const zn = (c.pos[2] - cortexBox.min.z) / zr, yn = (c.pos[1] - cortexBox.min.y) / yr;
      if (c.nrm[0] * side < -0.35 || (s.C && c.curv < -0.25 && tries < 56) || !inBand(folder, zn, yn)) continue;
      break;
    }
    const c = best!, depth = cb ? 0.012 + 0.016 * r() : 0.02 + 0.04 * r();
    return { pos: [c.pos[0] - c.nrm[0] * depth, c.pos[1] - c.nrm[1] * depth, c.pos[2] - c.nrm[2] * depth], normal: c.nrm, depth, region: cb ? "cerebellum" : "cortex" };
  };
  const tissuePoint: BrainAsset["tissuePoint"] = (r, dmin, dmax) => {
    const cb = !!surf.cerebellum && r() > 0.84, s = cb ? surf.cerebellum : hemi(r() < 0.5 ? -1 : 1);
    let c = sampleTri(s, r); for (let k = 0; k < 8 && s.C && c.curv < -0.2; k++) c = sampleTri(s, r); // prefer gyral crowns: narrow sulci would put a deep point outside the tissue
    const d = Math.min(dmin + (dmax - dmin) * r(), cb ? 0.04 : dmax);
    return { pos: [c.pos[0] - c.nrm[0] * d, c.pos[1] - c.nrm[1] * d, c.pos[2] - c.nrm[2] * d], normal: c.nrm, region: cb ? "cerebellum" : "cortex" };
  };
  const contains = (p: V3) => {
    const d: V3 = [0.0123, 0.9992, 0.0317]; let hits = 0;
    for (const k of ["cortex_lh", "cortex_rh", "cerebellum", "brainstem"]) { const s = surf[k]; if (!s) continue; let h = 0;
      for (let t = 0; t < s.tri.length / 3; t++) {
        const a = s.tri[t * 3] * 3, b = s.tri[t * 3 + 1] * 3, c = s.tri[t * 3 + 2] * 3;
        const e1: V3 = [s.P[b] - s.P[a], s.P[b + 1] - s.P[a + 1], s.P[b + 2] - s.P[a + 2]], e2: V3 = [s.P[c] - s.P[a], s.P[c + 1] - s.P[a + 1], s.P[c + 2] - s.P[a + 2]];
        const pv: V3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
        if (Math.abs(det) < 1e-12) continue;
        const tv: V3 = [p[0] - s.P[a], p[1] - s.P[a + 1], p[2] - s.P[a + 2]], u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det; if (u < 0 || u > 1) continue;
        const qv: V3 = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]], v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det; if (v < 0 || u + v > 1) continue;
        if ((e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det > 0) h++;
      }
      hits += h; }
    return hits % 2 === 1;
  };
  const surfaceSamples: BrainAsset["surfaceSamples"] = (count, seed) => {
    const list = Object.values(surf), tot = list.reduce((a, b) => a + b.area, 0), r = rng(seed >>> 0), pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), rand = new Float32Array(count);
    for (let i = 0; i < count; i++) { let x = r() * tot, s = list[0]; for (const c of list) { if (x < c.area) { s = c; break; } x -= c.area; } const c = sampleTri(s, r); for (let k = 0; k < 3; k++) { pos[i * 3 + k] = c.pos[k] + c.nrm[k] * 0.003; nrm[i * 3 + k] = c.nrm[k]; } rand[i] = r(); }
    return { pos, nrm, rand };
  };
  // nearest-vertex lookup (uniform grid) used to keep relaxed notes on the cortex shell
  const grids = new Map<Surf, Map<number, number[]>>(); const CELL = 0.05, key = (x: number, y: number, z: number) => ((x + 64) * 256 + (y + 64)) * 256 + (z + 64);
  const gridOf = (sf: Surf) => { let g = grids.get(sf); if (g) return g; g = new Map(); for (let v = 0; v < sf.P.length / 3; v++) { const k = key(Math.floor(sf.P[v * 3] / CELL), Math.floor(sf.P[v * 3 + 1] / CELL), Math.floor(sf.P[v * 3 + 2] / CELL)); const a = g.get(k); if (a) a.push(v); else g.set(k, [v]); } grids.set(sf, g); return g; };
  const nearest = (sf: Surf, p: V3): number => {
    const g = gridOf(sf), cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), cz = Math.floor(p[2] / CELL); let best = -1, bd = Infinity;
    for (let R = 1; R <= 6 && best < 0; R++) for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) { const a = g.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue; for (const v of a) { const d = (sf.P[v * 3] - p[0]) ** 2 + (sf.P[v * 3 + 1] - p[1]) ** 2 + (sf.P[v * 3 + 2] - p[2]) ** 2; if (d < bd) { bd = d; best = v; } } }
    return best;
  };
  const relax: BrainAsset["relax"] = (places, edges, paths) => {
    const n = places.length, nb: number[][] = places.map(() => []); for (const [a, b] of edges) { nb[a].push(b); nb[b].push(a); }
    const orig = places.map((p) => p.pos), side = paths.map((p) => hemisphereOf(p)); let cur = places.map((p) => p.pos);
    for (let it = 0; it < 2; it++) {
      const next = cur.map((p, i): V3 => {
        if (places[i].region === "cerebellum") return p;
        let t: V3 = [p[0], p[1], p[2]];
        if (nb[i].length) { const c: V3 = [0, 0, 0]; for (const j of nb[i]) { c[0] += cur[j][0]; c[1] += cur[j][1]; c[2] += cur[j][2]; } const k = 0.1 / nb[i].length; for (let a = 0; a < 3; a++) t[a] += (c[a] - nb[i].length * p[a]) * k; }
        if (n <= 2500) for (let j = 0; j < n; j++) if (j !== i) { const d = Math.hypot(p[0] - cur[j][0], p[1] - cur[j][1], p[2] - cur[j][2]); if (d < 0.07 && d > 1e-6) for (let a = 0; a < 3; a++) t[a] += ((p[a] - cur[j][a]) / d) * (0.07 - d) * 0.25; }
        const dd = Math.hypot(t[0] - orig[i][0], t[1] - orig[i][1], t[2] - orig[i][2]); if (dd > 0.16) for (let a = 0; a < 3; a++) t[a] = orig[i][a] + ((t[a] - orig[i][a]) * 0.16) / dd;
        return t;
      });
      cur = next.map((t, i) => { if (places[i].region === "cerebellum") return t; const sf = hemi(side[i]), v = nearest(sf, t); return v < 0 ? t : [sf.P[v * 3] - sf.N[v * 3] * places[i].depth, sf.P[v * 3 + 1] - sf.N[v * 3 + 1] * places[i].depth, sf.P[v * 3 + 2] - sf.N[v * 3 + 2] * places[i].depth]; });
    }
    return places.map((p, i) => { if (p.region === "cerebellum") return p; const sf = hemi(side[i]), v = nearest(sf, cur[i]); return v < 0 ? p : { ...p, pos: cur[i], normal: [sf.N[v * 3], sf.N[v * 3 + 1], sf.N[v * 3 + 2]] as V3 }; });
  };
  const ambientSource = (): AmbientSource => ({
    sample: (part: Part, r: () => number) => { const s = surf[part]; if (!s) return null; const c = sampleTri(s, r); return { pos: c.pos, nrm: c.nrm, curv: c.curv }; },
    area: (part: Part) => surf[part]?.area ?? 0,
    cortexBox: { min: [cortexBox.min.x, cortexBox.min.y, cortexBox.min.z], max: [cortexBox.max.x, cortexBox.max.y, cortexBox.max.z] },
  });
  const dispose = () => group.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  return { group, meshes, names: Object.keys(meshes), triangles: Math.round(triangles), bbox, placer, field, fieldVerified: verified, exteriorStats: ext!.stats, tissuePoint, contains, surfaceSamples, relax, ambientSource, dispose };
}
/** Visible shell material (translucent, depth-tested against its own depth pre-pass) + the invisible depth pre-pass material. */
export function brainMaterials(base: V3, rim: V3, micro: boolean, smooth = false) {
  const uniforms = { uBase: { value: new THREE.Color(...base) }, uRim: { value: new THREE.Color(...rim) }, uAlpha: { value: 1 }, uCavity: { value: smooth ? 0.12 : 0.93 }, uMicro: { value: micro && !smooth ? 1 : 0 }, uTint: { value: 0.22 }, uFade: { value: 1 }, uRevealY: { value: 99 }, uSpec: specUniform() };
  const shell = new THREE.ShaderMaterial({ vertexShader: BRAIN_VS, fragmentShader: BRAIN_FS, uniforms, transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, side: THREE.FrontSide });
  // The bloom blend tests the stencil stamped by this existing depth draw. No separate silhouette render.
  const pre = new THREE.ShaderMaterial({ vertexShader: BRAIN_VS, fragmentShader: "void main(){ gl_FragColor = vec4(0.0); }", colorWrite: false, depthWrite: true, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2, stencilWrite: true, stencilRef: 1, stencilZPass: THREE.ReplaceStencilOp });
  return { uniforms, shell, pre };
}
