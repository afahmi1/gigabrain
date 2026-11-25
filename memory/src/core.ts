// Palace Atlas memory core: a bounded, local-only, symlink-refusing view of a Markdown vault.
// Scope rules come from ../../src/scope.ts (shared with the Obsidian plugin). Nothing here touches the network.
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE, ScopeConfig, ScopeError, parseScopeConfig, pathInScope, isAllowed, hasExcludedTerm, NoteMeta } from "../../src/scope";

export { ScopeError };

/** Hard limits. Every one is enforced in code and covered by tests; docs/connect.md lists them. */
export const LIMITS = {
  maxFileBytes: 256 * 1024, // notes larger than this are skipped / refused
  maxFiles: 5000, // in-scope candidate files scanned per call
  maxTotalBytes: 64 * 1024 * 1024, // total text read per scan
  maxDepth: 6, // folder depth below a configured top-level folder
  maxReadChars: 64_000, // characters returned by a read (longer is truncated, flagged)
  maxSearchResults: 50,
  defaultSearchResults: 10,
  maxQueryChars: 200,
  maxQueryTerms: 8,
  maxPathChars: 300,
  maxWriteBytes: 20_000, // note body
  maxTitleChars: 120,
  maxTags: 8,
  maxLinks: 20,
  maxWritesPerSession: 25, // new notes per server/CLI process
  maxInboxNotes: 1000, // notes the inbox folder may hold before writes are refused
} as const;

export class MemoryError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const NOT_FOUND = () => new MemoryError("not_found", "note not found, or not readable inside the memory scope");

export interface Options { root: string; allowWrite?: boolean; }
export interface NoteInfo { path: string; title: string; tags: string[]; bytes: number; modified: string }
interface Loaded extends NoteInfo { text: string }

// ---------- parsing ----------
interface Parsed { fm: Record<string, unknown> | null; body: string; ok: boolean }

export function parseNote(raw: string): Parsed {
  const text = raw.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*\r?\n/.test(text)) return { fm: null, body: text, ok: true };
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) { end = i; break; }
  if (end < 0) return { fm: null, body: text, ok: false }; // unterminated frontmatter: fail closed
  const fm: Record<string, unknown> = {};
  let cur: string | null = null;
  const push = (k: string, v: string) => {
    const prev = fm[k];
    fm[k] = prev === undefined ? [v] : Array.isArray(prev) ? [...prev, v] : [prev, v];
  };
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      cur = m[1];
      const v = m[2].trim();
      if (v === "") fm[cur] = [];
      else if (/^\[.*\]$/.test(v)) fm[cur] = v.slice(1, -1).split(",").map((s) => unq(s)).filter(Boolean);
      else fm[cur] = unq(v);
    } else if (cur) {
      // list items and any nested/continuation text are folded into the current key so exclusion terms still match
      const item = line.trim().replace(/^-\s*/, "");
      if (item) push(cur, unq(item));
    }
  }
  return { fm, body: lines.slice(end + 1).join("\n"), ok: true };
}
function unq(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

const INLINE_TAG = /(^|[\s(])#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
function inlineTags(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(INLINE_TAG)) out.push(m[2]);
  return out;
}
function fmTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const out: string[] = [];
  for (const k of Object.keys(fm)) if (k.toLowerCase() === "tags" || k.toLowerCase() === "tag") {
    const v = fm[k];
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string") for (const t of x.split(/[,\s]+/)) if (t) out.push(t.replace(/^#/, ""));
  }
  return out;
}
function metaOf(p: Parsed): NoteMeta | null {
  if (!p.ok) return null;
  return { tags: inlineTags(p.body), fm: p.fm };
}
function titleOf(rel: string, p: Parsed): string {
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(p.body);
  if (h) return h[1].slice(0, 200);
  const t = p.fm && typeof p.fm.title === "string" ? p.fm.title : "";
  return (t || path.posix.basename(rel, path.posix.extname(rel))).slice(0, 200);
}

// ---------- the vault ----------
export class Memory {
  readonly root: string;
  readonly allowWrite: boolean;
  readonly cfg: ScopeConfig;
  private writes = 0;

  constructor(opts: Options) {
    this.allowWrite = !!opts.allowWrite;
    this.root = resolveRoot(opts.root);
    this.cfg = readConfig(this.root);
  }

