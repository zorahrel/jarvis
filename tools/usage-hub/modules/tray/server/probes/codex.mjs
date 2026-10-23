// Probe Codex: parla JSON-RPC con `codex app-server` (copiato da ClaudeBar).
// Ritorna {quotas:[{key,usedPct,resetsAt}], email} o null.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Email dal claim `email` dell'id_token in ~/.codex/auth.json (solo decode, niente verify).
function codexEmail() {
  try {
    const d = JSON.parse(readFileSync(path.join(os.homedir(), ".codex/auth.json"), "utf8"));
    const tok = d?.tokens?.id_token;
    if (typeof tok !== "string" || tok.split(".").length !== 3) return null;
    const p = JSON.parse(Buffer.from(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return typeof p.email === "string" && p.email.includes("@") ? p.email : null;
  } catch {
    return null;
  }
}

const CLI_ARGS = ["-s", "read-only", "-a", "never", "app-server"];

// launchd ha un PATH minimo: cerca il binario nei posti soliti.
function resolveCli() {
  if (process.env.CODEX_CLI) return process.env.CODEX_CLI;
  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    if (existsSync(p)) return p;
  }
  return "codex";
}

export function rpc(proc, msg) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("rpc timeout")), 15000);
    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === msg.id) {
            clearTimeout(timer);
            proc.stdout.off("data", onData);
            resolve(m);
            return;
          }
        } catch { /* frammento, aspetta */ }
      }
      buf = lines[lines.length - 1];
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(JSON.stringify(msg) + "\n");
  });
}

// Reset manuali: availableCount fa fede (la lista può essere cappata),
// dettaglio solo per gli available. Senza dati: null, mai inventati.
export function mapResetCredits(rc) {
  if (!rc || typeof rc.availableCount !== "number") return null;
  const credits = Array.isArray(rc.credits) ? rc.credits
    .filter((c) => c?.status === "available")
    .map((c) => ({ title: c.title ?? null, expiresAt: c.expiresAt ?? null })) : [];
  return { available: rc.availableCount, credits };
}

export async function probeCodex() {
  const proc = spawn(resolveCli(), CLI_ARGS, {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
  });
  const dead = await new Promise((r) => { proc.on("error", () => r(true)); setImmediate(() => r(false)); });
  if (dead) return null;
  try {
    await rpc(proc, { jsonrpc: "2.0", id: 1, method: "initialize",
                      params: { clientInfo: { name: "usage-tray", version: "1.0.0" } } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const limits = await rpc(proc, { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" });
    const r = limits?.result?.rateLimits;
    if (!r) return null;
    const quotas = [];
    if (r.primary) quotas.push({ key: "5h", usedPct: Math.round(r.primary.usedPercent ?? 0),
                                 resetsAt: r.primary.resetsAt ?? null });
    if (r.secondary) quotas.push({ key: "7d", usedPct: Math.round(r.secondary.usedPercent ?? 0),
                                   resetsAt: r.secondary.resetsAt ?? null });
    const resetCredits = mapResetCredits(limits?.result?.rateLimitResetCredits);
    return quotas.length ? { quotas, email: codexEmail(), resetCredits } : null;
  } catch {
    return null;
  } finally {
    proc.kill();
  }
}
