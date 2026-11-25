// SYNTHETIC DEMO FIXTURE. Not real notes. Used only by the demo/test harness.
import { GraphSource, buildGraph } from "../src/adapter";
import { rng } from "../src/layout";

export function demoSource(n = 150): GraphSource {
  const r = rng(42);
  const dirs = ["topics", "projects", "memories"];
  const words = ["Orbit", "Lattice", "Signal", "Cache", "Vector", "Harbor", "Ledger", "Beacon", "Thread", "Atlas", "Ember", "Quartz"];
  const paths: string[] = [];
  for (let i = 0; i < n; i++) paths.push(`${dirs[i % 3]}/DEMO ${words[Math.floor(r() * words.length)]} ${String(i).padStart(3, "0")}.md`);
  // decoys that the adapter must withhold
  const decoys = ["topics/secret plans.md", "projects/private review.md", "memories/confidential DEMO.md", "memories/DEMO flagged.md", "topics/DEMO tagged-only.md",
    "daily/2026-01-01.md", "inbox/x.md", "topics/DEMO credential tracker.md", "projects/DEMO fm-excluded.md"];
  paths.push(...decoys);
  const tagMap: Record<string, string[]> = { "topics/DEMO tagged-only.md": ["#Private/Plans"] };
  const fmMap: Record<string, Record<string, unknown>> = { "projects/DEMO fm-excluded.md": { tags: ["secret"] }, "memories/DEMO flagged.md": { private: true } };
  const links: Record<string, Record<string, number>> = {};
  const all = paths.slice();
  for (let i = 0; i < all.length * 1.6; i++) {
    const a = all[Math.floor(r() * all.length)], b = all[Math.floor(r() * all.length)];
    (links[a] ||= {})[b] = 1;
  }
  return { paths, resolvedLinks: links, meta: (p) => ({ tags: tagMap[p] ?? [], fm: fmMap[p] ?? null }) };
}
export const demoGraph = () => buildGraph(demoSource());
