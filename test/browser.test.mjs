// Browser harness: serves dist-demo (SYNTHETIC demo fixture) and drives it with system Chrome via playwright-core.
import { chromium } from "playwright-core";
import { CHROME, LOCAL_ONLY } from "./gpu.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";

// Keep generated synthetic screenshots out of source control.
const root = path.resolve(process.env.PA_ROOT || "dist-demo");
const shots = path.resolve(process.env.PA_SHOTS || path.join(os.tmpdir(), "palace-atlas-synthetic", "browser"));
fs.mkdirSync(shots, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary" };
// synthetic brain asset served same-origin for the loader-seam test (a wrinkled-ellipsoid stand-in, not anatomy)
{ const { createRequire } = await import("node:module"); const { makeSynthGlb } = createRequire(import.meta.url)(path.join(root, "synth-glb.cjs"));
  fs.mkdirSync(path.join(root, "assets-synth"), { recursive: true }); const g = Buffer.from(makeSynthGlb(36, 48)), gl = Buffer.from(makeSynthGlb(18, 24));
  fs.writeFileSync(path.join(root, "assets-synth/brain.glb"), g); fs.writeFileSync(path.join(root, "assets-synth/brain_low.glb"), gl); fs.writeFileSync(path.join(root, "assets-synth/index.json"), JSON.stringify(["brain.glb", "brain_low.glb"]));
  fs.mkdirSync(path.join(root, "assets-empty"), { recursive: true }); fs.writeFileSync(path.join(root, "assets-empty/index.json"), "[]");
  // real brain.glb with a CORRUPT brain_sdf.bin (fail-closed / regenerate check)
  fs.mkdirSync(path.join(root, "assets-badsdf"), { recursive: true }); fs.copyFileSync(path.join(root, "assets/brain.glb"), path.join(root, "assets-badsdf/brain.glb")); fs.writeFileSync(path.join(root, "assets-badsdf/brain_sdf.bin"), Buffer.from("PAFD-corrupt-field-bytes".repeat(40))); fs.writeFileSync(path.join(root, "assets-badsdf/index.json"), JSON.stringify(["brain.glb", "brain_sdf.bin"])); }
const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.writeHead(204); return res.end(); }
  const f = path.join(root, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const requests = [];
const GPU = process.env.PA_GPU === "1"; // PA_GPU=1 runs the whole suite on ANGLE/Metal instead of SwiftShader
const gpuArgs = GPU ? ["--use-angle=metal", "--enable-gpu", "--disable-frame-rate-limit", "--disable-gpu-vsync"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"];
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [...LOCAL_ONLY, "--ignore-gpu-blocklist", ...gpuArgs] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GPU stall due to ReadPixels/.test(m.text())) /* ReadPixels stall comes from the test's own toDataURL probe */ errors.push(m.type() + ": " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("request", (r) => requests.push(r.url()));
const results = [];
let perf = null;
const ok = (name, detail = "") => { results.push(name); console.log("PASS", name, detail); };
const dbg = () => page.evaluate(() => window.__atlas.scene.debug());
const wait = (ms) => page.waitForTimeout(ms);

const MAIN = url + "?asset=assets&intro=0"; // real brain.glb + brain_sdf.bin: containment + pulse gating are exercised by the whole suite
const readyBrain = (p = page) => p.waitForFunction(() => window.__atlas?.scene.debug().containLive && window.__atlas.scene.debug().frames > 5, null, { timeout: 120000 });
await page.goto(MAIN);
await readyBrain();

// 1 render + counts
let d = await dbg();
assert(d.webgl, "webgl"); assert(d.contained && d.containLive && d.assetLoaded && d.geomSamples > 1000 && d.pulseSamples > 100 && d.geomOutside === 0 && d.pulseOutside === 0 && d.extentOutside === 0 && d.boltSamples > 1000 && d.boltOutside === 0, "real verified field is live, positive sample counts (incl. every lightning bolt segment), nothing outside: " + JSON.stringify(d)); assert.equal(d.notes, 150); assert.equal(d.dust, 2400); assert(d.edges > 50);
const f1 = d.frames; await page.waitForFunction((f) => window.__atlas.scene.debug().frames > f + 2, f1, { timeout: 30000 }); // software GL: first frames stall on shader compile
const lit = await page.evaluate(() => {
  const ui = window.__atlas; ui.scene.frame(performance.now());
  const src = ui.scene.canvas.toDataURL();
  return new Promise((res) => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const x = c.getContext("2d"); x.drawImage(im, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data; let n = 0, bright = 0; for (let i = 0; i < px.length; i += 4) { if (px[i] + px[i + 1] + px[i + 2] > 60) n++; if (px[i + 3] > 200 && px[i] + px[i + 1] + px[i + 2] > 450) bright++; } res({ n, bright, total: px.length / 4 }); }; im.src = src; });
});
assert(lit.n > lit.total * 0.01, "canvas has rendered content " + JSON.stringify(lit)); assert(lit.bright > 20, "bright star pixels " + lit.bright);
ok("renders brain (non-blank, bright stars)", JSON.stringify(lit));
await page.screenshot({ path: shots + "/brain.png" });
await page.screenshot({ path: shots + "/brain-neurons.png" });
const foot = await page.textContent(".pa-foot");
assert(/^150 notes as neurons · 220 links \(your wikilinks\) · background cells and sparkle are decoration · folders are not brain regions/.test(foot) && !foot.includes("\n") && foot.length < 220, "one-line footer: " + foot);
const tip = await page.$eval(".pa-legend", (e) => e.title);
assert(/150 notes \(neuron cells\)/.test(tip) && /2,400 decorative dust particles \(not notes, not links\)/.test(tip) && /decorative background neurons/.test(tip) && /axon to another's dendrite/.test(tip) && /not synapses/.test(tip) && /folders are not real brain regions/.test(tip) && /bundled original procedural mesh \(illustration, not an anatomical scan/.test(tip) && /not neural activity/.test(tip), tip);
assert.equal(await page.$$eval(".pa-label", (e) => e.length), 0, "no floating folder labels"); assert.equal(await page.$$eval(".pa-legend-item", (e) => e.length), 3, "legend shows 3 folders");
assert(await page.textContent(".pa-banner").then((t) => /DEMO/.test(t)));
ok("counts separate dust vs notes; anatomy vs illustrative placement labelled; DEMO banner");

// 2 filter in list
const titles = await page.$$eval(".pa-item-btn", (b) => b.map((x) => x.dataset.path));
assert.equal(titles.length, 150);
assert(!titles.some((t) => /secret|private|confidential|credential|flagged|tagged-only|fm-excluded|daily|inbox/i.test(t)));
assert((await page.textContent(".pa-foot")).includes("7 private/ineligible"));
ok("excluded decoys absent from list; withheld count 7");

// 3 search
await page.fill(".pa-search", "orbit");
const n1 = await page.$$eval(".pa-item-btn", (b) => b.length); const dm = await dbg();
assert(n1 > 0 && n1 < 150 && dm.matches === n1, `search matches ${n1}/${dm.matches}`);
assert((await page.textContent(".pa-status")).includes(`${n1} of 150`));
await page.fill(".pa-search", "zzzz-nothing"); assert.equal(await page.$$eval(".pa-item-btn", (b) => b.length), 0);
await page.fill(".pa-search", "memories"); assert.equal(await page.$$eval(".pa-item-btn", (b) => b.length), 50);
await page.screenshot({ path: shots + "/search-memories.png" });
await page.fill(".pa-search", ""); assert.equal(await page.$$eval(".pa-item-btn", (b) => b.length), 150);
ok("search filters list + 3D dimming", `orbit=${n1}, memories=50`);

// 3b edges rendered == graph.edges; neuron arbors + decor are decoration; picking is soma-only
{
  const r = await page.evaluate(() => { const s = window.__atlas.scene; const pairs = s.renderedEdgePairs().map(([a, b]) => a + ":" + b).sort(); const want = s.graph.edges.map((e) => e.a + ":" + e.b).sort();
    return { pairs, want, d: s.debug(), arborAttrs: Object.keys(s.arbor.geometry.attributes), decorAttrs: Object.keys(s.decor.geometry.attributes), edgeAttrs: Object.keys(s.edges.geometry.attributes) }; });
  const sup = r.d.pulses.suppressed;
  if (sup === 0) { assert.deepEqual(r.pairs, r.want, "rendered link pairs must equal graph.edges exactly"); assert.equal(r.d.layers.renderedLinks, r.want.length); }
  else { console.log("WARN", sup, "of", r.want.length, "links intentionally fail-closed (route not provably inside); drawn + suppressed must equal graph.edges"); assert(r.pairs.every((x) => r.want.includes(x)) && r.pairs.length + sup === r.want.length && r.d.layers.renderedLinks === r.pairs.length, "drawn + suppressed == graph.edges " + JSON.stringify([r.pairs.length, sup, r.want.length])); }
  assert.equal(r.d.pulses.count, r.want.length, "one link bolt per graph edge regardless of suppression");
  { // lightning model: link bolts == real edges; ambient bolts are decorative and counted separately (never notes, never links)
    const L = r.d.lightning; assert(L.linkBolts === r.want.length && L.ambientBolts > 0 && r.d.pulses.ambient === L.ambientBolts && L.linkSegments > 1000 && L.ambientSegments > 1000, "link bolts == edges, ambient bolts separate: " + JSON.stringify(L));
    const dec = await page.evaluate(() => { const s = window.__atlas.scene; return { link: !!s.linkBolts?.userData.decorative, amb: !!s.ambientBolts?.userData.decorative, linkAttrs: Object.keys(s.linkBolts.geometry.attributes), ambAttrs: Object.keys(s.ambientBolts.geometry.attributes) }; });
    assert(dec.link && dec.amb && !dec.linkAttrs.includes("aA") && !dec.ambAttrs.includes("aA"), "bolt layers are decoration, carry no edge endpoints, never pickable " + JSON.stringify(dec));
  }
  assert(r.d.noteNeuronSegments > 3000 && r.d.layers.dendriteSegments > 300 && r.d.layers.dendriteDecorative, "neuron arbors exist and are decorative");
  assert(!r.arborAttrs.includes("aA") && !r.arborAttrs.includes("aB") && !r.decorAttrs.includes("aA"), "arbors/decor carry no edge endpoints");
  assert(r.d.decorNeurons > 0 && r.d.notes === 150 && r.d.edges === 220 && !("nodes" in r.d) && r.d.layers.pickable === r.d.notes && r.d.decorNeurons !== r.d.notes, "decor neurons are counted separately, never as notes or links: " + JSON.stringify([r.d.notes, r.d.edges, r.d.decorNeurons, r.d.layers.pickable]));
  { // real hit-test: dendrite tips, axon terminals and decor tips far from any soma must NOT pick; isolated somas pick themselves
    const pr = await page.evaluate(() => {
      const s = window.__atlas.scene, cam = s.camera, rect = s.canvas.getBoundingClientRect(), V = s.starPos(0).clone();
      const soma = s.graph.nodes.map((_, i) => s.screenOf(i, rect)).map((p) => [p.x, p.y]);
      const near = (x, y, r) => soma.some(([sx, sy]) => Math.hypot(sx - x, sy - y) <= r);
      const pts = s.arborPoints(400), res = {};
      for (const [kind, arr] of Object.entries(pts)) { const picks = [];
        for (const p of arr) { V.set(p[0], p[1], p[2]).project(cam); const x = rect.left + (V.x * 0.5 + 0.5) * rect.width, y = rect.top + (-V.y * 0.5 + 0.5) * rect.height;
          if (V.z < 1 && x > rect.left + 5 && x < rect.right - 5 && y > rect.top + 5 && y < rect.bottom - 5 && !near(x, y, 16)) picks.push(s.pick(x, y)); }
        res[kind] = picks; }
      const iso = []; soma.forEach(([x, y], i) => { const o = soma.filter(([a, b], j) => j !== i && Math.hypot(a - x, b - y) <= 16).length; const p = s.screenOf(i, rect); if (!o && p.z < 1 && x > rect.left && x < rect.right && y > rect.top && y < rect.bottom) iso.push(i); });
      return { res, somaPicks: iso.slice(0, 8).map((i) => [i, s.pick(soma[i][0], soma[i][1])]) };
    });
    for (const k of ["dendrite", "axon", "decor"]) { assert(pr.res[k].length >= 8, `enough ${k} tips sampled: ` + pr.res[k].length); assert(pr.res[k].every((x) => x === -1), `${k} tips are not hit-testable: ` + JSON.stringify(pr.res[k])); }
    assert(pr.somaPicks.length >= 3 && pr.somaPicks.every(([i, p]) => i === p), "soma picks return that note: " + JSON.stringify(pr.somaPicks));
  }
  assert(r.d.layers.pulseEdgesReal, "impulse paths are real edges only");
  { // inter-note impulse paths == graph edges EXACTLY (one oriented fibre per edge), and every launched impulse used one of them
    await page.waitForFunction(() => window.__atlas.scene.impulseLog().length >= 5 && window.__atlas.scene.debug().pulses.visible, null, { timeout: 90000 }); assert((await dbg()).pulses.gate === "open", "gate open on the verified real brain");
    const ip = await page.evaluate(() => { const s = window.__atlas.scene, k = ([a, b]) => (a < b ? a + ":" + b : b + ":" + a); return { paths: s.impulsePaths().map(k).sort(), edges: s.graph.edges.map((e) => e.a + ":" + e.b).sort(), used: [...new Set(s.impulseLog().map(k))], raw: s.impulsePaths().length }; });
    assert.deepEqual(ip.paths, ip.edges, "impulse paths == graph edges"); assert.equal(ip.raw, ip.edges.length, "one fibre per edge");
    assert(ip.used.length >= 3 && ip.used.every((u) => ip.edges.includes(u)), "link strikes only on real edges: " + ip.used.length);
    // decorative ambient strikes are logged separately and never counted as link strikes
    await page.waitForFunction(() => window.__atlas.scene.sim.ambientLog.length >= 2, null, { timeout: 90000 });
    const am = await page.evaluate(() => { const s = window.__atlas.scene; return { amb: s.sim.ambientLog.length, links: s.impulseLog().length, nAmb: s.debug().lightning.ambientBolts, ok: s.sim.ambientLog.every(([i]) => i >= 0 && i < s.debug().lightning.ambientBolts) }; });
    assert(am.amb >= 2 && am.ok, "ambient strikes on decorative channels only " + JSON.stringify(am));
  }
  ok("rendered links == graph.edges; link bolts == edges, ambient bolts separate; arbors/decor/bolts decorative, soma-only picking", `links=${r.want.length} segs=${r.d.noteNeuronSegments} decor=${r.d.decorNeurons} ambientBolts=${r.d.lightning.ambientBolts}`);
}

// 3c neighbor focus (progressive disclosure)
{
  const hub = await page.evaluate(() => { const s = window.__atlas.scene; let b = 0; s.graph.nodes.forEach((n, i) => { if (n.degree > s.graph.nodes[b].degree) b = i; }); return b; });
  const expect = await page.evaluate((i) => Array.from(new Set(window.__atlas.scene.graph.edges.filter((e) => e.a === i || e.b === i).map((e) => (e.a === i ? e.b : e.a)))).sort((a, b) => a - b), hub);
  await page.evaluate((i) => { const s = window.__atlas.scene; s.setFocus(i, false); s.frame(performance.now()); }, hub); await wait(200);
  const f = await dbg();
  assert.deepEqual(f.neighbors, expect, "neighbors == real graph neighbors");
  assert.equal(f.nearLit, expect.length + 1, "only focus + real neighbours stay lit"); assert.equal(f.dimmed, 150 - expect.length - 1);
  assert(f.dimmed > 100, "everything else dims");
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".pa-nlabel")).some((e) => e.style.display !== "none"), null, { timeout: 8000 });
  const u = await page.evaluate(() => { const s = window.__atlas.scene; return { dim: s.stars.material.uniforms.uDimOn.value, foc: s.edges.material.uniforms.uFocus.value, labels: Array.from(document.querySelectorAll(".pa-nlabel")).filter((e) => e.style.display !== "none").length }; });
  assert.equal(u.dim, 1); assert.equal(u.foc, hub); assert(u.labels >= 1 && u.labels <= 13, "labels only for focus + neighbours: " + u.labels);
  { const rects = await page.evaluate(() => Array.from(document.querySelectorAll(".pa-nlabel")).filter((e) => e.style.display !== "none").map((e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom, e.classList.contains("pa-nlabel-main")]; }));
    assert(rects.length >= 2 && rects.some((r) => r[4]), "focus label plus neighbour labels visible: " + rects.length);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j]; assert(!(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]), `labels ${i} and ${j} overlap`); }
    const z = await page.evaluate(() => { const m = document.querySelector(".pa-nlabel-main"); return Number(getComputedStyle(m).zIndex); }); assert(z >= 3, "focused label on top"); }
  await page.screenshot({ path: shots + "/neighbor-focus.png" });
  await page.evaluate(() => window.__atlas.scene.setFocus(-1, false)); await wait(100);
  const c = await dbg(); assert.equal(c.dimmed, 0, "dimming cleared"); assert.deepEqual(c.neighbors, []);
  ok("hover/select highlights real neighbours, dims the rest, labels only focus+neighbours", `hub deg=${expect.length}`);
}

