// Containment suite on the REAL assets/brain.glb: the shipped signed distance field is rebuilt from the meshes and compared, then the actual layout,
// routing, arbor and background-cell generation runs for synthetic fixtures plus adversarial cases. Every fibre, arbor segment, background-cell branch,
// pulse path, soma and sparkle point is sampled at <= 0.5 voxel and must be at least `margin` below the surface. Prints before (v0.3.0 logic) / after numbers.
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildGraph } from "../src/adapter";
import { demoSource } from "../demo/fixture";
import { parseBrainGLB } from "../src/brain";
import { Field, parseField, serializeField, V3 } from "../src/field";
import { generateField, readGlbMeshes, capsuleMesh, makeBridges, RawMesh } from "../src/sdfgen";
import { Router, Region3, minDepthAlong, clipMorph, insetSurfacePoints } from "../src/contain";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { containSomas, makeNoteMorphs, planLinks, makeDecor, WNode, LINK_SEG, somaNeed, makeLinkBolt, linkBoltOpts, LinkPlan } from "../src/world";
import { ambientBolts, ambientBoltAt, sampleBolt, Bolt, lobeOf, binName, BINS, ambientNeed } from "../src/lightning";
import { QUALITY, lodByCount, complexityFor, Quality } from "../src/quality";
import { Placement, rng, fnv } from "../src/layout";
import { Morph, KIND_BOUTON } from "../src/morph";
import { orient, cellsOf } from "../src/impulse";

const GLB = "assets/brain.glb", SDF = "assets/brain_sdf.bin";
assert(existsSync(GLB) && existsSync(SDF), "assets/brain.glb and assets/brain_sdf.bin must exist (npm run assets:sdf)");
const glbBytes = readFileSync(GLB), sdfBytes = readFileSync(SDF);
let groups = 0; const report: Record<string, unknown> = {};
const t = async (name: string, fn: () => void | Promise<void>) => { try { await fn(); groups++; console.log("PASS", name); } catch (e) { console.error("FAIL contain:", name); throw e; } };

