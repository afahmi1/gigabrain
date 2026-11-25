import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { AtlasGraph } from "./adapter";
import { FOLDERS, FOLDER_COLOR, FOLDER_LABEL, V3, Placement, brainLayout, universeStarPos, makeDust, rng, fnv, dirInBand, cortexPoint, cortexNormal, inCerebellum, cerebellumPoint, proceduralPlacement, CB_C, CB_R, BRAIN_REGION_CENTER, UNIVERSE_REGION_CENTER } from "./layout";
import { cortexMesh, gyriLines, cerebellumMesh, cerebellumLines, brainstemMesh, Mesh } from "./anatomy";
import { Quality, QualitySettings, QUALITY, autoQuality, complexityFor, lodByCount } from "./quality";
import { Morph, SwcCell, makeMorph, decorMorph, cellTypeFor, hubOf, reachFor, KIND_DENDRITE } from "./morph";
import { buildNeuronGeo } from "./neuronGeo";
import { NeuronTex, FibreTex, Shared, makeShared, arborMaterial, somaMaterial, fibreMaterial, decorMaterial, backgroundMesh, sparkleMaterial, CAPGLSL } from "./neurons";
import { LightningSim, Channel, AmbientChannel, StrikeSink, RATES, REDUCED, KIND_LINK, cellsOf, orient } from "./impulse";
import { BoltLayer } from "./bolts";
import { Bolt, ambientBolts, emptyBolt, sampleBolt } from "./lightning";
import { BrainAsset, brainMaterials } from "./brain";
import { PALETTE, spectrumAt, spectrumT } from "./palette";
/** One real link as the lightning sees it: oriented note indices, graph edge index and the dendrite group its bolt strikes on the target. */
export interface LinkFibre { src: number; dst: number; edge: number; group: number; }
/** A bolt spanning more than this radius counts as a large ("screen-significant") flash for the photosensitivity cap. */
const BIG_RADIUS = 0.25;
import { Field } from "./field";
import { Router, Region3, containPoint, insetSurfacePoints } from "./contain";
import { containSomas, makeNoteMorphs, planLinks, makeDecor, LinkPlan, somaNeed, LINK_SEG, makeLinkBolt, linkBoltOpts } from "./world";

export type Mode = "brain" | "universe";
export type PosMap = Record<string, { brain?: V3; universe?: V3 }>;
export interface SceneOpts {
  container: HTMLElement;
  onOpen: (path: string) => void;
  onPositions?: (p: PosMap) => void;
  onHover?: (idx: number) => void;
  dustCount?: number;
  autoRotate?: boolean;
  morphMs?: number;
  quality?: Quality;          // default: High on real GPUs, Low on software renderers
  intro?: boolean;            // play the grow-in once per session (default true; never under reduced motion)
  templates?: SwcCell[];      // real SWC morphologies (morphologies.json); procedural MST neurons are used when absent
}

const STAR_VS = `
attribute vec3 aBrain; attribute vec3 aUni; attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aState; attribute float aIndex; attribute float aNear;
uniform float uMorph; uniform float uTime; uniform float uPx; uniform float uFocus; uniform float uDimOn; uniform float uHalo;
varying vec3 vCol; varying float vA;
${CAPGLSL}void main(){
  vec3 p = mix(aBrain, aUni, uMorph);
  vec4 mv = modelViewMatrix * vec4(p,1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.88 + 0.12*sin(uTime*1.6 + aPhase*6.2831);
  float f = 1.0 - step(0.5, abs(aIndex - uFocus));
  float nb = mix(1.0, mix(0.18, 1.0, aNear), uDimOn);
  float s = aSize * uHalo * (1.0 + 0.9*f) * tw * clamp(aState, 0.5, 1.5) * (0.55 + 0.45*nb);
  gl_PointSize = capPx(clamp(s * uPx * (80.0 / max(0.1, -mv.z)), 3.0, 90.0), gl_Position.w);
  vCol = mix(aColor, vec3(1.0), 0.25*f); vA = aState * nb;
}`;
const STAR_FS = `
varying vec3 vCol; varying float vA;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.32, 0.0, d);
  float glow = pow(1.0 - d, 2.6);
  vec3 c = mix(vCol, vec3(1.0), core*0.85);
  float i = (glow*0.75 + core) * vA;
  gl_FragColor = vec4(c, clamp(i, 0.0, 1.0));
}`;
const DUST_VS = `
attribute vec3 aBrain; attribute vec3 aUni; attribute vec3 aColor; attribute float aRand; attribute float aSize;
uniform float uMorph; uniform float uTime; uniform float uPx; uniform float uAlpha;
varying vec3 vCol; varying float vA;
${CAPGLSL}void main(){
  float t = clamp(uMorph*1.7 - aRand*0.7, 0.0, 1.0);
  float e = t*t*(3.0-2.0*t);
  vec3 p = mix(aBrain, aUni, e);
  p.y += sin(e*3.14159) * (aRand-0.5) * 2.2;
  p += vec3(sin(aRand*40.0+uTime*0.21), cos(aRand*31.0+uTime*0.25), sin(aRand*17.0+uTime*0.17)) * 0.012;
  vec4 mv = modelViewMatrix * vec4(p,1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = capPx(clamp(aSize * uPx * (230.0 / max(0.1,-mv.z)), 1.0, 6.0), gl_Position.w);
  vCol = aColor; vA = uAlpha * (0.55 + 0.45*aRand);
}`;
const DUST_FS = `
varying vec3 vCol; varying float vA;
void main(){ float d = length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard; gl_FragColor = vec4(vCol, vA*(1.0-d)); }`;
const GLOW_VS = `
attribute vec3 aBrain; attribute vec3 aUni; attribute vec3 aColor; attribute float aSize;
uniform float uMorph; uniform float uPx; varying vec3 vCol;
void main(){ vec3 p = mix(aBrain,aUni,uMorph); vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv;
  gl_PointSize = clamp(aSize*uPx*(60.0/max(0.1,-mv.z)), 8.0, 700.0); vCol = aColor; }`;
const GLOW_FS = `varying vec3 vCol; void main(){ float d=length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard; gl_FragColor = vec4(vCol, 0.045*pow(1.0-d,2.4)); }`;

const SHELL_VS = `
uniform float uMorph; varying vec3 vN; varying vec3 vV;
void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const SHELL_FS = `
uniform vec3 uColor; uniform float uAlpha; varying vec3 vN; varying vec3 vV;
void main(){ float rim = 1.0 - abs(dot(normalize(vN), normalize(vV))); float a = (0.035 + 0.30*pow(rim, 2.4)) * uAlpha; gl_FragColor = vec4(uColor, a); }`;
const LINE_VS = `uniform float uAlpha; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const LINE_FS = `uniform vec3 uColor; uniform float uAlpha; void main(){ gl_FragColor = vec4(uColor, uAlpha); }`;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Default brain camera: three-quarter left lateral from slightly below; frontal/temporal/occipital lobes, cerebellum and brainstem all visible, brain about 70% of the canvas height. */
export const DEFAULT_CAM = { pos: [-2.10, -0.69, 1.62] as V3, target: [0, -0.15, 0] as V3, dist: 2.7 };
export class AtlasScene {
  readonly opts: SceneOpts;
  renderer: THREE.WebGLRenderer | null = null;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(48, 1, 0.05, 200);
  controls: OrbitControls | null = null;
  canvas: HTMLCanvasElement;
  labelLayer: HTMLDivElement;
  graph: AtlasGraph = { nodes: [], edges: [], excluded: 0 };
  brainP: Float32Array = new Float32Array(0);
  uniP: Float32Array = new Float32Array(0);
  positions: PosMap = {};
  mode: Mode = "brain";
  morph = 0; target = 0; morphFrom = 0; morphStart = 0;
  focus = -1; hover = -1;
  query = "";
  matches: number[] = [];
  edit = false;
  frames = 0; // rendered frames (renderer.render calls)
  loops = 0; // rAF ticks, rendered or skipped
  skipped = 0; // ticks skipped because the scene was idle or hidden
  /** Render-on-demand: when nothing animates (pulses paused, no autorotate/morph/tween) and nothing changed, no render is issued. */
  private dirtyWarm = 30; private sig = ""; private lastInvalidate = 0; private lastRenderAt = 0; private frameTimes: number[] = []; private lastRenderTs = 0;
  webgl = true;
  private dustCount: number;
  private raf = 0; private disposed = false; private t0 = performance.now();
  private stars?: THREE.Points; private dust?: THREE.Points; edges?: THREE.Mesh | THREE.LineSegments; fibreRes?: THREE.Vector2; private glow?: THREE.Points;
  private starU: any; private dustU: any; private edgeU: any; private glowU: any;
  // quality / post processing
  quality: Quality = "low"; qs: QualitySettings = QUALITY.low; private composer: EffectComposer | null = null; private bloomPass: UnrealBloomPass | null = null; private bg?: THREE.Mesh;
  guardActive = false;
  private badFibre = new Uint8Array(0); private suppressed = 0; private gateOpen = false; private gateReason = "intro";
  // neurons (decoration of notes; never connect two notes), fibres (the real graph edges), background neurons (decor)
  morphs: Morph[] = []; place: Placement[] = []; private ntex: NeuronTex | null = null; private ftex: FibreTex | null = null; private sh: Shared = makeShared();
  arbor?: THREE.Mesh | THREE.LineSegments; private somas?: THREE.Mesh; decor?: THREE.LineSegments; fibres: LinkFibre[] = []; sim: LightningSim | null = null;
  // lightning: one precomputed bolt per real link (linkBolts) and decorative bolts seeded over the whole cortex (ambientBolts); drawn only while in flight
  linkBolts?: THREE.Mesh; ambientBolts?: THREE.Mesh; private boltL: BoltLayer | null = null; private boltA: BoltLayer | null = null;
  private ambientSet: { key: string; asset: BrainAsset; bolts: Bolt[]; binArea: number[] } | null = null; private boltCache = new Map<string, Bolt>();
  private boltStats = { samples: 0, outside: 0, linkSegments: 0, ambientSegments: 0, ms: 0, prewarmMs: 0 };
  noteNeuronSegments = 0; denSegments = 0; decorNeurons = 0; decorMorphs: Morph[] = []; decorPos: V3[] = [];
  asset: BrainAsset | null = null; private assetGroup = new THREE.Group(); private assetU: any[] = []; private silhouette = new THREE.Group();
  // containment (signed distance field) wiring: all glowing geometry is projected/clipped into the interior from one shared field
  private router: Router | null = null; private linkPlans: LinkPlan[] = []; private regions: Region3[] = [];
  private projectedSaved = 0; private projectedPlaced = 0; private routeFailed = 0;
  private noteClip = { cut: 0, dropped: 0 }; private decorClip = { cut: 0, dropped: 0 }; private sparkleDropped = 0;
  private containStats = { geomSamples: 0, geomOutside: 0, pulseSamples: 0, pulseOutside: 0, extentSamples: 0, extentOutside: 0, boltSamples: 0, boltOutside: 0 }; private outsideBy = { soma: 0, arbor: 0, decor: 0, sparkle: 0 }; private linkStats = { gs: 0, go: 0, ps: 0, po: 0 };
  /** Signed distance field of the real brain, null on the procedural scaffold (no containment needed there). */
  get field(): Field | null { return this.asset?.field ?? null; }
  /** SDF mode gate: true only while a real brain mesh + field is loaded. */
  get contained() { return !!this.field; }
  /** Per-frame containment state: live only while the brain is present and not morphing toward the universe. */
  get containLive() { return this.field !== null && (this.asset as any)?.fieldVerified === true && this.mode === "brain" && this.morph === 0; }
  private shellU: any[] = []; private lineU: any[] = []; private focusU = { value: -1 };
  adj: number[][] = []; near: Float32Array = new Float32Array(0); nearCount = 0;
  private labelIdx: number[] = []; private nlabels: HTMLDivElement[] = [];
  private ctrlB: Float32Array = new Float32Array(0); private ctrlU: Float32Array = new Float32Array(0);
  pulsesOn = true; pulseClock = 0; private lastNow = 0;
  private labels: Record<string, HTMLDivElement> = {};
  private ro?: ResizeObserver;
  private drag: { idx: number; moved: boolean; sx: number; sy: number } | null = null;
  /** Last mouse/pen position over the canvas (null after leave or touch) and the view the hover was resolved for: stars move under a still cursor. */
  private ptr: { x: number; y: number } | null = null; private hoverKey = ""; private posRev = 0;
  private preview: { i: number; mode: Mode; original: V3 } | null = null;
  private camTween: { t0: number; dur: number; from: THREE.Vector3; to: THREE.Vector3; df: number; dt: number } | null = null;
  private reduce: boolean;
  get reducedMotion() { return this.reduce; }