// 3d pulses: pause toggle, then play
{
  assert(/Pause/.test(await page.textContent(".pa-pulse-btn")), "pulses run by default (no reduced motion)");
  await wait(300); let p0 = (await dbg()).pulses; await page.waitForFunction((c) => window.__atlas.scene.debug().pulses.clock > c, p0.clock, { timeout: 8000 }); let p1 = (await dbg()).pulses;
  assert(p0.on && p0.visible && p0.gate === "open" && p0.count > 20 && p1.clock > p0.clock, "pulses advance " + JSON.stringify([p0, p1]));
  await page.click(".pa-pulse-btn");
  assert(/Play/.test(await page.textContent(".pa-pulse-btn")));
  await wait(150); const q0 = (await dbg()).pulses; await wait(500); const q1 = (await dbg()).pulses;
  assert(!q0.on && !q1.visible && q1.clock === q0.clock, "paused: clock frozen " + JSON.stringify([q0, q1]));
  { const a = await page.evaluate(() => ({ act: window.__atlas.scene.debug().impulsesActive, log: window.__atlas.scene.impulseLog().length })); await wait(600); const b = await page.evaluate(() => ({ act: window.__atlas.scene.debug().impulsesActive, log: window.__atlas.scene.impulseLog().length })); assert.equal(a.act, 0, "paused: zero active impulses"); assert.deepEqual(a, b, "paused: no new impulses launched"); }
  await page.screenshot({ path: shots + "/paused.png" });
  await page.click(".pa-pulse-btn"); await page.waitForFunction((c) => window.__atlas.scene.debug().pulses.clock > c, q1.clock, { timeout: 8000 }); const r0 = (await dbg()).pulses; assert(r0.on, "play resumes");
  ok("Pause/Play toggle stops and resumes link pulses");
}

