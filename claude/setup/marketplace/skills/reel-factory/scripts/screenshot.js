// Full-page PNG at 1080w (2x) with WebKit via Playwright.
// Chrome/Chromium are banned on this Mac (14/09/2026): see ~/.claude/jarvis/memory/tools/browser.md
// usage: node screenshot.js <URL> <OUT_PATH> [MIN_HEIGHT] [--mobile]
const { webkit } = require('playwright-core');

const args = process.argv.slice(2);
const MOBILE = args.includes('--mobile');
const positional = args.filter(a => !a.startsWith('--'));
const [URL, OUT, MIN_H_ARG] = positional;
if (!URL || !OUT) {
  console.error('usage: node screenshot.js <URL> <OUT_PATH> [MIN_HEIGHT] [--mobile]');
  process.exit(1);
}
const MIN_H = parseInt(MIN_H_ARG || '4000', 10);
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WIDTH = MOBILE ? 540 : 1080;

async function run() {
  const browser = await webkit.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: WIDTH, height: MOBILE ? 960 : 1920 },
      deviceScaleFactor: 2,
      ...(MOBILE ? { isMobile: true, userAgent: IPHONE_UA } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2500);

    // Scroll to bottom to trigger lazy loaders
    await page.evaluate(async () => {
      await new Promise(r => { let y = 0; const id = setInterval(() => { window.scrollTo(0, y); y += 800; if (y > document.body.scrollHeight) { clearInterval(id); r(); } }, 80); });
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);

    // Measure full content height; the viewport grows to it so the PNG is exactly that tall
    const contentH = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const fullH = Math.max(contentH, MIN_H);
    await page.setViewportSize({ width: WIDTH, height: fullH });
    await page.waitForTimeout(800);

    await page.screenshot({ path: OUT });
    console.log(`${OUT} ${fullH}`);
  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error(e.message || e); process.exitCode = 1; });
