// GPU side of the neuron system: data textures, shaders and material factories.
// v0.3.2: no travelling comets anywhere. A note neuron FLASHES when a lightning strike on one of its real links reaches the return stroke: the
// source's whole axon and the target's dendrite group light at once and decay in ~0.1 s (the bolt itself is drawn by bolts.ts). The CPU only
// writes a few texels when a strike starts; nothing is rebuilt per frame.
import * as THREE from "three";
import { PALETTE, SPECTRUM } from "./palette";

export const NW = 8; // texels per neuron row: 0 brain pos, 1 universe pos, 2 colour+state, 3 axon event, 4 dendrite event A, 5 dendrite event B, 6 aux (groupA, groupB, near, somaR)
const NEVER = -1e6;
/** GLSL: spectral gradient lookup; needs `uniform vec3 uSpec[7]` in the same shader. t=0 frontal pole (orange) .. t=1 back (magenta). */
export const SPECTRUM_GLSL = `vec3 spectrum(float t){ float x = clamp(t, 0.0, 1.0) * 6.0; int i = int(min(5.0, floor(x))); return mix(uSpec[i], uSpec[i + 1], x - float(i)); }`;
export const specUniform = () => ({ value: SPECTRUM.map((c) => new THREE.Vector3(...c)) });
export class NeuronTex {
  readonly data: Float32Array; readonly tex: THREE.DataTexture; readonly n: number;
  constructor(n: number) {
    this.n = Math.max(1, n); this.data = new Float32Array(NW * this.n * 4);
    for (let r = 0; r < this.n; r++) { this.data[(r * NW + 1) * 4 + 3] = NEVER; this.data[(r * NW + 3) * 4] = NEVER; this.data[(r * NW + 4) * 4] = NEVER; this.data[(r * NW + 5) * 4] = NEVER; this.data[(r * NW + 6) * 4] = -1; this.data[(r * NW + 6) * 4 + 1] = -1; this.data[(r * NW + 6) * 4 + 2] = 1; this.data[(r * NW + 2) * 4 + 3] = 1; }
    this.tex = new THREE.DataTexture(this.data, NW, this.n, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter; this.tex.generateMipmaps = false; this.tex.needsUpdate = true;
  }
  private o(r: number, t: number, c = 0) { return (r * NW + t) * 4 + c; }
  setPos(r: number, brain: ArrayLike<number>, bo: number, uni: ArrayLike<number>, uo: number) { const d = this.data; for (let k = 0; k < 3; k++) { d[this.o(r, 0, k)] = brain[bo + k]; d[this.o(r, 1, k)] = uni[uo + k]; } this.tex.needsUpdate = true; }
  setStyle(r: number, c: ArrayLike<number>, somaR: number) { const d = this.data; for (let k = 0; k < 3; k++) d[this.o(r, 2, k)] = c[k]; d[this.o(r, 6, 3)] = somaR; this.tex.needsUpdate = true; }
  /** 1 = pyramidal (teardrop soma along the apical axis), 0 = round */
  setType(r: number, v: number) { this.data[this.o(r, 0, 3)] = v; this.tex.needsUpdate = true; }
  setNormal(r: number, nrm: ArrayLike<number>) { const d = this.data; for (let k = 0; k < 3; k++) d[this.o(r, 7, k)] = nrm[k]; this.tex.needsUpdate = true; }
  /** Drag preview: 1 = this neuron's arbor (and every impulse on it) is not drawn until the moved cell is re-clipped on release. */
  setHidden(r: number, on: boolean) { this.data[this.o(r, 7, 3)] = on ? 1 : 0; this.tex.needsUpdate = true; }
  hidden(r: number) { return this.data[this.o(r, 7, 3)] > 0.5; }
  setState(r: number, s: number) { this.data[this.o(r, 2, 3)] = s; }
  setNear(r: number, v: number) { this.data[this.o(r, 6, 2)] = v; }
  axon(r: number, t: number, c: ArrayLike<number>) { const d = this.data, i = this.o(r, 3); d[i] = t; d[i + 1] = c[0]; d[i + 2] = c[1]; d[i + 3] = c[2]; this.tex.needsUpdate = true; }
  dendrite(r: number, t: number, group: number, c: ArrayLike<number>, arrive = t) {
    this.data[this.o(r, 1, 3)] = arrive;
    const d = this.data, a = this.o(r, 4), b = this.o(r, 5), useA = d[a] <= d[b], i = useA ? a : b;
    d[i] = t; d[i + 1] = c[0]; d[i + 2] = c[1]; d[i + 3] = c[2]; d[this.o(r, 6, useA ? 0 : 1)] = group; this.tex.needsUpdate = true;
  }
  clearEvents() { for (let r = 0; r < this.n; r++) { for (const t of [3, 4, 5]) this.data[this.o(r, t)] = NEVER; this.data[this.o(r, 6, 0)] = -1; this.data[this.o(r, 6, 1)] = -1; } this.tex.needsUpdate = true; }
}
/** Per-fibre texels (layout kept from 0.3.1): only texel 2 is used now, .y = drag-preview hidden flag. */
export class FibreTex {
  readonly data: Float32Array; readonly tex: THREE.DataTexture; readonly n: number;
  constructor(n: number) {
    this.n = Math.max(1, n); this.data = new Float32Array(3 * this.n * 4);
    for (let r = 0; r < this.n; r++) { this.data[r * 12] = NEVER; this.data[r * 12 + 4] = NEVER; this.data[r * 12 + 8] = 1; }
    this.tex = new THREE.DataTexture(this.data, 3, this.n, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter; this.tex.generateMipmaps = false; this.tex.needsUpdate = true;
  }
  /** Drag preview: 1 = this fibre (resting glow and impulses) is not drawn until its route is re-derived on release. */
  setHidden(r: number, on: boolean) { this.data[r * 12 + 9] = on ? 1 : 0; this.tex.needsUpdate = true; }
  hidden(r: number) { return this.data[r * 12 + 9] > 0.5; }
}

export interface Shared {
  uClock: { value: number }; uMorph: { value: number }; uAnim: { value: number }; uDimOn: { value: number }; uUniScale: { value: number };
  uOcc: { value: number }; uGain: { value: number }; uStatic: { value: number }; uWMax: { value: number }; uViewH: { value: number };
}
export const makeShared = (): Shared => ({
  uClock: { value: 0 }, uMorph: { value: 0 }, uAnim: { value: 1 }, uDimOn: { value: 0 }, uUniScale: { value: 2.2 },
  uOcc: { value: 0 }, uGain: { value: PALETTE.pulseGain }, uStatic: { value: 0 }, uWMax: { value: 1e6 }, uViewH: { value: 800 },
});

/** Discharge flash of a neuron at a return stroke (e = seconds since the stroke): near-instant rise, ~70 ms decay, faint afterglow; 0 outside 0..1.5 s. */
const FLASH = `float flash(float e){ return (e < 0.0 || e > 1.5) ? 0.0 : min(1.0, e / 0.012) * (exp(-e / 0.07) + 0.12 * exp(-e / 0.35)); }`;

const ARBOR_VS = `
attribute float aNeuron; attribute float aS; attribute vec4 aInfo;
uniform sampler2D uN; uniform float uMorph; uniform float uUniScale;
varying float vS; varying vec4 vInfo; flat varying float vN; varying float vFace;
#ifdef TUBE
varying vec3 vNrm; varying vec3 vView;
#endif
void main(){
  int row = int(aNeuron + 0.5);
  vec3 sb = texelFetch(uN, ivec2(0, row), 0).xyz; vec3 su = texelFetch(uN, ivec2(1, row), 0).xyz;
  vec4 t7 = texelFetch(uN, ivec2(7, row), 0); vec3 sn = t7.xyz; float sl = length(sn);
  vFace = sl < 0.01 ? 1.0 : dot(sn / sl, normalize(cameraPosition - sb));
  vec3 p = mix(sb, su, uMorph) + position * mix(1.0, uUniScale, uMorph);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  if (t7.w > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // drag preview: the whole arbor lies outside the clip volume, so none of it rasterises
  vS = aS; vInfo = aInfo; vN = aNeuron;
#ifdef TUBE
  vNrm = normalize(normalMatrix * normal); vView = normalize(-mv.xyz);
#endif
}`;
const ARBOR_FS = `
uniform sampler2D uN; uniform float uOcc; uniform float uMorph; uniform float uClock; uniform float uAnim; uniform float uGain; uniform float uDimOn; uniform float uStatic; uniform float uRest; uniform vec3 uMyelin;
varying float vS; varying vec4 vInfo; flat varying float vN; varying float vFace;
#ifdef TUBE
varying vec3 vNrm; varying vec3 vView;
#endif
${FLASH}
void main(){
  int row = int(vN + 0.5);
  vec4 c2 = texelFetch(uN, ivec2(2, row), 0), ax = texelFetch(uN, ivec2(3, row), 0), dA = texelFetch(uN, ivec2(4, row), 0), dB = texelFetch(uN, ivec2(5, row), 0), aux = texelFetch(uN, ivec2(6, row), 0);
  float kind = vInfo.x, grp = vInfo.y, smax = vInfo.z;
  vec3 base = c2.rgb; float state = c2.a;
  float near = mix(1.0, mix(0.1, 1.0, aux.z), uDimOn);
  near *= mix(1.0, mix(0.1, 1.0, smoothstep(-0.3, 0.3, vFace)), uOcc * (1.0 - uMorph)); // cells on the far side of the brain recede
  vec3 col; float a;
  float prox = 0.45 + 1.15 * exp(-vS / 0.07);                 // dendrites are brightest near the soma and fade distally
  if (kind < 0.5) { col = base; a = 0.5 * prox; }
  else if (kind < 1.5) { col = mix(base, vec3(1.0), 0.25); a = 0.42; }
  else if (kind < 2.5) { col = mix(base, uMyelin, 0.65); a = 0.55; }
  else { col = mix(base, vec3(1.0), 0.55); a = 0.85; }
  float rim = 1.0;
#ifdef TUBE
  rim = 0.45 + 1.0 * pow(1.0 - abs(dot(normalize(vNrm), normalize(vView))), 1.2);
#endif
  vec3 E = col * a * rim * near * clamp(state, 0.2, 1.5) * uRest * (1.0 + uStatic);
  vec3 pc = vec3(0.0); float pI = 0.0;
  if (uAnim > 0.5) { // the whole axon (source) / the struck dendrite group (target) light at once with the bolt's return stroke
    if (kind > 0.5) { float c = flash(uClock - ax.x); pc += ax.yzw * c; pI += c; }
    else {
      float prox2 = 0.5 + 0.5 * exp(-vS / 0.12);
      if (abs(grp - aux.x) < 0.5) { float c = flash(uClock - dA.x) * prox2; pc += dA.yzw * c; pI += c; }
      if (abs(grp - aux.y) < 0.5) { float c = flash(uClock - dB.x) * prox2; pc += dB.yzw * c; pI += c; }
    }
  }
  E += (pc + vec3(1.0) * pow(clamp(pI, 0.0, 1.5), 3.0) * 0.28) * uGain * near; // coloured flash with a small white-hot core
  gl_FragColor = vec4(E, 1.0);
}`;
const SOMA_VS = `
attribute float aNeuron; attribute vec3 aBrain; attribute vec3 aUni;
uniform sampler2D uN; uniform float uMorph; uniform float uUniScale;
varying vec3 vNrm; varying vec3 vView; flat varying float vN; varying float vFace;
void main(){
  int row = int(aNeuron + 0.5);
  vec3 sb = aBrain, su = aUni;
  vec3 sn = texelFetch(uN, ivec2(7, row), 0).xyz; float sl = length(sn); vFace = sl < 0.01 ? 1.0 : dot(sn / sl, normalize(cameraPosition - sb)); float r = texelFetch(uN, ivec2(6, row), 0).w;
  float tear = texelFetch(uN, ivec2(0, row), 0).w; vec3 q = position;
  if (tear > 0.5 && sl > 0.01) { vec3 ax = sn / sl; float t = dot(q, ax); vec3 perp = q - ax * t; q = (t > 0.0 ? ax * t * 1.9 + perp * (1.0 - 0.5 * t) : ax * t * 0.85 + perp); } // cone toward the apical dendrite
  vec3 p = mix(sb, su, uMorph) + q * r * mix(1.0, uUniScale, uMorph);
  vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
  vNrm = normalize(normalMatrix * position); vView = normalize(-mv.xyz); vN = aNeuron;
}`;
const SOMA_FS = `
uniform sampler2D uN; uniform float uOcc; uniform float uMorph; uniform float uClock; uniform float uAnim; uniform float uDimOn; uniform float uGlow; uniform float uStatic;
varying vec3 vNrm; varying vec3 vView; flat varying float vN; varying float vFace;
void main(){
  int row = int(vN + 0.5);
  vec4 c2 = texelFetch(uN, ivec2(2, row), 0), ax = texelFetch(uN, ivec2(3, row), 0), aux = texelFetch(uN, ivec2(6, row), 0);
  float ndv = clamp(dot(normalize(vNrm), normalize(vView)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.2), nucleus = pow(ndv, 9.0);
  float flash = 0.0; if (uAnim > 0.5) { float e = uClock - ax.x; if (e > 0.0 && e < 1.5) flash = exp(-e / 0.09) + 0.1 * exp(-e / 0.4); }
  float near = mix(1.0, mix(0.1, 1.0, aux.z), uDimOn);
  near *= mix(1.0, mix(0.1, 1.0, smoothstep(-0.3, 0.3, vFace)), uOcc * (1.0 - uMorph));
  vec3 base = c2.rgb;
  vec3 body = base * (0.6 + 0.7 * fres);                          // dense small soma, rim lit
  vec3 core = mix(base, vec3(1.0), 0.75) * nucleus * (0.85 + 2.6 * flash + uStatic * 0.4); // glowing nucleus, flares when the cell fires
  vec4 dA = texelFetch(uN, ivec2(4, row), 0), dB = texelFetch(uN, ivec2(5, row), 0); float arr = 0.0, la = texelFetch(uN, ivec2(1, row), 0).w;
  vec3 acol = dA.x > dB.x ? dA.yzw : dB.yzw; if (uAnim > 0.5) { float e = uClock - la; if (e > 0.0 && e < 1.5) arr = exp(-e / 0.09) + 0.1 * exp(-e / 0.4); }
  vec3 E = (body + core + (ax.yzw * flash + acol * arr) * (0.35 + 0.6 * fres)) * uGlow * near * clamp(c2.a, 0.25, 1.5); // flash in the colour of the firing/arriving folder
  gl_FragColor = vec4(E, 1.0);
}`;
export const CAPGLSL = `uniform float uWMax; uniform float uViewH;
float capPx(float px, float w){ float wpp = 2.0 * max(w, 0.01) / (projectionMatrix[1][1] * uViewH); return min(px, 2.0 * uWMax / wpp); } // point extent bounded in WORLD units
`;
const FIBRE_VS = `
attribute vec3 aBrain; attribute vec3 aBrainO; attribute vec3 aUni; attribute vec3 aUniO; attribute float aSide; attribute vec3 aColor; attribute float aA; attribute float aB; attribute float aT; attribute float aEdge;
uniform float uMorph; uniform float uFocus; uniform float uFaint; uniform vec2 uRes; uniform float uW; uniform float uWMax;
varying vec3 vCol; varying float vAl; varying float vT; varying float vHit; varying float vSide; flat varying float vE;
void main(){
  vec3 p = mix(aBrain, aUni, uMorph), q = mix(aBrainO, aUniO, uMorph);
  mat4 mvp = projectionMatrix * modelViewMatrix; vec4 cp = mvp * vec4(p, 1.0), cq = mvp * vec4(q, 1.0);
  vec2 d = (cq.xy / cq.w - cp.xy / cp.w) * uRes; float dl = length(d); vec2 nrm = dl > 1e-4 ? vec2(-d.y, d.x) / dl : vec2(0.0, 1.0);
  float wpp = 2.0 * cp.w / (projectionMatrix[1][1] * uRes.y); float hw = min(uW * 0.5, uWMax / wpp); // ribbon half width in px, capped at uWMax in world units
  cp.xy += nrm * aSide * (2.0 * hw / uRes) * cp.w;
  gl_Position = cp;
  float hit = max(1.0 - step(0.5, abs(aA - uFocus)), 1.0 - step(0.5, abs(aB - uFocus)));
  float base = uFaint * (0.16 + 0.16 * sin(aT * 3.14159));
  vAl = uFocus < -0.5 ? base : mix(0.01, 0.9, hit);
  vHit = uFocus < -0.5 ? 1.0 : mix(0.1, 1.0, hit);
  vCol = aColor; vT = aT; vE = aEdge; vSide = aSide;
}`;
const FIBRE_FS = `
uniform sampler2D uE;
varying vec3 vCol; varying float vAl; varying float vT; varying float vHit; varying float vSide; flat varying float vE;
void main(){
  int row = int(vE + 0.5);
  float core = 1.0 - smoothstep(0.18, 0.4, abs(vSide));        // resting fibre stays hairline thin; discharges are drawn by the lightning layer
  if (texelFetch(uE, ivec2(2, row), 0).y > 0.5) discard;        // drag preview: fibre of the moved cell, re-routed on release
  vec3 E = vCol * vAl * core;
  if (max(E.r, max(E.g, E.b)) < 0.002) discard;
  gl_FragColor = vec4(E, 1.0);
}`;
const DECOR_VS = `
attribute float aS; attribute vec4 aInfo; varying float vS; varying vec4 vInfo; varying float vZ; varying float vFace;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vS = aS; vInfo = aInfo; vZ = position.z; vFace = dot(normalize(position - vec3(0.0, -0.05, -0.05)), normalize(cameraPosition - position)); }`;
const DECOR_FS = `
uniform float uMorph; uniform float uAlphaD; uniform float uDimOn; uniform vec3 uSpec[7];
varying float vS; varying vec4 vInfo; varying float vZ; varying float vFace; uniform float uOcc;
vec3 spectrum(float t){ float x = clamp(t, 0.0, 1.0) * 6.0; int i = int(min(5.0, floor(x))); return mix(uSpec[i], uSpec[i + 1], x - float(i)); }
void main(){
  float fade = clamp(1.0 - uMorph * 1.6, 0.0, 1.0); if (fade < 0.01) discard;
  fade *= mix(1.0, mix(0.1, 1.0, smoothstep(-0.4, 0.3, vFace)), uOcc);
  float rnd = vInfo.w;
  vec3 hue = spectrum((1.2 - vZ) / 2.4);                       // spatial spectrum: front orange ... back magenta
  vec3 E = hue * uAlphaD * (0.55 + 0.45 * fract(rnd * 7.31));   // static: ambient activity is the decorative lightning layer
  gl_FragColor = vec4(E * fade * mix(1.0, 0.25, uDimOn), 1.0);
}`;
const BG_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`;
const BG_FS = `uniform vec3 uIn; uniform vec3 uMid; uniform vec3 uOut; varying vec2 vUv;
void main(){ vec2 q = (vUv - vec2(0.5, 0.58)) * vec2(1.25, 1.0); float d = length(q) * 1.6; vec3 c = d < 0.55 ? mix(uIn, uMid, d / 0.55) : mix(uMid, uOut, clamp((d - 0.55) / 0.45, 0.0, 1.0)); gl_FragColor = vec4(c, 1.0); }`;

const additive = { transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending } as const;
export function arborMaterial(sh: Shared, ntex: NeuronTex, tube: boolean, rest = PALETTE.restAlpha) {
  const u = { ...sh, uN: { value: ntex.tex }, uRest: { value: rest }, uMyelin: { value: new THREE.Vector3(...PALETTE.myelin) } };
  // Additive front/back faces commute; draw them together without a second vertex pass.
  return new THREE.ShaderMaterial({ vertexShader: ARBOR_VS, fragmentShader: ARBOR_FS, uniforms: u, defines: tube ? { TUBE: 1 } : {}, ...additive, side: THREE.DoubleSide, forceSinglePass: true });
}
export function somaMaterial(sh: Shared, ntex: NeuronTex) {
  return new THREE.ShaderMaterial({ vertexShader: SOMA_VS, fragmentShader: SOMA_FS, uniforms: { ...sh, uN: { value: ntex.tex }, uGlow: { value: PALETTE.somaGlow } }, ...additive });
}
export function fibreMaterial(sh: Shared, ftex: FibreTex, focus: { value: number }) {
  return new THREE.ShaderMaterial({ vertexShader: FIBRE_VS, fragmentShader: FIBRE_FS, uniforms: { uMorph: sh.uMorph, uFocus: focus, uFaint: { value: PALETTE.fibreFaint }, uE: { value: ftex.tex }, uRes: { value: new THREE.Vector2(1, 1) }, uW: { value: 4 }, uWMax: sh.uWMax }, ...additive, side: THREE.DoubleSide, forceSinglePass: true });
}
export function decorMaterial(sh: Shared, alpha = PALETTE.decorAlpha) {
  return new THREE.ShaderMaterial({ vertexShader: DECOR_VS, fragmentShader: DECOR_FS, uniforms: { uMorph: sh.uMorph, uAlphaD: { value: alpha }, uSpec: specUniform(), uOcc: sh.uOcc, uDimOn: sh.uDimOn }, ...additive });
}
export function backgroundMesh() {
  const c = (a: number[]) => new THREE.Vector3(a[0] / 255, a[1] / 255, a[2] / 255);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: BG_VS, fragmentShader: BG_FS, uniforms: { uIn: { value: c(PALETTE.background.inner) }, uMid: { value: c(PALETTE.background.mid) }, uOut: { value: c(PALETTE.background.outer) } }, depthTest: false, depthWrite: false }));
  m.frustumCulled = false; m.renderOrder = -100; m.userData.decorative = true; return m;
}

const SPARK_VS = `
attribute vec3 aNrm; attribute float aRand; uniform float uClock; uniform float uStatic; uniform float uMorph; uniform float uPx; uniform float uDimOn; uniform vec3 uSpec[7]; uniform float uSize;
varying vec3 vCol; varying float vA;
${SPECTRUM_GLSL}
${CAPGLSL}void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
  float face = dot(normalize(aNrm), normalize(cameraPosition - position));
  float tw = 0.72 + 0.28 * sin(uClock * (0.5 + aRand * 1.3) + aRand * 50.0) * (1.0 - uStatic);
  float fade = clamp(1.0 - uMorph * 2.2, 0.0, 1.0);
  vA = smoothstep(-0.15, 0.35, face) * tw * fade * (0.45 + 0.55 * aRand) * mix(1.0, 0.3, uDimOn);
  vCol = spectrum((1.2 - position.z) / 2.4);
  gl_PointSize = capPx(max(1.0, uSize * uPx * (0.7 + 1.1 * aRand * aRand)), gl_Position.w);
}`;
const SPARK_FS = `varying vec3 vCol; varying float vA;
void main(){ vec2 q = gl_PointCoord - 0.5; float d = length(q); if (d > 0.5 || vA < 0.01) discard; float k = 1.0 - smoothstep(0.0, 0.5, d); gl_FragColor = vec4(vCol * vA * (0.3 + 0.8 * k * k), 1.0); }`;
export function sparkleMaterial(sh: Shared, px: number, size: number) {
  // depthTest off: sparkle points are inset below the margin (containment), so they sit inside the tissue; the far-side face fade above hides them from behind.
  return new THREE.ShaderMaterial({ vertexShader: SPARK_VS, fragmentShader: SPARK_FS, uniforms: { uClock: sh.uClock, uStatic: sh.uStatic, uMorph: sh.uMorph, uDimOn: sh.uDimOn, uPx: { value: px }, uSize: { value: size }, uWMax: sh.uWMax, uViewH: sh.uViewH, uSpec: specUniform() }, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
}
