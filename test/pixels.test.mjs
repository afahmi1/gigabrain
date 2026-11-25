// Independent real-GLB rendered pixel regression: everything that glows must stay inside the brain.
//
// For each (quality, note-count) and each predetermined viewpoint (>= 12, incl. underside/fissure) at >1 pulse time we:
//   1. derive a camera-aligned binary silhouette from the ACTUAL on-screen tissue (the loaded GLB meshes, rendered
//      with a plain bright diagnostic material so the mask is hole-free), NOT from graph geometry and NOT the field;
//   2. render the emissive layer ALONE with bloom disabled (raw, no tone map) and count bright pixels OUTSIDE the
//      exact silhouette (no dilation)  -> must be 0;
//   3. render the composited scene with bloom and count bright (L>0.2) pixels BEYOND 3 px outside the silhouette
//      -> must be 0;
//   4. assert non-zero MOVING BRIGHT and SATURATED in-mask controls (two pulse clocks) so a blank frame cannot pass; production motion is measured on
//      real note-link fibres and note arbors alone (decor and sparkle hidden);
//   5. drag a cell with real pointer events across the fissure and the cerebrum-cerebellum gap and repeat 1-4 BEFORE pointerup (`--full`).
//   6. LIGHTNING (v0.3.2): both bolt layers (real-link bolts and decorative ambient bolts) are part of every outside/bloom check above, with EVERY
//      precomputed bolt forced on (main channels and forks of all channels at once). Production windows run the real scheduler through the real
//      frame path at a fixed 30 fps clock and require (a) bright flashes in every screen region of the cerebrum from left/right/top/front (both
//      hemispheres, not only the centre), (b) transience: a pixel lit at a flash peak is dark again within 0.5 s (strict for isolated strikes),
//      (c) photosensitivity: no more than 3 general flashes (WCAG 2.3.1 area rule on the composited frame) in any 1 s window.
//
// `--full` (the release gate, used by `npm test`) evaluates all 12 angles at 31/150/1500 notes on High and Low and refuses PA_QUICK / PA_PLAN.
//
// Also exercises 31/150/1500 synthetic notes at correct quality (High with bloom, Low without) and the
// missing / corrupt / morph / universe gates (containment only applies in brain mode with a real asset).
//
// Serves the freshly built demo plus scratch-only negative asset fixtures. Screenshots are synthetic.
import { launchGpu, hardwareRenderer } from "./gpu.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";

const ROOT = path.resolve("dist-demo");
const SHOTS = process.env.PA_SHOTS || path.join(os.tmpdir(), "palace-atlas-synthetic", "pixels");
fs.mkdirSync(SHOTS, { recursive: true });
const SCRATCH_ASSETS = fs.mkdtempSync(path.join(os.tmpdir(), "palace-atlas-assets-"));

