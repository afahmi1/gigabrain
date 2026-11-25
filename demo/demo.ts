import { AtlasUI } from "../src/ui";
import { demoSource } from "./fixture";
import { buildGraph } from "../src/adapter";
import { buildDiag } from "../src/diag";
import { isQuality } from "../src/quality";

(async () => {
const KEY = "palace-atlas-demo-data";
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } })();
(window as any).__opened = [];
const q = new URLSearchParams(location.search);
const assetDir = q.get("asset");
let list: Promise<string[]> | null = null;
const listing = () => (list ??= fetch(`${assetDir}/index.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []));
let templates: any[] | undefined;
if (assetDir && (await listing()).includes("morphologies.json")) { try { const j = await (await fetch(`${assetDir}/morphologies.json`)).json(); if (Array.isArray(j?.cells)) templates = j.cells; } catch { /* optional */ } }
const ui = new AtlasUI({
  container: document.getElementById("app")!,
  banner: "DEMO: synthetic fixture, not your vault",
  // ?quality=high|balanced|low forces a level (otherwise saved choice, else auto: Low on software renderers); ?asset=<dir> loads <dir>/brain.glb (same origin)
  initial: { mode: saved?.mode ?? "brain", positions: saved?.positions ?? {}, rotate: q.get("rotate") === "1", quality: isQuality(q.get("quality")) ? (q.get("quality") as any) : saved?.quality },
  loadAsset: assetDir ? async (f) => { try { if (!(await listing()).includes(f)) return null; const r = await fetch(`${assetDir}/${f}`); return r.ok ? await r.arrayBuffer() : null; } catch { return null; } } : undefined,
  templates,
  dustCount: Number(q.get("dust") || 2400),
  intro: q.get("intro") !== "0",
  morphMs: Number(q.get("morph") || 800),
  onOpen: (p) => (window as any).__opened.push(p),
  onState: (s) => localStorage.setItem(KEY, JSON.stringify(s)),
});
ui.setGraph(buildGraph(demoSource(Number(q.get("n") || 150)))); // ?n=1500 for the perf fixture (still synthetic)
(window as any).__atlas = ui;
(window as any).__diag = () => buildDiag("test", ui.scene.graph, ui.scene);

})();