// 3e top-down view: two hemispheres with a visible longitudinal fissure
{
  await page.evaluate(() => window.__atlas.scene.preset("top"));
  await wait(500);
  const px = await page.evaluate(() => { // test both open ends of the fissure; the deep corpus callosum spans the middle in this projection
    const s = window.__atlas.scene; s.frame(performance.now()); const src = s.canvas.toDataURL();
    return new Promise((res) => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const x = c.getContext("2d"); x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const col = (u, a, b) => { let sum = 0; const X = Math.round(u * c.width); for (let y = Math.round(c.height * a); y < Math.round(c.height * b); y++) for (let k = -2; k <= 2; k++) { const i = (y * c.width + X + k) * 4; sum += d[i] + d[i + 1] + d[i + 2]; } return sum; };
      res([[0.24, 0.30], [0.70, 0.76]].map(([a, b]) => ({ mid: col(0.5, a, b), left: col(0.42, a, b), right: col(0.58, a, b) }))); }; im.src = src; });
  });
  await page.screenshot({ path: shots + "/brain-top.png" });
  assert(px.every(({ mid, left, right }) => left > 0 && right > 0 && mid < left * 0.92 && mid < right * 0.92), "both open ends of the visible fissure are darker than the hemispheres " + JSON.stringify(px));
  await page.click(".pa-reset-view"); await wait(300);
  ok("top-down view shows two hemispheres separated by a fissure", JSON.stringify(px));
}

// 4 orbit & zoom
const box = await page.locator(".pa-canvas").boundingBox();
const c0 = (await dbg()).cam;
await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 140, box.y + 70, { steps: 8 }); await page.mouse.up();
await wait(400);
const c1 = (await dbg()).cam; assert(Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]) > 0.2, "orbit moved camera");
const dist0 = (await dbg()).dist;
await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.wheel(0, -600); await wait(500);
const dist1 = (await dbg()).dist; assert(dist1 < dist0 - 0.2, `zoom in ${dist0}->${dist1}`);
ok("orbit and zoom change camera", `dist ${dist0.toFixed(2)}->${dist1.toFixed(2)}`);
await page.click(".pa-reset-view"); await wait(300);
{ // Reset view also consumes the orbit inertia left by the drag above: the camera stays on the default pose (stars do not slide under a still cursor)
  const r0 = await dbg(); await wait(400); const r1 = await dbg();
  assert(r1.frames > r0.frames && Math.hypot(...r1.cam.map((v, k) => v - r0.cam[k])) < 1e-6, "camera static after Reset view " + JSON.stringify([r0.cam, r1.cam, r0.frames, r1.frames]));
}

