// Generates assets/morphologies.json: ORIGINAL procedural neuron morphologies (no third-party reconstructions).
// Algorithm (independent of src/morph.ts, which uses MST growth): stochastic tip growth. Each growing tip walks in short
// steps with persistence, a cell-type tropism and a little noise; it bifurcates with a probability that falls with path
// distance and terminates past a per-type extent. Radii taper by a Rall-like rule at every branch point.
// Output points use the SWC column order [x, y, z, radius, parentIndex, swcType] (micrometres, soma at origin,
// swcType 1 soma, 2 axon, 3 basal dendrite, 4 apical dendrite). Fully deterministic: `node scripts/build-morphologies.mjs`.
// The output is original work covered by this repository's MIT licence (see assets/LICENSES.md).
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] || "assets/morphologies.json";
const PER_TYPE = 6, MAX_POINTS = 1400;

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const gauss = (r) => { let u = 0; for (let i = 0; i < 4; i++) u += r(); return (u - 2) / 0.577; };
const randDir = (r) => norm([gauss(r), gauss(r), gauss(r)]);

// Cell-type programmes. `stems`: initial neurites [swcType, direction fn, extent µm, bifurcation rate, start radius].
const TYPES = {
  pyramidal: (r) => ({
    soma: 9,
    stems: [
      [4, () => norm([0.08 * gauss(r), 1, 0.08 * gauss(r)]), 480 + 120 * r(), 0.030, 2.6, { tropism: [0, 1, 0], tw: 0.16, tuftAt: 0.62 }],
      ...Array.from({ length: 4 + Math.floor(r() * 3) }, () => [3, () => norm([gauss(r), -0.35 + 0.5 * gauss(r), gauss(r)]), 230 + 90 * r(), 0.036, 1.4, { tropism: null, tw: 0 }]),
      [2, () => norm([0.1 * gauss(r), -1, 0.1 * gauss(r)]), 360 + 120 * r(), 0.012, 0.9, { tropism: [0, -1, 0], tw: 0.1 }],
    ],
  }),
  stellate: (r) => ({
    soma: 7,
    stems: [
      ...Array.from({ length: 6 + Math.floor(r() * 3) }, () => [3, () => randDir(r), 170 + 60 * r(), 0.032, 1.2, { tropism: null, tw: 0 }]),
      [2, () => randDir(r), 260 + 80 * r(), 0.03, 0.8, { tropism: null, tw: 0, wiggle: 0.5 }],
    ],
  }),
  purkinje: (r) => ({
    soma: 12, planar: true,
    stems: [
      ...Array.from({ length: 1 + Math.floor(r() * 2) }, (_, i) => [3, () => norm([0.35 * (i ? 1 : -1) + 0.15 * gauss(r), 1, 0]), 230 + 60 * r(), 0.16, 3.0, { tropism: [0, 1, 0], tw: 0.12, fan: true }]),
      [2, () => [0, -1, 0], 300 + 80 * r(), 0.006, 1.0, { tropism: [0, -1, 0], tw: 0.25 }],
    ],
  }),
  interneuron: (r) => ({
    soma: 7,
    stems: [
      ...Array.from({ length: 3 + Math.floor(r() * 3) }, () => [3, () => randDir(r), 130 + 50 * r(), 0.028, 1.0, { tropism: null, tw: 0 }]),
      [2, () => norm([gauss(r), 0.6 * gauss(r), gauss(r)]), 230 + 60 * r(), 0.06, 0.6, { tropism: null, tw: 0, wiggle: 0.7 }],
    ],
  }),
};

