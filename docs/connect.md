# Connect an AI client to your notes (Palace Atlas memory)

`palace-memory` turns a folder of plain Markdown notes into a small local memory for any MCP-capable AI client, and ships the same operations as a command line tool. It reads and searches your notes, follows `[[links]]`, and, only if you switch it on, saves new notes. It never sends anything over a network: the MCP server talks over stdin/stdout to the client that launched it.

Requirements: Node 20.3 or newer, and this repository checked out with `npm install` done.

## 1. Build

Run from the repository root. Every command in the blocks marked `bash` below is run by the test suite (`memory/test/docs.test.cjs`), so they work as written.

```bash test
node memory/build.mjs
node memory/dist/palace-memory.cjs help
```

The result is one executable file, `memory/dist/palace-memory.cjs`. Use its absolute path in client configs.

## 2. What the server can see (scope)

You choose the vault with an explicit root (`--root DIR` or `PALACE_MEMORY_ROOT`). There is no default, so it cannot start pointed at your home folder by accident. The same scope rules as the Obsidian plugin apply (`src/scope.ts`), configured by an optional `palace-atlas.json` at the root:

```json
{ "folders": ["topics", "projects", "memories"], "inbox": "memories", "exclude": ["private", "secret", "confidential", "password", "credential"] }
```

A note is visible only if all of these hold:

- it is a `.md` file inside one of the (up to three) configured top-level folders;
- no path segment starts with `.`, and the path contains no exclude term (case-insensitive);
- its tags and category-like frontmatter values contain no exclude term, including inline `#tags`;
- its frontmatter does not say `private: true` or `memory: false`;
- its frontmatter parses (an unterminated `---` block fails closed).

Symlinks are never followed (files, folders, the configured folders themselves, and `palace-atlas.json`). Hard-linked files, `..`, absolute paths, backslashes, URLs and hidden paths are refused. A refused read always returns the same message, so a client cannot probe which files exist.

Try it on the bundled synthetic vault (`example-vault/`, read-only, nothing real in it):

```bash test
export VAULT="$PWD/example-vault"
node memory/dist/palace-memory.cjs --root "$VAULT" scope
node memory/dist/palace-memory.cjs --root "$VAULT" list
node memory/dist/palace-memory.cjs --root "$VAULT" search spaced repetition --limit 3
node memory/dist/palace-memory.cjs --root "$VAULT" read topics/spaced-repetition.md
node memory/dist/palace-memory.cjs --root "$VAULT" links topics/active-recall.md
```

Output is JSON on stdout. Errors are one line on stderr; exit status is 0 ok, 1 refused or failed, 2 usage error. Two of the example notes are deliberately out of scope, and the CLI refuses them:

```bash test expect-fail
node memory/dist/palace-memory.cjs --root "$PWD/example-vault" read topics/secret-plans.md
```

## 3. Saving notes (opt-in)

Read-only is the default. Writing needs `--allow-write` (or `PALACE_MEMORY_WRITE=1`); without it the `memory_write` tool is not even listed. When on, it can only **create one new note per call** in the configured `inbox` folder. It cannot overwrite, edit, move or delete anything, and it cannot choose a folder: the file name comes from the title (`"Quokka habitat"` becomes `memories/quokka-habitat.md`). Saving the same title twice fails. Links you pass must name existing readable notes and are written as a `## Related` list of `[[wikilinks]]`.

Work on a copy so the example vault stays pristine:

```bash test
VAULT="$(mktemp -d)/vault"
cp -R example-vault "$VAULT"
! node memory/dist/palace-memory.cjs --root "$VAULT" write --title "Quokka habitat" --content "x"   # refused: read-only, exit status 1
node memory/dist/palace-memory.cjs --root "$VAULT" --allow-write write --title "Quokka habitat" --tag animals --link active-recall --content "Quokkas live on Rottnest Island."
printf 'Longer text can come from stdin.\n' | node memory/dist/palace-memory.cjs --root "$VAULT" --allow-write write --title "From stdin" --stdin
node memory/dist/palace-memory.cjs --root "$VAULT" search rottnest
node memory/dist/palace-memory.cjs --root "$VAULT" read memories/quokka-habitat.md
node memory/dist/palace-memory.cjs --root "$VAULT" links topics/active-recall.md
```

Anything you save is ordinary Markdown in your vault: review it, edit it, delete it yourself. Notes the AI wrote are marked `source: ai-memory` in their frontmatter.

## 4. Limits

| Limit | Value |
| --- | --- |
| New note body | 20,000 bytes, title 120 characters, 8 tags, 20 links |
| New notes per server/CLI process | 25 (restart to continue) |
| Entries allowed in the inbox folder before writes stop | 1000 |
| Note size read or indexed | 256 KB (bigger notes are invisible) |
| Notes scanned per call | 5000 files, 64 MB total, 6 folder levels deep |
| Text returned by `read` | 64,000 characters (flagged `contentTruncated`) |
| Search | 200-character query, 8 terms, at most 50 results (default 10) |

Search and links scan the vault on every call (no cache), so a note saved by one process is found by the next. Frontmatter parsing is a deliberate YAML subset (`key: value`, `[a, b]`, `- item` lists); unusual structures are folded in as text so exclusion still applies. Wikilinks resolve by path or file name, case-insensitively, like Obsidian; titles that differ from file names do not resolve. POSIX systems (macOS, Linux) are the tested targets.

