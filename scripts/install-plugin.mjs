// Whitelisted release installer; only an explicitly named existing plugin directory can be modified.
// PA_PLUGIN_DIR=<plugin-dir> PA_BACKUP_ROOT=<backup-root> node scripts/install-plugin.mjs [--dry-run]
// PA_PLUGIN_DIR=<plugin-dir> node scripts/install-plugin.mjs --rollback <backup-dir>
// PA_SRC_DIR defaults to cwd (a built checkout, or an unzipped release folder). PA_EXPECT_VERSION optionally pins the version;
// by default the source manifest.json version is used, and package.json (when present) must agree. Never reads or writes data.json/diag.json.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// The watcher reloads on main.js. Publish it only after every dependency (including the SDF) is in place.
const FILES = ["assets/brain.glb", "assets/brain_low.glb", "assets/brain_sdf.bin", "assets/morphologies.json", "assets/LICENSES.md", "LICENSE", "NOTICES.md", "manifest.json", "styles.css", "main.js"];
const SRC = resolve(process.env.PA_SRC_DIR || ".");
let VERSION = process.env.PA_EXPECT_VERSION || "";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stat = (p) => { try { return lstatSync(p); } catch (e) { if (e.code !== "ENOENT") throw e; return null; } };
const need = (condition, message) => { if (!condition) throw new Error(message); };
const readVersions = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8")).version;
const hashes = (dir) => Object.fromEntries(FILES.map((f) => {
  const p = join(dir, f), st = stat(p);
  need(!st || st.isFile(), `not a regular runtime file: ${f}`);
  return [f, st ? sha(p) : null];
}));

function withStage(parent, from, expected, action) {
  const stage = mkdtempSync(join(parent, ".pa-stage-"));
  try {
    for (const f of FILES) {
      if (expected[f] === null) continue;
      const t = join(stage, f); mkdirSync(dirname(t), { recursive: true }); copyFileSync(join(from, f), t);
      need(sha(t) === expected[f], `staged hash mismatch: ${f}`);
    }
    action(stage);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
function publish(stage, dst, expected) {
  for (const f of FILES) {
    const t = join(dst, f);
    if (expected[f] === null) { if (stat(t)) unlinkSync(t); }
    else { mkdirSync(dirname(t), { recursive: true }); renameSync(join(stage, f), t); }
  }
  const actual = hashes(dst);
  for (const f of FILES) {
    need(actual[f] === expected[f], `runtime readback hash mismatch: ${f}`);
    console.log(f.padEnd(28), actual[f] ?? "absent", "OK");
  }
}
function restore(bdir, dst) {
  const m = JSON.parse(readFileSync(join(bdir, "backup-manifest.json"), "utf8"));
  const expected = Object.fromEntries(FILES.map((f) => {
    const h = m.files?.[f]?.sha256;
    need(h === null || (typeof h === "string" && /^[a-f0-9]{64}$/.test(h)), `invalid backup manifest entry: ${f}`);
    return [f, h];
  }));
  const from = join(bdir, "files"), actual = hashes(from);
  for (const f of FILES) need(actual[f] === expected[f], `backup file hash mismatch: ${f}`);
  withStage(dst, from, expected, (stage) => publish(stage, dst, expected));
}
function run(args) {
  const rollback = args[0] === "--rollback" && args.length === 2, dry = args.length === 1 && args[0] === "--dry-run";
  need(args.length === 0 || dry || rollback, "usage: install-plugin.mjs [--dry-run | --rollback <backup-dir>]");
  need(process.env.PA_PLUGIN_DIR, "PA_PLUGIN_DIR must explicitly name the target plugin directory");
  const dst = resolve(process.env.PA_PLUGIN_DIR);
  need(dst !== SRC && stat(dst)?.isDirectory(), "target must be an existing plugin directory, separate from the source");
  const da = stat(join(dst, "assets")); need(!da || da.isDirectory(), "target assets must be a directory, not a symlink");
  const previous = hashes(dst); // exact whitelist only
  if (rollback) { restore(resolve(args[1]), dst); return; }
  if (!dry) need(process.env.PA_BACKUP_ROOT, "PA_BACKUP_ROOT is required for installation");
  for (const f of FILES) { const st = stat(join(SRC, f)); need(st?.isFile() && st.size > 0, `source missing, empty, or not a regular file: ${f}`); }
  const manifest = readVersions(SRC, "manifest.json"), pkg = stat(join(SRC, "package.json")) ? readVersions(SRC, "package.json") : manifest;
  VERSION ||= manifest;
  need(manifest === VERSION && pkg === VERSION, `version mismatch: manifest=${manifest} package=${pkg} expected=${VERSION}`);
  const expected = hashes(SRC);
  withStage(dry ? tmpdir() : dst, SRC, expected, (stage) => {
    console.log(`preflight OK: ${FILES.length} staged hashes match source${dry ? " (dry run, target unchanged)" : ""}`);
    if (dry) return;
    const root = resolve(process.env.PA_BACKUP_ROOT); mkdirSync(root, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    const bdir = mkdtempSync(join(root, `palace-atlas-${ts}-pre-${VERSION}-`));
    const saved = join(bdir, "files"); mkdirSync(saved);
    for (const f of FILES) if (previous[f] !== null) {
      const t = join(saved, f); mkdirSync(dirname(t), { recursive: true }); copyFileSync(join(dst, f), t);
      need(sha(t) === previous[f], `backup hash mismatch: ${f}`);
    }
    writeFileSync(join(bdir, "backup-manifest.json"), JSON.stringify({ created: ts, target: VERSION, files: Object.fromEntries(FILES.map((f) => [f, { sha256: previous[f] }])) }, null, 2));
    console.log("backup:", bdir);
    try { publish(stage, dst, expected); }
    catch (e) { console.error("install failed; restoring backup:", e.message); restore(bdir, dst); throw e; }
    console.log("rollback directory:", bdir);
  });
}
try { run(process.argv.slice(2)); }
catch (e) { console.error("FAIL:", e.message); process.exitCode = 1; }
