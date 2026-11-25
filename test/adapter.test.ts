import assert from "node:assert";
import { buildGraph, graphFromApp, isAllowed } from "../src/adapter";
import { demoSource } from "../demo/fixture";
import { brainStarPos, universeStarPos, brainLayout, inHemisphereBounds, HALF_GAP } from "../src/layout";
import { buildDiag, DIAG_KEYS } from "../src/diag";
import { growDendrites, dendriteReach } from "../src/dendrites";
import { cortexMesh, gyriLines } from "../src/anatomy";
import { decimateSwc, connectedSwc, makeMorph, proceduralMorph, cellTypeFor, reachFor, hubOf, KIND_DENDRITE, KIND_AXON, KIND_MYELIN, KIND_BOUTON, GROUPS, SwcCell } from "../src/morph";
import { LightningSim, orient, Channel, AmbientChannel, Strike, RATES, REDUCED, KIND_LINK, KIND_AMBIENT } from "../src/impulse";
import { SelfReloader } from "../src/reload";
import { mergeData, applyState } from "../src/data";
import { autoQuality, QUALITY, isQuality } from "../src/quality";
import { buildNeuronGeo } from "../src/neuronGeo";
import { parseBrainGLB } from "../src/brain";
import { makeSynthGlb, SYNTH_RADII } from "./synth-glb";
import { PALETTE, SPECTRUM } from "../src/palette";
import { readFileSync, existsSync } from "node:fs";

