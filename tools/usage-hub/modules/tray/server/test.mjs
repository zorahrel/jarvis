// node --test server/test.mjs — nessun framework, solo node:test.
import '../../../test-support/isolate-tmp.mjs';
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetText, statusFor, mapClaude, mapMuse, mapQuotas, filterRenewals, toEpoch, code3, mergeCredit, bonusTargets, mapHub, shortNum, readApiSpend } from "./server.mjs";
import { parseCloudCredit, classifyCreditOutput, mergeCreditMap } from "./probes/cloud-credit.mjs";
import { EventEmitter } from "node:events";
import { rpc } from "./probes/codex.mjs";
import { quotaWindowSec, samplesFromProviders, parseHistory,
         decimate, vdmSeries, mergeSeries, attachHistory, createHistory } from "./history.mjs";

describe("resetText", () => {
  it("rende ore+minuti e giorni", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(resetText(now + 4 * 3600 + 12 * 60), "4h12m");
    assert.equal(resetText(now + 2 * 86400 + 5 * 3600), "2d5h");
    assert.equal(resetText(now + 9 * 60), "9m");
    assert.equal(resetText(now - 5), "ora");
    assert.equal(resetText(null), "");
  });
});

describe("statusFor", () => {
  it("soglie verde/arancio/rosso", () => {
    assert.equal(statusFor(10, null), "ok");
    assert.equal(statusFor(80, null), "warning");
    assert.equal(statusFor(95, null), "critical");
    assert.equal(statusFor(100, null), "depleted");
  });
  it("l'override vince", () => {
    assert.equal(statusFor(10, "depleted"), "depleted");
  });
});