// 5 hover + click open
const pathN = titles.find((t) => t.startsWith("topics/"));
let pos = await page.evaluate((p) => window.__atlas.scene.screenOfPath(p), pathN);
// choose a star that is unambiguous: iterate until pick returns itself and on-screen
const cand = await page.evaluate(() => { const s = window.__atlas.scene; for (let i = 0; i < s.graph.nodes.length; i++) { const p = s.screenOf(i); const b = s.canvas.getBoundingClientRect(); if (p.x > b.left + 40 && p.x < b.right - 40 && p.y > b.top + 40 && p.y < b.bottom - 40 && s.pick(p.x, p.y) === i) return { id: s.graph.nodes[i].id, title: s.graph.nodes[i].title, x: p.x, y: p.y }; } return null; });
assert(cand, "an on-screen pickable star exists");
await page.mouse.move(cand.x, cand.y); await wait(100);
assert(await page.isVisible(".pa-tip"), "tooltip on hover");
assert.equal(await page.$eval(".pa-tip b", (e) => e.textContent), cand.title, "tooltip names the hovered star");
await page.mouse.click(cand.x, cand.y);
const opened = await page.evaluate(() => window.__opened);
assert.equal(opened.at(-1), cand.id, "click opened " + JSON.stringify(opened));
ok("hover tooltip + click opens note callback", cand.id);
const firstBtn = page.locator(".pa-item-btn").first(); await firstBtn.focus();
assert.equal((await dbg()).focus, 0, "list focus highlights star");
await page.keyboard.press("Enter");
assert.equal((await page.evaluate(() => window.__opened)).length, 2);
ok("keyboard list focus highlights + Enter opens");

// 5b the view moves under a still cursor (autorotate, inertia, tweens): the tooltip follows the star now under the cursor and the click opens exactly that note
{
  await page.click(".pa-reset-view"); await wait(300);
  const mv = await page.evaluate(() => {
    const s = window.__atlas.scene; s.frame(performance.now()); // draw the current pose first: picking uses the matrices of the last drawn frame
    const cam = s.camera, T = s.controls.target, b = s.canvas.getBoundingClientRect(), P0 = cam.position.clone();
    const ok = (p) => p.z < 1 && p.x > b.left + 40 && p.x < b.right - 40 && p.y > b.top + 40 && p.y < b.bottom - 40;
    const own = []; for (let i = 0; i < s.graph.nodes.length; i++) { const p = s.screenOf(i, b); if (ok(p) && s.pick(p.x, p.y) === i) own.push({ i, x: p.x, y: p.y }); }
    let found = null;
    for (const deg of [2, 3, 5, 8, 12, 16, 20]) { // orbit about the target (world up) until a different star takes some hovered star's screen spot
      const a = deg * Math.PI / 180, ox = P0.x - T.x, oz = P0.z - T.z;
      cam.position.set(T.x + ox * Math.cos(a) + oz * Math.sin(a), P0.y, T.z - ox * Math.sin(a) + oz * Math.cos(a)); cam.lookAt(T); cam.updateMatrixWorld();
      for (const h of own) { const j = s.pick(h.x, h.y); if (j >= 0 && j !== h.i) { found = { a: h, b: j, deg, pos: cam.position.toArray(), target: T.toArray() }; break; } }
      if (found) break;
    }
    cam.position.copy(P0); cam.lookAt(T); cam.updateMatrixWorld();
    return found && { ...found, aTitle: s.graph.nodes[found.a.i].title, bTitle: s.graph.nodes[found.b].title, bId: s.graph.nodes[found.b].id };
  });
  assert(mv, "a small orbit brings a different star under a hovered star's spot");
  await page.mouse.move(mv.a.x + 30, mv.a.y + 30); await page.mouse.move(mv.a.x, mv.a.y); await wait(100);
  const h0 = await page.evaluate(() => window.__atlas.scene.hover);
  assert.equal(h0, mv.a.i, "hover resolves the star under the cursor"); assert.equal(await page.$eval(".pa-tip b", (e) => e.textContent), mv.aTitle);
  // the camera moves; the pointer does not
  const h1 = await page.evaluate(({ pos, target, x, y }) => { const s = window.__atlas.scene; s.setCamera(pos, target); s.frame(performance.now()); return { hover: s.hover, pick: s.pick(x, y) }; }, { pos: mv.pos, target: mv.target, x: mv.a.x, y: mv.a.y });
  await wait(150);
  const tipNow = await page.$eval(".pa-tip b", (e) => e.textContent);
  assert(h1.hover === mv.b && h1.pick === mv.b && tipNow === mv.bTitle, "hover/tooltip follow the star now under the still cursor " + JSON.stringify({ h1, want: mv.b, tipNow, bTitle: mv.bTitle, aTitle: mv.aTitle, deg: mv.deg }));
  await page.mouse.click(mv.a.x, mv.a.y);
  const op = await page.evaluate(() => window.__opened);
  assert.equal(op.at(-1), mv.bId, "click opens the note the tooltip names " + JSON.stringify(op));
  await page.click(".pa-reset-view"); await wait(300);
  ok("moving view under a still cursor: tooltip follows, click opens the tooltip note", `${mv.aTitle} -> ${mv.bTitle} after ${mv.deg} deg`);
}

// 6 morph
const before = await page.evaluate(() => window.__atlas.scene.screenOf(5));
await page.click(".pa-mode");
// sample the first rendered morph frame instead of a fixed 250 ms: software GL paces rAF at ~200-400 ms here, so a fixed sleep can land before any morph frame
await page.waitForFunction(() => window.__atlas.scene.debug().morph > 0, null, { timeout: 5000 }); const mid = await dbg(); assert(mid.morph > 0 && mid.morph < 1, "mid-morph " + mid.morph);
await page.screenshot({ path: shots + "/mid-morph.png" });
await page.waitForFunction(() => window.__atlas.scene.debug().morph === 1, null, { timeout: 8000 });
await wait(900);
const after = await page.evaluate(() => window.__atlas.scene.screenOf(5));
assert(Math.hypot(before.x - after.x, before.y - after.y) > 5, "star moved across morph");
assert((await dbg()).mode === "universe"); assert(/Universe/.test(await page.textContent(".pa-mode")));
await page.screenshot({ path: shots + "/universe.png" });
await page.click(".pa-mode"); await page.waitForFunction(() => window.__atlas.scene.debug().morph === 0, null, { timeout: 8000 });
ok("brain<->universe morph animates and returns", `mid=${mid.morph.toFixed(3)}`);

// 7 persistence via real drag in edit mode
await wait(900); await page.click(".pa-reset-view"); await wait(600);
await page.click(".pa-edit-btn");
const sel = await page.evaluate(() => { const s = window.__atlas.scene; for (let i = 0; i < s.graph.nodes.length; i++) { const p = s.screenOf(i); const b = s.canvas.getBoundingClientRect(); if (s.graph.nodes[i].degree > 0 && p.x > b.left + 80 && p.x < b.right - 120 && p.y > b.top + 80 && p.y < b.bottom - 120 && s.pick(p.x, p.y) === i) return { i, id: s.graph.nodes[i].id, x: p.x, y: p.y, pos: Array.from(s.brainP.subarray(i * 3, i * 3 + 3)) }; } });
const openedBefore = (await page.evaluate(() => window.__opened)).length;
await page.mouse.move(sel.x, sel.y); await page.mouse.down();
const dragDepths = [], held = []; for (let k = 1; k <= 6; k++) { await page.mouse.move(sel.x + 70 * k / 6, sel.y - 40 * k / 6); const st = await page.evaluate((i) => { const s = window.__atlas.scene, P = s.brainP, d = s.debug(); return { depth: s.field.depthE(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) - s.field.margin, preview: d.preview, links: d.layers.renderedLinks, edges: d.edges, gate: d.pulses.gate }; }, sel.i); dragDepths.push(st.depth); held.push(st); }
// BEFORE pointerup: the moved cell's arbor and every incident fibre are held (not drawn), only they leave the drawn link set, and the rest keeps pulsing
assert(held.every((h) => h.preview && h.preview.idx === sel.i && h.preview.arborHidden && h.preview.incident > 0 && h.preview.fibresHidden === h.preview.incident && h.links === h.edges - h.preview.incident && h.gate === "open"), "drag preview holds the moved cell's arbor + links, others keep pulsing " + JSON.stringify(held.at(-1)));
await page.mouse.up(); assert(dragDepths.every((v) => v >= -1e-4), "soma stays inside the margin on every drag preview frame " + JSON.stringify(dragDepths));
await wait(300); { const e = await dbg(); assert(e.geomOutside === 0 && e.pulseOutside === 0 && e.extentOutside === 0 && e.geomSamples > 1000, "after the drag commit arbors+routes are re-derived and nothing is outside " + JSON.stringify([e.geomOutside, e.pulseOutside, e.extentOutside, e.geomSamples]));
  assert(e.preview === null && e.layers.renderedLinks === e.edges && e.pulses.gate === "open", "release restores real-link parity and the gate " + JSON.stringify([e.preview, e.layers.renderedLinks, e.edges, e.pulses.gate])); }
