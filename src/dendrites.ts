// DECORATIVE neuron glyph branches. Ornament only: they never connect two notes, are never hit-tested and are never counted as links.
// Simplified space colonization (Runions et al. 2007, https://doi.org/10.2312/NPH/NPH07/063-070): seeded attractor points
// pull a small tree of branches out of the soma. Fully deterministic per note path.
import { fnv, rng, V3 } from "./layout";

export interface Dendrite { segs: number[]; /* 6 floats per segment: soma-relative start, end */ ts: number[]; /* 0..1 distance from soma per segment end */ }
const len = (v: V3) => Math.hypot(v[0], v[1], v[2]);
export function growDendrites(id: string, reach: number): Dendrite {
  const r = rng(fnv("d:" + id));
  const unit = (): V3 => { const z = 2 * r() - 1, a = r() * 2 * Math.PI, s = Math.sqrt(1 - z * z); return [s * Math.cos(a), s * Math.sin(a), z]; };
  const step = reach * 0.36, kill = step * 0.8, infl = reach * 1.3;
  const attr: V3[] = [];
  for (let i = 0; i < 12; i++) { const u = unit(), m = reach * (0.5 + 0.5 * Math.cbrt(r())); attr.push([u[0] * m, u[1] * m, u[2] * m]); }
  const tree: V3[] = [[0, 0, 0]];
  const segs: number[] = [], ts: number[] = [];
  const add = (from: V3, to: V3) => { segs.push(...from, ...to); ts.push(Math.min(1, len(to) / reach)); tree.push(to); };
  const roots = 3 + Math.floor(r() * 2);
  for (let i = 0; i < roots; i++) { const u = unit(); add([0, 0, 0], [u[0] * step * 0.7, u[1] * step * 0.7, u[2] * step * 0.7]); }
  for (let it = 0; it < 3 && attr.length; it++) {
    const acc = new Map<number, V3>();
    for (const a of attr) {
      let bi = -1, bd = infl;
      for (let k = 0; k < tree.length; k++) { const d = Math.hypot(a[0] - tree[k][0], a[1] - tree[k][1], a[2] - tree[k][2]); if (d < bd) { bd = d; bi = k; } }
      if (bi < 0) continue;
      const t = tree[bi], s = acc.get(bi) ?? [0, 0, 0];
      s[0] += (a[0] - t[0]) / bd; s[1] += (a[1] - t[1]) / bd; s[2] += (a[2] - t[2]) / bd; acc.set(bi, s);
    }
    if (!acc.size) break;
    for (const [k, s] of [...acc.entries()].sort((x, y) => x[0] - y[0])) {
      const j = unit(), v: V3 = [s[0] + 0.25 * j[0], s[1] + 0.25 * j[1], s[2] + 0.25 * j[2]], l = len(v) || 1, t = tree[k];
      let c: V3 = [t[0] + (v[0] / l) * step, t[1] + (v[1] / l) * step, t[2] + (v[2] / l) * step];
      const cl = len(c); if (cl > reach) c = [c[0] * reach / cl, c[1] * reach / cl, c[2] * reach / cl];
      add(t, c);
    }
    for (let i = attr.length - 1; i >= 0; i--) if (tree.some((t) => Math.hypot(attr[i][0] - t[0], attr[i][1] - t[1], attr[i][2] - t[2]) < kill)) attr.splice(i, 1);
  }
  return { segs, ts };
}
export const dendriteReach = (degree: number) => 0.055 + 0.035 * Math.min(1, Math.sqrt(degree) / 3);