describe("readApiSpend", () => {
  it("recomputes the shared line from Rome day buckets and returns null on file errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "usage-api-spend-"));
    const file = path.join(dir, "api-spend.json");
    writeFileSync(file, JSON.stringify({ version: 1, days: {
      "2026-10-10": { "account-a": { "claude-sonnet-4-5": { cost: 3 } } },
      "2026-10-16": {
        "account-a": { "claude-opus-5-5": { cost: 0.2 } },
        operatore: { "claude-sonnet-4-6": { cost: 1.5 } },
      },
    } }));
    const result = readApiSpend(file, Date.parse("2026-10-16T12:30:00+02:00"));
    assert.equal(result.today, 1.7);
    assert.equal(result.last7d, 4.7);
    assert.equal(result.sinceOct16, 1.7);
    assert.equal(result.line, "API Claude: $1.70 oggi · $4.70 7g (account-a $3.20, operatore $1.50)");
    assert.equal(readApiSpend(path.join(dir, "missing.json")), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("mapClaude", () => {
  const vdm = { profiles: [
    { name: "a", label: "ada@example.com", isActive: true, blockKind: null,
      rateLimits: { fiveH: { utilization: 0.12, reset: 1791319200 },
                    sevenD: { utilization: 1, reset: 1791345600 } } },
    { name: "b", label: "x@y.zz", blockKind: "quota-7d",
      rateLimits: { fiveH: { utilization: 0, reset: 1 }, sevenD: { utilization: 0.4, reset: 1 } } },
  ]};
  it("percentuali e peggiore dei due", () => {
    const [a] = mapClaude(vdm).accounts;
    assert.equal(a.quotas[0].usedPct, 12);
    assert.equal(a.quotas[1].usedPct, 100);
    assert.equal(a.status, "depleted");
    assert.equal(a.active, true);
  });
  it("blockKind quota forza depleted", () => {
    const [, b] = mapClaude(vdm).accounts;
    assert.equal(b.status, "depleted");
  });
  it("ogni quota ha il suo status, l'account il peggiore", () => {
    const [a, b] = mapClaude(vdm).accounts;
    assert.equal(a.quotas[0].status, "ok");
    assert.equal(a.quotas[1].status, "depleted");
    assert.equal(b.quotas[0].status, "ok");
    assert.equal(b.quotas[1].status, "depleted");
  });
});

describe("mapMuse", () => {
  it("converte remaining in used", () => {
    const p = mapMuse({ quotas: [
      { type: "session", percentRemaining: 94, resetsAt: "2026-10-06T21:10:18Z" },
      { type: "weekly", percentRemaining: 82, resetsAt: "2026-10-12T00:00:00Z" },
    ]});
    assert.equal(p.accounts[0].quotas[0].usedPct, 6);
    assert.equal(p.accounts[0].quotas[1].key, "7d");
    assert.equal(p.accounts[0].status, "ok");
  });
  it("senza dati segnala errore invece di inventare", () => {
    assert.equal(mapMuse({ quotas: [] }).error, "nessun dato");
    assert.equal(mapMuse(null).error, "nessun dato");
  });
  it("account confermato senza quota resta visibile e lo dichiara", () => {
    const p = mapMuse({ email: "io@x.it", quotas: [] });
    assert.equal(p.error, "Muse non pubblica la quota");
    assert.equal(p.accounts[0].label, "io@x.it");
    assert.deepEqual(p.accounts[0].quotas, []);
  });
  it("label dall'email o dal nome", () => {
    const p = mapMuse({ email: "io@x.it",
      quotas: [{ type: "session", percentRemaining: 50, resetsAt: null }] });
    assert.equal(p.accounts[0].label, "io@x.it");
    assert.equal(p.accounts[0].code, "MUS");
    const q = mapMuse({ quotas: [{ type: "session", percentRemaining: 50, resetsAt: null }] });
    assert.equal(q.accounts[0].label, "Muse");
  });
  it("dato vecchio: grigio con l'età, mai colore di quota attuale", () => {
    const now = 1791556000;
    const quotas = [{ type: "session", percentRemaining: 20, resetsAt: "2026-10-09T14:34:14Z" }];
    const old = mapMuse({ quotas, asOf: now - 48 * 60 }, now);
    assert.equal(old.accounts[0].status, "stale");
    assert.equal(old.accounts[0].quotas[0].status, "stale");
    assert.equal(old.accounts[0].quotas[0].resetText, "dato di 48m fa");
    // lo storico colloca il punto alla lettura vera, non alla rilettura
    assert.equal(old.accounts[0].quotas[0].observedAt, now - 48 * 60);
    assert.equal(mapMuse({ quotas, asOf: now - 3 * 3600 }, now).accounts[0].quotas[0].resetText, "dato di 3h fa");
    const fresh = mapMuse({ quotas, asOf: now - 60 }, now);
    assert.equal(fresh.accounts[0].quotas[0].status, "warning");
  });
});

describe("mapQuotas", () => {
  it("forma unificata per codex", () => {
    const p = mapQuotas({ quotas: [
      { key: "5h", usedPct: 42, resetsAt: 1791318908 },
      { key: "7d", usedPct: 68, resetsAt: null },
    ]}, "codex", "Codex", "codex", "CODEX");
    assert.equal(p.accounts[0].quotas[0].usedPct, 42);
    assert.equal(p.accounts[0].status, "ok");
    assert.equal(p.accounts[0].quotas[0].status, "ok");
    assert.equal(p.accounts[0].quotas[1].resetText, "");
  });
  it("vuoto diventa errore", () => {
    assert.equal(mapQuotas(null, "x", "X", "x", "X").error, "nessun dato");
  });
  it("label dall'email, codice dal nome", () => {
    const p = mapQuotas({ quotas: [{ key: "5h", usedPct: 1, resetsAt: null }] },
                        "codex", "Codex", "codex", "Codex", "io@x.it");
    assert.equal(p.accounts[0].label, "io@x.it");
    assert.equal(p.accounts[0].code, "COD");
    const q = mapQuotas({ quotas: [{ key: "5h", usedPct: 1, resetsAt: null }] },
                        "codex", "Codex", "codex", "Codex", "spazzatura");
    assert.equal(q.accounts[0].label, "Codex");
  });
});

describe("filterRenewals", () => {
  it("nasconde solo tray:false, il resto passa", () => {
    const out = filterRenewals([
      { service: "A", provider: "claude" },
      { service: "B", provider: "infra", tray: false },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].service, "A");
    assert.deepEqual(filterRenewals(null), []);
  });
});

describe("code3", () => {
  it("tre lettere maiuscole", () => {
    assert.equal(code3("ada@example.com"), "ADA");
    assert.equal(code3("Codex"), "COD");
    assert.equal(code3("Opus"), "OPU");
    assert.equal(code3("Muse"), "MUS");
  });
});

describe("parseCloudCredit", () => {
  const live = { iguana_necktie: { limit_dollars: 250, used_dollars: 130.584522,
    remaining_dollars: 119.41547800000001, resets_at: "2026-11-05T07:59:00+00:00" } };
  it("saldo arrotondato e data corta", () => {
    assert.deepEqual(parseCloudCredit(live),
      { remaining: 119.42, limit: 250, used: 130.58, renewsAt: "2026-11-05" });
  });
  it("senza bucket o rotto dà null, mai eccezioni", () => {
    assert.equal(parseCloudCredit({}), null);
    assert.equal(parseCloudCredit({ iguana_necktie: null }), null);
    assert.equal(parseCloudCredit({ iguana_necktie: {} }), null);
    assert.equal(parseCloudCredit(null), null);
    assert.equal(parseCloudCredit("xx"), null);
  });
  it("classifyCreditOutput: live, nobonus, failed", async () => {
    const { classifyCreditOutput } = await import("./probes/cloud-credit.mjs");
    assert.equal(classifyCreditOutput(JSON.stringify({ iguana_necktie: {
      remaining_dollars: 10, limit_dollars: 250,
      resets_at: "2026-11-05T00:00:00Z" } })).kind, "live");
    assert.equal(classifyCreditOutput('{"iguana_necktie":null}').kind, "nobonus");
    assert.equal(classifyCreditOutput("credito-cloud: HTTP 429").kind, "failed");
    assert.equal(classifyCreditOutput("").kind, "failed");
  });
  it("creditAccount: legge l'email loggata o null", async () => {
    const { creditAccount } = await import("./probes/cloud-credit.mjs");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tray-home-"));
    fs.writeFileSync(path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "ada@example.com" } }));
    assert.equal(creditAccount(home), "ada@example.com");
    assert.equal(creditAccount(home + "-missing"), null);
  });
  it("lastGood: scrive e rilegge con stale+asOf, scade dopo 6h", async () => {
    const { saveLastGood, loadLastGood } = await import("./probes/cloud-credit.mjs");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tray-lg-")), "last.json");
    const v = { remaining: 74.4, limit: 250, renewsAt: "2026-11-05", account: "a@b.c" };
    assert.equal(loadLastGood(p), null);
    saveLastGood(v, p);
    const back = loadLastGood(p);
    assert.equal(back.remaining, 74.4);
    assert.equal(back.stale, true);
    assert.equal(typeof back.asOf, "number");
    assert.equal(loadLastGood(p, Date.now() + 7 * 3600 * 1000), null);
  });
  it("reasonForFailure: token, 429, generico", async () => {
    const { reasonForFailure } = await import("./probes/cloud-credit.mjs");
    assert.equal(reasonForFailure({ code: 3 }, "", ""), "token");
    assert.equal(reasonForFailure({ code: 1 }, "", "HTTP 429 da api"), "limited");
    assert.equal(reasonForFailure({ code: 1 }, "boom", ""), "error");
    assert.equal(reasonForFailure(null, "testo", ""), "error");
  });
  it("nobonusQuiet: vale solo per quel login", async () => {
    const { nobonusQuiet } = await import("./probes/cloud-credit.mjs");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tray-nb-")), "nb");
    fs.writeFileSync(p, `a@b.c|${Date.now()}`);
    assert.equal(nobonusQuiet("a@b.c", p), true);
    assert.equal(nobonusQuiet("x@y.z", p), false);
  });
  it("mergeCredit: live salva, stantio ripiega, il resto passa", () => {
    const live = { remaining: 10 };
    const stale = { remaining: 9, stale: true };
    const una = { unavailable: true };
    assert.deepEqual(mergeCredit(live, stale), { credit: live, save: live });
    assert.deepEqual(mergeCredit(una, stale), { credit: stale, save: null });
    assert.deepEqual(mergeCredit(una, null), { credit: una, save: null });
    assert.deepEqual(mergeCredit(null, stale), { credit: stale, save: null });
    assert.deepEqual(mergeCredit(null, null), { credit: null, save: null });
  });
  it("mergeCredit: sonda stale (cache) si serve con la sua età, mai risalvata", () => {
    const cached = { remaining: 9, stale: true, asOf: 1000 };
    assert.deepEqual(mergeCredit(cached, null), { credit: cached, save: null });
  });
  it("liveQuiet: fresco tace, vecchio o mancante riprova", async () => {
    const { liveQuiet } = await import("./probes/cloud-credit.mjs");
    const { writeFileSync } = await import("node:fs");
    const p = `${process.env.TMPDIR || "/tmp/"}tray-quiet-test`;
    writeFileSync(p, String(Date.now()));
    assert.equal(liveQuiet(p), true);
    writeFileSync(p, "1");
    assert.equal(liveQuiet(p), false);
    assert.equal(liveQuiet(p + "-missing"), false);
  });
});

describe("creditMap", () => {
  const live = (account, remaining = 50) => ({ remaining, limit: 100, used: 100 - remaining,
    renewsAt: "2026-11-06", account });
  it("live fresco per un login, gli altri account stantii con età intatta", async () => {
    const { mergeCreditMap } = await import("./probes/cloud-credit.mjs");
    const before = { "a@example.com": { remaining: 10, limit: 100, used: 90,
      renewsAt: "2026-11-05", asOf: 1000 } };
    const { map, credits, changed } =
      mergeCreditMap(before, live("b@example.com"), 2000);
    assert.equal(changed, true);
    assert.equal(credits["b@example.com"].stale, false);
    assert.equal(credits["b@example.com"].asOf, 2000);
    assert.equal(credits["a@example.com"].stale, true);
    assert.equal(credits["a@example.com"].asOf, 1000);
    assert.equal(map["a@example.com"].remaining, 10);
  });
  it("nobonus segna solo quell'account, senza cancellare gli altri", async () => {
    const { mergeCreditMap } = await import("./probes/cloud-credit.mjs");
    const before = { "a@example.com": { remaining: 10, limit: 100, used: 90,
      renewsAt: "2026-11-05", asOf: 1000 } };
    const { map, credits, changed } =
      mergeCreditMap(before, { nobonus: true, account: "b@example.com" }, 2000);
    assert.equal(changed, true);
    assert.equal(credits["b@example.com"].nobonus, true);
    assert.equal(credits["b@example.com"].stale, true);
    assert.equal(map["a@example.com"].remaining, 10);
    assert.equal(credits["a@example.com"].stale, true);
  });
  it("sonda stantia non ringiovanisce né sovrascrive", async () => {
    const { mergeCreditMap } = await import("./probes/cloud-credit.mjs");
    const old = { remaining: 10, limit: 100, used: 90,
      renewsAt: "2026-11-05", asOf: 1000 };
    const same = mergeCreditMap({ "a@example.com": old },
      { ...live("a@example.com", 11), stale: true, asOf: 1500 }, 2000);
    assert.equal(same.changed, false);
    assert.equal(same.credits["a@example.com"].asOf, 1000);
    assert.equal(same.credits["a@example.com"].remaining, 10);
    const fresh = mergeCreditMap({},
      { ...live("a@example.com"), stale: true, asOf: 1500 }, 2000);
    assert.equal(fresh.changed, true);
    assert.equal(fresh.credits["a@example.com"].asOf, 1500);
    assert.equal(fresh.credits["a@example.com"].stale, true);
  });
  it("live senza account e fallimenti non toccano la mappa", async () => {
    const { mergeCreditMap } = await import("./probes/cloud-credit.mjs");
    const before = { "a@example.com": { remaining: 10, asOf: 1000 } };
    for (const probed of [{ ...live(null) }, { ...live("x") },
        { unavailable: true, account: "b@example.com" }, null]) {
      const r = mergeCreditMap(before, probed, 2000);
      assert.equal(r.changed, false);
      assert.deepEqual(r.map, before);
      assert.equal(r.credits["a@example.com"].stale, true);
    }
  });
  it("persistenza senza scadenza: si rilegge a qualsiasi età", async () => {
    const { saveCreditMap, loadCreditMap } = await import("./probes/cloud-credit.mjs");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tray-cm-")),
      "sub", "credit-last.json");
    assert.deepEqual(loadCreditMap(p), {});
    const map = { "a@example.com": { remaining: 10, limit: 100, used: 90,
      renewsAt: "2026-11-05", asOf: 1000 },
      "b@example.com": { nobonus: true, asOf: 1000 } };
    saveCreditMap(map, p);
    assert.deepEqual(loadCreditMap(p), map);
    fs.writeFileSync(p, "rotto{");
    assert.deepEqual(loadCreditMap(p), {});
  });
  it("mergeCredit: nobonus vale come assenza di live", () => {
    const stale = { remaining: 9, stale: true };
    const nb = { nobonus: true, account: "a@example.com" };
    assert.deepEqual(mergeCredit(nb, stale), { credit: stale, save: null });
    assert.deepEqual(mergeCredit(nb, null), { credit: null, save: null });
  });
  it("bonusTargets: solo i profili Max con nome ed email", () => {
    const vdm = { profiles: [
      { name: "auto-2", label: "a@example.com", subscriptionType: "max" },
      { name: "auto-3", label: "b@example.com", subscriptionType: "max" },
      { name: "auto-9", label: "c@example.com", subscriptionType: "pro" },
      { name: null, label: "d@example.com", subscriptionType: "max" },
    ] };
    assert.deepEqual(bonusTargets(vdm), [
      { name: "auto-2", email: "a@example.com" },
      { name: "auto-3", email: "b@example.com" },
    ]);
    assert.deepEqual(bonusTargets(null), []);
  });
});