await page.waitForFunction((i) => window.__atlas.scene.impulseLog().some(([a, b]) => a === i || b === i), sel.i, { timeout: 60000 }); // impulses relaunch on the moved cell's real links
const moved = await page.evaluate((i) => Array.from(window.__atlas.scene.brainP.subarray(i * 3, i * 3 + 3)), sel.i);
assert(Math.hypot(...moved.map((v, k) => v - sel.pos[k])) > 0.05, "star moved " + moved);
assert.equal((await page.evaluate(() => window.__opened)).length, openedBefore, "edit drag did not open note");
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("palace-atlas-demo-data")));
assert(stored.positions[sel.id]?.brain, "position persisted in storage");
assert.deepEqual(Object.keys(stored).sort(), ["mode", "positions"], "only mode+positions stored");
await page.reload(); await readyBrain();
const re = await page.evaluate((id) => { const s = window.__atlas.scene; const i = s.indexOf(id); return Array.from(s.brainP.subarray(i * 3, i * 3 + 3)); }, sel.id);
assert(Math.hypot(...re.map((v, k) => v - moved[k])) < 1e-4, "restored after reload");
await page.click(".pa-reset-pos");
const re2 = await page.evaluate((id) => { const s = window.__atlas.scene; const i = s.indexOf(id); return Array.from(s.brainP.subarray(i * 3, i * 3 + 3)); }, sel.id);
assert(Math.hypot(...re2.map((v, k) => v - sel.pos[k])) < 1e-4, "reset restores deterministic layout");
ok("drag-to-move persists across reload; reset restores default");

// 8 deterministic layout across loads
const a1 = await page.evaluate(() => Array.from(window.__atlas.scene.brainP.subarray(0, 30)));
await page.reload(); await readyBrain();
const a2 = await page.evaluate(() => Array.from(window.__atlas.scene.brainP.subarray(0, 30)));
assert.deepEqual(a1, a2); ok("layout deterministic across reloads");

// 8c resize
{
  await page.setViewportSize({ width: 900, height: 600 }); await wait(400);
  const sz = await page.evaluate(() => { const s = window.__atlas.scene, st = s.canvas.parentElement; return { cw: s.canvas.width, ch: s.canvas.height, sw: st.clientWidth, sh: st.clientHeight, asp: s.camera.aspect }; });
  assert(Math.abs(sz.asp - sz.sw / sz.sh) < 0.02 && sz.cw > 0 && sz.ch > 0, "resize updated camera/canvas " + JSON.stringify(sz));
  const f0 = (await dbg()).frames; await page.waitForFunction((f) => window.__atlas.scene.debug().frames > f, f0, { timeout: 15000 }); // keeps rendering after a resize (software GL can need seconds)
  await page.setViewportSize({ width: 1280, height: 800 }); await wait(300);
  ok("resize updates canvas and camera aspect", JSON.stringify(sz));
}

// 150-node frame time (software GL here; real GPU is faster)
{ const ms = await page.evaluate(() => { const s = window.__atlas.scene; const t = performance.now(); for (let i = 0; i < 10; i++) s.frame(performance.now()); return (performance.now() - t) / 10; }); console.log("perf150 frameMs", ms.toFixed(1)); }
{ // loose frame-time sanity; only meaningful on a real GPU (skipped on software rasterisers)
  const rn = await page.evaluate(() => window.__atlas.scene.rendererName()); const soft = /swiftshader|llvmpipe|software/i.test(rn);
  if (!soft) { await wait(1500); const fsx = await page.evaluate(() => window.__atlas.scene.frameStats()); assert(fsx.n < 5 || (fsx.avg < 20 && fsx.p95 < 33), "frame time on a real GPU: " + JSON.stringify(fsx)); ok("frame-time sanity on real GPU (avg < 20 ms, p95 < 33 ms)", JSON.stringify(fsx)); }
  else ok("frame-time sanity skipped on software renderer", rn.slice(0, 60)); }

// 8f diag: whitelist, counts only, parity
{
  const d = await page.evaluate(() => window.__diag()); const names = await page.evaluate(() => window.__atlas.scene.graph.nodes.map((n) => n.title));
  const KEYS = ["version", "ts", "mode", "viewOpen", "nodes", "edges", "renderedPairs", "dendriteSegments", "pulses", "excluded", "folderCounts", "reducedMotion", "paused", "autorotate", "frames", "avgFrameMs", "p95FrameMs", "idleRendering", "renderer", "fps", "quality", "decorNeurons", "noteNeuronSegments", "impulsesActive", "bloom", "assetLoaded", "assetTriangles", "contained", "containLive", "geomSamples", "geomOutside", "pulseSamples", "pulseOutside", "projectedSaved", "projectedPlaced", "routeFailed", "pulseGate", "pulsesSuppressed", "guardActive", "extentSamples", "extentOutside", "shaderCapWorld", "ambientBolts", "boltSamples", "boltOutside", "flashRateMax"].sort();
  assert.deepEqual(Object.keys(d).sort(), KEYS, "diag keys are exactly the whitelist");
  assert.deepEqual(Object.keys(d.folderCounts).sort(), ["memories", "projects", "topics"]);
  const flat = JSON.stringify(d); assert(!flat.includes("/") && !flat.includes(".md"), "no paths in diag: " + flat);
  for (const t of names) assert(!flat.includes(t), "no fixture title in diag");
  for (const [k, v] of Object.entries(d)) if (k !== "folderCounts") assert(["number", "boolean", "string"].includes(typeof v) && (typeof v !== "string" || v.length <= 80) && (typeof v !== "number" || Number.isFinite(v)), k);
  assert.equal(d.renderedPairs, d.edges, "rendered pairs == real edges"); assert.equal(d.pulsesSuppressed, 0);
  assert.equal(d.guardActive, d.bloom, "the bloom guard is active exactly when bloom runs on a steady brain");
  assert(d.contained && d.containLive && d.pulseGate && d.geomSamples > 1000 && d.pulseSamples > 100 && d.geomOutside === 0 && d.pulseOutside === 0 && d.extentOutside === 0 && d.extentSamples > 100 && d.shaderCapWorld > 0 && d.shaderCapWorld < 0.1 && d.impulsesActive >= 0 && d.avgFrameMs > 0 && d.p95FrameMs > 0, "containment counters are measured, positive and clean: " + JSON.stringify(d)); assert.equal(d.nodes, 150); assert.equal(d.viewOpen, true);
  assert.equal(d.folderCounts.topics + d.folderCounts.projects + d.folderCounts.memories, d.nodes);
  assert(d.ambientBolts > 0 && d.ambientBolts !== d.edges && d.boltSamples > 1000 && d.boltOutside === 0 && d.flashRateMax >= 0 && d.flashRateMax <= 6, "lightning diag: decorative ambient bolts separate from edges, bolt clearance clean, flash rate capped: " + JSON.stringify([d.ambientBolts, d.boltSamples, d.boltOutside, d.flashRateMax]));
  ok("diag.json object: exact key whitelist, counts only, renderedPairs == edges", flat.slice(0, 160));
}

