"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO, "memory", "dist", "palace-memory.cjs");
const CORE = path.join(REPO, "memory", "dist", "core.cjs");
if (!fs.existsSync(CLI) || !fs.existsSync(CORE)) throw new Error("memory/dist is missing: run `node memory/build.mjs` first");

const tmpRoots = [];
function tmp(prefix = "pm-") {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

function put(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
/** Synthetic vault with in-scope and out-of-scope notes. */
function makeVault() {
  const v = tmp("pm-vault-");
  put(v, "topics/alpha.md", "---\ntitle: Alpha\ntags: [greek]\n---\n# Alpha\n\nThe quick marmot jumps. See [[beta]] and [b](../projects/beta.md).\n");
  put(v, "topics/sub/deep.md", "# Deep note\n\nmarmot in a subfolder\n");
  put(v, "projects/beta.md", "# Beta\n\nBeta links back to [[alpha]].\n");
  put(v, "topics/secret-diary.md", "# Diary\n\nmarmot but excluded by path\n");
  put(v, "topics/flagged.md", "---\nprivate: true\n---\n# Flagged\n\nmarmot private flag\n");
  put(v, "topics/off.md", "---\nmemory: false\n---\n# Off\n\nmarmot memory false\n");
  put(v, "topics/tagged.md", "---\ntags:\n  - confidential\n---\n# Tagged\n\nmarmot confidential tag\n");
  put(v, "topics/inline.md", "# Inline\n\nmarmot with #secret inline tag\n");
  put(v, "topics/broken.md", "---\ntitle: never closed\n# Broken\n\nmarmot unterminated frontmatter\n");
  put(v, "topics/.hidden.md", "# Hidden\n\nmarmot hidden file\n");
  put(v, ".git/topics/x.md", "marmot in hidden dir\n");
  put(v, "topics/.stash/y.md", "marmot in hidden subdir\n");
  put(v, "topics/notes.txt", "marmot not markdown\n");
  put(v, "other/outside.md", "# Outside\n\nmarmot outside configured folders\n");
  put(v, "root-note.md", "marmot at the root\n");
  fs.mkdirSync(path.join(v, "memories"));
  return v;
}
function cli(args, { env = {}, input, cwd } = {}) {
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input, cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}
module.exports = { REPO, CLI, CORE, tmp, put, makeVault, cli };