describe("hub", () => {
  it("shortNum: k sopra mille, due decimali sotto cento", () => {
    assert.equal(shortNum(45300), "45k");
    assert.equal(shortNum(1200), "1.2k");
    assert.equal(shortNum(1000), "1k");
    assert.equal(shortNum(999), "999");
    assert.equal(shortNum(49), "49");
    assert.equal(shortNum(1.05), "1.05");
    assert.equal(shortNum(0.5), "0.5");
  });
  it("parseOpenRouter: spesa del mese sul tetto, label o default", async () => {
    const { parseOpenRouter } = await import("./probes/hub.mjs");
    const live = { data: { label: "Test", usage: 1.5, usage_monthly: 0.5,
      limit: 50, limit_reset: "monthly" } };
    assert.deepEqual(parseOpenRouter(live), { label: "Test", quotas: [
      { key: "usd", used: 0.5, limit: 50, unit: "$", reset: null, resetWord: "mensile" }] });
    const nocap = { data: { label: "", usage: 2, limit: null } };
    assert.deepEqual(parseOpenRouter(nocap).quotas[0].limit, null);
    assert.equal(parseOpenRouter(nocap).label, "OpenRouter");
    // chiave senza nome: l'API rimanda la chiave mascherata, si dichiara chiave
    const masked = { data: { label: "sk-or-v1-987...be6", usage: 1, limit: 50 } };
    assert.equal(parseOpenRouter(masked).label, "chiave …be6");
    assert.equal(parseOpenRouter({}), null);
    assert.equal(parseOpenRouter({ data: { usage: "x" } }), null);
  });
  it("parseEleven: email o tier come label, unix come reset", async () => {
    const { parseEleven } = await import("./probes/hub.mjs");
    const sub = { character_count: 4500, character_limit: 10000,
      next_character_count_reset_unix: 1794074400, tier: "starter" };
    assert.deepEqual(parseEleven(sub, { email: "a@example.com" }), {
      label: "a@example.com", quotas: [
        { key: "chr", used: 4500, limit: 10000, unit: "", reset: 1794074400, resetWord: null }] });
    assert.equal(parseEleven(sub, null).label, "starter");
    assert.equal(parseEleven({}, null), null);
  });
  it("classify: noperm, timeout, http, chiavi invisibili", async () => {
    const { classifyElevenError } = await import("./probes/hub.mjs");
    assert.equal(classifyElevenError(0, null), "timeout");
    assert.equal(classifyElevenError(401, { Detail: { status: "missing_permissions" } }), "noperm");
    assert.equal(classifyElevenError(401, { Detail: { message: "missing the permission user_read" } }), "noperm");
    const zwsp = JSON.parse("{\"detail" + String.fromCharCode(8203) + "\":{\"status\":\"missing_permissions\"}}");
    assert.equal(zwsp.Detail, undefined);
    assert.equal(classifyElevenError(401, zwsp), "noperm");
    assert.equal(classifyElevenError(500, null), "http500");
  });
  it("mapHub: detail coi numeri, flag hub, errori in chiaro", () => {
    const live = { label: "Test", quotas: [
      { key: "usd", used: 0.5, limit: 50, unit: "$", reset: null, resetWord: "mensile" }] };
    const m = mapHub("openrouter", "OpenRouter", live);
    assert.equal(m.menuOnly, true);
    assert.equal(m.billing, "usage");
    assert.equal(m.accounts[0].label, "Test");
    const q = m.accounts[0].quotas[0];
    assert.equal(q.usedPct, 1);
    assert.equal(q.detail, "$0.5 su $50");
    assert.equal(q.resetText, "mensile");
    const nolimit = { label: "T", quotas: [
      { key: "usd", used: 2, limit: null, unit: "$", reset: null, resetWord: null }] };
    assert.equal(mapHub("o", "O", nolimit).accounts[0].quotas[0].detail, "$2 spesi");
    // senza tetto niente percentuale: unknown, mai uno 0% verde finto
    assert.equal(mapHub("o", "O", nolimit).accounts[0].quotas[0].status, "unknown");
    assert.equal(q.status, "ok");
    assert.equal(mapHub("e", "E", { error: "noperm" }).error,
      "chiave senza permesso user_read");
    assert.equal(mapHub("x", "X", null).error, "nessun dato");
  });
});

