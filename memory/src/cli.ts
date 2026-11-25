// palace-memory CLI. Results are JSON on stdout; errors are one line on stderr. `serve` speaks MCP on stdout.
import { Memory, MemoryError, ScopeError } from "./core";
import { serve } from "./server";

declare const __PM_VERSION__: string;

const HELP = `palace-memory ${__PM_VERSION__}: local Markdown memory for AI clients (MCP stdio server + CLI)

usage: palace-memory --root DIR [--allow-write] <command> [args]
  (or set PALACE_MEMORY_ROOT=DIR and PALACE_MEMORY_WRITE=1)

commands:
  serve                       run the MCP stdio server
  scope                       show readable folders, write status and limits
  list [--folder NAME]        list readable notes
  search QUERY [--limit N]    ranked search (all terms must match)
  read PATH                   read a note, e.g. topics/foo.md
  links PATH                  outgoing links and backlinks of a note
  write --title T (--content TEXT | --stdin) [--tag X]... [--link NOTE]...
                              create ONE new note in the inbox (needs --allow-write; never overwrites)

exit status: 0 ok, 1 refused/failed, 2 usage error`;

class Usage extends Error {}

function parse(argv: string[]) {
  const flags: Record<string, string[]> = {};
  const pos: string[] = [];
  const bool = new Set(["allow-write", "stdin", "help"]);
  const val = new Set(["root", "folder", "limit", "title", "content", "tag", "link"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const k = a.slice(2);
    if (bool.has(k)) (flags[k] ??= []).push("1");
    else if (val.has(k)) { if (i + 1 >= argv.length) throw new Usage(`--${k} needs a value`); (flags[k] ??= []).push(argv[++i]); }
    else throw new Usage(`unknown option --${k}`);
  }
  return { flags, pos };
}

async function readStdin(max: number): Promise<string> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of process.stdin) { n += (c as Buffer).length; if (n > max) throw new MemoryError("bad_request", "stdin is larger than the write limit"); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  const { flags, pos } = parse(argv);
  const cmd = pos[0];
  if (flags.help || !cmd || cmd === "help") { console.log(HELP); return cmd || flags.help ? 0 : 2; }
  const root = flags.root?.[0] ?? process.env.PALACE_MEMORY_ROOT ?? "";
  const allowWrite = !!flags["allow-write"] || process.env.PALACE_MEMORY_WRITE === "1";
  const mem = new Memory({ root, allowWrite });
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  const need = (i: number, what: string) => { if (!pos[i]) throw new Usage(`${cmd}: missing ${what}`); return pos[i]; };
  switch (cmd) {
    case "serve": await serve(mem); return -1; // keep running
    case "scope": out(mem.scope()); return 0;
    case "list": out(mem.list(flags.folder?.[0])); return 0;
    case "search": {
      const limit = flags.limit ? Number(flags.limit[0]) : undefined;
      if (limit !== undefined && !Number.isInteger(limit)) throw new Usage("--limit must be an integer");
      out(mem.search(pos.slice(1).join(" "), limit)); return 0;
    }
    case "read": out(mem.read(need(1, "PATH"))); return 0;
    case "links": out(mem.links(need(1, "PATH"))); return 0;
    case "write": {
      if (!flags.title) throw new Usage("write: --title is required");
      let content = flags.content?.[0];
      if (flags.stdin) { if (content !== undefined) throw new Usage("use --content or --stdin, not both"); content = await readStdin(64 * 1024); }
      if (content === undefined) throw new Usage("write: give --content TEXT or --stdin");
      out(mem.write({ title: flags.title[0], content, tags: flags.tag, links: flags.link })); return 0;
    }
    default: throw new Usage(`unknown command "${cmd}"`);
  }
}

main(process.argv.slice(2)).then((code) => { if (code >= 0) process.exitCode = code; }, (e) => {
  if (e instanceof Usage) { process.stderr.write(`palace-memory: ${e.message}\n(try: palace-memory help)\n`); process.exitCode = 2; }
  else if (e instanceof MemoryError || e instanceof ScopeError) { process.stderr.write(`palace-memory: ${e.message}\n`); process.exitCode = 1; }
  else { process.stderr.write("palace-memory: internal error\n"); process.exitCode = 1; }
});
