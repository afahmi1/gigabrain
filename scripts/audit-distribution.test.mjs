// Tests for scripts/audit-distribution.mjs with benign synthetic fixtures. Every "secret" below is a fake string assembled at
// run time so this file itself contains no matchable value. Run: node --test scripts/audit-distribution.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import cp from "node:child_process";
import { fileURLToPath } from "node:url";
import { crc32 } from "./audit-distribution.mjs";

const SCRIPT = fileURLToPath(new URL("./audit-distribution.mjs", import.meta.url));
const J = (...p) => p.join("");
const FAKE = {
  pem: J("-----BEGIN ", "RSA PRIVATE", " KEY-----\nMIIBFAKE\n-----END ", "RSA PRIVATE", " KEY-----"),
  anth: J("sk-", "ant-", "api03-FAKEFAKEFAKEFAKE"),
  gh: J("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
  aws: J("AK", "IA", "ABCDEFGHIJKLMNOP"),
  jwt: J("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiJmYWtlIn0.", "c2lnbmF0dXJlRkFLRQ"),
  assign: J("api", "_key", ' = "', "q9Zx7Lm2Vb4Nc8Rt1Yw6Hp3K", '"'),
  home: J("/Us", "ers/", "jdoe", "/Documents/notes"),
  homeWin: J("C:\\Us", "ers\\", "jdoe", "\\AppData"),
  tmp: J("/private", "/var/", "folders/ab/xyz"),
  email: J("jane.doe", "@", "corp-internal.io"),
  privUrl: J("http://", "10.1.2.3", "/api"),
  urlCred: J("https://", "bob:hunter22pw", "@host.example.org/x"),
  term: J("zork", "mid-", "9"),
};
const tmpDirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "audit-")); tmpDirs.push(d); return d; };
process.on("exit", () => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function zip(entries) { // entries: [{name, data, deflate?, symlink?, encrypted?}]
  const locals = [], cds = []; let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? ""), body = e.deflate ? zlib.deflateRawSync(raw) : raw, name = Buffer.from(e.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.encrypted ? 1 : 0, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE((3 << 8) | 20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.encrypted ? 1 : 0, 8); cd.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(raw), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38); cd.writeUInt32LE(off, 42);
    locals.push(lh, name, body); cds.push(cd, name); off += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(cds), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const CLEAN = [
  { name: "pkg/LICENSE", data: "MIT License\n\nCopyright (c) 2026 Contributors\n" },
  { name: "pkg/NOTICES.md", data: "# Notices\nthree: https://github.com/mrdoob/three.js\nUpstream: Ada Author <" + J("ada", "@", "upstream-lib.dev") + ">\n", deflate: true },
  { name: "pkg/main.js", data: 'console.log("hello"); // see https://developer.mozilla.org/en-US/docs/Web\nconst u="http://127.0.0.1:4173/";\n' + J("/ho", "me/runner/work ", "/Us", "ers/you/vault"), deflate: true },
  { name: "pkg/assets/model.glb", data: Buffer.concat([Buffer.from("glTF\0\0\0\0"), Buffer.from([0, 255, 1, 2, 3])]) },
];
/** Build a release dir. `extra` entries are added to the zip; `files` are bare artifacts; opts tweak sums. */
function release({ extra = [], files = {}, sums = "auto", base = CLEAN } = {}) {
  const dir = mk();
  const all = { "pkg.zip": zip([...base, ...extra]), "LICENSE": "MIT License\n", "NOTICES.md": "# Notices\n", ...files };
  for (const [n, b] of Object.entries(all)) fs.writeFileSync(path.join(dir, n), b);
  if (sums === "auto") fs.writeFileSync(path.join(dir, "SHA256SUMS"), Object.entries(all).map(([n, b]) => `${sha(Buffer.from(b))}  ${n}`).join("\n") + "\n");
  else if (sums !== null) fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums(all));
  return dir;
}
const audit = (dir, args = [], env = {}) => {
  const r = cp.spawnSync(process.execPath, [SCRIPT, "--dir", dir, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  return { code: r.status, all: r.stdout + r.stderr, out: r.stdout, err: r.stderr };
};
const rules = (r) => [...r.all.matchAll(/^(ERROR|WARN)\s+(\S+)/gm)].map((m) => m[2]);

test("negative: clean bundle passes, public URLs / placeholder paths / upstream attribution email are not failures", () => {
  const r = audit(release());
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /PASS \(0 errors, 0 warnings/);
  assert.match(r.out, /developer\.mozilla\.org/);
  assert.match(r.out, /upstream contact emails inside attribution files/);
  assert.match(r.out, /pkg\.zip: 4 entries scanned/);
});

// positive cases: [name, entry data, expected rule]
const POSITIVES = [
  ["private key block", FAKE.pem, "private-key-block"],
  ["anthropic-style key", `x="${FAKE.anth}"`, "anthropic-style-key"],
  ["github token", `t=${FAKE.gh}`, "github-token"],
  ["aws key id", FAKE.aws, "aws-access-key-id"],
  ["jwt", FAKE.jwt, "jwt"],
  ["secret assignment", FAKE.assign, "secret-assignment"],
  ["unix home path", FAKE.home, "local-user-path"],
  ["windows home path", FAKE.homeWin, "local-user-path"],
  ["temp path", FAKE.tmp, "local-temp-path"],
  ["non-public email outside attribution", `contact ${FAKE.email}`, "non-public-email"],
  ["private-network URL", FAKE.privUrl, "private-network-host"],
  ["credentials in URL", FAKE.urlCred, "url-credentials"],
  ["secret query string", J("https://api.example.org/x?tok", "en=abcdefgh12345678"), "url-secret-query"],
];
for (const [name, data, rule] of POSITIVES) {
  for (const deflate of [false, true]) test(`positive: ${name} in ${deflate ? "deflated" : "stored"} zip entry is flagged, value never printed`, () => {
    const r = audit(release({ extra: [{ name: "pkg/src/leak.txt", data: `line one\n${data}\n`, deflate }] }));
    assert.equal(r.code, 1, r.all);
    assert.ok(rules(r).includes(rule), `${rule} in ${rules(r)}`);
    assert.match(r.all, /leak\.txt  \(line 2/);
    for (const frag of [data.split(/\s+/).pop(), data.replace(/^.*?([A-Za-z0-9_-]{12,}).*$/s, "$1")]) assert.ok(!r.all.includes(frag), "matched text leaked into output");
  });
}

test("positive: binary asset with embedded path and secret is flagged byte-wise", () => {
  const bin = Buffer.concat([Buffer.from([0, 1, 2, 255, 254]), Buffer.from(FAKE.home), Buffer.from([0, 0]), Buffer.from(FAKE.aws), Buffer.from([9, 9])]);
  const r = audit(release({ files: { "brain.bin": bin } }));
  assert.equal(r.code, 1);
  assert.ok(rules(r).includes("local-user-path") && rules(r).includes("aws-access-key-id"));
  assert.match(r.all, /brain\.bin/);
  assert.ok(!r.all.includes("jdoe"));
});

test("positive: bare .cjs file and nested zip are scanned", () => {
  const inner = zip([{ name: "x.txt", data: FAKE.home }]);
  const r = audit(release({ files: { "tool.cjs": `#!/usr/bin/env node\n// MIT License\nvar p="${FAKE.homeWin.replace(/\\/g, "\\\\")}";` }, extra: [{ name: "pkg/inner.zip", data: inner }] }));
  assert.equal(r.code, 1);
  assert.match(r.all, /tool\.cjs/);
  assert.match(r.all, /inner\.zip!x\.txt/);
});

test("denylist from env: terms and regexes flagged by line number only; names too; value and file path never printed", () => {
  const dl = path.join(mk(), "deny.txt");
  fs.writeFileSync(dl, `# comment\n\n${FAKE.term}\nre:proj[-_]?${J("ba", "lloon")}\n`);
  const dir = release({ extra: [{ name: `pkg/${FAKE.term}-notes.md`, data: `see ${FAKE.term.toUpperCase()} and proj_${J("ba", "lloon")}` }] });
  const r = audit(dir, [], { PALACE_AUDIT_DENYLIST: dl });
  assert.equal(r.code, 1);
  assert.ok(rules(r).includes("denylist-term") && rules(r).includes("denylist-term-in-name"));
  assert.match(r.all, /denylist line 3\b/);
  assert.match(r.all, /denylist line 4\b/);
  assert.match(r.all, /external denylist applied/);
  for (const secret of [FAKE.term, J("ba", "lloon"), dl]) assert.ok(!r.all.toLowerCase().includes(secret.toLowerCase()), "denylist content leaked");
  // flag form works the same, and the clean bundle passes with a denylist present
  assert.equal(audit(dir, ["--denylist", dl]).code, 1);
  assert.equal(audit(release(), ["--denylist", dl]).code, 0);
});

test("denylist named but unreadable / empty fails closed with exit 2", () => {
  assert.equal(audit(release(), [], { PALACE_AUDIT_DENYLIST: "/nonexistent/deny.txt" }).code, 2);
  const empty = path.join(mk(), "e.txt"); fs.writeFileSync(empty, "# nothing\n");
  assert.equal(audit(release(), ["--denylist", empty]).code, 2);
  const bad = path.join(mk(), "b.txt"); fs.writeFileSync(bad, "re:(unclosed\n");
  const r = audit(release(), ["--denylist", bad]);
  assert.equal(r.code, 2);
  assert.ok(!r.all.includes("unclosed"));
});

test("SHA256SUMS: mismatch, unlisted artifact, missing artifact, missing file, malformed line", () => {
  const good = release();
  fs.appendFileSync(path.join(good, "NOTICES.md"), "tampered");
  assert.ok(rules(audit(good)).includes("sha256-mismatch"));
  const unlisted = release(); fs.writeFileSync(path.join(unlisted, "extra.txt"), "x");
  assert.ok(rules(audit(unlisted)).includes("artifact-not-in-sha256sums"));
  const missing = release(); fs.rmSync(path.join(missing, "LICENSE"));
  assert.ok(rules(audit(missing)).includes("listed-artifact-missing"));
  assert.ok(rules(audit(release({ sums: null }))).includes("sha256sums-missing"));
  const mal = release({ sums: (all) => `nothex  pkg.zip\n${sha(Buffer.from(all.LICENSE))}  ../LICENSE\n` });
  assert.ok(rules(audit(mal)).filter((x) => x === "sha256sums-malformed-line").length === 2);
  assert.equal(audit(path.join(mk(), "nope")).code, 2);
});

test("zip structure: zip-slip, absolute, symlink, encrypted, duplicate, forbidden and hidden files", () => {
  const cases = [
    [{ name: "../escape.txt", data: "x" }, "zip-slip-name"],
    [{ name: "/abs.txt", data: "x" }, "zip-slip-name"],
    [{ name: "pkg/link", data: "target", symlink: true }, "zip-symlink-entry"],
    [{ name: "pkg/enc.bin", data: "x", encrypted: true }, "zip-encrypted-entry"],
    [{ name: "pkg/main.js", data: "dup" }, "zip-duplicate-entry"],
    [{ name: "pkg/data.json", data: "{}" }, "forbidden-file"],
    [{ name: "pkg/.env", data: "A=1" }, "forbidden-file"],
    [{ name: "pkg/main.js.map", data: "{}" }, "forbidden-file"],
    [{ name: "pkg/.hidden/readme.txt", data: "x" }, "hidden-entry"],
  ];
  for (const [entry, rule] of cases) { const r = audit(release({ extra: [entry] })); assert.ok(rules(r).includes(rule), `${rule}: ${rules(r)}`); }
  assert.equal(audit(release({ extra: [{ name: "pkg/.hidden/readme.txt", data: "x" }] })).code, 0, "hidden entry alone is only a warning");
  assert.equal(audit(release({ extra: [{ name: "pkg/.hidden/readme.txt", data: "x" }] }), ["--strict"]).code, 1);
  const corrupt = zip(CLEAN); corrupt[corrupt.indexOf(Buffer.from("MIT License"))] ^= 1; // flip a byte inside a stored entry
  assert.ok(rules(audit(release({ files: { "pkg.zip": corrupt } }))).includes("zip-crc-or-size-mismatch"));
  assert.ok(rules(audit(release({ files: { "bad.zip": Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)]) } }))).includes("zip-malformed"));
});

