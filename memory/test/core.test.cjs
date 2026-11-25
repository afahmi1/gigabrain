"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CORE, makeVault, put, tmp } = require("./helpers.cjs");
const { Memory, LIMITS, MemoryError, extractLinks } = require(CORE);

const paths = (r) => r.notes.map((n) => n.path);

test("scope: only allowed notes are listed", () => {
  const m = new Memory({ root: makeVault() });
  assert.deepEqual(paths(m.list()), ["topics/alpha.md", "topics/sub/deep.md", "projects/beta.md"]);
});

test("scope: excluded / hidden / out-of-folder notes are unreadable and unsearchable", () => {
  const v = makeVault();
  const m = new Memory({ root: v });
  for (const p of ["topics/secret-diary.md", "topics/flagged.md", "topics/off.md", "topics/tagged.md", "topics/inline.md", "topics/broken.md", "topics/.hidden.md", ".git/topics/x.md", "topics/.stash/y.md", "topics/notes.txt", "other/outside.md", "root-note.md", "palace-atlas.json"]) {
    assert.throws(() => m.read(p), (e) => e instanceof MemoryError && e.code === "not_found", p);
  }
  assert.deepEqual(m.search("marmot").results.map((r) => r.path).sort(), ["topics/alpha.md", "topics/sub/deep.md"]);
});

test("scope: custom palace-atlas.json is honoured, invalid config is an error (never widened)", () => {
  const v = tmp();
  put(v, "palace-atlas.json", JSON.stringify({ folders: ["notes"], inbox: "notes", exclude: ["nope"] }));
  put(v, "notes/a.md", "# A\n\nprivate words are fine here\n");
  put(v, "topics/b.md", "# B\n");
  const m = new Memory({ root: v });
  assert.deepEqual(paths(m.list()), ["notes/a.md"]);
  put(v, "palace-atlas.json", "{ not json");
  assert.throws(() => new Memory({ root: v }), /valid JSON/);
  put(v, "palace-atlas.json", JSON.stringify({ folders: ["notes"], surprise: 1 }));
  assert.throws(() => new Memory({ root: v }), /unknown key/);
});

test("read / list folder filter / search ranking and limits", () => {
  const m = new Memory({ root: makeVault() });
  const r = m.read("topics/alpha.md");
  assert.equal(r.title, "Alpha");
  assert.deepEqual(r.tags, ["greek"]);
  assert.match(r.content, /quick marmot/);
  assert.deepEqual(paths(m.list("projects")), ["projects/beta.md"]);
  assert.throws(() => m.list("other"), /folder must be one of/);
  const s = m.search("marmot greek");
  assert.deepEqual(s.results.map((x) => x.path), ["topics/alpha.md"]);
  assert.match(s.results[0].snippet, /marmot/);
  assert.equal(m.search("marmot", 1).results.length, 1);
  assert.equal(m.search("zzzznope").results.length, 0);
  assert.throws(() => m.search("   "), /query/);
  assert.throws(() => m.search("x".repeat(LIMITS.maxQueryChars + 1)), /query/);
});

test("read truncates long notes and skips oversized ones", () => {
  const v = tmp();
  put(v, "topics/long.md", "# Long\n\n" + "word ".repeat(30000));
  put(v, "topics/huge.md", "# Huge\n\n" + "x".repeat(LIMITS.maxFileBytes + 10));
  const m = new Memory({ root: v });
  const r = m.read("topics/long.md");
  assert.equal(r.content.length, LIMITS.maxReadChars);
  assert.equal(r.contentTruncated, true);
  assert.throws(() => m.read("topics/huge.md"), MemoryError);
  assert.deepEqual(paths(m.list()), ["topics/long.md"]);
});

test("links: wikilinks, markdown links, backlinks, unresolved", () => {
  const v = makeVault();
  put(v, "topics/gamma.md", "# Gamma\n\n[[alpha#Heading|the a]] [[missing-note]] [web](https://example.com/x.md) [[secret-diary]]\n");
  const m = new Memory({ root: v });
  const a = m.links("topics/alpha.md");
  assert.deepEqual(a.outgoing.map((l) => l.resolved), ["projects/beta.md", "projects/beta.md"]);
  assert.deepEqual(a.backlinks.sort(), ["projects/beta.md", "topics/gamma.md"]);
  const g = m.links("topics/gamma.md");
  assert.deepEqual(g.outgoing.map((l) => l.resolved), ["topics/alpha.md", null, null]); // excluded note never resolves
  assert.equal(extractLinks("[x](http://a/b.md)").length, 0);
});

test("write: disabled by default", () => {
  const v = makeVault();
  const m = new Memory({ root: v });
  assert.throws(() => m.write({ title: "T", content: "c" }), (e) => e.code === "read_only");
  assert.deepEqual(fs.readdirSync(path.join(v, "memories")), []);
});