describe("anthropic-api", () => {
  it("saldo console: mantiene cifra, data e validità API senza inferirli dallo speso", async () => {
    const { attachApiSpend } = await import("./server.mjs");
    const { probeAnthropicApi } = await import("./probes/anthropic-api.mjs");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "api-balance-")), "snapshot.json");
    const snapshot = { account: "ada@example.com", remaining: 143.17,
      source: "console", asOf: 1791568845, expiresAt: "2099-10-17" };
    fs.writeFileSync(file, JSON.stringify(snapshot));
    const out = await probeAnthropicApi(file);
    const providers = [{ id: "claude", accounts: [{ label: "ada@example.com" }] }];
    attachApiSpend(providers, out);
    assert.match(providers[0].accounts[0].apiSpend.detail, /^\$143\.17 rilevati 09\/10$/);
    assert.match(providers[0].accounts[0].apiSpend.note, /^saldo letto a mano 09\/10 .*solo API\/SDK · scade 17\/10$/);
    assert.equal(providers[0].accounts[0].apiSpend.status, "unknown");
    fs.writeFileSync(file, JSON.stringify({ ...snapshot, expiresAt: "2000-01-01" }));
    assert.equal((await probeAnthropicApi(file)).error, "expired");
    fs.writeFileSync(file, JSON.stringify({ remaining: 200 }));
    assert.equal((await probeAnthropicApi(file)).error, "nodata");
  });
  it("console live: speso = concesso - residuo, scaduto ignorato, riga sotto l'account proprietario", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const cfgFile = `${mkdtempSync(`${tmpdir()}/local-`)}/local.json`;
    writeFileSync(cfgFile, JSON.stringify({ api: { account: "owner@example.com", org: "org-fake", keychainAccount: "fake" } }));
    process.env.USAGE_LOCAL_CONFIG = cfgFile;
    const { parseConsoleCredits, probeAnthropicConsole } = await import("./probes/anthropic-api.mjs");
    const { attachApiSpend } = await import("./server.mjs");
    const data = { promo_tranches: [
      { granted_amount_minor_units: 20000, remaining_amount_minor_units: 12153, expires_at: "2099-10-17T00:00:00Z" },
      { granted_amount_minor_units: 5000, remaining_amount_minor_units: 5000, expires_at: "2000-01-01T00:00:00Z" } ] };
    assert.deepEqual(parseConsoleCredits(data),
      { granted: 200, remaining: 121.53, spent: 78.47, expiresAt: "2099-10-17T00:00:00Z" });
    assert.equal(parseConsoleCredits({ promo_tranches: [] }), null);
    const ok = async () => ({ ok: true, json: async () => data });
    const out = await probeAnthropicConsole({ fetchImpl: ok, cookie: "x" });
    const ps = [{ id: "claude", accounts: [{ label: "owner@example.com" }, { label: "z@example.com" }] }];
    attachApiSpend(ps, out);
    assert.equal(ps[0].accounts[0].apiSpend.detail, "$121.53 rimasti");
    assert.match(ps[0].accounts[0].apiSpend.note, /^\$78\.47 spesi su \$200\.00 · letto alle \d\d:\d\d$/);
    // scadenza in resetsAt, niente testo di reset: non è un reset
    assert.equal(ps[0].accounts[0].apiSpend.resetsAt, toEpoch("2099-10-17T00:00:00Z"));
    assert.equal(ps[0].accounts[0].apiSpend.resetText, "");
    assert.equal(ps[0].accounts[0].apiSpend.usedPct, 39);
    assert.equal(ps[0].accounts[1].apiSpend, undefined);
  });
  it("sumCostReport: centesimi su più pagine, rotto ignorato", async () => {
    const { sumCostReport } = await import("./probes/anthropic-api.mjs");
    const pages = [
      { data: [{ results: [{ amount: "123.78912" }, { amount: "50" }] },
               { results: [{ amount: "xx" }] }] },
      { data: [] },
      null,
    ];
    assert.equal(sumCostReport(pages), 1.74);
    assert.equal(sumCostReport([]), 0);
    assert.equal(sumCostReport(null), 0);
  });
  it("classifyAnthropicError: timeout, permessi, http", async () => {
    const { classifyAnthropicError } = await import("./probes/anthropic-api.mjs");
    assert.equal(classifyAnthropicError(0, null), "timeout");
    assert.equal(classifyAnthropicError(401, { error: { message: "admin only" } }), "noperm");
    assert.equal(classifyAnthropicError(401, { error: { message: "invalid key" } }), "rejected");
    assert.equal(classifyAnthropicError(500, null), "http500");
  });
  it("mapHub: la sonda api diventa riga a consumo coi numeri veri", () => {
    const out = { label: "owner@example.com", quotas: [
      { key: "usd", used: 0.15, limit: 200, unit: "$", reset: null, resetWord: null }] };
    const m = mapHub("anthropic-api", "Anthropic API", out);
    assert.equal(m.menuOnly, true);
    assert.equal(m.accounts[0].quotas[0].detail, "$0.15 su $200");
  });
  it("attachApiSpend: solo sotto il proprietario, mai sezione, mai senza dati", async () => {
    const { attachApiSpend } = await import("./server.mjs");
    const out = { label: "owner@example.com", quotas: [
      { key: "usd", used: 0.15, limit: 200, unit: "$", reset: null, resetWord: null }] };
    const mk = () => [{ id: "claude", name: "Claude", accounts: [
      { label: "owner@example.com", quotas: [] },
      { label: "other@example.com", quotas: [] } ] }];
    const ps = mk();
    attachApiSpend(ps, out);
    assert.equal(ps[0].accounts[0].apiSpend.detail, "$0.15 su $200");
    assert.equal(ps[0].accounts[1].apiSpend, undefined);
    assert.equal(ps.length, 1); // nessuna sezione hub aggiunta
    attachApiSpend(mk(), { error: "timeout" });
    attachApiSpend(mk(), null);
    attachApiSpend([{ id: "codex", accounts: [] }], out);
  });
});

