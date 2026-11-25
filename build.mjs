import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
const common = { bundle: true, target: "es2020", logLevel: "info", legalComments: "none" };
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "main.js", format: "cjs", platform: "browser", minify: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"] });
mkdirSync("dist-demo", { recursive: true });
await build({ ...common, entryPoints: ["demo/demo.ts"], outfile: "dist-demo/demo.js", format: "iife", platform: "browser", sourcemap: false });
await build({ ...common, entryPoints: ["test/synth-glb.ts"], outfile: "dist-demo/synth-glb.cjs", format: "cjs", platform: "node" });
copyFileSync("demo/index.html", "dist-demo/index.html"); copyFileSync("styles.css", "dist-demo/styles.css");
await build({ ...common, entryPoints: ["test/contain.test.ts"], outfile: "dist-demo/contain.test.cjs", format: "cjs", platform: "node" });
await build({ ...common, entryPoints: ["test/adapter.test.ts"], outfile: "dist-demo/adapter.test.cjs", format: "cjs", platform: "node" });
// Optional assets (brain.glb, brain_low.glb, morphologies.json, LICENSES.md) ship next to main.js; the demo serves them same-origin.
// dist-demo/assets/index.json always exists and lists what is there, so the demo probes without ever causing a 404.
mkdirSync("dist-demo/assets", { recursive: true });
const present = existsSync("assets") ? readdirSync("assets").filter((f) => !f.startsWith(".")) : [];
for (const f of present) copyFileSync("assets/" + f, "dist-demo/assets/" + f);
writeFileSync("dist-demo/assets/index.json", JSON.stringify(present));
