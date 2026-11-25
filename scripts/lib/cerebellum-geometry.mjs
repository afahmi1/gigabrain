// Original procedural cerebellum (illustrative, not a scan): a closed loft across X with two hemispheres,
// a midline vermis and transverse folia. Shared by build-brain.mjs and build-cerebellum.mjs.
const PI = Math.PI, TAU = 2 * PI, sq = (x) => x * x;
// Loft a single surface across X. Each cross-section sweeps from superior to posterior (-Z),
// inferior (-Y) and around to the anterior. The profile has two broad hemispheric wings and
// a narrow, folded midline vermis in the shallower groove between them. No planar end caps.
export function section(u, a) {
  const s = Math.sin(u), span = Math.cos(u);
  const mid = Math.exp(-sq(s / 0.29)), vermis = Math.exp(-sq(s / 0.105));
  const y0 = -0.591 + 0.023 * s * s + 0.013 * vermis + 0.003 * s;
  const z0 = -0.596 + 0.030 * mid - 0.015 * vermis + 0.005 * s;
  const ry = 0.165 - 0.050 * mid + 0.024 * vermis;
  const back = 0.342 - 0.101 * mid + 0.036 * vermis;
  const front = 0.309 - 0.101 * mid + 0.024 * vermis;
  const sin = Math.sin(a), cos = Math.cos(a);
  const rz = back * (0.5 + 0.5 * sin) + front * (0.5 - 0.5 * sin);
  // Transverse folia wrap continuously around the inferior surface. They sweep toward the tips
  // and turn sharply onto the vermis, rather than drawing parallel lines across a flat patch.
  const phase = 13 * a + 5.5 * s * s + (1.2 + 1.3 * Math.cos(a - 0.5)) * mid - 0.75 * vermis
    + 0.31 * Math.sin(2 * a + 3 * s) + 0.23 * Math.sin(a - 8 * s);
  const groove = (0.5 + 0.5 * Math.cos(phase)) ** 3.2 * span * span;
  const r = span * (1 - (0.073 + 0.023 * Math.cos(3 * a + 1.4 * s * s)) * groove);
  return [0.486 * s, y0 + r * (ry * cos - 0.021 * sin), z0 - r * rz * sin, 0.53 - 1.49 * groove];
}

export function cerebellumMesh(strips, around) {
  const pos = [], normal = [], curv = [], indices = [];
  const vertex = (u, a, pole = 0) => {
    const [x, y, z, c] = section(u, a);
    pos.push(x, y, z); curv.push(c);
    if (pole) { normal.push(pole, 0, 0); return; }
    // Same underlying normal field at both resolutions. ∂u × ∂a points outward.
    const eps = 1e-4, ul = section(u - eps, a), ur = section(u + eps, a), al = section(u, a - eps), ar = section(u, a + eps);
    const [ux, uy, uz] = ur.map((v, i) => v - ul[i]), [ax, ay, az] = ar.map((v, i) => v - al[i]);
    const n = [uy * az - uz * ay, uz * ax - ux * az, ux * ay - uy * ax], length = Math.hypot(...n);
    normal.push(...n.map((v) => v / length));
  };
  vertex(-PI / 2, 0, -1);
  for (let i = 1; i < strips; i++) for (let j = 0; j < around; j++) vertex(PI * (i / strips - 0.5), TAU * j / around);
  const right = pos.length / 3;
  vertex(PI / 2, 0, 1);
  for (let j = 0; j < around; j++) {
    const k = (j + 1) % around;
    indices.push(0, 1 + j, 1 + k);
    for (let i = 0; i < strips - 2; i++) {
      const o = 1 + i * around, r = o + around;
      indices.push(o + j, r + j, r + k, o + j, r + k, o + k);
    }
    indices.push(right - around + j, right, right - around + k);
  }
  return { pos: Float32Array.from(pos), normal: Float32Array.from(normal), curv: Float32Array.from(curv), indices: Uint32Array.from(indices) };
}