// 8g render-on-demand: idle stops rendering, hover/input resumes
{
  await page.evaluate(() => { const s = window.__atlas.scene; s.setPulses(false); s.setAutoRotate(false); });
  { let last = -1, same = 0; for (let k = 0; k < 60 && same < 3; k++) { await wait(400); const f = (await dbg()).frames; same = f === last ? same + 1 : 0; last = f; } assert(same >= 3, "render queue drains to idle"); }
  const a = await page.evaluate(() => { const d = window.__atlas.scene.debug(); return { frames: d.frames, loops: d.loops, idle: d.idle }; });
  await wait(1500);
  const b2 = await page.evaluate(() => { const s = window.__atlas.scene, d = s.debug(); return { frames: d.frames, loops: d.loops, idleRendering: s.idleRendering() }; });
  assert(a.idle, "scene reports idle state"); assert.equal(b2.frames, a.frames, "no renders while idle and paused " + JSON.stringify([a, b2])); assert(b2.loops > a.loops, "rAF still ticks (cheap) while idle"); assert.equal(b2.idleRendering, false);
  // hover resumes
  const pt = await page.evaluate(() => { const s = window.__atlas.scene, r = s.canvas.getBoundingClientRect(); const i = s.graph.nodes.findIndex((_, k) => { const p = s.screenOf(k, r); return p.z < 1 && p.x > r.left + 20 && p.x < r.right - 20 && p.y > r.top + 20 && p.y < r.bottom - 20; }); const p = s.screenOf(i, r); return { x: p.x, y: p.y }; });
  await page.mouse.move(pt.x - 60, pt.y - 60); await wait(300);
  const c0 = (await dbg()).frames; await page.mouse.move(pt.x, pt.y); await wait(500);
  const c1 = await dbg(); assert(c1.frames > c0 && c1.hover >= 0, "hover wakes rendering " + JSON.stringify([c0, c1.frames, c1.hover]));
  await page.mouse.move(pt.x + 300, pt.y + 200); await wait(1200); const e0 = (await dbg()).frames; await wait(1200); assert.equal((await dbg()).frames, e0, "idle again after hover ends");
  // search resumes
  await page.fill(".pa-search", "orbit"); await wait(500); assert((await dbg()).frames > e0, "search wakes rendering"); await page.fill(".pa-search", ""); await wait(800);
  // hidden container renders nothing
  await page.evaluate(() => { document.querySelector(".pa-root").style.display = "none"; }); await wait(300); const h0 = (await dbg()).frames; await page.evaluate(() => window.__atlas.scene.setPulses(true)); await wait(800);
  assert.equal((await dbg()).frames, h0, "hidden view does not render even with pulses on");
  await page.evaluate(() => { document.querySelector(".pa-root").style.display = ""; }); await wait(600); assert((await dbg()).frames > h0, "visible again resumes");
  await page.evaluate(() => window.__atlas.scene.setPulses(false)); await wait(600);
  ok("render-on-demand: 0 renders while idle+paused, resumes on hover/search/visibility", `idleLoops=${b2.loops - a.loops}`);
}

// 8e pause button aria, 800x600 layout (toolbar wraps, list scrolls, nothing clipped)
{
  assert.equal(await page.getAttribute(".pa-pulse-btn", "aria-pressed"), null, "pause button: label-only toggle, no stale aria-pressed");
  { const lbl = await page.getAttribute(".pa-pulse-btn", "aria-label"); assert(typeof lbl === "string" && /^(Pause|Play) /.test(lbl), "pulse button aria-label is label-only: " + lbl); }
  await page.setViewportSize({ width: 800, height: 600 }); await wait(500);
  const L = await page.evaluate(() => { const q = (s) => document.querySelector(s), r = (e) => e.getBoundingClientRect(), list = q(".pa-list"), side = q(".pa-side"), tb = q(".pa-toolbar"), root = q(".pa-root");
    const btns = Array.from(tb.children).map((e) => r(e)); return { scrolls: list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY !== "visible", listBottom: r(list).bottom, sideBottom: r(side).bottom, rootBottom: r(root).bottom, tbRight: Math.max(...btns.map((b) => b.right)), rootRight: r(root).right, tbBottom: r(tb).bottom, mainTop: r(q(".pa-main")).top, footBottom: r(q(".pa-foot")).bottom }; });
  assert(L.scrolls, "list scrolls " + JSON.stringify(L)); assert(L.listBottom <= L.sideBottom + 1 && L.footBottom <= L.rootBottom + 1, "nothing overflows the pane " + JSON.stringify(L));
  assert(L.tbRight <= L.rootRight + 1 && Math.abs(L.tbBottom - L.mainTop) <= 1, "toolbar wraps inside the pane " + JSON.stringify(L));
  await page.evaluate(() => { const l = document.querySelector(".pa-list"); l.scrollTop = l.scrollHeight; }); await wait(100);
  const last = await page.evaluate(() => { const l = document.querySelector(".pa-list"), li = l.lastElementChild.getBoundingClientRect(), lr = l.getBoundingClientRect(); return li.bottom <= lr.bottom + 1; });
  assert(last, "last list item fully reachable by scrolling");
  await page.screenshot({ path: shots + "/layout-800x600.png" });
  await page.setViewportSize({ width: 1280, height: 800 }); await wait(300);
  ok("pause aria is label-only; 800x600 toolbar wraps and list scrolls to the last item", JSON.stringify(L));
}