const g = buildGraph(demoSource(150));
const ids = g.nodes.map((n) => n.id);
assert.equal(g.nodes.length, 150, "only the 150 clean demo notes survive");
assert.equal(g.excluded, 7, "7 decoys inside allowed dirs counted as withheld (daily/ and inbox/ are outside and not counted)");
for (const bad of ["secret", "private", "confidential", "credential", "flagged", "tagged-only", "fm-excluded", "daily/", "inbox/"]) assert(!ids.some((i) => i.toLowerCase().includes(bad)), "leaked " + bad);
assert(ids.every((i) => /^(topics|projects|memories)\//.test(i)));
const set = new Set(ids);
assert(g.edges.length > 50);
for (const e of g.edges) { assert(e.a < e.b); assert(g.nodes[e.a] && g.nodes[e.b]); }
// edges whose endpoint is excluded are dropped
const g2 = buildGraph({ paths: ["topics/ok1.md", "topics/ok2.md", "projects/secret review.md"], meta: () => ({ tags: [], fm: null }),
  resolvedLinks: { "topics/ok1.md": { "projects/secret review.md": 1, "topics/ok2.md": 1, "topics/ok1.md": 1 }, "projects/secret review.md": { "topics/ok2.md": 1 } } });
assert.equal(g2.nodes.length, 2); assert.equal(g2.edges.length, 1, "edge to excluded endpoint and self link dropped");
// fail closed when no metadata cache yet
assert.equal(isAllowed("topics/a.md", null), false);
assert.equal(isAllowed("topics/a.md", { tags: [], fm: null }), true);
assert.equal(isAllowed("topics/a.txt", { tags: [], fm: null }), false);
assert.equal(isAllowed("other/a.md", { tags: [], fm: null }), false);
assert.equal(isAllowed("topics/.hidden/a.md", { tags: [], fm: null }), false);
assert.equal(isAllowed("topics/a.md", { tags: ["#secret-project"], fm: null }), false);
assert.equal(isAllowed("topics/a.md", { tags: [], fm: { tags: "confidential" } }), false);
assert.equal(isAllowed("topics/a.md", { tags: [], fm: { tags: ["x", "Private"] } }), false);
assert.equal(isAllowed("topics/a.md", { tags: [], fm: { private: true } }), false, "frontmatter private: true");
assert.equal(isAllowed("topics/a.md", { tags: [], fm: { memory: "false" } }), false, "frontmatter memory: false");
assert.equal(isAllowed("topics/a.md", { tags: [], fm: { description: "mentions a secret" } }), true, "non-tag free text is not scanned");
// graphFromApp uses only metadataCache + file paths: mock app WITHOUT any read API; any content read would throw.
let reads = 0;
const app: any = {
  vault: { getMarkdownFiles: () => [{ path: "topics/a.md" }, { path: "topics/b.md" }, { path: "memories/c.md" }, { path: "topics/nocache.md" }],
    read: () => { reads++; throw new Error("read"); }, cachedRead: () => { reads++; throw new Error("read"); } },
  metadataCache: { getFileCache: (f: any) => (f.path === "topics/nocache.md" ? null : { tags: [], frontmatter: f.path === "memories/c.md" ? { tags: ["secret"] } : null }),
    resolvedLinks: { "topics/a.md": { "topics/b.md": 2, "memories/c.md": 1 } } },
};
const g3 = graphFromApp(app);
assert.deepEqual(g3.nodes.map((n) => n.id), ["topics/a.md", "topics/b.md"]);
assert.equal(g3.edges.length, 1); assert.equal(g3.excluded, 2); assert.equal(reads, 0);
// layout determinism & stability when other notes change
assert.deepEqual(brainStarPos("topics/x.md", "topics"), brainStarPos("topics/x.md", "topics"));
assert.deepEqual(universeStarPos("topics/x.md", "topics"), universeStarPos("topics/x.md", "topics"));
assert.notDeepEqual(brainStarPos("topics/x.md", "topics"), brainStarPos("topics/y.md", "topics"));
// brain layout: deterministic, inside hemisphere bounds, fissure gap respected, stable under note addition
for (const n of [150, 1500]) {
  const gg = buildGraph(demoSource(n));
  const l1 = brainLayout(gg.nodes, gg.edges), l2 = brainLayout(gg.nodes, gg.edges);
  assert.deepEqual(l1, l2, "layout deterministic " + n);
  assert.equal(l1.length, gg.nodes.length);
  let bad = 0, minAx = 9, left = 0;
  for (const p of l1) { if (!inHemisphereBounds(p)) bad++; minAx = Math.min(minAx, Math.abs(p[0])); if (p[0] < 0) left++; }
  assert.equal(bad, 0, "positions outside hemisphere bounds: " + bad);
  assert(minAx >= HALF_GAP, "fissure gap violated " + minAx);
  assert(left > l1.length * 0.35 && left < l1.length * 0.65, "both hemispheres populated");
  // pulling linked notes together: mean edge length must not grow versus unrelaxed seeds
  const seeds = gg.nodes.map((x) => brainStarPos(x.id, x.folder));
  const mean = (P: number[][]) => gg.edges.reduce((s, e) => s + Math.hypot(P[e.a][0] - P[e.b][0], P[e.a][1] - P[e.b][1], P[e.a][2] - P[e.b][2]), 0) / gg.edges.length;
  assert(mean(l1) < mean(seeds), "relaxation pulls linked notes closer");
}
{ // stability: adding one note moves only its neighbours (by far less than the brain size) and nobody else
  const base = demoSource(150), gA = buildGraph(base);
  const extra = "topics/DEMO added 999.md";
  const withNew = { ...base, paths: [...base.paths, extra], resolvedLinks: { ...base.resolvedLinks, [extra]: { [gA.nodes[3].id]: 1, [gA.nodes[40].id]: 1 } } };
  const gB = buildGraph(withNew);
  const A = brainLayout(gA.nodes, gA.edges), B = brainLayout(gB.nodes, gB.edges);
  const idxB = new Map(gB.nodes.map((n, i) => [n.id, i]));
  let moved = 0, maxMove = 0;
  gA.nodes.forEach((n, i) => { const q = B[idxB.get(n.id)!], p = A[i]; const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (d > 1e-9) moved++; maxMove = Math.max(maxMove, d); });
  assert(moved <= 40, "only a local neighbourhood moves: " + moved); assert(maxMove < 0.45, "no wild jumps: " + maxMove);
}
// dendrites: decorative, deterministic, bounded around their own soma (cannot reach another note's soma-scale neighbourhood by construction)
{
  const a = growDendrites("topics/x.md", dendriteReach(4)), b = growDendrites("topics/x.md", dendriteReach(4));
  assert.deepEqual(a, b); assert(a.ts.length >= 4 && a.ts.length < 40);
  for (let i = 0; i < a.segs.length; i += 3) assert(Math.hypot(a.segs[i], a.segs[i + 1], a.segs[i + 2]) <= dendriteReach(4) * 1.0001, "twig within reach of own soma");
  assert(dendriteReach(1000) < 0.1);
}
// silhouette geometry is non-trivial, deterministic and respects the fissure
{
  const m = cortexMesh(1), l = gyriLines(-1);
  assert(m.pos.length > 3000 && l.length > 600, "silhouette has geometry " + l.length);
  assert.deepEqual(gyriLines(-1), l);
  for (let i = 0; i < l.length; i += 3) assert(l[i] <= -HALF_GAP + 1e-6, "left contour stays left of fissure");
}
// diag (no scene): exact key whitelist, counts only
{
  const g = buildGraph(demoSource(150)), d = buildDiag("0.2.1", g, null, 1700000000000);
  assert.deepEqual(Object.keys(d).sort(), [...DIAG_KEYS].sort());
  assert.equal(d.nodes, 150); assert.equal(d.edges, g.edges.length); assert.equal(d.viewOpen, false);
  assert.deepEqual(Object.keys(d.folderCounts).sort(), ["memories", "projects", "topics"]);
  assert.equal(d.folderCounts.topics + d.folderCounts.projects + d.folderCounts.memories, 150);
  const s = JSON.stringify(d); assert(!s.includes("/") && !s.includes(".md"));
  for (const n of g.nodes) assert(!s.includes(n.title), "no titles in diag");
}


let unit = 0; const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]); const tests: [string, () => void | Promise<void>][] = [];
const opts = (o: any = {}) => ({ type: "pyramidal" as const, reach: 0.1, hub: 0.5, normal: [0, 1, 0] as [number, number, number], depth: 0.08, ...o });

