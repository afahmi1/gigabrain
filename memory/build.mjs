// Bundles the memory server + CLI into single CommonJS files (SDK and zod inlined) under memory/dist/.
//   memory/dist/palace-memory.cjs  executable CLI + MCP stdio server (package.json "bin")
//   memory/dist/core.cjs           the vault logic alone (used by unit tests)
import { build } from "esbuild";
import { chmodSync, readFileSync, mkdirSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const common = { bundle: true, platform: "node", target: "node20", format: "cjs", logLevel: "info", legalComments: "none", define: { __PM_VERSION__: JSON.stringify(pkg.version) } };
mkdirSync("memory/dist", { recursive: true });
await build({ ...common, entryPoints: ["memory/src/cli.ts"], outfile: "memory/dist/palace-memory.cjs", banner: { js: "#!/usr/bin/env node" } });
await build({ ...common, entryPoints: ["memory/src/core.ts"], outfile: "memory/dist/core.cjs" });
chmodSync("memory/dist/palace-memory.cjs", 0o755);