  // --- reading
  /** Walk the configured folders and return allowed notes. Never follows symlinks, skips hidden/excluded/oversized. */
  private scan(withText: boolean): { notes: Loaded[]; truncated: boolean } {
    const out: Loaded[] = [];
    let files = 0, total = 0, truncated = false;
    const visit = (relDir: string, depth: number) => {
      if (truncated) return;
      let names: string[];
      try { names = fs.readdirSync(path.join(this.root, relDir)).sort(); } catch { return; }
      for (const name of names) {
        if (truncated) return;
        if (name.startsWith(".")) continue;
        const rel = relDir + "/" + name;
        if (hasExcludedTerm(rel, this.cfg)) continue;
        let st: fs.Stats;
        try { st = fs.lstatSync(path.join(this.root, rel)); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { if (depth < LIMITS.maxDepth) visit(rel, depth + 1); continue; }
        if (!st.isFile() || !pathInScope(rel, this.cfg)) continue;
        if (++files > LIMITS.maxFiles) { truncated = true; return; }
        try {
          const n = this.loadNote(rel);
          total += n.bytes;
          if (total > LIMITS.maxTotalBytes) { truncated = true; return; }
          out.push(withText ? n : { ...n, text: "" });
        } catch { /* skipped: not allowed / unreadable */ }
      }
    };
    for (const f of this.cfg.folders) {
      let st: fs.Stats;
      try { st = fs.lstatSync(path.join(this.root, f)); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) visit(f, 1);
    }
    return { notes: out, truncated };
  }

  /** Validate a caller-supplied relative path and return its normalised form. */
  private cleanPath(p: unknown): string {
    if (typeof p !== "string" || !p || p.length > LIMITS.maxPathChars) throw NOT_FOUND();
    if (p.includes("\0") || p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith("~") || p.includes("://")) throw NOT_FOUND();
    if (!pathInScope(p, this.cfg)) throw NOT_FOUND();
    return p;
  }

  /** Read one note with every check: path scope, no symlink component, O_NOFOLLOW, regular file, single link, size, realpath, metadata scope. */
  private loadNote(rel: string): Loaded {
    this.cleanPath(rel);
    let cur = this.root;
    const segs = rel.split("/");
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      let st: fs.Stats;
      try { st = fs.lstatSync(cur); } catch { throw NOT_FOUND(); }
      if (st.isSymbolicLink()) throw NOT_FOUND();
      if (i < segs.length - 1 ? !st.isDirectory() : !st.isFile()) throw NOT_FOUND();
    }
    let fd: number;
    try { fd = fs.openSync(cur, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw NOT_FOUND(); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > LIMITS.maxFileBytes) throw NOT_FOUND();
      const real = fs.realpathSync(cur);
      if (real !== path.join(this.root, ...segs)) throw NOT_FOUND(); // a directory was swapped for a link, or the root moved
      const text = fs.readFileSync(fd, "utf8");
      const p = parseNote(text);
      if (!isAllowed(rel, metaOf(p), this.cfg)) throw NOT_FOUND();
      const tags = [...new Set([...fmTags(p.fm), ...inlineTags(p.body)])].slice(0, 50);
      return { path: rel, title: titleOf(rel, p), tags, bytes: st.size, modified: st.mtime.toISOString(), text };
    } finally { fs.closeSync(fd); }
  }

  scope() {
    const s = this.scan(false);
    return { root: this.root, folders: this.cfg.folders, inbox: this.cfg.inbox, exclude: this.cfg.exclude, notes: s.notes.length, truncated: s.truncated, writeEnabled: this.allowWrite, limits: LIMITS };
  }

  list(folder?: string): { notes: NoteInfo[]; truncated: boolean } {
    if (folder !== undefined && !this.cfg.folders.includes(folder)) throw new MemoryError("bad_request", `folder must be one of: ${this.cfg.folders.join(", ")}`);
    const s = this.scan(false);
    const notes = s.notes.filter((n) => !folder || n.path.startsWith(folder + "/")).map(({ text, ...i }) => i);
    return { notes, truncated: s.truncated };
  }

  read(rel: string): NoteInfo & { content: string; contentTruncated: boolean } {
    const n = this.loadNote(rel);
    const { text, ...info } = n;
    return { ...info, content: text.slice(0, LIMITS.maxReadChars), contentTruncated: text.length > LIMITS.maxReadChars };
  }

