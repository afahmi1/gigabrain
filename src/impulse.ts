// Lightning scheduler (CPU side, tiny). It only decides WHEN a discharge strikes and WHICH precomputed channel carries it; the bolts themselves are
// drawn on the GPU from a few per-strike numbers and a clock uniform (bolts.ts). Nothing is rebuilt per frame.
//  - LINK strikes ride a channel that exists in graph.edges (one oriented link bolt per real edge); the target note may discharge on in turn
//    (seeded cascade through the real graph). Hovering/selecting a note biases strikes toward its own links.
//  - AMBIENT strikes are decorative and stratified: bins (hemisphere x lobe, cerebellum, brainstem) are dealt from a shuffled deck whose card counts
//    follow cortical area (flattened), so every lobe of both hemispheres flashes in every cycle; within the bin the admissible channel farthest from
//    the recent strikes wins (Mitchell's best candidate). The flashes wander over the whole cerebrum instead of clustering where the notes are.
// Timing of one strike (Kim & Lin): stepped leader 60-150 ms, near-instant return stroke, 1-3 restrikes 30-60 ms apart (all within ~180 ms),
// exponential decay (tau 35-70 ms; dark again 150-300 ms after the return stroke) and a faint afterglow. Intervals are irregular (exponential).
// Photosensitivity (WCAG 2.3.1 spirit): at most `capPerSec` strike onsets and at most 3 large ("screen-significant") strikes in ANY 1 s window, a
// minimum gap between onsets so flashes never synchronise, per-channel refractory, and no two strikes over the same coarse region at once.
// Reduced motion: rare (<= 1 strike per ~1.6 s), soft (slow rise and fade, no white-hot core), no restrikes, no stepped flicker.
import { rng, fnv } from "./layout";

export interface Channel { src: number; dst: number; edge: number; big: boolean; cells: ArrayLike<number>; center?: ArrayLike<number>; }
export interface AmbientChannel { bin: number; big: boolean; cells: ArrayLike<number>; center?: ArrayLike<number>; }
export const KIND_LINK = 0, KIND_AMBIENT = 1;
/** Everything the GPU needs to draw one strike of one precomputed bolt. Times in pulse-clock seconds. */
export interface Strike {
  kind: number; bolt: number; t0: number;
  leader: number;            // stepped-leader duration (s); the return stroke happens at t0 + leader
  steps: number;             // leader steps (visible jumps of the tip)
  gaps: [number, number, number];  // restrike offsets after the return stroke (s), -1 = none
  amps: [number, number, number];  // restrike amplitudes
  tau: number;               // decay of the continuing current after each stroke (s)
  amp: number; seed: number; keep: number;  // overall amplitude, per-strike random, fraction of forks shown this time
  life: number;              // after t0 + life the strike is invisible and retired
  reduced: boolean;
}
export interface StrikeSink {
  strike(s: Strike): void;                 // a strike starts (write its parameters for the GPU)
  end(kind: number, bolt: number): void;   // its envelope is over (stop drawing the channel)
  clear(): void;                           // drop everything in flight
  allowed?(kind: number, bolt: number): boolean; // e.g. an edit-drag preview holds a cell's channels
}
export interface Rates { link: number; ambient: number; cascade: number; capPerSec: number; bigPerSec: number; minGap: number; refractory: number; reduced: boolean; }
export const RATES: Record<"high" | "balanced" | "low", Rates> = {
  high: { link: 1.05, ambient: 3.4, cascade: 0.3, capPerSec: 6, bigPerSec: 3, minGap: 0.07, refractory: 2.0, reduced: false },
  balanced: { link: 0.95, ambient: 2.9, cascade: 0.3, capPerSec: 5, bigPerSec: 3, minGap: 0.08, refractory: 2.0, reduced: false },
  low: { link: 0.85, ambient: 2.4, cascade: 0.25, capPerSec: 4, bigPerSec: 3, minGap: 0.09, refractory: 2.0, reduced: false },
};
export const REDUCED: Rates = { link: 0.3, ambient: 0.32, cascade: 0, capPerSec: 1, bigPerSec: 1, minGap: 1.6, refractory: 6, reduced: true };
/** Coarse occupancy cells (0.12 world units) of a bolt: two strikes never light the same region at once, so every lit pixel goes dark again. */
export const CELL = 0.12;
export const cellOf = (x: number, y: number, z: number) => ((Math.floor(x / CELL) + 32) * 64 + (Math.floor(y / CELL) + 32)) * 64 + (Math.floor(z / CELL) + 32);
export function cellsOf(pos: ArrayLike<number>, n: number): number[] { const s = new Set<number>(); for (let i = 0; i < n; i++) s.add(cellOf(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])); return [...s]; }