// 8h quality levels, persistence, asset seam (synthetic GLB), silent missing asset
{
  await page.goto("about:blank");
  const c4 = await browser.newContext({ viewport: { width: 1000, height: 700 } }); const p4 = await c4.newPage(); const e4 = [], r4 = [];
  p4.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/ReadPixels/.test(m.text())) e4.push(m.text()); }); p4.on("pageerror", (e) => e4.push(e.message)); p4.on("request", (r) => r4.push(r.url()));
  const ready = (f = 3) => p4.waitForFunction((n) => window.__atlas && window.__atlas.scene.debug().frames > n, f, { timeout: 120000 });
  // missing asset (listing empty): silent, procedural shell, default quality low on SwiftShader
  await p4.goto(url + "?asset=assets-empty&n=40&rotate=0"); await ready(); await wait(800);
  let d4 = await p4.evaluate(() => window.__atlas.scene.debug()); const soft4 = /swiftshader|llvmpipe|software/i.test(await p4.evaluate(() => window.__atlas.scene.rendererName())), want4 = soft4 ? "low" : "high";
  assert.equal(d4.assetLoaded, false); assert.equal(d4.quality, want4, "auto default: Low on software renderers, High on real GPUs"); assert.equal(d4.bloom, !soft4);
  assert.match(await p4.$eval(".pa-legend", (e) => e.title), /procedural.*not an anatomical scan/i, "fallback is explicitly not an anatomical scan");
  assert.equal(await p4.$eval(".pa-quality", (e) => e.value), want4);
  // synthetic asset: loaded, notes inside the volume, quality switching
  await p4.goto(url + "?asset=assets-synth&n=40&rotate=0&quality=high&intro=0"); await ready(); await p4.waitForFunction(() => window.__atlas.scene.debug().assetLoaded, null, { timeout: 60000 });
  d4 = await p4.evaluate(() => window.__atlas.scene.debug()); assert(d4.assetTriangles > 3000 && d4.quality === "high" && d4.bloom === true && d4.decorNeurons === 700, JSON.stringify(d4));
  const hiTri = d4.assetTriangles; // High synthetic asset incl. the generated bridge capsules (rendered tissue); Low must load the distinct low-poly file
  const inside = await p4.evaluate(() => { const s = window.__atlas.scene; let bad = 0; for (let i = 0; i < s.graph.nodes.length; i++) if (!s.asset.contains([s.brainP[i * 3], s.brainP[i * 3 + 1], s.brainP[i * 3 + 2]])) bad++; return { bad, n: s.graph.nodes.length, ctr: s.place.filter((p) => p.region === "cerebellum").length }; });
  assert.equal(inside.bad, 0, "all notes inside the brain volume " + JSON.stringify(inside));
  await p4.selectOption(".pa-quality", "balanced"); await wait(300); d4 = await p4.evaluate(() => window.__atlas.scene.debug()); assert(d4.quality === "balanced" && d4.bloom && d4.decorNeurons === 240, "balanced " + JSON.stringify(d4));
  await p4.selectOption(".pa-quality", "low"); await p4.waitForFunction((hi) => window.__atlas.scene.asset && window.__atlas.scene.asset.triangles < hi / 2 && window.__atlas.scene.debug().quality === "low", hiTri, { timeout: 60000 }); d4 = await p4.evaluate(() => window.__atlas.scene.debug());
  assert(!d4.bloom && d4.decorNeurons === 36 && d4.assetLoaded && d4.assetTriangles < hiTri / 2, "low: no bloom, minimal decor, low-poly asset " + JSON.stringify([hiTri, d4]));
  const st = await p4.evaluate(() => JSON.parse(localStorage.getItem("palace-atlas-demo-data"))); assert.equal(st.quality, "low", "quality persisted"); assert(st.positions && st.mode, "positions/mode kept alongside quality");
  await p4.goto(url + "?asset=assets-synth&n=40&rotate=0&intro=0"); await ready(); assert.equal(await p4.$eval(".pa-quality", (e) => e.value), "low", "saved quality restored after reload");
  const dg = await p4.evaluate(() => window.__diag()); assert(dg.assetLoaded && dg.assetTriangles > 0 && dg.quality === "low" && dg.bloom === false && dg.decorNeurons === 36 && typeof dg.fps === "number" && dg.noteNeuronSegments > 500, JSON.stringify(dg));
  await p4.screenshot({ path: shots + "/v030-synthetic-low.png" });
  await p4.selectOption(".pa-quality", "high"); await wait(5000); await p4.screenshot({ path: shots + "/v030-synthetic-high.png" });
  assert.deepEqual(r4.filter((u) => !u.startsWith(url)), [], "no external requests"); assert.deepEqual(e4, [], "quality/asset console: " + e4.join("|"));
  await c4.close(); ok("quality High/Balanced/Low switch + persist (data merge); synthetic GLB loads, notes inside volume; missing asset silent", JSON.stringify({ tri: d4.assetTriangles, inside }));
}

// 8i intro grow-in: plays once per session with an asset; reduced motion shows the final state on the first frame
{
  const c5 = await browser.newContext({ viewport: { width: 900, height: 600 }, reducedMotion: "reduce" }); const p5 = await c5.newPage(); const e5 = [];
  p5.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/ReadPixels/.test(m.text())) e5.push(m.text()); }); p5.on("pageerror", (e) => e5.push(e.message));
  await p5.addInitScript(() => { window.__introSamples = []; const iv = setInterval(() => { const a = window.__atlas; if (a && a.scene.asset) { window.__introSamples.push(a.scene.debug().introProgress); clearInterval(iv); } }, 1); });
  await p5.goto(url + "?asset=assets-synth&n=30&rotate=0&quality=low"); await p5.waitForFunction(() => window.__atlas && window.__atlas.scene.asset && window.__atlas.scene.debug().frames > 1, null, { timeout: 120000 });
  const r5 = await p5.evaluate(() => { const s = window.__atlas.scene; return { first: window.__introSamples[0], now: s.debug().introProgress, vis: [s.arbor, s.somas, s.edges, s.decor].map((o) => o.visible), fades: s.assetParts.map((p) => [p.u.uFade.value, p.u.uRevealY.value]) }; });
  assert.equal(r5.first, 1, "reduced motion: first frame with the asset is already the final state " + JSON.stringify(r5)); assert(r5.vis.every(Boolean) && r5.fades.every(([f, y]) => f === 1 && y === 99), "reduced motion: everything visible " + JSON.stringify(r5));
  await c5.close();
  const c6 = await browser.newContext({ viewport: { width: 900, height: 600 } }); const p6 = await c6.newPage();
  p6.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/ReadPixels/.test(m.text())) e5.push(m.text()); }); p6.on("pageerror", (e) => e5.push(e.message));
  await p6.addInitScript(() => { window.__introSamples = []; const iv = setInterval(() => { const a = window.__atlas; if (a && a.scene.asset) { const s = a.scene; window.__introSamples.push({ p: s.debug().introProgress, vis: s.arbor ? s.arbor.visible : null }); clearInterval(iv); } }, 1); });
  await p6.goto(url + "?asset=assets-synth&n=30&rotate=0&quality=low"); await p6.waitForFunction(() => window.__introSamples && window.__introSamples.length, null, { timeout: 120000 });
  const s6 = await p6.evaluate(() => window.__introSamples[0]); assert(s6.p < 0.5 && s6.vis === false, "intro starts with neurons hidden " + JSON.stringify(s6));
  await p6.waitForFunction(() => window.__atlas.scene.debug().introProgress === 1, null, { timeout: 60000 }); assert(await p6.evaluate(() => window.__atlas.scene.arbor.visible), "neurons appear after the intro");
  await p6.reload(); await p6.waitForFunction(() => window.__atlas.scene.asset, null, { timeout: 120000 }); await c6.close();
  assert.deepEqual(e5, [], "intro console: " + e5.join("|")); ok("intro grow-in plays once; reduced motion shows final state on first frame", JSON.stringify(s6));
}

