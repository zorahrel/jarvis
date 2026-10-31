// Build a 3-slide IG carousel (1080x1350, 4:5) for a GitHub repo promo.
// Uses file:// URLs (data: URLs were too large for the embedded README).
//
// Rendered with WebKit via Playwright: Chrome/Chromium are banned on this Mac (14/09/2026).
//
// usage: node carousel.js <readme.png> <out_dir> <hook_json> <repo>
const { webkit } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const [README, OUT_DIR, HOOK_JSON, REPO] = args;
if (!README || !OUT_DIR || !HOOK_JSON || !REPO) {
  console.error('usage: node carousel.js <readme.png> <out_dir> <hook_json> <repo>');
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const HOOK = JSON.parse(HOOK_JSON);
const HOOK_TEXT = `${HOOK.line1} ${HOOK.line2}`.toUpperCase();
const HIGHLIGHTS = (HOOK.highlights || []).map(s => s.toUpperCase());

function highlight(text) {
  let out = text;
  for (const term of HIGHLIGHTS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    out = out.replace(re, `<span class="hl">${term}</span>`);
  }
  return out;
}

const HOME = process.env.HOME;
const dashboardPath = path.join(HOME, '.claude/jarvis/docs/images/dashboard-overview.png');

// Pre-crop README hero (skip github navbar ~360px @2x, take next 1500px)
const HERO_CROP = path.join(OUT_DIR, '_hero-crop.png');
console.log('→ cropping hero from README');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', README,
  '-vf', 'crop=1080:750:0:180',
  HERO_CROP,
]);

const slidesDir = fs.mkdtempSync('/tmp/rf-carousel-html-');
function fileUrl(p) { return 'file://' + path.resolve(p); }

let browser;

