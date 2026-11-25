// World generation with containment: soma placement, arbors, link routes and background cells. Pure functions (no three.js scene, no DOM) shared by
// the scene and the node tests, so the tests exercise exactly the generation code that ships.
import { Field, V3 } from "./field";
import { Folder, Placement, rng, fnv } from "./layout";
import { Morph, SwcCell, makeMorph, decorMorph, cellTypeFor, hubOf, reachFor, somaRadiusFor } from "./morph";
import { Router, Region3, RouteResult, clipMorph, containPoint } from "./contain";
import { orient } from "./impulse";
import { PALETTE } from "./palette";
import { Bolt, linkBolt, linkOpts, LinkOpts, emptyBolt } from "./lightning";

export interface WNode { id: string; folder: Folder; degree: number; }
export interface WEdge { a: number; b: number; }
export type SavedPos = Record<string, { brain?: V3; universe?: V3 }>;

/** Depth a soma needs below the surface: the margin, the fade band (so its own arbor starts at full intensity) and its radius. */
export const somaNeed = (f: Field, degree: number) => f.margin + f.fadeBand + somaRadiusFor(degree);

export interface SomaPlan { brainP: Float32Array; places: Placement[]; regions: Region3[]; projectedSaved: number; projectedPlaced: number; }
/** Soma positions: saved position (else the placed one), projected into the main interior core in memory only. Normals point to the nearest surface so apical dendrites end just under it. */
export function containSomas(f: Field, nodes: WNode[], places: Placement[], saved: SavedPos): SomaPlan {
  const n = nodes.length, brainP = new Float32Array(n * 3), out: Placement[] = [], regions: Region3[] = [], g: V3 = [0, 0, 0]; let projectedSaved = 0, projectedPlaced = 0;
  const cx = f.header.bridges.length ? (f.header.bridges[0].a[0] + f.header.bridges[0].b[0]) / 2 : 0;
  for (let i = 0; i < n; i++) {
    const pl = places[i], sv = saved[nodes[i].id]?.brain, start: V3 = sv && sv.length === 3 && sv.every(Number.isFinite) ? [sv[0], sv[1], sv[2]] : pl.pos;
    const r = containPoint(f, start, somaNeed(f, nodes[i].degree));
    if (r.moved) { if (sv) projectedSaved++; else projectedPlaced++; }
    brainP.set(r.p, i * 3);
    let nrm = pl.normal; f.grad(r.p[0], r.p[1], r.p[2], g); const toSurface: V3 = [-g[0], -g[1], -g[2]], has = !!(g[0] || g[1] || g[2]);
    if (has && (r.moved || sv || nrm[0] * toSurface[0] + nrm[1] * toSurface[1] + nrm[2] * toSurface[2] < 0.35)) nrm = toSurface;
    out.push({ pos: r.p, normal: nrm, depth: Math.max(0, f.depth(r.p[0], r.p[1], r.p[2])), region: pl.region });
    regions.push(pl.region === "cerebellum" ? "C" : r.p[0] < cx ? "L" : "R");
  }
  return { brainP, places: out, regions, projectedSaved, projectedPlaced };
}

export interface MorphOpts { carriers: number; radiusMul: number; templates?: SwcCell[]; }
/** Note neurons: generated from the (projected) soma frame, then every branch is clipped at the margin. */
export function makeNoteMorphs(f: Field, nodes: WNode[], places: Placement[], brainP: Float32Array, o: MorphOpts): { morphs: Morph[]; cut: number; dropped: number } {
  let cut = 0, dropped = 0;
  const morphs = nodes.map((nd, i) => {
    const m = makeMorph(nd.id, { type: cellTypeFor(nd.id, places[i].region, nd.degree), reach: reachFor(nd.degree), hub: hubOf(nd.degree), normal: places[i].normal,
      depth: Math.max(0.02, places[i].depth - f.margin), carriers: o.carriers, radiusMul: o.radiusMul, templates: o.templates, maxPoints: Math.max(60, Math.round((240 + 360 * hubOf(nd.degree)) * o.carriers)) });
    const c = clipMorph(m, [brainP[i * 3], brainP[i * 3 + 1], brainP[i * 3 + 2]], f); cut += c.cut; dropped += c.dropped; return c.morph;
  });
  return { morphs, cut, dropped };
}

