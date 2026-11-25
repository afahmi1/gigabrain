// Build one conservative field for both rendered LODs: intersect their voxelised interiors
// before adding the shared bridge volumes. The closed cerebellum now supports parity like the cortex.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { generateField, readGlbMeshes } from "../src/sdfgen";
import { serializeField } from "../src/field";

const [high = "assets/brain.glb", low = "assets/brain_low.glb", out = "assets/brain_sdf.bin"] = process.argv.slice(2);
const bytes = [readFileSync(high), readFileSync(low)], lods = bytes.map(readGlbMeshes);
assert(lods.every((L) => L.cerebellum), "both runtime LODs must include the cerebellum");
const glbSha256 = bytes.map((data) => createHash("sha256").update(data).digest("hex"));
const t0 = Date.now(), { field, info } = generateField(lods, { extra: { glbSha256 } });
assert.equal(info.parts.cerebellum.method, "parity", "both cerebellar surfaces must be closed; refusing a visual hull");
writeFileSync(out, serializeField(field));
const c = field.coreInfo(field.margin);
console.log(`wrote ${out}: dims ${field.dims.join("x")}, voxel ${field.h.toFixed(5)}, margin ${field.margin.toFixed(4)}, ${info.voxels} inside voxels, ${Date.now() - t0} ms`);
console.log(`LODs ${lods.length}; parts`, JSON.stringify(info.parts), "bridges", info.bridges);
console.log(`core at margin: main piece ${c.main} voxels, pieces ${c.pieces}`);
