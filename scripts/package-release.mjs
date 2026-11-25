// Builds the release artifacts into ./release (deterministic: sorted entries, fixed timestamps, no external zip tool).
//   node scripts/package-release.mjs [--no-build] [--require-memory]
//   palace-atlas-<v>.zip         Obsidian plugin folder  palace-atlas/{main.js,manifest.json,styles.css,LICENSE,NOTICES.md,assets/*}
//   palace-atlas-demo-<v>.zip    static synthetic demo   palace-atlas-demo/{index.html,...,serve.mjs}
//   palace-atlas-memory-<v>.cjs  memory MCP server + CLI (only when memory/dist/palace-memory.cjs exists, or required by --require-memory)
//   LICENSE, NOTICES.md          shipped next to the standalone memory file (it inlines third-party code); only written with it
//   SHA256SUMS                   checksums of every file above
// Every produced zip is re-read and verified (central directory, CRC-32, byte-for-byte against source) before the script succeeds.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { makeZip, readZip } from "./lib/zip.mjs";

const args = new Set(process.argv.slice(2)), OUT = "release";
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
if (version !== pkgVersion) throw new Error(`version mismatch: manifest=${version} package=${pkgVersion}`);
if (!args.has("--no-build")) {
  const run = (a) => { const r = spawnSync(process.execPath, a, { stdio: "inherit" }); if (r.status !== 0) throw new Error(`failed: node ${a.join(" ")}`); };
  run(["build.mjs"]);
  if (existsSync("memory/build.mjs")) run(["memory/build.mjs"]);
}

// ---- inputs ----
const must = (f) => { if (!existsSync(f) || !statSync(f).isFile() || statSync(f).size === 0) throw new Error(`missing or empty release input: ${f} (run npm run build)`); return readFileSync(f); };
// Runtime assets: every file the plugin loads next to main.js, plus the provenance statement. Same list as scripts/install-plugin.mjs.
const ASSETS = ["brain.glb", "brain_low.glb", "brain_sdf.bin", "morphologies.json", "LICENSES.md"];
const text = (s) => Buffer.from(s, "utf8");
const pluginFiles = [
  ["main.js", must("main.js")], ["manifest.json", must("manifest.json")], ["styles.css", must("styles.css")],
  ["LICENSE", must("LICENSE")], ["NOTICES.md", must("NOTICES.md")],
  ...ASSETS.map((a) => [`assets/${a}`, must(`assets/${a}`)]),
  ["INSTALL.txt", text(`Palace Atlas ${version} - Obsidian plugin (desktop only)

1. Open your vault folder in Finder/Explorer and show hidden files (the .obsidian folder).
2. Copy this whole "palace-atlas" folder to  <your vault>/.obsidian/plugins/palace-atlas/
   (so that .obsidian/plugins/palace-atlas/main.js exists).
3. In Obsidian: Settings > Community plugins > turn off Restricted mode > enable "Palace Atlas".
4. Open the command palette and run the Palace Atlas command.

Upgrading: replace the files, keep data.json (your settings). Uninstall: delete the folder.
Full guide: docs/install.md in the repository. License: MIT (LICENSE), third-party: NOTICES.md.
`)],
];
const demoSrc = "dist-demo", demoFiles = ["index.html", "styles.css", "demo.js"].map((f) => [f, must(join(demoSrc, f))]);
for (const a of ASSETS) demoFiles.push([`assets/${a}`, must(join(demoSrc, "assets", a))]);
demoFiles.push(["assets/index.json", must(join(demoSrc, "assets", "index.json"))]);
demoFiles.push(["serve.mjs", must("scripts/serve-demo.mjs")], ["LICENSE", must("LICENSE")], ["NOTICES.md", must("NOTICES.md")]);
demoFiles.push(["README.txt", text(`Palace Atlas ${version} - synthetic demo (no vault data; every note is generated).

  node serve.mjs            # needs Node 20+, serves on 127.0.0.1 only
  open http://127.0.0.1:4173/?asset=assets

Browsers block loading the 3D assets from file://, hence the tiny local server. Without ?asset=assets the demo falls back to a built-in procedural brain.
`)]);

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { recursive: true, force: true });
const built = [];
function emitZip(file, top, files) {
  const entries = files.map(([n, d]) => ({ name: posix.join(top, n), data: d }));
  writeFileSync(join(OUT, file), makeZip(entries));
  const back = readZip(readFileSync(join(OUT, file)));
  if (back.size !== entries.length) throw new Error(`${file}: entry count`);
  for (const e of entries) if (!back.get(e.name)?.equals(e.data)) throw new Error(`${file}: content mismatch ${e.name}`);
  built.push(file); console.log(`${file}  ${entries.length} files, verified`);
}
emitZip(`palace-atlas-${version}.zip`, "palace-atlas", pluginFiles);
emitZip(`palace-atlas-demo-${version}.zip`, "palace-atlas-demo", demoFiles);
const memory = "memory/dist/palace-memory.cjs";
if (existsSync(memory)) {
  // The standalone file inlines the MCP SDK (Apache-2.0) and zod (MIT), so it ships with the license texts as separate files, all checksummed.
  copyFileSync(memory, join(OUT, `palace-atlas-memory-${version}.cjs`)); built.push(`palace-atlas-memory-${version}.cjs`); console.log(`${built.at(-1)}  copied from ${memory}`);
  for (const f of ["LICENSE", "NOTICES.md"]) { copyFileSync(f, join(OUT, f)); built.push(f); }
}
else if (args.has("--require-memory")) throw new Error(`${memory} missing (memory build not integrated)`);
else console.warn(`NOTE: ${memory} not found; memory artifact skipped (memory package not integrated yet)`);
writeFileSync(join(OUT, "SHA256SUMS"), built.map((f) => `${createHash("sha256").update(readFileSync(join(OUT, f))).digest("hex")}  ${f}`).join("\n") + "\n");
console.log("SHA256SUMS written; release/ ready:", built.join(", "));
