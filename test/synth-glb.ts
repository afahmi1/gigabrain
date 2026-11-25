// SYNTHETIC brain-like GLB for tests (wrinkled ellipsoids named like the real asset). Not anatomy; used only to exercise the loader seam.
const PARTS = [
  { name: "cortex_lh", c: [-0.38, 0.1, 0.0], r: [0.36, 0.46, 0.95] }, { name: "cortex_rh", c: [0.38, 0.1, 0.0], r: [0.36, 0.46, 0.95] },
  { name: "cerebellum", c: [0, -0.42, -0.8], r: [0.4, 0.18, 0.28] }, { name: "brainstem", c: [0, -0.6, -0.25], r: [0.09, 0.3, 0.09] },
];
export const SYNTH_RADII = PARTS;
function part(p: (typeof PARTS)[0], lat: number, lon: number) {
  const nv = (lat + 1) * lon, pos = new Float32Array(nv * 3), curv = new Float32Array(nv), idx = new Uint32Array(lat * lon * 6);
  for (let i = 0; i <= lat; i++) for (let j = 0; j < lon; j++) {
    const th = (i / lat) * Math.PI, ph = (j / lon) * 2 * Math.PI, d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    const w = Math.sin(13 * d[0] + 5 * d[1]) * Math.cos(11 * d[2] - 3 * d[0]) * 0.6 + Math.sin(23 * d[1] + 17 * d[2]) * 0.4, k = 1 + 0.045 * w, v = i * lon + j;
    pos.set([p.c[0] + p.r[0] * d[0] * k, p.c[1] + p.r[1] * d[1] * k, p.c[2] + p.r[2] * d[2] * k], v * 3); curv[v] = Math.max(-1, Math.min(1, w));
  }
  let t = 0;
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) { const a = i * lon + j, b = i * lon + (j + 1) % lon, c = (i + 1) * lon + j, d = (i + 1) * lon + (j + 1) % lon; idx.set([a, c, b, b, c, d], t); t += 6; }
  const nrm = new Float32Array(nv * 3);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3, u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], w = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const q of [a, b, c]) { nrm[q] += n[0]; nrm[q + 1] += n[1]; nrm[q + 2] += n[2]; }
  }
  for (let v = 0; v < nv; v++) { const l = Math.hypot(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]) || 1; nrm[v * 3] /= l; nrm[v * 3 + 1] /= l; nrm[v * 3 + 2] /= l; }
  // make normals point outward (flip if the winding produced inward ones)
  let dot = 0; for (let v = 0; v < nv; v++) dot += nrm[v * 3] * (pos[v * 3] - p.c[0]) + nrm[v * 3 + 1] * (pos[v * 3 + 1] - p.c[1]) + nrm[v * 3 + 2] * (pos[v * 3 + 2] - p.c[2]);
  if (dot < 0) { for (let v = 0; v < nv * 3; v++) nrm[v] = -nrm[v]; for (let f = 0; f < idx.length; f += 3) { const x = idx[f + 1]; idx[f + 1] = idx[f + 2]; idx[f + 2] = x; } }
  return { pos, nrm, curv, idx, nv };
}
export function makeSynthGlb(lat = 44, lon = 60): Uint8Array {
  const chunks: Uint8Array[] = [], views: any[] = [], acc: any[] = [], meshes: any[] = [], nodes: any[] = []; let off = 0;
  const addView = (arr: ArrayBufferView, target: number) => { const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); const pad = (4 - (bytes.length % 4)) % 4; const c = new Uint8Array(bytes.length + pad); c.set(bytes); chunks.push(c); views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, target }); off += c.length; return views.length - 1; };
  PARTS.forEach((p, mi) => {
    const g = part(p, lat, lon); let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let v = 0; v < g.nv; v++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], g.pos[v * 3 + k]); mx[k] = Math.max(mx[k], g.pos[v * 3 + k]); }
    const a0 = acc.length; acc.push({ bufferView: addView(g.pos, 34962), componentType: 5126, count: g.nv, type: "VEC3", min: mn, max: mx });
    acc.push({ bufferView: addView(g.nrm, 34962), componentType: 5126, count: g.nv, type: "VEC3" });
    acc.push({ bufferView: addView(g.curv, 34962), componentType: 5126, count: g.nv, type: "SCALAR" });
    acc.push({ bufferView: addView(g.idx, 34963), componentType: 5125, count: g.idx.length, type: "SCALAR" });
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: a0, NORMAL: a0 + 1, _CURV: a0 + 2 }, indices: a0 + 3, mode: 4 }] }); nodes.push({ name: p.name, mesh: mi });
  });
  const json = JSON.stringify({ asset: { version: "2.0", generator: "palace-atlas synthetic test fixture" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors: acc, bufferViews: views, buffers: [{ byteLength: off }] });
  const jb = new TextEncoder().encode(json), jpad = (4 - (jb.length % 4)) % 4, jchunk = new Uint8Array(jb.length + jpad).fill(0x20); jchunk.set(jb);
  const total = 12 + 8 + jchunk.length + 8 + off, out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jchunk.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jchunk, 20);
  let p = 20 + jchunk.length; dv.setUint32(p, off, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