const COMMON = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:1080px; height:1350px; overflow:hidden; background:#0a0a0a; color:#fff;
           font-family:'Inter', system-ui, sans-serif; position:relative; }
    .anton { font-family:'Anton', 'Impact', sans-serif; font-weight:400; line-height:0.92; letter-spacing:-1px; text-transform:uppercase; }
    .hl { color:#ffd60a; }
    .badge-logo { position:absolute; left:30px; bottom:30px; width:60px; height:60px;
                  background:linear-gradient(135deg, #58a6ff, #a371f7); border-radius:14px;
                  display:flex; align-items:center; justify-content:center;
                  font-family:'Anton',sans-serif; font-size:32px; color:#fff;
                  box-shadow: 0 8px 20px rgba(88,166,255,0.4); z-index:5; }
    .swipe { position:absolute; right:30px; bottom:36px; background:#fff; color:#000;
             padding:12px 22px; border-radius:100px; font-size:20px; font-weight:800;
             text-transform:uppercase; letter-spacing:0.5px; display:flex; align-items:center; gap:8px; z-index:5; }
    .swipe::after { content:'→'; font-size:22px; }
  </style>
`;

const slide1 = `<!doctype html><html><head><meta charset="utf-8">${COMMON}
<style>
  .top { position:absolute; top:0; left:0; right:0; height:600px; overflow:hidden; background:#fff; }
  .top img { width:1080px; display:block; }
  .top::after { content:''; position:absolute; left:0; right:0; bottom:0; height:80px;
                background:linear-gradient(to bottom, transparent, #0a0a0a); }
  .bottom { position:absolute; top:600px; left:0; right:0; bottom:0; padding:40px 50px 110px;
            display:flex; align-items:center; justify-content:center; }
  h1 { font-size:96px; text-align:center; color:#fff; }
</style></head><body>
  <div class="top"><img src="${fileUrl(HERO_CROP)}" alt=""></div>
  <div class="bottom"><h1 class="anton">${highlight(HOOK_TEXT)}</h1></div>
  <div class="badge-logo">JC</div>
  <div class="swipe">Swipe</div>
</body></html>`;

const features = [
  'Telegram, WhatsApp, Discord — one router',
  'Per-route agents with separate memory and tools',
  'Voice, image, PDF pipeline (Whisper, Vision, OCR)',
  'Local semantic search over your Markdown notes',
  'React dashboard at <span class="mono">localhost:3340</span>',
  'Native macOS tray app — no Docker, no cloud',
];

const slide2 = `<!doctype html><html><head><meta charset="utf-8">${COMMON}
<style>
  .pad { padding:80px 60px 110px; }
  .eyebrow { font-size:24px; color:#ffd60a; font-weight:800; letter-spacing:3px; text-transform:uppercase; margin-bottom:18px; }
  h2 { font-size:78px; color:#fff; margin-bottom:30px; max-width:880px; }
  .lead { font-size:30px; line-height:1.4; color:#c9d1d9; margin-bottom:36px; max-width:920px; }
  .lead b { color:#fff; }
  ul { list-style:none; display:grid; grid-template-columns:1fr; gap:18px; max-width:760px; }
  li { display:flex; align-items:flex-start; gap:18px; font-size:28px; line-height:1.35; color:#fff; }
  .dot { flex:0 0 14px; width:14px; height:14px; border-radius:50%;
         background:#3fb950; margin-top:14px; box-shadow:0 0 12px rgba(63,185,80,0.5); }
  .mono { font-family:'JetBrains Mono', monospace; background:rgba(255,255,255,0.08);
          padding:2px 8px; border-radius:6px; font-size:24px; }
  .imgrow { position:absolute; right:-50px; bottom:120px; width:380px; border-radius:18px; overflow:hidden;
            box-shadow:0 30px 80px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.1);
            transform:rotate(4deg); }
  .imgrow img { width:100%; display:block; }
</style></head><body>
  <div class="pad">
    <div class="eyebrow">/// What you get</div>
    <h2 class="anton">A real <span class="hl">multi-channel</span> router for Claude Code</h2>
    <p class="lead">Built on the Claude Code CLI. Uses <b>your subscription</b>, not metered API keys. <b>Zero per-token costs.</b></p>
    <ul>${features.map(f => `<li><span class="dot"></span>${f}</li>`).join('')}</ul>
  </div>
  ${fs.existsSync(dashboardPath) ? `<div class="imgrow"><img src="${fileUrl(dashboardPath)}" alt=""></div>` : ''}
  <div class="badge-logo">JC</div>
  <div class="swipe">Swipe</div>
</body></html>`;

const slide3 = `<!doctype html><html><head><meta charset="utf-8">${COMMON}
<style>
  body { background:radial-gradient(circle at 30% 20%, #1f6feb33, #0a0a0a 60%); }
  .center { position:absolute; inset:0; padding:90px 60px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:36px; }
  .badge { background:#ffd60a; color:#0a0a0a; padding:12px 30px; border-radius:100px;
           font-size:22px; font-weight:900; text-transform:uppercase; letter-spacing:1.5px; }
  h3 { font-size:140px; color:#fff; text-align:center; line-height:0.9; }
  .repo { display:flex; align-items:center; gap:14px; padding:24px 38px; background:#0d1117;
          border:2px solid #30363d; border-radius:14px;
          font-family:'JetBrains Mono', monospace; font-size:34px; color:#58a6ff; font-weight:500;
          box-shadow: 0 20px 50px rgba(0,0,0,0.6); }
  .repo svg { width:42px; height:42px; }
  .sub { font-size:30px; text-align:center; color:#c9d1d9; max-width:880px; line-height:1.4; }
  .sub b { color:#ffd60a; }
  .footer { position:absolute; bottom:50px; left:0; right:0; text-align:center;
            font-size:22px; color:#8b949e; }
  .footer b { color:#ffd60a; }
</style></head><body>
  <div class="center">
    <div class="badge">⭐ Open-source · MIT</div>
    <h3 class="anton">Star the repo<br>if you <span class="hl">like it</span>.</h3>
    <div class="repo">
      <svg viewBox="0 0 24 24" fill="#fff"><path d="M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.9 2.9 1.4 3.6 1 .1-.8.4-1.4.8-1.7-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0012 .3"/></svg>
      ${REPO}
    </div>
    <p class="sub"><b>Multi-channel router for Claude Code</b><br>Telegram · WhatsApp · Discord<br>Uses your Claude sub. Zero per-token costs.</p>
  </div>
  <div class="footer">github.com/${REPO} &nbsp;·&nbsp; <b>Save this post</b> for later</div>
</body></html>`;

async function renderSlide(html, name) {
  const htmlPath = path.join(slidesDir, `${name}.html`);
  fs.writeFileSync(htmlPath, html);
  const out = path.join(OUT_DIR, `${name}.png`);
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
  try {
    await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: out });
    console.log(`✓ ${out}`);
  } finally {
    await page.close();
  }
}

async function run() {
  browser = await webkit.launch({ headless: true });
  await renderSlide(slide1, '01-hook');
  await renderSlide(slide2, '02-features');
  await renderSlide(slide3, '03-cta');
}

run()
  .catch(e => { console.error('FAIL:', e.message || e); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(slidesDir, { recursive: true, force: true });
  });
