#!/usr/bin/env node
// Notificatore di default: scrive il messaggio su stdout. Un cron che annuncia lo stdout lo recapita.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try { console.log(JSON.parse(raw).message); } catch { console.log(process.env.USAGE_HUB_MESSAGE || raw); }
});
