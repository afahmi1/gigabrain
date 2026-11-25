// GPU side of the lightning: every bolt's segments live in one float texture (uploaded once per layout), every vertex is generated from gl_VertexID
// (4 per segment, screen-space ribbon), and one small state texture holds the parameters of the strike currently on each channel. Per frame the CPU
// only advances the clock uniform; a strike start writes 5 texels and adds one draw group (only channels in flight are drawn at all).
// Look (Kim & Lin 2004): thin channel, per-segment luminance (main channel brightest, forks dimmer with depth), white-hot core at the return stroke,
// tinted edges and afterglow; bloom (stencil-guarded to the tissue) makes it read thick. The ribbon half-width is capped in WORLD units (uWMax =
// half the containment margin), so a ribbon never extends beyond the margin around its verified centre line.
import * as THREE from "three";
import { Bolt, packSegments, SEG_TEXELS } from "./lightning";
import type { Strike } from "./impulse";

export const SEGW = 2048;        // texels per row of the segment texture
export const STATE_TEXELS = 5;   // per bolt: (t0, leader, seed, amp) (tint rgb, hidden) (gap1..3, tau) (amp1..3, keep) (src, dst, steps, life)
const NEVER = -1e6;

const VS = `
#define SEGW ${SEGW}
uniform sampler2D uSeg; uniform sampler2D uState;
uniform float uClock; uniform float uAnim; uniform float uReduce; uniform float uDimOn; uniform float uFocus; uniform float uKind; uniform float uOcc;
uniform vec2 uRes; uniform float uW; uniform float uWMax;
varying float vSide; varying vec3 vCol; varying float vI; varying float vHot;
vec4 segT(int i){ return texelFetch(uSeg, ivec2(i % SEGW, i / SEGW), 0); }
float h1(float x){ return fract(sin(x * 12.9898 + 78.233) * 43758.5453); }
void cull(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vSide = 0.0; vCol = vec3(0.0); vI = 0.0; vHot = 0.0; }
float pulse(float s, float a, float tau){ return s < 0.0 ? 0.0 : a * (exp(-s / 0.032) + 0.25 * exp(-s / tau)); } // stroke spike + continuing current
void main(){
  int vid = gl_VertexID, seg = vid >> 2, corner = vid & 3, base = seg * ${SEG_TEXELS};
  vec4 A = segT(base), B = segT(base + 1), M = segT(base + 2);
  int bolt = int(M.x + 0.5);
  vec4 s0 = texelFetch(uState, ivec2(0, bolt), 0), s1 = texelFetch(uState, ivec2(1, bolt), 0), s4 = texelFetch(uState, ivec2(4, bolt), 0);
  if (uAnim < 0.5 || s1.w > 0.5) { cull(); return; }
  bool atQ = corner >= 2; vec3 p = atQ ? B.xyz : A.xyz, q = atQ ? A.xyz : B.xyz;
  float w = M.y, fork = M.z; bool mainCh = fork < 0.5;
  // Intensity is evaluated at BOTH ends of the segment and the segment is culled only when both are dark: culling one corner of a quad alone would
  // stretch its triangles toward the cull point, off the channel. Facing uses the segment midpoint, so both ends agree.
  float IA, IB, hotA, hotB;
#ifdef FORCE
  { // test/stress program only (separate material): every channel lit at once, brightness still varies with the clock
    float phA = sin(uClock * 7.0 + s0.z * 6.2831 + A.w * 4.0), phB = sin(uClock * 7.0 + s0.z * 6.2831 + B.w * 4.0), k = mainCh ? 1.0 : min(1.0, w * 1.7);
    IA = k * (0.72 + 0.28 * phA); IB = k * (0.72 + 0.28 * phB); hotA = mainCh ? 0.6 + 0.4 * phA : 0.25; hotB = mainCh ? 0.6 + 0.4 * phB : 0.25;
  }
#else
  {
    float e = uClock - s0.x;
    if (e < 0.0 || e > s4.w) { cull(); return; }
    vec4 s2 = texelFetch(uState, ivec2(2, bolt), 0), s3 = texelFetch(uState, ivec2(3, bolt), 0);
    float TL = max(s0.y, 1e-3), seed = s0.z;
    if (!mainCh && h1(fork * 7.13 + seed * 91.7) > s3.w) { cull(); return; } // a different subset of forks on every strike of the same channel
    // stepped leader: the tip advances in jumps (fast step, pause); the channel behind it glows dimly, the tip brightly
    float x = clamp(e / TL, 0.0, 1.0), n = max(1.0, s4.z), k = floor(x * n), fr = fract(x * n);
    float front = uReduce > 0.5 ? x : min(1.0, (k + smoothstep(0.0, 0.3, fr)) / n + 0.02 * (h1(k + seed * 13.0) - 0.5));
    if (x >= 1.0) front = 1.0;
    float s = e - TL, flick = uReduce > 0.5 ? 0.6 : 0.82 + 0.18 * h1(floor(e * 60.0) + seed * 7.0);
    float bA = front - A.w, bB = front - B.w;
    float leadA = bA < 0.0 ? 0.0 : (0.12 + 0.5 * exp(-bA / 0.035)) * flick, leadB = bB < 0.0 ? 0.0 : (0.12 + 0.5 * exp(-bB / 0.035)) * flick;
    float st = 0.0;
    if (s >= 0.0) {
      if (uReduce > 0.5) st = smoothstep(0.0, 0.08, s) * exp(-s / s2.w);        // soft: slow rise, slow fade, no flicker
      else {
        st = pulse(s, 1.0, s2.w);                                                // return stroke: the whole channel at once
        if (s2.x > 0.0) st = max(st, pulse(s - s2.x, s3.x, s2.w));               // restrikes of the same channel
        if (s2.y > 0.0) st = max(st, pulse(s - s2.y, s3.y, s2.w));
        if (s2.z > 0.0) st = max(st, pulse(s - s2.z, s3.z, s2.w));
      }
      float fade = exp(-s / 0.03); leadA *= fade; leadB *= fade;
    }
    float glow = s > 0.0 && uReduce < 0.5 ? 0.035 * exp(-s / 0.22) : 0.0;      // faint afterglow
    // main channel: weight w = 1 near the cortex, dimmer deep inside the tissue (link routes through the white matter); forks dimmer with branch depth
    IA = (mainCh ? w * (max(leadA, st) + glow) : w * (max(leadA * 1.4, st * 0.8) + glow * 0.5)) * s0.w;
    IB = (mainCh ? w * (max(leadB, st) + glow) : w * (max(leadB * 1.4, st * 0.8) + glow * 0.5)) * s0.w;
    hotA = hotB = uReduce > 0.5 ? 0.0 : (mainCh ? clamp(st * 1.2 - 0.12, 0.0, 1.0) * smoothstep(0.35, 0.9, w) : 0.4 * clamp(st - 0.2, 0.0, 1.0));
  }
#endif
  float nearF = 1.0;
  if (uDimOn > 0.5) nearF = uKind < 0.5 ? ((abs(s4.x - uFocus) < 0.5 || abs(s4.y - uFocus) < 0.5) ? 1.0 : 0.12) : 0.3; // focus: that note's links stay lit
  if (M.w >= 0.0) { vec3 nn = vec3(mod(M.w, 256.0), mod(floor(M.w / 256.0), 256.0), floor(M.w / 65536.0)) / 255.0 * 2.0 - 1.0; float face = dot(normalize(nn), normalize(cameraPosition - 0.5 * (A.xyz + B.xyz))); nearF *= mix(1.0, mix(0.28, 1.0, smoothstep(-0.25, 0.3, face)), uOcc); } // far side recedes
  IA *= nearF; IB *= nearF;
  if (max(IA, IB) < 0.003) { cull(); return; }
  float I = atQ ? IB : IA, hot = atQ ? hotB : hotA;
  mat4 mvp = projectionMatrix * modelViewMatrix; vec4 cp = mvp * vec4(p, 1.0), cq = mvp * vec4(q, 1.0);
  vec2 d = (cq.xy / cq.w - cp.xy / cp.w) * uRes; float dl = length(d); vec2 nrm = dl > 1e-4 ? vec2(-d.y, d.x) / dl : vec2(0.0, 1.0);
  float side = (corner & 1) == 1 ? 1.0 : -1.0;
  float wpp = 2.0 * cp.w / (projectionMatrix[1][1] * uRes.y);
  float hw = min(uW * 0.5 * (mainCh ? 1.0 : 0.5 + 0.5 * min(1.0, w / 0.55)), uWMax / wpp);   // px, capped in world units
  cp.xy += nrm * (atQ ? -side : side) * (2.0 * hw / uRes) * cp.w;
  gl_Position = cp; vSide = side; vI = I; vHot = hot; vCol = s1.rgb;
}`;
const FS = `
uniform float uGain;
varying float vSide; varying vec3 vCol; varying float vI; varying float vHot;
void main(){
  float a = abs(vSide), core = exp(-a * a * 9.0), halo = exp(-a * a * 2.2) * (1.0 - 0.6 * a);
  vec3 E = (vCol * (0.55 * halo + 0.75 * core) + vec3(1.0) * core * vHot * 1.4) * vI * uGain; // white-hot core, tinted edges
  if (max(E.r, max(E.g, E.b)) < 0.002) discard;
  gl_FragColor = vec4(E, 1.0);
}`;