export interface LinkPlan { edge: number; src: number; dst: number; term: number; tip: number; pts: V3[]; length: number; astar: boolean; ok: boolean; }
export const LINK_SEG = 24;
/** One route per real graph edge (same order as graph.edges), from the source axon terminal to a dendrite tip of the target, through the interior. */
export function planLinks(f: Field, router: Router, nodes: WNode[], edges: WEdge[], morphs: Morph[], brainP: Float32Array, regions: Region3[], seg = LINK_SEG): LinkPlan[] {
  const outN = new Int32Array(nodes.length), inN = new Int32Array(nodes.length), good = f.margin + f.fadeBand, plans: LinkPlan[] = [];
  const pt = (m: Morph, k: number, who: number): V3 => [brainP[who * 3] + m.pos[k * 3], brainP[who * 3 + 1] + m.pos[k * 3 + 1], brainP[who * 3 + 2] + m.pos[k * 3 + 2]];
  const pick = (m: Morph, list: number[], who: number, counter: Int32Array): number => { // prefer attachment points that are fully lit (deeper than the fade band)
    if (!list.length) return 0; const deep = list.filter((k) => { const p = pt(m, k, who); return f.depth(p[0], p[1], p[2]) >= good; }), use = deep.length ? deep : list; return use[counter[who]++ % use.length];
  };
  edges.forEach((e, ei) => {
    const aSrc = orient(nodes[e.a].id, nodes[e.b].id), src = aSrc ? e.a : e.b, dst = aSrc ? e.b : e.a, ms = morphs[src], md = morphs[dst];
    const term = pick(ms, ms.axonTerminals, src, outN), tip = pick(md, md.dendTips, dst, inN), p0 = pt(ms, term, src), p1 = pt(md, tip, dst);
    const r: RouteResult = router.route(p0, p1, regions[src], regions[dst]), pts = router.coarse(r, seg);
    plans.push({ edge: ei, src, dst, term, tip, pts, length: r.length, astar: r.astar, ok: r.ok });
  });
  return plans;
}

/** Soma -> axon terminal (chainA) and dendrite tip -> soma (chainB) of a planned link: the arbor parts of its lightning bolt (clipped, verified arbors). */
export function linkChains(pl: LinkPlan, morphs: Morph[], brainP: Float32Array): { chainA: V3[]; chainB: V3[] } {
  const chain = (who: number, k: number): V3[] => { const m = morphs[who], o: V3[] = []; for (let i = k; i >= 0; i = m.parent[i]) { o.push([brainP[who * 3] + m.pos[i * 3], brainP[who * 3 + 1] + m.pos[i * 3 + 1], brainP[who * 3 + 2] + m.pos[i * 3 + 2]]); if (i === 0) break; } return o; };
  return { chainA: chain(pl.src, pl.term).reverse(), chainB: chain(pl.dst, pl.tip) };
}
/** Link-bolt detail from the vault-size complexity (complexityFor) and the quality's bolt detail (the same numbers the scene uses). */
export const linkBoltOpts = (complexity: number, boltDetail: number, box?: { min: V3; max: V3 }): LinkOpts => ({ ...linkOpts(complexity * boltDetail), box });
/** The lightning bolt of one planned real link, exactly as the scene builds it (seeded by the two note ids, so it is stable when notes are added).
 *  A plan that is not ok gets an empty bolt that can never strike. */
export function makeLinkBolt(f: Field, nodes: WNode[], pl: LinkPlan, morphs: Morph[], brainP: Float32Array, o: LinkOpts): Bolt {
  if (!pl.ok || pl.pts.length < 2) return emptyBolt(pl.src, pl.dst, pl.edge);
  const { chainA, chainB } = linkChains(pl, morphs, brainP);
  return linkBolt(f, { src: pl.src, dst: pl.dst, edge: pl.edge, chainA, route: pl.pts, chainB }, o, fnv("lb:" + nodes[pl.src].id + "|" + nodes[pl.dst].id));
}

export interface DecorCell { morph: Morph; pos: V3; rand: number; }
/** Background cells: inside the tissue, inset past the margin, arbors clipped. `tissue` returns a point beneath the surface and its outward normal. */
export function makeDecor(f: Field, count: number, carriers: number, tissue: (r: () => number) => { pos: V3; normal: V3 }): { cells: DecorCell[]; cut: number; dropped: number } {
  const cells: DecorCell[] = []; let cut = 0, dropped = 0;
  for (let k = 0; k < count; k++) {
    const r = rng(fnv("decor:" + k)), t = tissue(r), reach = (0.05 + 0.04 * r()) * PALETTE.decorScale;
    const c = containPoint(f, t.pos, f.margin + f.fadeBand + 0.2 * reach), g: V3 = [0, 0, 0]; f.grad(c.p[0], c.p[1], c.p[2], g);
    const normal: V3 = c.moved && (g[0] || g[1] || g[2]) ? [-g[0], -g[1], -g[2]] : t.normal;
    const m = decorMorph(String(k), reach, normal, Math.max(6, Math.round(11 * carriers))), cl = clipMorph(m, c.p, f); cut += cl.cut; dropped += cl.dropped;
    cells.push({ morph: cl.morph, pos: c.p, rand: r() });
  }
  return { cells, cut, dropped };
}