test("write: creates one note in the inbox, readable back, never overwrites", () => {
  const v = makeVault();
  const m = new Memory({ root: v, allowWrite: true });
  const w = m.write({ title: "Marmot Facts: 2026!", content: "Marmots hibernate.", tags: ["animals", "facts"], links: ["alpha", "projects/beta.md"] });
  assert.equal(w.path, "memories/marmot-facts-2026.md");
  const disk = fs.readFileSync(path.join(v, w.path), "utf8");
  assert.match(disk, /^---\ntitle: "Marmot Facts: 2026!"\ncreated: \d{4}-.*\nsource: ai-memory\ntags: \[animals, facts\]\n---\n/);
  assert.match(disk, /- \[\[topics\/alpha\]\]\n- \[\[projects\/beta\]\]/);
  assert.equal((fs.statSync(path.join(v, w.path)).mode & 0o777), 0o600);
  const r = m.read(w.path);
  assert.deepEqual(r.tags, ["animals", "facts"]);
  assert.deepEqual(m.search("hibernate").results.map((x) => x.path), [w.path]);
  assert.ok(m.links("topics/alpha.md").backlinks.includes(w.path));
  assert.throws(() => m.write({ title: "marmot facts 2026", content: "replace" }), (e) => e.code === "exists");
  assert.equal(fs.readFileSync(path.join(v, w.path), "utf8"), disk, "existing note untouched");
});

test("write: input validation and limits", () => {
  const v = makeVault();
  const m = new Memory({ root: v, allowWrite: true });
  const bad = (a, re) => assert.throws(() => m.write(a), re);
  bad({ title: "", content: "x" }, /title/);
  bad({ title: "a\nb", content: "x" }, /title/);
  bad({ title: "!!!", content: "x" }, /letters or digits/);
  bad({ title: "ok", content: "" }, /content/);
  bad({ title: "ok", content: "a\0b" }, /content/);
  bad({ title: "ok", content: "x".repeat(LIMITS.maxWriteBytes + 1) }, /content/);
  bad({ title: "ok", content: "x", tags: ["a b"] }, /tags/);
  bad({ title: "ok", content: "x", tags: Array(LIMITS.maxTags + 1).fill("t") }, /tags/);
  bad({ title: "ok", content: "x", tags: ["private"] }, /out of scope/);
  bad({ title: "My Secret plan", content: "x" }, /excludes/);
  bad({ title: "ok", content: "has #password tag" }, /out of scope/);
  bad({ title: "ok", content: "x", links: ["nonexistent"] }, /link target/);
  bad({ title: "ok", content: "x", links: ["secret-diary"] }, /link target/);
  bad({ title: "ok", content: "x", links: Array(LIMITS.maxLinks + 1).fill("alpha") }, /links/);
  assert.deepEqual(fs.readdirSync(path.join(v, "memories")), [], "rejected writes leave nothing behind");
  assert.equal(m.write({ title: "x".repeat(200).slice(0, 100), content: "ok" }).path.length <= "memories/".length + 63, true);
});

test("write: per-session cap and inbox cap", () => {
  const v = makeVault();
  const m = new Memory({ root: v, allowWrite: true });
  for (let i = 0; i < LIMITS.maxWritesPerSession; i++) m.write({ title: `n ${i}`, content: "c" });
  assert.throws(() => m.write({ title: "one more", content: "c" }), (e) => e.code === "limit");
  assert.equal(fs.readdirSync(path.join(v, "memories")).length, LIMITS.maxWritesPerSession);
  const v2 = makeVault();
  for (let i = 0; i < LIMITS.maxInboxNotes; i++) fs.writeFileSync(path.join(v2, "memories", `f${i}.txt`), "");
  assert.throws(() => new Memory({ root: v2, allowWrite: true }).write({ title: "full", content: "c" }), (e) => e.code === "limit");
});

test("write: creates the missing inbox folder only", () => {
  const v = tmp();
  put(v, "topics/a.md", "# A\n");
  const m = new Memory({ root: v, allowWrite: true });
  assert.equal(m.write({ title: "first", content: "hello" }).path, "memories/first.md");
  assert.deepEqual(fs.readdirSync(v).sort(), ["memories", "topics"]);
});

test("root: explicit, local, existing directory", () => {
  assert.throws(() => new Memory({ root: "" }), (e) => e.code === "no_root");
  assert.throws(() => new Memory({ root: "https://example.com/vault" }), (e) => e.code === "bad_root");
  assert.throws(() => new Memory({ root: "/" }), (e) => e.code === "bad_root");
  assert.throws(() => new Memory({ root: path.join(tmp(), "nope") }), (e) => e.code === "bad_root");
  const f = put(tmp(), "file.txt", "x");
  assert.throws(() => new Memory({ root: f }), (e) => e.code === "bad_root");
});
