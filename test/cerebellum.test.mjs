// Exercise the actual shipped GLBs, without a camera, material workaround or generated SDF.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FrontSide, Ray, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshBVH } from "three-mesh-bvh";

function checkTopology(g) {
  const p = g.getAttribute("position"), { array: indices } = g.getIndex();
  const edges = new Map(), parent = Array.from({ length: p.count }, (_, i) => i);
  const root = (i) => { while (i !== parent[i]) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const a = new Vector3(), b = a.clone(), c = a.clone();
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const v = indices.subarray(i, i + 3);
    assert(v.every((k) => k < p.count) && new Set(v).size === 3, "valid indexed faces");
    assert(b.fromBufferAttribute(p, v[1]).sub(a.fromBufferAttribute(p, v[0])).cross(c.fromBufferAttribute(p, v[2]).sub(a)).lengthSq() > 0, "nondegenerate triangle");
    volume += a.dot(b) / 6;
    for (let j = 0; j < 3; j++) {
      const from = v[j], to = v[(j + 1) % 3];
      const key = Math.min(from, to) * p.count + Math.max(from, to);
      const info = edges.get(key) ?? { count: 0, winding: 0 };
      info.count++; info.winding += from < to ? 1 : -1; edges.set(key, info);
      parent[root(from)] = root(to);
    }
  }
  const bad = [...edges.values()].filter((e) => e.count !== 2 || e.winding !== 0).length;
  assert.equal(bad, 0, "no open boundary, non-manifold edge, or reversed seam");
  assert.equal(new Set(parent.map((_, i) => root(i))).size, 1, "continuous tissue between hemispheres and vermis");
  assert.equal(p.count - edges.size + indices.length / 3, 2, "one closed shell, no handles");
  assert(volume > 0.066, "outward winding and genuine rounded volume, not a cap over the former cut");
  return { triangles: indices.length / 3, volume: +volume.toFixed(5) };
}

function checkShape(g) {
  const bvh = new MeshBVH(g), dirZ = new Vector3(0, 0, 1), dirY = new Vector3(0, 1, 0);
  const hit = (origin, direction) => {
    const r = bvh.raycastFirst(new Ray(origin, direction), FrontSide);
    assert(r, `front-facing surface at ${origin.toArray()} along ${direction.toArray()}`);
    return r.point;
  };
  const z = (x, y) => hit(new Vector3(x, y, -2), dirZ).z;
  const y = (x, z) => hit(new Vector3(x, -2, z), dirY).y;
  const x = [-0.21, 0.001, 0.21], posterior = x.map((k) => z(k, -0.60));
  const [left, vermis, right] = posterior;
  assert(left < -0.85 && right < -0.85, "both hemispheres extend past the former posterior cut (~-0.719)");
  assert(vermis > Math.max(left, right) + 0.018 && vermis < Math.min(z(-0.085, -0.60), z(0.085, -0.60)) - 0.004,
    "distinct midline vermis protrudes between the shallower grooves without masking the paired lobes");
  for (const k of [x[0], x[2]]) {
    assert(z(k, -0.69) - z(k, -0.60) > 0.055, "posterior face turns under; not a planar fill");
    const floor = y(k, -0.60);
    assert(floor < -0.71 && y(k, -0.83) > floor + 0.028 && y(k, -0.38) > floor + 0.06, "inferior surface rounds up at back and front");
  }

  // Measure real relief on cross-sections, independent of the stylised _CURV colour attribute.
  // A smooth ellipsoid or a hemisphere with painted-on lines cannot produce these recurring local grooves.
  const grooves = x.map((k) => {
    const n = 240, ctr = new Vector3(k, -0.59, -0.59);
    const r = Array.from({ length: n }, (_, i) => {
      const a = i / n * 2 * Math.PI, d = new Vector3(0, 0.15 * Math.cos(a), -0.30 * Math.sin(a));
      return hit(ctr.clone().addScaledVector(d, 4), d.clone().negate().normalize()).distanceTo(ctr) / d.length();
    });
    const at = (i) => r[(i + n) % n], parts = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) if (r[i] < at(i - 1) && r[i] <= at(i + 1) && (at(i - 4) + at(i + 4)) / 2 - r[i] > 0.012) parts[Math.floor(i / (n / 4))]++;
    assert(parts.every((k) => k >= 2), `multiple geometric folia in all four quadrants at x=${k}: ${parts}`);
    return parts;
  });
  return { posterior: posterior.map((v) => +v.toFixed(4)), foliaPerQuadrant: grooves };
}

const args = process.argv.slice(2);
for (const file of args.length ? args : ["assets/brain.glb", "assets/brain_low.glb"]) test(file, async () => {
  const { scene } = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(file)).buffer, "");
  const mesh = scene.getObjectByName("cerebellum");
  assert(mesh?.isMesh, "named cerebellum primitive");
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  console.log(JSON.stringify({ file, ...checkTopology(geometry), ...checkShape(geometry) }));
});