// 8j graceful fallback: every non-verified state is CLOSED (no emission), the real brain is open
{
  await page.goto("about:blank");
  const c7 = await browser.newContext({ viewport: { width: 900, height: 600 } }); const p7 = await c7.newPage(); const e7 = [];
  p7.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/ReadPixels/.test(m.text())) e7.push(m.text()); }); p7.on("pageerror", (e) => e7.push(e.message));
  const snap = () => p7.evaluate(() => { const s = window.__atlas.scene, d = s.debug(); return { gate: d.pulses.gate, vis: d.pulses.visible, act: d.impulsesActive, uAnim: s.sh.uAnim.value, contained: d.contained, live: d.containLive, loaded: d.assetLoaded, mode: d.mode, log: s.impulseLog().length }; });
  const ready = (f = 3) => p7.waitForFunction((n) => window.__atlas && window.__atlas.scene.debug().frames > n, f, { timeout: 120000 });
  // the gate is evaluated in every rendered frame; software GL paces frames at ~200-400 ms here, so after a state change wait for a frame
  // rendered after it (change and frame count read in one evaluate) instead of a fixed sleep that can end before any frame was drawn
  const afterFrame = (f0) => p7.waitForFunction((f) => window.__atlas.scene.debug().frames > f, f0, { timeout: 30000 });
  // missing GLB -> closed
  await p7.goto(url + "?asset=assets-empty&n=40&rotate=0&intro=0"); await ready(); await wait(2500);
  let g = await snap(); assert(g.gate === "noasset" && !g.vis && g.act === 0 && g.uAnim === 0 && !g.loaded, "missing GLB: closed " + JSON.stringify(g));
  // corrupt SDF with a real GLB -> open only if the loaded field is verified, closed otherwise (never open on an unverified field)
  await p7.goto(url + "?asset=assets-badsdf&n=40&rotate=0&intro=0"); await ready(); await p7.waitForFunction(() => window.__atlas.scene.debug().assetLoaded, null, { timeout: 120000 }); await wait(2500);
  g = await snap(); const ver = await p7.evaluate(() => window.__atlas.scene.asset.fieldVerified);
  assert(g.loaded && (g.gate === "open") === (ver === true) && (g.gate === "open" || (g.gate === "field" && !g.vis && g.uAnim === 0 && g.act === 0)), "corrupt SDF: gate follows fieldVerified " + JSON.stringify([g, ver]));
  // real verified brain: positive active pulses; gate closes for a lost field, intro, morph and universe, every frame
  await p7.goto(url + "?asset=assets&n=40&rotate=0"); await ready(); await p7.waitForFunction(() => window.__atlas.scene.debug().assetLoaded, null, { timeout: 120000 });
  g = await snap(); assert(g.gate === "intro" && !g.vis && g.uAnim === 0 && g.act === 0, "intro: closed " + JSON.stringify(g));
  await p7.waitForFunction(() => window.__atlas.scene.debug().introProgress === 1, null, { timeout: 90000 });
  await p7.waitForFunction(() => window.__atlas.scene.debug().impulsesActive > 0, null, { timeout: 90000 }); g = await snap(); assert(g.gate === "open" && g.vis && g.uAnim === 1 && g.act > 0 && g.live, "valid brain: open with positive active pulses " + JSON.stringify(g));
  let f0 = await p7.evaluate(() => { const s = window.__atlas.scene; s.setMode("universe"); return s.debug().frames; }); await afterFrame(f0); g = await snap(); assert(g.gate === "morph" && !g.vis && g.uAnim === 0 && g.act === 0, "morphing: closed " + JSON.stringify(g));
  await p7.waitForFunction(() => window.__atlas.scene.debug().morph === 1, null, { timeout: 30000 }); await wait(300); g = await snap(); assert(g.gate === "morph" && g.uAnim === 0 && g.act === 0 && !g.live, "universe: closed " + JSON.stringify(g));
  await p7.evaluate(() => window.__atlas.scene.setMode("brain")); await p7.waitForFunction(() => window.__atlas.scene.debug().morph === 0 && window.__atlas.scene.debug().pulses.visible, null, { timeout: 30000 });
  f0 = await p7.evaluate(() => { const s = window.__atlas.scene; window.__fld = s.asset.field; s.asset.field = null; return s.debug().frames; }); await afterFrame(f0); g = await snap(); assert(g.gate === "field" && !g.vis && g.uAnim === 0 && g.act === 0, "lost field: closed " + JSON.stringify(g));
  f0 = await p7.evaluate(() => { const s = window.__atlas.scene; s.asset.field = window.__fld; return s.debug().frames; }); await afterFrame(f0); g = await snap(); assert(g.gate === "open", "field restored: open " + JSON.stringify(g));
  assert.deepEqual(e7, [], "fallback console: " + e7.join("|")); await c7.close();
  ok("fallback: missing GLB, corrupt SDF, intro, morph/universe and lost field are closed; verified real brain has positive active pulses");
}

// 8b reduced motion starts paused
{
  await page.goto("about:blank"); // idle the main page so software-GL contexts do not starve each other
  const c2 = await browser.newContext({ viewport: { width: 1000, height: 700 }, reducedMotion: "reduce" });
  const p2 = await c2.newPage(); const e2 = []; p2.on("console", (m) => { if (["error", "warning"].includes(m.type())) e2.push(m.text()); }); p2.on("pageerror", (e) => e2.push(e.message));
  await p2.goto(MAIN + "&rotate=1", { timeout: 90000 }); await readyBrain(p2);
  const a = await p2.evaluate(() => window.__atlas.scene.debug().pulses); await p2.waitForTimeout(500); const b = await p2.evaluate(() => window.__atlas.scene.debug().pulses);
  assert(!a.on && !a.visible && a.clock === b.clock, "reduced motion: pulses paused " + JSON.stringify([a, b]));
  assert.deepEqual(await p2.evaluate(() => [window.__atlas.scene.debug().impulsesActive, window.__atlas.scene.impulseLog().length, window.__atlas.scene.sh.uAnim.value]), [0, 0, 0], "reduced motion: zero travelling pulses, static glow only");
  assert(/Play/.test(await p2.textContent(".pa-pulse-btn")));
  assert.equal(await p2.evaluate(() => window.__atlas.scene.controls.autoRotate), false, "reduced motion: no auto-rotate");
  assert.equal(await p2.getAttribute(".pa-rotate", "aria-pressed"), "false");
  await p2.click(".pa-pulse-btn"); await p2.waitForFunction(() => window.__atlas.scene.debug().pulses.clock > 0, null, { timeout: 8000 });
  { // opting in under reduced motion: rare (<= 1 onset per second, 1.6 s apart), soft (no restrikes, no white-hot core), never strobing
    const L = await p2.evaluate(() => { const s = window.__atlas.scene; return { ...s.debug().lightning, minGap: s.sim.rates.minGap, uReduce: s.linkBolts.material[0].uniforms.uReduce.value }; });
    assert(L.reduced && L.capPerSec <= 1 && L.minGap >= 1.5 && L.restrikes === 0 && L.rateMax <= 1 && L.uReduce === 1, "reduced motion lightning is rare and soft " + JSON.stringify(L));
  }
  assert.deepEqual(e2, [], "reduced-motion console: " + e2.join("|"));
  await c2.close(); ok("prefers-reduced-motion: reduce starts paused, no autorotate, opt-in works (rare, soft, no restrikes)");
}

// 8d perf: 1,500-node synthetic fixture
{
  const p3 = await ctx.newPage(); const e3 = []; p3.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/ReadPixels/.test(m.text())) e3.push(m.text()); }); p3.on("pageerror", (e) => e3.push(e.message));
  const t0 = Date.now(); await p3.goto(MAIN + "&n=1500", { timeout: 90000 });
  await readyBrain(p3);
  const loadMs = Date.now() - t0;
  const m = await p3.evaluate(() => { const s = window.__atlas.scene; const t = performance.now(); for (let i = 0; i < 5; i++) s.frame(performance.now()); const ms = (performance.now() - t) / 5; const d = s.debug();
    const pairs = s.renderedEdgePairs().length; return { ms, notes: d.notes, edges: d.edges, pairs, den: d.layers.dendriteSegments, pulses: d.pulses.count }; });
  assert.equal(m.notes, 1500); assert.equal(m.pairs, m.edges, "1500 fixture: rendered links == graph.edges");
  await p3.screenshot({ path: shots + "/brain-1500.png" });
  assert.deepEqual(e3, [], "1500 fixture console: " + e3.join("|"));
  perf = { loadMs, frameMs: Number(m.ms.toFixed(1)), ...m }; await p3.close();
  ok("1,500-node synthetic fixture loads without errors", JSON.stringify(perf));
}
// 9 no external requests / console errors
const external = requests.filter((u) => !u.startsWith(url));
assert.equal(external.length, 0, "external requests: " + external);
assert.deepEqual(errors, [], "console issues: " + errors.join("\n"));
ok("no console errors/warnings, no external network requests");

await browser.close(); server.close();
console.log(`\nbrowser tests: ${results.length} groups PASS; screenshots in ${shots}`);