describe("codex rpc", () => {
  const fakeProc = () => ({ stdout: new EventEmitter(), stdin: { write() {} } });
  it("ricuce i chunk spezzati e risponde all'id giusto", async () => {
    const proc = fakeProc();
    const p = rpc(proc, { id: 2 });
    proc.stdout.emit("data", '{"id":1,"result":"no"}\n{"id":2,"res');
    proc.stdout.emit("data", 'ult":"sì"}\n');
    assert.equal((await p).result, "sì");
  });
  it("ignora righe vuote e JSON a metà", async () => {
    const proc = fakeProc();
    const p = rpc(proc, { id: 7 });
    proc.stdout.emit("data", '\n{"id":7');
    proc.stdout.emit("data", ',"ok":true}\n');
    assert.equal((await p).ok, true);
  });
});

describe("toEpoch", () => {
  it("ISO o null", () => {
    assert.equal(toEpoch("2026-10-06T21:10:18Z"), Date.parse("2026-10-06T21:10:18Z") / 1000);
    assert.equal(toEpoch(null), null);
    assert.equal(toEpoch("xx"), null);
  });
});

describe("resetCredits", () => {
  it("mapResetCredits: conteggio e soli available con titolo e scadenza", async () => {
    const { mapResetCredits } = await import("./probes/codex.mjs");
    const live = { availableCount: 1, credits: [
      { id: "a", status: "available", title: "Full reset (Weekly + 5 hr)", expiresAt: 1794004915 },
      { id: "b", status: "redeemed", title: "vecchio", expiresAt: null },
    ] };
    assert.deepEqual(mapResetCredits(live), { available: 1, credits: [
      { title: "Full reset (Weekly + 5 hr)", expiresAt: 1794004915 }] });
  });
  it("mapResetCredits: senza dati dà null, mai eccezioni", async () => {
    const { mapResetCredits } = await import("./probes/codex.mjs");
    assert.equal(mapResetCredits(null), null);
    assert.equal(mapResetCredits({}), null);
    assert.equal(mapResetCredits({ availableCount: "1" }), null);
  });
  it("mapQuotas: resetCredits passati all'account, null se assenti", () => {
    const rc = { available: 2, credits: [] };
    const p = mapQuotas({ quotas: [{ key: "5h", usedPct: 1, resetsAt: null }], resetCredits: rc },
                        "codex", "Codex", "codex", "Codex");
    assert.deepEqual(p.accounts[0].resetCredits, rc);
    const q = mapQuotas({ quotas: [{ key: "5h", usedPct: 1, resetsAt: null }] },
                        "codex", "Codex", "codex", "Codex");
    assert.equal(q.accounts[0].resetCredits, null);
  });
  it("mapClaude: reset manuali ignoti, mai inventati", () => {
    const vdm = { profiles: [{ name: "a", label: "ada@example.com", isActive: true,
      rateLimits: { fiveH: { utilization: 0.1, reset: 1 },
                    sevenD: { utilization: 0.2, reset: 1 } } }] };
    assert.equal(mapClaude(vdm).accounts[0].resetCredits, null);
  });
});