  constructor(opts: SceneOpts) {
    this.opts = opts;
    this.dustCount = opts.dustCount ?? 2400;
    this.reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.pulsesOn = !this.reduce;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pa-canvas";
    this.canvas.tabIndex = -1;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Palace Atlas 3D visualization. A searchable list of the same notes is next to it.");
    opts.container.appendChild(this.canvas);
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "pa-labels";
    this.labelLayer.setAttribute("aria-hidden", "true");
    opts.container.appendChild(this.labelLayer);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
      this.renderer.setClearColor(0x02030a, 1);
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // all colours in this scene are display-referred; no implicit sRGB re-encode
    } catch (e) { this.webgl = false; }
    this.camera.position.set(...DEFAULT_CAM.pos);
    if (this.renderer) {
      this.controls = new OrbitControls(this.camera, this.canvas);
      Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, minDistance: 0.12, maxDistance: 40, autoRotate: (opts.autoRotate ?? true) && !this.reduce, autoRotateSpeed: 0.45 });
      this.controls.addEventListener("start", () => { if (this.controls) this.controls.autoRotate = false; });
      this.quality = opts.quality ?? autoQuality(this.rendererName()); this.qs = QUALITY[this.quality];
      this.bg = backgroundMesh(); this.scene.add(this.bg);
      this.buildDust(); this.buildSilhouette(); this.assetGroup.visible = false; this.scene.add(this.assetGroup);
      this.canvas.addEventListener("pointerdown", this.onDown);
      this.canvas.addEventListener("pointermove", this.onMove);
      this.canvas.addEventListener("pointerleave", this.onLeave);
      window.addEventListener("pointerup", this.onUp);
      this.canvas.addEventListener("pointercancel", this.onCancel);
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(opts.container);
      this.resize(); this.setupComposer();
      this.loop();
    } else {
      const m = document.createElement("div"); m.className = "pa-nogl"; m.textContent = "WebGL unavailable. Use the note list.";
      opts.container.appendChild(m);
    }
  }

  // ---------- data ----------
  private buildDust() {
    const d = makeDust(this.dustCount);
    // tissue sparkle: fine points take the spatial spectrum hue by anterior-posterior position (front orange ... back magenta)
    for (let i = 0; i < d.count; i++) { const c = spectrumAt(spectrumT(d.brain[i * 3 + 2])), m = 0.55 + 0.45 * d.rand[i]; d.color[i * 3] = c[0] * m; d.color[i * 3 + 1] = c[1] * m; d.color[i * 3 + 2] = c[2] * m; }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(d.count * 3), 3));
    g.setAttribute("aBrain", new THREE.BufferAttribute(d.brain, 3));
    g.setAttribute("aUni", new THREE.BufferAttribute(d.uni, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(d.color, 3));
    g.setAttribute("aRand", new THREE.BufferAttribute(d.rand, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(d.size, 1));
    this.dustU = { uMorph: { value: 0 }, uTime: { value: 0 }, uPx: { value: 1 }, uAlpha: { value: 0.3 }, uWMax: this.sh.uWMax, uViewH: this.sh.uViewH };
    const m = new THREE.ShaderMaterial({ vertexShader: DUST_VS, fragmentShader: DUST_FS, uniforms: this.dustU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.dust = new THREE.Points(g, m); this.dust.frustumCulled = false; this.dust.renderOrder = 0;
    this.scene.add(this.dust);
  }

  setGraph(graph: AtlasGraph, positions?: PosMap) {
    this.cancelPreview();
    this.graph = graph;
    if (positions) this.positions = positions;
    const n = graph.nodes.length;
    { const next = lodByCount(QUALITY[this.quality], n), redo = !!this.renderer && (next.msaa !== this.qs.msaa || next.bloomScale !== this.qs.bloomScale); this.qs = next; if (redo) this.setupComposer(); } // bounded LOD by note count
    this.brainP = new Float32Array(n * 3); this.uniP = new Float32Array(n * 3);
    this.regions = []; this.linkPlans = []; this.router = null; this.projectedSaved = 0; this.projectedPlaced = 0; this.routeFailed = 0;
    const asset = this.asset;
    if (asset && asset.field) {
      // real brain + signed distance field: somas are projected into the interior (saved positions too, in memory only), arbors and links are generated below from the same constrained positions
      const nodes = graph.nodes.map((nd) => ({ id: nd.id, folder: nd.folder, degree: nd.degree }));
      const places = asset.relax(graph.nodes.map((nd) => asset.placer(nd.id, nd.folder)), graph.edges.map((e) => [e.a, e.b] as [number, number]), graph.nodes.map((nd) => nd.id));
      const sp = containSomas(asset.field, nodes, places, this.positions);
      this.brainP = sp.brainP; this.place = sp.places; this.regions = sp.regions;
      // runtime second chance: any soma still below the margin is re-projected with the field before anything is generated from it (in memory only)
      for (let i = 0; i < nodes.length; i++) {
        const P = sp.brainP; if (asset.field.depthE(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) >= asset.field.margin) continue;
        const q = asset.field.project([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], somaNeed(asset.field, nodes[i].degree)); this.brainP.set(q, i * 3); this.place[i] = { ...this.place[i], pos: [q[0], q[1], q[2]] }; this.projectedPlaced++;
      }
      this.projectedSaved = sp.projectedSaved; this.projectedPlaced = sp.projectedPlaced;
    } else {
      // procedural scaffold (no field): the built-in layout already keeps every soma inside the shell
      const lay = brainLayout(graph.nodes, graph.edges);
      this.place = graph.nodes.map((nd, i) => asset ? asset.placer(nd.id, nd.folder)
        : inCerebellum(nd.id, nd.folder) ? proceduralPlacement(cerebellumPoint(nd.id), "cerebellum") : proceduralPlacement(lay[i], "cortex"));
      if (asset) this.place = asset.relax(this.place, graph.edges.map((e) => [e.a, e.b] as [number, number]), graph.nodes.map((nd) => nd.id));
      graph.nodes.forEach((nd, i) => {
        const o = this.positions[nd.id];
        this.brainP.set(o?.brain ?? this.place[i].pos, i * 3);
      });
    }
    // universe layout is never constrained (it is not a brain)
    graph.nodes.forEach((nd, i) => {
      const o = this.positions[nd.id];
      this.uniP.set(o?.universe ?? universeStarPos(nd.id, nd.folder), i * 3);
    });
    this.adj = graph.nodes.map(() => []);
    for (const e of graph.edges) { this.adj[e.a].push(e.b); this.adj[e.b].push(e.a); }
    this.near = new Float32Array(n).fill(1);
    if (this.hover >= 0) this.opts.onHover?.(-1); // indices change with the graph: drop the tooltip, trackHover re-resolves under the cursor
    this.focus = -1; this.hover = -1; this.hoverKey = ""; this.labelIdx = []; this.nearCount = n;
    this.invalidate(12);
    if (this.renderer) this.rebuildAll();
  }
  /** Everything that depends on the graph, positions or quality. */
  private rebuildAll() {
    this.rebuildNeurons(); this.rebuildStars(); this.rebuildAmbient(); this.rebuildEdges(); this.rebuildDecor(); this.rebuildGlow(); this.rebuildLabels(); this.applyQuery(); if (this.introProgress < 1) this.applyIntro();
    this.measureClearance(); this.syncShared();
  }
  private disposeObj(o?: THREE.Object3D & { geometry?: any; material?: any }) {
    if (!o) return; this.scene.remove(o); o.geometry?.dispose(); o.material?.dispose();
  }
  private rebuildStars() {
    this.disposeObj(this.stars);
    const n = this.graph.nodes.length;
    const g = new THREE.BufferGeometry();
    const col = new Float32Array(n * 3), size = new Float32Array(n), ph = new Float32Array(n), st = new Float32Array(n).fill(1), idx = new Float32Array(n);
    this.graph.nodes.forEach((nd, i) => {
      col.set(FOLDER_COLOR[nd.folder], i * 3);
      size[i] = 0.8 + Math.min(1.8, Math.sqrt(nd.degree) * 0.45);
      ph[i] = (i * 0.61803) % 1; idx[i] = i;
    });
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aBrain", new THREE.BufferAttribute(this.brainP, 3));
    g.setAttribute("aUni", new THREE.BufferAttribute(this.uniP, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
    g.setAttribute("aState", new THREE.BufferAttribute(st, 1));
    g.setAttribute("aIndex", new THREE.BufferAttribute(idx, 1));
    g.setAttribute("aNear", new THREE.BufferAttribute(this.near, 1));
    this.starU = { uWMax: this.sh.uWMax, uViewH: this.sh.uViewH, uMorph: { value: this.morph }, uTime: { value: 0 }, uPx: { value: this.pr() }, uFocus: { value: -1 }, uDimOn: { value: 0 }, uHalo: { value: 0.07 } };
    const m = new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: this.starU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.stars = new THREE.Points(g, m); this.stars.frustumCulled = false; this.stars.renderOrder = 3;
    this.scene.add(this.stars);
  }
  /** Quadratic control point. Brain: links bow INWARD through the brain volume like white-matter tracts (edge-bundling look). */
  private ctrl(p0: V3, p1: V3, mode: Mode): V3 {
    const mid: V3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
    const dist = Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]);
    if (mode === "brain") {
      const cy = 0.05, dx = -mid[0], dy = cy - mid[1], dz = -mid[2];
      const l = Math.hypot(dx, dy, dz) || 1, k = Math.min((this.asset ? 0.2 : 0.42) * dist, l * 0.95);
      const cross = p0[0] * p1[0] < 0 ? 0.14 * dist : 0; // commissure-like arch over the fissure
      return [mid[0] + (dx / l) * k, mid[1] + (dy / l) * k + cross, mid[2] + (dz / l) * k];
    }
    return [mid[0], mid[1] + 0.3 * dist + 0.1, mid[2]];
  }
  private curve(p0: V3, p1: V3, mode: Mode, out: number[], seg: number, store: Float32Array, si: number) {
    const c = this.ctrl(p0, p1, mode);
    store.set(p0, si); store.set(c, si + 3); store.set(p1, si + 6);
    const pts: V3[] = [];
    for (let s = 0; s <= seg; s++) {
      const t = s / seg, u = 1 - t;
      pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1], u * u * p0[2] + 2 * u * t * c[2] + t * t * p1[2]]);
    }
    for (let s = 0; s < seg; s++) out.push(...pts[s], ...pts[s + 1]);
  }
  /** Fibres: the REAL graph edges, drawn from the source note's axon terminal to a dendrite tip of the linked note. */
  private rebuildEdges() {
    this.disposeObj(this.edges); this.edges = undefined; this.fibres = []; this.sim = null; this.ftex?.tex.dispose(); this.ftex = null; this.disposeBoltL();
    const E = this.graph.edges; this.ctrlB = new Float32Array(0); this.ctrlU = new Float32Array(0);
    this.linkPlans = []; this.router = null; this.routeFailed = 0; this.badFibre = new Uint8Array(E.length); this.suppressed = 0;
    if (!E.length) { this.makeSim(); return; }
    const SEG = LINK_SEG, US = this.sh.uUniScale.value, f = this.field;
    const nodes = this.graph.nodes.map((nd) => ({ id: nd.id, folder: nd.folder, degree: nd.degree }));
    let plans: LinkPlan[] = [];
    if (f) { this.router = new Router(f); plans = planLinks(f, this.router, nodes, E.map((e) => ({ a: e.a, b: e.b })), this.morphs, this.brainP, this.regions, SEG); }
    this.linkPlans = plans; this.linkStats = { gs: 0, go: 0, ps: 0, po: 0 };
    const segOf = (ei: number) => (plans[ei] ? Math.max(1, plans[ei].pts.length - 1) : SEG); // per-edge segment count: the router's own vertices, no resample
    const first: number[] = []; let nSeg = 0; for (let ei = 0; ei < E.length; ei++) { first.push(nSeg); nSeg += segOf(ei); }
    const V = nSeg * 2, b: number[] = [], u: number[] = [];
    this.ctrlB = new Float32Array(E.length * 9); this.ctrlU = new Float32Array(E.length * 9);
    const col = new Float32Array(V * 3), A = new Float32Array(V), B = new Float32Array(V), T = new Float32Array(V), EI = new Float32Array(V);
    const outN = new Int32Array(nodes.length), inN = new Int32Array(nodes.length);
    const rel = (m: Morph, k: number, sc: number, base: Float32Array, who: number): V3 => [base[who * 3] + m.pos[k * 3] * sc, base[who * 3 + 1] + m.pos[k * 3 + 1] * sc, base[who * 3 + 2] + m.pos[k * 3 + 2] * sc];
    let v = 0;
    E.forEach((e, ei) => {
      const plan = plans[ei], na = this.graph.nodes[e.a], nb = this.graph.nodes[e.b], aSrc = orient(na.id, nb.id), n = segOf(ei), o0 = first[ei];
      const src = plan ? plan.src : aSrc ? e.a : e.b, dst = plan ? plan.dst : aSrc ? e.b : e.a;
      const ms = this.morphs[src], md = this.morphs[dst];
      const term = plan ? plan.term : (ms.axonTerminals.length ? ms.axonTerminals[outN[src]++ % ms.axonTerminals.length] : 0);
      const tip = plan ? plan.tip : (md.dendTips.length ? md.dendTips[inN[dst]++ % md.dendTips.length] : 0);
      const pb0 = rel(ms, term, 1, this.brainP, src), pb1 = rel(md, tip, 1, this.brainP, dst), pu0 = rel(ms, term, US, this.uniP, src), pu1 = rel(md, tip, US, this.uniP, dst);
      if (plan) {
        let pts = plan.pts.length >= 2 ? plan.pts : [pb0, pb1];
        const st = this.planOutside(plan, pts); // one pass over terminal chains + the polyline that is actually drawn
        if (!plan.ok || st.o > 0) { this.badFibre[ei] = 1; this.suppressed++; this.routeFailed++; pts = Array.from({ length: n + 1 }, () => pts[0]); } // fail closed: zero-length, no emission
        else { this.linkStats.gs += st.sp; this.linkStats.ps += st.s; }
        for (let s = 0; s < n; s++) b.push(...pts[s], ...pts[s + 1]);
      } else this.curve(pb0, pb1, "brain", b, n, this.ctrlB, ei * 9);
      this.curve(pu0, pu1, "universe", u, n, this.ctrlU, ei * 9); // same segment count as the brain path; endpoints exact
      let tot = 0; const cum = [0]; for (let s = 0; s < n; s++) { const q = (o0 + s) * 6; tot += Math.hypot(b[q + 3] - b[q], b[q + 4] - b[q + 1], b[q + 5] - b[q + 2]); cum.push(tot); }
      this.fibres.push({ src, dst, edge: ei, group: md.group[tip] });
      const ca = FOLDER_COLOR[this.graph.nodes[src].folder], cb = FOLDER_COLOR[this.graph.nodes[dst].folder];
      for (let s = 0; s < n; s++) for (let k = 0; k < 2; k++) {
        const t = tot > 1e-9 ? cum[s + k] / tot : (s + k) / n; // exact arc-length fraction along the checked rendered path
        col[v * 3] = ca[0] * (1 - t) + cb[0] * t; col[v * 3 + 1] = ca[1] * (1 - t) + cb[1] * t; col[v * 3 + 2] = ca[2] * (1 - t) + cb[2] * t;
        A[v] = e.a; B[v] = e.b; T[v] = t; EI[v] = ei; v++;
      }
    });
    const NS = nSeg, RV = NS * 4, rb = new Float32Array(RV * 3), rbo = new Float32Array(RV * 3), ru = new Float32Array(RV * 3), ruo = new Float32Array(RV * 3), side = new Float32Array(RV);
    const rcol = new Float32Array(RV * 3), rA = new Float32Array(RV), rB = new Float32Array(RV), rT = new Float32Array(RV), rE = new Float32Array(RV), idx = new Uint32Array(NS * 6);
    for (let gI = 0; gI < NS; gI++) for (let k = 0; k < 2; k++) for (let sd = 0; sd < 2; sd++) {
      const rv = gI * 4 + k * 2 + sd, lv = gI * 2 + k, me = k * 3, ot = (1 - k) * 3;
      for (let c = 0; c < 3; c++) { rb[rv * 3 + c] = b[gI * 6 + me + c]; rbo[rv * 3 + c] = b[gI * 6 + ot + c]; ru[rv * 3 + c] = u[gI * 6 + me + c]; ruo[rv * 3 + c] = u[gI * 6 + ot + c]; rcol[rv * 3 + c] = col[lv * 3 + c]; }
      side[rv] = sd ? 1 : -1; rA[rv] = A[lv]; rB[rv] = B[lv]; rT[rv] = T[lv]; rE[rv] = EI[lv];
    }
    for (let gI = 0; gI < NS; gI++) { const o = gI * 4; idx.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], gI * 6); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RV * 3), 3));
    g.setAttribute("aBrain", new THREE.BufferAttribute(rb, 3)); g.setAttribute("aBrainO", new THREE.BufferAttribute(rbo, 3));
    g.setAttribute("aUni", new THREE.BufferAttribute(ru, 3)); g.setAttribute("aUniO", new THREE.BufferAttribute(ruo, 3)); g.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(rcol, 3));
    g.setAttribute("aA", new THREE.BufferAttribute(rA, 1)); g.setAttribute("aB", new THREE.BufferAttribute(rB, 1)); g.setAttribute("aT", new THREE.BufferAttribute(rT, 1)); g.setAttribute("aEdge", new THREE.BufferAttribute(rE, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.ftex = new FibreTex(E.length);
    const m = fibreMaterial(this.sh, this.ftex, this.focusU); this.edgeU = m.uniforms; this.fibreRes = m.uniforms.uRes.value as THREE.Vector2; this.fibreRes.set(this.canvas.width || 1, this.canvas.height || 1); m.uniforms.uW.value = 4 * this.pr();
    this.edges = new THREE.Mesh(g, m) as any; this.edges!.frustumCulled = false; this.edges!.renderOrder = 2;
    this.scene.add(this.edges);
    this.buildLinkBolts(plans);
    this.makeSim(); this.prewarmBolts();
  }
  /** True once the lightning shader is compiled and its textures are on the GPU; strikes wait for it, so the first flash never freezes the view. */
  boltsReady = false; private prewarmSeq = 0;
  /** Build the lightning program, its GPU pipeline (the render-target variant the composer draws it with: HDR target, no tone mapping) and its
   *  textures during the layout rebuild, which blocks anyway, with a fully culled draw. A lazy first use on the first strike froze the view for
   *  ~1.7 s at 1,500 notes (driver compile on first draw). Strikes are held until this has run. */
  private prewarmBolts() {
    const r = this.renderer, t0 = performance.now(); this.boltsReady = false; ++this.prewarmSeq;
    if (r) { const rt = this.composer ? this.composer.renderTarget1 : null; for (const L of [this.boltL, this.boltA]) { try { L?.prewarm(r, this.camera, rt); } catch { /* a failed prewarm only costs the first-strike compile */ } } }
    this.boltsReady = true; this.boltStats.prewarmMs = Math.round(performance.now() - t0);
  }
  private boltWidth() { return this.qs.bloom ? PALETTE.boltWidth : PALETTE.boltWidthLow; }
  private boltGain() { return this.qs.bloom ? PALETTE.boltGain : PALETTE.boltGainLow; }
  /** One precomputed lightning bolt per real link: source soma -> axon terminal -> the link's verified route (jagged, forked) -> dendrite tip -> target soma.
   *  Suppressed (fail-closed) links get an empty bolt that can never strike. Bolts are cached per route, so a drag commit only regrows the moved cell's links. */
  private buildLinkBolts(plans: LinkPlan[]) {
    const f = this.field, nodes = this.graph.nodes; if (!f || !this.renderer || plans.length !== this.fibres.length) return;
    const t0 = performance.now(), lo = linkBoltOpts(complexityFor(nodes.length), this.qs.boltDetail, this.asset?.ambientSource().cortexBox), next = new Map<string, Bolt>(), P = this.brainP;
    const wn = nodes.map((nd) => ({ id: nd.id, folder: nd.folder, degree: nd.degree }));
    const bolts = plans.map((pl, ei) => {
      if (this.badFibre[ei] || !pl.ok) return emptyBolt(pl.src, pl.dst, ei);
      const q = pl.pts, mid = q[q.length >> 1], sa = this.morphs[pl.src], sb = this.morphs[pl.dst];
      const key = [nodes[pl.src].id, nodes[pl.dst].id, lo.maxNodes, lo.forks, lo.jag.levels, q.length, ...q[0], ...mid, ...q[q.length - 1], P[pl.src * 3], P[pl.src * 3 + 1], P[pl.src * 3 + 2], P[pl.dst * 3], P[pl.dst * 3 + 1], P[pl.dst * 3 + 2], sa.n, sb.n, pl.term, pl.tip].map((x) => (typeof x === "number" ? x.toFixed(5) : x)).join("|");
      let bolt = this.boltCache.get(key);
      bolt = bolt ? { ...bolt, edge: ei } : makeLinkBolt(f, wn, pl, this.morphs, P, lo); // cached per route: a drag commit only regrows the moved cell's links
      next.set(key, bolt); return bolt;
    });
    this.boltCache = next;
    this.boltL = new BoltLayer(bolts, this.sh, this.focusU, { kind: KIND_LINK, tint: (i) => PALETTE.impulse[nodes[bolts[i].src]?.folder ?? "topics"], ends: (i) => [bolts[i].src, bolts[i].dst], width: this.boltWidth(), gain: this.boltGain(), reduce: this.reduce });
    this.boltL.setRes(this.canvas.width, this.canvas.height, this.pr(), this.boltWidth());
    this.linkBolts = this.boltL.mesh; this.linkBolts.visible = this.introProgress >= 0.92; this.scene.add(this.linkBolts);
    this.boltStats.linkSegments = this.boltL.segments; this.boltStats.ms = performance.now() - t0;
    for (let i = 0; i < this.fibres.length; i++) if (this.ftex?.hidden(i)) this.boltL.setHidden(i, true);
  }
  private disposeBoltL() { if (this.linkBolts) this.scene.remove(this.linkBolts); this.boltL?.dispose(); this.boltL = null; this.linkBolts = undefined; }
  private disposeBoltA() { if (this.ambientBolts) this.scene.remove(this.ambientBolts); this.boltA?.dispose(); this.boltA = null; this.ambientBolts = undefined; }
  /** Decorative lightning over the whole cortex: depends only on the brain asset (field + meshes) and the quality level, so it is grown once per asset/quality. */
  private rebuildAmbient() {
    const f = this.field, a = this.asset; if (!f || !a || !this.renderer) { this.disposeBoltA(); this.ambientSet = null; return; }
    const key = `${this.qs.ambientBolts}|${this.qs.boltDetail}`;
    if (!this.ambientSet || this.ambientSet.key !== key || this.ambientSet.asset !== a) { const res = ambientBolts(f, a.ambientSource(), { count: this.qs.ambientBolts, detail: this.qs.boltDetail }); this.ambientSet = { key, asset: a, bolts: res.bolts, binArea: res.binArea }; }
    const bolts = this.ambientSet.bolts; this.disposeBoltA();
    this.boltA = new BoltLayer(bolts, this.sh, this.focusU, { kind: 1, tint: (i) => spectrumAt(spectrumT(bolts[i].center[2])), width: this.boltWidth() * 0.9, gain: this.boltGain() * PALETTE.ambientGain, reduce: this.reduce });
    this.boltA.setRes(this.canvas.width, this.canvas.height, this.pr(), this.boltWidth() * 0.9);
    this.ambientBolts = this.boltA.mesh; this.ambientBolts.visible = this.introProgress >= 0.92; this.scene.add(this.ambientBolts);
    this.boltStats.ambientSegments = this.boltA.segments;
  }
  /** The lightning scheduler over the real links (+ the decorative ambient channels). Link strikes flash the source axon and the target dendrite group. */
  private makeSim() {
    const nt = this.ntex, nodes = this.graph.nodes; if (!nt) return;
    const imp = (n: number) => PALETTE.impulse[nodes[n].folder], held = (n: number) => this.preview?.i === n; // the cell under an edit-drag preview stays dark until release
    const lb = this.boltL, ab = this.boltA;
    const links: Channel[] = this.fibres.map((fb, i) => { const b = lb?.bolts[i]; return { src: fb.src, dst: fb.dst, edge: fb.edge, big: !b || b.radius >= BIG_RADIUS, cells: b ? cellsOf(b.pos, b.n) : [], center: b?.center }; });
    const amb: AmbientChannel[] = (ab?.bolts ?? []).map((b) => ({ bin: b.bin, big: b.radius >= BIG_RADIUS, cells: cellsOf(b.pos, b.n), center: b.center }));
    const sink: StrikeSink = {
      strike: (s) => {
        if (s.kind !== KIND_LINK) { ab?.strike(s); return; }
        const fb = this.fibres[s.bolt]; lb?.strike(s);
        const tr = s.t0 + s.leader, c = imp(fb.src); nt.axon(fb.src, tr, c); nt.dendrite(fb.dst, tr, fb.group, c, tr); // both cells flash with the return stroke
      },
      end: (k, b) => (k === KIND_LINK ? lb : ab)?.end(b),
      clear: () => { lb?.clear(); ab?.clear(); },
      allowed: (k, b) => { if (!this.boltsReady) return false; if (k !== KIND_LINK) return !!ab; const fb = this.fibres[b]; return !!lb && lb.count[b] > 0 && !lb.hidden(b) && !this.badFibre[b] && !held(fb.src) && !held(fb.dst); },
    };
    const w = this.ambientSet?.binArea.map((x, i) => (i < 8 ? Math.pow(x, 0.6) : i === 8 ? 0.45 : 0.08)) ?? []; // cerebrum by cortical area (flattened so the smaller lobes flash too); cerebellum/brainstem occasionally
    this.sim = new LightningSim(nodes.length, links, amb, sink, this.reduce ? REDUCED : RATES[this.quality], 0x51ac, w);
    this.sim.reset(this.pulseClock); // schedule relative to the current clock (no burst of stale seeds after a re-layout)
    this.sim.focus = this.hover >= 0 ? this.hover : this.focus;
  }
  private rebuildGlow() {
    this.disposeObj(this.glow); this.glow = undefined;
    if (this.field) return; // procedural scaffold glow only: the real brain is lit by its contained neurons
    const pb: number[] = [], pu: number[] = [], c: number[] = [], s: number[] = [];
    FOLDERS.forEach((f) => { for (let k = 0; k < 3; k++) {
      const jb = BRAIN_REGION_CENTER[f], ju = UNIVERSE_REGION_CENTER[f];
      pb.push(jb[0], jb[1], jb[2]); pu.push(ju[0], ju[1], ju[2]); c.push(...FOLDER_COLOR[f]); s.push(18 + k * 14);
    } });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pb.length), 3));
    g.setAttribute("aBrain", new THREE.BufferAttribute(new Float32Array(pb), 3));
    g.setAttribute("aUni", new THREE.BufferAttribute(new Float32Array(pu), 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(c), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(s), 1));
    this.glowU = { uMorph: { value: this.morph }, uPx: { value: this.pr() } };
    this.glow = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms: this.glowU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.glow.frustumCulled = false; this.glow.renderOrder = -1; this.scene.add(this.glow);
  }

  // ---------- decorative layers ----------
  private meshGeo(m: Mesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(m.pos), 3));
    g.setIndex(m.idx); g.computeVertexNormals(); return g;
  }
  /** Translucent two-hemisphere cortex shells + sulci contour lines + cerebellum/brainstem hints. Purely decorative. */
  private buildSilhouette() {
    const g = this.silhouette; g.userData.decorative = true; g.renderOrder = 1;
    const shell = (m: Mesh, col: number[]) => {
      const u = { uColor: { value: new THREE.Color(col[0], col[1], col[2]) }, uAlpha: { value: 1 }, uMorph: { value: 0 } }; this.shellU.push(u);
      const mesh = new THREE.Mesh(this.meshGeo(m), new THREE.ShaderMaterial({ vertexShader: SHELL_VS, fragmentShader: SHELL_FS, uniforms: u, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      mesh.frustumCulled = false; mesh.renderOrder = 0; g.add(mesh);
    };
    const lines = (arr: number[], col: number[], alpha: number) => {
      const u = { uColor: { value: new THREE.Color(col[0], col[1], col[2]) }, uAlpha: { value: alpha } }; this.lineU.push({ u, base: alpha });
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3));
      const l = new THREE.LineSegments(geo, new THREE.ShaderMaterial({ vertexShader: LINE_VS, fragmentShader: LINE_FS, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      l.frustumCulled = false; l.renderOrder = 0; g.add(l);
    };
    for (const side of [-1, 1]) {
      shell(cortexMesh(side), side < 0 ? [0.34, 0.5, 0.95] : [0.42, 0.46, 0.98]);
      lines(gyriLines(side), [0.5, 0.62, 0.95], 0.2);
    }
    shell(cerebellumMesh(), [0.5, 0.45, 0.9]); lines(cerebellumLines(), [0.5, 0.6, 0.95], 0.18);
    shell(brainstemMesh(), [0.45, 0.5, 0.9]);
    this.scene.add(g);
  }
  /** Note neurons: soma sphere + dendrite tree + axon (tube or line geometry), all positioned from one data texture. */
  private rebuildNeurons() {
    this.disposeObj(this.arbor); this.arbor = undefined; this.disposeObj(this.somas); this.somas = undefined; this.ntex?.tex.dispose(); this.ntex = null;
    this.morphs = []; this.noteNeuronSegments = 0; this.denSegments = 0;
    const nodes = this.graph.nodes, N = nodes.length; if (!N) return;
    const cx = complexityFor(N) * this.qs.carriers;
    const f = this.field;
    if (f) {
      const wnodes = nodes.map((nd) => ({ id: nd.id, folder: nd.folder, degree: nd.degree }));
      const r = makeNoteMorphs(f, wnodes, this.place, this.brainP, { carriers: cx, radiusMul: this.qs.tubeRadius, templates: this.opts.templates });
      this.morphs = r.morphs; this.noteClip = { cut: r.cut, dropped: r.dropped };
    } else {
      this.morphs = nodes.map((nd, i) => makeMorph(nd.id, { type: cellTypeFor(nd.id, this.place[i].region, nd.degree), reach: reachFor(nd.degree), hub: hubOf(nd.degree),
        normal: this.place[i].normal, depth: this.place[i].depth, carriers: cx, radiusMul: this.qs.tubeRadius, templates: this.opts.templates, maxPoints: Math.max(60, Math.round((240 + 360 * hubOf(nd.degree)) * cx)) }));
      this.noteClip = { cut: 0, dropped: 0 };
    }
    const nt = this.ntex = new NeuronTex(N);
    nodes.forEach((nd, i) => { nt.setPos(i, this.brainP, i * 3, this.uniP, i * 3); nt.setStyle(i, PALETTE.neuron[nd.folder], this.morphs[i].somaR); nt.setNormal(i, this.place[i].normal); nt.setType(i, this.morphs[i].type === "pyramidal" ? 1 : 0); });
    for (const m of this.morphs) { this.noteNeuronSegments += m.segments; this.denSegments += m.dendSegments; }
    const geo = buildNeuronGeo(this.morphs, { tube: this.qs.tube, radial: this.qs.radial, radiusMul: 1 });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(geo.pos, 3)); g.setAttribute("aNeuron", new THREE.BufferAttribute(geo.neuron, 1));
    g.setAttribute("aS", new THREE.BufferAttribute(geo.s, 1)); g.setAttribute("aInfo", new THREE.BufferAttribute(geo.info, 4));
    if (geo.nrm) g.setAttribute("normal", new THREE.BufferAttribute(geo.nrm, 3));
    if (geo.index) g.setIndex(new THREE.BufferAttribute(geo.index, 1));
    const mat = arborMaterial(this.sh, nt, this.qs.tube, this.qs.rest * PALETTE.restAlpha);
    this.arbor = this.qs.tube ? new THREE.Mesh(g, mat) : new THREE.LineSegments(g, mat);
    this.arbor.frustumCulled = false; this.arbor.renderOrder = 3; this.arbor.userData.decorative = true; this.scene.add(this.arbor);
    // soma spheres (instanced)
    const ico = new THREE.IcosahedronGeometry(1, Math.max(0, this.qs.somaDetail)), sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute("position", ico.getAttribute("position")); sg.instanceCount = N;
    sg.setAttribute("aNeuron", new THREE.InstancedBufferAttribute(Float32Array.from({ length: N }, (_, i) => i), 1));
    // The drag preview moves this contained body; the neuron texture keeps the last certified branches and links anchored until commit.
    sg.setAttribute("aBrain", new THREE.InstancedBufferAttribute(this.brainP, 3));
    sg.setAttribute("aUni", new THREE.InstancedBufferAttribute(this.uniP, 3));
    this.somas = new THREE.Mesh(sg, somaMaterial(this.sh, nt)); this.somas.frustumCulled = false; this.somas.renderOrder = 4; this.somas.userData.decorative = true; this.scene.add(this.somas);
  }
  /** Background neurons filling the tissue. Never pickable, never counted as notes/links, never connect two notes. */
  private rebuildDecor() {
    this.disposeObj(this.decor); this.decor = undefined; this.decorNeurons = 0; this.decorMorphs = []; this.decorPos = [];
    const count = this.qs.decorNeurons; if (!count) return;
    const morphs: Morph[] = [], offs: V3[] = [], rnd: number[] = [];
    const f = this.field;
    if (f && this.asset) {
      const { cells, cut, dropped } = makeDecor(f, count, this.qs.carriers, (r) => { const t = this.asset!.tissuePoint(r, 0.03, 0.16); return { pos: t.pos, normal: t.normal }; });
      this.decorClip = { cut, dropped };
      for (const cell of cells) { morphs.push(cell.morph); offs.push(cell.pos); rnd.push(cell.rand); }
    } else {
      this.decorClip = { cut: 0, dropped: 0 };
      for (let k = 0; k < count; k++) {
        const r = rng(fnv("decor:" + k)); let pos: V3, normal: V3;
        if (this.asset) { const t = this.asset.tissuePoint(r, 0.03, 0.16); pos = t.pos; normal = t.normal; }
        else if (r() < 0.14) { const z = 2 * r() - 1, a = r() * 6.283, sq = Math.sqrt(1 - z * z), kk = 0.3 + 0.6 * Math.cbrt(r());
          pos = [CB_C[0] + CB_R[0] * kk * sq * Math.cos(a), CB_C[1] + CB_R[1] * kk * z, CB_C[2] + CB_R[2] * kk * sq * Math.sin(a)]; normal = [Math.cos(a) * sq, z, Math.sin(a) * sq]; }
        else { const d = dirInBand(r, -1, 1); pos = cortexPoint(d[0], d[1], d[2], r() < 0.5 ? -1 : 1, 0.6 + 0.4 * r()); normal = cortexNormal(pos); }
        const q = Math.max(6, Math.round(11 * this.qs.carriers));
        morphs.push(decorMorph(String(k), (0.05 + 0.04 * r()) * PALETTE.decorScale, normal, q)); offs.push(pos); rnd.push(r());
      }
    }
    const geo = buildNeuronGeo(morphs, { tube: false, radial: 0, radiusMul: 1, offsets: offs, rand: rnd });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(geo.pos, 3)); g.setAttribute("aS", new THREE.BufferAttribute(geo.s, 1)); g.setAttribute("aInfo", new THREE.BufferAttribute(geo.info, 4));
    this.decor = new THREE.LineSegments(g, decorMaterial(this.sh, this.qs.decorAlpha * PALETTE.decorAlpha / 0.2)); this.decor.frustumCulled = false; this.decor.renderOrder = 1; this.decor.userData.decorative = true; this.scene.add(this.decor);
    this.decorNeurons = count; this.decorMorphs = morphs; this.decorPos = offs;
  }
  private writeSomaPos(i: number) { this.ntex?.setPos(i, this.brainP, i * 3, this.uniP, i * 3); }
  private syncShared() { const on = this.pulsesOn; this.sh.uStatic.value = on ? 0 : 1; this.applyGate(); }
  /** Why emission is closed ("" = open). Evaluated every frame: paused, intro, morph/universe, no validated field, or a leak found in the rendered geometry. */
  private evalGate(): string {
    if (!this.pulsesOn) return "paused";
    if (this.introProgress < 1) return "intro";
    if (this.mode !== "brain" || this.target !== 0 || this.morph > 0) return "morph";
    if (!this.asset) return "noasset"; // missing GLB: no real tissue to keep impulses in, fail closed
    {
      if (!this.asset.field || (this.asset as any).fieldVerified !== true) return "field";
      if (this.containStats.geomOutside > 0 || this.containStats.pulseOutside > 0 || this.containStats.extentOutside > 0 || this.containStats.boltOutside > 0) return "leak";
    }
    return "";
  }
  /** Single shared enable for every shader that draws impulses (uAnim). Closing also clears sim + lingering shader events (clock jump past every event window). */
  private applyGate() {
    const why = this.evalGate(), open = why === "";
    if (this.gateOpen && !open) { this.pulseClock += 11; this.sim?.reset(this.pulseClock); }
    this.gateOpen = open; this.gateReason = why || "open"; this.sh.uAnim.value = open ? 1 : 0;
  }
  setPulses(on: boolean) { this.invalidate(); this.pulsesOn = on; this.syncShared(); }
  /** Test/stress hook (pixel containment sweeps): draw EVERY precomputed bolt at once, independent of the scheduler. Never used by the UI. */
  setBoltForce(on: boolean) { this.boltL?.setForce(on); this.boltA?.setForce(on); }
  /** Lightning counters (tests, diag): channels, strikes so far, the largest number of strike onsets seen in any 1 s window, and what is in flight. */
  lightning() {
    const s = this.sim;
    return { ready: this.boltsReady, prewarmMs: this.boltStats.prewarmMs, linkBolts: this.boltL?.bolts.length ?? 0, ambientBolts: this.boltA?.bolts.length ?? 0, linkSegments: this.boltStats.linkSegments, ambientSegments: this.boltStats.ambientSegments, buildMs: Math.round(this.boltStats.ms),
      strikes: s?.strikes ?? 0, restrikes: s?.restrikes ?? 0, rateMax: s?.rateMax ?? 0, bigRateMax: s?.bigRateMax ?? 0, capPerSec: s?.rates.capPerSec ?? 0, bigPerSec: s?.rates.bigPerSec ?? 0, reduced: !!s?.rates.reduced,
      linkInFlight: this.boltL?.inFlight ?? 0, ambientInFlight: this.boltA?.inFlight ?? 0, ambientLog: (s?.ambientLog ?? []).length, bins: this.ambientSet ? this.ambientSet.bolts.reduce((a, b) => { a[b.bin] = (a[b.bin] ?? 0) + 1; return a; }, {} as Record<number, number>) : {} };
  }
  /** Oriented fibres that can carry an impulse, as (source note index, target note index). Exactly one per real graph edge. */
  impulsePaths(): [number, number][] { return this.sim?.paths() ?? []; }
  /** (source, target) of every impulse launched along a fibre so far (bounded log; test hook). */
  impulseLog(): [number, number][] { return (this.sim?.log ?? []).map(([f]) => [this.fibres[f].src, this.fibres[f].dst]); }
  /** Absolute brain-space positions of dendrite tips, axon terminals (note neurons) and decor tips: test hook for the soma-only picking rule. */
  arborPoints(max = 60) {
    const dendrite: V3[] = [], axon: V3[] = [], decor: V3[] = [];
    this.morphs.forEach((m, i) => { for (const k of m.dendTips) if (dendrite.length < max) dendrite.push([this.brainP[i * 3] + m.pos[k * 3], this.brainP[i * 3 + 1] + m.pos[k * 3 + 1], this.brainP[i * 3 + 2] + m.pos[k * 3 + 2]]);
      for (const k of m.axonTerminals) if (axon.length < max) axon.push([this.brainP[i * 3] + m.pos[k * 3], this.brainP[i * 3 + 1] + m.pos[k * 3 + 1], this.brainP[i * 3 + 2] + m.pos[k * 3 + 2]]); });
    this.decorMorphs.forEach((m, i) => { for (const k of m.dendTips.concat(m.axonTerminals)) if (decor.length < max) decor.push([this.decorPos[i][0] + m.pos[k * 3], this.decorPos[i][1] + m.pos[k * 3 + 1], this.decorPos[i][2] + m.pos[k * 3 + 2]]); });
    return { dendrite, axon, decor };
  }
  /** Mindcorpus-style tissue sparkle: tiny spectral points on the real brain surface (area-weighted, deterministic seed). */
  private sparkle?: THREE.Points;
  private buildSparkle() {
    this.disposeObj(this.sparkle); this.sparkle = undefined; if (!this.asset || !this.renderer) return;
    const f = this.field; if (!f) return;
    const smp = this.asset.surfaceSamples(this.qs.sparkle, 0x5a4c1e);
    // surface samples sit just above the pial surface; pull them below the margin so no sparkle glows outside the brain
    const ins = insetSurfacePoints(f, smp.pos, smp.nrm, smp.rand, f.margin + 0.5 * f.h);
    this.sparkleDropped = ins.dropped;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(ins.pos, 3)); g.setAttribute("aNrm", new THREE.BufferAttribute(ins.nrm, 3)); g.setAttribute("aRand", new THREE.BufferAttribute(ins.rand, 1));
    this.sparkle = new THREE.Points(g, sparkleMaterial(this.sh, this.pr(), 1.7)); this.sparkle.frustumCulled = false; this.sparkle.renderOrder = 1; this.sparkle.userData.decorative = true; this.scene.add(this.sparkle);
    this.sparkleCount = ins.count;
  }
  sparkleCount = 0;
  // ---------- intro grow-in ----------
  private assetParts: { name: string; u: any }[] = [];
  private introStart = 0; introProgress = 1; private introDur = 2500;
  private startIntro() {
    const w = window as any; if (this.reduce || this.opts.intro === false || w.__paIntroPlayed || !this.asset) { this.endIntro(); return; }
    w.__paIntroPlayed = true; this.introStart = performance.now(); this.introProgress = 0; this.applyIntro(); this.invalidate(30);
  }
  private endIntro() { this.introProgress = 1; this.applyIntro(); }
  private applyIntro() {
    const p = this.introProgress, ymin = this.asset?.bbox.min.y ?? -1, ymax = this.asset?.bbox.max.y ?? 1, k = (x: number) => Math.max(0, Math.min(1, x));
    for (const { name, u } of this.assetParts) {
      if (p >= 1) { u.uFade.value = 1; u.uRevealY.value = 99; continue; }
      if (name === "brainstem" || name === "spinal_cord") { u.uFade.value = k(p / 0.25); u.uRevealY.value = 99; }
      else if (name === "cerebellum") { u.uFade.value = k((p - 0.18) / 0.25); u.uRevealY.value = 99; }
      else { u.uFade.value = k((p - 0.35) / 0.1); u.uRevealY.value = ymin + k((p - 0.4) / 0.5) * (ymax - ymin + 0.3); }
    }
    const live = p >= 0.92; for (const o of [this.arbor, this.somas, this.edges, this.decor, this.stars, this.sparkle, this.linkBolts, this.ambientBolts]) if (o) o.visible = live;
  }
  private tickIntro(now: number) { if (this.introProgress >= 1) return; this.introProgress = Math.min(1, (now - this.introStart) / this.introDur); this.applyIntro(); this.invalidate(2); }
  // ---------- quality / bloom ----------
  private disposeComposer() {
    this.composer?.passes.forEach((p: { dispose(): void }) => p.dispose());
    this.composer?.dispose(); this.composer = null; this.bloomPass = null;
  }
  private setupComposer() {
    if (!this.renderer) return;
    this.disposeComposer();
    if (!this.qs.bloom) { this.renderer.toneMapping = THREE.NoToneMapping; return; }
    const c = new EffectComposer(this.renderer); // HalfFloat HDR, with a per-sample tissue stencil written by the depth prepass
    try {
      for (const target of [c.renderTarget1, c.renderTarget2]) {
        target.stencilBuffer = true; target.samples = this.qs.msaa;
        // Only colour is sampled. The additive blend reuses the original multisample stencil, not a resolved depth/stencil copy.
        target.resolveDepthBuffer = false; target.resolveStencilBuffer = false;
      }
      c.addPass(new RenderPass(this.scene, this.camera));
      const bp = new UnrealBloomPass(new THREE.Vector2(256, 256), this.qs.bloomStrength, this.qs.bloomRadius, this.qs.bloomThreshold);
      // These passes only filter a fullscreen quad; no depth buffer is read or written by the effect.
      for (const target of [bp.renderTargetBright, ...bp.renderTargetsHorizontal, ...bp.renderTargetsVertical]) target.depthBuffer = false;
      // Restrict only the pass's additive blend; do not clip or alter base colours, bright cores, or the blur itself.
      bp.blendMaterial.stencilFunc = THREE.EqualStencilFunc; bp.blendMaterial.stencilRef = 1;
      c.addPass(bp); c.addPass(new OutputPass()); this.composer = c; this.bloomPass = bp;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = PALETTE.exposure;
      this.sizeComposer();
    } catch {
      c.passes.forEach((p: { dispose(): void }) => p.dispose()); c.dispose();
      this.composer = null; this.bloomPass = null; this.renderer.toneMapping = THREE.NoToneMapping;
    }
  }
  private sizeComposer() {
    if (!this.composer || !this.renderer) return;
    const c = this.opts.container, w = Math.max(50, c.clientWidth), h = Math.max(50, c.clientHeight), pr = this.pr();
    this.composer.setPixelRatio(pr); this.composer.setSize(w, h);
    this.bloomPass?.setSize(Math.round(w * pr * this.qs.bloomScale), Math.round(h * pr * this.qs.bloomScale));
  }
  /** Live tuning hook for the style pass (bloom strength/radius/threshold and tone-mapping exposure). */
  tuneBloom(o: { strength?: number; radius?: number; threshold?: number; exposure?: number }) {
    const b = this.bloomPass; if (b) { if (o.strength !== undefined) b.strength = o.strength; if (o.radius !== undefined) b.radius = o.radius; if (o.threshold !== undefined) b.threshold = o.threshold; }
    if (o.exposure !== undefined && this.renderer) this.renderer.toneMappingExposure = o.exposure; this.invalidate(6);
  }
  setQuality(q: Quality) {
    if (q === this.quality || !QUALITY[q]) return;
    this.cancelPreview();
    this.quality = q; this.qs = lodByCount(QUALITY[q], this.graph.nodes.length); this.invalidate(12);
    if (!this.renderer) return;
    this.setupComposer(); this.buildSparkle(); for (const p of this.assetParts) p.u.uMicro.value = this.qs.micro && p.name !== "brainstem" && p.name !== "spinal_cord" ? 1 : 0;
    if (this.graph.nodes.length) this.rebuildAll();
  }
  /** Swap in the real brain meshes (parsed GLB) or go back to the procedural scaffold (null). Notes are re-placed inside the cortex volume. */
  setBrainAsset(a: BrainAsset | null) {
    if (this.asset === a) return;
    this.invalidate(12);
    this.assetGroup.clear(); this.assetU = []; this.assetParts = []; this.asset?.dispose(); this.asset = a;
    this.router = null; this.linkPlans = []; this.regions = [];
    if (a) {
      const lowMicro = !this.qs.micro;
      for (const mesh of Object.values(a.meshes)) {
        const smooth = mesh.name === "brainstem" || mesh.name === "spinal_cord"; // smooth tissue: no ridge pattern (no cavity relief or micro noise)
        const bm = brainMaterials(PALETTE.brainBase, PALETTE.brainRim, !lowMicro, smooth); this.assetParts.push({ name: mesh.name, u: bm.uniforms });
        const pre = new THREE.Mesh(mesh.geometry, bm.pre); pre.frustumCulled = false; pre.renderOrder = -50; pre.matrixAutoUpdate = false; pre.matrix.copy(mesh.matrixWorld); pre.userData.decorative = true; this.assetGroup.add(pre);
        mesh.material = bm.shell; mesh.renderOrder = 0; mesh.frustumCulled = false; this.assetU.push(bm.uniforms);
      }
      this.assetGroup.add(a.group);
    }
    this.assetGroup.visible = !!a; this.sh.uOcc.value = a ? 1 : 0; this.buildSparkle();
    if (this.renderer && this.graph.nodes.length) this.setGraph(this.graph, this.positions);
    if (a) this.startIntro(); // after the (blocking) layout rebuild, so the grow-in plays its full length
  }
  private rebuildLabels() {
    this.labelLayer.innerHTML = ""; this.labels = {};
    // folder names live in the legend only (no floating region labels); hover labels are created elsewhere
  }
  /** Samples (<= 0.5 voxel) of the whole emission path: source terminal chain, polyline actually drawn, target tip chain. s/o = all, sp = polyline only. */
  private planOutside(pl: LinkPlan, pts: V3[]): { s: number; o: number; sp: number; op: number } {
    const f = this.field!, M = f.margin - 1e-4, step = f.h * 0.5, r = { s: 0, o: 0, sp: 0, op: 0 };
    const seg = (a: ArrayLike<number>, b: ArrayLike<number>, poly: boolean) => { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / step)); for (let s = 0; s <= n; s++) { const u = s / n, bad = f.depthE(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u) < M; r.s++; if (bad) r.o++; if (poly) { r.sp++; if (bad) r.op++; } } };
    const chain = (m: Morph, k: number, who: number) => { const B = [this.brainP[who * 3], this.brainP[who * 3 + 1], this.brainP[who * 3 + 2]]; for (let i = k; i > 0; i = m.parent[i]) { const q = m.parent[i]; seg([B[0] + m.pos[q * 3], B[1] + m.pos[q * 3 + 1], B[2] + m.pos[q * 3 + 2]], [B[0] + m.pos[i * 3], B[1] + m.pos[i * 3 + 1], B[2] + m.pos[i * 3 + 2]], false); } };
    chain(this.morphs[pl.src], pl.term, pl.src); chain(this.morphs[pl.dst], pl.tip, pl.dst);
    for (let k = 1; k < pts.length; k++) seg(pts[k - 1], pts[k], true);
    return r;
  }
  /** Measure the actual clearance of the rendered geometry classes at <= 0.5 voxel against the exact BVH distance (real counts for diag, never hardcoded). */
  private measureClearance() {
    const f = this.field, L = this.linkStats;
    this.containStats = { geomSamples: 0, geomOutside: 0, pulseSamples: 0, pulseOutside: 0, extentSamples: 0, extentOutside: 0, boltSamples: 0, boltOutside: 0 };
    if (!f) return;
    const M = f.margin - 1e-4, step = f.h * 0.5, c = { s: 0, o: 0 }, by = { soma: 0, arbor: 0, decor: 0, sparkle: 0 }, x = { s: 0, o: 0 }, mul = this.qs.tube ? this.qs.tubeRadius : 0;
    const outside = (px: number, py: number, pz: number) => f.depthE(px, py, pz) < M;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      const l = Math.hypot(bx - ax, by - ay, bz - az), n = Math.max(1, Math.ceil(l / step));
      for (let s = 0; s <= n; s++) { const u = s / n; c.s++; if (outside(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u)) c.o++; }
    };
    const walk = (m: Morph, base: V3, rad: boolean) => { for (let k = 1; k < m.n; k++) { const p = m.parent[k]; seg(base[0] + m.pos[p * 3], base[1] + m.pos[p * 3 + 1], base[2] + m.pos[p * 3 + 2], base[0] + m.pos[k * 3], base[1] + m.pos[k * 3 + 1], base[2] + m.pos[k * 3 + 2]); if (rad && mul) { x.s++; if (m.rad[k] * mul > f.margin) x.o++; } } };
    for (let i = 0; i < this.graph.nodes.length; i++) {
      const P: V3 = [this.brainP[i * 3], this.brainP[i * 3 + 1], this.brainP[i * 3 + 2]]; c.s++; if (outside(P[0], P[1], P[2])) { c.o++; by.soma++; }
      x.s++; if (f.depthE(P[0], P[1], P[2]) < this.morphs[i].somaR - 1e-4) x.o++; // soma ball extent, not just its centre
      { const o0 = c.o; walk(this.morphs[i], P, true); by.arbor += c.o - o0; }
    }
    { const o0 = c.o; for (let i = 0; i < this.decorMorphs.length; i++) walk(this.decorMorphs[i], this.decorPos[i], false); by.decor = c.o - o0; }
    if (this.sparkle) { const pos = this.sparkle.geometry.getAttribute("position"); for (let i = 0; i < pos.count; i++) { c.s++; if (outside(pos.getX(i), pos.getY(i), pos.getZ(i))) { c.o++; by.sparkle++; } } }
    this.outsideBy = by;
    // shader-expanded classes (ribbon, star/sparkle/dust points) are capped in world units by sh.uWMax = 0.5 * margin, so their extent beyond a checked centre is < margin
    // lightning: every segment of every precomputed bolt (link main channels + forks, ambient channels + forks) at <= 0.5 voxel; the ribbon around it is capped at uWMax
    let bs = 0, bo = 0; for (const layer of [this.boltL, this.boltA]) if (layer) for (const b of layer.bolts) { const r = sampleBolt(f, b, step, M); bs += r.main + r.fork; bo += r.mainOut + r.forkOut; }
    this.boltStats.samples = bs; this.boltStats.outside = bo;
    this.containStats = { geomSamples: c.s + L.gs, geomOutside: c.o + L.go, pulseSamples: L.ps, pulseOutside: L.po, extentSamples: x.s, extentOutside: x.o, boltSamples: bs, boltOutside: bo };
  }

  // ---------- state ----------
  private pr() { return Math.min(2, window.devicePixelRatio || 1); }
  setMode(m: Mode, instant = false) {
    if (m !== this.mode) this.cancelPreview();
    this.invalidate();
    this.mode = m; this.target = m === "brain" ? 0 : 1;
    if (instant || this.reduce) { this.morph = this.target; }
    else { this.morphFrom = this.morph; this.morphStart = performance.now(); }
    // camera ease to a sensible framing distance
    if (this.controls) {
      const dir = this.camera.position.clone().sub(this.controls.target);
      const dTo = m === "brain" ? DEFAULT_CAM.dist : 12;
      const to = m === "brain" ? new THREE.Vector3(...DEFAULT_CAM.target) : new THREE.Vector3(0, 0, 0);
      if (instant || this.reduce) { this.controls.target.copy(to); this.camera.position.copy(to).add(dir.setLength(dTo)); }
      else this.camTween = { t0: performance.now(), dur: this.opts.morphMs ?? 2400, from: this.controls.target.clone(), to, df: dir.length(), dt: dTo };
    }
  }
  toggleMode() { this.setMode(this.mode === "brain" ? "universe" : "brain"); }
  setAutoRotate(v: boolean) { this.invalidate(); if (this.controls) this.controls.autoRotate = v; }
  setEdit(v: boolean) { this.edit = v; this.canvas.classList.toggle("pa-edit", v); }
  /** With damping on, OrbitControls keeps applying the rest of the last orbit/pan for a while; one undamped update consumes that inertia so a
   *  programmatic camera pose (Reset view, setCamera) stays where it was put instead of drifting (stars sliding under the cursor). */
  private stopInertia() { const c = this.controls; if (!c) return; const damp = c.enableDamping; c.enableDamping = false; c.update(); c.enableDamping = damp; }
  resetView() { this.setMode(this.mode); this.camTween = null; if (this.controls) { this.stopInertia(); if (this.mode === "brain") { this.controls.target.set(...DEFAULT_CAM.target); this.camera.position.set(...DEFAULT_CAM.pos); } else { this.controls.target.set(0, 0, 0); this.camera.position.set(0.55, 0.35, 0.8).setLength(12); } } }
  setSearch(q: string) { this.invalidate(); this.query = q.trim().toLowerCase(); this.applyQuery(); }
  private applyQuery() {
    const q = this.query;
    this.matches = [];
    this.graph.nodes.forEach((n, i) => { if (!q || (n.title + " " + n.id + " " + n.folder).toLowerCase().includes(q)) this.matches.push(i); });
    if (this.stars) {
      const a = this.stars.geometry.getAttribute("aState") as THREE.BufferAttribute;
      const set = new Set(this.matches);
      for (let i = 0; i < a.count; i++) { const v = !q ? 1 : set.has(i) ? 1.45 : 0.22; a.setX(i, v); this.ntex?.setState(i, v); }
      a.needsUpdate = true; if (this.ntex) this.ntex.tex.needsUpdate = true;
    }
  }
  indexOf(path: string) { return this.graph.nodes.findIndex((n) => n.id === path); }
  setFocus(i: number, fly = false) {
    this.focus = i; this.updateFocusUniform();
    if (fly && i >= 0 && this.controls) {
      const p = this.starPos(i);
      this.camTween = { t0: performance.now(), dur: 900, from: this.controls.target.clone(), to: p, df: this.camera.position.distanceTo(this.controls.target), dt: Math.min(this.camera.position.distanceTo(this.controls.target), this.mode === "brain" ? 3.2 : 7) };
    }
  }
  /** Jump the camera (deterministic framing for screenshots and presets). */
  setCamera(pos: V3, target: V3) { this.camTween = null; if (this.controls) { this.controls.autoRotate = false; this.stopInertia(); this.controls.target.set(...target); this.camera.position.set(...pos); this.controls.update(); } this.invalidate(12); }
  /** Diagnostic: draw one asset mesh with a plain lit standard material (separates mesh problems from shader problems). */
  debugPlainMaterial(name: string) { const m = this.asset?.meshes[name]; if (!m) return false; m.material = new THREE.MeshStandardMaterial({ color: 0x8890b0, roughness: 0.8 }); if (!this.scene.children.some((c) => c.type === "DirectionalLight")) { this.scene.add(new THREE.DirectionalLight(0xffffff, 2.5), new THREE.AmbientLight(0x404060, 1)); } this.invalidate(10); return true; }
  /** Named deterministic camera presets: overview (three-quarter lateral, whole brain), closeup (hub neuron), top. */
  preset(name: "overview" | "closeup" | "impulses" | "top" | "underside") {
    if (name === "overview") return this.setCamera(DEFAULT_CAM.pos, DEFAULT_CAM.target);
    if (name === "underside") return this.setCamera([-1.1, -2.1, -2.0], [0, -0.35, -0.4]);
    if (name === "impulses") return this.setCamera([1.5, 0.4, 0.9], [0, 0, 0.1]);
    if (name === "top") return this.setCamera([0, 3.6, 0.01], [0, 0, 0]);
    let b = 0; this.graph.nodes.forEach((n, i) => { if (n.degree > this.graph.nodes[b].degree || (n.degree === this.graph.nodes[b].degree && this.brainP[i * 3] > this.brainP[b * 3] && this.place[i]?.region === "cortex")) b = i; });
    const p = this.starPos(b), nn = this.place[b]?.normal ?? [0, 1, 0], up = Math.abs(nn[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t: V3 = [p.x + nn[0] * 0.04, p.y + nn[1] * 0.04, p.z + nn[2] * 0.04];
    const sd: V3 = [nn[1] * up[2] - nn[2] * up[1], nn[2] * up[0] - nn[0] * up[2], nn[0] * up[1] - nn[1] * up[0]], sl = Math.hypot(...sd) || 1;
    this.setCamera([t[0] + nn[0] * 0.42 + sd[0] / sl * 0.55, t[1] + nn[1] * 0.42 + sd[1] / sl * 0.55, t[2] + nn[2] * 0.42 + sd[2] / sl * 0.55], t);
    return b;
  }
  starPos(i: number, out = new THREE.Vector3()) {
    const m = this.morph, b = this.brainP, u = this.uniP;
    return out.set(b[i * 3] * (1 - m) + u[i * 3] * m, b[i * 3 + 1] * (1 - m) + u[i * 3 + 1] * m, b[i * 3 + 2] * (1 - m) + u[i * 3 + 2] * m);
  }
  screenOf(i: number, rect?: DOMRect): { x: number; y: number; z: number } {
    const v = this.starPos(i).project(this.camera);
    const r = rect ?? this.canvas.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height, z: v.z };
  }
  screenOfPath(path: string) { const i = this.indexOf(path); return i < 0 ? null : this.screenOf(i); }
  pick(cx: number, cy: number, rad = 14): number {
    let best = -1, bd = 1e9;
    const hits = this.matches.length && this.query ? new Set(this.matches) : null;
    const rect = this.canvas.getBoundingClientRect();
    for (let i = 0; i < this.graph.nodes.length; i++) {
      if (hits && !hits.has(i)) continue;
      const s = this.screenOf(i, rect);
      if (s.z > 1 || s.z < -1) continue;
      const d = Math.hypot(s.x - cx, s.y - cy) + s.z * 3;
      if (Math.hypot(s.x - cx, s.y - cy) <= rad && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ---------- input ----------
  private onDown = (e: PointerEvent) => {
    const i = this.pick(e.clientX, e.clientY);
    if (e.pointerType !== "touch") { this.ptr = { x: e.clientX, y: e.clientY }; this.hoverKey = this.hoverViewKey(); this.setHover(i); } // the tooltip names exactly the note this press opens or drags
    this.drag = { idx: i, moved: false, sx: e.clientX, sy: e.clientY };
    if (this.edit && i >= 0 && this.controls && (this.morph < 0.01 || this.morph > 0.99)) { this.controls.enabled = false; this.canvas.setPointerCapture?.(e.pointerId); }
  };
  private onMove = (e: PointerEvent) => {
    this.ptr = e.pointerType === "touch" ? null : { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (d && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
    if (d && !this.controls?.enabled && d.idx >= 0) { this.dragStar(d.idx, e); return; }
    if (e.buttons) return;
    this.hoverKey = this.hoverViewKey(); this.setHover(this.pick(e.clientX, e.clientY));
  };
  private onLeave = () => { this.ptr = null; if (!this.drag) this.setHover(-1); };
  private setHover(i: number) { if (i !== this.hover) { this.hover = i; this.canvas.style.cursor = i >= 0 ? "pointer" : ""; this.opts.onHover?.(i); this.updateFocusUniform(); } }
  /** Everything pick() depends on besides the pointer: camera matrices, morph, soma positions, search filter, canvas rect. */
  private hoverViewKey(r = this.canvas.getBoundingClientRect()) {
    return `${this.camera.matrixWorldInverse.elements.join()}|${this.camera.projectionMatrix.elements.join()}|${this.morph}|${this.posRev}|${this.query}|${this.matches.length}|${r.left},${r.top},${r.width},${r.height}`;
  }
  /** Stars move under a still cursor (autorotate, orbit inertia, camera tweens, morph). Before each render the hover is re-resolved at the last pointer
   *  position, so the tooltip, the highlight and the next click all name the star under the cursor in the frame being drawn. */
  private trackHover() {
    if (!this.ptr || this.drag) return;
    const k = this.hoverViewKey(); if (k === this.hoverKey) return;
    this.hoverKey = k; this.setHover(this.pick(this.ptr.x, this.ptr.y));
  }
  private onUp = (e: PointerEvent) => {
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (this.controls && !this.controls.enabled) {
      this.controls.enabled = true;
      if (d.moved && this.preview?.i === d.idx) {
        const a = this.mode === "brain" ? this.brainP : this.uniP, i = d.idx * 3;
        this.setStarPosition(d.idx, [a[i], a[i + 1], a[i + 2]]);
      } else this.cancelPreview();
      return;
    }
    if (!d.moved && d.idx >= 0 && e.target === this.canvas) this.opts.onOpen(this.graph.nodes[d.idx].id);
  };
  private onCancel = () => {
    this.drag = null;
    this.cancelPreview();
    if (this.controls) this.controls.enabled = true;
  };
  private markSomaPosition(mode: Mode) {
    const attr = mode === "brain" ? "aBrain" : "aUni"; this.posRev++;
    for (const o of [this.stars, this.somas]) if (o) o.geometry.getAttribute(attr).needsUpdate = true;
  }
  private cancelPreview() {
    const p = this.preview; if (!p) return;
    this.preview = null; this.holdCell(p.i, false);
    (p.mode === "brain" ? this.brainP : this.uniP).set(p.original, p.i * 3);
    this.markSomaPosition(p.mode); this.invalidate();
  }
  /** Edit-drag preview: the moved cell's arbor, its incident fibres and their impulses are not drawn (their geometry was clipped/routed for the old
   *  position) until release re-clips the arbor and re-routes the links; every other cell keeps its certified geometry and keeps pulsing. */
  private holdCell(i: number, on: boolean) {
    this.ntex?.setHidden(i, on);
    const ft = this.ftex; if (ft) this.fibres.forEach((fb, f) => { if (fb.src === i || fb.dst === i) { ft.setHidden(f, on); this.boltL?.setHidden(f, on); } });
    this.invalidate();
  }
  private dragStar(i: number, e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.camera);
    const p = this.starPos(i);
    const n = this.camera.getWorldDirection(new THREE.Vector3());
    const hit = rc.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, p), new THREE.Vector3());
    if (hit) { this.setStarPosition(i, [hit.x, hit.y, hit.z], false); }
  }
  /** Public so tests/UI can set a position; mode decides which layout is overridden. */
  setStarPosition(i: number, p: V3, commit = true) {
    const id = this.graph.nodes[i]?.id;
    if (!id || !p.every(Number.isFinite)) return;
    if (commit || this.preview?.i !== i || this.preview.mode !== this.mode) this.cancelPreview();
    const f = this.mode === "brain" ? this.field : null, a = this.mode === "brain" ? this.brainP : this.uniP, k = i * 3;
    const q = f ? containPoint(f, p, somaNeed(f, this.graph.nodes[i].degree)).p : p;
    if (f && !(f.depthE(q[0], q[1], q[2]) >= f.margin)) return; // projection failed: the soma keeps its last contained position
    if (!commit && !this.preview) { this.preview = { i, mode: this.mode, original: [a[k], a[k + 1], a[k + 2]] }; this.holdCell(i, true); }
    a.set(q, k); this.markSomaPosition(this.mode); this.invalidate();
    if (!commit) return; // no save, no translation of the certified arbor, no stale fibre endpoints
    const o = (this.positions[id] ||= {}); o[this.mode] = q;
    if (f) {
      const g: V3 = [0, 0, 0]; f.grad(q[0], q[1], q[2], g);
      const pl = this.place[i], normal: V3 = g.some(Boolean) ? [-g[0], -g[1], -g[2]] : pl.normal;
      this.place[i] = { ...pl, pos: q, normal, depth: f.depth(q[0], q[1], q[2]) };
      const b = f.bridges[0], cx = b ? (b.a[0] + b.b[0]) / 2 : 0;
      this.regions[i] = pl.region === "cerebellum" ? "C" : q[0] < cx ? "L" : "R";
      this.rebuildNeurons(); this.updateFocusUniform(); this.applyQuery();
    } else this.writeSomaPos(i);
    this.rebuildEdges(); this.measureClearance(); this.syncShared(); this.sim?.kick(i, this.pulseClock); this.opts.onPositions?.(this.positions); // the re-routed links arc soon after release
  }
  resetPositions() { this.positions = {}; this.setGraph(this.graph, {}); this.opts.onPositions?.(this.positions); }
  /** Progressive disclosure (Visualization in Connectomics, arXiv:1206.1428): the hovered/selected neuron and its REAL neighbours stay lit, the rest dims. */
  private updateFocusUniform() {
    const f = this.hover >= 0 ? this.hover : this.focus;
    if (this.starU) { this.starU.uFocus.value = f; this.starU.uDimOn.value = f >= 0 ? 1 : 0; }
    if (this.edgeU) this.edgeU.uFocus.value = f;
    this.sh.uDimOn.value = f >= 0 ? 1 : 0; this.focusU.value = f;
    this.near.fill(f >= 0 ? 0 : 1);
    if (f >= 0 && this.adj[f]) { this.near[f] = 1; for (const j of this.adj[f]) this.near[j] = 1; }
    this.nearCount = 0; for (let i = 0; i < this.near.length; i++) this.nearCount += this.near[i];
    if (this.stars) (this.stars.geometry.getAttribute("aNear") as THREE.BufferAttribute).needsUpdate = true;
    this.labelIdx = f < 0 || !this.adj[f] ? [] : [f, ...[...this.adj[f]].sort((a, b) => this.graph.nodes[b].degree - this.graph.nodes[a].degree || a - b).slice(0, 12)];
    if (this.ntex) { for (let i = 0; i < this.near.length; i++) this.ntex.setNear(i, this.near[i]); this.ntex.tex.needsUpdate = true; }
    if (this.sim) this.sim.focus = f;
  }

  // ---------- frame ----------
  private resize() {
    if (!this.renderer) return;
    const c = this.opts.container, w = Math.max(50, c.clientWidth), h = Math.max(50, c.clientHeight);
    this.renderer.setPixelRatio(this.pr()); this.renderer.setSize(w, h, false);
    this.canvas.style.width = "100%"; this.canvas.style.height = "100%";
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.invalidate(6);
    const px = this.pr();
    for (const u of [this.starU, this.dustU, this.glowU]) if (u) u.uPx.value = px;
    if (this.sparkle) (this.sparkle.material as any).uniforms.uPx.value = px;
    this.sizeComposer(); if (this.fibreRes) { this.fibreRes.set(this.canvas.width, this.canvas.height); this.edgeU.uW.value = 4 * px; }
    for (const b of [this.boltL, this.boltA]) b?.setRes(this.canvas.width, this.canvas.height, px, this.boltWidth() * (b === this.boltA ? 0.9 : 1));
  }
  /** Ask for a few more frames (called on any visual change). */
  invalidate(n = 3) { this.dirtyWarm = Math.max(this.dirtyWarm, n); this.lastInvalidate = performance.now(); }
  /** True when nothing continuously animates. */
  isIdleState() {
    return this.introProgress >= 1 && !this.pulsesOn && !this.controls?.autoRotate && this.morph === this.target && !this.camTween;
  }
  private visibleOnScreen() { return !document.hidden && this.opts.container.clientWidth > 0 && this.opts.container.clientHeight > 0; }
  private signature() {
    const c = this.camera, t = this.controls?.target;
    return [this.focus, this.hover, this.query, this.matches.length, this.mode, this.pulsesOn, this.edit, c.position.x, c.position.y, c.position.z, t?.x, t?.y, t?.z].join("|");
  }
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.loops++;
    if (!this.visibleOnScreen()) { this.skipped++; this.lastNow = 0; return; } // hidden tab / hidden leaf: do not render
    const sg = this.signature(); if (sg !== this.sig) { this.sig = sg; this.invalidate(); }
    if (this.controls?.update()) this.invalidate(); // damping still settling
    if (this.isIdleState() && this.dirtyWarm <= 0) { this.skipped++; this.lastNow = 0; return; }
    if (this.dirtyWarm > 0) this.dirtyWarm--;
    this.frame(performance.now());
  };
  frame(now: number) {
    if (!this.renderer) return;
    if (this.morph !== this.target) {
      const dur = this.opts.morphMs ?? 2400;
      const t = Math.min(1, (now - this.morphStart) / dur);
      this.morph = this.morphFrom + (this.target - this.morphFrom) * ease(t);
      if (t >= 1) this.morph = this.target;
    }
    if (this.camTween && this.controls) {
      const k = Math.min(1, (now - this.camTween.t0) / this.camTween.dur), e = ease(k), tw = this.camTween;
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.controls.target.lerpVectors(tw.from, tw.to, e);
      this.camera.position.copy(this.controls.target).addScaledVector(dir, tw.df + (tw.dt - tw.df) * e);
      if (k >= 1) this.camTween = null;
    }
    const t = (now - this.t0) / 1000;
    const dt = this.lastNow ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000)) : 0; this.lastNow = now;
    for (const u of [this.starU, this.dustU, this.glowU]) if (u) { u.uMorph.value = this.morph; if (u.uTime) u.uTime.value = t; }
    this.sh.uMorph.value = this.morph;
    // brain-only silhouette fades out for the universe layout; dust is the dim starfield in universe mode
    const sil = 1 - Math.min(1, this.morph * 1.6);
    this.silhouette.visible = sil > 0.01 && !this.asset; if (this.glow) this.glow.visible = !this.asset; if (this.dust) this.dust.visible = !this.asset || this.morph > 0.02;  this.assetGroup.visible = sil > 0.01 && !!this.asset; for (const u of this.assetU) u.uAlpha.value = sil; for (const u of this.shellU) u.uAlpha.value = sil; for (const l of this.lineU) l.u.uAlpha.value = l.base * sil;
    if (this.dustU) this.dustU.uAlpha.value = 0.3 + 0.35 * this.morph;
    this.tickIntro(performance.now());
    this.sh.uWMax.value = this.field ? 0.5 * this.field.margin : 1e6; this.sh.uViewH.value = this.canvas.height || 800;
    this.applyGate();
    if (this.gateOpen) { this.pulseClock += dt; this.sim?.step(this.pulseClock); }
    this.sh.uClock.value = this.pulseClock;
    this.guardActive = !!this.bloomPass && this.assetGroup.visible && this.mode === "brain" && this.morph === 0;
    if (this.bloomPass) this.bloomPass.blendMaterial.stencilWrite = this.guardActive;
    this.controls?.update();
    this.camera.updateMatrixWorld(); this.trackHover(); // the hover follows stars moving under a still cursor (matrices of the frame about to be drawn)
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    this.frames++;
    if (this.lastRenderTs && now - this.lastRenderTs < 250) { this.frameTimes.push(now - this.lastRenderTs); if (this.frameTimes.length > 240) this.frameTimes.shift(); }
    this.lastRenderTs = now; this.lastRenderAt = performance.now();
    this.placeLabels();
  }
  private placeLabels() {
    const r = this.canvas.getBoundingClientRect(), m = this.morph;
    while (this.nlabels.length < this.labelIdx.length) { const d = document.createElement("div"); d.className = "pa-nlabel"; this.labelLayer.appendChild(d); this.nlabels.push(d); }
    // Screen-space collision avoidance: the focused label (k=0) is placed first and always wins; neighbours are nudged
    // vertically in steps and hidden if no free slot is found within +-4 steps.
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const hit = (a: { x0: number; y0: number; x1: number; y1: number }) => placed.some((p) => a.x0 < p.x1 + 2 && a.x1 > p.x0 - 2 && a.y0 < p.y1 + 2 && a.y1 > p.y0 - 2);
    this.nlabels.forEach((d, k) => {
      const i = this.labelIdx[k];
      if (i === undefined) { d.style.display = "none"; return; }
      const v = this.starPos(i).project(this.camera);
      const t = this.graph.nodes[i]?.title ?? ""; if (d.textContent !== t) d.textContent = t;
      d.classList.toggle("pa-nlabel-main", k === 0);
      d.style.zIndex = k === 0 ? "3" : "2";
      if (v.z > 1) { d.style.display = "none"; return; }
      d.style.display = "block";
      const px = (v.x * 0.5 + 0.5) * r.width, py = (-v.y * 0.5 + 0.5) * r.height, w = d.offsetWidth || 120, h = d.offsetHeight || 18;
      let ny = py, ok = false;
      for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
        const y = py + step * (h + 2), box = { x0: px + 8, x1: px + 8 + w, y0: y - h / 2, y1: y + h / 2 };
        if (k === 0 || !hit(box)) { ny = y; placed.push(box); ok = true; break; }
      }
      if (!ok) { d.style.display = "none"; return; }
      d.style.transform = `translate(8px,-50%) translate(${px}px,${ny}px)`;
    });
    FOLDERS.forEach((f) => {
      const a = BRAIN_REGION_CENTER[f], b = UNIVERSE_REGION_CENTER[f];
      const v = new THREE.Vector3(a[0] * (1 - m) + b[0] * m, (a[1] * (1 - m) + b[1] * m) + 0.75 * (1 - m) + 1.0 * m, a[2] * (1 - m) + b[2] * m).project(this.camera);
      const el = this.labels[f]; if (!el) return;
      el.style.display = v.z > 1 ? "none" : "block";
      el.style.transform = `translate(-50%,-50%) translate(${(v.x * 0.5 + 0.5) * r.width}px,${(-v.y * 0.5 + 0.5) * r.height}px)`;
    });
  }
  debug() {
    return { mode: this.mode, morph: this.morph, introProgress: this.introProgress, frames: this.frames, notes: this.graph.nodes.length, edges: this.graph.edges.length, dust: this.dustCount, quality: this.quality, bloom: !!this.composer, decorNeurons: this.decorNeurons, noteNeuronSegments: this.noteNeuronSegments, impulsesActive: this.gateOpen ? (this.sim?.active() ?? 0) : 0, assetLoaded: !!this.asset, assetTriangles: this.asset?.triangles ?? 0, matches: this.matches.length, focus: this.focus,
      neighbors: this.focusNeighbors(), nearLit: this.nearCount, dimmed: this.near.length - this.nearCount, hover: this.hover,
      layers: { renderedLinks: this.renderedEdgePairs().length, dendriteSegments: this.denSegments, dendriteDecorative: !!this.arbor?.userData.decorative, pickable: this.graph.nodes.length, pulseEdgesReal: this.impulsePaths().length === this.graph.edges.length && this.impulsePaths().every(([a, b]) => this.graph.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) },
      contained: this.contained, containLive: this.containLive, pulseGate: this.gateOpen, pulsesSuppressed: this.suppressed, guardActive: this.guardActive,
      geomSamples: this.containStats.geomSamples, geomOutside: this.containStats.geomOutside,
      pulseSamples: this.containStats.pulseSamples, pulseOutside: this.containStats.pulseOutside, extentSamples: this.containStats.extentSamples, extentOutside: this.containStats.extentOutside, shaderCapWorld: this.sh.uWMax.value, outsideBy: this.outsideBy,
      projectedSaved: this.projectedSaved, projectedPlaced: this.projectedPlaced, routeFailed: this.routeFailed,
      loops: this.loops, skipped: this.skipped, idle: this.isIdleState(),
      pulses: { on: this.pulsesOn, visible: this.gateOpen, gate: this.gateReason, suppressed: this.suppressed, guard: this.guardActive, count: this.fibres.length, ambient: this.boltA?.bolts.length ?? 0, clock: this.pulseClock },
      boltSamples: this.containStats.boltSamples, boltOutside: this.containStats.boltOutside, lightning: this.lightning(),
      preview: this.preview ? { idx: this.preview.i, mode: this.preview.mode, arborHidden: !!this.ntex?.hidden(this.preview.i), fibresHidden: this.fibres.filter((_, f) => this.ftex?.hidden(f)).length, incident: this.fibres.filter((fb) => fb.src === this.preview!.i || fb.dst === this.preview!.i).length } : null,
      cam: this.camera.position.toArray(), dist: this.controls ? this.camera.position.distanceTo(this.controls.target) : 0, webgl: this.webgl };
  }
  /** Frame-interval stats over recent animating renders (ms between consecutive rendered frames; gaps over 250 ms excluded). */
  frameStats() {
    const a = [...this.frameTimes].sort((x, y) => x - y);
    return { n: a.length, avg: a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0, p95: a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0 };
  }
  /** True if a render happened shortly after the last invalidation although nothing animates (should always be false). */
  idleRendering() { return this.isIdleState() && this.dirtyWarm <= 0 && this.lastRenderAt > this.lastInvalidate + 800 && performance.now() - this.lastRenderAt < 1500; }
  rendererName(): string {
    try { const gl = this.renderer?.getContext(); const e = gl?.getExtension("WEBGL_debug_renderer_info"); return e ? String(gl!.getParameter(e.UNMASKED_RENDERER_WEBGL)).slice(0, 80) : "unknown"; } catch { return "unknown"; }
  }
  focusNeighbors(): number[] { const f = this.hover >= 0 ? this.hover : this.focus; return f >= 0 && this.adj[f] ? [...this.adj[f]].sort((a, b) => a - b) : []; }
  /** Distinct (a,b) endpoint pairs actually present in the rendered link geometry (test hook: must equal graph.edges). */
  /** Distinct (a,b) pairs of edges actually drawn: zero-length (fail-closed) brain paths are not counted while the brain layout is shown. */
  renderedEdgePairs(): [number, number][] {
    if (!this.edges) return [];
    const g = this.edges.geometry, A = g.getAttribute("aA") as THREE.BufferAttribute, B = g.getAttribute("aB") as THREE.BufferAttribute, EI = g.getAttribute("aEdge") as THREE.BufferAttribute, brain = this.morph < 0.5;
    const seen = new Set<string>(), out: [number, number][] = [];
    for (let i = 0; i < A.count; i++) { if ((brain && this.badFibre[EI.getX(i)]) || this.ftex?.hidden(EI.getX(i))) continue; const k = A.getX(i) + ":" + B.getX(i); if (!seen.has(k)) { seen.add(k); out.push([A.getX(i), B.getX(i)]); } }
    return out;
  }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf); this.ro?.disconnect();
    window.removeEventListener("pointerup", this.onUp);
    [this.stars, this.dust, this.edges, this.glow, this.arbor, this.somas, this.decor, this.bg].forEach((o) => this.disposeObj(o as any));
    this.ntex?.tex.dispose(); this.ftex?.tex.dispose(); this.disposeBoltL(); this.disposeBoltA(); this.disposeComposer(); this.asset?.dispose(); this.assetGroup.clear(); this.disposeObj(this.sparkle);
    this.silhouette.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose(); }); this.scene.remove(this.silhouette);
    this.controls?.dispose(); this.renderer?.dispose();
    this.canvas.remove(); this.labelLayer.remove();
  }
}
