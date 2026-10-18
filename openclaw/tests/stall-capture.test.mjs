// Prova: uno stall finto produce un file datato col contesto, e non lo duplica.
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "stall-"));
const log = join(dir, "gw.log");
const out = join(dir, "stalls");
const row = (o) => JSON.stringify(o);
writeFileSync(log, [
  row({ 0: "[mcp-loopback] request {\"toolName\":\"exec\"}" }),
  row({ 0: '{"subsystem":"agent/cli-backend"}', 1: "cli exec: provider=claude-cli sessionKey=agent:main:test" }),
  row({ 0: '{"subsystem":"gateway/ws"}', 1: "rumore" }),
  row({ 0: '{"subsystem":"diagnostic"}', 1: "stalled session: sessionId=abcd1234-0000 sessionKey=agent:main:test state=processing reason=blocked_tool_call activeTool=mcp__openclaw__exec activeToolCallId=toolu_FAKE123456 recovery=none" }),
].join("\n") + "\n");

const run = () => execFileSync("python3", ["-I", homedir() + "/.openclaw/bin/stall-capture.py", "--log", log, "--out", out], { encoding: "utf8" });
assert.match(run(), /stall salvato/);
const files = readdirSync(out).filter((f) => f.endsWith(".log"));
assert.equal(files.length, 1, "un file per stall");
const body = readFileSync(join(out, files[0]), "utf8");
assert.match(body, /mcp-loopback/, "contiene le righe MCP");
assert.match(body, /== STALL ==/);
assert.ok(!body.includes("rumore"), "niente rumore");
assert.equal(run(), "", "stesso stall non rilanciato");
assert.equal(readdirSync(out).filter((f) => f.endsWith(".log")).length, 1);
console.log("ok");