Treat note text as untrusted input: it may contain instructions aimed at the AI. The tool descriptions say so, but the client and model must honour it. Read-only mode is the safe default for vaults you did not write yourself.

## 5. Tools exposed over MCP

`memory_scope`, `memory_list`, `memory_search`, `memory_read`, `memory_links` (all marked read-only), plus `memory_write` only with `--allow-write`. Arguments mirror the CLI: `{ "query": "...", "limit": 5 }`, `{ "path": "topics/x.md" }`, `{ "title", "content", "tags"?, "links"? }`.

## 6. Client config 1: Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (Claude → Settings → Developer → Edit Config), then quit and reopen Claude Desktop. Replace both paths. Desktop apps often lack your shell `PATH`, so if `node` is not found put the output of `command -v node` in `"command"`.

```json config-test
{
  "mcpServers": {
    "palace-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/palace-atlas-public/memory/dist/palace-memory.cjs", "serve"],
      "env": { "PALACE_MEMORY_ROOT": "/ABSOLUTE/PATH/TO/vault" }
    }
  }
}
```

This is read-only. To allow saving, add `"PALACE_MEMORY_WRITE": "1"` to `env` (or `"--allow-write"` to `args` before `"serve"`).

## 7. Client config 2: Claude Code

Per project, commit-able as `.mcp.json` in the project root (Claude Code asks you to approve project servers):

```json config-test
{
  "mcpServers": {
    "palace-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/palace-atlas-public/memory/dist/palace-memory.cjs", "--root", "/ABSOLUTE/PATH/TO/vault", "serve"],
      "env": {}
    }
  }
}
```

Or add it from the shell (this edits your Claude Code settings, so it is not run by the tests; `claude mcp add --help` documents the syntax):

```
claude mcp add palace-memory -e PALACE_MEMORY_ROOT=/ABSOLUTE/PATH/TO/vault -- node /ABSOLUTE/PATH/TO/palace-atlas-public/memory/dist/palace-memory.cjs serve
```

Then run `/mcp` inside Claude Code to see the server and its tools. For saving, add `-e PALACE_MEMORY_WRITE=1`.

Any other MCP client that launches stdio servers uses the same three ingredients: a command (`node`), arguments (the `.cjs` file, optional `--root`/`--allow-write`, then `serve`), and optional environment variables.

## 8. Client config 3: Cursor

Cursor reads MCP servers from `mcp.json`: `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects (you can also manage servers from Cursor's settings UI). The format is the same `mcpServers` object as above:

```json config-test
{
  "mcpServers": {
    "palace-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/palace-atlas-public/memory/dist/palace-memory.cjs", "serve"],
      "env": { "PALACE_MEMORY_ROOT": "/ABSOLUTE/PATH/TO/vault" }
    }
  }
}
```

Read-only as written; add `"PALACE_MEMORY_WRITE": "1"` to `env` to allow saving. Restart or refresh the server in Cursor after editing.

## 9. Client config 4: Codex

Codex (CLI and IDE extension) reads `[mcp_servers.<name>]` tables from `~/.codex/config.toml`, or `.codex/config.toml` in a trusted project. A stdio server needs `command`; `args` and `env` are optional:

```toml config-test
[mcp_servers.palace-memory]
command = "node"
args = ["/ABSOLUTE/PATH/TO/palace-atlas-public/memory/dist/palace-memory.cjs", "serve"]

[mcp_servers.palace-memory.env]
PALACE_MEMORY_ROOT = "/ABSOLUTE/PATH/TO/vault"
```

Or from the shell (`--` separates Codex's options from the launcher command; this edits your Codex config, so the tests only launch the command it records):

```
codex mcp add palace-memory --env PALACE_MEMORY_ROOT=/ABSOLUTE/PATH/TO/vault -- node /ABSOLUTE/PATH/TO/palace-atlas-public/memory/dist/palace-memory.cjs serve
```

Check with `codex mcp list`. Codex does not pass your whole shell environment to servers, which is why the root is set in `env`. Writing: add `PALACE_MEMORY_WRITE = "1"` under `[mcp_servers.palace-memory.env]`.

Config formats for Cursor and Codex were checked against their published documentation; neither application was installed here, so the tests start the server exactly as these configs specify (command, args, env) with the real MCP client rather than through Cursor or Codex themselves.

## 10. Check it yourself: save, restart, retrieve

The test suite does this with the real MCP SDK client (`memory/test/mcp.test.cjs`): client A starts the server with writes on and saves a note; the process exits; client B, a fresh process, starts read-only and finds and reads that note. By hand with the CLI, which is the same code:

```bash test
VAULT="$(mktemp -d)/vault"
cp -R example-vault "$VAULT"
node memory/dist/palace-memory.cjs --root "$VAULT" --allow-write write --title "Remember me" --content "unique-token-zebra-lantern-42"
node memory/dist/palace-memory.cjs --root "$VAULT" search unique-token-zebra-lantern-42 | grep -q memories/remember-me.md && echo "found after restart"
```

## What this does not do

It does not publish, sync or upload anything, does not edit or delete notes, does not follow symlinks out of the vault, and does not guard against a client or model that you have granted other powerful tools. Pointing it at a vault with secrets is your decision; use `exclude`, `private: true` and a dedicated vault if in doubt.
