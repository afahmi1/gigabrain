// Test the real installer exclusively against an owned synthetic temp plugin, never Obsidian.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const W = mkdtempSync(join(tmpdir(), "pa-install-test-"));
const SRC = join(W, "src"), DEST = join(W, "fake-plugin"), BK = join(W, "backups"), TRACE = join(W, "trace.mjs");
const put = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
const FILES = ["assets/brain.glb", "assets/brain_low.glb", "assets/brain_sdf.bin", "assets/morphologies.json", "assets/LICENSES.md", "LICENSE", "NOTICES.md", "manifest.json", "styles.css", "main.js"];
const noStage = () => assert(!readdirSync(DEST).some((n) => n.startsWith(".pa-stage-")), "no leaked staging directories");
const snap = () => Object.fromEntries([...FILES, "data.json", "diag.json", "unrelated.txt"].map((f) => [f, existsSync(join(DEST, f)) ? sha(join(DEST, f)) : null]));
const run = (args = [], env = {}) => spawnSync(process.execPath, ["--import", TRACE, resolve("scripts/install-plugin.mjs"), ...args], {
  env: { ...process.env, PA_SRC_DIR: SRC, PA_PLUGIN_DIR: DEST, PA_BACKUP_ROOT: BK, PA_EXPECT_VERSION: "", ...env }, encoding: "utf8", timeout: 10000,
});
const success = (r) => { assert.equal(r.status, 0, r.error?.message ?? r.stdout + r.stderr); noStage(); };
const failure = (r, msg) => { assert.equal(r.status, 1, r.error?.message ?? r.stdout + r.stderr); assert.match(r.stderr, msg); noStage(); };
const published = (r) => r.stdout.split("\n").filter((l) => l.startsWith("TRACE ")).map((l) => l.slice(6));
try {
  // Instrument the actual atomic renames and reject even a read of the sentinels by the installer child.
  put(TRACE, `import fs from "node:fs"; import { relative } from "node:path"; import { syncBuiltinESMExports } from "node:module";
const dst = ${JSON.stringify(DEST)}, rename = fs.renameSync, read = fs.readFileSync;
fs.renameSync = (from, to) => { rename(from, to); if (to.startsWith(dst + "/")) console.log("TRACE " + relative(dst, to)); };
fs.readFileSync = (p, ...args) => { if (typeof p === "string" && /\\/(?:data|diag)\\.json$/.test(p)) throw new Error("read of sentinel forbidden"); return read(p, ...args); };
syncBuiltinESMExports();`);
  for (const f of FILES) put(join(SRC, f), `new-${f}`);
  put(join(SRC, "manifest.json"), JSON.stringify({ version }));
  put(join(SRC, "package.json"), JSON.stringify({ version }));
  for (const f of FILES.filter((f) => f !== "assets/brain_sdf.bin")) put(join(DEST, f), `old-${f}`);
  put(join(DEST, "manifest.json"), JSON.stringify({ version: "0.3.1" }));
  for (const f of ["data.json", "diag.json", "unrelated.txt"]) put(join(DEST, f), `synthetic-sentinel-${f}`);
  const orig = snap();
  failure(run([], { PA_PLUGIN_DIR: "" }), /explicitly name the target/);
  const s = join(SRC, "assets/brain_sdf.bin"); renameSync(s, s + ".hold");
  failure(run(), /source missing.*brain_sdf/); assert.deepEqual(snap(), orig); assert(!existsSync(BK));
  renameSync(s + ".hold", s);
  put(join(SRC, "package.json"), JSON.stringify({ version: "0.3.1" }));
  failure(run(), /version mismatch/); assert.deepEqual(snap(), orig); assert(!existsSync(BK));
  put(join(SRC, "package.json"), JSON.stringify({ version }));
  const dry = run(["--dry-run"]); success(dry); assert.match(dry.stdout, /10 staged hashes match/); assert.deepEqual(published(dry), []); assert.deepEqual(snap(), orig); assert(!existsSync(BK));
  console.log("PASS explicit target, required assets and versions; dry-run stages without replacing any runtime file");

  const upgrade = run(); success(upgrade); assert.deepEqual(published(upgrade), FILES, "main.js is published last, after every asset");
  for (const f of FILES) assert.equal(sha(join(DEST, f)), sha(join(SRC, f)), f);
  for (const f of ["data.json", "diag.json", "unrelated.txt"]) assert.equal(sha(join(DEST, f)), orig[f]);
  const [name] = readdirSync(BK);
  assert.match(name, new RegExp(`^palace-atlas-\\d{8}-\\d{6}-pre-${version.replaceAll(".", "\\.")}-\\w+$`));
  const bdir = join(BK, name), m = JSON.parse(readFileSync(join(bdir, "backup-manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(m.files).sort(), FILES.slice().sort());
  for (const f of FILES) assert.equal(m.files[f].sha256, orig[f]);
  console.log("PASS upgrade parity, main.js last, exact backup hashes; data.json and diag.json untouched");

  const rollback = run(["--rollback", bdir]); success(rollback); assert.deepEqual(published(rollback), FILES.filter((f) => orig[f] !== null)); assert.deepEqual(snap(), orig);
  console.log("PASS rollback restores exact old runtime including absence of the SDF");
  success(run()); assert.equal(readdirSync(BK).length, 2, "independent backups even in the same second");
  put(join(bdir, "files/main.js"), "tampered"); const beforeTamper = snap();
  const tamper = run(["--rollback", bdir]); failure(tamper, /backup file hash mismatch: main.js/);
  assert.deepEqual(published(tamper), []); assert.deepEqual(snap(), beforeTamper);
  console.log("PASS tampered backup rejected before any publication");
} finally { rmSync(W, { recursive: true, force: true }); }
