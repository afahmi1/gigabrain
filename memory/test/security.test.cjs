"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CORE, makeVault, put, tmp } = require("./helpers.cjs");
const { Memory, MemoryError } = require(CORE);

const denied = (m, p) => assert.throws(() => m.read(p), (e) => e instanceof MemoryError && e.code === "not_found", String(p));

test("traversal, absolute, URL and odd paths are refused", () => {
  const v = makeVault();
  const outside = put(tmp(), "outside.md", "# Outside\n\nsentinel-outside\n");
  const m = new Memory({ root: v });
  for (const p of ["../outside.md", "topics/../../outside.md", "topics/../topics/alpha.md", "./topics/alpha.md", "topics//alpha.md", outside, "/etc/passwd", "~/x.md", "topics\\alpha.md", "topics/alpha.md\0.txt", "file:///etc/passwd.md", "https://x/y.md", "C:/x.md", "", "topics/", "topics", "Topics/alpha.md", "topics/alpha.MD.txt", "x".repeat(400), null, 7, {}]) denied(m, p);
  assert.ok(m.read("topics/alpha.md"));
});

test("symlinked note, symlinked folder, symlinked configured root folder are not followed", () => {
  const v = makeVault();
  const ext = tmp("pm-ext-");
  put(ext, "leak.md", "# Leak\n\nsentinel-leak\n");
  put(ext, "dir/inner.md", "# Inner\n\nsentinel-leak\n");
  fs.symlinkSync(path.join(ext, "leak.md"), path.join(v, "topics", "link.md"));
  fs.symlinkSync(path.join(ext, "dir"), path.join(v, "topics", "linkdir"));
  fs.symlinkSync(path.join(v, "topics", "alpha.md"), path.join(v, "topics", "alias.md")); // even an in-vault target
  const m = new Memory({ root: v });
  denied(m, "topics/link.md");
  denied(m, "topics/linkdir/inner.md");
  denied(m, "topics/alias.md");
  assert.equal(m.search("sentinel-leak").results.length, 0);
  assert.ok(!m.list().notes.some((n) => /link|alias/.test(n.path)));
  // configured top-level folder itself replaced by a symlink
  fs.rmSync(path.join(v, "projects"), { recursive: true });
  fs.symlinkSync(path.join(ext, "dir"), path.join(v, "projects"));
  denied(m, "projects/inner.md");
  assert.ok(!m.list().notes.some((n) => n.path.startsWith("projects/")));
});

test("hard links to files elsewhere are refused", () => {
  const v = makeVault();
  const ext = put(tmp("pm-ext-"), "hard.md", "# Hard\n\nsentinel-hard\n");
  fs.linkSync(ext, path.join(v, "topics", "hard.md"));
  const m = new Memory({ root: v });
  denied(m, "topics/hard.md");
  assert.equal(m.search("sentinel-hard").results.length, 0);
});

test("a symlinked palace-atlas.json is not followed", () => {
  const v = makeVault();
  const ext = put(tmp("pm-ext-"), "cfg.json", JSON.stringify({ folders: ["other"], inbox: "other" }));
  fs.symlinkSync(ext, path.join(v, "palace-atlas.json"));
  assert.throws(() => new Memory({ root: v }), /regular file/);
});

test("write never follows a symlink: inbox symlink, pre-planted file link", () => {
  const v = makeVault();
  const ext = tmp("pm-ext-");
  put(ext, "victim.md", "ORIGINAL\n");
  // inbox is a symlink to an outside directory
  fs.rmSync(path.join(v, "memories"), { recursive: true });
  fs.symlinkSync(ext, path.join(v, "memories"));
  const m = new Memory({ root: v, allowWrite: true });
  assert.throws(() => m.write({ title: "victim", content: "pwned" }), (e) => e.code === "unsafe");
  assert.equal(fs.readFileSync(path.join(ext, "victim.md"), "utf8"), "ORIGINAL\n");
  assert.deepEqual(fs.readdirSync(ext), ["victim.md"]);
  // target file name pre-planted as a symlink inside a real inbox
  fs.unlinkSync(path.join(v, "memories"));
  fs.mkdirSync(path.join(v, "memories"));
  fs.symlinkSync(path.join(ext, "victim.md"), path.join(v, "memories", "victim.md"));
  assert.throws(() => m.write({ title: "victim", content: "pwned" }), (e) => e.code === "exists");
  assert.equal(fs.readFileSync(path.join(ext, "victim.md"), "utf8"), "ORIGINAL\n");
});

test("write can only land in the inbox: title cannot steer the path", () => {
  const v = makeVault();
  const m = new Memory({ root: v, allowWrite: true });
  for (const title of ["../../etc/evil", "topics/alpha", "a/b/c", ".hidden"]) {
    const w = m.write({ title, content: "x" });
    assert.match(w.path, /^memories\/[a-z0-9-]+\.md$/, title);
  }
  assert.equal(fs.readFileSync(path.join(v, "topics/alpha.md"), "utf8").includes("quick marmot"), true);
  assert.throws(() => m.write({ title: "..", content: "x" }), /letters or digits/);
  assert.ok(!fs.existsSync(path.join(path.dirname(v), "etc")));
});

test("existing notes are never deleted or modified by any operation", () => {
  const v = makeVault();
  const snap = () => JSON.stringify(walk(v).map((f) => [f, fs.readFileSync(path.join(v, f), "utf8")]));
  const before = snap();
  const m = new Memory({ root: v });
  m.list(); m.search("marmot"); m.read("topics/alpha.md"); m.links("topics/alpha.md"); m.scope();
  assert.equal(snap(), before);
  const w = new Memory({ root: v, allowWrite: true }).write({ title: "added", content: "c" });
  const after = walk(v);
  assert.deepEqual(after.filter((f) => !JSON.parse(before).some(([g]) => g === f)), [w.path]);
});
function walk(d, rel = "") {
  return fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d, path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]).sort();
}
