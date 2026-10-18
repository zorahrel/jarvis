#!/usr/bin/env node
// gptchat — legge le conversazioni ChatGPT dal Chrome CDP persistente (profilo skill-profile).
// Uso:  gptchat list [regex]        elenca le chat in sidebar (filtro opzionale)
//       gptchat read <href|url>     stampa il testo completo di una chat
//       gptchat grep <regex>        apre le chat che matchano il titolo e ne stampa il testo
// Chrome: se non gira, lo lancia headless sul profilo ~/.cache/cdp-mcp/skill-profile (porta 19223).
import { spawn } from 'node:child_process';
const PORT = +(process.env.GPTCHAT_PORT || 19223);
const PROFILE = process.env.GPTCHAT_PROFILE || `${process.env.HOME}/.cache/cdp-mcp/skill-profile`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureChrome() {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return; } catch {}
  spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--no-first-run', 'https://chatgpt.com/'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await sleep(1000); try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return; } catch {} }
  throw new Error('Chrome CDP non risponde sulla porta ' + PORT);
}

async function attach() {
  await ensureChrome();
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let t = list.find(x => x.type === 'page' && x.url.includes('chatgpt.com'));
  if (!t) { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?https://chatgpt.com/`)).json(); await sleep(5000); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const p = send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = await Promise.race([p, sleep(25000).then(() => ({ timeout: 1 }))]);
    return r.timeout ? 'TIMEOUT' : (r.result?.result?.value ?? '');
  };
  return { send, ev, close: () => ws.close() };
}

// ChatGPT carica la sidebar in modo incrementale: scrolla finché il conteggio dei link smette di crescere.
async function sidebar(ev) {
  let prev = 0;
  for (let i = 0; i < 12; i++) {
    await ev(`(()=>{const el=[...document.querySelectorAll('div,nav')].find(e=>e.scrollHeight>e.clientHeight+200&&e.querySelector('a[href^="/c/"]'));if(el)el.scrollTop=el.scrollHeight;return 1})()`);
    await sleep(800);
    const n = +(await ev(`document.querySelectorAll('a[href^="/c/"]').length`));
    if (n === prev) break; prev = n;
  }
  return JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('a[href^="/c/"]')].map(a=>({href:a.getAttribute('href'),title:a.textContent.trim()})))`));
}

async function readChat({ send, ev }, href) {
  const url = href.startsWith('http') ? href : 'https://chatgpt.com' + href;
  await send('Page.navigate', { url });
  await sleep(6000);
  // risale in cima per forzare il caricamento dei messaggi più vecchi
  for (let i = 0; i < 5; i++) {
    await ev(`(()=>{const sc=[...document.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+400&&e.querySelector('[data-message-author-role]'));if(sc)sc.scrollTop=0;return 1})()`);
    await sleep(700);
  }
  return await ev(`[...document.querySelectorAll('[data-message-author-role]')].map(e=>e.getAttribute('data-message-author-role').toUpperCase()+': '+e.innerText.trim()).join('\\n\\n---\\n\\n')`);
}

const [cmd, arg] = process.argv.slice(2);
const s = await attach();
try {
  if (cmd === 'list') {
    const re = arg ? new RegExp(arg, 'i') : null;
    for (const c of await sidebar(s.ev)) if (!re || re.test(c.title)) console.log(c.href + '\t' + c.title);
  } else if (cmd === 'read') {
    console.log(await readChat(s, arg));
  } else if (cmd === 'grep') {
    const re = new RegExp(arg, 'i');
    for (const c of (await sidebar(s.ev)).filter(c => re.test(c.title))) {
      console.log(`\n===== ${c.title} (${c.href}) =====`);
      console.log(await readChat(s, c.href));
    }
  } else {
    console.log('uso: gptchat list [regex] | gptchat read <href> | gptchat grep <regex>');
  }
} finally { s.close(); process.exit(0); }
