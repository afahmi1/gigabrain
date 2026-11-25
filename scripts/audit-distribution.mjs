#!/usr/bin/env node
// Post-packaging distribution audit. Run AFTER `npm run package`; it does not build, publish, upload or touch git.
//
//   node scripts/audit-distribution.mjs [--dir release] [--sources [DIR]] [--denylist FILE] [--strict] [--json] [--quiet]
//
//   --dir DIR        release folder holding SHA256SUMS + artifacts (default: release)
//   --sources [DIR]  also scan source files under DIR (default: repo root; skips node_modules, build output, .git)
//   --denylist FILE  extra private terms, one per line ("#" comments; prefix "re:" for a regular expression, case-insensitive).
//                    Also read from env PALACE_AUDIT_DENYLIST. The file stays OUT of the repository; no term appears in
//                    this tracked source. A named but unreadable denylist is a hard error (fail closed).
//   --strict         warnings also fail the run
//   --json           machine-readable report on stdout
//
// Checks: SHA256SUMS matches every artifact and lists nothing missing/extra; zip structure (zip-slip, symlinks, encrypted,
// CRC, size bombs, forbidden files); every decompressed entry, bare .cjs/.js, assets (binary included, byte-wise) and
// optionally sources are scanned for secrets, local/host paths, non-public emails, private-network URLs and denylist terms.
// Findings carry rule + file + position + count and NEVER the matched text. Public URLs and OSS attribution are reported as
// "info" and do not fail. Exit status: 0 clean, 1 findings, 2 usage/environment error.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ rules (generic only; assembled so this file never matches itself)
const J = (...p) => p.join("");
const SECRET_RULES = [
  ["private-key-block", new RegExp(J("-----BEGIN ", "(?:[A-Z0-9]+ )*", "PRIVATE KEY", "(?: BLOCK)?-----"))],
  ["anthropic-style-key", new RegExp(J("sk-", "ant-", "[A-Za-z0-9_-]{8,}"))],
  ["openai-style-key", new RegExp(J("\\bsk-", "(?:proj-)?[A-Za-z0-9_-]{32,}"))],
  ["github-token", new RegExp(J("\\bgh[pousr]_", "[A-Za-z0-9]{30,}"))],
  ["github-fine-grained-token", new RegExp(J("\\bgithub_", "pat_[A-Za-z0-9_]{40,}"))],
  ["aws-access-key-id", new RegExp(J("\\b(?:AKIA|ASIA)", "[0-9A-Z]{16}\\b"))],
  ["slack-token", new RegExp(J("\\bxox[baprs]-", "[A-Za-z0-9-]{10,}"))],
  ["google-api-key", new RegExp(J("\\bAIza", "[0-9A-Za-z_-]{35}"))],
  ["npm-token", new RegExp(J("\\bnpm_", "[A-Za-z0-9]{36}\\b"))],
  ["jwt", new RegExp(J("\\beyJ[A-Za-z0-9_-]{10,}\\.", "eyJ[A-Za-z0-9_-]{10,}\\.", "[A-Za-z0-9_-]{10,}"))],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`<>]{1,64}:[^\s/@"'`<>]{3,128}@[A-Za-z0-9.-]+/i],
];
// quoted high-entropy value assigned to a secret-looking name
const ASSIGN = /\b(?:api[_-]?key|secret|passw(?:or)?d|auth[_-]?token|access[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9+/_=-]{20,})["']/gi;
const HOME_PATH = [
  /\/Users\/([A-Za-z0-9._-]{1,64})(?=\/)/g, /\/home\/([A-Za-z0-9._-]{1,64})(?=\/)/g,
  /[A-Za-z]:\\+Users\\+([A-Za-z0-9._ -]{1,64}?)(?=\\)/g, /\/private\/var\/folders\/()/g, /\/var\/folders\/[a-z0-9_]{2}\/()/g,
];
const PLACEHOLDER_USERS = new Set(["", "you", "user", "username", "name", "me", "example", "yourname", "your-name", "shared", "runner", "default", "public", "<user>", "x", "foo", "alice", "bob", "test", "tmp"]);
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![A-Za-z0-9])/g;
const PUBLIC_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|invalid|test|localhost|local|users\.noreply\.github\.com|noreply\.github\.com)$/i;
const URL_RE = /\bhttps?:\/\/[^\s"'`<>)\]\\}]+/gi;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|[^.]+$|.*\.(local|internal|lan|corp|home|intranet)$)/i;
const SECRET_QUERY = /[?&](?:token|access_token|api_?key|key|secret|password|auth|sig|signature)=[^&\s]{8,}/i;
// public documentation / registry / upstream hosts that legitimately appear in OSS attribution and docs
const KNOWN_PUBLIC = /(^|\.)(github\.com|githubusercontent\.com|npmjs\.org|npmjs\.com|nodejs\.org|doi\.org|creativecommons\.org|apache\.org|opensource\.org|spdx\.org|w3\.org|whatwg\.org|json-schema\.org|mozilla\.org|khronos\.org|modelcontextprotocol\.io|obsidian\.md|d3js\.org|mathworks\.com|wikipedia\.org|github\.io|example\.(com|org|net)|ietf\.org|rfc-editor\.org|unpkg\.com|jsdelivr\.net|stackoverflow\.com|developer\.mozilla\.org|zod\.dev|colinhacks\.com|threejs\.org|anthropic\.com|claude\.ai|cursor\.com|openai\.com)$/i;
const FORBIDDEN_NAME = /^(data\.json|diag\.json|\.env(\..*)?|\.npmrc|\.netrc|\.DS_Store|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|map|log|tsbuildinfo))$/i;
const ATTRIBUTION_FILE = /(^|\/)(LICEN[CS]E[^/]*|NOTICES?(\.md|\.txt)?|COPYING|AUTHORS|THIRD[-_]?PARTY[^/]*|LICENSES\.md|package\.json|package-lock\.json)$/i;

