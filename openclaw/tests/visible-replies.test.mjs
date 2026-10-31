// Prova: nei canali/gruppi il testo finale non esce da solo, nei DM sì.
// Usa il resolver reale di OpenClaw con la config reale (o con quella mutata via VR_MUTATE=1).
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import assert from "node:assert/strict";

const dist = "/opt/homebrew/lib/node_modules/openclaw/dist/";
const file = readdirSync(dist).find((f) => /^source-reply-delivery-mode-.*\.mjs$/.test(f) && readFileSync(dist + f, "utf8").includes("function resolveSourceReplyDeliveryMode"));
const mod = await import(dist + file);
// La lettera dell'export minificato cambia a ogni versione (2026.10.5: «r» è diventato un'altra funzione): si legge dall'export.
const alias = /resolveSourceReplyDeliveryMode as (\w+)/.exec(readFileSync(dist + file, "utf8"))[1];
const resolve = mod[alias];

const cfg = JSON.parse(readFileSync(homedir() + "/.openclaw/openclaw.json", "utf8"));
if (process.env.VR_MUTATE === "1") delete cfg.messages.groupChat.visibleReplies;
const base = { cfg, messageToolAvailable: true, defaultVisibleReplies: "automatic" };
const mk = (ChatType, Provider) => ({ ...base, ctx: { ChatType, Provider, Surface: Provider } });

assert.equal(resolve(mk("channel", "discord")), "message_tool_only", "canale Discord: solo tool");
assert.equal(resolve(mk("group", "whatsapp")), "message_tool_only", "gruppo WhatsApp: solo tool");
assert.equal(resolve(mk("direct", "discord")), "automatic", "DM: testo finale consegnato");
assert.equal(resolve(mk("direct", "whatsapp")), "automatic", "DM WhatsApp: consegnato");
console.log("ok");