export interface BoltShared { uClock: { value: number }; uAnim: { value: number }; uDimOn: { value: number }; uWMax: { value: number }; uOcc: { value: number }; }
export class BoltLayer {
  readonly mesh: THREE.Mesh; readonly n: number; readonly segments: number; readonly first: Int32Array; readonly count: Int32Array;
  readonly state: Float32Array; readonly stateTex: THREE.DataTexture; readonly segTex: THREE.DataTexture; readonly u: Record<string, { value: any }>;
  private active = new Set<number>(); private forced = false; private geo: THREE.BufferGeometry; private mat: THREE.ShaderMaterial; private forceMat: THREE.ShaderMaterial | null = null;
  constructor(readonly bolts: Bolt[], sh: BoltShared, focus: { value: number }, o: { kind: number; tint: (i: number) => ArrayLike<number>; ends?: (i: number) => [number, number]; width: number; gain: number; reduce: boolean }) {
    this.n = Math.max(1, bolts.length);
    const pk = packSegments(bolts); this.segments = pk.segments; this.first = pk.first; this.count = pk.count;
    const rows = Math.max(1, Math.ceil((pk.segments * SEG_TEXELS) / SEGW)), seg = new Float32Array(SEGW * rows * 4); seg.set(pk.data);
    this.segTex = new THREE.DataTexture(seg, SEGW, rows, THREE.RGBAFormat, THREE.FloatType);
    this.state = new Float32Array(STATE_TEXELS * this.n * 4);
    for (let b = 0; b < this.n; b++) {
      const o0 = b * STATE_TEXELS * 4, c = b < bolts.length ? o.tint(b) : [1, 1, 1], e = o.ends && b < bolts.length ? o.ends(b) : [-1, -1];
      this.state[o0] = NEVER; this.state[o0 + 1] = 0.1; this.state[o0 + 3] = 1; this.state[o0 + 4] = c[0]; this.state[o0 + 5] = c[1]; this.state[o0 + 6] = c[2];
      this.state[o0 + 16] = e[0]; this.state[o0 + 17] = e[1]; this.state[o0 + 18] = 1; this.state[o0 + 19] = 0;
    }
    this.stateTex = new THREE.DataTexture(this.state, STATE_TEXELS, this.n, THREE.RGBAFormat, THREE.FloatType);
    for (const t of [this.segTex, this.stateTex]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; }
    const idx = new Uint32Array(pk.segments * 6); for (let s = 0; s < pk.segments; s++) { const v = s * 4; idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6); }
    this.geo = new THREE.BufferGeometry(); this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10); // vertices come from the texture; never frustum culled anyway
    this.u = { uSeg: { value: this.segTex }, uState: { value: this.stateTex }, uClock: sh.uClock, uAnim: sh.uAnim, uDimOn: sh.uDimOn, uWMax: sh.uWMax, uOcc: sh.uOcc, uFocus: focus,
      uReduce: { value: o.reduce ? 1 : 0 }, uKind: { value: o.kind }, uRes: { value: new THREE.Vector2(1, 1) }, uW: { value: o.width }, uGain: { value: o.gain } };
    this.mat = this.material(false);
    this.mesh = new THREE.Mesh(this.geo, [this.mat]); this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; this.mesh.userData.decorative = true;
    this.groups();
  }
  private material(force: boolean) { return new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.u, defines: force ? { FORCE: 1 } : {}, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true }); }
  /** Build the program, its GPU pipeline and the textures NOW (during the layout rebuild, which already blocks) with a fully culled one-segment draw
   *  into the target the composer really uses, so the first strike never waits for a driver compile. */
  prewarm(r: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null) {
    if (!this.segments) return;
    const g = this.geo.groups, vis = this.mesh.visible, prevT = r.getRenderTarget(), auto = r.autoClear;
    this.geo.groups = [{ start: 0, count: 6, materialIndex: 0 }]; this.mesh.visible = true; r.autoClear = false;
    try { r.initTexture(this.segTex); r.initTexture(this.stateTex); r.setRenderTarget(target); r.render(this.mesh, camera); } // bolt 0 has no strike: every vertex is culled, nothing is written
    finally { r.setRenderTarget(prevT); r.autoClear = auto; this.mesh.visible = vis; this.geo.groups = g; }
  }
  private groups() {
    const g: { start: number; count: number; materialIndex: number }[] = [];
    if (this.forced) { if (this.segments) g.push({ start: 0, count: this.segments * 6, materialIndex: 0 }); }
    else for (const b of this.active) if (this.count[b] > 0) g.push({ start: this.first[b] * 6, count: this.count[b] * 6, materialIndex: 0 });
    this.geo.groups = g;
  }
  /** A strike starts on bolt s.bolt: its parameters go into the state texture and its segments into the draw list. */
  strike(s: Strike) {
    const o = s.bolt * STATE_TEXELS * 4, d = this.state;
    d[o] = s.t0; d[o + 1] = s.leader; d[o + 2] = s.seed; d[o + 3] = s.amp;
    d[o + 8] = s.gaps[0]; d[o + 9] = s.gaps[1]; d[o + 10] = s.gaps[2]; d[o + 11] = s.tau;
    d[o + 12] = s.amps[0]; d[o + 13] = s.amps[1]; d[o + 14] = s.amps[2]; d[o + 15] = s.keep;
    d[o + 18] = s.steps; d[o + 19] = s.life;
    this.stateTex.needsUpdate = true; this.active.add(s.bolt); this.groups();
  }
  end(b: number) { if (this.active.delete(b)) this.groups(); }
  clear() { for (const b of this.active) this.state[b * STATE_TEXELS * 4] = NEVER; this.active.clear(); this.stateTex.needsUpdate = true; this.groups(); }
  /** Drag preview: a held channel is never drawn (its route was derived for the old position). */
  setHidden(b: number, on: boolean) { this.state[b * STATE_TEXELS * 4 + 7] = on ? 1 : 0; this.stateTex.needsUpdate = true; if (on) this.end(b); }
  hidden(b: number) { return this.state[b * STATE_TEXELS * 4 + 7] > 0.5; }
  /** Test/stress hook: draw EVERY channel at once (containment sweeps), brightness still clock dependent. */
  setForce(on: boolean) { if (on === this.forced) return; this.forced = on; this.mesh.material = [on ? (this.forceMat ??= this.material(true)) : this.mat]; this.groups(); }
  get inFlight() { return this.active.size; }
  setReduce(on: boolean) { this.u.uReduce.value = on ? 1 : 0; }
  setRes(w: number, h: number, px: number, width: number) { (this.u.uRes.value as THREE.Vector2).set(w || 1, h || 1); this.u.uW.value = width * px; }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.forceMat?.dispose(); this.segTex.dispose(); this.stateTex.dispose(); }
}
