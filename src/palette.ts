// Single place for the look of the neuron/impulse system. The style worker tunes THIS file (and the quality table).
// Colours are display-referred linear RGB triples (renderer output colour space is linear; see scene.ts).
import { Folder, V3 } from "./layout";

/** Mindcorpus-style spectral gradient running front (+Z, orange) to back (-Z, magenta). */
export const SPECTRUM: V3[] = [[1.0, 0.478, 0.239], [0.91, 0.824, 0.29], [0.357, 0.89, 0.49], [0.184, 0.827, 0.878], [0.31, 0.482, 1.0], [0.643, 0.42, 1.0], [0.949, 0.373, 0.816]];
/** Spectrum colour at t in [0,1] (0 = frontal pole, 1 = occipital/cerebellum end). */
export function spectrumAt(t: number): V3 {
  const x = Math.max(0, Math.min(1, t)) * (SPECTRUM.length - 1), i = Math.min(SPECTRUM.length - 2, Math.floor(x)), f = x - i, a = SPECTRUM[i], b = SPECTRUM[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
/** Brain-space z (front +1.2 .. back -1.2) to spectrum parameter. */
export const spectrumT = (z: number) => (1.2 - z) / 2.4;


export const PALETTE = {
  /** Impulse colour per SOURCE folder, from the spectrum: topics cyan #2FD3E0, projects orange #FF7A3D, memories violet #A46BFF. Bolt cores go white-hot at the return stroke (shader). */
  impulse: { topics: SPECTRUM[3], projects: SPECTRUM[0], memories: SPECTRUM[5] } as Record<Folder, V3>,
  /** Resting tint of a note neuron per folder (same hues, dimmer in the shader). */
  neuron: { topics: SPECTRUM[3], projects: SPECTRUM[0], memories: SPECTRUM[5] } as Record<Folder, V3>,
  decorPulse: [1, 1, 1] as V3,                    // (unused since 0.3.2: background neurons no longer carry pulses)
  myelin: [0.80, 0.92, 1.0] as V3,
  brain: { body: [0.30, 0.42, 0.85] as V3, rim: [0.60, 0.72, 1.0] as V3 },
  background: { inner: [0, 0, 0], mid: [0, 0, 0], outer: [0, 0, 0] } as Record<string, number[]>, // mindcorpus: pure black, lots of negative space
  /** shader tuning */
  pulseGain: 1.6, somaGlow: 0.9, fibreFaint: 0.1, decorAlpha: 0.2, restAlpha: 1.0,
  /** lightning: HDR gain of a bolt (bloom makes the thin channel read thick; Low has no bloom and no tone mapping, so it runs cooler and wider), ribbon width in CSS px */
  boltGain: 2.6, boltGainLow: 1.25, boltWidth: 2.6, boltWidthLow: 3.4, ambientGain: 1.0,
  exposure: 0.9,
  /** Note neurons must read as cells at the default camera: arbor size and soma size multipliers. */
  neuronScale: 1.5, somaScale: 0.6, decorScale: 0.8,
  brainBase: [0.32, 0.33, 0.54] as V3, brainRim: [0.30, 0.55, 1.0] as V3,
};
