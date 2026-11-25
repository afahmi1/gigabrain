// Gallery screenshots of the SYNTHETIC demo fixture (never a vault) on the real GPU: docs/images/{brain,lightning,linked-note}.webp
// Usage: npm run build && node test/capture-gallery.mjs [outDir]   (env PA_W/PA_H, default 1600x1000; needs python3 + Pillow for WebP)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { spawnSync } from "node:child_process";
import { launchGpu } from "./gpu.mjs";
const root = path.resolve("dist-demo"), types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream" };
const server = http.createServer((req, res) => { const u = req.url.split("?")[0]; const f = path.join(root, u === "/" ? "index.html" : u); if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); res.end(fs.readFileSync(f)); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/?quality=high&n=150&rotate=0&asset=assets&dust=2400&intro=0`;
const W = +(process.env.PA_W || 1600), H = +(process.env.PA_H || 1000);
const OUT = path.resolve(process.argv[2] || "docs/images"), TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pa-gallery-"));
fs.mkdirSync(OUT, { recursive: true });
const { browser, page, renderer, mode } = await launchGpu({ width: W, height: H });
console.log("renderer:", renderer, "(" + mode + ")");
page.on("pageerror", (e) => console.log("pageerror", e.message));

async function fresh() {
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.waitForFunction(() => window.__atlas && window.__atlas.scene.debug().assetLoaded && window.__atlas.scene.debug().pulseGate && window.__atlas.scene.boltsReady, null, { timeout: 120000 });
  return page.evaluate(() => { const d = window.__atlas.scene.debug(); return { tris: d.assetTriangles, contained: d.containLive ?? d.contained, q: d.quality }; });
}
const settle = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) await page.waitForTimeout(250); };
const shots = [];

// 1. whole folded brain + cerebellum: left posterior-lateral three-quarter view, live scheduler running
let info = await fresh();
await page.evaluate(() => { const s = window.__atlas.scene; s.setAutoRotate(false); s.setPulses(true); s.setCamera([-2.35, 0.55, -1.55], [0, -0.12, -0.08]); s.camTween = null; });
await settle(4000);
await page.screenshot({ path: path.join(TMP, "brain.png") }); shots.push(["brain", info]);

// 2. one real-link lightning strike, deterministic: rAF paused, strike triggered on the most camera-facing link bolt, frame rendered at the return stroke
info = await fresh();
const bolt = await page.evaluate(() => {
  const s = window.__atlas.scene; s.setAutoRotate(false); s.setCamera([2.0, 0.85, 1.5], [0, -0.05, 0.0]); s.camTween = null;
  return true;
});
await settle(1500);
const strike = await page.evaluate(() => {
  const s = window.__atlas.scene, cam = s.camera.position, V = s.camera.position.clone(); cancelAnimationFrame(s.raf);
  const saved = s.sim.rates; s.sim.rates = { ...saved, link: 0, ambient: 0, cascade: 0 }; s.sim.reset(s.pulseClock);
  let best = -1, bs = -1e9;
  s.boltL.bolts.forEach((b, i) => { if (b.n < 8) return; const c = b.center, p = V.set(c[0], c[1], c[2]).project(s.camera); if (Math.abs(p.x) > 0.55 || Math.abs(p.y) > 0.55) return;
    const v = [cam.x - c[0], cam.y - c[1], cam.z - c[2]], vl = Math.hypot(...v), face = (c[0] * v[0] + c[1] * v[1] + c[2] * v[2]) / (vl * (Math.hypot(...c) || 1));
    const sc = face * 1.5 + Math.min(b.radius, 0.35) * 3 + Math.min(b.forks, 8) * 0.06; if (sc > bs) { bs = sc; best = i; } });
  if (best < 0) return null;
  // frame the chosen bolt: closer camera along the view direction, aimed at the bolt centre
  const c = s.boltL.bolts[best].center, dv = [cam.x - c[0], cam.y - c[1], cam.z - c[2]], dl = Math.hypot(...dv);
  s.setCamera([c[0] + dv[0] / dl * 1.45, c[1] + dv[1] / dl * 1.45, c[2] + dv[2] / dl * 1.45], [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8]); s.camTween = null; s.controls?.update?.();
  const T = s.pulseClock + 0.05, st = s.sim.strikeNow(0, best, T); s.pulseClock = T + st.leader + 0.006; s.lastNow = 0; s.frame(performance.now());
  // the WebGL drawing buffer is cleared after compositing, so pin the synchronously rendered frame as an <img> over the canvas
  const r = s.canvas.getBoundingClientRect(), im = document.createElement("img"); im.src = s.canvas.toDataURL("image/png");
  Object.assign(im.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", zIndex: 5, pointerEvents: "none" });
  document.body.appendChild(im);
  for (const el of document.querySelectorAll(".pa-legend, .pa-labels")) el.style.zIndex = 6;
  const b = s.boltL.bolts[best]; return { bolt: best, forks: b.forks, radius: +b.radius.toFixed(3), leaderMs: Math.round(st.leader * 1000) };
});
console.log("strike", JSON.stringify(strike));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(TMP, "lightning.png") }); shots.push(["lightning", { ...info, strike }]);

// 3. selected synthetic note with its real linked neighbours lit and labelled (hover tip + neighbour labels)
info = await fresh();
const pick = await page.evaluate(() => {
  const s = window.__atlas.scene; s.setAutoRotate(false); s.setPulses(true); let b = 0;
  s.graph.nodes.forEach((n, i) => { if (n.degree > s.graph.nodes[b].degree && s.place[i].region === "cortex") b = i; });
  const p = [s.brainP[b * 3], s.brainP[b * 3 + 1], s.brainP[b * 3 + 2]], l = Math.hypot(...p) || 1, d = [p[0] / l, p[1] / l + 0.35, p[2] / l], dl = Math.hypot(...d);
  s.setCamera([p[0] * 0.5 + d[0] / dl * 2.0, p[1] * 0.5 + d[1] / dl * 2.0, p[2] * 0.5 + d[2] / dl * 2.0], [p[0] * 0.5, p[1] * 0.5 - 0.05, p[2] * 0.5]); s.camTween = null;
  return { i: b, title: s.graph.nodes[b].title, degree: s.graph.nodes[b].degree };
});
await settle(1500);
const xy = await page.evaluate((b) => { const s = window.__atlas.scene, r = s.canvas.getBoundingClientRect(), p = s.screenOf(b, r); return [p.x, p.y]; }, pick.i);
await page.mouse.move(xy[0] - 40, xy[1]); await page.mouse.move(xy[0], xy[1], { steps: 5 }); await settle(2500);
const hov = await page.evaluate(() => window.__atlas.scene.hover);
console.log("selected", JSON.stringify(pick), "hover", hov);
await page.screenshot({ path: path.join(TMP, "linked-note.png") }); shots.push(["linked-note", { ...info, pick, hover: hov }]);

await browser.close(); server.close();
// PNG -> WebP (lossy q82, method 6)
for (const [name] of shots) {
  const r = spawnSync("python3", ["-c", "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],'WEBP',quality=82,method=6)", path.join(TMP, name + ".png"), path.join(OUT, name + ".webp")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("webp encode failed: " + r.stderr);
  console.log(path.join(OUT, name + ".webp"), fs.statSync(path.join(OUT, name + ".webp")).size, "bytes");
}
console.log(JSON.stringify(shots));