describe("history", () => {
  const NOW = 1791830000;
  const providers = (pct5, pct7) => [{ id: "codex", name: "Codex", accounts: [
    { id: "codex", label: "ada@example.com", code: "COD", active: true, status: "ok",
      quotas: [{ key: "5h", usedPct: pct5 }, { key: "7d", usedPct: pct7 }],
      apiSpend: { key: "API", usedPct: 42 } }] }];

  it("quotaWindowSec: finestra per tipo di quota", () => {
    assert.equal(quotaWindowSec("5h"), 86400);
    assert.equal(quotaWindowSec("7d"), 7 * 86400);
    assert.equal(quotaWindowSec("API"), 30 * 86400);
    assert.equal(quotaWindowSec("usd"), 30 * 86400);
    assert.equal(quotaWindowSec("altro"), 7 * 86400);
  });
  it("samplesFromProviders: quote e apiSpend, chiavi stabili", () => {
    const [s] = samplesFromProviders(providers(10, 20), NOW);
    assert.equal(s.t, NOW);
    assert.equal(s.s["codex|ada@example.com|5h"], 10);
    assert.equal(s.s["codex|ada@example.com|7d"], 20);
    assert.equal(s.s["codex|ada@example.com|API"], 42);
  });
  it("samplesFromProviders: stale al suo observedAt, unknown fuori", () => {
    const ps = [...providers(10, 20), { id: "muse", name: "Muse", accounts: [
      { id: "muse-code", label: "ada@example.com", code: "MUS", active: true,
        status: "stale", quotas: [
          { key: "5h", usedPct: 7, status: "stale", observedAt: NOW - 3600 },
          { key: "7d", usedPct: 28, status: "stale" },
          { key: "usd", usedPct: 0, status: "unknown", observedAt: NOW - 3600 }] }] }];
    const ss = samplesFromProviders(ps, NOW);
    assert.equal(ss.length, 2);
    assert.equal(ss[0].t, NOW - 3600);
    assert.deepEqual(ss[0].s, { "muse|ada@example.com|5h": 7 });
    assert.equal(ss[1].t, NOW);
  });
  it("parseHistory: riga corrotta saltata, ordine per tempo", () => {
    const text = `${JSON.stringify({ t: 2, s: {} })}\nrotto{\n${JSON.stringify({ t: 1, s: {} })}\n`;
    assert.deepEqual(parseHistory(text).map((o) => o.t), [1, 2]);
    assert.deepEqual(parseHistory(null), []);
  });
  it("decimate: tetto ai punti, primo e ultimo sempre presenti", () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ t: i, v: i }));
    const d = decimate(pts, 72);
    assert.equal(d.length, 72);
    assert.equal(d[0].t, 0);
    assert.equal(d[d.length - 1].t, 199);
    assert.equal(decimate(pts.slice(0, 3), 72).length, 3);
  });
  it("decimate: un picco breve sopravvive (la uniforme lo saltava)", () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ t: i, v: i === 101 ? 90 : 5 }));
    assert.ok(decimate(pts, 72).some((p) => p.v === 90));
  });
  it("vdmSeries: u in %, finestra e dedup tra le due serie vdm", () => {
    const profile = {
      utilizationHistory: [
        { ts: (NOW - 3600) * 1000, u5h: 0.1, u7d: 0.5 },
        { ts: (NOW - 60) * 1000, u5h: 0.27, u7d: 0.51 }],
      weeklyHistory: [
        { ts: (NOW - 90000) * 1000, u5h: 0, u7d: 0.4 },
        { ts: (NOW - 60) * 1000, u5h: 0.27, u7d: 0.51 }],
    };
    assert.deepEqual(vdmSeries(profile, "5h", 86400, NOW),
                     [{ t: NOW - 3600, v: 10 }, { t: NOW - 60, v: 27 }]);
    assert.equal(vdmSeries(profile, "7d", 7 * 86400, NOW).length, 3);
    assert.deepEqual(vdmSeries(null, "5h", 86400, NOW), []);
    assert.deepEqual(vdmSeries(profile, "xx", 86400, NOW), []);
  });
  it("mergeSeries: a pari istante vince vdm (decimale)", () => {
    const merged = mergeSeries([{ t: NOW, v: 27 }], [{ t: NOW + 30, v: 27.4 }]);
    assert.deepEqual(merged, [{ t: NOW + 30, v: 27.4 }]);
  });
  it("attachHistory: serie dal log, mai con un punto solo", () => {
    const samples = [samplesFromProviders(providers(5, 10), NOW - 3600)[0],
                     samplesFromProviders(providers(9, 10), NOW - 60)[0]];
    const ps = providers(9, 10);
    attachHistory(ps, null, samples, NOW);
    assert.deepEqual(ps[0].accounts[0].quotas[0].history,
                     [{ t: NOW - 3600, v: 5 }, { t: NOW - 60, v: 9 }]);
    const one = providers(9, 10);
    attachHistory(one, null, samples.slice(0, 1), NOW);
    assert.equal(one[0].accounts[0].quotas[0].history, undefined);
  });
  it("attachHistory: Claude prende la serie vdm anche a log vuoto", () => {
    const ps = [{ id: "claude", name: "Claude", accounts: [
      { id: "ada@example.com", label: "ada@example.com", code: "ADA", active: true,
        status: "ok", quotas: [{ key: "5h", usedPct: 27 }] }] }];
    const vdm = { profiles: [{ name: "a", label: "ada@example.com",
      utilizationHistory: [{ ts: (NOW - 7200) * 1000, u5h: 0, u7d: 0.4 },
                           { ts: (NOW - 60) * 1000, u5h: 0.27, u7d: 0.45 }],
      weeklyHistory: [] }] };
    attachHistory(ps, vdm, [], NOW);
    assert.deepEqual(ps[0].accounts[0].quotas[0].history,
                     [{ t: NOW - 7200, v: 0 }, { t: NOW - 60, v: 27 }]);
  });
  it("createHistory: append su file, rilettura e dedup dei fermi", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tray-hist-")),
                           "sub", "history.jsonl");
    const h = createHistory(file);
    assert.equal(h.record(providers(5, 10), NOW), true);
    assert.equal(h.record(providers(5, 10), NOW + 60), false);
    assert.equal(h.record(providers(8, 10), NOW + 120), true);
    assert.equal(h.record(providers(8, 10), NOW + 905), true); // heartbeat
    const again = createHistory(file);
    assert.equal(again.samples().length, 3);
    assert.equal(again.samples()[1].s["codex|ada@example.com|5h"], 8);
  });
  it("createHistory: punto stale inserito al tempo vero, una sola volta", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tray-hist-")),
                           "history.jsonl");
    const h = createHistory(file);
    assert.equal(h.record(providers(5, 10), NOW), true);
    const staleMuse = [{ id: "muse", name: "Muse", accounts: [
      { id: "muse-code", label: "ada@example.com", code: "MUS", active: true,
        status: "stale", quotas: [
          { key: "5h", usedPct: 7, status: "stale", observedAt: NOW - 3600 }] }] }];
    assert.equal(h.record(staleMuse, NOW + 60), true);
    assert.equal(h.record(staleMuse, NOW + 120), false); // stessa cache riletta
    assert.deepEqual(h.samples().map((s) => s.t), [NOW - 3600, NOW]);
    assert.equal(h.samples()[0].s["muse|ada@example.com|5h"], 7);
    // e alla rilettura da file l'ordine resta cronologico (append + sort)
    const again = createHistory(file);
    assert.deepEqual(again.samples().map((s) => s.t), [NOW - 3600, NOW]);
  });
});

