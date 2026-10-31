// Barra del guardiano di run.ts: chiude il Chrome fermo, non quello in uso, muore con lui,
// lascia il posto al guardiano di un giro piu' nuovo, regge un Chrome lento e due giri
// sovrapposti. Exit 0 = verde.
// Niente Chrome vero: un CDP finto (Bun.serve) risponde a /json/version e registra Browser.close.
// Uso: bun watchdog-test.ts   (~12 s, sette casi in parallelo)
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const RUN = join(import.meta.dir, "run.ts");
const IDLE_MIN = 0.05; // 3 s di soglia, giro del guardiano ogni 0,75 s
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const homes: string[] = [];

// slow: quante risposte a /json/version arrivano dopo 2 s (oltre il tetto di 1,5 s del guardiano).
// /json resta in sospeso finche' il test non chiama release(): e' il giro vero "al lavoro";
// poi risponde 404 e il giro esce con un errore, passando dal suo handler di exit.
function fakeChrome(slow = 0) {
  let closed = 0;
  const held: (() => void)[] = [];
  const srv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/json/version") {
        if (slow-- > 0) await sleep(2000);
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/x` });
      }
      if (path === "/json") { await new Promise<void>(r => held.push(r)); return new Response("", { status: 404 }); }
      if (server.upgrade(req)) return;
      return new Response("", { status: 404 });
    },
    websocket: {
      message(ws, m) {
        if (JSON.parse(String(m)).method !== "Browser.close") return;
        closed++;
        setTimeout(() => srv.stop(true), 50); // come Chrome: dopo Browser.close la porta sparisce
      },
    },
  });
  return { port: srv.port, stop: () => srv.stop(true), closed: () => closed, held };
}

// Un giro vero di run.ts sul CDP finto. sandbox-exec nega /usr/bin/open: se il CDP finto
// tardasse, run.ts non puo' aprire un Chrome vero sullo schermo di Attilio.
const NO_OPEN = '(version 1)(allow default)(deny process-exec (literal "/usr/bin/open"))';
function runGiro(chrome: { port: number }, home: string) {
  return Bun.spawn(["/usr/bin/sandbox-exec", "-p", NO_OPEN, process.execPath, RUN, "prova",
    "--port", String(chrome.port), "--idle-min", String(IDLE_MIN)],
    { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
}
// guardiani vivi su quella porta (lanciati staccati dal giro: il test non ha i loro pid)
const guardians = (port: number) =>
  String(spawnSync("/usr/bin/pgrep", ["-f", `watchdog [^ ]+ --port ${port} `]).stdout).trim().split("\n").filter(Boolean).length;
async function until(f: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (f()) return true;
  return f();
}

function start(chrome: { port: number }, token: string) {
  const home = mkdtempSync(join(tmpdir(), "cgi-wd-")); homes.push(home);
  const stamp = join(home, ".cache/cdp-mcp", `skill-last-use-${chrome.port}`);
  mkdirSync(join(home, ".cache/cdp-mcp"), { recursive: true });
  writeFileSync(stamp, token);
  const p = Bun.spawn([process.execPath, RUN, "--watchdog", token, "--port", String(chrome.port), "--idle-min", String(IDLE_MIN)],
    { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
  return { p, stamp, t0: Date.now() };
}

async function exitWithin(p: ReturnType<typeof Bun.spawn>, ms: number): Promise<number | null> {
  const r = await Promise.race([p.exited, sleep(ms).then(() => null)]);
  if (r === null) p.kill();
  return r;
}

const cases: Record<string, () => Promise<string | null>> = {
  // fermo oltre la soglia: Browser.close una volta, poi il guardiano esce
  async fermo() {
    const c = fakeChrome(); const w = start(c, "T");
    const rc = await exitWithin(w.p, 9000); const dt = Date.now() - w.t0;
    if (rc !== 0) return `exit ${rc}`;
    if (c.closed() !== 1) return `Browser.close mandati: ${c.closed()}`;
    if (dt < 2900) return `chiuso dopo ${dt} ms, prima della soglia`;
    return null;
  },
  // in uso (stamp toccato ogni 0,5 s per 5 s): non chiude; smesso l'uso, chiude
  async inUso() {
    const c = fakeChrome(); const w = start(c, "T");
    for (let i = 0; i < 10; i++) { await sleep(500); const now = new Date(); utimesSync(w.stamp, now, now); }
    if (c.closed() !== 0) return "chiuso mentre era in uso";
    const rc = await exitWithin(w.p, 8000);
    if (rc !== 0 || c.closed() !== 1) return `dopo l'uso: exit ${rc}, close ${c.closed()}`;
    return null;
  },
  // Chrome chiuso da fuori: il guardiano muore con lui, senza mandare niente
  async chromeMorto() {
    const c = fakeChrome(); const w = start(c, "T");
    await sleep(1000); c.stop();
    const rc = await exitWithin(w.p, 3000);
    if (rc !== 0) return `non e' uscito (exit ${rc})`;
    return null;
  },
  // un giro piu' nuovo ha scritto il suo token: il vecchio guardiano esce senza chiudere
  async giroNuovo() {
    const c = fakeChrome(); const w = start(c, "T1");
    await sleep(300); writeFileSync(w.stamp, "T2");
    const rc = await exitWithin(w.p, 3000);
    const closed = c.closed(); c.stop();
    if (rc !== 0 || closed !== 0) return `exit ${rc}, close ${closed}`;
    return null;
  },
  // due risposte lente di fila (Mac in swap): Chrome e' vivo, il guardiano resta e poi lo chiude
  async chromeLento() {
    const c = fakeChrome(2); const w = start(c, "T");
    const rc = await exitWithin(w.p, 12000);
    if (rc !== 0 || c.closed() !== 1) { c.stop(); return `exit ${rc}, close ${c.closed()}`; }
    return null;
  },
  // Chrome appeso (la porta accetta ma non risponde mai): il guardiano non resta vivo per sempre
  async chromeAppeso() {
    const c = fakeChrome(1e9); const w = start(c, "T");
    const rc = await exitWithin(w.p, 12000); c.stop();
    if (rc !== 1 || c.closed() !== 0) return `exit ${rc}, close ${c.closed()}`;
    return null;
  },
  // B parte mentre A lavora, poi A finisce: il guardiano di B deve restare e chiudere Chrome
  async giriSovrapposti() {
    const c = fakeChrome();
    const home = mkdtempSync(join(tmpdir(), "cgi-wd-")); homes.push(home);
    try {
      const a = runGiro(c, home);
      if (!(await until(() => c.held.length === 1, 8000))) return "il giro A non e' arrivato al lavoro";
      const b = runGiro(c, home);
      if (!(await until(() => c.held.length === 2, 8000))) return "il giro B non e' arrivato al lavoro";
      if (!(await until(() => guardians(c.port) === 1, 5000))) return `guardiani dopo il giro B: ${guardians(c.port)}`;
      c.held[0](); await a.exited;
      await sleep(1600); // due controlli del guardiano di B mentre B lavora ancora
      if (guardians(c.port) !== 1) return `finito A, guardiani vivi: ${guardians(c.port)}`;
      c.held[1](); await b.exited;
      if (!(await until(() => c.closed() === 1, 8000))) return `Browser.close mandati: ${c.closed()}`;
      if (!(await until(() => guardians(c.port) === 0, 3000))) return `dopo la chiusura, guardiani vivi: ${guardians(c.port)}`;
      return null;
    } finally { c.stop(); }
  },
};

const res = await Promise.all(Object.entries(cases).map(async ([k, f]) => [k, await f()] as const));
for (const h of homes) rmSync(h, { recursive: true, force: true });
let bad = 0;
for (const [k, err] of res) if (err) { console.log(`SBAGLIATO ${k}: ${err}`); bad = 1; }
if (!bad) console.log("chatgpt-image watchdog ok");
process.exit(bad);