const LIMITS = { entries: 5000, entryBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, maxFileScan: 160 * 1024 * 1024, perRuleFileCap: 5, zipDepth: 2 };
const SOURCE_SKIP_DIRS = new Set(["node_modules", ".git", "dist-demo", "release", "dist", "coverage", ".claude"]);
const SOURCE_SKIP_FILES = new Set(["package-lock.json"]); // registry URLs and integrity hashes only
const SCANNABLE_SOURCE = /\.(mjs|cjs|js|ts|tsx|json|md|css|html|yml|yaml|toml|txt|svg|glb|bin|sh)$|^(LICENSE|NOTICES|\.gitignore|\.gitattributes)$/i;

// ------------------------------------------------------------------ report
class Report {
  constructor() { this.findings = []; this.info = { checked: [], hosts: new Map(), attribution: [] }; }
  add(severity, rule, where, extra = {}) { this.findings.push({ severity, rule, where, ...extra }); }
  host(h, where) { const set = this.info.hosts.get(h) ?? new Set(); set.add(where); this.info.hosts.set(h, set); }
}

// ------------------------------------------------------------------ denylist (private terms live outside the repo)
export function loadDenylist(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { throw new UsageError("denylist file named but not readable (refusing to continue without it)"); }
  const entries = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      if (line.startsWith("re:")) entries.push({ n: i + 1, re: new RegExp(line.slice(3), "gi") });
      else entries.push({ n: i + 1, re: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") });
    } catch { throw new UsageError(`denylist line ${i + 1} is not a valid pattern`); }
  });
  if (!entries.length) throw new UsageError("denylist has no entries");
  return entries;
}
class UsageError extends Error {}