// ------------------------------------------------------------------ fixtures served same-origin
// scratch asset dirs (never written into dist-demo)
const mk = (d, files) => { fs.mkdirSync(path.join(SCRATCH_ASSETS, d), { recursive: true }); for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(SCRATCH_ASSETS, d, k), v); fs.writeFileSync(path.join(SCRATCH_ASSETS, d, "index.json"), JSON.stringify(Object.keys(files))); };
mk("assets-empty", {});                                                    // missing GLB
const garbage = Buffer.alloc(128, 0xcd);
mk("assets-corrupt", { "brain.glb": garbage, "brain_low.glb": garbage });  // corrupt GLB
// INTACT real GLBs (+ morphologies) with a missing / corrupt FIELD (brain_sdf.bin): the real render pulse gate must fail closed
const realFile = (f) => { const q = path.join(ROOT, "assets", f); return fs.existsSync(q) ? fs.readFileSync(q) : null; };
const realSet = {}; for (const f of ["brain.glb", "brain_low.glb", "morphologies.json"]) { const b = realFile(f); if (b) realSet[f] = b; }
mk("assets-nofield", { ...realSet });
const realSdf = realFile("brain_sdf.bin");
const badSdf = realSdf ? Buffer.concat([realSdf.subarray(0, Math.floor(realSdf.length * 0.6))]) : Buffer.alloc(4096, 0x7f); // truncated real field (header intact) else garbage
if (realSdf) for (let i = 2000; i < Math.min(badSdf.length, 2400); i++) badSdf[i] ^= 0xa5;
mk("assets-badfield", { ...realSet, "brain_sdf.bin": badSdf });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream" };
const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.writeHead(204); return res.end(); }
  const u = req.url.split("?")[0];
  let f;
  if (/^\/assets-(empty|corrupt|nofield|badfield)\//.test(u)) f = path.join(SCRATCH_ASSETS, u);
  else f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT) && !f.startsWith(SCRATCH_ASSETS)) { res.writeHead(404); return res.end(); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ------------------------------------------------------------------ thresholds / config
const RAW_BRIGHT_SUM = 20;     // legacy "visible" reference count only; the ASSERTED raw threshold is any byte difference vs the blank-emission render (0 = zero tolerance)
const BLOOM_L = 0.2;          // composited "bright" luminance (normalised 0..1)
const BLOOM_MARGIN_PX = 3;    // composited bright pixels beyond this many px outside the silhouette fail
const SIL_SUM = 6;            // exact rasterised tissue coverage (plain bright material on black: any covered pixel incl. AA fringe); no dilation for the raw test
const CTRL_BRIGHT_L = 0.4;    // positive control: clearly-bright in-mask pixels (normalised)
const CTRL_SAT = 40;          // positive control: chroma (max-min) for "saturated"
const CTRL_SAT_L = 0.03;      // and minimum luminance for a saturated control pixel (coloured neurons are dim in linear space)

const VIEWPOINTS = [
  { name: "overview", pos: [-2.10, -0.69, 1.62], target: [0, -0.15, 0] },
  { name: "top-fissure", pos: [0, 3.6, 0.01], target: [0, 0, 0] },
  { name: "underside", pos: [-1.1, -2.1, -2.0], target: [0, -0.35, -0.4] },
  { name: "front-fissure", pos: [0, 0.1, 3.0], target: [0, 0.1, 0] },
  { name: "left", pos: [-3.0, 0.0, 0.0], target: [0, 0, 0] },
  { name: "right", pos: [3.0, 0.0, 0.0], target: [0, 0, 0] },
  { name: "rear", pos: [0, 0.2, -3.0], target: [0, 0, 0] },
  { name: "front-top-left", pos: [-1.5, 1.8, 1.5], target: [0, -0.1, 0] },
  { name: "rear-bottom-right", pos: [1.5, -1.6, -1.8], target: [0, -0.2, -0.3] },
  { name: "cerebellum-close", pos: [0.8, -1.2, -2.4], target: [0, -0.5, -0.6] },
  { name: "left-frontal", pos: [-1.4, 0.2, 1.6], target: [0, 0, 0.3] },
  { name: "right-temporal", pos: [1.9, -0.3, 0.6], target: [0, -0.2, 0.2] },
];
const PULSE_DELTA = 0.7; // seconds between the two pulse clocks per viewpoint

// ------------------------------------------------------------------ page-side pixel engine (injected once)
const PX_HELPER = String.raw`(() => {
  const NEURON = ["stars", "edges", "arbor", "somas", "decor", "sparkle", "linkBolts", "ambientBolts"]; // everything that must stay inside the brain
  const BG = ["dust", "glow"], ALL = NEURON.concat(BG);
  const NOTE = ["edges", "arbor", "somas", "linkBolts"], PULSE = NOTE.concat(["decor", "ambientBolts"]); // NOTE: positive motion controls (real cells/links only); PULSE: closed-gate zero-delta checks (decor and ambient bolts must freeze too)
  // synchronous: set layer visibility, render (direct or composer), snapshot the real canvas, restore. No await between render and snapshot.
  function shoot(s, show, tissue, o) {
    o = o || {};
    const saved = ALL.map(k => s[k] ? s[k].visible : null), st = s.assetGroup ? s.assetGroup.visible : false, ua = s.sh.uAnim.value, uc = s.sh.uClock.value, bp = s.bloomPass, be = bp?.enabled, sw = bp?.blendMaterial.stencilWrite;
    const names = o.plain ? Object.keys(s.asset.meshes || {}) : [], mats = names.map(n => s.asset.meshes[n].material);
    ALL.forEach(k => { if (s[k]) s[k].visible = show.indexOf(k) >= 0; });
    if (s.assetGroup) s.assetGroup.visible = tissue;
    if (o.force) { s.sh.uAnim.value = 1; s.setBoltForce?.(true); } // independent of the runtime pulse gate: the geometry itself must be contained (every bolt drawn at once)
    if (o.clock != null) s.sh.uClock.value = o.clock;
    names.forEach(n => s.debugPlainMaterial(n));
    let r;
    try {
      if (o.noBloom && bp) bp.enabled = false;
      if (o.guardOff && bp) bp.blendMaterial.stencilWrite = false; // control only: bloom blended everywhere (is there any bloom source at all?)
      if (o.composer && s.composer) s.composer.render(); else { s.renderer.setRenderTarget(null); s.renderer.render(s.scene, s.camera); }
      r = { url: s.canvas.toDataURL(), w: s.canvas.width, h: s.canvas.height };
    } finally {
      if (bp) { bp.enabled = be; bp.blendMaterial.stencilWrite = sw; }
      names.forEach((n, i) => { s.asset.meshes[n].material = mats[i]; });
      ALL.forEach((k, i) => { if (s[k]) s[k].visible = saved[i]; });
      if (s.assetGroup) s.assetGroup.visible = st;
      s.sh.uAnim.value = ua; s.sh.uClock.value = uc; if (o.force) s.setBoltForce?.(false);
    }
    return r;
  }
  const decode = (r) => new Promise((res) => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = r.w; c.height = r.h; const x = c.getContext("2d"); x.drawImage(im, 0, 0); res({ w: r.w, h: r.h, d: x.getImageData(0, 0, r.w, r.h).data }); }; im.src = r.url; });
  // TRUE camera-aligned binary coverage of the ACTUAL tissue: only asset.meshes are drawn, each with a temporary flat white unlit
  // ShaderMaterial (DoubleSide, depthWrite on); the depth-prepass duplicates, silhouette/dust/glow/emissive/other scene objects, background and fog are hidden for this pass only.
  function coverage(s) {
    const metas = Object.values(s.asset.meshes || {}), keep = new Set(metas), hid = [], hide = (o) => { if (o.visible) { hid.push(o); o.visible = false; } };
    const src = [metas[0] && metas[0].material, s.dust && s.dust.material, s.stars && s.stars.material, s.edges && s.edges.material].find((m) => m && m.isShaderMaterial);
    if (!src) throw new Error("coverage: no ShaderMaterial constructor reachable");
    const Ctor = src.constructor, mine = metas.map(() => new Ctor({ vertexShader: "void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}", fragmentShader: "void main(){gl_FragColor=vec4(1.0);}", side: 2, depthWrite: true, depthTest: true, transparent: false, toneMapped: false }));
    const mats = metas.map((m) => m.material), mv = metas.map((m) => m.visible), gv = s.assetGroup.visible, bg = s.scene.background, fog = s.scene.fog;
    s.scene.children.forEach((c) => { if (c !== s.assetGroup) hide(c); });
    s.assetGroup.traverse((o) => { if (o !== s.assetGroup && !keep.has(o) && (o.isMesh || o.isLine || o.isPoints)) hide(o); });
    s.assetGroup.visible = true; metas.forEach((m, i) => { m.material = mine[i]; m.visible = true; }); s.scene.background = null; s.scene.fog = null;
    let r;
    try { s.renderer.setRenderTarget(null); s.renderer.render(s.scene, s.camera); r = { url: s.canvas.toDataURL(), w: s.canvas.width, h: s.canvas.height }; }
    finally { metas.forEach((m, i) => { m.material = mats[i]; m.visible = mv[i]; mine[i].dispose(); }); hid.forEach((o) => { o.visible = true; }); s.assetGroup.visible = gv; s.scene.background = bg; s.scene.fog = fog; }
    return r;
  }
  const SUM = (d, i) => d[i] + d[i + 1] + d[i + 2];
  const CHR = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
  function boxDilate(mask, w, h, r) {
    // Euclidean: a diagonal displacement of (3,3) is outside a 3px allowance.
    const out = mask.slice();
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
        const src = y * w, dst = (y + dy) * w;
        for (let x = 0; x < w; x++) if (mask[src + x]) out.fill(1, dst + Math.max(0, x - dx), dst + Math.min(w, x + dx + 1));
      }
    }
    return out;
  }
  // pixels outside the mask whose any channel differs from the blank-emission render by more than tol bytes
  function outsideDiff(img, blank, mask, tol) { let n = 0; const d = img.d, b = blank.d, N = img.w * img.h;
    for (let i = 0; i < N; i++) { if (mask[i]) continue; const o = i * 4; if (Math.abs(d[o] - b[o]) > tol || Math.abs(d[o + 1] - b[o + 1]) > tol || Math.abs(d[o + 2] - b[o + 2]) > tol) n++; } return n; }
  const snapshot = (s, production) => {
    const all = shoot(s, production ? NOTE : PULSE, false);
    return Promise.all((production ? [all, shoot(s, ["linkBolts"], false), shoot(s, ["arbor"], false), coverage(s)] : [all]).map(decode));
  };
  // ---------------------------------------------------------------- v0.3.2 lightning: raw readback and deterministic production windows
  const RB = {};
  function readRaw(s, key) { const gl = s.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; let b = RB[key]; if (!b || b.length !== w * h * 4) b = RB[key] = new Uint8Array(w * h * 4); s.renderer.setRenderTarget(null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return { d: b, w, h }; } // rows bottom-up
  function grab(s, show, key, o = {}) { // shoot() without the PNG round trip: same layer toggling, raw pixels of the frame just drawn
    const saved = ALL.map(k => s[k] ? s[k].visible : null), st = s.assetGroup ? s.assetGroup.visible : false; let r;
    ALL.forEach(k => { if (s[k]) s[k].visible = show.indexOf(k) >= 0; }); if (s.assetGroup) s.assetGroup.visible = !!o.tissue;
    try { if (o.composer && s.composer) s.composer.render(); else { s.renderer.setRenderTarget(null); s.renderer.render(s.scene, s.camera); } r = readRaw(s, key); }
    finally { ALL.forEach((k, i) => { if (s[k]) s[k].visible = saved[i]; }); if (s.assetGroup) s.assetGroup.visible = st; }
    return r;
  }
  /** Binary coverage (bottom-up rows) of the actual tissue meshes; 'only' restricts it to some parts (the cerebrum = both cortex meshes). */
  function coverageRaw(s, only) {
    const metas = Object.entries(s.asset.meshes || {}).filter(([n]) => !only || only.includes(n)).map(([, m]) => m), others = Object.values(s.asset.meshes || {}).filter((m) => !metas.includes(m));
    const keep = new Set(metas), hid = [], hide = (o) => { if (o.visible) { hid.push(o); o.visible = false; } };
    const Ctor = s.stars.material.constructor, mine = metas.map(() => new Ctor({ vertexShader: "void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}", fragmentShader: "void main(){gl_FragColor=vec4(1.0);}", side: 2, depthWrite: true, depthTest: true, transparent: false, toneMapped: false }));
    const mats = metas.map((m) => m.material), mv = metas.map((m) => m.visible), gv = s.assetGroup.visible, bg = s.scene.background;
    s.scene.children.forEach((c) => { if (c !== s.assetGroup) hide(c); }); s.assetGroup.traverse((o) => { if (o !== s.assetGroup && !keep.has(o) && (o.isMesh || o.isLine || o.isPoints)) hide(o); }); others.forEach(hide);
    s.assetGroup.visible = true; metas.forEach((m, i) => { m.material = mine[i]; m.visible = true; }); s.scene.background = null;
    let r; try { s.renderer.setRenderTarget(null); s.renderer.render(s.scene, s.camera); r = readRaw(s, "cov"); }
    finally { metas.forEach((m, i) => { m.material = mats[i]; m.visible = mv[i]; mine[i].dispose(); }); hid.forEach((o) => { o.visible = true; }); s.assetGroup.visible = gv; s.scene.background = bg; }
    const mask = new Uint8Array(r.w * r.h); let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let i = 0; i < mask.length; i++) if (r.d[i * 4] + r.d[i * 4 + 1] + r.d[i * 4 + 2] > 6) { mask[i] = 1; n++; const x = i % r.w, y = (i / r.w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { mask, w: r.w, h: r.h, n, box: [x0, y0, x1, y1] };
  }
  // WCAG 2.x relative luminance of an 8-bit display value
  const YL = new Float32Array(256).map((_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  function motion(a, b, mask) {
    let changed = 0, changed8 = 0, bright = 0, coloured = 0, outside = 0;
    for (let i = 0; i < a.w * a.h * 4; i += 4) {
      const diff = Math.max(Math.abs(a.d[i] - b.d[i]), Math.abs(a.d[i + 1] - b.d[i + 1]), Math.abs(a.d[i + 2] - b.d[i + 2]));
      if (!diff) continue;
      changed++;
      if (mask && SUM(mask.d, i) <= 6) { outside++; continue; }
      if (diff <= 8) continue;
      changed8++;
      if (Math.max(SUM(a.d, i), SUM(b.d, i)) / 765 > 0.4) bright++;
      if ((CHR(a.d, i) > 40 && SUM(a.d, i) / 765 > 0.03) || (CHR(b.d, i) > 40 && SUM(b.d, i) / 765 > 0.03)) coloured++;
    }
    return { changed, changed8, bright, coloured, outside };
  }
  // Deterministic production clock for lightning windows: the scheduler is rebuilt fresh (seeded) at pulse clock 4096 s and the REAL frame path is
  // driven at exactly 32 fps (dt = 1/32 s, exact in binary floating point), so a window is bit-for-bit reproducible for a given build.
  function freshClock(s) { s.pulseClock = 4096 * Math.ceil((s.pulseClock + 2) / 4096); s.lastNow = 0; s.ntex?.clearEvents(); s.makeSim(); } // monotonic, exact, no stale cell flashes
  function spreadRegions(cere, maxL, grid, BRIGHT) {
    const [x0, y0, x1, y1] = cere.box, gx = grid[0], gy = grid[1], cells = [];
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) cells.push({ i, j, area: 0, mask: 0, flash: 0 });
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const ci = Math.min(gx - 1, Math.floor(((x - x0) / (x1 - x0 + 1)) * gx)), cj = Math.min(gy - 1, Math.floor(((y - y0) / (y1 - y0 + 1)) * gy)), c = cells[cj * gx + ci], k = y * cere.w + x;
      c.area++; if (cere.mask[k]) { c.mask++; if (maxL[k] >= BRIGHT) c.flash++; }
    }
    return cells;
  }
  window.__px = {
    /** PRODUCTION lightning window: fresh seeded scheduler, real gate + real frame path at 32 fps for 'secs'. Per frame the bolt layers alone are read back
     *  raw (spread, transience, anything outside the tissue), optionally the real-link bolts and the arbors (motion evidence) and the COMPOSITED frame
     *  (photosensitivity: WCAG 2.3.1 general-flash area rule, |dY| >= 0.1 with the darker state < 0.8 over >= 25% of any 341x256 window). */
    lightWindow(s, o) {
      const fps = 32, frames = Math.round(o.secs * fps), all = coverageRaw(s, null), cere = coverageRaw(s, ["cortex_lh", "cortex_rh"]), W = all.w, H = all.h, N = W * H;
      const PEAK = 0.6 * 765, DARK = 0.1 * 765, BRIGHT = 0.35 * 765, LIT = 18, maxL = new Uint16Array(N), ep = new Int32Array(N).fill(-1);
      const r = { frames, outside: 0, outsideFrames: 0, episodes: 0, violations: 0, maxEpisodeMs: 0, activeMax: 0, strikes: 0, linkStrikes: 0, ambientStrikes: 0, links: null, arbor: null, photo: null };
      freshClock(s); s.frame(0);
      let arb0 = null; if (o.arbor) arb0 = grab(s, ["arbor"], "arb0").d.slice();
      const L = o.links ? { bright: 0, coloured: 0, outside: 0 } : null, A = o.arbor ? { bright: 0, coloured: 0, outside: 0, changed: 0 } : null;
      const P = o.photo ? { prev: new Float32Array(N), flag: new Uint8Array(N), integ: new Int32Array((W + 1) * (H + 1)), trans: [], maxFrac: 0, meanDY: 0 } : null, WW = 341, WH = 256;
      const s0 = s.sim.strikes, l0 = s.sim.log.length, a0 = s.sim.ambientLog.length;
      for (let k = 1; k <= frames; k++) {
        s.frame(k * 31.25);
        r.activeMax = Math.max(r.activeMax, s.sim.active());
        if (P) { // the composited frame frame() just drew
          const c = readRaw(s, "comp").d; let any = 0, sumDY = 0;
          for (let i = 0; i < N; i++) { const q = i * 4, y = 0.2126 * YL[c[q]] + 0.7152 * YL[c[q + 1]] + 0.0722 * YL[c[q + 2]], py = P.prev[i]; if (k > 1) { const dy = Math.abs(y - py); sumDY += dy; P.flag[i] = dy >= 0.1 && Math.min(y, py) < 0.8 ? 1 : 0; any |= P.flag[i]; } P.prev[i] = y; }
          let frac = 0;
          if (k > 1 && any) { const I = P.integ; for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += P.flag[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
            for (let y = 0; y + WH <= H; y += 16) for (let x = 0; x + WW <= W; x += 16) { const v = I[(y + WH) * (W + 1) + x + WW] - I[y * (W + 1) + x + WW] - I[(y + WH) * (W + 1) + x] + I[y * (W + 1) + x]; if (v > frac) frac = v; }
            frac /= WW * WH; }
          if (k > 1) { P.trans.push(frac >= 0.25 ? 1 : 0); P.maxFrac = Math.max(P.maxFrac, frac); P.meanDY += sumDY / N / (frames - 1); }
        }
        const b = grab(s, ["linkBolts", "ambientBolts"], "bolt").d; let out = 0;
        for (let i = 0; i < N; i++) { const q = i * 4, l = b[q] + b[q + 1] + b[q + 2]; if (l > maxL[i]) maxL[i] = l; if (!all.mask[i] && l > LIT) out++;
          if (l >= PEAK) { if (ep[i] === -1) { ep[i] = k; r.episodes++; } } else if (l < DARK) { if (ep[i] >= 0) r.maxEpisodeMs = Math.max(r.maxEpisodeMs, (k - ep[i]) * 31.25); ep[i] = -1; }
          if (ep[i] >= 0 && k - ep[i] > 0.5 * fps) { r.violations++; r.maxEpisodeMs = Math.max(r.maxEpisodeMs, (k - ep[i]) * 31.25); ep[i] = -2; } }
        r.outside += out; if (out) r.outsideFrames++;
        if (L) { const d = grab(s, ["linkBolts"], "lnk").d; let br = 0, co = 0, ou = 0; for (let i = 0; i < N; i++) { const q = i * 4, sm = d[q] + d[q + 1] + d[q + 2]; if (sm <= LIT) continue; if (!all.mask[i]) { ou++; continue; } if (sm / 765 > 0.4) br++; if (CHR(d, q) > 40 && sm / 765 > 0.03) co++; } L.bright = Math.max(L.bright, br); L.coloured = Math.max(L.coloured, co); L.outside += ou; }
        if (A) { const d = grab(s, ["arbor"], "arb").d; let br = 0, co = 0, ou = 0, ch = 0; for (let i = 0; i < N; i++) { const q = i * 4, diff = Math.max(Math.abs(d[q] - arb0[q]), Math.abs(d[q + 1] - arb0[q + 1]), Math.abs(d[q + 2] - arb0[q + 2])); if (diff <= 8) continue; if (!all.mask[i]) { ou++; continue; } ch++; if (Math.max(SUM(d, q), SUM(arb0, q)) / 765 > 0.4) br++; if (CHR(d, q) > 40 && SUM(d, q) / 765 > 0.03) co++; } A.bright = Math.max(A.bright, br); A.coloured = Math.max(A.coloured, co); A.outside += ou; A.changed = Math.max(A.changed, ch); }
      }
      s.lastNow = 0;
      r.strikes = s.sim.strikes - s0; r.linkStrikes = s.sim.log.length - l0; r.ambientStrikes = s.sim.ambientLog.length - a0; r.links = L; r.arbor = A; r.rateMax = s.sim.rateMax; r.bigRateMax = s.sim.bigRateMax;
      if (P) { let m = 0; for (let k = 0; k < P.trans.length; k++) { let c = 0; for (let j = k; j < Math.min(P.trans.length, k + fps); j++) c += P.trans[j]; m = Math.max(m, c); } r.photo = { maxAreaFrac: +P.maxFrac.toFixed(4), significantTransitionsMaxPerSec: m, generalFlashesMaxPerSec: m / 2, meanAbsDY: +P.meanDY.toFixed(5) }; }
      if (o.grid) { r.cells = spreadRegions(cere, maxL, o.grid, BRIGHT); const [x0, , x1] = cere.box, mx = (x0 + x1) / 2; let lf = 0, rf = 0; for (let y = cere.box[1]; y <= cere.box[3]; y++) for (let x = x0; x <= x1; x++) { const k = y * W + x; if (cere.mask[k] && maxL[k] >= BRIGHT) { if (x < mx) lf++; else rf++; } } r.halves = [lf, rf]; }
      r.cerebrumPx = cere.n; r.flashPx = 0; for (let i = 0; i < N; i++) if (cere.mask[i] && maxL[i] >= BRIGHT) r.flashPx++;
      if (o.image) { const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const x = cv.getContext("2d"), im = x.createImageData(W, H); for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const src = y * W + xx, dst = ((H - 1 - y) * W + xx) * 4, v = Math.min(255, maxL[src] / 3), m = all.mask[src] ? 28 : 0; im.data[dst] = Math.max(v, m); im.data[dst + 1] = Math.max(v, m); im.data[dst + 2] = Math.max(v, m + (cere.mask[src] ? 20 : 0)); im.data[dst + 3] = 255; } x.putImageData(im, 0, 0); r.image = cv.toDataURL("image/png"); }
      return r;
    },
    /** STRICT transience: one real strike at a time (the production parameter draw), rendered alone at 64 fps from its start until 1.2 s later. Every
     *  pixel that reaches the peak level must be dark again within 0.5 s of first reaching it. Picks the most camera-facing on-screen channels. */
    isolatedStrikes(s, perKind) {
      const all = coverageRaw(s, null), W = all.w, H = all.h, N = W * H, PEAK = 0.6 * 765, DARK = 0.1 * 765, fps = 64, out = [], cam = s.camera.position, V = s.camera.position.clone();
      freshClock(s); const saved = s.sim.rates; s.sim.rates = { ...saved, link: 0, ambient: 0, cascade: 0 };
      const pick = (kind) => { const L = kind === 1 ? s.boltA : s.boltL; return L.bolts.map((b, i) => { if (b.n < 8) return null; const p = V.set(b.center[0], b.center[1], b.center[2]).project(s.camera); if (Math.abs(p.x) > 0.75 || Math.abs(p.y) > 0.75) return null; const v = [cam.x - b.center[0], cam.y - b.center[1], cam.z - b.center[2]], vl = Math.hypot(...v); let face = 0.5; if (b.nrm) { face = 0; for (let j = 0; j < b.n; j++) face += (b.nrm[j * 3] * v[0] + b.nrm[j * 3 + 1] * v[1] + b.nrm[j * 3 + 2] * v[2]) / vl / b.n; } return [face + b.radius, i]; }).filter(Boolean).sort((a, c) => c[0] - a[0]).slice(0, perKind).map(([, i]) => [kind, i]); };
      for (const [kind, bolt] of [...pick(0), ...pick(1)]) {
        s.sim.reset(s.pulseClock); const T = s.pulseClock + 0.0625, st = s.sim.strikeNow(kind, bolt, T), ep = new Int32Array(N).fill(-1); let peakPx = 0, viol = 0, maxEp = 0;
        for (let k = 0; k <= 1.2 * fps; k++) { s.pulseClock = T + k / fps; s.lastNow = 0; s.frame(0);
          const b = grab(s, ["linkBolts", "ambientBolts"], "iso").d;
          for (let i = 0; i < N; i++) { const q = i * 4, l = b[q] + b[q + 1] + b[q + 2];
            if (l >= PEAK) { if (ep[i] === -1) { ep[i] = k; peakPx++; } } else if (l < DARK) { if (ep[i] >= 0) maxEp = Math.max(maxEp, k - ep[i]); ep[i] = -1; }
            if (ep[i] >= 0 && k - ep[i] > 0.5 * fps) { viol++; maxEp = Math.max(maxEp, k - ep[i]); ep[i] = -2; } } }
        out.push({ kind, bolt, peakPx, violations: viol, maxEpisodeMs: Math.round(maxEp * 1000 / fps), leaderMs: Math.round(st.leader * 1000), restrikes: st.gaps.filter((g) => g > 0).length, tauMs: Math.round(st.tau * 1000) });
      }
      s.sim.rates = saved; s.sim.reset(s.pulseClock); s.lastNow = 0;
      return out;
    },
    // drag preview positive control: pixels the held cell's stale (un-reclipped) arbor + incident fibres WOULD add if drawn (must be > 0, so the hold removes real geometry)
    async heldDelta(s, i, clock) {
      const nt = s.ntex, ft = s.ftex, inc = s.fibres.map((fb, f) => (fb.src === i || fb.dst === i ? f : -1)).filter((f) => f >= 0);
      const held = shoot(s, ["arbor", "edges"], false, { force: true, clock });
      nt.setHidden(i, false); inc.forEach((f) => ft.setHidden(f, false));
      let open; try { open = shoot(s, ["arbor", "edges"], false, { force: true, clock }); } finally { nt.setHidden(i, true); inc.forEach((f) => ft.setHidden(f, true)); }
      const [a, b] = await Promise.all([held, open].map(decode)); let n = 0;
      for (let k = 0; k < a.d.length; k += 4) if (a.d[k] !== b.d[k] || a.d[k + 1] !== b.d[k + 1] || a.d[k + 2] !== b.d[k + 2]) n++;
      return { delta: n, incident: inc.length };
    },
    // pickable cortical note for a drag route (real screen position, soma picking), and a world point's screen position
    dragPick(s, kind) {
      const b = s.canvas.getBoundingClientRect(), P = s.brainP, out = [];
      for (let i = 0; i < s.graph.nodes.length; i++) {
        if (s.place[i].region !== "cortex" || s.graph.nodes[i].degree < 2) continue;
        const p = s.screenOf(i); if (p.x < b.left + 60 || p.x > b.right - 60 || p.y < b.top + 60 || p.y > b.bottom - 60 || s.pick(p.x, p.y) !== i) continue;
        out.push({ i, x: p.x, y: p.y, w: [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], id: s.graph.nodes[i].id });
      }
      if (kind === "fissure") return out.filter((c) => c.w[0] < -0.04).sort((a, c) => Math.abs(a.w[0]) - Math.abs(c.w[0]))[0] || null; // left hemisphere, nearest the midline
      return out.filter((c) => c.w[1] > -0.25).sort((a, c) => a.w[2] - c.w[2])[0] || null; // most posterior (occipital) cell above the cerebellum
    },
    screenOfWorld(s, w) { const v = s.starPos(0).set(w[0], w[1], w[2]).project(s.camera), r = s.canvas.getBoundingClientRect(); return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height }; },
    held(s, i) { const P = s.brainP, f = s.field, d = s.debug(); return { preview: d.preview, renderedLinks: d.layers.renderedLinks, edges: d.edges, gate: d.pulses.gate, somaDepth: f.depthE(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), need: f.margin + f.fadeBand }; },
    // real runtime observables (no reimplemented gate): shader enable uniform, pulse clock, scheduler log, gate reason when the build exposes it
    obs(s) { const sim = s.sim, lg = sim ? sim.log : [];
      return { uAnim: s.sh.uAnim.value, clock: s.pulseClock, uClock: s.sh.uClock.value, launches: lg.length, lastLaunch: lg.length ? lg[lg.length - 1][1] : -1, strikes: sim ? sim.strikes : 0, active: sim ? sim.active() : 0, queued: sim ? sim.queued() : 0,
        reason: s.gateReason === undefined ? null : s.gateReason, mode: s.mode, morph: s.morph, intro: s.introProgress, pulsesOn: s.pulsesOn, assetLoaded: !!s.asset, field: !!s.field, verified: s.asset ? (s.asset.fieldVerified === undefined ? null : s.asset.fieldVerified) : null }; },
    async frameA(s, production) { window.__fa = await snapshot(s, production); },
    async frameB(s, production) { const b = await snapshot(s, production), a = window.__fa;
      return { ...motion(a[0], b[0], a[3]), links: production ? motion(a[1], b[1], a[3]) : null, arbor: production ? motion(a[2], b[2], a[3]) : null }; },
    async evaluate(s, vp, T, thr) {
      s.setAutoRotate(false); if (s.mode !== "brain") s.setMode("brain", true);
      s.setCamera(vp.pos, vp.target); s.setPulses(true); s.camTween = null;
      for (let i = 0; i < 3; i++) s.frame(performance.now());
      // silhouette: ACTUAL tissue meshes, plain bright material, all emissive/background hidden, exact coverage (no dilation)
      const silShot = coverage(s), legShot = shoot(s, [], true, { plain: true });
      const silImg = await decode(silShot), legImg = await decode(legShot), N = silImg.w * silImg.h, sil = new Uint8Array(N); let silN = 0, silLegacy = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
      for (let i = 0; i < N; i++) { if (SUM(silImg.d, i * 4) > thr.SIL) { sil[i] = 1; silN++; const x = i % silImg.w, y = (i / silImg.w) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; } if (SUM(legImg.d, i * 4) > 60) silLegacy++; }
      const blank = await decode(shoot(s, [], false, { force: true }));   // blank-emission, tissue hidden: clear colour only
      const dil = boxDilate(sil, silImg.w, silImg.h, thr.BLOOM_MARGIN);
      const bg = BG.filter(k => s[k]?.visible), visible = NEURON.filter(k => s[k]?.visible).concat(bg);
      // Static, identical-clock controls use the actual background visibility (never force hidden universe glow/dust into brain mode).
      const sc = !!(s.composer && s.bloomPass), u1 = shoot(s, bg, true, { force: true, clock: T[0], composer: sc }), u2 = shoot(s, bg, true, { force: true, clock: T[0], composer: sc }), u3 = shoot(s, bg, true, { force: true, clock: T[1], composer: sc });
      const sA = await decode(u1), sA2 = await decode(u2), sB = await decode(u3);
      let staticRepeatDelta = 0, staticClockDelta = 0;
      for (let i = 0; i < N * 4; i += 4) { if (sA.d[i] !== sA2.d[i] || sA.d[i + 1] !== sA2.d[i + 1] || sA.d[i + 2] !== sA2.d[i + 2]) staticRepeatDelta++; if (sA.d[i] !== sB.d[i] || sA.d[i + 1] !== sB.d[i + 1] || sA.d[i + 2] !== sB.d[i + 2]) staticClockDelta++; }
      const per = [], imgs = [], layers = {}; let rawUrl = null;
      for (const pc of T) {
        const rs = shoot(s, NEURON, false, { force: true, clock: pc }), raw = await decode(rs); imgs.push(raw); if (pc === T[0]) rawUrl = rs.url;
        let inBright = 0, inSat = 0;
        for (let i = 0; i < N; i++) if (sil[i]) { const o = i * 4, l = SUM(raw.d, o) / 765; if (l > thr.CTRL_BRIGHT) inBright++; if (CHR(raw.d, o) > thr.CTRL_SAT && l > thr.CTRL_SAT_L) inSat++; }
        const rec = { pc, raw: { outAny: outsideDiff(raw, blank, sil, 0), outVisible: outsideDiff(raw, blank, sil, 6), inBright, inSat }, bloom: null };
        if (pc === T[0]) for (const k of NEURON) if (s[k]) layers[k] = outsideDiff(await decode(shoot(s, [k], false, { force: true, clock: pc })), blank, sil, 0);
        if (sc) {
          const o = { force: true, clock: pc, composer: true };
          const cu = shoot(s, visible, true, o), bu = shoot(s, bg, true, o), nb = shoot(s, visible, true, { ...o, noBloom: true }), gu = shoot(s, visible, true, { ...o, guardOff: true }); // all in one synchronous block
          const [comp, bl, sharp, open] = await Promise.all([cu, bu, nb, gu].map(decode));
          let beyond = 0, total = 0, beyondRaw = 0, addedInside = 0, addedBeyond = 0, sourceAny = 0;
          for (let i = 0; i < N; i++) { const o = i * 4; let m = 0, added = 0, un = 0;
            for (let c = 0; c < 3; c++) { m += Math.max(0, comp.d[o + c] - bl.d[o + c]); added += Math.max(0, comp.d[o + c] - sharp.d[o + c]); un += Math.max(0, open.d[o + c] - sharp.d[o + c]); }
            if (m / 765 > thr.BLOOM_L) { total++; if (!dil[i]) beyond++; }
            if (SUM(comp.d, o) / 765 > thr.BLOOM_L && !dil[i]) beyondRaw++;
            if (added > 0 && sil[i]) addedInside++;
            if (added / 765 > thr.BLOOM_L && !dil[i]) addedBeyond++;
            if (un > 0) sourceAny++;
          }
          rec.bloom = { brightTotal: total, brightBeyond: beyond, unsubtractedBeyond: beyondRaw, addedInside, addedBeyond, unguardedBloomAnywhere: sourceAny };
        }
        per.push(rec);
      }
      let changedBright = 0, changedSat = 0; const a = imgs[0], b = imgs[1];
      for (let i = 0; i < N; i++) if (sil[i]) { const o = i * 4, la = SUM(a.d, o) / 765, lb = SUM(b.d, o) / 765;
        if ((la > thr.CTRL_BRIGHT) !== (lb > thr.CTRL_BRIGHT)) changedBright++;
        if ((CHR(a.d, o) > thr.CTRL_SAT && la > thr.CTRL_SAT_L) !== (CHR(b.d, o) > thr.CTRL_SAT && lb > thr.CTRL_SAT_L)) changedSat++; }
      return { w: silImg.w, h: silImg.h, silBounds: [bx0, by0, bx1, by1], silLegacy, silUrl: silShot.url, rawUrl, silPixels: silN, per, layers, changedBright, changedSat, staticRepeatDelta, staticClockDelta };
    },
  };
})()`;

// ------------------------------------------------------------------ launch
const checks = []; // every objective check is recorded; none throws, so the red count is complete
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.log("FAIL", name, detail ?? ""); return !!ok; };
const summary = { layerTotals: {}, staticRepeat: 0, staticClock: 0, cases: [], dragCases: [], states: [], lightning: [], rawOutsideTotal: 0, rawVisibleTotal: 0, bloomBeyondTotal: 0, bloomUnsubtractedTotal: 0, viewpoints: 0 };

