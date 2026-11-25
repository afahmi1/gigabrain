// Release-gate preflight (first step of `npm test`): the suite must run complete and against this checkout's fresh build.
// Refuses environment settings that shorten or redirect coverage, and refuses a `test` script that dropped a required step.
import fs from "node:fs";
import path from "node:path";
import { render as renderNotices } from "./build-notices.mjs";

const SHORTENING = {
  PA_QUICK: "pixels: quick plan", PA_PLAN: "pixels: reduced view plan", PA_ROOT: "browser: serves another build directory",
  PA_Q: "perf: quality subset", PA_BASELINE_REF: "perf: compares against another baseline than v0.3.0",
  CONTAIN_FAST: "contain: reduced sampling", CONTAIN_FIXTURES: "contain: fixture subset",
};
const REQUIRED = ["npm run typecheck", "npm run build", "npm run test:adapter", "npm run test:cerebellum", "npm run test:contain", "npm run test:browser", "npm run test:pixels -- --full", "npm run test:installer", "npm run test:release"];

const set = Object.keys(SHORTENING).filter((k) => (process.env[k] ?? "") !== "");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const chain = pkg.scripts?.test ?? "", missing = REQUIRED.filter((s) => !chain.split("&&").map((x) => x.trim()).includes(s));

// ---- repository hygiene (fails closed; each finding is printed) ----
const problems = [];
const exists = (f) => fs.existsSync(f);
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
if (manifest.version !== pkg.version) problems.push(`version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
for (const f of ["LICENSE", "NOTICES.md", "README.md", ".gitignore"]) if (!exists(f)) problems.push(`missing ${f}`);
if (exists("LICENSE") && !fs.readFileSync("LICENSE", "utf8").startsWith("MIT License")) problems.push("LICENSE is not the MIT license");
if (exists("NOTICES.md") && fs.readFileSync("NOTICES.md", "utf8") !== renderNotices()) problems.push("NOTICES.md is stale or hand-edited: run `npm run notices`");
// every script file / npm script referenced from package.json exists
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of cmd.matchAll(/\bnode(?:\s+--\S+)*\s+((?:\.\/)?[\w./-]+\.(?:mjs|cjs|js|ts))/g)) if (!exists(m[1]) && !m[1].startsWith("dist-demo/")) problems.push(`script "${name}" references missing file ${m[1]}`);
  for (const m of cmd.matchAll(/\besbuild\s+([\w./-]+\.ts)/g)) if (!exists(m[1])) problems.push(`script "${name}" references missing file ${m[1]}`);
  for (const m of cmd.matchAll(/npm run ([\w:-]+)/g)) if (!(m[1] in pkg.scripts)) problems.push(`script "${name}" runs unknown npm script ${m[1]}`);
}
// Private / machine-specific content must not appear in any source file (this script included: nothing here is skipped).
// 1) Generic patterns, identity-free: home-directory paths, key material, API-key shapes.
// 2) Optional personal denylist: PA_PRIVATE_DENYLIST=<file outside this repo>, one case-insensitive term per line (# comments ok).
//    The terms live only in that file; findings report file and entry number, never the term.
// 3) The public GitHub owner/repo from package.json's repository URL is the one intentional identity: occurrences of exactly
//    github.com/<owner>/<repo> are removed before the denylist runs; the same owner anywhere else is still a finding.
const GENERIC = [
  [/\/(?:Users|home)\/[A-Za-z0-9._-]+\//, "home-directory path"], [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/, "Windows home-directory path"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"], [/\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})/, "API key / token"],
];
const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
const gh = repoUrl.match(/^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
if (!gh) problems.push("package.json repository.url must be a plain https://github.com/<owner>/<repo> URL");
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const publicRepo = gh ? new RegExp(`github\\.com/${esc(gh[1])}/${esc(gh[2])}(?:\\.git)?(?![\\w.-])`, "gi") : null;
let deny = [];
if (process.env.PA_PRIVATE_DENYLIST) {
  const df = path.resolve(process.env.PA_PRIVATE_DENYLIST), root = fs.realpathSync(".");
  if (!fs.existsSync(df)) problems.push("PA_PRIVATE_DENYLIST names a file that does not exist");
  else if ((fs.realpathSync(df) + path.sep).startsWith(root + path.sep)) problems.push("PA_PRIVATE_DENYLIST must point outside the repository");
  else deny = fs.readFileSync(df, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((t) => t.toLowerCase());
}
const SKIP_DIRS = new Set(["node_modules", ".git", "dist-demo", "release", "memory/dist"]), TEXT = /\.(mjs|cjs|js|ts|json|md|css|html|yml|yaml|txt)$|^(LICENSE|\.gitignore|\.gitattributes)$/;
let scanned = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = dir === "." ? e.name : path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(p) && !SKIP_DIRS.has(e.name)) walk(p); continue; }
    if (/(^|\/)(data|diag)\.json$|(^|\/)\.env/.test(p)) { problems.push(`user-data/secret file present: ${p}`); continue; }
    if (p === "package-lock.json" || p === "main.js" || !TEXT.test(e.name)) continue; // main.js: untracked build output, covered by the post-package scan
    scanned++;
    const body = fs.readFileSync(p, "utf8");
    for (const [re, why] of GENERIC) if (re.test(body)) problems.push(`${p}: contains a ${why}`);
    const folded = (publicRepo ? body.replace(publicRepo, "") : body).toLowerCase(), name = p.toLowerCase();
    deny.forEach((t, i) => { if (folded.includes(t) || name.includes(t)) problems.push(`${p}: matches private denylist entry #${i + 1}`); });
  }
})(".");
// relative links and images in README.md / docs/*.md must resolve
const mdFiles = ["README.md", ...(exists("docs") ? fs.readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => path.join("docs", f)) : [])].filter(exists);
for (const f of mdFiles) {
  const body = fs.readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img[^>]+src="([^"]+)"/g)) {
    const t = (m[1] ?? m[2]).split("#")[0];
    if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t)) continue;
    if (!exists(path.join(path.dirname(f), t))) problems.push(`${f}: broken relative link ${t}`);
  }
}
for (const p of problems) console.error(`release guard: ${p}`);

if (set.length || missing.length || problems.length) {
  for (const k of set) console.error(`release guard: refusing ${k}=${process.env[k]} (${SHORTENING[k]})`);
  for (const s of missing) console.error(`release guard: package.json "test" no longer runs \`${s}\``);
  process.exit(1);
}
console.log(`release guard: complete suite (${REQUIRED.length} steps), no shortening environment, hygiene clean (${scanned} source files scanned, ${deny.length} denylist entries, ${mdFiles.length} markdown files link-checked)`);