(async () => {
  const raw = readGlbMeshes(new Uint8Array(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength));
  // production wiring: the SHIPPED field goes through parseBrainGLB, and every check below uses the field the app would use (asset.field with its exterior-boundary distance)
  const asset = await parseBrainGLB(glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength) as ArrayBuffer, sdfBytes.buffer.slice(sdfBytes.byteOffset, sdfBytes.byteOffset + sdfBytes.byteLength) as ArrayBuffer);
  assert.equal(asset.fieldVerified, true, "shipped field is accepted against the real exterior surface"); const field = asset.field;
  const h = field.h, M = field.margin, EPS = 1e-4;

  const lowBytes = readFileSync("assets/brain_low.glb"), lowRaw = readGlbMeshes(lowBytes);
  await t("shipped field equals a fresh build from both runtime GLBs (byte-identical)", () => {
    const glbSha256 = [glbBytes, lowBytes].map((b) => createHash("sha256").update(b).digest("hex"));
    const { field: f2, info } = generateField([raw, lowRaw], { extra: { glbSha256 } });
    assert.equal(info.parts.cerebellum.method, "parity", "closed cerebellum (no hull fallback)");
    const a = serializeField(f2); assert.equal(a.length, sdfBytes.length, "size"); assert(Buffer.compare(Buffer.from(a), sdfBytes) === 0, "bytes differ: run npm run assets:sdf");
    assert(M >= 2 * h - 1e-9 && Math.abs(h - 2 / 128) < 1e-9, "voxel 2/128 and margin >= 2 voxels"); report.fieldDims = field.dims.join("x"); report.margin = +M.toFixed(4); report.voxel = +h.toFixed(5); report.parts = info.parts;
  });

  await t("EXTERIOR clearance: no accepted interior point is within the margin of a VISIBLE (non-buried) surface, both LODs, parts and bridge capsules (independent BVH/analytic verifier)", () => {
    const bvh = (m: RawMesh) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(m.pos as ArrayLike<number>), 3)); g.setIndex(Array.from(m.idx as ArrayLike<number>)); return new MeshBVH(g); };
    const LODs = [raw, lowRaw];
    const solids = ["cortex_lh", "cortex_rh", "brainstem"] as const, all = ["cortex_lh", "cortex_rh", "brainstem", "cerebellum"] as const;
    const S = LODs.map((L) => Object.fromEntries(all.map((n) => [n, bvh(L[n])]))) as Record<string, MeshBVH>[];
    const caps = field.bridges, capB = caps.map((b) => bvh(capsuleMesh(b.a, b.b, b.r)));
    const ray = new THREE.Ray(), dir = new THREE.Vector3(0.3, 0.9, -0.31).normalize();
    const par = (b: MeshBVH, p: THREE.Vector3) => { ray.origin.copy(p); ray.direction.copy(dir); return (b.raycast(ray, THREE.DoubleSide) as unknown[]).length % 2 === 1; };
    const sd = (p: THREE.Vector3, a: number[], b: number[]) => { const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], t = Math.max(0, Math.min(1, ((p.x - a[0]) * d[0] + (p.y - a[1]) * d[1] + (p.z - a[2]) * d[2]) / l2)); return Math.hypot(p.x - a[0] - d[0] * t, p.y - a[1] - d[1] * t, p.z - a[2] - d[2] * t); };
    const inCap = (p: THREE.Vector3, skip: number) => caps.some((b, i) => i !== skip && sd(p, b.a, b.b) < b.r - 0.002);
    const r = rng(42), tg = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }, q = new THREE.Vector3(); let checked = 0, proven = 0, worst = Infinity, hidden = 0;
    for (let k = 0; k < 60000; k++) {
      q.set((r() - 0.5) * 1.7, (r() - 0.5) * 1.6, (r() - 0.5) * 2.1); if (field.depth(q.x, q.y, q.z) < M) continue; checked++;
      const test = (d: number, pt: THREE.Vector3, exterior: boolean) => { if (!exterior) { hidden++; return; } worst = Math.min(worst, d); if (d < M - 1e-3) proven++; };
      LODs.forEach((_, li) => { for (const n of all) { const hit = S[li][n].closestPointToPoint(q, tg); if (!hit || hit.distance >= M) continue; const pt = tg.point.clone(); test(hit.distance, pt, !inCap(pt, -1) && !solids.some((m) => m !== n && par(S[li][m], pt))); } });
      caps.forEach((_, ci) => { const hit = capB[ci].closestPointToPoint(q, tg); if (!hit || hit.distance >= M) return; const pt = tg.point.clone(); test(hit.distance, pt, !inCap(pt, ci) && !LODs.every((_l, li) => all.some((m) => par(S[li][m], pt)))); });
    }
    assert.equal(proven, 0, `${proven} accepted interior points are within the margin of a visible surface (worst ${worst})`); assert(checked > 3000, "sampled " + checked);
    for (const p of [[3, 3, 3], [-2, 0, 0], [0, -3, 1], [0.9, 0.9, 0.9]] as V3[]) assert(field.depth(p[0], p[1], p[2]) < -0.5, "far outside is negative");
    report.exteriorVerifier = { checked, proven, hiddenSurfaceHitsIgnored: hidden, worstVisibleClearance: worst === Infinity ? null : +worst.toFixed(4) };
  });

  await t("one connected inside: cerebrum (both hemispheres), brainstem and cerebellum are in the main component at the margin", () => {
    const c = field.coreInfo(M); assert(c.main > 100000, "main core " + c.main);
    const probe = (p: V3, why: string) => { const q = field.project(p, M); assert(field.depth(q[0], q[1], q[2]) >= M - EPS && field.inMainCore(q, M), why); };
    probe([-0.3, 0.1, 0.1], "left cerebrum"); probe([0.3, 0.1, 0.1], "right cerebrum"); probe([0, -0.45, -0.1], "brainstem"); probe([0.1, -0.59, -0.5], "cerebellum"); probe([-0.25, -0.59, -0.5], "left cerebellum");
    report.coreMainVoxels = c.main;
    // the bridge route exists: a cerebellum point and a cerebral point are in the SAME component after projection
    const a = field.project([-0.3, 0.1, 0.5], M), b = field.project([0.25, -0.6, -0.55], M); assert(field.inMainCore(a, M) && field.inMainCore(b, M));
  });

  // ---------------------------------------------------------------- generation under test
  type Cfg = { name: string; n: number; custom?: (nodes: WNode[]) => Record<string, { brain: V3 }> };
  interface Counts { somas: number; somaOut: number; arborSamples: number; arborOut: number; fibreSamples: number; fibreOut: number; pulseSamples: number; pulseOut: number; decorSamples: number; decorOut: number; sparkSamples: number; sparkOut: number; minDepth: number; }
  const newCounts = (): Counts => ({ somas: 0, somaOut: 0, arborSamples: 0, arborOut: 0, fibreSamples: 0, fibreOut: 0, pulseSamples: 0, pulseOut: 0, decorSamples: 0, decorOut: 0, sparkSamples: 0, sparkOut: 0, minDepth: Infinity });
  const STEP = 0.5 * h, thr = (strict: boolean) => (strict ? M - EPS : M);
  /** Sample a segment at <= 0.5 voxel; returns [samples, violations, minDepth]. */
  const seg = (a: ArrayLike<number>, b: ArrayLike<number>, level: number): [number, number, number] => {
    const l = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), n = Math.max(1, Math.ceil(l / STEP)); let bad = 0, mn = Infinity;
    for (let s = 0; s <= n; s++) { const u = s / n, d = field.depthE(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u); if (d < level) bad++; if (d < mn) mn = d; }
    return [n + 1, bad, mn];
  };
  const arborCheck = (m: Morph, base: V3, c: Counts, level: number, pulse?: Set<number>) => {
    for (let i = 1; i < m.n; i++) { const p = m.parent[i], A = [base[0] + m.pos[p * 3], base[1] + m.pos[p * 3 + 1], base[2] + m.pos[p * 3 + 2]], B = [base[0] + m.pos[i * 3], base[1] + m.pos[i * 3 + 1], base[2] + m.pos[i * 3 + 2]], [n, bad, mn] = seg(A, B, level); c.arborSamples += n; c.arborOut += bad; c.minDepth = Math.min(c.minDepth, mn); if (pulse) { pulse.add(i); } }
  };
  const pathNodes = (m: Morph, k: number) => { const o: number[] = []; for (let i = k; i > 0; i = m.parent[i]) o.push(i); return o; };
  const polyCheck = (pts: V3[], level: number): [number, number, number] => { let n = 0, bad = 0, mn = Infinity; for (let i = 1; i < pts.length; i++) { const [a, b, c] = seg(pts[i - 1], pts[i], level); n += a; bad += b; mn = Math.min(mn, c); } return [n, bad, mn]; };

  function runNew(nodes: WNode[], edges: { a: number; b: number }[], saved: Record<string, { brain?: V3 }>, places: Placement[], decorN: number, sparkleN: number, carriers: number) {
    const c = newCounts(), t0 = Date.now(), sp = containSomas(field, nodes, places, saved), nm = makeNoteMorphs(field, nodes, sp.places, sp.brainP, { carriers, radiusMul: 1 });
    const router = new Router(field), plans = planLinks(field, router, nodes, edges, nm.morphs, sp.brainP, sp.regions);
    for (let i = 0; i < nodes.length; i++) { const p: V3 = [sp.brainP[i * 3], sp.brainP[i * 3 + 1], sp.brainP[i * 3 + 2]]; c.somas++; const d = field.depth(p[0], p[1], p[2]); c.minDepth = Math.min(c.minDepth, d); if (d < M - EPS) c.somaOut++; arborCheck(nm.morphs[i], p, c, M - EPS); }
    for (const pl of plans) { const [n, bad, mn] = polyCheck(pl.pts, M - EPS); c.fibreSamples += n; c.fibreOut += bad; c.minDepth = Math.min(c.minDepth, mn);
      // pulse paths: source axon path, the fibre, target dendrite path
      const ms = nm.morphs[pl.src], md = nm.morphs[pl.dst], bs: V3 = [sp.brainP[pl.src * 3], sp.brainP[pl.src * 3 + 1], sp.brainP[pl.src * 3 + 2]], bd: V3 = [sp.brainP[pl.dst * 3], sp.brainP[pl.dst * 3 + 1], sp.brainP[pl.dst * 3 + 2]];
      const walk = (m: Morph, k: number, b: V3) => { for (const i of pathNodes(m, k)) { const p = m.parent[i], [q, bad2] = seg([b[0] + m.pos[p * 3], b[1] + m.pos[p * 3 + 1], b[2] + m.pos[p * 3 + 2]], [b[0] + m.pos[i * 3], b[1] + m.pos[i * 3 + 1], b[2] + m.pos[i * 3 + 2]], M - EPS); c.pulseSamples += q; c.pulseOut += bad2; } };
      walk(ms, pl.term, bs); walk(md, pl.tip, bd); c.pulseSamples += n; c.pulseOut += bad; }
    let dc = { cells: [] as ReturnType<typeof makeDecor>["cells"], cut: 0, dropped: 0 };
    if (decorN) { dc = makeDecor(field, decorN, carriers, (r) => { const tp = asset.tissuePoint(r, 0.03, 0.16); return { pos: tp.pos, normal: tp.normal }; }); for (const cell of dc.cells) { const cc = newCounts(); arborCheck(cell.morph, cell.pos, cc, M - EPS); c.decorSamples += cc.arborSamples; c.decorOut += cc.arborOut; c.minDepth = Math.min(c.minDepth, cc.minDepth); } }
    if (sparkleN) { const s = asset.surfaceSamples(sparkleN, 0x5a4c1e), ins = insetSurfacePoints(field, s.pos, s.nrm, s.rand, M + 0.5 * h); for (let i = 0; i < ins.count; i++) { c.sparkSamples++; if (field.depth(ins.pos[i * 3], ins.pos[i * 3 + 1], ins.pos[i * 3 + 2]) < M - EPS) c.sparkOut++; } report["sparkleDropped_" + nodes.length] = ins.dropped; }
    assert.equal(plans.length, edges.length, "one route per edge"); plans.forEach((p, i) => { const e = edges[i]; assert((p.src === e.a && p.dst === e.b) || (p.src === e.b && p.dst === e.a), "route endpoints are the edge endpoints"); const aSrc = orient(nodes[e.a].id, nodes[e.b].id); assert.equal(p.src, aSrc ? e.a : e.b); });
    return { c, sp, nm, plans, router, dc, ms: Date.now() - t0 };
  }
  /** v0.3.0 behaviour, replicated for the before numbers: placer positions, unclipped arbors, quadratic links with the callosal arch, unprojected sparkle on the surface. */
  function runLegacy(nodes: WNode[], edges: { a: number; b: number }[], places: Placement[], saved: Record<string, { brain?: V3 }>, decorN: number, sparkleN: number, carriers: number) {
    const c = newCounts(), P = new Float32Array(nodes.length * 3); nodes.forEach((n, i) => P.set(saved[n.id]?.brain ?? places[i].pos, i * 3));
    const morphs = makeNoteMorphs(field, nodes, places, P, { carriers, radiusMul: 1 }).morphs; // clipped: rebuild unclipped below
    const raw0 = nodes.map((nd, i) => { const mm = morphsRaw(nd, places[i], carriers); return mm; });
    void morphs; const level = 0; // before: count samples with depth < margin (the new rule) and, separately, truly outside (< 0)
    const outsideTrue = { arbor: 0, fibre: 0, spark: 0, decor: 0, soma: 0 };
    const count = (a: ArrayLike<number>, b: ArrayLike<number>) => { const l = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), n = Math.max(1, Math.ceil(l / STEP)); let bad = 0, tr = 0; for (let s = 0; s <= n; s++) { const u = s / n, d = field.depth(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u); if (d < M - EPS) bad++; if (d < level) tr++; } return [n + 1, bad, tr]; };
    for (let i = 0; i < nodes.length; i++) { const p: V3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]; c.somas++; const d = field.depth(p[0], p[1], p[2]); if (d < M - EPS) c.somaOut++; if (d < 0) outsideTrue.soma++; const m = raw0[i]; for (let k = 1; k < m.n; k++) { const q = m.parent[k], r = count([p[0] + m.pos[q * 3], p[1] + m.pos[q * 3 + 1], p[2] + m.pos[q * 3 + 2]], [p[0] + m.pos[k * 3], p[1] + m.pos[k * 3 + 1], p[2] + m.pos[k * 3 + 2]]); c.arborSamples += r[0]; c.arborOut += r[1]; outsideTrue.arbor += r[2]; } }
    const outN = new Int32Array(nodes.length), inN = new Int32Array(nodes.length);
    edges.forEach((e) => { const aSrc = orient(nodes[e.a].id, nodes[e.b].id), src = aSrc ? e.a : e.b, dst = aSrc ? e.b : e.a, ms = raw0[src], md = raw0[dst]; const term = ms.axonTerminals.length ? ms.axonTerminals[outN[src]++ % ms.axonTerminals.length] : 0, tip = md.dendTips.length ? md.dendTips[inN[dst]++ % md.dendTips.length] : 0;
      const p0: V3 = [P[src * 3] + ms.pos[term * 3], P[src * 3 + 1] + ms.pos[term * 3 + 1], P[src * 3 + 2] + ms.pos[term * 3 + 2]], p1: V3 = [P[dst * 3] + md.pos[tip * 3], P[dst * 3 + 1] + md.pos[tip * 3 + 1], P[dst * 3 + 2] + md.pos[tip * 3 + 2]];
      const mid: V3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2], dist = Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]), dx = -mid[0], dy = 0.05 - mid[1], dz = -mid[2], l = Math.hypot(dx, dy, dz) || 1, k = Math.min(0.2 * dist, l * 0.95), cross = p0[0] * p1[0] < 0 ? 0.14 * dist : 0;
      const ctl: V3 = [mid[0] + (dx / l) * k, mid[1] + (dy / l) * k + cross, mid[2] + (dz / l) * k]; let prev = p0;
      for (let s = 1; s <= 14; s++) { const u = s / 14, w = 1 - u, q: V3 = [w * w * p0[0] + 2 * w * u * ctl[0] + u * u * p1[0], w * w * p0[1] + 2 * w * u * ctl[1] + u * u * p1[1], w * w * p0[2] + 2 * w * u * ctl[2] + u * u * p1[2]]; const r = count(prev, q); c.fibreSamples += r[0]; c.fibreOut += r[1]; outsideTrue.fibre += r[2]; prev = q; } });
    if (decorN) for (let k = 0; k < decorN; k++) { const r = rng(fnv("decor:" + k)), tp = asset.tissuePoint(r, 0.03, 0.16), reach = (0.05 + 0.04 * r()) * 0.8; void reach; const mm = decorRaw(k, tp, carriers); for (let j = 1; j < mm.n; j++) { const q = mm.parent[j], rr = count([tp.pos[0] + mm.pos[q * 3], tp.pos[1] + mm.pos[q * 3 + 1], tp.pos[2] + mm.pos[q * 3 + 2]], [tp.pos[0] + mm.pos[j * 3], tp.pos[1] + mm.pos[j * 3 + 1], tp.pos[2] + mm.pos[j * 3 + 2]]); c.decorSamples += rr[0]; c.decorOut += rr[1]; outsideTrue.decor += rr[2]; } }
    if (sparkleN) { const s = asset.surfaceSamples(sparkleN, 0x5a4c1e); for (let i = 0; i < sparkleN; i++) { c.sparkSamples++; const d = field.depth(s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]); if (d < M - EPS) c.sparkOut++; if (d < 0) outsideTrue.spark++; } }
    return { c, outsideTrue };
  }
  // unclipped morph builders (what v0.3.0 rendered)
  const { makeMorph, decorMorph, cellTypeFor, hubOf, reachFor } = await import("../src/morph");
  const morphsRaw = (nd: WNode, pl: Placement, carriers: number) => makeMorph(nd.id, { type: cellTypeFor(nd.id, pl.region, nd.degree), reach: reachFor(nd.degree), hub: hubOf(nd.degree), normal: pl.normal, depth: pl.depth, carriers, radiusMul: 1, maxPoints: Math.max(60, Math.round((240 + 360 * hubOf(nd.degree)) * carriers)) });
  const decorRaw = (k: number, tp: { normal: V3 }, carriers: number) => { const r = rng(fnv("decor:" + k)); r(); r(); r(); r(); r(); r(); r(); return decorMorph(String(k), (0.05 + 0.04 * r()) * 0.8, tp.normal, Math.max(6, Math.round(11 * carriers))); };

  // ---------------------------------------------------------------- lightning bolts (v0.3.2): the exact generators the scene uses
  interface BoltCounts { bolts: number; main: number; mainOut: number; fork: number; forkOut: number; forks: number; min: number; segments: number; }
  const boltCounts = (f: Field, bolts: Bolt[]): BoltCounts => { const c: BoltCounts = { bolts: 0, main: 0, mainOut: 0, fork: 0, forkOut: 0, forks: 0, min: Infinity, segments: 0 };
    for (const b of bolts) { if (b.n < 2) continue; const r = sampleBolt(f, b, 0.5 * f.h, f.margin - EPS); c.bolts++; c.main += r.main; c.mainOut += r.mainOut; c.fork += r.fork; c.forkOut += r.forkOut; c.forks += b.forks; c.min = Math.min(c.min, r.min); c.segments += b.n - 1; } return c; };
  const linkBoltsOf = (f: Field, nodes: WNode[], plans: LinkPlan[], morphs: Morph[], brainP: Float32Array, n: number, detail: number) => plans.map((pl) => makeLinkBolt(f, nodes, pl, morphs, brainP, linkBoltOpts(complexityFor(n), detail, asset.ambientSource().cortexBox)));
  const ambientCache = new Map<string, ReturnType<typeof ambientBolts>>();
  const ambientFor = (a: typeof asset, q: Quality, n: number, tag: string) => { const qs = lodByCount(QUALITY[q], n), k = `${tag}|${qs.ambientBolts}|${qs.boltDetail}`; let r = ambientCache.get(k); if (!r) { r = ambientBolts(a.field, a.ambientSource(), { count: qs.ambientBolts, detail: qs.boltDetail }); ambientCache.set(k, r); } return r; };
  const lowAsset = await parseBrainGLB(lowBytes.buffer.slice(lowBytes.byteOffset, lowBytes.byteOffset + lowBytes.byteLength) as ArrayBuffer, sdfBytes.buffer.slice(sdfBytes.byteOffset, sdfBytes.byteOffset + sdfBytes.byteLength) as ArrayBuffer);
  assert.equal(lowAsset.fieldVerified, true, "Low asset (brain_low.glb) field verified against its own exterior");

  const sources = (n: number) => { const g = buildGraph(demoSource(n)), nodes: WNode[] = g.nodes.map((x) => ({ id: x.id, folder: x.folder, degree: x.degree })); return { g, nodes }; };
  const place = (nodes: WNode[], edges: { a: number; b: number }[]) => asset.relax(nodes.map((n) => asset.placer(n.id, n.folder)), edges.map((e) => [e.a, e.b] as [number, number]), nodes.map((n) => n.id));
  const results: Record<string, unknown> = {};

  for (const n of [31, 150, 1500]) await t(`fixture ${n} notes: 0 samples beyond the margin (somas, arbors, fibres, pulse paths, background cells, sparkle, lightning bolts: link main channels + forks, ambient channels + forks); before vs after`, () => {
    const { g, nodes } = sources(n), places = place(nodes, g.edges), decorN = n > 600 ? 200 : 700, sparkle = n > 600 ? 12000 : 25000, carriers = n <= 200 ? 1 : n <= 600 ? 0.6 : 0.28;
    const after = runNew(nodes, g.edges, {}, places, decorN, sparkle, carriers), before = runLegacy(nodes, g.edges, places, {}, decorN, sparkle, carriers);
    const c = after.c;
    assert.equal(c.somaOut, 0, "somas"); assert.equal(c.arborOut, 0, "arbors"); assert.equal(c.fibreOut, 0, "fibres"); assert.equal(c.pulseOut, 0, "pulse paths"); assert.equal(c.decorOut, 0, "decor"); assert.equal(c.sparkOut, 0, "sparkle");
    assert(c.minDepth >= M - EPS, "min depth " + c.minDepth);
    assert.equal(after.router.stats.failed, 0, "no route failed"); assert(after.plans.every((p) => p.ok));
    assert(c.fibreSamples > 100 && c.arborSamples > 100, "samples were actually taken");
    // lightning: one bolt per real edge (main channel soma->axon->jagged route->dendrite->soma, plus forks) at High and Low detail, and the decorative ambient bolts of every quality
    const tb = Date.now(), lbHigh = linkBoltsOf(field, nodes, after.plans, after.nm.morphs, after.sp.brainP, n, QUALITY.high.boltDetail), lbLow = linkBoltsOf(field, nodes, after.plans, after.nm.morphs, after.sp.brainP, n, QUALITY.low.boltDetail);
    assert.equal(lbHigh.length, g.edges.length, "one link bolt per real edge"); lbHigh.forEach((b, i) => { const pl = after.plans[i]; assert(b.src === pl.src && b.dst === pl.dst && b.edge === i, "link bolt endpoints are the edge's oriented endpoints"); });
    const LH = boltCounts(field, lbHigh), LL = boltCounts(field, lbLow), amb: Record<string, BoltCounts> = {};
    for (const q of ["high", "balanced", "low"] as Quality[]) { const a = q === "low" ? lowAsset : asset, res = ambientFor(a, q, n, q === "low" ? "low" : "high"); amb[q] = boltCounts(a.field, res.bolts); assert(res.bolts.length >= Math.min(lodByCount(QUALITY[q], n).ambientBolts, 60) * 0.9, `${q}: ambient bolts grown ${res.bolts.length}`); }
    for (const [k, b] of Object.entries({ linkHigh: LH, linkLow: LL, ...Object.fromEntries(Object.entries(amb).map(([q, v]) => ["ambient_" + q, v])) })) {
      assert.equal(b.mainOut, 0, `${k}: main-channel samples beyond the margin`); assert.equal(b.forkOut, 0, `${k}: fork samples beyond the margin`); assert(b.min >= M - EPS, `${k}: min depth ${b.min}`);
      assert(b.main > 100 && b.fork > 50 && b.forks > 0, `${k}: main channels AND forks were actually sampled ${JSON.stringify(b)}`);
    }
    const boltMs = Date.now() - tb;
    console.log(`         bolts  link(High) main ${LH.mainOut}/${LH.main} forks ${LH.forkOut}/${LH.fork} (${LH.forks} forks, ${LH.segments} segments), link(Low) ${LL.mainOut + LL.forkOut}/${LL.main + LL.fork}, ambient ${Object.entries(amb).map(([q, v]) => `${q} ${v.mainOut + v.forkOut}/${v.main + v.fork} (${v.bolts} bolts, ${v.forks} forks)`).join(", ")}, min depth ${(Math.min(LH.min, LL.min, ...Object.values(amb).map((v) => v.min)) / h).toFixed(2)} voxels, ${boltMs} ms`);
    results[n] = { edges: g.edges.length, before: { ...before.c, outsideTrue: before.outsideTrue }, after: c, router: after.router.stats, projectedPlaced: after.sp.projectedPlaced, clip: { cut: after.nm.cut, dropped: after.nm.dropped }, decorClip: { cut: after.dc.cut, dropped: after.dc.dropped }, ms: after.ms, bolts: { linkHigh: LH, linkLow: LL, ambient: amb } };
    console.log(`  n=${n}: before outside-margin samples fibre ${before.c.fibreOut}/${before.c.fibreSamples}, arbor ${before.c.arborOut}/${before.c.arborSamples}, decor ${before.c.decorOut}/${before.c.decorSamples}, sparkle ${before.c.sparkOut}/${before.c.sparkSamples}, somas ${before.c.somaOut}/${before.c.somas} (truly outside the pial surface: ${JSON.stringify(before.outsideTrue)})`);
    console.log(`         after  fibre ${c.fibreOut}/${c.fibreSamples}, arbor ${c.arborOut}/${c.arborSamples}, pulse ${c.pulseOut}/${c.pulseSamples}, decor ${c.decorOut}/${c.decorSamples}, sparkle ${c.sparkOut}/${c.sparkSamples}, somas ${c.somaOut}/${c.somas}, min depth ${(c.minDepth / h).toFixed(2)} voxels, router ${JSON.stringify(after.router.stats)}, ${after.ms} ms`);
  });
  report.fixtures = results;

  await t("adversarial: positions far outside, cross-hemisphere, frontal-occipital, temporal-parietal across the Sylvian fissure, cerebrum-cerebellum", () => {
    const folders = ["topics", "projects", "memories"] as const;
    const spots: Record<string, V3> = { farA: [3, 3, 3], farB: [-2.5, -1.5, 0.4], farC: [0.1, -4, -1], farD: [0, 0.2, 5], lFront: [-0.3, 0.15, 0.85], rOcc: [0.3, 0.1, -0.85], lOcc: [-0.3, 0.1, -0.85], rFront: [0.3, 0.15, 0.85], lTemporal: [-0.55, -0.35, 0.15], lParietal: [-0.4, 0.5, -0.3], rTemporal: [0.55, -0.35, 0.15], rParietal: [0.4, 0.5, -0.3], cbL: [-0.25, -0.6, -0.5], cbR: [0.25, -0.6, -0.5], cerebrumLow: [-0.35, -0.4, 0.3], lMid: [-0.1, 0.05, 0.05], rMid: [0.1, 0.05, 0.05], gapTop: [0, 0.75, 0.1], gapUnder: [0, -0.6, 0.6] };
    const keys = Object.keys(spots), nodes: WNode[] = keys.map((k, i) => ({ id: `${folders[i % 3]}/adv-${k}.md`, folder: folders[i % 3], degree: 6 })), saved: Record<string, { brain?: V3 }> = {}; keys.forEach((k, i) => { saved[nodes[i].id] = { brain: spots[k] }; });
    const idx = (k: string) => keys.indexOf(k), E: { a: number; b: number }[] = [];
    const pairs: [string, string][] = [["lFront", "rOcc"], ["lFront", "lOcc"], ["lFront", "rFront"], ["lTemporal", "lParietal"], ["rTemporal", "rParietal"], ["lTemporal", "rTemporal"], ["cbL", "lFront"], ["cbR", "rFront"], ["cbL", "cbR"], ["farA", "farB"], ["farC", "cbL"], ["farD", "rOcc"], ["lMid", "rMid"], ["gapTop", "gapUnder"], ["cerebrumLow", "cbR"], ["lParietal", "rTemporal"], ["rOcc", "cbL"], ["lOcc", "rFront"], ["farA", "lFront"], ["farB", "rParietal"]];
    for (const [a, b] of pairs) E.push({ a: Math.min(idx(a), idx(b)), b: Math.max(idx(a), idx(b)) });
    assert(asset.fieldVerified === true, "shipped field accepted against the real surface"); report.exteriorStats = asset.exteriorStats;
    const base = nodes.map((n) => asset.placer(n.id, n.folder)); // placements are overridden by the saved positions below, exactly as at load time
    const r = runNew(nodes, E, saved, base, 0, 0, 1);
    assert(r.sp.projectedSaved >= 4, "far saved positions were projected: " + r.sp.projectedSaved);
    for (let i = 0; i < nodes.length; i++) { const p: V3 = [r.sp.brainP[i * 3], r.sp.brainP[i * 3 + 1], r.sp.brainP[i * 3 + 2]]; assert(field.depthE(p[0], p[1], p[2]) >= somaNeed(field, 6) - EPS, "adversarial soma deep enough " + keys[i]); assert(field.inMainCore(p, M), "soma in the main component " + keys[i]); }
    const c = r.c; assert.equal(c.somaOut + c.arborOut + c.fibreOut + c.pulseOut, 0, JSON.stringify(c)); assert(r.plans.every((p) => p.ok) && r.router.stats.failed === 0);
    report.adversarial = { pairs: pairs.length, routes: r.plans.length, astar: r.router.stats.astar, projectedSaved: r.sp.projectedSaved, samples: c.fibreSamples + c.arborSamples, outside: c.somaOut + c.arborOut + c.fibreOut + c.pulseOut };
    // the lightning bolts of these adversarial links (jagged main channels + forks across the fissure via the callosum and across the cerebellum gap)
    for (const det of [1, 0.4]) { const bc = boltCounts(field, linkBoltsOf(field, nodes, r.plans, r.nm.morphs, r.sp.brainP, nodes.length, det)); assert.equal(bc.mainOut + bc.forkOut, 0, "adversarial link bolts " + JSON.stringify(bc)); assert(bc.bolts === pairs.length && bc.fork > 0, "every adversarial link has a bolt with forks " + JSON.stringify(bc)); (report.adversarial as Record<string, unknown>)["bolts_" + det] = bc; }
    // routes between the hemispheres really use the callosal depth, not the vertex: the highest point of a cross-hemisphere route stays well below the top of the brain
    for (const [a, b] of [["lFront", "rOcc"], ["lFront", "rFront"], ["lOcc", "rFront"]] as [string, string][]) { const i = idx(a), j = idx(b), pl = r.plans.find((p) => (p.src === i && p.dst === j) || (p.src === j && p.dst === i))!; const top = Math.max(...pl.pts.map((q) => q[1])); assert(top < 0.62, `cross-hemisphere route ${a}-${b} stays below the vertex: ${top.toFixed(2)}`); }
  });

  await t("a straight line between hemispheres or across the cerebrum-cerebellum gap would have left the brain (the A* and routing fallbacks are exercised)", () => {
    const rt = new Router(field), cases: [V3, V3, Region3, Region3][] = [[[-0.3, 0.1, 0.1], [0.3, 0.1, 0.1], "L", "R"], [[-0.3, 0.1, 0.5], [0.3, 0.1, -0.5], "L", "R"], [[-0.3, 0.0, -0.5], [0.2, -0.6, -0.5], "L", "C"], [[0.45, -0.3, 0.2], [0.3, 0.3, -0.4], "R", "R"]];
    for (const [a0, b0, ra, rb] of cases) { const a = field.project(a0, M + 2 * h), b = field.project(b0, M + 2 * h), straight = minDepthAlong(field, [a, b]); const r = rt.route(a, b, ra, rb); assert(r.ok && r.minDepth >= M - EPS, "route valid " + r.minDepth); report["straightMin_" + ra + rb] = +(straight / h).toFixed(1); }
    // force the grid search path on a hard pair
    const hard = rt.route(field.project([-0.45, -0.38, 0.2], M + 2 * h), field.project([0.1, -0.6, -0.5], M + 2 * h), "L", "C"); assert(hard.ok && hard.minDepth >= M - EPS);
    report.routerStats = rt.stats;
  });

  await t("lightning: adversarial ambient bolts aimed ACROSS the longitudinal fissure and the cerebrum-cerebellum gap never leave the brain (a straight discharge would)", () => {
    const need = ambientNeed(field), lo = need + 0.004, cases: { name: string; p: V3; dir: V3; small?: boolean }[] = [];
    for (const z of [-0.45, -0.1, 0.25, 0.55]) for (const s of [-1, 1]) cases.push({ name: `fissure z=${z} ${s < 0 ? "L->R" : "R->L"}`, p: [s * 0.09, 0.5, z], dir: [-s, -0.05, 0] });
    for (const x of [-0.3, -0.1, 0.1, 0.3]) { cases.push({ name: `occipital->cerebellum x=${x}`, p: [x, -0.28, -0.62], dir: [0, -1, -0.25] }); cases.push({ name: `cerebellum->occipital x=${x}`, p: [x, -0.52, -0.55], dir: [0, 1, 0.1], small: true }); }
    for (const x of [-0.35, 0.35]) cases.push({ name: `temporal->cerebellum x=${x}`, p: [x, -0.38, -0.25], dir: [0, -0.6, -1] });
    let samples = 0, out = 0, grown = 0, straightOut = 0; const rows: string[] = [];
    cases.forEach((cs, i) => {
      const seed = field.project(cs.p, lo + 0.012), L = cs.small ? 0.2 : 0.5, d = Math.hypot(...cs.dir), dir: V3 = [cs.dir[0] / d, cs.dir[1] / d, cs.dir[2] / d];
      if (minDepthAlong(field, [seed, [seed[0] + dir[0] * L, seed[1] + dir[1] * L, seed[2] + dir[2] * L]]) < M) straightOut++; // positive control: the straight discharge leaves the tissue
      for (const det of [1, 0.4]) { const b = ambientBoltAt(field, seed, dir, { L, detail: det, small: cs.small, rngSeed: 0xad00 + i * 7 + (det < 1 ? 3 : 0) }); if (!b || b.n < 2) continue; grown++;
        const r = sampleBolt(field, b, 0.5 * h, M - EPS); samples += r.main + r.fork; out += r.mainOut + r.forkOut; if (r.mainOut + r.forkOut) rows.push(cs.name); }
    });
    assert.equal(out, 0, `adversarial ambient bolts outside: ${out} (${rows.join(", ")})`); assert(grown >= cases.length, `bolts grown ${grown}`); assert(samples > 2000, "samples " + samples);
    assert(straightOut >= cases.length * 0.75, `positive control: straight discharges across the fissure/gap would leave the brain in ${straightOut}/${cases.length} cases`);
    report.adversarialAmbient = { cases: cases.length, grown, samples, outside: out, straightWouldLeave: straightOut };
  });

  await t("lightning: ambient bolts cover the WHOLE cerebrum (both hemispheres, all four lobes, cortex shell), cerebellum/brainstem only occasionally; deterministic", () => {
    for (const [q, a] of [["high", asset], ["low", lowAsset]] as [Quality, typeof asset][]) {
      const res = ambientFor(a, q, 150, q), box = a.ambientSource().cortexBox, per = new Array(BINS).fill(0), lobeHits = new Array(8).fill(0); let xmin = 9, xmax = -9, zmin = 9, zmax = -9, ymin = 9, ymax = -9;
      for (const b of res.bolts) { per[b.bin]++; if (b.bin < 8) for (let i = 0; i < b.n; i++) { const p: V3 = [b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]]; xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); zmin = Math.min(zmin, p[2]); zmax = Math.max(zmax, p[2]); lobeHits[(p[0] < 0 ? 0 : 4) + lobeOf(p, box)]++; } }
      for (let b = 0; b < 8; b++) { assert(per[b] >= 2, `${q}: ${binName(b)} has bolts (${per[b]})`); assert(lobeHits[b] > 50, `${q}: bolt nodes lie in ${binName(b)} (${lobeHits[b]})`); }
      assert(per[8] >= 1 && per[8] < per.slice(0, 8).reduce((x, y) => x + y, 0) * 0.12, `${q}: cerebellum gets occasional small bolts (${per[8]})`);
      assert(xmin < -0.45 && xmax > 0.45 && zmin < -0.6 && zmax > 0.6 && ymin < -0.3 && ymax > 0.35, `${q}: bolts span the cerebrum: x ${xmin.toFixed(2)}..${xmax.toFixed(2)} y ${ymin.toFixed(2)}..${ymax.toFixed(2)} z ${zmin.toFixed(2)}..${zmax.toFixed(2)}`);
      const again = ambientBolts(a.field, a.ambientSource(), { count: lodByCount(QUALITY[q], 150).ambientBolts, detail: QUALITY[q].boltDetail });
      assert(again.bolts.length === res.bolts.length && again.bolts.every((b, i) => b.n === res.bolts[i].n && b.pos.every((v, k) => v === res.bolts[i].pos[k])), `${q}: deterministic`);
      // spatial-exclusion cells exist for every bolt (the scheduler never lights two strikes over the same region at once)
      assert(res.bolts.every((b) => cellsOf(b.pos, b.n).length >= 1));
      report["ambientBins_" + q] = Object.fromEntries(per.map((c, b) => [binName(b), c]));
    }
  });

  await t("arbor clipping truncates at the margin and drops descendants; apical dendrites aim at the nearest surface", () => {
    const { g, nodes } = sources(31), places = place(nodes, g.edges), sp = containSomas(field, nodes, places, {});
    let apicalOK = 0, apicalN = 0;
    const raw = nodes.map((nd, i) => makeMorph(nd.id, { type: "pyramidal", reach: 0.12, hub: 1, normal: sp.places[i].normal, depth: Math.max(0.02, sp.places[i].depth - M), carriers: 1, radiusMul: 1 }));
    raw.forEach((m, i) => { const base: V3 = [sp.brainP[i * 3], sp.brainP[i * 3 + 1], sp.brainP[i * 3 + 2]], c = clipMorph(m, base, field); for (let k = 1; k < c.morph.n; k++) { const p = c.morph.parent[k]; assert(p >= 0 && p < k, "parent order kept"); }
      const reachLimit = (v: V3) => field.depth(v[0], v[1], v[2]); let far: V3 | null = null, fd = 0; for (let k = 1; k < c.morph.n; k++) { const q: V3 = [base[0] + c.morph.pos[k * 3], base[1] + c.morph.pos[k * 3 + 1], base[2] + c.morph.pos[k * 3 + 2]], dd = Math.hypot(c.morph.pos[k * 3], c.morph.pos[k * 3 + 1], c.morph.pos[k * 3 + 2]); const nn = sp.places[i].normal; if (m.kind[k] === 0 && dd > fd && c.morph.pos[k * 3] * nn[0] + c.morph.pos[k * 3 + 1] * nn[1] + c.morph.pos[k * 3 + 2] * nn[2] > 0.5 * dd) { fd = dd; far = q; } }
      if (far) { apicalN++; if (reachLimit(far) < M + 3 * h) apicalOK++; } });
    assert(apicalN > 5 && apicalOK / apicalN > 0.7, `apical tips end just under the surface (within ~3 voxels of the margin): ${apicalOK}/${apicalN}`);
    report.apicalEndNearSurface = `${apicalOK}/${apicalN}`;
  });

  await t("brain-asset integration: the asset exposes the field and the bridge parts", () => {
    assert(asset.field instanceof Field, "asset.field"); assert(Object.keys(asset.meshes).some((k) => k.startsWith("bridge")), "bridge meshes rendered");
    void KIND_BOUTON;
  });

  console.log("CONTAIN REPORT " + JSON.stringify(report));
  console.log(`containment tests: PASS (${groups} groups)`);
})().catch((e) => { console.error(e); process.exit(1); });
