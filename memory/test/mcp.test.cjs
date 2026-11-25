"use strict";
// Real SDK client <-> real server over stdio (child process), no mocks.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
const { CLI, makeVault, put, tmp } = require("./helpers.cjs");

async function connect(args, env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "serve", ...args], env: { PATH: process.env.PATH, ...env }, stderr: "pipe" });
  const client = new Client({ name: "palace-memory-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
const text = (r) => r.content.map((c) => c.text).join("");
const data = (r) => { assert.ok(!r.isError, text(r)); return JSON.parse(text(r)); };

test("mcp: initialize + tools/list + tools/call, read-only by default", async () => {
  const v = makeVault();
  const c = await connect(["--root", v]);
  try {
    const info = c.getServerVersion();
    assert.equal(info.name, "palace-memory");
    const tools = (await c.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["memory_links", "memory_list", "memory_read", "memory_scope", "memory_search"]);
    for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(data(await c.callTool({ name: "memory_scope", arguments: {} })).writeEnabled, false);
    assert.equal(data(await c.callTool({ name: "memory_list", arguments: {} })).notes.length, 3);
    const s = data(await c.callTool({ name: "memory_search", arguments: { query: "quick marmot" } }));
    assert.equal(s.results[0].path, "topics/alpha.md");
    assert.match(data(await c.callTool({ name: "memory_read", arguments: { path: "topics/alpha.md" } })).content, /quick marmot/);
    assert.deepEqual(data(await c.callTool({ name: "memory_links", arguments: { path: "topics/alpha.md" } })).backlinks, ["projects/beta.md"]);
    // refusals come back as tool errors, not protocol crashes
    for (const p of ["../x.md", "topics/secret-diary.md", "/etc/passwd"]) {
      const r = await c.callTool({ name: "memory_read", arguments: { path: p } });
      assert.equal(r.isError, true, p);
      assert.ok(!text(r).includes(v));
    }
    // the write tool does not exist in read-only mode
    const w = await c.callTool({ name: "memory_write", arguments: { title: "x", content: "y" } }).catch((e) => ({ thrown: e }));
    assert.ok(w.thrown || w.isError, "memory_write must be unavailable");
    assert.deepEqual(fs.readdirSync(path.join(v, "memories")), []);
    // input schema is enforced by the SDK
    const bad = await c.callTool({ name: "memory_search", arguments: { query: "" } }).catch((e) => ({ thrown: e }));
    assert.ok(bad.thrown || bad.isError);
  } finally { await c.close(); }
});

test("mcp: a distinct restarted client retrieves what the first one saved", async () => {
  const v = makeVault();
  const before = fs.readdirSync(v).sort();
  const first = await connect(["--root", v, "--allow-write"]);
  let saved;
  try {
    const tools = (await first.listTools()).tools;
    const wt = tools.find((t) => t.name === "memory_write");
    assert.ok(wt, "memory_write listed when --allow-write");
    assert.equal(wt.annotations.destructiveHint, false);
    saved = data(await first.callTool({ name: "memory_write", arguments: { title: "Quokka habitat", content: "Quokkas live on Rottnest Island. Unique-token: zebra-lantern-42.", tags: ["animals"], links: ["alpha"] } }));
    assert.equal(saved.path, "memories/quokka-habitat.md");
    const dup = await first.callTool({ name: "memory_write", arguments: { title: "Quokka habitat", content: "overwrite" } });
    assert.equal(dup.isError, true);
    assert.match(text(dup), /never overwritten/);
  } finally { await first.close(); }

  // brand-new process, brand-new client, no shared state: only the files on disk
  const second = await connect([], { PALACE_MEMORY_ROOT: v }); // read-only, root via environment
  try {
    assert.notEqual(second, first);
    assert.ok(!(await second.listTools()).tools.some((t) => t.name === "memory_write"));
    const s = data(await second.callTool({ name: "memory_search", arguments: { query: "zebra-lantern-42" } }));
    assert.deepEqual(s.results.map((r) => r.path), [saved.path]);
    const r = data(await second.callTool({ name: "memory_read", arguments: { path: saved.path } }));
    assert.match(r.content, /Quokkas live on Rottnest Island/);
    assert.deepEqual(r.tags, ["animals"]);
    assert.ok(data(await second.callTool({ name: "memory_links", arguments: { path: "topics/alpha.md" } })).backlinks.includes(saved.path));
  } finally { await second.close(); }

  const added = fs.readdirSync(v).filter((f) => !before.includes(f));
  assert.deepEqual(added, []);
  assert.deepEqual(fs.readdirSync(path.join(v, "memories")), ["quokka-habitat.md"]);
});

test("mcp: server refuses to start without a root and with an invalid scope config", async () => {
  await assert.rejects(connect([]));
  const v = tmp();
  put(v, "palace-atlas.json", "{bad");
  await assert.rejects(connect(["--root", v]));
});