describe("fetchVdm", () => {
  it("vdm lento o giù: ultima risposta buona per 15 minuti, poi errore", async () => {
    const { fetchVdm } = await import("./server.mjs");
    const T = 1_800_000_000_000;
    const ok = async () => ({ ok: true, json: async () => ({ profiles: [{ label: "me@example.com" }] }) });
    const down = async () => { throw new Error("aborted"); };
    assert.equal((await fetchVdm({ fetchImpl: ok, now: T })).profiles[0].label, "me@example.com");
    assert.equal((await fetchVdm({ fetchImpl: down, now: T + 14 * 60_000 })).profiles[0].label, "me@example.com");
    await assert.rejects(fetchVdm({ fetchImpl: down, now: T + 16 * 60_000 }));
  });
});

describe("modelli con quota propria", () => {
  const models = [{ name: "Fable", pct: 0, resets: "2026-10-25T09:00:00+00:00" }];
  it("arrivano anche dall'account senza bonus e restano nella mappa al giro dopo", () => {
    const c = classifyCreditOutput(JSON.stringify({ iguana_necktie: null, models }));
    assert.equal(c.kind, "nobonus");
    assert.deepEqual(c.models, models);
    const first = mergeCreditMap({}, { account: "a@x.it", nobonus: true, models }, 100);
    const again = mergeCreditMap(first.map, { account: "a@x.it", nobonus: true }, 200);
    assert.deepEqual(again.credits["a@x.it"].models, models);
  });
  it("il saldo vivo li porta con sé", () => {
    const v = parseCloudCredit({ iguana_necktie: { remaining_dollars: 51.81, limit_dollars: 250, used_dollars: 198.19, resets_at: "2026-11-05T07:59:00Z" }, models });
    assert.deepEqual(v.models, models);
  });
});