// ------------------------------------------------------------------ content scanning
const entropy = (s) => { const f = {}; for (const c of s) f[c] = (f[c] ?? 0) + 1; return -Object.values(f).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0); };
// a URL inside a code comment / doc line is upstream attribution or reference, not behaviour
const inComment = (text, off) => { const pre = text.slice(text.lastIndexOf("\n", off - 1) + 1, off); return /^\s*(\/\/|\/\*|\*|#|<!--)/.test(pre) || /(^|\s)\/\/\s/.test(pre); };
const lineOf = (text, off) => { let n = 1; for (let i = text.indexOf("\n"); i >= 0 && i < off; i = text.indexOf("\n", i + 1)) n++; return n; };

/** Scan raw bytes. `text` is a latin1 view so binary and UTF-8 files are both matched byte-for-byte. */
export function scanBytes(buf, where, rep, opts = {}) {
  const text = buf.toString("latin1");
  const caps = new Map();
  const hit = (severity, rule, off, extra) => {
    const k = rule; const c = (caps.get(k) ?? 0) + 1; caps.set(k, c);
    if (c <= LIMITS.perRuleFileCap) rep.add(severity, rule, where, { line: lineOf(text, off), offset: off, ...extra });
  };
  for (const [rule, re] of SECRET_RULES) { const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"); for (const m of text.matchAll(g)) hit("error", rule, m.index); }
  for (const m of text.matchAll(ASSIGN)) if (entropy(m[1]) >= 3.6) hit("error", "secret-assignment", m.index);
  for (const re of HOME_PATH) for (const m of text.matchAll(re)) if (!PLACEHOLDER_USERS.has((m[1] ?? "").toLowerCase().trim())) hit("error", "local-user-path", m.index);
  for (const m of text.matchAll(/\/private\/var\/folders\/|\/var\/folders\/[a-z0-9_]{2}\//g)) hit("error", "local-temp-path", m.index);
  for (const m of text.matchAll(EMAIL)) {
    const dom = m[0].slice(m[0].lastIndexOf("@") + 1);
    if (PUBLIC_EMAIL_DOMAIN.test(dom)) continue;
    if (opts.attribution) rep.info.attribution.push(where); // upstream author contact inside licence/notice text
    else hit("error", "non-public-email", m.index);
  }
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { host = (/^https?:\/\/([^/:?#]+)/i.exec(url)?.[1] ?? "").toLowerCase(); }
    if (SECRET_QUERY.test(url)) hit("error", "url-secret-query", m.index);
    if (!host) continue;
    if (PRIVATE_HOST.test(host) && !/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host) && !/^[a-z]$/.test(host) && host.includes(".")) hit("error", "private-network-host", m.index);
    else if (/^(localhost|127\.0\.0\.1)$/.test(host)) rep.host("loopback:" + host, where);
    else if (host.includes(".")) { rep.host(host, where); if (!KNOWN_PUBLIC.test(host) && !inComment(text, m.index)) hit("warn", "unrecognised-host", m.index); }
  }
  if (opts.denylist) for (const d of opts.denylist) { d.re.lastIndex = 0; for (const m of text.matchAll(d.re)) { hit("error", "denylist-term", m.index, { entry: d.n }); if (!m[0].length) break; } }
  for (const [rule, c] of caps) if (c > LIMITS.perRuleFileCap) rep.add("note", "more-matches", where, { of: rule, total: c });
}
function scanName(name, where, rep, opts) {
  const base = name.split("/").pop();
  if (FORBIDDEN_NAME.test(base)) rep.add("error", "forbidden-file", where);
  if (opts.denylist) for (const d of opts.denylist) { d.re.lastIndex = 0; if (d.re.test(name)) rep.add("error", "denylist-term-in-name", where, { entry: d.n }); }
}

// ------------------------------------------------------------------ zip reader (stored + deflate; no dependencies)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export const isZip = (b) => b.length >= 22 && b.readUInt32LE(0) === 0x04034b50;

export function readZip(buf, rep, where) {
  const out = [];
  const bad = (rule, extra) => rep.add("error", rule, where, extra);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { bad("zip-malformed", { why: "no end-of-central-directory record" }); return out; }
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) { bad("zip-unsupported", { why: "zip64" }); return out; }
  if (count > LIMITS.entries) { bad("zip-limit", { why: "too many entries" }); return out; }
  let p = cdOff, total = 0; const seen = new Set();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) { bad("zip-malformed", { why: "bad central directory" }); return out; }
    const madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    p += 46 + nl + el + cl;
    const ew = `${where}!${name}`;
    if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) { bad("zip-slip-name", { entry: i }); continue; }
    if (seen.has(name)) { bad("zip-duplicate-entry", { entry: i }); continue; } seen.add(name);
    if (name.endsWith("/")) continue;
    if ((madeBy >> 8) === 3 && ((ext >>> 16) & 0o170000) === 0o120000) { rep.add("error", "zip-symlink-entry", ew); continue; }
    if (flags & 1) { rep.add("error", "zip-encrypted-entry", ew); continue; }
    if (name.split("/").some((s) => s.startsWith(".") || s === "__MACOSX")) rep.add("warn", "hidden-entry", ew);
    if (usize > LIMITS.entryBytes || (total += usize) > LIMITS.totalBytes) { rep.add("error", "zip-limit", ew, { why: "uncompressed size" }); continue; }
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) { rep.add("error", "zip-malformed", ew, { why: "bad local header" }); continue; }
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(ds, ds + csize);
    let data;
    try { data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.entryBytes }) : null; } catch { data = null; }
    if (!data) { rep.add("error", "zip-undecodable-entry", ew, { method }); continue; }
    if (data.length !== usize || crc32(data) !== crc) { rep.add("error", "zip-crc-or-size-mismatch", ew); continue; }
    out.push({ name, data });
  }
  return out;
}

