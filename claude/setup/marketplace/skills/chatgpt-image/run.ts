// Generate image via ChatGPT. Self-contained: launches its own Chrome on demand.
// Usage: bun run run.ts <prompt> [--out <path>] [--cdp <url>] [--port <n>]
//
// First call: spawns Chrome with persistent profile, opens chatgpt.com, exits
// with login-required message. User logs in once. Subsequent calls reuse it.

import { spawn } from "child_process";
import { existsSync } from "fs";

const args = process.argv.slice(2);
const prompt = args.find(a => !a.startsWith("--")) ?? "";
const idxOut = args.indexOf("--out");
const idxPort = args.indexOf("--port");
const idxCdp = args.indexOf("--cdp");
const out = idxOut >= 0 ? args[idxOut + 1] : `/tmp/chatgpt-image-${Date.now()}.png`;
const port = idxPort >= 0 ? parseInt(args[idxPort + 1], 10) : 19223;
const cdp = idxCdp >= 0 ? args[idxCdp + 1] : `http://127.0.0.1:${port}`;
if (!prompt) { console.error("usage: run.ts <prompt> [--out <path>] [--port <n>] [--cdp <url>]"); process.exit(1); }

const PROFILE = `${process.env.HOME}/.cache/cdp-mcp/skill-profile`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function isUp(): Promise<boolean> {
  try { const r = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
}

if (!(await isUp())) {
  console.error(`[*] no Chrome on ${cdp}, launching...`);
  if (!existsSync(CHROME)) { console.error("Chrome not found at " + CHROME); process.exit(1); }
  const child = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run", "--no-default-browser-check",
    "https://chatgpt.com/"
  ], { detached: true, stdio: "ignore" });
  child.unref();
  // wait for CDP up
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); if (await isUp()) break; }
  if (!(await isUp())) { console.error("Chrome failed to start CDP"); process.exit(1); }
  console.error(`[*] Chrome up on ${cdp}, profile ${PROFILE}`);
}

const pages = await (await fetch(`${cdp}/json`)).json() as any[];
let tab = pages.find((p: any) => p.type === "page" && p.url?.includes("chatgpt.com"));
if (!tab) {
  const r = await fetch(`${cdp}/json/new?${encodeURIComponent("https://chatgpt.com/")}`, { method: "PUT" });
  tab = await r.json();
  await new Promise(r => setTimeout(r, 4000));
}