t("morphology is deterministic per path and differs between paths", () => {
  const a = proceduralMorph("topics/a.md", opts()), b = proceduralMorph("topics/a.md", opts()), c = proceduralMorph("topics/b.md", opts());
  assert.deepEqual(Array.from(a.pos), Array.from(b.pos)); assert.deepEqual(Array.from(a.parent), Array.from(b.parent));
  assert.notDeepEqual(Array.from(a.pos), Array.from(c.pos));
});
t("morphology structure: tree, arc length, myelin, boutons, taper, groups", () => {
  for (const type of ["pyramidal", "stellate", "purkinje", "interneuron"] as const) {
    const m = proceduralMorph("topics/" + type + ".md", opts({ type }));
    assert.equal(m.type, type); assert(m.segments > 40, type + " segments " + m.segments);
    for (let i = 1; i < m.n; i++) { const p = m.parent[i]; assert(p >= 0 && p < i, "parent before child"); const l = Math.hypot(m.pos[i * 3] - m.pos[p * 3], m.pos[i * 3 + 1] - m.pos[p * 3 + 1], m.pos[i * 3 + 2] - m.pos[p * 3 + 2]); assert(Math.abs(m.s[i] - (m.s[p] + l)) < 1e-5, "arc length = parent + segment"); assert(m.rad[i] > 0); assert(m.group[i] < GROUPS); }
    assert(m.dendTips.length >= 3 && m.axonTerminals.length >= 4, "tips and terminals");
    assert(m.kind.some((k) => k === KIND_BOUTON) && m.kind.some((k) => k === KIND_AXON));
    for (const k of m.dendTips) assert.equal(m.kind[k], KIND_DENDRITE); for (const k of m.axonTerminals) assert.equal(m.kind[k], KIND_BOUTON);
    if (type === "pyramidal" || type === "purkinje") assert(m.kind.some((k) => k === KIND_MYELIN), type + " has myelin internodes");
    let far = 0; for (let i = 0; i < m.n; i++) far = Math.max(far, Math.hypot(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2])); assert(far < m.reach * 4, "bounded around its soma");
  }
});
t("pyramidal apical dendrite points toward the outward normal; hubs get bigger arbors", () => {
  const m = proceduralMorph("topics/p.md", opts({ normal: [0, 0, 1], depth: 0.2, hub: 0.2 })); let mx = -1, tip = 0;
  for (const k of m.dendTips) if (m.pos[k * 3 + 2] > mx) { mx = m.pos[k * 3 + 2]; tip = k; } assert(mx > m.reach * 0.4, "apical reaches along +normal: " + mx); void tip;
  const small = makeMorph("x", opts({ hub: hubOf(1), reach: reachFor(1) })), big = makeMorph("x", opts({ hub: hubOf(12), reach: reachFor(12) }));
  assert(big.segments > small.segments && big.reach > small.reach, "hub larger arbor");
  assert.equal(cellTypeFor("memories/x.md", "cerebellum", 1), "purkinje");
});
t("template path consumes SWC cells (seeded rotation/scale/jitter) and falls back to procedural", () => {
  const pts: number[][] = [[0, 0, 0, 8, -1, 1]]; for (let i = 1; i <= 30; i++) pts.push([(i % 3) * 5, i * 20, (i % 2) * 7, 1.5, i === 1 ? 0 : i - 1, i < 15 ? 4 : 3]); for (let i = 31; i <= 40; i++) pts.push([0, -(i - 30) * 15, 0, 1, i === 31 ? 0 : i - 1, 2]);
  const cell: SwcCell = { id: "t1", type: "pyramidal", points: pts };
  const a = makeMorph("topics/t.md", opts({ templates: [cell] })), b = makeMorph("topics/t.md", opts({ templates: [cell] })), c = makeMorph("topics/u.md", opts({ templates: [cell] }));
  assert.equal(a.source, "template"); assert.deepEqual(Array.from(a.pos), Array.from(b.pos)); assert.notDeepEqual(Array.from(a.pos), Array.from(c.pos));
  assert(a.axonTerminals.length > 0 && a.dendTips.length > 0);
  assert.equal(makeMorph("topics/t.md", opts({ templates: [{ ...cell, type: "stellate" }] })).source, "procedural", "no matching type: procedural");
  assert.equal(makeMorph("topics/t.md", opts()).source, "procedural");
});
t("tube and line geometry carry arc length; segments match", () => {
  const ms = [proceduralMorph("a", opts()), proceduralMorph("b", opts({ type: "stellate" }))];
  const tube = buildNeuronGeo(ms, { tube: true, radial: 5, radiusMul: 1 }), line = buildNeuronGeo(ms, { tube: false, radial: 0, radiusMul: 1 });
  assert.equal(tube.segments, ms[0].segments + ms[1].segments); assert.equal(line.vertices, tube.segments * 2); assert.equal(tube.vertices, (tube.segments + tube.sleeves) * 10 + tube.boutons * 12); assert(tube.boutons > 4 && tube.sleeves > 0, "boutons and myelin sleeves present");
  assert(tube.index!.length === (tube.segments + tube.sleeves) * 30 + tube.boutons * 60 && tube.index!.every((x) => x < tube.vertices) && tube.s.every((v) => v >= 0 && Number.isFinite(v)));
});
const mkLinks = (g: ReturnType<typeof buildGraph>): Channel[] => g.edges.map((e, i) => { const sa = orient(g.nodes[e.a].id, g.nodes[e.b].id); return { src: sa ? e.a : e.b, dst: sa ? e.b : e.a, edge: i, big: i % 3 === 0, cells: [i % 97, 300 + (i % 11)] }; });
t("lightning sim: link channels == graph edges exactly, strikes only on real edges, deterministic, cascades, flash caps, reduced motion, paused clock = nothing", () => {
  const g = buildGraph(demoSource(60)), links = mkLinks(g), amb: AmbientChannel[] = Array.from({ length: 50 }, (_, i) => ({ bin: i % 10, big: i % 4 === 0, cells: [500 + i] }));
  const run = (rates = RATES.high, secs = 60) => { const ev: string[] = [], st: Strike[] = []; let ended = 0;
    const sim = new LightningSim(g.nodes.length, links, amb, { strike: (s) => { st.push(s); ev.push(s.kind + ":" + s.bolt + "@" + s.t0.toFixed(4)); }, end: () => { ended++; }, clear() {} }, rates);
    for (let k = 0; k <= secs * 60; k++) sim.step(k / 60); return { sim, ev, st, ended }; };
  const A = run(), B = run(); assert.deepEqual(A.ev, B.ev, "deterministic schedule");
  const key = (a: number, b: number) => (a < b ? a + ":" + b : b + ":" + a), want = g.edges.map((e) => e.a + ":" + e.b).sort();
  assert.deepEqual(A.sim.paths().map(([a, b]) => key(a, b)).sort(), want, "one link channel per real edge"); assert.equal(new Set(A.sim.paths().map(([a, b]) => key(a, b))).size, g.edges.length);
  const L = A.st.filter((s) => s.kind === KIND_LINK), M = A.st.filter((s) => s.kind === KIND_AMBIENT);
  assert(L.length > 60 && M.length > 60, `link and ambient strikes: ${L.length} / ${M.length}`); assert.equal(A.sim.log.length, L.length);
  assert(L.length / 60 >= RATES.high.link * 0.85, `real-link discharges are not starved by decorative strikes under the flash budget: ${(L.length / 60).toFixed(2)}/s`);
  for (const s of L) assert(s.bolt >= 0 && s.bolt < g.edges.length, "link strike on a real edge");
  assert.equal(new Set(M.map((s) => amb[s.bolt].bin)).size, 10, "ambient strikes visit every bin");
  // cascade: a later strike leaves the note an earlier strike arrived at, within 1.5 s
  let casc = 0; for (const s of L) if (L.some((p) => links[p.bolt].dst === links[s.bolt].src && s.t0 > p.t0 && s.t0 - p.t0 < 1.5)) casc++; assert(casc > 5, "cascades reach other notes: " + casc);
  // timing: stepped leader 50-150 ms, 1-3 restrikes all within 180 ms of the return stroke, decay tau 35-70 ms, gone within ~1.5 s
  for (const s of A.st) { const g = s.gaps.filter((x) => x > 0), n = g.length; assert(s.leader >= 0.05 && s.leader <= 0.15 && n >= 1 && n <= 3 && Math.max(...g) <= 0.18 + 1e-9 && s.tau >= 0.035 && s.tau <= 0.07 && s.life < 1.5 && !s.reduced, JSON.stringify(s)); }
  // photosensitivity caps: in ANY 1 s window at most capPerSec onsets and at most 3 large ones; never two onsets closer than minGap
  const on = A.st.map((s) => s.t0), big = A.st.filter((s) => (s.kind === KIND_LINK ? links[s.bolt].big : amb[s.bolt].big)).map((s) => s.t0);
  for (const t0 of on) { assert(on.filter((x) => x > t0 - 1 && x <= t0).length <= RATES.high.capPerSec, "onsets per second"); assert(big.filter((x) => x > t0 - 1 && x <= t0).length <= 3, "large flashes per second"); }
  for (let i = 1; i < on.length; i++) assert(on[i] - on[i - 1] >= RATES.high.minGap - 1e-9, "onset gap");
  assert(A.sim.rateMax <= RATES.high.capPerSec && A.sim.bigRateMax <= 3 && A.ended > 0);
  // irregular, not a conveyor: the gaps between onsets vary
  const gaps = on.slice(1).map((x, i) => x - on[i]), mean = gaps.reduce((a, b) => a + b, 0) / gaps.length, sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length); assert(sd / mean > 0.4, "irregular intervals cv=" + (sd / mean).toFixed(2));
  // reduced motion: rare, soft, no restrikes, no strobe
  const R = run(REDUCED); const ro = R.st.map((s) => s.t0);
  assert(R.st.length > 3 && R.st.every((s) => s.reduced && s.gaps.every((x) => x < 0) && s.amp <= 0.5 && s.steps === 1), "reduced: soft single strokes " + R.st.length);
  for (let i = 1; i < ro.length; i++) assert(ro[i] - ro[i - 1] >= REDUCED.minGap - 1e-9, "reduced: rare");
  // nothing before the first seed; an idle clock starts nothing
  const idle = new LightningSim(g.nodes.length, links, amb, { strike() { throw new Error("no"); }, end() { throw new Error("no"); }, clear() {} }, RATES.high); idle.step(0.0); assert.equal(idle.active(), 0);
  // kick: a moved note's real links discharge soon
  const K = new LightningSim(g.nodes.length, links, [], { strike() {}, end() {}, clear() {} }, RATES.high); const n0 = links[0].src; K.kick(n0, 0); for (let k = 0; k <= 120; k++) K.step(k / 60);
  assert(K.log.some(([i]) => links[i].src === n0 || links[i].dst === n0), "kick strikes one of the note's links within 2 s");
});
t("reload watcher: no reload when unchanged; one disable/enable on change; no loop", async () => {
  let mt = 1000, now = 0; const calls: string[] = [];
  const app: any = { vault: { adapter: { stat: async () => ({ mtime: mt }) } }, plugins: { disablePlugin: async (id: string) => { calls.push("d:" + id); }, enablePlugin: async (id: string) => { calls.push("e:" + id); } } };
  const w = new SelfReloader({ app, id: "palace-atlas", file: "x/main.js", now: () => now, setTimer: () => 0, clearTimer: () => {} });
  await w.start(); for (let i = 0; i < 10; i++) { now += 2000; assert.equal(await w.tick(), false); } assert.deepEqual(calls, [], "unchanged mtime: no reload");
  mt = 2000; now += 2000; assert.equal(await w.tick(), false, "debounce: first sight does not reload"); now += 2000; assert.equal(await w.tick(), true); assert.deepEqual(calls, ["d:palace-atlas", "e:palace-atlas"]);
  for (let i = 0; i < 10; i++) { now += 2000; assert.equal(await w.tick(), false); } assert.equal(calls.length, 2, "no loop after reload");
  mt = 3000; now += 2000; await w.tick(); mt = 3001; now += 2000; assert.equal(await w.tick(), false, "still being written: restart debounce"); now += 2000; assert.equal(await w.tick(), true); assert.equal(calls.length, 4);
  // loop guard: rapid repeated changes are rate limited
  let n = 0; for (let i = 0; i < 40; i++) { mt += 1; now += 1100; await w.tick(); now += 1100; if (await w.tick()) n++; } assert(n <= 6, "reload storm capped: " + n);
  w.stop(); const before = calls.length; mt += 5; now += 9000; assert.equal(await w.tick(), false); assert.equal(calls.length, before, "stopped watcher never reloads");
});
t("data.json merge keeps positions, mode and unknown keys; quality validated and persisted", () => {
  const raw = { version: 1, mode: "universe", positions: { "topics/a.md": { brain: [1, 2, 3] } }, custom: 7, quality: "nonsense" };
  const d = mergeData(raw); assert.equal(d.quality, undefined); assert.equal(d.custom, 7); assert.equal(d.mode, "universe"); assert.deepEqual(d.positions, raw.positions);
  applyState(d, { mode: "brain", positions: d.positions, quality: "balanced" }); assert.equal(d.quality, "balanced"); assert.equal(d.custom, 7); assert.deepEqual(d.positions, raw.positions);
  applyState(d, { mode: "brain", positions: d.positions }); assert.equal(d.quality, "balanced", "state without quality does not erase it");
  assert.equal(mergeData(null).mode, "brain"); assert.equal(mergeData({ version: 1, quality: "low" }).quality, "low");
  assert(isQuality("high") && !isQuality("ultra"));
});
t("quality: auto default High on real GPU, Low on SwiftShader; Low has no bloom", () => {
  assert.equal(autoQuality("ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)"), "high");
  assert.equal(autoQuality("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)))"), "low");
  assert(QUALITY.high.bloom && QUALITY.balanced.bloom && !QUALITY.low.bloom && QUALITY.low.decorNeurons < QUALITY.balanced.decorNeurons && QUALITY.balanced.decorNeurons < QUALITY.high.decorNeurons);
});
t("palette: spectrum folder colours and black background", () => {
  assert.deepEqual(PALETTE.background.inner, [0, 0, 0]); for (const f of ["topics", "projects", "memories"] as const) assert.equal(PALETTE.impulse[f].length, 3);
});
t("diag whitelist includes the new keys and stays counts-only", () => {
  const d = buildDiag("0.3.0", buildGraph(demoSource(40)), null, 1700000000000);
  for (const k of ["fps", "quality", "decorNeurons", "noteNeuronSegments", "impulsesActive", "bloom", "assetLoaded", "assetTriangles"]) assert(k in d && (DIAG_KEYS as readonly string[]).includes(k), k);
  assert.deepEqual(Object.keys(d).sort(), [...DIAG_KEYS].sort()); const s = JSON.stringify(d); assert(!s.includes("/") && !s.includes(".md"));
});
t("brain GLB seam: parses named meshes, places notes INSIDE the volume just beneath the surface, deterministic", async () => {
  const glb = makeSynthGlb(30, 40), bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const a = await parseBrainGLB(bytes); for (const n of ["cortex_lh", "cortex_rh", "cerebellum", "brainstem"]) assert(a.meshes[n], n);
  assert(a.triangles > 4000); let cereb = 0, left = 0; const N = 120;
  for (let i = 0; i < N; i++) { const f = (["topics", "projects", "memories"] as const)[i % 3], p = `${f}/n${i}.md`, pl = a.placer(p, f), again = a.placer(p, f);
    assert.deepEqual(pl, again, "deterministic"); assert(a.contains(pl.pos), "inside the tissue " + p); assert(pl.depth > 0.01 && pl.depth < 0.08); if (pl.region === "cerebellum") cereb++; if (pl.pos[0] < 0) left++; }
  assert(cereb > 0 && cereb < N / 3, "some notes in the cerebellum: " + cereb); assert(left > N * 0.3 && left < N * 0.7, "both hemispheres");
  assert(!a.contains([3, 3, 3]), "outside point is outside"); void SYNTH_RADII; a.dispose();
});
t("SWC helpers: fragments are dropped, chains thinned to budget, parents stay valid", () => {
  const pts: number[][] = [[0, 0, 0, 5, -1, 1]]; for (let i = 1; i <= 200; i++) pts.push([i, 0, 0, 1, i - 1, 3]);   // one long chain
  for (let i = 201; i <= 260; i++) pts.push([0, i, 0, 1, -1, 3]);                                                    // disconnected fragments
  const c = connectedSwc(pts); assert.equal(c.length, 201, "fragments removed");
  const d = decimateSwc(c, 90); assert(d.length <= 90 && d.length >= 40, "thinned " + d.length);
  d.forEach((p, i) => { if (i > 0) assert(p[4] >= 0 && p[4] < i, "valid parent"); });
  const fan: number[][] = [[0, 0, 0, 5, -1, 1]]; for (let i = 1; i <= 300; i++) fan.push([i, i % 7, 0, 1, 0, 3]); // 300 leaves on the soma
  const f = decimateSwc(fan, 100); assert(f.length <= 100 && f.every((p, i) => i === 0 || p[4] === 0));
  // a cell with no soma-connected neurites is rejected and the note still gets a (procedural) neuron
  const broken: SwcCell = { id: "b", type: "pyramidal", points: [[0, 0, 0, 5, -1, 1], ...Array.from({ length: 60 }, (_, i) => [i, 1, 0, 1, -1, 3])] };
  assert.equal(makeMorph("topics/z.md", opts({ templates: [broken] })).source, "procedural");
});
t("spectrum palette: black background, orange front, magenta back, folder colours from the spectrum", () => {
  assert.deepEqual(PALETTE.impulse.topics, SPECTRUM[3]); assert.deepEqual(PALETTE.impulse.projects, SPECTRUM[0]); assert.deepEqual(PALETTE.impulse.memories, SPECTRUM[5]);
});
t("brain seam on the synthetic GLB: sparkle samples are on the surface and deterministic; relax keeps notes inside their hemisphere shell", async () => {
  const glb = makeSynthGlb(30, 40), a = await parseBrainGLB(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer);
  const s1 = a.surfaceSamples(500, 7), s2 = a.surfaceSamples(500, 7); assert.deepEqual(Array.from(s1.pos), Array.from(s2.pos)); assert(s1.pos.length === 1500 && s1.rand.length === 500);
  const g = buildGraph(demoSource(60)), pl = g.nodes.map((n) => a.placer(n.id, n.folder)), rl = a.relax(pl, g.edges.map((e) => [e.a, e.b] as [number, number]), g.nodes.map((n) => n.id)), rl2 = a.relax(pl, g.edges.map((e) => [e.a, e.b] as [number, number]), g.nodes.map((n) => n.id));
  assert.deepEqual(rl, rl2, "relax deterministic");
  const mean = (P: typeof pl) => g.edges.reduce((s, e) => s + Math.hypot(P[e.a].pos[0] - P[e.b].pos[0], P[e.a].pos[1] - P[e.b].pos[1], P[e.a].pos[2] - P[e.b].pos[2]), 0) / g.edges.length;
  assert(mean(rl) <= mean(pl) * 1.001, "linked notes pulled closer: " + mean(pl).toFixed(3) + " -> " + mean(rl).toFixed(3));
  rl.forEach((p, i) => { assert(a.contains(p.pos) || p.region === "cerebellum", "inside after relax"); assert(Math.sign(p.pos[0]) === Math.sign(pl[i].pos[0]) || Math.abs(p.pos[0]) < 0.02 || p.region === "cerebellum", "same hemisphere"); });
});
const REAL = "assets/brain.glb";
if (existsSync(REAL)) t("REAL brain.glb: names, triangle budget, notes inside volume 0.02-0.06 below pial, normals outward", async () => {
  const b = readFileSync(REAL), a = await parseBrainGLB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  for (const n of ["cortex_lh", "cortex_rh"]) assert(a.meshes[n], n); assert(a.triangles > 150000 && a.triangles < 400000, "tris " + a.triangles);
  let inside = 0, N = 24; for (let i = 0; i < N; i++) { const f = (["topics", "projects"] as const)[i % 2], p = a.placer(`${f}/r${i}.md`, f); if (a.contains(p.pos)) inside++; assert(p.depth >= 0.02 && p.depth <= 0.06 + 1e-9, "depth " + p.depth); assert(Math.abs(Math.hypot(...p.normal) - 1) < 1e-3); }
  assert.equal(inside, N, "all real-mesh notes sit inside the volume");
  const smp = a.surfaceSamples(2000, 3); let bad = 0; for (let i = 0; i < 2000; i++) { const q: [number, number, number] = [smp.pos[i * 3] - smp.nrm[i * 3] * 0.02, smp.pos[i * 3 + 1] - smp.nrm[i * 3 + 1] * 0.02, smp.pos[i * 3 + 2] - smp.nrm[i * 3 + 2] * 0.02]; if (i % 80 === 0 && !a.contains(q)) bad++; } assert(bad <= 1, "inward normals point into the tissue " + bad);
});
(async () => { for (const [n, fn] of tests) { try { await fn(); unit++; } catch (e) { console.error("FAIL unit:", n); throw e; } } console.log(`adapter/layout tests: PASS (+${unit} unit groups)`); })();