async function newPage(browser, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 }), page = await ctx.newPage();
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/ReadPixels|GPU stall/i.test(m.text())) errors.push(m.type() + ": " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.addInitScript(PX_HELPER);
  return { ctx, page };
}
async function openDemo(page, q) {
  await page.goto(`${BASE}?asset=${q.asset}&n=${q.n}&quality=${q.quality}&rotate=0&intro=${q.intro ?? 0}&morph=${q.morph ?? 800}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__atlas && window.__atlas.scene.debug().frames > 3, null, { timeout: 120000 });
  if (q.waitAsset !== false) await page.waitForFunction(() => window.__atlas.scene.debug().assetLoaded, null, { timeout: 120000 });
}
const OBS = () => window.__px.obs(window.__atlas.scene);

async function runRegression(browser, { n, quality, viewpoints, pulseOf }, label) {
  const errors = [], { ctx, page } = await newPage(browser, errors);
  try {
    await openDemo(page, { asset: "assets", n, quality });
    await page.waitForTimeout(1500); // let impulses launch
    const d = await page.evaluate(() => window.__atlas.scene.debug());
    check(`${label}: quality=${quality}`, d.quality === quality, d.quality);
    check(`${label}: bloom matches quality`, d.bloom === (quality !== "low"), String(d.bloom));
    check(`${label}: real GLB loaded`, d.assetLoaded);
    const row = { label, quality, n, bloom: d.bloom, viewpoints: [] };
    { // PRODUCTION animation evidence: no forced uniforms, fixed camera, real scheduler + two real frames
      await page.evaluate((vp) => { const s = window.__atlas.scene; s.setAutoRotate(false); s.setCamera(vp.pos, vp.target); s.camTween = null; }, VIEWPOINTS[0]);
      await page.waitForTimeout(400);
      const ps = await sampleState(page, 2000, true); row.production = ps;
      check(`${label}: PRODUCTION gate open on valid field (uAnim=1, no override)`, ps.o0.uAnim === 1 && ps.o1.uAnim === 1, `uAnim ${ps.o0.uAnim}->${ps.o1.uAnim} reason=${ps.o1.reason} verified=${ps.o1.verified}`);
      check(`${label}: PRODUCTION scheduler strikes + clock advances (real time)`, ps.launched && ps.clockAdv > 0, `strikes ${ps.o0.strikes}->${ps.o1.strikes} links ${ps.o0.launches}->${ps.o1.launches} clockAdv=${ps.clockAdv}`);
      // lightning flashes are brief: two instants can miss them, so the motion evidence is a deterministic 6 s window on the real scheduler and frame path
      await page.waitForFunction(() => window.__atlas.scene.boltsReady, null, { timeout: 60000 });
      const pw = await page.evaluate(() => window.__px.lightWindow(window.__atlas.scene, { secs: 6, links: true, arbor: true })); row.productionWindow = { ...pw, image: undefined };
      for (const [name, m] of [["real-link bolts only", pw.links], ["note arbors only (flash at the return stroke)", pw.arbor]])
        check(`${label}: PRODUCTION bright and coloured flashes (${name}, fixed camera, no decor or sparkle; 6 s window, real scheduler, 32 fps)`, m.bright > 0 && m.coloured > 0 && m.outside === 0, JSON.stringify({ ...m, linkStrikes: pw.linkStrikes }));
      check(`${label}: PRODUCTION link strikes in the window ride real edges and light the tissue only`, pw.linkStrikes > 0 && pw.outside === 0, JSON.stringify({ links: pw.linkStrikes, ambient: pw.ambientStrikes, outside: pw.outside }));
      let act = pw.activeMax, dbg = null; for (let k = 0; k < 6; k++) { dbg = await page.evaluate(() => window.__atlas.scene.debug()); act = Math.max(act, dbg.impulsesActive); await page.waitForTimeout(250); }
      row.parity = { tris: dbg.assetTriangles, edges: dbg.edges, renderedLinks: dbg.layers.renderedLinks, pulseEdgesReal: dbg.layers.pulseEdgesReal, impulsesActiveMax: act, pulseGate: dbg.pulseGate, contained: dbg.contained, containLive: dbg.containLive, geomSamples: dbg.geomSamples, geomOutside: dbg.geomOutside, pulseSamples: dbg.pulseSamples, pulseOutside: dbg.pulseOutside };
      check(`${label}: asset triangles > 0 (real GLB loaded; high=${quality === "high"})`, dbg.assetTriangles > 0, String(dbg.assetTriangles));
      check(`${label}: PRODUCTION graph parity: drawn links == graph edges > 0`, dbg.edges > 0 && dbg.layers.renderedLinks === dbg.edges, `edges=${dbg.edges} rendered=${dbg.layers.renderedLinks}`);
      check(`${label}: PRODUCTION pulse paths are exactly the real edges`, dbg.layers.pulseEdgesReal === true, String(dbg.layers.pulseEdgesReal));
      check(`${label}: PRODUCTION active strikes > 0 (window + 1.5 s real time, gate open, no override)`, act > 0 && dbg.pulseGate === true, `activeMax=${act} gate=${dbg.pulseGate}`);
      check(`${label}: PRODUCTION every bolt segment measured inside (diag counters)`, dbg.boltSamples > 1000 && dbg.boltOutside === 0, JSON.stringify([dbg.boltSamples, dbg.boltOutside]));
      check(`${label}: contained + live`, dbg.contained === true && dbg.containLive === true, `contained=${dbg.contained} live=${dbg.containLive}`);
    }
    for (const vp of viewpoints) await recordView(page, label, vp, row);
    summary.viewpoints += viewpoints.length; summary.cases.push(row);
  } catch (e) { check(`${label}: harness error`, false, e.message); } finally { await ctx.close(); }
}
// One evaluated view (fixed camera `vp`): mask, raw-outside, bloom-beyond and in-mask controls. Shared by the viewpoint sweep and the drag-preview steps.
async function recordView(page, label, vp, row, opts = {}) {
      const pc0 = await page.evaluate(() => window.__atlas.scene.pulseClock);
      const r = await page.evaluate(({ vp, T, thr }) => window.__px.evaluate(window.__atlas.scene, vp, T, thr), { vp, T: [pc0, pc0 + PULSE_DELTA],
        thr: { SIL: SIL_SUM, BLOOM_L, BLOOM_MARGIN: BLOOM_MARGIN_PX, CTRL_BRIGHT: CTRL_BRIGHT_L, CTRL_SAT, CTRL_SAT_L } });
      const png = (u, suffix) => fs.writeFileSync(path.join(SHOTS, `${label}__${vp.name}__${suffix}.png`), Buffer.from(u.split(",")[1], "base64"));
      png(r.silUrl, "mask"); if (r.rawUrl) png(r.rawUrl, "emissive");
      const v = { name: vp.name, silPixels: r.silPixels, silLegacy: r.silLegacy, silBounds: r.silBounds, frame: [r.w, r.h], layersOutside: r.layers,
        rawOutside: r.per.map((p) => p.raw.outAny), rawVisible: r.per.map((p) => p.raw.outVisible),
        bloomBeyond: r.per.filter((p) => p.bloom).map((p) => p.bloom.brightBeyond), bloomUnsubtracted: r.per.filter((p) => p.bloom).map((p) => p.bloom.unsubtractedBeyond),
        bloomAddedInside: r.per.filter((p) => p.bloom).map((p) => p.bloom.addedInside), bloomAddedBeyond: r.per.filter((p) => p.bloom).map((p) => p.bloom.addedBeyond), bloomUnguardedAny: r.per.filter((p) => p.bloom).map((p) => p.bloom.unguardedBloomAnywhere),
        inBright: r.per.map((p) => p.raw.inBright), inSat: r.per.map((p) => p.raw.inSat), changedBright: r.changedBright, changedSat: r.changedSat };
      row.viewpoints.push(v);
      summary.rawOutsideTotal += Math.max(...v.rawOutside); summary.rawVisibleTotal += Math.max(...v.rawVisible);
      summary.bloomBeyondTotal += v.bloomBeyond.reduce((a, b) => a + b, 0); summary.bloomUnsubtractedTotal += v.bloomUnsubtracted.reduce((a, b) => a + b, 0);
      for (const [k, x] of Object.entries(v.layersOutside)) summary.layerTotals[k] = (summary.layerTotals[k] || 0) + x;
      summary.staticRepeat += r.staticRepeatDelta; summary.staticClock += r.staticClockDelta;
      const id = `${label}/${v.name}`, [bx0, by0, bx1, by1] = v.silBounds, fw = r.w, fh = r.h;
      check(`${id}: coverage mask non-trivial (>=3% of frame, bbox >=20% of frame each way) [mask validity]`, r.silPixels >= 0.03 * fw * fh && bx1 - bx0 >= 0.2 * fw && by1 - by0 >= 0.2 * fh, `px=${r.silPixels} legacyLit=${r.silLegacy} bbox=${v.silBounds} frame=${fw}x${fh}`);
      check(`${id}: static composite (emissive hidden) identical across repeat renders [class: static]`, r.staticRepeatDelta === 0, String(r.staticRepeatDelta));
      check(`${id}: static composite independent of pulse clock, so frame diffs are emissive draws only [class: static]`, r.staticClockDelta === 0, String(r.staticClockDelta));
      check(`${id}: raw emissive outside silhouette == 0`, Math.max(...v.rawOutside) === 0, `any-byte-diff pixels=${v.rawOutside} layers=${JSON.stringify(v.layersOutside)}`);
      if (row.bloom) {
        if (!opts.sourceAware) check(`${id}: bloom adds light inside at both clocks`, v.bloomAddedInside.length === 2 && v.bloomAddedInside.every((x) => x > 0), `inside=${v.bloomAddedInside}`);
        else { // drag preview: focus dim + held links can leave no source above the HDR threshold at the later forced clock (control: unguarded bloom is then 0 too)
          check(`${id}: bloom adds light inside wherever any bloom source exists (unguarded control) and at >= 1 clock`, v.bloomAddedInside.length === 2 && v.bloomAddedInside.every((x, k) => x > 0 || v.bloomUnguardedAny[k] === 0) && v.bloomAddedInside.some((x) => x > 0), `inside=${v.bloomAddedInside} unguardedAnywhere=${v.bloomUnguardedAny}`);
        }
        check(`${id}: zero bright emissive bloom beyond ${BLOOM_MARGIN_PX}px`, v.bloomBeyond.every((x) => x === 0) && v.bloomAddedBeyond.every((x) => x === 0), `emission=${v.bloomBeyond} bloom-only=${v.bloomAddedBeyond}`);
        check(`${id}: zero bright composite pixels beyond ${BLOOM_MARGIN_PX}px`, v.bloomUnsubtracted.every((x) => x === 0), `beyond=${v.bloomUnsubtracted}`);
      }
      check(`${id}: control bright in-mask > 0`, Math.min(...v.inBright) > 0, String(v.inBright));
      check(`${id}: control saturated in-mask > 0`, Math.min(...v.inSat) > 0, String(v.inSat));
      check(`${id}: control bright moves [STRESS: forced uAnim+uClock, NOT evidence of production animation]`, v.changedBright > 0, String(v.changedBright));
      check(`${id}: control saturated moves [STRESS: forced uAnim+uClock, NOT evidence of production animation]`, v.changedSat > 0, String(v.changedSat));
      await page.screenshot({ path: path.join(SHOTS, `${label}__${vp.name}.png`) });
      return v;
}

// Real render pulse gate: sample the actual uniform/clock/scheduler and two real frames (pulse layers) ~1.5 s apart.
async function sampleState(page, wait, production = false) {
  const o0 = await page.evaluate(OBS); await page.evaluate((p) => window.__px.frameA(window.__atlas.scene, p), production);
  await page.waitForTimeout(wait);
  const o1 = await page.evaluate(OBS), delta = await page.evaluate((p) => window.__px.frameB(window.__atlas.scene, p), production);
  return { o0, o1, delta, clockAdv: +(o1.clock - o0.clock).toFixed(3), launched: o1.strikes !== o0.strikes || o1.launches !== o0.launches || o1.lastLaunch !== o0.lastLaunch };
}
async function gateState(browser, field, dir, state) {
  const errors = [], { ctx, page } = await newPage(browser, errors), id = `field=${field} state=${state}`;
  try {
    const q = { asset: dir, n: 60, quality: "high", intro: state === "intro" ? 1 : 0, morph: state === "mid-morph" ? 9000 : 800 };
    await openDemo(page, q);
    let wait = 1500, valid = true;
    if (state === "mid-morph") { await page.click(".pa-mode"); await page.waitForFunction(() => { const m = window.__atlas.scene.debug().morph; return m > 0.1 && m < 0.6; }, null, { timeout: 8000 }); }
    else if (state === "universe") { await page.click(".pa-mode"); await page.waitForFunction(() => window.__atlas.scene.debug().morph === 1, null, { timeout: 8000 }); }
    else if (state === "brain") { if (field === "valid") await page.waitForFunction(() => window.__atlas.scene.sh.uAnim.value === 1, null, { timeout: 6000 }).catch(() => {}); else await page.waitForTimeout(1500); }
    else wait = 900;
    const live = field === "valid" && state === "brain", s = await sampleState(page, wait, live); // open case: real note links / arbors only (no decor, no sparkle)
    if (state === "intro") valid = s.o0.intro < 1 && s.o1.intro < 1; if (state === "mid-morph") valid = s.o1.morph > 0 && s.o1.morph < 1;
    const open = s.o0.uAnim === 1 && s.o1.uAnim === 1;
    const rec = { field, state, valid, open, ...s };
    summary.states.push(rec);
    check(`gate ${id}: sampled in the intended state`, valid, JSON.stringify({ intro: s.o1.intro, morph: s.o1.morph }));
    if (field !== "valid" || state !== "brain") { // missing/corrupt field, OR valid field in intro/mid-morph/universe: gate must be closed
      check(`gate ${id}: pulse uniform closed (uAnim=0)`, !open && s.o0.uAnim === 0 && s.o1.uAnim === 0, `uAnim ${s.o0.uAnim}->${s.o1.uAnim} reason=${s.o1.reason} verified=${s.o1.verified}`);
      check(`gate ${id}: scheduler launched nothing`, !s.launched && s.o1.active === 0, `launches ${s.o0.launches}->${s.o1.launches} active=${s.o1.active}`);
      if (state === "mid-morph") summary.states[summary.states.length - 1].pixelDeltaWaived = "geometry morphs between frames; pulse evidence = uniform + scheduler"; else check(`gate ${id}: zero frame-to-frame pixel delta (pulse layers)`, s.delta.changed === 0, `changed=${s.delta.changed} (>8: ${s.delta.changed8})`);
    } else { // valid field, steady brain: production positive control
      check(`gate ${id}: pulse uniform open (uAnim=1)`, open, `uAnim ${s.o0.uAnim}->${s.o1.uAnim} reason=${s.o1.reason} verified=${s.o1.verified}`);
      check(`gate ${id}: pulse clock advances`, s.clockAdv > 0, String(s.clockAdv));
      check(`gate ${id}: scheduler strikes`, s.launched, `strikes ${s.o0.strikes}->${s.o1.strikes} links ${s.o0.launches}->${s.o1.launches}`);
      await page.waitForFunction(() => window.__atlas.scene.boltsReady, null, { timeout: 60000 });
      const w = await page.evaluate(() => window.__px.lightWindow(window.__atlas.scene, { secs: 6, links: true }));
      check(`gate ${id}: bright coloured flashes on real-link bolts only (no decor/sparkle), inside the tissue (6 s production window)`, w.links && w.links.bright > 0 && w.links.coloured > 0 && w.links.outside === 0 && w.outside === 0, JSON.stringify({ links: w.links, outside: w.outside, linkStrikes: w.linkStrikes }));
    } // valid field in intro/morph/universe is recorded only (state rows in the report)
  } catch (e) { check(`gate ${id}: harness error`, false, e.message); } finally { await ctx.close(); }
}
// Procedural scaffold controls: missing / corrupt GLB must keep working (no containment needed, pulses live)
async function glbControl(browser, kind, dir) {
  const errors = [], { ctx, page } = await newPage(browser, errors);
  try {
    await openDemo(page, { asset: dir, n: 40, quality: "high", waitAsset: false }); await page.waitForTimeout(1500);
    const d = await page.evaluate(() => window.__atlas.scene.debug()), g = await sampleState(page, 1200);
    check(`glb ${kind}: no real GLB loaded (procedural scaffold)`, d.assetLoaded === false && !g.o0.assetLoaded, String(d.assetLoaded));
    check(`glb ${kind}: pulse gate CLOSED (uAnim=0)`, g.o0.uAnim === 0 && g.o1.uAnim === 0, `uAnim ${g.o0.uAnim}->${g.o1.uAnim} reason=${g.o1.reason}`);
    check(`glb ${kind}: scheduler launched nothing`, !g.launched && g.o1.active === 0, `launches ${g.o0.launches}->${g.o1.launches} active=${g.o1.active}`);
    check(`glb ${kind}: zero frame-to-frame pixel delta (pulse layers)`, g.delta.changed === 0, `changed=${g.delta.changed}`);
  } catch (e) { check(`glb ${kind}: harness error`, false, e.message); } finally { await ctx.close(); }
}

// Adversarial edit-drag on the REAL mesh, sampled BEFORE pointerup. Real pointer events drag a cortical cell across the longitudinal fissure (top view) and
// from the occipital lobe across the cerebrum-cerebellum gap to below the brain (side view), then a programmatic preview far past the underside.
// At every sampled step: the soma stays margin+fade deep, the held cell's arbor and incident fibres are not drawn (positive control: they WOULD add pixels),
// the other cells keep pulsing, and the full mask/raw/bloom evaluation passes. After release: preview cleared, drawn links == graph edges, counters clean,
// only the dragged notes are saved, and impulses relaunch on the moved cell's real links.
const DRAG_ROUTES = [
  { name: "fissure", view: "top-fissure", kind: "fissure", to: (w) => [-w[0], w[1], w[2]], stops: [0.5, 1] },
  { name: "cerebellum-gap", view: "left", kind: "occipital", to: (w) => [w[0], -0.95, -0.75], stops: [0.4, 0.7, 1] },
];
async function sampleHeld(page, id, i, vp, row, label) {
  const h = await page.evaluate((i) => window.__px.held(window.__atlas.scene, i), i), p = h.preview;
  check(`${id}: preview active on the dragged cell (arbor held, every incident fibre held)`, p && p.idx === i && p.arborHidden === true && p.incident > 0 && p.fibresHidden === p.incident, JSON.stringify(p));
  check(`${id}: soma stays >= margin + fade band deep (exact distance)`, h.somaDepth >= h.need - 1e-4, `depth=${h.somaDepth.toFixed(4)} need=${h.need.toFixed(4)}`);
  check(`${id}: drawn links == graph edges - held fibres; the other cells keep pulsing (gate open)`, !!p && h.renderedLinks === h.edges - p.incident && h.gate === "open", JSON.stringify({ links: h.renderedLinks, edges: h.edges, gate: h.gate }));
  const pc = await page.evaluate(() => window.__atlas.scene.pulseClock), hd = await page.evaluate(({ i, pc }) => window.__px.heldDelta(window.__atlas.scene, i, pc), { i, pc });
  check(`${id}: positive control - the held stale arbor/fibres would add pixels if drawn`, hd.delta > 0, JSON.stringify(hd));
  await recordView(page, label, { ...vp, name: id.split("/").pop().replace(/[^a-z0-9-]+/gi, "_") }, row, { sourceAware: true });
}
async function dragRegression(browser, quality) {
  const errors = [], { ctx, page } = await newPage(browser, errors), label = `drag-${quality}`, dragged = [];
  try {
    await openDemo(page, { asset: "assets", n: 150, quality });
    await page.waitForFunction(() => window.__atlas.scene.debug().pulseGate, null, { timeout: 60000 });
    const d0 = await page.evaluate(() => window.__atlas.scene.debug()), row = { label, quality, n: 150, bloom: d0.bloom, viewpoints: [] };
    check(`${label}: quality=${quality}, real GLB, verified field live`, d0.quality === quality && d0.assetLoaded && d0.containLive, JSON.stringify({ q: d0.quality, a: d0.assetLoaded, live: d0.containLive }));
    await page.evaluate(() => window.__atlas.scene.setEdit(true));
    for (const rt of DRAG_ROUTES) {
      const vp = VIEWPOINTS.find((v) => v.name === rt.view), id = `${label}/${rt.name}`;
      await page.evaluate((vp) => { const s = window.__atlas.scene; s.setAutoRotate(false); s.setCamera(vp.pos, vp.target); s.camTween = null; for (let k = 0; k < 3; k++) s.frame(performance.now()); }, vp);
      const sel = await page.evaluate((k) => window.__px.dragPick(window.__atlas.scene, k), rt.kind);
      if (!check(`${id}: a pickable cell exists for the route`, !!sel, JSON.stringify(sel))) continue;
      dragged.push(sel.id);
      const end = await page.evaluate((w) => window.__px.screenOfWorld(window.__atlas.scene, w), rt.to(sel.w));
      await page.mouse.move(sel.x, sel.y); await page.mouse.down();
      const STEPS = 12; let k = 0;
      for (const stop of rt.stops) {
        for (; k < Math.round(stop * STEPS); k++) { const u = (k + 1) / STEPS; await page.mouse.move(sel.x + (end.x - sel.x) * u, sel.y + (end.y - sel.y) * u); }
        await sampleHeld(page, `${id}@${Math.round(stop * 100)}pct`, sel.i, vp, row, label);
      }
      if (rt.name === "cerebellum-gap") { // the review's regression call: preview far past the underside, still before pointerup
        await page.evaluate((i) => window.__atlas.scene.setStarPosition(i, [0, -1.6, -0.3], false), sel.i);
        await sampleHeld(page, `${id}@far-underside`, sel.i, vp, row, label);
      }
      await page.mouse.up();
      await page.waitForFunction(() => { const d = window.__atlas.scene.debug(); return d.preview === null && d.layers.renderedLinks === d.edges; }, null, { timeout: 30000 }).catch(() => {});
      const r = await page.evaluate((i) => { const s = window.__atlas.scene, d = s.debug(), P = s.brainP; let held = 0; for (let f = 0; f < s.fibres.length; f++) if (s.ftex.hidden(f)) held++;
        return { preview: d.preview, links: d.layers.renderedLinks, edges: d.edges, arborHeld: s.ntex.hidden(i), held, geomOutside: d.geomOutside, pulseOutside: d.pulseOutside, extentOutside: d.extentOutside, geomSamples: d.geomSamples,
          pos: [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], stored: (JSON.parse(localStorage.getItem("palace-atlas-demo-data") || "{}").positions) || {} }; }, sel.i);
      check(`${id}: release clears the preview (arbor re-clipped, fibres re-routed, nothing held)`, r.preview === null && r.arborHeld === false && r.held === 0, JSON.stringify({ preview: r.preview, arborHeld: r.arborHeld, held: r.held }));
      check(`${id}: release restores real-link parity (drawn links == graph edges)`, r.links === r.edges && r.edges > 0, `links=${r.links} edges=${r.edges}`);
      check(`${id}: release re-measures clearance at <= 0.5 voxel: nothing outside`, r.geomOutside === 0 && r.pulseOutside === 0 && r.extentOutside === 0 && r.geomSamples > 1000, JSON.stringify([r.geomOutside, r.pulseOutside, r.extentOutside, r.geomSamples]));
      const sv = r.stored[sel.id]?.brain;
      check(`${id}: saved only what the user dragged, at the contained position (no silent rewrites)`, Object.keys(r.stored).every((key) => dragged.includes(key)) && !!sv && Math.hypot(sv[0] - r.pos[0], sv[1] - r.pos[1], sv[2] - r.pos[2]) < 1e-6, JSON.stringify({ keys: Object.keys(r.stored).length, sv, pos: r.pos }));
      const relaunched = await page.waitForFunction((i) => { const s = window.__atlas.scene; return s.debug().pulses.gate === "open" && s.impulseLog().some(([a, b]) => a === i || b === i); }, sel.i, { timeout: 30000 }).then(() => true, () => false);
      check(`${id}: impulses relaunch on the moved cell's real links after release`, relaunched, "");
      await recordView(page, label, { ...vp, name: `${rt.name}-released` }, row);
    }
    summary.dragCases.push(row);
    check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  } catch (e) { check(`${label}: harness error`, false, e.message); } finally { await ctx.close(); }
}

