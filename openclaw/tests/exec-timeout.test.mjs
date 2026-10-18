// Prova: exec ha un timeout corto in config e il gateway lo fa rispettare.
// Statico (sempre): tools.exec.timeoutSeconds <= 600. Vivo (LIVE=1): sessione di test, mai canali veri.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const cfg = JSON.parse(readFileSync(homedir() + "/.openclaw/openclaw.json", "utf8"));
const limit = cfg.tools?.exec?.timeoutSeconds;
assert.ok(typeof limit === "number" && limit > 0 && limit <= 600, `tools.exec.timeoutSeconds=${limit}, atteso 1..600`);

if (process.env.LIVE === "1") {
  // Con la soglia a 20 s uno sleep 900 deve sparire da solo e l'agente deve ricevere un risultato.
  execFileSync("openclaw", ["config", "set", "tools.exec.timeoutSeconds", "20"]);
  try {
    const out = execFileSync("openclaw", ["agent", "--agent", "main", "--session-key", "agent:main:test-exec-timeout-live", "--model", "anthropic/claude-sonnet-5-5", "--json", "-m",
      "Test tecnico. Usa exec con command 'sleep 900', senza timeoutSeconds e senza background. Riporta il testo esatto del risultato."], { encoding: "utf8", timeout: 120000 });
    assert.match(out, /Command still running|timed out/, "l'agente non ha ricevuto un risultato exec");
    await new Promise((r) => setTimeout(r, 40000));
    const ps = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
    assert.ok(!/^sleep 900$/m.test(ps), "sleep 900 ancora vivo dopo il timeout");
  } finally {
    execFileSync("openclaw", ["config", "set", "tools.exec.timeoutSeconds", String(limit)]);
  }
}
console.log("ok");
