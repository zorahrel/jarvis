// Reference-conditioned image editing via Gemini Nano Banana (web UI).
// Attaches each scene + a reference image, asks to change ONLY the target, downloads the result.
// See ../SKILL.md. Requires a logged-in Google storageState (Gemini gates all tools behind login).
import { createRequire } from "module";
import { writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, basename, extname, isAbsolute } from "path";
const require = createRequire(homedir() + "/.claude/jarvis/mcp-servers/jarvis-browser/");
// WebKit: Chrome/Chromium are banned on this Mac (14/09/2026).
const { webkit } = require("playwright");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
const SCENES = arg("scenes");
const REF = arg("ref");
const OUT = arg("out", process.cwd());
const TASK = arg("task", "Replace the brand logo in the first image with the logo from the second image. Keep everything else identical — composition, lighting, perspective, colors. Output the edited photo in high resolution.");
const STATE = arg("state", join(homedir(), ".claude/jarvis/state/browser-states/gemini.json"));
const only = arg("only") ? new Set(arg("only").split(",")) : null;
if (!SCENES || !REF) { console.error("usage: gemini-edit.mjs --scenes <dir|file> --ref <img> --out <dir> --task <text> [--state <json>] [--only ids]"); process.exit(1); }
const abs = (p) => (isAbsolute(p) ? p : join(process.cwd(), p));
const EDITOR = 'div.ql-editor, [contenteditable="true"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

const scenePaths = (() => {
  const s = abs(SCENES);
  if (statSync(s).isDirectory()) return readdirSync(s).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => join(s, f));
  return [s];
})().filter((p) => !only || only.has(basename(p, extname(p))));
mkdirSync(abs(OUT), { recursive: true });

const browser = await webkit.launch({ headless: true });
const ctx = await browser.newContext({ storageState: existsSync(STATE) ? STATE : undefined, viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();

async function ready() {
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 20; i++) { if (await page.locator(EDITOR).first().isVisible().catch(() => false)) return true; await sleep(2000); }
  return await page.locator(EDITOR).first().isVisible().catch(() => false);
}
async function attach(files) {
  let chooser = null;
  page.once("filechooser", (fc) => { chooser = fc; });
  await page.getByRole("button", { name: /Upload & tools|Caricamento e strumenti|Add files/i }).first().click({ timeout: 15000 });
  await sleep(1500);
  for (const re of [/^Upload files?$/i, /Upload from computer/i, /More uploads/i, /Carica file/i]) {
    const mi = page.getByText(re).first();
    if (await mi.isVisible().catch(() => false)) { await mi.click().catch(() => {}); await sleep(1500); break; }
  }
  const acc = page.getByRole("button", { name: /Accept|Got it|Accetta|Continue/i }).first();
  if (await acc.isVisible().catch(() => false)) { await acc.click().catch(() => {}); await sleep(2000); }
  for (let i = 0; i < 12 && !chooser; i++) await sleep(800);
  if (chooser) { await chooser.setFiles(files); return "filechooser"; }
  const fi = page.locator('input[type=file]');
  if (await fi.count()) { await fi.first().setInputFiles(files); return "input"; }
  throw new Error("no upload trigger (logged out? re-capture the Gemini session — see SKILL.md)");
}
async function imgs() {
  return page.evaluate(() => [...document.querySelectorAll("img")]
    .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth }))
    .filter((o) => o.src && (o.src.startsWith("http") || o.src.startsWith("blob:")) && !o.src.includes("gstatic.com/lamda") && !o.src.includes("googleusercontent.com/a/")));
}
async function download(src, out) {
  if (src.startsWith("blob:")) {
    const b64 = await page.evaluate(async (s) => { const r = await fetch(s); const b = await r.arrayBuffer(); let bin = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]); return btoa(bin); }, src);
    writeFileSync(out, Buffer.from(b64, "base64")); return Buffer.from(b64, "base64").length;
  }
  const resp = await ctx.request.get(src); const buf = await resp.body(); writeFileSync(out, buf); return buf.length;
}

if (!(await ready())) { log("FAIL: Gemini composer not available"); await browser.close(); process.exit(2); }
log(`Gemini ready — ${scenePaths.length} scene(s)`);
let ok = 0;
for (const scene of scenePaths) {
  const id = basename(scene, extname(scene));
  log(`=== ${id} ===`);
  try {
    await ready(); await sleep(1200);
    const how = await attach([scene, abs(REF)]);
    log(`  attached (${how})`); await sleep(6000);
    const pre = new Set((await imgs()).map((o) => o.src));
    await page.locator(EDITOR).first().click();
    await page.keyboard.insertText(TASK);
    await sleep(800);
    await page.keyboard.press("Enter");
    let url = null;
    for (let i = 0; i < 80; i++) {
      await sleep(3000);
      const neu = (await imgs()).filter((o) => !pre.has(o.src) && o.w >= 400);
      if (neu.length) { await sleep(4000); const c2 = (await imgs()).filter((o) => !pre.has(o.src) && o.w >= 400); url = (c2[c2.length - 1] || neu[neu.length - 1]).src; break; }
    }
    if (!url) { log(`  timeout ${id}`); await page.screenshot({ path: "/tmp/gem_err.png" }).catch(() => {}); continue; }
    const outPath = join(abs(OUT), id + ".png");
    const n = await download(url, outPath);
    log(`  ✓ ${id}.png (${Math.round(n / 1024)} KB)`);
    console.log(outPath);
    ok++; await sleep(2000);
  } catch (e) { log(`  ERROR ${id}: ${String(e.message).slice(0, 160)}`); await page.screenshot({ path: "/tmp/gem_err.png" }).catch(() => {}); }
}
log(`[done] ${ok}/${scenePaths.length}`);
await browser.close();
