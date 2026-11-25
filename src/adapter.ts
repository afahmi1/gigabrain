// Read-only vault adapter. Uses ONLY metadataCache data (paths, cached frontmatter/tags, resolvedLinks).
// It never reads note contents and never writes to the vault. Scope rules live in ./scope (shared with the memory server).
import { DEFAULT_SCOPE, Folder, NoteMeta, ScopeConfig, folderOf as scopeFolderOf, hasExcludedTerm as scopeHasExcluded, isAllowed as scopeIsAllowed, metaExcluded as scopeMetaExcluded } from "./scope";

export type { Folder } from "./scope";
export { SLOTS as ALLOWED_DIRS } from "./scope";

export interface AtlasNode { id: string; title: string; folder: Folder; degree: number; }
export interface AtlasEdge { a: number; b: number; }
export interface AtlasGraph { nodes: AtlasNode[]; edges: AtlasEdge[]; excluded: number; }

export interface GraphSource {
  paths: string[];                                 // vault-relative file paths (any extension)
  meta(path: string): NoteMeta | null;             // null = not cached yet (fail closed)
  resolvedLinks: Record<string, Record<string, number>>;
}

export const folderOf = (path: string, cfg: ScopeConfig = DEFAULT_SCOPE) => scopeFolderOf(path, cfg);
export const hasExcludedTerm = (s: string, cfg: ScopeConfig = DEFAULT_SCOPE) => scopeHasExcluded(s, cfg);
export const metaExcluded = (m: NoteMeta, cfg: ScopeConfig = DEFAULT_SCOPE) => scopeMetaExcluded(m, cfg);
export const isAllowed = (path: string, meta: NoteMeta | null, cfg: ScopeConfig = DEFAULT_SCOPE) => scopeIsAllowed(path, meta, cfg);

export function buildGraph(src: GraphSource, cfg: ScopeConfig = DEFAULT_SCOPE): AtlasGraph {
  const nodes: AtlasNode[] = [];
  const index = new Map<string, number>();
  let excluded = 0;
  for (const p of [...src.paths].sort()) {
    const f = folderOf(p, cfg);
    if (!f) continue; // outside allowed dirs: not even counted
    if (!isAllowed(p, src.meta(p), cfg)) { excluded++; continue; }
    index.set(p, nodes.length);
    nodes.push({ id: p, title: p.split("/").pop()!.replace(/\.md$/i, ""), folder: f, degree: 0 });
  }
  const seen = new Set<string>();
  const edges: AtlasEdge[] = [];
  for (const [s, targets] of Object.entries(src.resolvedLinks || {})) {
    const a = index.get(s);
    if (a === undefined) continue; // endpoint excluded
    for (const t of Object.keys(targets)) {
      const b = index.get(t);
      if (b === undefined || b === a) continue; // endpoint excluded / self link
      const k = a < b ? a + ":" + b : b + ":" + a;
      if (seen.has(k)) continue;
      seen.add(k); edges.push({ a: Math.min(a, b), b: Math.max(a, b) });
      nodes[a].degree++; nodes[b].degree++;
    }
  }
  return { nodes, edges, excluded };
}

// Obsidian-facing wrapper (structural types so the module stays testable in node).
export function graphFromApp(app: any, cfg: ScopeConfig = DEFAULT_SCOPE): AtlasGraph {
  const files: any[] = app.vault.getMarkdownFiles();
  const byPath = new Map<string, any>(files.map((f) => [f.path, f]));
  const src: GraphSource = {
    paths: files.map((f) => f.path),
    meta: (p) => {
      const f = byPath.get(p);
      const c = f ? app.metadataCache.getFileCache(f) : null;
      if (!c) return null;
      return { tags: (c.tags || []).map((t: any) => String(t.tag)), fm: c.frontmatter || null };
    },
    resolvedLinks: app.metadataCache.resolvedLinks,
  };
  return buildGraph(src, cfg);
}
