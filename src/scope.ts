// Memory scope: ONE definition shared by the Obsidian plugin (what is drawn) and the memory server/CLI (what an AI can
// read and where it may write). Pure functions, no I/O, so both runtimes and the tests use exactly the same rules.
//
// A note is in scope when ALL of these hold:
//  - it is a `.md` file inside one of the configured top-level folders (at most three, one colour each);
//  - no path segment is hidden (starts with "."), and the path contains no exclude term;
//  - its metadata is known (fail closed) and no tag / category-like frontmatter value contains an exclude term;
//  - its frontmatter does not say `private: true` (or `memory: false`).
//
// Configuration lives in a visible file at the memory root: `palace-atlas.json`, e.g.
//   { "folders": ["topics", "projects", "memories"], "inbox": "memories", "exclude": ["private", "secret"] }
// Missing file = DEFAULT_SCOPE. An invalid file is an error (never silently widened).

export const CONFIG_FILE = "palace-atlas.json";
/** Internal colour slots. The configured folder names map onto these in order. */
export const SLOTS = ["topics", "projects", "memories"] as const;
export type Folder = (typeof SLOTS)[number];

export interface ScopeConfig {
  /** 1 to 3 top-level folder names, in slot order (colours: cyan, orange, violet). */
  folders: string[];
  /** Folder (one of `folders`) where new AI memories are written when writes are enabled. */
  inbox: string;
  /** Case-insensitive terms; a path, tag or category-like frontmatter value containing one is out of scope. */
  exclude: string[];
}

export const DEFAULT_SCOPE: ScopeConfig = Object.freeze({
  folders: ["topics", "projects", "memories"],
  inbox: "memories",
  exclude: ["private", "secret", "confidential", "password", "credential"],
}) as ScopeConfig;

/** Frontmatter keys whose values are treated like tags for exclusion (same list as the plugin always used). */
export const META_KEYS = ["tags", "tag", "category", "categories", "type", "domain", "area", "kind", "bot", "profile"];

const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

export class ScopeError extends Error {}

/** Validate a parsed palace-atlas.json value. Throws ScopeError with a readable message. */
export function parseScopeConfig(raw: unknown): ScopeConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_SCOPE, folders: [...DEFAULT_SCOPE.folders], exclude: [...DEFAULT_SCOPE.exclude] };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ScopeError(`${CONFIG_FILE} must be a JSON object`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["folders", "inbox", "exclude", "$comment"].includes(k)) throw new ScopeError(`${CONFIG_FILE}: unknown key "${k}"`);
  const folders = o.folders === undefined ? [...DEFAULT_SCOPE.folders] : o.folders;
  if (!Array.isArray(folders) || folders.length < 1 || folders.length > SLOTS.length) throw new ScopeError(`${CONFIG_FILE}: "folders" must list 1 to ${SLOTS.length} folder names`);
  for (const f of folders) if (typeof f !== "string" || !FOLDER_RE.test(f)) throw new ScopeError(`${CONFIG_FILE}: invalid folder name ${JSON.stringify(f)} (one top-level folder; letters, digits, space, _ or -; not hidden)`);
  const lower = folders.map((f: string) => f.toLowerCase());
  if (new Set(lower).size !== lower.length) throw new ScopeError(`${CONFIG_FILE}: duplicate folder names`);
  const inbox = o.inbox === undefined ? (folders.includes(DEFAULT_SCOPE.inbox) ? DEFAULT_SCOPE.inbox : folders[folders.length - 1]) : o.inbox;
  if (typeof inbox !== "string" || !folders.includes(inbox)) throw new ScopeError(`${CONFIG_FILE}: "inbox" must be one of the folders`);
  const exclude = o.exclude === undefined ? [...DEFAULT_SCOPE.exclude] : o.exclude;
  if (!Array.isArray(exclude) || exclude.length > 200 || exclude.some((t) => typeof t !== "string" || !t.trim() || t.length > 64)) throw new ScopeError(`${CONFIG_FILE}: "exclude" must be a list of short non-empty strings`);
  const cfg: ScopeConfig = { folders: [...folders], inbox, exclude: exclude.map((t: string) => t.trim().toLowerCase()) };
  if (hasExcludedTerm(inbox, cfg)) throw new ScopeError(`${CONFIG_FILE}: the inbox folder name contains an exclude term`);
  return cfg;
}

export function normalizePath(path: string): string { return path.replace(/\\/g, "/"); }

/** Colour slot of a vault-relative path, or null when outside the configured folders. */
export function folderOf(path: string, cfg: ScopeConfig = DEFAULT_SCOPE): Folder | null {
  const p = normalizePath(path);
  for (let i = 0; i < cfg.folders.length; i++) if (p.startsWith(cfg.folders[i] + "/")) return SLOTS[i];
  return null;
}
/** Display label of a slot under this config (the real folder name). */
export function folderLabel(slot: Folder, cfg: ScopeConfig = DEFAULT_SCOPE): string { return cfg.folders[SLOTS.indexOf(slot)] ?? slot; }

export function hasExcludedTerm(s: string, cfg: ScopeConfig = DEFAULT_SCOPE): boolean {
  const l = s.toLowerCase();
  return cfg.exclude.some((t) => l.includes(t));
}
function flat(v: unknown, out: string[]) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => flat(x, out));
}
export interface NoteMeta { tags: string[]; fm: Record<string, unknown> | null }

const truthy = (v: unknown) => v === true || (typeof v === "string" && /^(true|yes|1)$/i.test(v.trim()));
const falsy = (v: unknown) => v === false || (typeof v === "string" && /^(false|no|0)$/i.test(v.trim()));

export function metaExcluded(m: NoteMeta, cfg: ScopeConfig = DEFAULT_SCOPE): boolean {
  const vals: string[] = [...m.tags];
  if (m.fm) {
    for (const k of Object.keys(m.fm)) {
      const lk = k.toLowerCase();
      if (META_KEYS.includes(lk)) flat(m.fm[k], vals);
      if (lk === "private" && truthy(m.fm[k])) return true;
      if (lk === "memory" && falsy(m.fm[k])) return true;
    }
  }
  return vals.some((v) => hasExcludedTerm(v.replace(/^#/, ""), cfg));
}

/** Path-only checks (no metadata): markdown, configured folder, no hidden segment, no `..`, no exclude term. */
export function pathInScope(path: string, cfg: ScopeConfig = DEFAULT_SCOPE): boolean {
  const p = normalizePath(path);
  if (!p.toLowerCase().endsWith(".md")) return false;
  if (!folderOf(p, cfg)) return false;
  const segs = p.split("/");
  if (segs.some((seg) => seg === "" || seg === "." || seg === ".." || seg.startsWith("."))) return false;
  return !hasExcludedTerm(p, cfg);
}

export function isAllowed(path: string, meta: NoteMeta | null, cfg: ScopeConfig = DEFAULT_SCOPE): boolean {
  if (!pathInScope(path, cfg)) return false;
  if (!meta) return false; // fail closed until metadata exists
  return !metaExcluded(meta, cfg);
}