function grow(type, seed) {
  const r = mulberry32(seed), prog = TYPES[type](r), pts = [[0, 0, 0, prog.soma, -1, 1]];
  const budgetPer = Math.floor((MAX_POINTS - 1) / prog.stems.length);
  for (const [swc, dirFn, extent, bif, rad0, opt] of prog.stems) {
    const start = pts.length, step = Math.max(5, extent / 42);
    let d0 = dirFn(); if (prog.planar) d0 = norm([d0[0], d0[1], 0.04 * gauss(r)]);
    const tips = [{ p: add([0, 0, 0], d0, prog.soma), d: d0, parent: 0, rad: rad0, s: 0, depth: 0 }];
    while (tips.length && pts.length - start < budgetPer) {
      const t = tips.shift();
      for (let k = 0; k < 400 && pts.length - start < budgetPer; k++) {
        // persistence + tropism + noise; purkinje stays in its sagittal plane
        let nd = add(t.d, randDir(r), opt.wiggle ?? 0.22);
        if (opt.tropism) nd = add(nd, opt.tropism, opt.tw * (opt.tuftAt && t.s / extent > opt.tuftAt ? 0.2 : 1)); // the apical tuft spreads out
        if (prog.planar) nd[2] *= 0.15;
        t.d = norm(nd); t.p = add(t.p, t.d, step); t.s += step;
        const dist = Math.hypot(t.p[0], t.p[1], t.p[2]);
        pts.push([t.p[0], t.p[1], t.p[2], Math.max(0.25, t.rad), t.parent, swc]); t.parent = pts.length - 1;
        if (dist > extent || t.s > extent * 1.6) break;                       // past the envelope: terminate
        const frac = t.s / extent;
        const tuft = opt.tuftAt && frac > opt.tuftAt && t.depth < 6 ? 0.22 : 0;   // apical tuft near the pia
        const p = (bif + tuft) * (opt.tuftAt && frac < opt.tuftAt ? 0.25 : 1) * Math.max(0.15, 1 - 0.7 * frac) * (opt.fan ? 1 + t.depth * 0.08 : 1);
        if (r() < p && t.depth < 12) {
          // Rall 3/2 rule split of the parent radius; daughters diverge 25-55 deg
          const a = (0.45 + 0.5 * r()) * (tuft ? 1.8 : 1), rr = t.rad * 0.79;
          const side = prog.planar ? norm([t.d[1], -t.d[0], 0]) : norm([gauss(r), gauss(r), gauss(r)]);
          tips.push({ p: t.p.slice(), d: norm(add(t.d, side, a)), parent: t.parent, rad: rr, s: t.s, depth: t.depth + 1 });
          t.d = norm(add(t.d, side, -a * 0.6)); t.rad = rr; t.depth++;
        } else t.rad *= 0.992;
      }
    }
  }
  return pts.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1), +p[3].toFixed(2), p[4], p[5]]);
}

const cells = [];
for (const [ti, type] of Object.keys(TYPES).entries()) for (let i = 0; i < PER_TYPE; i++) {
  const seed = 0x9e3779b1 ^ (ti * 7919 + i * 104729 + 17);
  cells.push({ id: `pa-proc-${type}-${String(i + 1).padStart(2, "0")}`, type, source: `procedural: scripts/build-morphologies.mjs seed ${seed >>> 0}`, license: "MIT (original, Palace Atlas contributors)", points: grow(type, seed) });
}
// self-check: SWC invariants (soma first, parent < child, every point connected)
for (const c of cells) {
  if (c.points[0][5] !== 1 || c.points[0][4] !== -1) throw new Error(c.id + ": soma must be point 0");
  c.points.forEach((p, i) => { if (i && !(p[4] >= 0 && p[4] < i)) throw new Error(`${c.id}: bad parent at ${i}`); });
  if (c.points.length < 200) throw new Error(`${c.id}: too few points (${c.points.length})`);
}
mkdirSync("assets", { recursive: true });
writeFileSync(OUT, JSON.stringify({ format: "swc-columns x,y,z,radius,parent,type (um)", generator: "scripts/build-morphologies.mjs", license: "MIT", cells }));
console.log(`wrote ${OUT}: ${cells.length} cells, ${cells.reduce((s, c) => s + c.points.length, 0)} points`);
for (const c of cells) console.log(" ", c.id, c.points.length);