let id = 0;
const pending = new Map<number, (v: any) => void>();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", rej); });
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data as string);
  if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
});
const send = (method: string, params: any = {}) => {
  const i = ++id;
  return new Promise<any>(r => { pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
};
const ev = async (e: string, awaitPromise = false) => {
  const r = await send("Runtime.evaluate", { expression: e, awaitPromise, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
};

const t0 = Date.now();
console.error("[1] nav fresh chat...");
await send("Page.enable");
await send("Page.navigate", { url: process.env.CHATGPT_URL || "https://chatgpt.com/" });
await new Promise(r => setTimeout(r, 12_000));

// Detect login state — anonymous chat shows composer too, must check for login CTA
const loginCheck = await ev(`
  (() => {
    const text = document.body.innerText;
    const hasLoginCta = /Log in to (get|create images|upload)/i.test(text) || /Sign up for free/i.test(text);
    const hasComposer = !!(document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]'));
    return { hasComposer, hasLoginCta };
  })()
`);
if (!loginCheck.hasComposer || loginCheck.hasLoginCta) {
  console.error("");
  console.error("⚠️  ChatGPT not logged in (anonymous mode = no image gen).");
  console.error(`   Focus Chrome window on port ${port}, click Log in, complete login, then retry.`);
  console.error(`   Profile persists at: ${PROFILE}`);
  process.exit(2);
}

// A new chat restores the profile's leftover draft, attachments included: on 08/09 five
// images stuck in that draft rode along with every prompt, and the skill downloaded one
// of them instead of the render. Temporary chat has no draft but also no image tool, so
// the draft has to be emptied by hand. Attachment chips carry a remove button.
const cleared = await ev(`
  (() => {
    let n = 0;
    for (let k = 0; k < 12; k++) {
      const b = document.querySelector('button[aria-label*="Rimuovi" i], button[aria-label*="Remove" i]');
      if (!b) break;
      b.click(); n++;
    }
    return n;
  })()
`);
if (cleared) console.error(`[1b] cleared ${cleared} leftover attachment(s)`);
await new Promise(r => setTimeout(r, 1500));

// Only images inside assistant turns count. A bare `document.querySelectorAll('img')`
// also picks up the sidebar/discover artwork, which is served from oaiusercontent too:
// on a fresh chat it loads *after* the baseline snapshot, so it looks "new" and gets
// downloaded instead of the render (measured 08/09: two different prompts, same file).
// The generated image is NOT inside a [data-message-author-role="assistant"] node — that
// selector finds nothing and the run times out on a render that is sitting on screen.
// Everything in <main> that is not part of a user turn is the answer.
const IMGS = `[...document.querySelectorAll('main img')].filter(i=>!i.closest('[data-message-author-role="user"]'))`;
const before: string[] = await ev(`
  ${IMGS}.map(i=>i.src).filter(s=>s&&(s.includes('oaiusercontent')||s.includes('dalle')||s.includes('backend-api/estuary/content')))
`);
console.error(`[2] before: ${before.length}`);

console.error("[3] submit...");
// Focus the composer. (Insertion is done via CDP Input.insertText below — execCommand
// does NOT fire the events ProseMirror/React needs, so the send button never appears.)
const hasComposer = await ev(`
  (() => {
    const ta = document.querySelector('#prompt-textarea')
      || document.querySelector('div[contenteditable="true"]')
      || document.querySelector('textarea');
    if (!ta) return false;
    ta.focus();
    return true;
  })()
`);
if (!hasComposer) { console.error("FAILED: no composer"); process.exit(2); }
await new Promise(r => setTimeout(r, 350));
// Empty the restored draft text as well, or the prompt is appended to somebody else's
// half-written message and the model answers that one instead (08/09).
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
await new Promise(r => setTimeout(r, 200));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
await new Promise(r => setTimeout(r, 400));
// Type via CDP so React registers the text and reveals the send button.
await send("Input.insertText", { text: prompt });
await new Promise(r => setTimeout(r, 900));
// Click the send button (data-testid stable; aria-label is locale-dependent → keep both).
// Fallback: press Enter (ChatGPT submits on plain Enter).
const clicked = await ev(`
  (() => {
    const b = document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Invia" i]')
      || document.querySelector('button[aria-label*="send" i]');
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()
`);
if (!clicked) {
  const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
}

const tSubmit = Date.now();
console.error("[4] waiting...");
const beforeJSON = JSON.stringify(before);
let url: string | null = null;
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const r = await ev(`
    (() => {
      const b=new Set(${beforeJSON});
      const f=${IMGS}.map(i=>i.src)
        .filter(s=>s&&(s.includes('oaiusercontent')||s.includes('dalle')||s.includes('backend-api/estuary/content'))&&!b.has(s));
      return f[f.length-1]||null;
    })()`);
  if (r) {
    await new Promise(res=>setTimeout(res,4000));
    url = await ev(`(() => { const b=new Set(${beforeJSON}); const f=${IMGS}.map(i=>i.src).filter(s=>s&&(s.includes('oaiusercontent')||s.includes('dalle')||s.includes('backend-api/estuary/content'))&&!b.has(s)); return f[f.length-1]||null; })()`);
    if (url) break;
  }
  process.stderr.write(".");
  await new Promise(res=>setTimeout(res,3000));
}
console.error("");
if (!url) { console.error("TIMEOUT"); process.exit(3); }

console.error("[5] downloading...");
const dl = await ev(`(async()=>{const r=await fetch(${JSON.stringify(url)});if(!r.ok)return null;const b=await r.arrayBuffer();const u=new Uint8Array(b);let s='';for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return{b64:btoa(s),size:u.length};})()`, true);
if (!dl) { console.error("dl failed"); process.exit(4); }

await Bun.write(out, Buffer.from(dl.b64, "base64"));
const total = ((Date.now()-t0)/1000).toFixed(1);
const gen = ((Date.now()-tSubmit)/1000).toFixed(1);
console.error(`✓ ${(dl.size/1024).toFixed(0)}KB | ${total}s total, ${gen}s gen`);
console.log(out);
ws.close();
