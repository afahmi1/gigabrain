// Replace only the cerebellum primitive in existing GLBs (for example a locally imported, separately licensed cortex), in their brain coordinate frame.
// Original procedural illustration; no scans, imported meshes or Python dependencies.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { cerebellumMesh as tessellate } from "./lib/cerebellum-geometry.mjs";

function replace(bytes, { pos, normal, curv, indices }) {
  const jsonBytes = bytes.readUInt32LE(12), bin = 20 + jsonBytes + 8;
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  assert.equal(bytes.toString("ascii", bin - 4, bin - 1), "BIN");
  const json = JSON.parse(bytes.toString("utf8", 20, 20 + jsonBytes));
  assert.equal(json.buffers.length, 1);
  assert.equal(bytes.length, bin + bytes.readUInt32LE(bin - 8));
  const meshes = json.meshes.filter((m) => m.name === "cerebellum");
  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].primitives.length, 1);
  const p = meshes[0].primitives[0], chunks = new Map();
  const attrs = [[p.attributes.POSITION, pos, 3], [p.attributes.NORMAL, normal, 3], [p.attributes._CURV, curv, 1], [p.indices, indices, 1]];
  for (const [a, values, width] of attrs) {
    const acc = json.accessors[a], v = json.bufferViews[acc.bufferView];
    assert(!acc.byteOffset && !v.byteStride && !acc.sparse && !chunks.has(acc.bufferView));
    // The original GLBs allocate one bufferView per accessor. Reject shared views rather than moving unrelated data.
    assert.equal(json.accessors.filter((a) => a.bufferView === acc.bufferView).length, 1);
    acc.count = values.length / width;
    acc.componentType = a === p.indices ? 5125 : 5126;
    if (values === pos) {
      acc.min = [Infinity, Infinity, Infinity]; acc.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i++) {
        const k = i % 3;
        acc.min[k] = Math.min(acc.min[k], pos[i]); acc.max[k] = Math.max(acc.max[k], pos[i]);
      }
    } else { delete acc.min; delete acc.max; }
    const block = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) {
      if (values === indices) block.writeUInt32LE(values[i], i * 4);
      else block.writeFloatLE(values[i], i * 4);
    }
    chunks.set(acc.bufferView, block);
  }
  let length = 0;
  const blocks = json.bufferViews.map((view, i) => {
    assert.equal(view.buffer, 0);
    const offset = view.byteOffset ?? 0;
    const block = chunks.get(i) ?? bytes.subarray(bin + offset, bin + offset + view.byteLength);
    assert(!(block.length % 4), "expected four-byte-aligned GLB views");
    view.byteOffset = length; view.byteLength = block.length; length += block.length;
    return block;
  });
  json.buffers[0].byteLength = length;
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const gh = Buffer.alloc(20), bh = Buffer.alloc(8);
  gh.write("glTF"); gh.writeUInt32LE(2, 4); gh.writeUInt32LE(28 + padded.length + length, 8);
  gh.writeUInt32LE(padded.length, 12); gh.write("JSON", 16);
  bh.writeUInt32LE(length); bh.write("BIN\0", 4);
  return Buffer.concat([gh, padded, bh, ...blocks]);
}

const output = [["assets/brain.glb", 111, 164], ["assets/brain_low.glb", 53, 94]].map(([file, strips, around]) => {
  const mesh = tessellate(strips, around);
  return { file, bytes: replace(readFileSync(file), mesh), triangles: mesh.indices.length / 3 };
});
for (const { file, bytes, triangles } of output) {
  writeFileSync(file, bytes);
  console.log(`${file}: ${triangles} cerebellum triangles (${bytes.length} GLB bytes)`);
}