const enum Req { Link, Ambient, Cascade, Kick }
interface Pending { t: number; type: Req; neuron: number; deadline: number; }
interface Flight { kind: number; bolt: number; end: number; }

export class LightningSim {
  readonly out: number[][];          // link channels leaving each note
  readonly inc: number[][];          // link channels touching each note (either end)
  readonly last: Float64Array;       // last discharge time per note (as a source)
  /** Every link strike in order: [link index, onset time]. Test hook (bounded). */
  readonly log: [number, number][] = [];
  /** Every ambient strike: [ambient index, onset time] (bounded). */
  readonly ambientLog: [number, number][] = [];
  focus = -1;
  /** Largest number of strike onsets observed in any 1 s window (photosensitivity evidence), total and large ones. */
  rateMax = 0; bigRateMax = 0; strikes = 0; restrikes = 0;
  private r: () => number; private pending: Pending[] = []; private flight: Flight[] = [];
  private onsets: number[] = []; private bigOnsets: number[] = []; private lastOnset = -1e9;
  private nextLink = 0.3; private nextAmb = 0.5;
  private linkLast: Float64Array; private ambLast: Float64Array; private busy = new Map<number, number>(); private binLast: Float64Array; private binW: number[];
  private seedable: number[] = []; private recent: number[][] = []; private deck: number[] = [];
  constructor(readonly nNeurons: number, readonly links: Channel[], readonly ambient: AmbientChannel[], private sink: StrikeSink, public rates: Rates = RATES.high, seed = 0x51ac, binWeights: number[] = []) {
    this.r = rng(seed); this.out = Array.from({ length: nNeurons }, () => []); this.inc = Array.from({ length: nNeurons }, () => []);
    links.forEach((l, i) => { this.out[l.src].push(i); this.inc[l.src].push(i); if (l.dst !== l.src) this.inc[l.dst].push(i); });
    for (let i = 0; i < nNeurons; i++) if (this.out[i].length) this.seedable.push(i);
    this.last = new Float64Array(nNeurons).fill(-1e9); this.linkLast = new Float64Array(links.length).fill(-1e9); this.ambLast = new Float64Array(ambient.length).fill(-1e9);
    const nb = ambient.reduce((m, a) => Math.max(m, a.bin + 1), 0); this.binLast = new Float64Array(nb).fill(-1e9);
    this.binW = Array.from({ length: nb }, (_, b) => (binWeights[b] ?? 1) * (ambient.some((a) => a.bin === b) ? 1 : 0));
    this.byBin = Array.from({ length: nb }, () => []); ambient.forEach((a, i) => this.byBin[a.bin].push(i));
    this.nextLink = 0.25 + this.gap(rates.link) * 0.5; this.nextAmb = 0.35 + this.gap(rates.ambient) * 0.5;
  }
  private byBin: number[][] = [];
  /** One shuffled cycle of ambient bins: card counts proportional to the bin weights (the smallest populated bin gets 2 cards, rare bins at least a chance). */
  private newDeck(): number[] {
    const w = this.binW, base = Math.min(...w.filter((x) => x > 0.5)) || 1, deck: number[] = [];
    w.forEach((x, b) => { if (x <= 0) return; const c = (2 * x) / base, n = Math.floor(c) + (this.r() < c - Math.floor(c) ? 1 : 0); for (let k = 0; k < n; k++) deck.push(b); });
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck;
  }
  /** Irregular interval: exponential with the given mean rate, clipped so it is neither a burst nor a lull. */
  private gap(rate: number) { if (rate <= 0) return 1e9; const m = 1 / rate; return Math.min(4 * m, Math.max(0.15 * m, -Math.log(1 - this.r() * 0.999) * m)); }
  private count(list: number[], t: number) { let n = 0; for (const x of list) if (x > t - 1 && x <= t) n++; return n; }
  private free(cells: ArrayLike<number>, t: number) { for (let i = 0; i < cells.length; i++) if ((this.busy.get(cells[i]) ?? -1e9) > t) return false; return true; }
  private okLink(i: number, t: number) { const l = this.links[i]; return t - this.linkLast[i] >= this.rates.refractory && this.free(l.cells, t) && (this.sink.allowed?.(KIND_LINK, i) ?? true); }
  private okAmb(i: number, t: number) { return t - this.ambLast[i] >= this.rates.refractory && this.free(this.ambient[i].cells, t) && (this.sink.allowed?.(KIND_AMBIENT, i) ?? true); }
  private pick<T>(arr: T[]): T { return arr[Math.floor(this.r() * arr.length)]; }
  /** Choose a channel for a request at time t, or -1. */
  private choose(p: Pending, t: number): [number, number] {
    if (p.type === Req.Ambient) {
      if (!this.ambient.length) return [-1, -1];
      // bins by cortical area, damped right after they flashed: strikes wander over the whole cerebrum
      if (!this.deck.length) this.deck = this.newDeck();
      let found: number[] = [];
      for (let c = 0; c < Math.min(6, this.deck.length) && !found.length; c++) { // the next card whose bin has an admissible channel (busy bins wait for later)
        const cand = this.byBin[this.deck[c]] ?? []; found = [];
        for (let k = 0; k < 8 && found.length < 4 && cand.length; k++) { const i = this.pick(cand); if (!found.includes(i) && this.okAmb(i, t)) found.push(i); }
        if (found.length) this.deck.splice(c, 1);
      }
      if (!found.length) return [-1, -1];
      // best candidate: the channel farthest from the last strikes (blue noise over space and time)
      let best = found[0], bd = -1;
      for (const i of found) { const c = this.ambient[i].center; let d = 1e9; if (c) for (const q of this.recent) d = Math.min(d, Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2])); d += 0.02 * this.r(); if (d > bd) { bd = d; best = i; } }
      return [KIND_AMBIENT, best];
    }
    if (!this.links.length) return [-1, -1];
    let pool: number[] = [];
    if (p.type === Req.Kick) pool = this.inc[p.neuron] ?? [];
    else if (p.type === Req.Cascade) { if (t - this.last[p.neuron] < this.rates.refractory * 0.45) return [-1, -1]; pool = this.out[p.neuron] ?? []; }
    else if (this.focus >= 0 && this.focus < this.nNeurons && this.inc[this.focus].length && this.r() < 0.6) pool = this.inc[this.focus]; // bias toward the hovered note's real links
    for (let tries = 0; tries < 8; tries++) {
      let i: number;
      if (pool.length) i = this.pick(pool);
      else { if (!this.seedable.length) return [-1, -1]; const n = this.pick(this.seedable); if (t - this.last[n] < this.rates.refractory * 0.45) continue; i = this.pick(this.out[n]); }
      if (this.okLink(i, t)) return [KIND_LINK, i];
    }
    return [-1, -1];
  }
  private params(kind: number, bolt: number, t: number): Strike {
    const r = this.r, big = kind === KIND_LINK ? this.links[bolt].big : this.ambient[bolt].big, seed = r();
    if (this.rates.reduced) {
      const leader = 0.25, tau = 0.35; return { kind, bolt, t0: t, leader, steps: 1, gaps: [-1, -1, -1], amps: [0, 0, 0], tau, amp: 0.45, seed, keep: 0.5, life: leader + 2.2, reduced: true };
    }
    const leader = (0.06 + 0.09 * r()) * (big ? 1 : 0.85), u = r(), n = big ? (u < 0.4 ? 1 : u < 0.78 ? 2 : 3) : (u < 0.6 ? 1 : 2);
    const g1 = 0.03 + 0.03 * r(), g2 = g1 + 0.03 + 0.03 * r(), g3 = g2 + 0.03 + 0.03 * r(), k = 0.85 + 0.15 * r();
    const gaps: [number, number, number] = [g1, n >= 2 ? g2 : -1, n >= 3 ? g3 : -1], amps: [number, number, number] = [0.85 * k, 0.68 * k, 0.52 * k];
    const tau = 0.035 + 0.035 * r(), lastG = n >= 3 ? g3 : n >= 2 ? g2 : g1;
    this.restrikes += n;
    return { kind, bolt, t0: t, leader, steps: 5 + Math.floor(5 * r()), gaps, amps, tau, amp: kind === KIND_LINK ? 1 : 0.92, seed, keep: 0.55 + 0.4 * r(), life: leader + lastG + 7 * tau + 0.55, reduced: false };
  }
  private launch(kind: number, bolt: number, t: number): Strike {
    const s = this.params(kind, bolt, t), ch = kind === KIND_LINK ? this.links[bolt] : this.ambient[bolt];
    this.sink.strike(s); this.strikes++; if (ch.center) { this.recent.push([ch.center[0], ch.center[1], ch.center[2]]); if (this.recent.length > 12) this.recent.shift(); }
    // the region is reserved until this strike is dark (only the faint afterglow remains), so the next flash there is a separate flash
    const dark = s.reduced ? t + s.life : t + s.leader + Math.max(0, ...s.gaps) + 4 * s.tau + 0.12;
    for (let i = 0; i < ch.cells.length; i++) this.busy.set(ch.cells[i], dark);
    this.flight.push({ kind, bolt, end: t + s.life });
    this.onsets.push(t); if (ch.big) this.bigOnsets.push(t); this.lastOnset = t;
    this.rateMax = Math.max(this.rateMax, this.count(this.onsets, t)); this.bigRateMax = Math.max(this.bigRateMax, this.count(this.bigOnsets, t));
    if (kind === KIND_LINK) {
      const l = this.links[bolt]; this.linkLast[bolt] = t; this.last[l.src] = t; this.log.push([bolt, t]); if (this.log.length > 4096) this.log.shift();
      if (this.rates.cascade > 0 && ((fnv("c:" + bolt + ":" + this.strikes) >>> 0) % 1000) / 1000 < this.rates.cascade) this.pending.push({ t: t + s.leader + 0.25 + 0.4 * this.r(), type: Req.Cascade, neuron: l.dst, deadline: t + s.leader + 1.3 });
    } else { this.ambLast[bolt] = t; this.binLast[this.ambient[bolt].bin] = t; this.ambientLog.push([bolt, t]); if (this.ambientLog.length > 4096) this.ambientLog.shift(); }
    return s;
  }
  /** Demo/test hook: start a strike on one channel at time t through the normal parameter draw and sink, bypassing the flash budget. Never used by the UI. */
  strikeNow(kind: number, bolt: number, t: number): Strike { return this.launch(kind, bolt, t); }
  /** Advance to `now` (pulse-clock seconds, frozen while the gate is closed). Returns the number of strikes started. */
  step(now: number): number {
    let started = 0;
    for (let i = this.flight.length - 1; i >= 0; i--) if (this.flight[i].end <= now) { const f = this.flight[i]; this.flight.splice(i, 1); this.sink.end(f.kind, f.bolt); }
    if (this.links.length) while (this.nextLink <= now) { this.pending.push({ t: this.nextLink, type: Req.Link, neuron: -1, deadline: this.nextLink + 0.6 }); this.nextLink += this.gap(this.rates.link); }
    if (this.ambient.length) while (this.nextAmb <= now) { this.pending.push({ t: this.nextAmb, type: Req.Ambient, neuron: -1, deadline: this.nextAmb + 0.6 }); this.nextAmb += this.gap(this.rates.ambient); }
    if (this.pending.length > 64) this.pending.splice(0, this.pending.length - 64);
    this.pending.sort((a, b) => a.t - b.t);
    // real-link discharges (seeds, cascades, kicks) go first; decorative ambient strikes may not take the last slot of the flash budget (or the last
    // large-flash slot) while a link discharge is still waiting, so meaning never starves behind decoration
    for (const ambientPass of [false, true]) {
      const reserve = ambientPass && this.pending.some((p) => p.type !== Req.Ambient && p.t <= now && now <= p.deadline) ? 1 : 0;
      for (let k = 0; k < this.pending.length; k++) {
        const p = this.pending[k]; if (p.t > now) break;
        if ((p.type === Req.Ambient) !== ambientPass) continue;
        if (now > p.deadline) { this.pending.splice(k--, 1); continue; }
        const t = Math.max(p.t, this.lastOnset + this.rates.minGap); if (t > now) break;              // never two onsets closer than minGap
        if (this.count(this.onsets, t) >= this.rates.capPerSec - reserve) break;                       // global flash budget for this 1 s window
        const [kind, bolt] = this.choose(p, t); if (kind < 0) { if (p.type === Req.Kick) continue; this.pending.splice(k--, 1); continue; }
        const big = kind === KIND_LINK ? this.links[bolt].big : this.ambient[bolt].big;
        if (big && this.count(this.bigOnsets, t) >= this.rates.bigPerSec - reserve) continue;          // at most 3 large flashes per second; small ones may still go
        this.pending.splice(k--, 1); this.launch(kind, bolt, t); started++;
      }
    }
    if (this.onsets.length > 64) this.onsets = this.onsets.filter((x) => x > now - 2); if (this.bigOnsets.length > 64) this.bigOnsets = this.bigOnsets.filter((x) => x > now - 2);
    return started;
  }
  /** Ask for a discharge on one of note n's real links soon (e.g. right after an edit-drag re-routed them). */
  kick(n: number, now: number) { if (n >= 0 && n < this.nNeurons && this.inc[n].length) this.pending.push({ t: now + 0.25, type: Req.Kick, neuron: n, deadline: now + 4 }); }
  /** Drop every queued/in-flight strike and restart seeding after `now` (used when emission is gated off). */
  reset(now: number) {
    this.pending = []; this.flight = []; this.sink.clear(); this.busy.clear(); this.onsets = []; this.bigOnsets = []; this.lastOnset = -1e9; this.recent = []; this.deck = [];
    this.nextLink = now + 0.25 + this.gap(this.rates.link) * 0.5; this.nextAmb = now + 0.35 + this.gap(this.rates.ambient) * 0.5;
    this.last.fill(-1e9); this.linkLast.fill(-1e9); this.ambLast.fill(-1e9); this.binLast.fill(-1e9);
  }
  /** Strikes currently visible (leader, strokes, decay or afterglow), link and ambient. */
  active(): number { return this.flight.length; }
  activeOf(kind: number): number { return this.flight.filter((f) => f.kind === kind).length; }
  /** Oriented link channels: exactly one (src,dst) per real edge. */
  paths(): [number, number][] { return this.links.map((l) => [l.src, l.dst]); }
  queued() { return this.pending.length; }
}

/** Orientation of an undirected edge, seeded by the two note paths so it is stable when notes are added. */
export function orient(aId: string, bId: string): boolean { return (fnv("o:" + aId + "|" + bId) & 1) === 0; }