  search(query: string, limit: number = LIMITS.defaultSearchResults): { results: Array<NoteInfo & { score: number; snippet: string }>; truncated: boolean } {
    if (typeof query !== "string" || !query.trim() || query.length > LIMITS.maxQueryChars) throw new MemoryError("bad_request", `query must be 1-${LIMITS.maxQueryChars} characters`);
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, LIMITS.maxQueryTerms);
    const lim = Math.max(1, Math.min(LIMITS.maxSearchResults, Math.floor(limit) || LIMITS.defaultSearchResults));
    const s = this.scan(true);
    const hits: Array<NoteInfo & { score: number; snippet: string }> = [];
    for (const n of s.notes) {
      const low = n.text.toLowerCase(), title = n.title.toLowerCase(), pth = n.path.toLowerCase(), tags = n.tags.join(" ").toLowerCase();
      let score = 0, ok = true;
      for (const t of terms) {
        const inBody = countOf(low, t);
        const inT = title.includes(t), inP = pth.includes(t), inG = tags.includes(t);
        if (!inBody && !inT && !inP && !inG) { ok = false; break; }
        score += (inT ? 5 : 0) + (inG ? 3 : 0) + (inP ? 2 : 0) + Math.min(inBody, 10);
      }
      if (!ok) continue;
      const { text, ...info } = n;
      hits.push({ ...info, score, snippet: snippet(text, terms[0]) });
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { results: hits.slice(0, lim), truncated: s.truncated };
  }

  links(rel: string) {
    const target = this.loadNote(rel);
    const s = this.scan(true);
    const idx = new LinkIndex(s.notes.map((n) => n.path));
    const outgoing = extractLinks(target.text).map((l) => ({ link: l.raw, kind: l.kind, resolved: idx.resolve(l, target.path) }));
    const backlinks: string[] = [];
    for (const n of s.notes) {
      if (n.path === target.path) continue;
      if (extractLinks(n.text).some((l) => idx.resolve(l, n.path) === target.path)) backlinks.push(n.path);
    }
    return { path: target.path, outgoing, backlinks, truncated: s.truncated };
  }

  // --- writing (opt-in, create-only)
  write(input: { title: string; content: string; tags?: string[]; links?: string[] }): { path: string; bytes: number } {
    if (!this.allowWrite) throw new MemoryError("read_only", "writes are disabled; start with --allow-write (or PALACE_MEMORY_WRITE=1) to let this process create new notes");
    if (this.writes >= LIMITS.maxWritesPerSession) throw new MemoryError("limit", `at most ${LIMITS.maxWritesPerSession} new notes per session`);
    const { title, content } = input;
    if (typeof title !== "string" || !title.trim() || title.length > LIMITS.maxTitleChars || /[\r\n\0]/.test(title)) throw new MemoryError("bad_request", `title must be 1-${LIMITS.maxTitleChars} characters on one line`);
    if (typeof content !== "string" || !content.trim() || content.includes("\0") || Buffer.byteLength(content) > LIMITS.maxWriteBytes) throw new MemoryError("bad_request", `content must be non-empty text of at most ${LIMITS.maxWriteBytes} bytes`);
    const tags = input.tags ?? [];
    if (tags.length > LIMITS.maxTags || tags.some((t) => typeof t !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,39}$/.test(t))) throw new MemoryError("bad_request", `tags: at most ${LIMITS.maxTags}, each letters/digits/_/- (max 40)`);
    const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
    if (!slug) throw new MemoryError("bad_request", "title must contain letters or digits");
    const rel = `${this.cfg.inbox}/${slug}.md`;
    if (!pathInScope(rel, this.cfg)) throw new MemoryError("bad_request", "the title contains a term the memory scope excludes; choose another title");

    // links: each must resolve to an existing readable note; written as [[wikilinks]]
    const linkNames = input.links ?? [];
    if (linkNames.length > LIMITS.maxLinks) throw new MemoryError("bad_request", `at most ${LIMITS.maxLinks} links`);
    let related = "";
    if (linkNames.length) {
      const idx = new LinkIndex(this.scan(false).notes.map((n) => n.path));
      const lines = linkNames.map((name) => {
        const r = typeof name === "string" ? idx.resolve({ raw: name, kind: "wiki", target: name.replace(/\.md$/i, "") }, rel) : null;
        if (!r) throw new MemoryError("bad_request", `link target not found in scope: ${JSON.stringify(name)}`);
        return `- [[${r.replace(/\.md$/i, "")}]]`;
      });
      related = `\n\n## Related\n${lines.join("\n")}`;
    }
    const fm = ["---", `title: ${JSON.stringify(title)}`, `created: ${new Date().toISOString()}`, "source: ai-memory", ...(tags.length ? [`tags: [${tags.join(", ")}]`] : []), "---", ""].join("\n");
    const text = `${fm}\n# ${title}\n\n${content.trim()}${related}\n`;
    // the note must be readable back through the same scope, otherwise refuse instead of writing an invisible file
    if (!isAllowed(rel, metaOf(parseNote(text)), this.cfg)) throw new MemoryError("bad_request", "the note would be out of scope (a tag, link or inline #tag contains an excluded term); not written");

