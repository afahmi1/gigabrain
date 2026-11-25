"use strict";
// Executes the commands and configs in docs/connect.md so the documentation cannot drift from the code.
const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
const { REPO, CLI, tmp } = require("./helpers.cjs");

const md = fs.readFileSync(path.join(REPO, "docs", "connect.md"), "utf8");
const blocks = [...md.matchAll(/^```(\w*)([^\n]*)\n([\s\S]*?)^```/gm)].map((m) => ({ lang: m[1], flags: m[2].trim().split(/\s+/).filter(Boolean), body: m[3] }));
const bash = blocks.filter((b) => b.lang === "bash" && b.flags.includes("test"));
const configs = blocks.filter((b) => b.lang === "json" && b.flags.includes("config-test"));
const tomls = blocks.filter((b) => b.lang === "toml" && b.flags.includes("config-test"));

test("docs: found the expected executable blocks", () => {
  assert.ok(bash.length >= 5, `bash blocks: ${bash.length}`);
  assert.equal(configs.filter((b) => b.lang === "json").length, 3);
  assert.equal(tomls.length, 1);
  assert.ok(bash.some((b) => b.flags.includes("expect-fail")));
});

bash.forEach((b, i) => test(`docs: bash block ${i + 1} (${b.body.split("\n")[0].slice(0, 50)})`, () => {
  const r = cp.spawnSync("bash", ["-e", "-o", "pipefail", "-c", b.body], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmp("pm-docs-") }, timeout: 60000 });
  if (b.flags.includes("expect-fail")) { assert.notEqual(r.status, 0, "should fail"); assert.match(r.stderr, /palace-memory:/); }
  else assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  if (b.body.includes("found after restart")) assert.match(r.stdout, /found after restart/);
  if (b.body.includes("memory/build.mjs")) assert.match(r.stdout, /usage: palace-memory/);
}));

async function runConfig(command, args, env) {
  const t = new StdioClientTransport({ command, args, env: { PATH: process.env.PATH, ...env }, stderr: "pipe" });
  const c = new Client({ name: "docs-test", version: "0" });
  await c.connect(t);
  try {
    const names = (await c.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("memory_search") && !names.includes("memory_write"), names.join());
    const r = await c.callTool({ name: "memory_list", arguments: {} });
    assert.ok(JSON.parse(r.content[0].text).notes.length >= 4);
  } finally { await c.close(); }
}
const fix = (s, vault) => s.replaceAll("/ABSOLUTE/PATH/TO/palace-atlas-public", REPO).replaceAll("/ABSOLUTE/PATH/TO/vault", vault);

configs.forEach((b, i) => test(`docs: MCP config ${i + 1} launches a working server`, async () => {
  const vault = tmp("pm-docs-vault-");
  fs.cpSync(path.join(REPO, "example-vault"), vault, { recursive: true });
  const cfg = JSON.parse(fix(b.body, vault)).mcpServers["palace-memory"];
  assert.equal(cfg.command, "node");
  assert.ok(fs.existsSync(cfg.args[0]) && cfg.args[0] === CLI);
  assert.equal(cfg.args.at(-1), "serve");
  await runConfig(cfg.command, cfg.args, cfg.env ?? {});
}));

test("docs: the `claude mcp add` line launches a working server", async () => {
  const line = md.split("\n").find((l) => l.startsWith("claude mcp add palace-memory"));
  assert.ok(line);
  const vault = tmp("pm-docs-vault-");
  fs.cpSync(path.join(REPO, "example-vault"), vault, { recursive: true });
  const [head, tail] = fix(line, vault).split(" -- ");
  const env = Object.fromEntries([...head.matchAll(/-e (\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  const [command, ...args] = tail.trim().split(/\s+/);
  await runConfig(command, args, env);
});

// minimal TOML reader for the documented shape: [mcp_servers.X] with command/args, and [mcp_servers.X.env] string pairs
function readCodexToml(src) {
  const out = { env: {} }; let sect = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { sect = h[1]; assert.match(sect, /^mcp_servers\.palace-memory(\.env)?$/); continue; }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    assert.ok(kv, line);
    const val = JSON.parse(kv[2]); // the documented values are valid JSON: strings and string arrays
    if (sect.endsWith(".env")) out.env[kv[1]] = val; else out[kv[1]] = val;
  }
  return out;
}
tomls.forEach((b) => test("docs: Codex TOML config launches a working server", async () => {
  const vault = tmp("pm-docs-vault-");
  fs.cpSync(path.join(REPO, "example-vault"), vault, { recursive: true });
  const cfg = readCodexToml(fix(b.body, vault));
  assert.equal(cfg.command, "node");
  assert.equal(cfg.args[0], CLI);
  assert.equal(cfg.args.at(-1), "serve");
  await runConfig(cfg.command, cfg.args, cfg.env);
}));

test("docs: the `codex mcp add` line launches a working server", async () => {
  const line = md.split("\n").find((l) => l.startsWith("codex mcp add palace-memory"));
  assert.ok(line);
  const vault = tmp("pm-docs-vault-");
  fs.cpSync(path.join(REPO, "example-vault"), vault, { recursive: true });
  const [head, tail] = fix(line, vault).split(" -- ");
  const env = Object.fromEntries([...head.matchAll(/--env (\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  const [command, ...args] = tail.trim().split(/\s+/);
  await runConfig(command, args, env);
});
