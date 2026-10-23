// Valori personali (account, organizzazione, voce del Keychain) fuori dal repo:
// vivono in un file locale, o in USAGE_LOCAL_CONFIG per i test.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadLocal() {
  const file = process.env.USAGE_LOCAL_CONFIG || path.join(os.homedir(), ".config", "claude-usage-hub", "local.json");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}