// Lightning across the WHOLE cerebrum. From four views (left/right lateral, top, front), a deterministic production window (fresh seeded scheduler,
// real gate and frame path at 32 fps) accumulates the brightest value every pixel of the bolt layers reached. The cerebrum silhouette (cortex meshes
// only) is cut into a grid; every cell with real cerebrum coverage must have bright flash pixels, both hemispheres must flash (top/front), and no
// single central band may dominate. The same windows check transience (lit at a peak -> dark within 0.5 s) and photosensitivity (composited frame,
// WCAG general-flash area rule, <= 3 flashes per second). A strict per-strike transience check renders isolated real strikes.
const LIGHT_VIEWS = [
  { name: "left-lateral", pos: [-3.0, 0.05, 0.12], target: [0, -0.02, 0], grid: [3, 2], kind: "lateral" },
  { name: "right-lateral", pos: [3.0, 0.05, 0.12], target: [0, -0.02, 0], grid: [3, 2], kind: "lateral" },
  { name: "top", pos: [0, 3.4, 0.01], target: [0, 0, 0], grid: [2, 3], kind: "top" },
  { name: "front", pos: [0, 0.15, 3.0], target: [0, 0.05, 0], grid: [2, 2], kind: "front" },
];
const SPREAD_SECS = 16, CELL_COVER = 0.15, CELL_FLASH = 20, TRANSIENT_TOL = 0.02;
async function lightningRegression(browser, quality, n) {
  const errors = [], { ctx, page } = await newPage(browser, errors), label = `lightning-n${n}-${quality}`;
  try {
    await openDemo(page, { asset: "assets", n, quality });
    await page.waitForFunction(() => window.__atlas.scene.debug().pulseGate && window.__atlas.scene.boltsReady, null, { timeout: 60000 });
    const row = { label, quality, n, views: [], isolated: null };
    for (const vp of LIGHT_VIEWS) {
      await page.evaluate((vp) => { const s = window.__atlas.scene; s.setAutoRotate(false); s.setCamera(vp.pos, vp.target); s.camTween = null; for (let k = 0; k < 3; k++) s.frame(performance.now()); }, vp);
      const r = await page.evaluate(({ grid, secs }) => window.__px.lightWindow(window.__atlas.scene, { secs, grid, photo: true, image: true }), { grid: vp.grid, secs: SPREAD_SECS });
      fs.writeFileSync(path.join(SHOTS, `${label}__${vp.name}__flash-max.png`), Buffer.from(r.image.split(",")[1], "base64")); delete r.image;
      row.views.push({ view: vp.name, ...r });
      const id = `${label}/${vp.name}`, live = r.cells.filter((c) => c.mask >= CELL_COVER * c.area), tot = r.flashPx || 1;
      check(`${id}: lightning strikes during the ${SPREAD_SECS} s production window (link and ambient)`, r.linkStrikes > 0 && r.ambientStrikes > 0 && r.activeMax > 0, JSON.stringify({ links: r.linkStrikes, ambient: r.ambientStrikes, activeMax: r.activeMax }));
      check(`${id}: bright flashes in EVERY cerebrum region of a ${vp.grid.join("x")} grid (cells with >= ${CELL_COVER * 100}% cerebrum coverage; >= ${CELL_FLASH} px each)`, live.length >= Math.min(4, vp.grid[0] * vp.grid[1]) && live.every((c) => c.flash >= CELL_FLASH), JSON.stringify(r.cells.map((c) => [c.i, c.j, c.flash, +(c.mask / c.area).toFixed(2)])));
      if (vp.kind !== "lateral") check(`${id}: both hemispheres flash (each half >= 15% of the flash pixels)`, Math.min(...r.halves) >= 0.15 * tot, JSON.stringify(r.halves));
      // not only the centre: the outer bands flash at >= 35% of the middle band's density (flash px per cerebrum px) and the middle band holds <= 60% of all flash px
      const band = (key, k) => { const cs = r.cells.filter((c) => c[key] === k), f = cs.reduce((a, c) => a + c.flash, 0), m = cs.reduce((a, c) => a + c.mask, 0); return { f, dens: f / Math.max(1, m) }; };
      const spread = (key, label) => { const b = [0, 1, 2].map((k) => band(key, k)); check(`${id}: ${label}: outer bands >= 35% of the middle band's flash density, middle band <= 60% of flash pixels`, Math.min(b[0].dens, b[2].dens) >= 0.35 * b[1].dens && b[1].f <= 0.6 * tot, JSON.stringify(b.map((x) => [x.f, +x.dens.toFixed(4)]))); };
      if (vp.kind === "lateral") spread("i", "flashes spread front to back, not only in the centre");
      if (vp.kind === "top") spread("j", "front, middle and back of the cerebrum all flash");
      check(`${id}: no bolt light outside the tissue silhouette in any of ${r.frames} production frames`, r.outside === 0, `outside px=${r.outside} frames=${r.outsideFrames}`);
      check(`${id}: transient flashes (production): pixels lit at a peak are dark again within 0.5 s (<= ${TRANSIENT_TOL * 100}% overlap of separate strikes)`, r.episodes > 100 && r.violations <= TRANSIENT_TOL * r.episodes, JSON.stringify({ episodes: r.episodes, violations: r.violations, maxEpisodeMs: r.maxEpisodeMs }));
      check(`${id}: photosensitivity: <= 3 general flashes per second (WCAG 2.3.1 area rule on the composited frame)`, r.photo.generalFlashesMaxPerSec <= 3, JSON.stringify(r.photo));
      check(`${id}: scheduler flash budget held (<= cap onsets and <= 3 large flashes in any 1 s)`, r.rateMax <= 6 && r.bigRateMax <= 3, JSON.stringify([r.rateMax, r.bigRateMax]));
    }
    await page.evaluate((vp) => { const s = window.__atlas.scene; s.setCamera(vp.pos, vp.target); s.camTween = null; }, LIGHT_VIEWS[0]);
    const iso = await page.evaluate(() => window.__px.isolatedStrikes(window.__atlas.scene, 4)); row.isolated = iso;
    check(`${label}: STRICT transience: every pixel an isolated real strike lights at its peak is dark again within 0.5 s (${iso.length} strikes, link + ambient)`, iso.length >= 6 && iso.filter((x) => x.peakPx > 0).length >= iso.length * 0.75 && iso.every((x) => x.violations === 0), JSON.stringify(iso));
    summary.lightning.push(row);
    check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  } catch (e) { check(`${label}: harness error`, false, e.message); } finally { await ctx.close(); }
}

