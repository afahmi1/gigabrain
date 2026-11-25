// Runtime ZIP parity: what a user unzips and installs must be byte-identical to the source assets, installable, and must load
// (high AND low quality) in a real browser, including morphology templates. Run after `node scripts/package-release.mjs`.
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { readZip } from "../scripts/lib/zip.mjs";

const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const RUNTIME = ["assets/brain.glb", "assets/brain_low.glb", "assets/brain_sdf.bin", "assets/morphologies.json", "assets/LICENSES.md", "LICENSE", "NOTICES.md", "manifest.json", "styles.css", "main.js"];
const plugin = readZip(readFileSync(`release/palace-atlas-${version}.zip`)), demo = readZip(readFileSync(`release/palace-atlas-demo-${version}.zip`));
const W = mkdtempSync(join(tmpdir(), "pa-release-test-"));
const put = (p, d) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, d); };
let server;
try {
  // 1. plugin zip: exact file set, every runtime file equals its source
  assert.deepEqual([...plugin.keys()].sort(), [...RUNTIME, "INSTALL.txt"].map((f) => "palace-atlas/" + f).sort(), "plugin zip contents");
  for (const f of RUNTIME) assert.equal(sha(plugin.get("palace-atlas/" + f)), sha(readFileSync(f)), `plugin zip ${f} == source`);
  // 2. demo zip carries the same assets and a complete index
  for (const f of RUNTIME.filter((f) => f.startsWith("assets/"))) assert.equal(sha(demo.get("palace-atlas-demo/" + f)), sha(readFileSync(f)), `demo zip ${f} == source`);
  const index = JSON.parse(demo.get("palace-atlas-demo/assets/index.json"));
  for (const f of RUNTIME.filter((f) => f.startsWith("assets/")).map((f) => f.slice(7))) assert(index.includes(f), `demo assets/index.json lists ${f}`);
  assert(demo.has("palace-atlas-demo/serve.mjs") && demo.has("palace-atlas-demo/LICENSE") && demo.has("palace-atlas-demo/NOTICES.md"));
  console.log(`PASS plugin zip (${plugin.size} files) and demo zip (${demo.size} files) match source byte-for-byte; demo index lists every asset`);

  // 2b. standalone memory file: fresh vs the build output, shipped with LICENSE + NOTICES, every file in release/ checksummed
  const rel = readdirSync("release").filter((f) => f !== "SHA256SUMS").sort();
  assert.deepEqual(rel, ["LICENSE", "NOTICES.md", `palace-atlas-${version}.zip`, `palace-atlas-demo-${version}.zip`, `palace-atlas-memory-${version}.cjs`], "release/ contents");
  assert.equal(sha(readFileSync(`release/palace-atlas-memory-${version}.cjs`)), sha(readFileSync("memory/dist/palace-memory.cjs")), "memory cjs == memory/dist build");
  for (const f of ["LICENSE", "NOTICES.md"]) assert.equal(sha(readFileSync("release/" + f)), sha(readFileSync(f)), `release/${f} == source`);
  const sums = Object.fromEntries(readFileSync("release/SHA256SUMS", "utf8").trim().split("\n").map((l) => { const [h, n] = l.split(/  /); return [n, h]; }));
  assert.deepEqual(Object.keys(sums).sort(), rel, "SHA256SUMS covers exactly the release files");
  for (const f of rel) assert.equal(sums[f], sha(readFileSync("release/" + f)), `SHA256SUMS ${f}`);
  const mem = readFileSync(`release/palace-atlas-memory-${version}.cjs`, "utf8");
  assert(mem.startsWith("#!/usr/bin/env node"), "memory cjs is executable-style");
  console.log("PASS release/: memory cjs fresh vs build, LICENSE + NOTICES.md alongside, SHA256SUMS covers and matches every file");

  // 3. install the UNZIPPED plugin with the real installer and compare the installed tree with the zip
  const un = join(W, "unzipped"); for (const [n, d] of plugin) put(join(un, n.replace(/^palace-atlas\//, "")), d);
  const dest = join(W, "vault/.obsidian/plugins/palace-atlas"); mkdirSync(dest, { recursive: true }); put(join(dest, "data.json"), '{"keep":true}');
  const r = spawnSync(process.execPath, [resolve("scripts/install-plugin.mjs")], { env: { ...process.env, PA_SRC_DIR: un, PA_PLUGIN_DIR: dest, PA_BACKUP_ROOT: join(W, "bk"), PA_EXPECT_VERSION: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of RUNTIME) assert.equal(sha(readFileSync(join(dest, f))), sha(plugin.get("palace-atlas/" + f)), `installed ${f} == zip`);
  assert.equal(readFileSync(join(dest, "data.json"), "utf8"), '{"keep":true}');
  console.log(`PASS installer puts all ${RUNTIME.length} runtime files from the unzipped plugin into a plugin folder; settings untouched`);

  // 4. real browser: serve the demo page with the INSTALLED plugin assets and verify both quality levels use the morphology templates
  const CHROME = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((c) => c && existsSync(c));
  if (!CHROME) { assert(!process.env.PA_REQUIRE_BROWSER, "PA_REQUIRE_BROWSER set but no Chrome found (set CHROME)"); console.log("SKIP browser load check: no Chrome/Chromium found (set CHROME)"); }
  else {
    const { chromium } = await import("playwright-core");
    const site = join(W, "site"); for (const [n, d] of demo) if (!n.includes("/assets/")) put(join(site, n.replace(/^palace-atlas-demo\//, "")), d);
    for (const f of readdirSync(join(dest, "assets"))) put(join(site, "assets", f), readFileSync(join(dest, "assets", f)));
    put(join(site, "assets/index.json"), JSON.stringify(readdirSync(join(dest, "assets")).sort()));
    const port = 20000 + Math.floor(Math.random() * 20000);
    server = spawn(process.execPath, [join(site, "serve.mjs"), site, String(port)], { stdio: "pipe" });
    await new Promise((res, rej) => { server.stdout.on("data", (d) => /demo/.test(String(d)) && res()); server.on("exit", () => rej(new Error("serve.mjs exited"))); setTimeout(() => rej(new Error("serve.mjs timeout")), 10000); });
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--no-proxy-server", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
    try {
      for (const quality of ["high", "low"]) {
        const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage(), errors = [], hits = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        page.on("response", (x) => hits.push(x.status() + " " + new URL(x.url()).pathname));
        await page.goto(`http://127.0.0.1:${port}/?asset=assets&intro=0&quality=${quality}`);
        await page.waitForFunction(() => window.__atlas?.scene.debug().containLive && window.__atlas.scene.debug().frames > 3, null, { timeout: 180000 });
        const s = await page.evaluate(() => { const sc = window.__atlas.scene, d = sc.debug(); const m = sc.morphs; return { assetLoaded: d.assetLoaded, quality: sc.quality ?? null, n: m.length, template: m.filter((x) => x.source === "template").length, types: [...new Set(m.filter((x) => x.source === "template").map((x) => x.type))].sort() }; });
        const wanted = [quality === "high" ? "brain.glb" : "brain_low.glb", "brain_sdf.bin", "morphologies.json"];
        for (const f of wanted) assert(hits.includes("200 /assets/" + f), `${quality}: fetched ${f} (${hits.join(", ")})`);
        assert(s.assetLoaded, `${quality}: brain asset loaded`); assert(s.template > 0 && s.template <= s.n, `${quality}: morphology templates in use (${JSON.stringify(s)})`);
        assert.deepEqual(hits.filter((h) => !h.startsWith("200 ") && !h.endsWith("/favicon.ico")), [], `${quality}: no failed requests (favicon aside)`);
        assert.deepEqual(errors.filter((e) => !/GPU stall|Failed to load resource/.test(e)), [], `${quality}: no page errors`);
        console.log(`PASS ${quality}: installed assets load; ${s.template}/${s.n} note neurons grown from morphologies.json (${s.types.join(",")})`);
        await page.context().close();
      }
    } finally { await browser.close(); }
  }
} finally { server?.kill(); rmSync(W, { recursive: true, force: true }); }
