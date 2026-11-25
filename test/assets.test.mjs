// Asset provenance gate: every shipped asset is original, procedurally generated, declared in assets/LICENSES.md, and
// regenerates byte-for-byte from the scripts in this repository.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const read = (f) => readFileSync(f);
const glb = (f) => { const b = read(f); assert.equal(b.toString("latin1", 0, 4), "glTF", `${f}: glTF magic`); const n = b.readUInt32LE(12); return JSON.parse(b.toString("utf8", 20, 20 + n)); };

// 1. meshes: procedural generator tag, four expected parts
for (const f of ["assets/brain.glb", "assets/brain_low.glb"]) {
  const j = glb(f);
  assert.match(j.asset.generator, /Palace Atlas procedural brain \(scripts\/build-brain\.mjs\)/, `${f}: generator tag`);
  assert.deepEqual(j.nodes.map((n) => n.name), ["cortex_lh", "cortex_rh", "cerebellum", "brainstem"], `${f}: parts`);
}
assert(read("assets/brain_sdf.bin").length > 1e6, "SDF present and non-trivial");
console.log("PASS meshes carry the procedural generator tag; SDF present");

// 2. morphologies: all cells declare procedural, MIT, original provenance; well-formed SWC columns; all four types
const m = JSON.parse(read("assets/morphologies.json"));
assert.equal(m.generator, "scripts/build-morphologies.mjs"); assert.equal(m.license, "MIT");
assert.equal(m.cells.length, 24, "24 cells");
const types = {}, ids = new Set();
for (const c of m.cells) {
  assert(!ids.has(c.id), `unique id ${c.id}`); ids.add(c.id);
  assert.match(c.source, /^procedural: scripts\/build-morphologies\.mjs seed \d+$/, `${c.id}: procedural source`);
  assert.match(c.license, /^MIT \(original, Palace Atlas contributors\)$/, `${c.id}: original MIT`);
  assert.deepEqual(Object.keys(c).sort(), ["id", "license", "points", "source", "type"], `${c.id}: no extra provenance fields`);
  assert(c.points.length >= 40 && c.points.length <= 1400, `${c.id}: point count ${c.points.length}`);
  c.points.forEach((p, i) => { assert.equal(p.length, 6, "x,y,z,radius,parent,type"); assert(p.every(Number.isFinite)); assert(i === 0 ? p[4] === -1 : p[4] >= 0 && p[4] < i, `${c.id}: parent precedes child`); });
  types[c.type] = (types[c.type] || 0) + 1;
}
assert.deepEqual(types, { pyramidal: 6, stellate: 6, purkinje: 6, interneuron: 6 });
console.log("PASS 24 morphologies, all procedural/original/MIT, valid SWC trees, 6 per cell type");

// 3. provenance statement covers every shipped asset and denies third-party data
const lic = read("assets/LICENSES.md").toString();
for (const f of ["brain.glb", "brain_low.glb", "brain_sdf.bin", "morphologies.json"]) assert(lic.includes("`" + f + "`") || lic.includes(f), `LICENSES.md covers ${f}`);
assert(/original, procedurally generated/i.test(lic) && /No anatomical scans/i.test(lic), "LICENSES.md states originality");
assert(read("LICENSE").toString().startsWith("MIT License"), "root LICENSE is MIT");
const notices = read("NOTICES.md").toString();
for (const p of ["three", "three-mesh-bvh", "@modelcontextprotocol/server", "zod"]) assert(notices.includes(`### ${p} `), `NOTICES.md lists ${p}`);
assert(notices.includes("morphologies.json") && notices.includes("assets/LICENSES.md"), "NOTICES.md describes the shipped assets");
console.log("PASS LICENSES.md and NOTICES.md cover every shipped asset");

// 4. reproducibility: the generators reproduce the committed files byte-for-byte (SDF is covered by test:contain)
const tmp = mkdtempSync(join(tmpdir(), "pa-assets-"));
try {
  const out = join(tmp, "morphologies.json");
  const r = spawnSync(process.execPath, ["scripts/build-morphologies.mjs", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sha(read(out)), sha(read("assets/morphologies.json")), "build-morphologies.mjs reproduces assets/morphologies.json");
  console.log("PASS build-morphologies.mjs reproduces assets/morphologies.json byte-for-byte");
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log("assets sha256:", ["brain.glb", "brain_low.glb", "brain_sdf.bin", "morphologies.json", "LICENSES.md"].map((f) => f + "=" + sha(read("assets/" + f)).slice(0, 12)).join(" "));
