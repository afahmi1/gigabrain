// Synthetic-demo LIGHTNING sequences on the real GPU (synthetic fixture, not a vault): one strike at a time, leader -> return stroke -> restrike ->
// decay -> afterglow, at fixed views (left lateral, right lateral, top, front), for a decorative ambient bolt and for a real-link bolt, plus a few
// frames of the live scheduler ("storm"). Each sequence is rendered synchronously at exact pulse-clock times (rAF paused), so frames are deterministic.
// Usage: node test/flash-shots.mjs [outDir] [quality]   (env PA_W/PA_H; default 1280x800, high, n=150)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { launchGpu } from "./gpu.mjs";
const root = path.resolve("dist-demo"), types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream" };
const server = http.createServer((req, res) => { const u = req.url.split("?")[0]; if (u === "/favicon.ico") { res.writeHead(204); return res.end(); } const f = path.join(root, u === "/" ? "index.html" : u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); res.end(fs.readFileSync(f)); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`, W = +(process.env.PA_W || 1280), H = +(process.env.PA_H || 800);
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "palace-atlas-synthetic", "lightning-shots")), Q = process.argv[3] || "high", N = +(process.env.PA_N || 150);
fs.mkdirSync(OUT, { recursive: true });
const VIEWS = [
  { name: "left-lateral", pos: [-3.0, 0.05, 0.12], target: [0, -0.02, 0], side: -1 },
  { name: "right-lateral", pos: [3.0, 0.05, 0.12], target: [0, -0.02, 0], side: 1 },
  { name: "top", pos: [0, 3.4, 0.01], target: [0, 0, 0], side: 0 },
  { name: "front", pos: [0, 0.15, 3.0], target: [0, 0.05, 0], side: 0 },
];
const { browser, page, renderer, mode } = await launchGpu({ width: W, height: H });
console.log("renderer:", renderer, "(" + mode + ")");
page.on("console", (m) => { if (m.type() === "error") console.log("console error", m.text().slice(0, 300)); }); page.on("pageerror", (e) => console.log("pageerror", e.message));
const save = (file, dataUrl) => fs.writeFileSync(path.join(OUT, file), Buffer.from(dataUrl.split(",")[1], "base64"));
const PAGE = String.raw`(() => {
  // the bolt facing the camera most squarely (ambient: by its surface normals; link: by its centroid), large and on screen
  window.__pickBolt = (s, kind) => {
    const L = kind === 1 ? s.boltA : s.boltL, cam = s.camera.position, V = s.camera.position.clone(); let best = -1, bs = -1e9;
    L.bolts.forEach((b, i) => {
      if (b.n < 8 || (kind === 1 && b.bin >= 8)) return;
      const c = b.center, v = [cam.x - c[0], cam.y - c[1], cam.z - c[2]], vl = Math.hypot(...v); let face = 0;
      if (b.nrm) { let k = 0; for (let j = 0; j < b.n; j += 3) { face += (b.nrm[j * 3] * v[0] + b.nrm[j * 3 + 1] * v[1] + b.nrm[j * 3 + 2] * v[2]) / vl; k++; } face /= k; }
      else face = (c[0] * v[0] + c[1] * v[1] + c[2] * v[2]) / (vl * (Math.hypot(...c) || 1));
      const p = V.set(c[0], c[1], c[2]).project(s.camera); if (Math.abs(p.x) > 0.6 || Math.abs(p.y) > 0.6) return;
      const sc = face * 1.5 + Math.min(b.radius, 0.35) * 3 + Math.min(b.forks, 8) * 0.05; if (sc > bs) { bs = sc; best = i; }
    });
    return best;
  };
  // frame times relative to the strike start: two leader frames, the return stroke, the dip between strokes, the first restrike, decay, afterglow
  window.__offsets = (TL, gaps, last) => [["leader 35%", TL * 0.35], ["leader 80%", TL * 0.8], ["return stroke", TL + 0.006], ["between strokes", TL + gaps[0] * 0.85], ["restrike", TL + gaps[0] + 0.005], ["decay", TL + last + 0.09], ["late decay", TL + last + 0.22], ["afterglow", TL + 0.5]];
  // render exact pulse-clock times synchronously (rAF paused by the caller): returns PNG data URLs
  window.__sequence = (s, kind, bolt, offsets) => {
    const T = s.pulseClock + 0.05, st = s.sim.strikeNow(kind, bolt, T), TL = st.leader, last = Math.max(...st.gaps.filter((g) => g > 0));
    const times = offsets(TL, st.gaps, last), out = [];
    for (const [label, t] of times) { s.pulseClock = T + t; s.lastNow = 0; s.frame(performance.now()); out.push({ label, t: +(t * 1000).toFixed(0), url: s.canvas.toDataURL("image/png") }); }
    return { strike: { leaderMs: +(TL * 1000).toFixed(0), restrikesMs: st.gaps.filter((g) => g > 0).map((g) => +(g * 1000).toFixed(0)), tauMs: +(st.tau * 1000).toFixed(0), steps: st.steps, keep: +st.keep.toFixed(2) }, frames: out };
  };
  window.__sheet = async (frames, cols, title) => {
    const ims = await Promise.all(frames.map((f) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = f.url; })));
    const w = ims[0].width / 2, h = ims[0].height / 2, rows = Math.ceil(ims.length / cols), c = document.createElement("canvas"); c.width = w * cols; c.height = h * rows + 30; const x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, c.width, c.height); x.fillStyle = "#ddd"; x.font = "16px sans-serif"; x.fillText(title, 10, 20);
    ims.forEach((im, i) => { const cx = (i % cols) * w, cy = 30 + Math.floor(i / cols) * h; x.drawImage(im, cx, cy, w, h); x.fillStyle = "#fff"; x.fillText(frames[i].label + " (" + frames[i].t + " ms)", cx + 8, cy + 20); });
    return c.toDataURL("image/png");
  };
})()`;
await page.addInitScript(PAGE);
const summary = [];
for (const vp of VIEWS) {
  await page.goto(url + `?quality=${Q}&n=${N}&rotate=0&asset=assets&dust=2400&intro=0`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url + `?quality=${Q}&n=${N}&rotate=0&asset=assets&dust=2400&intro=0`);
  await page.waitForFunction(() => window.__atlas && window.__atlas.scene.debug().assetLoaded && window.__atlas.scene.debug().pulseGate && window.__atlas.scene.boltsReady, null, { timeout: 120000 });
  await page.evaluate((vp) => { const s = window.__atlas.scene; s.setAutoRotate(false); s.setCamera(vp.pos, vp.target); s.camTween = null; }, vp);
  await page.waitForTimeout(600);
  // live scheduler ("storm"): three real frames ~0.35 s apart
  for (let k = 0; k < 3; k++) { await page.waitForTimeout(350); await page.screenshot({ path: path.join(OUT, `${vp.name}__storm-${k + 1}.png`) }); }
  for (const kind of [1, 0]) {
    const r = await page.evaluate((kind) => { const s = window.__atlas.scene; cancelAnimationFrame(s.raf); const saved = s.sim.rates; s.sim.rates = { ...saved, link: 0, ambient: 0, cascade: 0 }; s.sim.reset(s.pulseClock);
      const b = window.__pickBolt(s, kind); if (b < 0) return null; const res = window.__sequence(s, kind, b, window.__offsets); s.sim.rates = saved; s.lastNow = 0; s.loop(); const bo = (kind === 1 ? s.boltA : s.boltL).bolts[b]; return { ...res, bolt: b, bin: bo.bin, forks: bo.forks, radius: +bo.radius.toFixed(3) }; }, kind);
    if (!r) { console.log(vp.name, kind, "no bolt in view"); continue; }
    const tag = kind === 1 ? "ambient" : "link";
    r.frames.forEach((f, i) => save(`${vp.name}__${tag}-${i + 1}-${f.label.replace(/[^a-z0-9]+/gi, "-")}.png`, f.url));
    const sheet = await page.evaluate(({ frames, title }) => window.__sheet(frames, 4, title), { frames: r.frames, title: `${vp.name} / ${tag} bolt #${r.bolt}${tag === "ambient" ? " (bin " + r.bin + ")" : ""}: leader ${r.strike.leaderMs} ms, restrikes +${r.strike.restrikesMs.join("/")} ms, tau ${r.strike.tauMs} ms` });
    save(`${vp.name}__${tag}-SHEET.png`, sheet);
    summary.push({ view: vp.name, kind: tag, bolt: r.bolt, bin: r.bin, forks: r.forks, radius: r.radius, strike: r.strike });
    console.log(vp.name, tag, JSON.stringify(summary.at(-1)));
  }
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ renderer, quality: Q, notes: N, size: [W, H], summary }, null, 2));
console.log("shots:", OUT);
await browser.close(); server.close();