// ------------------------------------------------------------------ run
const full = process.argv.includes("--full");
if (full && (process.env.PA_QUICK || process.env.PA_PLAN)) { // the release gate never runs a shortened plan
  server.close(); fs.rmSync(SCRATCH_ASSETS, { recursive: true, force: true });
  throw new Error(`--full refuses shortened pixel settings: unset PA_QUICK=${process.env.PA_QUICK ?? ""} PA_PLAN=${process.env.PA_PLAN ?? ""}`);
}
const { browser, page: probe, renderer, mode } = await launchGpu({ width: 1000, height: 700 });
await probe.context().close();
console.log("renderer", `${renderer} (${mode})`);
if (!hardwareRenderer(renderer)) {
  await browser.close(); server.close(); fs.rmSync(SCRATCH_ASSETS, { recursive: true, force: true });
  throw new Error(`Pixel release gate requires hardware WebGL; observed ${renderer}`);
}
const quick = !full && process.env.PA_QUICK === "1";
const pulse = (pc0) => [pc0, pc0 + PULSE_DELTA];
const sub = (vps, k) => vps.filter((_, i) => i % Math.ceil(vps.length / k) === 0).slice(0, k);

const PLAN = full ? "full" : (process.env.PA_PLAN || "full"), pick = (names) => VIEWPOINTS.filter((v) => names.includes(v.name));
if (PLAN === "first") { for (const quality of ["high", "low"]) await runRegression(browser, { n: 31, quality, viewpoints: pick(["overview", "underside"]), pulseOf: pulse }, `n31-${quality}`); }
else if (PLAN === "n150") { for (const quality of ["high", "low"]) await runRegression(browser, { n: 150, quality, viewpoints: pick(["overview", "underside", "top-fissure", "cerebellum-close"]), pulseOf: pulse }, `n150-${quality}`); }
else if (PLAN === "lightning") { for (const [q, n] of [["high", 31], ["high", 150], ["high", 1500], ["low", 150]]) await lightningRegression(browser, q, n); } // development only (refused by --full)
else {
  for (const quality of ["high", "low"]) await runRegression(browser, { n: 150, quality, viewpoints: VIEWPOINTS, pulseOf: pulse }, `n150-${quality}`);
  for (const quality of ["high", "low"]) for (const n of quick ? [31] : [31, 1500]) await runRegression(browser, { n, quality, viewpoints: quick ? sub(VIEWPOINTS, 2) : VIEWPOINTS, pulseOf: pulse }, `n${n}-${quality}`);
  if (!quick) for (const quality of ["high", "low"]) await dragRegression(browser, quality);
  for (const [quality, n] of quick ? [["high", 150]] : [["high", 31], ["high", 150], ["high", 1500], ["low", 150]]) await lightningRegression(browser, quality, n);
}
if (PLAN !== "n150" && PLAN !== "lightning") { // plans: first | n150 | lightning (lightning regressions only) | full
  await glbControl(browser, "missing", "assets-empty"); await glbControl(browser, "corrupt", "assets-corrupt");
  for (const [field, dir] of [["valid", "assets"], ["missing", "assets-nofield"], ["corrupt", "assets-badfield"]]) for (const state of ["intro", "brain", "mid-morph", "universe"]) await gateState(browser, field, dir, state);
}

