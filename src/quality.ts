// Render quality levels. One table drives bloom, neuron geometry LOD and decor density.
export type Quality = "high" | "balanced" | "low";
export const QUALITIES: Quality[] = ["high", "balanced", "low"];
export const QUALITY_LABEL: Record<Quality, string> = { high: "High", balanced: "Balanced", low: "Low" };

export interface QualitySettings {
  bloom: boolean;
  bloomScale: number;      // bloom pass resolution relative to the canvas (cheaper = smaller)
  bloomStrength: number; bloomRadius: number; bloomThreshold: number;
  msaa: number;            // composer render target samples
  tube: boolean;           // neurons as tube meshes (else GL lines)
  radial: number;          // tube radial segments
  tubeRadius: number;      // multiplier on morphology radii
  carriers: number;        // multiplier on dendrite carrier points
  decorNeurons: number;    // background neurons (cap)
  somaDetail: number;      // icosahedron detail of soma spheres (-1 = none, points only)
  asset: "brain.glb" | "brain_low.glb";
  gyriLines: boolean;
  rest: number;            // resting brightness of neuron arbors (HDR paths add energy, so they sit lower)
  decorAlpha: number;      // brightness of background neurons
  sparkle: number;         // tissue sparkle points on the brain surface
  micro: boolean;          // shader micro surface detail on the brain
  ambientBolts: number;    // decorative lightning channels seeded over the cortex (per hemisphere x lobe, area weighted)
  boltDetail: number;      // 0..1 jag/fork detail of the precomputed bolts
}
export const QUALITY: Record<Quality, QualitySettings> = {
  high:     { bloom: true,  bloomScale: 1,   bloomStrength: 0.26, bloomRadius: 0.4, bloomThreshold: 1.1, msaa: 4, tube: true,  radial: 5, tubeRadius: 1,    carriers: 1,    decorNeurons: 700,    somaDetail: 3,  asset: "brain.glb",     gyriLines: true,  rest: 0.26, decorAlpha: 0.02, sparkle: 25000, micro: true, ambientBolts: 168, boltDetail: 1 },
  balanced: { bloom: true,  bloomScale: 0.5, bloomStrength: 0.23, bloomRadius: 0.35, bloomThreshold: 1.1, msaa: 0, tube: true,  radial: 3, tubeRadius: 0.8,  carriers: 0.7,  decorNeurons: 240,  somaDetail: 2,  asset: "brain.glb",     gyriLines: true,  rest: 0.45, decorAlpha: 0.032, sparkle: 10000, micro: true, ambientBolts: 112, boltDetail: 0.7 },
  low:      { bloom: false, bloomScale: 0.5, bloomStrength: 0,    bloomRadius: 0,    bloomThreshold: 1,    msaa: 0, tube: false, radial: 0, tubeRadius: 1,    carriers: 0.45, decorNeurons: 36,  somaDetail: 1,  asset: "brain_low.glb", gyriLines: false, rest: 1,    decorAlpha: 0.08, sparkle: 3000, micro: false, ambientBolts: 64, boltDetail: 0.4 },
};
export const isQuality = (v: unknown): v is Quality => v === "high" || v === "balanced" || v === "low";
/** Software rasterisers (SwiftShader, llvmpipe) cannot afford bloom or tubes. */
export const isSoftwareRenderer = (name: string) => /swiftshader|llvmpipe|software|softpipe|basic render/i.test(name);
export const autoQuality = (rendererName: string): Quality => (isSoftwareRenderer(rendererName) ? "low" : "high");
/** Bounded LOD by note count (keeps High within the frame budget on big vaults): above 600 notes High drops to 3-sided tubes, half-resolution bloom without MSAA and fewer background cells. */
export function lodByCount(q: QualitySettings, notes: number): QualitySettings {
  if (!q.bloom || q.msaa === 0 || notes <= 600) return q; // only High is affected
  return { ...q, radial: 3, bloomScale: 0.5, msaa: 0, decorNeurons: Math.min(q.decorNeurons, 200), sparkle: Math.min(q.sparkle, 12000), somaDetail: 2, ambientBolts: Math.min(q.ambientBolts, 128) };
}
/** Large vaults get cheaper neurons even on High (tube triangles scale with note count). */
export const complexityFor = (notes: number) => (notes <= 200 ? 1 : notes <= 600 ? 0.6 : notes <= 1200 ? 0.38 : 0.28);
