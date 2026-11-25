// Counts-only readback for verifying the live plugin without looking at any note data.
// STRICT WHITELIST: numbers, booleans and short fixed strings. Never ids, titles, paths, tags or links.
import type { AtlasScene } from "./scene";
import type { AtlasGraph } from "./adapter";
import { SLOTS } from "./scope";

export const DIAG_KEYS = ["version", "ts", "mode", "viewOpen", "nodes", "edges", "renderedPairs", "dendriteSegments", "pulses", "excluded",
  "folderCounts", "reducedMotion", "paused", "autorotate", "frames", "avgFrameMs", "p95FrameMs", "idleRendering", "renderer",
  "fps", "quality", "decorNeurons", "noteNeuronSegments", "impulsesActive", "bloom", "assetLoaded", "assetTriangles",
  "contained", "containLive", "geomSamples", "geomOutside", "pulseSamples", "pulseOutside", "projectedSaved", "projectedPlaced", "routeFailed", "pulseGate", "pulsesSuppressed", "guardActive", "extentSamples", "extentOutside", "shaderCapWorld",
  "ambientBolts", "boltSamples", "boltOutside", "flashRateMax"] as const;
export const FOLDER_KEYS = SLOTS;
export interface Diag {
  version: string; ts: number; mode: "brain" | "universe" | "none"; viewOpen: boolean; nodes: number; edges: number; renderedPairs: number;
  dendriteSegments: number; pulses: number; excluded: number; folderCounts: { topics: number; projects: number; memories: number };
  reducedMotion: boolean; paused: boolean; autorotate: boolean; frames: number; avgFrameMs: number; p95FrameMs: number; idleRendering: boolean; renderer: string;
  fps: number; quality: "high" | "balanced" | "low" | "none"; decorNeurons: number; noteNeuronSegments: number; impulsesActive: number; bloom: boolean; assetLoaded: boolean; assetTriangles: number;
  contained: boolean; containLive: boolean; geomSamples: number; geomOutside: number; pulseSamples: number; pulseOutside: number; projectedSaved: number; projectedPlaced: number; routeFailed: number; pulseGate: boolean; pulsesSuppressed: number; guardActive: boolean; extentSamples: number; extentOutside: number; shaderCapWorld: number;
  /** v0.3.2 lightning: decorative ambient bolt channels (never notes or links), samples / samples beyond the margin over every bolt segment, and the largest number of strike onsets seen in any 1 s window. */
  ambientBolts: number; boltSamples: number; boltOutside: number; flashRateMax: number;
}
const num = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
export function folderCounts(g: AtlasGraph) {
  const c = { topics: 0, projects: 0, memories: 0 };
  for (const n of g.nodes) if (n.folder in c) c[n.folder as keyof typeof c]++;
  return c;
}
/** Build the whitelisted diagnostics object. scene may be null when the Atlas view is closed (graph counts only). */
export function buildDiag(version: string, graph: AtlasGraph, scene: AtlasScene | null, ts = Date.now()): Diag {
  const d = scene?.debug(); const fs = scene?.frameStats();
  return {
    version: String(version).slice(0, 16), ts: Math.floor(ts), mode: scene ? scene.mode : "none", viewOpen: !!scene,
    nodes: graph.nodes.length, edges: graph.edges.length, renderedPairs: scene ? scene.renderedEdgePairs().length : 0,
    dendriteSegments: d ? d.layers.dendriteSegments : 0, pulses: d ? d.pulses.count : 0, excluded: graph.excluded, folderCounts: folderCounts(graph),
    reducedMotion: !!scene?.reducedMotion, paused: scene ? !scene.pulsesOn : false, autorotate: !!scene?.controls?.autoRotate,
    frames: d ? d.frames : 0, avgFrameMs: fs ? num(fs.avg) : 0, p95FrameMs: fs ? num(fs.p95) : 0, idleRendering: scene ? scene.idleRendering() : false,
    renderer: scene ? scene.rendererName().replace(/[^\x20-\x7e]/g, "").slice(0, 80) : "unknown",
    fps: fs && fs.avg > 0 ? num(1000 / fs.avg) : 0, quality: scene ? scene.quality : "none", decorNeurons: d ? d.decorNeurons : 0, noteNeuronSegments: d ? d.noteNeuronSegments : 0,
    impulsesActive: d ? d.impulsesActive : 0, bloom: d ? d.bloom : false, assetLoaded: d ? d.assetLoaded : false, assetTriangles: d ? d.assetTriangles : 0,
    contained: d ? d.contained : false, containLive: d ? d.containLive : false,
    geomSamples: d ? d.geomSamples : 0, geomOutside: d ? d.geomOutside : 0,
    pulseSamples: d ? d.pulseSamples : 0, pulseOutside: d ? d.pulseOutside : 0,
    projectedSaved: d ? d.projectedSaved : 0, projectedPlaced: d ? d.projectedPlaced : 0, routeFailed: d ? d.routeFailed : 0, pulseGate: d ? d.pulseGate : false, pulsesSuppressed: d ? d.pulsesSuppressed : 0, guardActive: d ? d.guardActive : false, extentSamples: d ? d.extentSamples : 0, extentOutside: d ? d.extentOutside : 0, shaderCapWorld: d ? num(Math.min(d.shaderCapWorld, 1e3)) : 0,
    ambientBolts: d ? d.lightning.ambientBolts : 0, boltSamples: d ? d.boltSamples : 0, boltOutside: d ? d.boltOutside : 0, flashRateMax: d ? d.lightning.rateMax : 0,
  };
}