if (PLAN !== "lightning") { // asset LOD distinctness across ALL cases: every High case sees the same brain.glb count, every Low case the same brain_low.glb count, High > Low
  const tri = (q) => [...new Set(summary.cases.filter((c) => c.quality === q && c.parity).map((c) => c.parity.tris))];
  const th = tri("high"), tl = tri("low");
  check("asset LOD: all High cases load one triangle count (brain.glb)", th.length === 1, JSON.stringify(th));
  check("asset LOD: all Low cases load one triangle count (brain_low.glb)", tl.length === 1, JSON.stringify(tl));
  check("asset LOD: High triangles > Low triangles (distinct assets)", th.length === 1 && tl.length === 1 && th[0] > tl[0], `high=${th} low=${tl}`);
  summary.lod = { highTriangles: th, lowTriangles: tl };
}
if (full) { // the release plan must actually have covered every predetermined angle at every note count and quality, plus both drag cases
  const seen = (label) => (summary.cases.find((c) => c.label === label)?.viewpoints || []).map((v) => v.name);
  check(`coverage: >= 12 predetermined camera angles`, VIEWPOINTS.length >= 12, String(VIEWPOINTS.length));
  for (const n of [31, 150, 1500]) for (const q of ["high", "low"]) check(`coverage: n${n}-${q} evaluated all ${VIEWPOINTS.length} angles`, VIEWPOINTS.every((v) => seen(`n${n}-${q}`).includes(v.name)), JSON.stringify(seen(`n${n}-${q}`)));
  check("coverage: adversarial pre-release drag ran for High and Low", ["drag-high", "drag-low"].every((l) => summary.dragCases.some((c) => c.label === l && c.viewpoints.length >= 2 * DRAG_ROUTES.length)), JSON.stringify(summary.dragCases.map((c) => [c.label, c.viewpoints.length])));
  check("coverage: lightning spread/transience/photosensitivity ran at High 31/150/1500 and Low 150 from all four views", ["lightning-n31-high", "lightning-n150-high", "lightning-n1500-high", "lightning-n150-low"].every((l) => summary.lightning.some((c) => c.label === l && c.views.length === LIGHT_VIEWS.length && c.isolated)), JSON.stringify(summary.lightning.map((c) => [c.label, c.views.length])));
}
// ------------------------------------------------------------------ report
const failed = checks.filter((c) => !c.ok), cat = (c) => (/^drag-/.test(c.name) ? "drag" : /^lightning-/.test(c.name) ? "lightning" : /^coverage/.test(c.name) ? "coverage" : /coverage mask/.test(c.name) ? "mask" : /raw emissive/.test(c.name) ? "raw-outside" : /bloom/.test(c.name) ? "bloom-beyond" : /control/.test(c.name) ? "controls" : /^gate /.test(c.name) ? "field-gate" : /^glb /.test(c.name) ? "glb-fallback" : "other");
const byCat = {}; for (const c of failed) byCat[cat(c)] = (byCat[cat(c)] || 0) + 1;
const report = { renderer, mode, thresholds: { RAW: "any byte diff vs blank-emission (tol 0)", BLOOM_L, BLOOM_MARGIN_PX, SIL_SUM, CTRL_BRIGHT_L, CTRL_SAT, CTRL_SAT_L }, shots: SHOTS, totals: summary.cases.length ? { rawOutsideAnyByteTotal: summary.rawOutsideTotal, rawOutsideVisibleTotal: summary.rawVisibleTotal, bloomBeyondMinusBlankTotal: summary.bloomBeyondTotal, bloomBeyondUnsubtractedTotal: summary.bloomUnsubtractedTotal, viewpoints: summary.viewpoints, layerOutsideTotals: summary.layerTotals, staticRepeatDeltaTotal: summary.staticRepeat, staticClockDeltaTotal: summary.staticClock, lod: summary.lod } : {},
  checks: { total: checks.length, failed: failed.length, byCategory: byCat }, cases: summary.cases, dragCases: summary.dragCases, states: summary.states, lightning: summary.lightning, failedChecks: failed };
const reportPath = process.env.PA_REPORT || path.join(SHOTS, "pixel-results.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log("\nPIXEL REGRESSION REPORT " + JSON.stringify({ renderer, totals: report.totals, checks: report.checks }, null, 2));
for (const s of summary.states) console.log(`state field=${s.field} state=${s.state} valid=${s.valid} uAnim=${s.o0.uAnim}->${s.o1.uAnim} reason=${s.o1.reason} clockAdv=${s.clockAdv} launched=${s.launched} pxChanged=${s.delta.changed}`);
console.log("results: " + reportPath + "\nscreenshots: " + SHOTS);
await browser.close(); server.close();
console.log(`pixel regression: ${failed.length} of ${checks.length} objective checks failed ${JSON.stringify(byCat)}`);
process.exit(failed.length ? 1 : 0);