    const dir = path.join(this.root, this.cfg.inbox);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(dir); } catch { /* missing */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new MemoryError("unsafe", "the inbox folder is not a plain directory");
    if (!st) fs.mkdirSync(dir, { mode: 0o755 });
    if (fs.readdirSync(dir).length >= LIMITS.maxInboxNotes) throw new MemoryError("limit", `the inbox already holds ${LIMITS.maxInboxNotes} entries`);
    let fd: number;
    try {
      fd = fs.openSync(path.join(dir, `${slug}.md`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (e: any) {
      if (e?.code === "EEXIST") throw new MemoryError("exists", `${rel} already exists; existing notes are never overwritten. Pick a different title`);
      throw new MemoryError("io", "could not create the note");
    }
    try {
      if (fs.realpathSync(dir) !== path.join(this.root, this.cfg.inbox)) throw new MemoryError("unsafe", "the inbox resolves outside the memory root");
      fs.writeFileSync(fd, text);
    } finally { fs.closeSync(fd); }
    this.writes++;
    return { path: rel, bytes: Buffer.byteLength(text) };
  }
}

// ---------- helpers ----------
function resolveRoot(root: string): string {
  if (typeof root !== "string" || !root.trim()) throw new MemoryError("no_root", "an explicit memory root is required (--root DIR or PALACE_MEMORY_ROOT)");
  if (root.includes("://") || root.includes("\0")) throw new MemoryError("bad_root", "the memory root must be a local directory path");
  const abs = path.resolve(root);
  if (abs === path.parse(abs).root) throw new MemoryError("bad_root", "refusing the filesystem root as memory root");
  let real: string;
  try { real = fs.realpathSync(abs); } catch { throw new MemoryError("bad_root", `memory root does not exist: ${abs}`); }
  if (!fs.statSync(real).isDirectory()) throw new MemoryError("bad_root", "memory root is not a directory");
  return real;
}
function readConfig(root: string): ScopeConfig {
  const file = path.join(root, CONFIG_FILE);
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return parseScopeConfig(undefined); }
  if (!st.isFile() || st.size > 16 * 1024) throw new ScopeError(`${CONFIG_FILE} must be a regular file under 16 KB (symlinks are not followed)`);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new ScopeError(`${CONFIG_FILE} is not valid JSON`); }
  return parseScopeConfig(raw);
}
function countOf(hay: string, needle: string): number {
  let c = 0, i = 0;
  while (c < 50 && (i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length; }
  return c;
}
function snippet(text: string, term: string): string {
  const flat = text.replace(/^---[\s\S]*?\n---[ \t]*\r?\n/, "").replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(term);
  const start = Math.max(0, (i < 0 ? 0 : i) - 60);
  return (start ? "…" : "") + flat.slice(start, start + 200);
}

interface RawLink { raw: string; kind: "wiki" | "markdown"; target: string }
export function extractLinks(text: string): RawLink[] {
  const body = parseNote(text).body;
  const out: RawLink[] = [];
  for (const m of body.matchAll(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g)) out.push({ raw: m[0], kind: "wiki", target: m[1].trim().replace(/\.md$/i, "") });
  for (const m of body.matchAll(/\[[^\]\n]*\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)/gi)) if (!/^[a-z][a-z0-9+.-]*:/i.test(m[1])) out.push({ raw: m[0], kind: "markdown", target: decodeURI(m[1]) });
  return out;
}
class LinkIndex {
  private byPath = new Map<string, string>();
  private byBase = new Map<string, string>();
  constructor(paths: string[]) {
    for (const p of [...paths].sort()) {
      this.byPath.set(p.toLowerCase().replace(/\.md$/, ""), p);
      const b = path.posix.basename(p, ".md").toLowerCase();
      if (!this.byBase.has(b)) this.byBase.set(b, p);
    }
  }
  resolve(l: RawLink, from: string): string | null {
    if (l.kind === "markdown") {
      const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), l.target)).toLowerCase().replace(/\.md$/, "");
      return this.byPath.get(joined) ?? null;
    }
    const t = l.target.toLowerCase();
    return this.byPath.get(t) ?? this.byBase.get(t) ?? null;
  }
}