test("attribution: zip without LICENSE/NOTICES fails; bare script without licence beside it warns", () => {
  const r = audit(release({ base: [{ name: "pkg/main.js", data: "1" }] }));
  assert.equal(rules(r).filter((x) => x === "attribution-missing-in-zip").length, 2);
  const dir = release({ files: { "tool.cjs": "var a=1;" } });
  fs.rmSync(path.join(dir, "LICENSE")); fs.writeFileSync(path.join(dir, "SHA256SUMS"), fs.readdirSync(dir).filter((f) => f !== "SHA256SUMS").map((f) => `${sha(fs.readFileSync(path.join(dir, f)))}  ${f}`).join("\n") + "\n");
  const w = audit(dir);
  assert.ok(rules(w).includes("attribution-missing-for-bare-script"));
  assert.equal(w.code, 0, "warning only");
});

test("--json report is valid and carries no matched text; --sources scans a tree", () => {
  const dir = release({ extra: [{ name: "pkg/leak.txt", data: FAKE.aws }] });
  const r = audit(dir, ["--json"]);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.ok(j.findings.some((f) => f.rule === "aws-access-key-id" && f.where.endsWith("leak.txt")));
  assert.ok(!r.all.includes(FAKE.aws));
  const src = mk();
  fs.mkdirSync(path.join(src, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules/x/i.js"), FAKE.aws); // skipped
  fs.writeFileSync(path.join(src, "ok.ts"), "export const a = 1;\n");
  assert.equal(audit(release(), ["--sources", src]).code, 0);
  fs.writeFileSync(path.join(src, "notes.md"), `path ${FAKE.home}\n`);
  const s = audit(release(), ["--sources", src]);
  assert.equal(s.code, 1);
  assert.match(s.all, /src:notes\.md/);
  assert.ok(!s.all.includes("jdoe"));
  fs.writeFileSync(path.join(src, ".env"), "A=1");
  assert.ok(rules(audit(release(), ["--sources", src])).includes("forbidden-file"));
});

test("usage errors exit 2; help exits 0", () => {
  assert.equal(cp.spawnSync(process.execPath, [SCRIPT, "--bogus"]).status, 2);
  assert.equal(cp.spawnSync(process.execPath, [SCRIPT, "--help"]).status, 0);
});

test("this script and its test contain no matchable secret/path literals (self-audit)", () => {
  const d = mk();
  for (const f of ["audit-distribution.mjs", "audit-distribution.test.mjs"]) fs.copyFileSync(path.join(path.dirname(SCRIPT), f), path.join(d, f));
  // sources scan skips the script itself by design, so copy under other names to prove the literals are clean
  fs.renameSync(path.join(d, "audit-distribution.mjs"), path.join(d, "copy-a.mjs")); fs.renameSync(path.join(d, "audit-distribution.test.mjs"), path.join(d, "copy-b.mjs"));
  const r = audit(release(), ["--sources", d]);
  assert.equal(r.code, 0, r.all);
});
