// Synthetic-demo screenshots on the real GPU. Usage: node test/shoot.mjs [all | name quality preset [n]]  (env PA_W/PA_H)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { launchGpu } from "./gpu.mjs"; import os from "node:os";
const OUT = path.resolve(process.env.PA_SHOTS || path.join(os.tmpdir(), "palace-atlas-shots")); fs.mkdirSync(OUT, { recursive: true });
const root = path.resolve("dist-demo"), types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary" };
const server = http.createServer((req, res) => { const u = req.url.split("?")[0]; if (u === "/favicon.ico") { res.writeHead(204); return res.end(); } const f = path.join(root, u === "/" ? "index.html" : u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); res.end(fs.readFileSync(f)); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`, W = +(process.env.PA_W || 1280), H = +(process.env.PA_H || 800);
const SHOTS = process.argv[2] === "all" || !process.argv[2]
  ? [["v030-overview", "high", "overview"], ["v030-neuron-closeup", "high", "closeup"], ["v030-impulses", "high", "impulses"], ["v030-hover-focus", "high", "hover"], ["v030-low", "low", "overview"], ["v030-underside", "high", "underside"]]
  : [[process.argv[2], process.argv[3] || "high", process.argv[4] || "overview", process.argv[5]]];
const { browser, page, renderer, mode } = await launchGpu({ width: W, height: H });
console.log("renderer:", renderer, "(" + mode + ")");
page.on("console", (m) => { if (m.type() === "error") console.log("console error", m.text().slice(0, 300)); }); page.on("pageerror", (e) => console.log("pageerror", e.message));
for (const [name, quality, preset, n = "150"] of SHOTS) {
  await page.goto(url + `?quality=${quality}&n=${n}&rotate=0&asset=assets&dust=2400&intro=0`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url + `?quality=${quality}&n=${n}&rotate=0&asset=assets&dust=2400&intro=0`);
  await page.waitForFunction(() => window.__atlas && window.__atlas.scene.debug().assetLoaded, null, { timeout: 120000 }).catch(() => console.log("asset not loaded"));
  await page.evaluate((p) => { const s = window.__atlas.scene; s.setPulses(true); s.preset(p === "hover" ? "overview" : p); }, preset);
  if (process.env.PA_EXTRA) await page.evaluate(process.env.PA_EXTRA);
  let info = {}; const t0 = Date.now();
  while (Date.now() - t0 < 40000) { await page.waitForTimeout(500); info = await page.evaluate(() => { const d = window.__atlas.scene.debug(); return { frames: d.frames, act: d.impulsesActive }; }); if (info.frames > 30 && info.act >= 2 && Date.now() - t0 > 3000) break; } // lightning: a couple of strikes in flight
  if (preset === "hover") {
    const pt = await page.evaluate(() => { const s = window.__atlas.scene; let b = 0; s.graph.nodes.forEach((n, i) => { if (n.degree > s.graph.nodes[b].degree && s.place[i].region === "cortex") b = i; }); s.preset("overview"); s.controls.target.set(s.brainP[b * 3] * 0.5, s.brainP[b * 3 + 1] * 0.5, s.brainP[b * 3 + 2] * 0.5); s.camera.position.set(s.brainP[b * 3] * 2.2 + 0.3, s.brainP[b * 3 + 1] * 1.6 + 0.4, s.brainP[b * 3 + 2] * 1.2 + 1.2); s.controls.update(); s.invalidate(30); return b; });
    await page.waitForTimeout(800);
    const xy = await page.evaluate((b) => { const s = window.__atlas.scene, r = s.canvas.getBoundingClientRect(), p = s.screenOf(b, r); return [p.x, p.y]; }, pt);
    await page.mouse.move(xy[0] - 30, xy[1]); await page.mouse.move(xy[0], xy[1], { steps: 4 }); await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(name, JSON.stringify(await page.evaluate(() => { const d = window.__atlas.scene.debug(); return { q: d.quality, bloom: d.bloom, tris: d.assetTriangles, act: d.impulsesActive, decor: d.decorNeurons, segs: d.noteNeuronSegments, hover: window.__atlas.scene.hover }; })));
}
await browser.close(); server.close();