function scanArtifactBytes(buf, where, rep, opts, depth = 0) {
  scanName(where.split("!").pop(), where, rep, opts);
  if (isZip(buf)) {
    if (depth >= LIMITS.zipDepth) { rep.add("warn", "nested-zip-not-scanned", where); return; }
    const entries = readZip(buf, rep, where);
    for (const e of entries) {
      const ew = `${where}!${e.name}`;
      if (isZip(e.data)) scanArtifactBytes(e.data, ew, rep, opts, depth + 1);
      else { scanName(e.name, ew, rep, opts); scanBytes(e.data, ew, rep, { ...opts, attribution: ATTRIBUTION_FILE.test(e.name) }); }
    }
    return entries;
  }
  scanBytes(buf, where, rep, { ...opts, attribution: ATTRIBUTION_FILE.test(where) });
  return null;
}

// ------------------------------------------------------------------ distribution
export function auditDistribution(dir, rep, opts = {}) {
  const sumsFile = path.join(dir, "SHA256SUMS");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`release directory not found: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => f !== "SHA256SUMS").sort();
  if (!fs.existsSync(sumsFile)) rep.add("error", "sha256sums-missing", "SHA256SUMS");
  const listed = new Map();
  if (fs.existsSync(sumsFile)) {
    fs.readFileSync(sumsFile, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      const m = /^([0-9a-f]{64}) [ *]([^/\\\0]+)$/i.exec(line);
      if (!m || m[2] === "." || m[2] === "..") { rep.add("error", "sha256sums-malformed-line", "SHA256SUMS", { line: i + 1 }); return; }
      if (listed.has(m[2])) rep.add("error", "sha256sums-duplicate", "SHA256SUMS", { line: i + 1 });
      listed.set(m[2], m[1].toLowerCase());
    });
  }
  for (const f of files) if (!listed.has(f)) rep.add("error", "artifact-not-in-sha256sums", f);
  for (const f of listed.keys()) if (!files.includes(f)) rep.add("error", "listed-artifact-missing", f);
  const zipNames = [];
  const dirHasNotice = files.some((f) => /^(NOTICES?(\.md|\.txt)?|THIRD[-_]?PARTY.*)$/i.test(f)) && files.some((f) => /^LICEN[CS]E/i.test(f));
  for (const f of files) {
    const full = path.join(dir, f);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile()) { rep.add("error", "artifact-not-regular-file", f); continue; }
    if (st.size > LIMITS.maxFileScan) { rep.add("error", "artifact-too-large-to-scan", f); continue; }
    const buf = fs.readFileSync(full);
    if (listed.has(f) && crypto.createHash("sha256").update(buf).digest("hex") !== listed.get(f)) rep.add("error", "sha256-mismatch", f);
    else if (listed.has(f)) rep.info.checked.push(`${f}: sha256 ok`);
    const entries = scanArtifactBytes(buf, f, rep, opts);
    if (entries) {
      zipNames.push(f);
      const names = entries.map((e) => e.name);
      for (const need of [/(^|\/)LICEN[CS]E[^/]*$/i, /(^|\/)NOTICES?(\.md|\.txt)?$/i]) if (!names.some((n) => need.test(n))) rep.add("error", "attribution-missing-in-zip", f, { need: need.source.includes("LICEN") ? "LICENSE" : "NOTICES" });
      rep.info.checked.push(`${f}: ${entries.length} entries scanned`);
    } else {
      if (/\.(cjs|mjs|js)$/.test(f) && !dirHasNotice && !/\b(MIT License|Apache License|SPDX-License-Identifier)\b/.test(buf.subarray(0, 4096).toString("latin1"))) rep.add("warn", "attribution-missing-for-bare-script", f, { why: "bundled OSS code ships without LICENSE/NOTICES beside it or a licence banner" });
      rep.info.checked.push(`${f}: scanned as file`);
    }
  }
  return zipNames;
}

// ------------------------------------------------------------------ sources
export function auditSources(root, rep, opts = {}) {
  const self = path.resolve(fileURLToPath(import.meta.url));
  let n = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isSymbolicLink()) { rep.add("warn", "source-symlink-skipped", rel); continue; }
      if (e.isDirectory()) { if (!SOURCE_SKIP_DIRS.has(e.name) && !rel.startsWith("memory/dist")) walk(full); continue; }
      if (!e.isFile()) continue;
      if (e.name === "main.js" && dir === root) continue; // build output, covered via the release artifacts
      if (path.resolve(full) === self || SOURCE_SKIP_FILES.has(e.name)) continue;
      scanName(rel, `src:${rel}`, rep, opts);
      if (!SCANNABLE_SOURCE.test(e.name) || FORBIDDEN_NAME.test(e.name)) continue;
      const st = fs.statSync(full); if (st.size > LIMITS.maxFileScan) { rep.add("warn", "source-too-large-to-scan", rel); continue; }
      scanBytes(fs.readFileSync(full), `src:${rel}`, rep, { ...opts, attribution: ATTRIBUTION_FILE.test(rel) }); n++;
    }
  })(root);
  rep.info.checked.push(`sources: ${n} files scanned under ${path.basename(root)}`);
}

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const o = { dir: "release", sources: null, denylist: process.env.PALACE_AUDIT_DENYLIST || null, strict: false, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); return argv[++i]; };
    if (a === "--dir") o.dir = next();
    else if (a === "--denylist") o.denylist = next();
    else if (a === "--sources") o.sources = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : ".";
    else if (a === "--strict") o.strict = true;
    else if (a === "--json") o.json = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new UsageError(`unknown option ${a}`);
  }
  return o;
}
const USAGE = "usage: node scripts/audit-distribution.mjs [--dir release] [--sources [DIR]] [--denylist FILE] [--strict] [--json] [--quiet]\n(env PALACE_AUDIT_DENYLIST=FILE supplies private terms; matched text is never printed)";

export function run(argv) {
  const o = parseArgs(argv);
  if (o.help) return { code: 0, text: USAGE };
  const rep = new Report();
  const opts = { denylist: o.denylist ? loadDenylist(o.denylist) : null };
  // file/entry names can themselves contain a private term: redact them in every line we print
  const redact = (t) => opts.denylist ? opts.denylist.reduce((a, d) => a.replace(new RegExp(d.re.source, d.re.flags.includes("g") ? d.re.flags : d.re.flags + "g"), "[denylisted]"), t) : t;
  auditDistribution(path.resolve(o.dir), rep, opts);
  if (o.sources !== null) auditSources(path.resolve(o.sources), rep, opts);
  const errors = rep.findings.filter((f) => f.severity === "error"), warns = rep.findings.filter((f) => f.severity === "warn");
  const failed = errors.length > 0 || (o.strict && warns.length > 0);
  const hosts = [...rep.info.hosts].map(([h, w]) => ({ host: h, files: w.size })).sort((a, b) => a.host.localeCompare(b.host));
  const attribution = [...new Set(rep.info.attribution)];
  if (o.json) return { code: failed ? 1 : 0, text: redact(JSON.stringify({ ok: !failed, denylist: !!o.denylist, errors: errors.length, warnings: warns.length, findings: rep.findings, info: { checked: rep.info.checked, publicHosts: hosts, attributionFilesWithContactEmails: attribution } }, null, 2)) };
  const L = [];
  for (const f of rep.findings) {
    const pos = [f.line != null ? `line ${f.line}` : null, f.offset != null ? `byte ${f.offset}` : null, f.entry != null ? `denylist line ${f.entry}` : null, f.why, f.need ? `need ${f.need}` : null, f.of ? `${f.of} x${f.total}` : null].filter(Boolean).join(", ");
    L.push(`${f.severity.toUpperCase().padEnd(5)} ${f.rule}  ${f.where}${pos ? `  (${pos})` : ""}`);
  }
  if (!o.quiet) {
    L.push("", ...rep.info.checked.map((c) => `ok    ${c}`));
    if (hosts.length) L.push(`info  public/loopback URL hosts referenced (not failures): ${hosts.map((h) => h.host).join(", ")}`);
    if (attribution.length) L.push(`info  upstream contact emails inside attribution files (not failures): ${attribution.join(", ")}`);
  }
  L.push(`audit-distribution: ${failed ? "FAIL" : "PASS"} (${errors.length} errors, ${warns.length} warnings${o.denylist ? ", external denylist applied" : ", no external denylist"})`);
  return { code: failed ? 1 : 0, text: redact(L.join("\n")) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { const r = run(process.argv.slice(2)); (r.code && !process.argv.includes("--json") ? console.error : console.log)(r.text); process.exitCode = r.code; }
  catch (e) { console.error(`audit-distribution: ${e instanceof UsageError ? e.message : "internal error"}\n${USAGE}`); process.exitCode = 2; }
}
