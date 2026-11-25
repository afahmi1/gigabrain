"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO, cli, makeVault } = require("./helpers.cjs");

test("cli: help, usage errors, missing root", () => {
  const h = cli(["help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /usage: palace-memory/);
  assert.equal(cli([]).code, 2);
  const u = cli(["--bogus"]);
  assert.equal(u.code, 2);
  assert.match(u.err, /unknown option/);
  const nr = cli(["list"]);
  assert.equal(nr.code, 1);
  assert.match(nr.err, /explicit memory root is required/);
  assert.equal(nr.out, "");
  assert.equal(cli(["--root", makeVault(), "frobnicate"]).code, 2);
  assert.equal(cli(["--root", makeVault(), "read"]).code, 2);
  assert.equal(cli(["--root", makeVault(), "search", "x", "--limit", "abc"]).code, 2);
});

test("cli: scope / list / search / read / links on a synthetic vault", () => {
  const v = makeVault();
  const base = ["--root", v];
  const sc = cli([...base, "scope"]).json();
  assert.equal(sc.writeEnabled, false);
  assert.equal(sc.notes, 3);
  assert.deepEqual(cli([...base, "list", "--folder", "topics"]).json().notes.map((n) => n.path), ["topics/alpha.md", "topics/sub/deep.md"]);
  assert.deepEqual(cli([...base, "search", "quick", "marmot"]).json().results.map((n) => n.path), ["topics/alpha.md"]);
  assert.match(cli([...base, "read", "topics/alpha.md"]).json().content, /quick marmot/);
  assert.deepEqual(cli([...base, "links", "topics/alpha.md"]).json().backlinks, ["projects/beta.md"]);
  const bad = cli([...base, "read", "../x.md"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.out, "");
  assert.ok(!bad.err.includes(v), "errors do not leak absolute paths");
});

test("cli: root from PALACE_MEMORY_ROOT; flag wins over env", () => {
  const v = makeVault(), w = makeVault();
  fs.writeFileSync(path.join(w, "topics", "only-here.md"), "# Only\n");
  assert.equal(cli(["list"], { env: { PALACE_MEMORY_ROOT: v } }).json().notes.length, 3);
  assert.equal(cli(["--root", w, "list"], { env: { PALACE_MEMORY_ROOT: v } }).json().notes.length, 4);
});

test("cli: write is refused by default, works with --allow-write, never overwrites", () => {
  const v = makeVault();
  const refused = cli(["--root", v, "write", "--title", "T", "--content", "c"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /writes are disabled/);
  assert.deepEqual(fs.readdirSync(path.join(v, "memories")), []);
  const ok = cli(["--root", v, "--allow-write", "write", "--title", "From CLI", "--tag", "cli", "--link", "alpha", "--stdin"], { input: "Body from stdin.\n" });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json().path, "memories/from-cli.md");
  assert.match(cli(["--root", v, "read", "memories/from-cli.md"]).json().content, /Body from stdin\./);
  const again = cli(["--root", v, "--allow-write", "write", "--title", "From CLI", "--content", "overwrite?"]);
  assert.equal(again.code, 1);
  assert.match(again.err, /never overwritten/);
  assert.match(fs.readFileSync(path.join(v, "memories/from-cli.md"), "utf8"), /Body from stdin\./);
  assert.equal(cli(["--root", v, "write", "--title", "E"], { env: { PALACE_MEMORY_WRITE: "1" } }).code, 2); // content missing
  assert.equal(cli(["--root", v, "write", "--title", "E", "--content", "via env"], { env: { PALACE_MEMORY_WRITE: "1" } }).code, 0);
});

test("cli: runs the committed example vault (read-only)", () => {
  const ev = path.join(REPO, "example-vault");
  const list = cli(["--root", ev, "list"]).json().notes.map((n) => n.path).sort();
  assert.deepEqual(list, ["memories/welcome.md", "projects/reading-list.md", "topics/active-recall.md", "topics/spaced-repetition.md"]);
  assert.equal(cli(["--root", ev, "read", "topics/secret-plans.md"]).code, 1);
  assert.equal(cli(["--root", ev, "read", "topics/hidden-by-flag.md"]).code, 1);
});
