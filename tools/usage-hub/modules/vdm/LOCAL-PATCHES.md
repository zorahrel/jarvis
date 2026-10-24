# Local patches to VDM

`vdm upgrade` overwrites `vdm`, `dashboard.mjs`, and `lib.mjs`. Re-apply anything listed here after an upgrade.
Backups of the pre-patch files: `dashboard.mjs.bak-20260807-025822` (first patch round),
`dashboard.mjs.bak-20260811-003143` + `lib.mjs.bak-20260811-003143` (second round).

**`lib.mjs` is now patched too** — it wasn't before 11/08. An upgrade that replaces it
takes the usage caps and the attribution maths with it, and `dashboard.mjs` will fail to
start on the missing imports rather than degrading quietly. `test/` is local-only and
survives an upgrade; run it first after re-applying:

    node --test "test/*.test.mjs"      # 181 unit tests, all local
    node test/layout-check.mjs         # real browser, 12 viewport widths (daemon must be up)

---

## 2026-10-24 - strategia `margin`: un account alla volta veniva svuotato

**Sintomo:** dal registro di VDM della settimana 18-24/10, un solo account per volta prendeva
tutto: zorahrel il 18-21/10 (100% col 43% di settimana), attilio il 21-23/10 (99% col 41%),
poi hi. `reset-first` sceglie chi si azzera prima anche quando corre oltre il ritmo, e lo tiene
finché non è pieno.

**Fix:** `lib.mjs`: `weeklyMargin()` = quota settimanale che resta, in % al giorno fino al
reset (reset ignoto = 100% su 7 giorni); `pickMostMargin()` sceglie il margine più alto fra
gli account selezionabili sotto il 90%; strategia `margin` in `pickByStrategy` con isteresi
1,25 (si lascia l'attivo solo se un altro ha un quarto di margine in più: ogni cambio fa
perdere la cache dei prompt a tutte le sessioni), uscita immediata se l'attivo ha la settimana
piena o il modello in pausa; quando l'attivo non è disponibile il sostituto lo sceglie il
margine, non la 5h più bassa. Margine sotto 100/7 = oltre il ritmo, sopra = in linea, quindi
non si sceglie mai un account che corre se un altro è in linea; a poche ore dal reset la quota
avanzata pesa di più da sola (usa-o-perdi). `vdm`: la CLI accetta `reset-first` e `margin`.
Il gate del hub (`src/pacing.mjs`) ordina gli account con lo stesso conto e la stessa isteresi.

**Prova:** `test/margin.test.mjs` (8 controlli; uno mostra che `reset-first` sceglie l'account
che corre). Suite seriale 359/359. Daemon riavviato il 24/10 alle 02:38 a richieste ferme,
`vdm config rotation margin`.

---

## 2026-10-03 - un reset esterno lascia l'account bloccato fino al vecchio retry-after

**Causa:** il probe riportava `allowed`, 5h 0% e 7d 0%, mentre il picker conservava
un cooldown account-wide di due giorni. La pulizia esisteva solo all'avvio.

**Fix:** `reconcileFromProbe()` applica lo stesso criterio dell'avvio durante il
funzionamento: blocco `model` account-wide con almeno 1h residua, entrambe le
utilizzazioni realmente ricevute, finite, non negative e sotto il 90%, stato raw
`allowed`. Cancella il cooldown, persiste lo stato e poi sveglia le richieste in
attesa. I veri blocchi per modello, Extra Usage, permessi e burst brevi restano.
Lo sweep ricontrolla questi blocchi ogni 2 minuti anche senza dashboard aperta,
saltando gli account disabilitati; con la cache di 5 minuti il reset viene rilevato
entro circa 6 minuti, se Anthropic risponde normalmente.

**Prova:** `test/quota-reset.test.mjs` fallisce sul codice precedente (3 fail su 9)
e passa sul fix. Suite seriale completa: 332/332. Patch installata nel daemon;
richiesta reale `claude-opus-5-5` attraverso VDM: HTTP 200 in 4,598 s.

---

## 2026-09-25 (later) - the hold let go one second before the account came back

**Symptom:** at every 5h reset of the day (05:20, 10:20) every parked request got
`hold expired after Nmin — returning 429` instead of resuming, and requests arriving in
that same second were parked for `0s` and failed too. Claude Code retried its way out,
but each reset turned a clean resume into a burst of errors.

**Cause:** `holdOutlook()` ended the hold at the account's `retryAfter` (a 429 at 14:31:16
with retry-after 2923s → 15:19:59.x), while `isAccountAvailable()` also waits out the
reset second (`resetAt >= nowSec`, resetAt = 15:20:00). The final check of the wait ran
inside that gap, found nothing selectable, and answered 429.

**Fix:** `accountFreeAt()` in `lib.mjs` returns the first instant `isAccountAvailable()`
flips: max(retryAfter + 1 ms, (resetAt + 1) s). `holdOutlook()` uses it.

**Proof:** `test/hold-release.test.mjs` (4 checks) was run against the old formula first:
3 fail. Suite 323/323. Live: the kickstart at 14:57 re-parked 16 waiting sessions; the
15:20 reset is the check (see the log line `released after ... — resuming`).

---

## 2026-09-25 - a 429 on one model froze the whole account, and every session, for 5 days

**Symptom:** every Claude Code session hung. The log repeated `holding request — 1 account
over cap, 2 rate-limited; waiting up to 24h`, and `vdm list` marked account-a@example.com
"non selezionabile" until Wednesday. Yet that account had room: 5h at 2%, 7d at 0%.

**Cause:** at 00:22 Anthropic answered one request 429 with `retry-after: 452236` (5.2
days, exactly the weekly reset) while both plan windows were free. That shape is a wall on
ONE model (a weekly model cap, the 1M-context variant), not on the account. VDM filed it as
the account's own cooldown: out of rotation for every model, and with the other two
accounts genuinely spent (account-b@example.com at 7d 100%, the third account over its own 27% cap) the
hold gate parked every request. The Haiku probe cannot lift an Opus cooldown by design, so
nothing would have cleared it before Wednesday. And the 429 was not even durable:
`opus[1m]` answered on the same account half an hour later.

**Fix:**
- `lib.mjs`: `requestModelKey` (model family, `-1m` with the 1M beta), `isPerModel429`
  (retry-after >= 1h and plan windows < 90%, read from the 429's own headers or a reading
  under 30 min old), `createModelBlocks` (pauses by account NAME, which survives token
  refreshes; one request every 10 min tests a pause again), `isMisfiledModelCooldown`.
- `dashboard.mjs`: a per-model 429 is filed in `model-blocks.json`, not as the account's
  cooldown; requests for that model count paused accounts as already tried (every picker,
  the strategy pick, the balance slot, the bulk-refresh reset); a 2xx for that model lifts
  the pause; if no account is left for the model, the answer is a 429 NOW naming the model
  and when it returns (or Anthropic's own 429, logged with its body), never a 24h hold. At
  startup, a persisted account-wide `model` cooldown with free windows and >= 1h left is
  dropped. The card shows "In pausa solo per ... Gli altri modelli continuano".
- `vdm` + `vdm-helper.mjs`: `vdm list` prints the per-model pauses; `block-state` reads the
  windows before trusting kind `model`, which every account-wide 429 used to be filed as
  (account-b@example.com at 7d 100% read "rate limit sul singolo modello").

**Proof:** `node --test "test/*.test.mjs"` → 313 pass, 2 fail (both pre-existing: they read
`install.sh`/`uninstall.sh`, which are not in this directory). `test/model-blocks.test.mjs`
(9 checks, the incident's own numbers) was watched failing first. After the kickstart the
log reads `account-a@example.com: dropped an account-wide cooldown with free plan windows
(125.1h left)`, and `claude -p` through the proxy on `opus[1m]` answered in 6.8 s, exit 0.
Backups: `*.bak-20260925-model-blocks` for all four files.

---

## 2026-09-13 — keychain read asks for our own account first

`readKeychain` looked the item up by service only, and the Keychain returns whichever
`Claude Code-credentials` item it meets first. On 2026-09-11 21:42Z Claude Code 2.1.269
(a Bun binary: with USER unset `os.userInfo().username` is "unknown") ran under `env -i`,
found a dead token in the legacy `~/.claude/.credentials.json`, wrote a blank item under
account "unknown" and deleted the file. For 35 hours vdm read that item: `/health` said
`activeToken: "missing"`, refreshes stopped updating the keychain, and every downstream
reader (Topics' native runtime, the jcode mirror) was stuck on a dead token while the item
vdm writes under `currentUser()` was live. Now the read passes `-a KEYCHAIN_ACCOUNT` and
falls back to the service-only lookup only when no item exists under that account (exit 44).
Regression: `test/keychain-account.test.mjs` (fake `security` on PATH; fails on the old read).

## 2026-09-01 - a transport timeout must not escape the VDM proxy

**Symptom:** a burst of `ETIMEDOUT` responses made VDM rotate through every
saved account, then retry the original client authorization directly against
Anthropic. After three such failures its circuit breaker kept that passthrough
mode on for two minutes. The proxy was healthy, but account rotation had been
silently bypassed.

**Cause:** a TCP/DNS failure happens before Anthropic can inspect a bearer token.
Changing account cannot repair it, and the final `_passthroughFallback()` used
the caller's original `Authorization` header instead of VDM's selected account.

**Fix:** the `lastNetworkError` branch retries its selected account once, then
returns `503` with `Retry-After: 1`. It never switches the Keychain account,
opens the bypass circuit, or forwards the original authorization. A normal
credential-recovery fallback remains available for actual authentication cases.

**Regression:** `test/network-fail-closed.test.mjs` pins the live branch: no
passthrough or account selection, and a retryable `503` that explicitly remains
on VDM routing.

---

## 2026-08-26 - `vdm switch` must write compact JSON to Keychain

**Symptom:** immediately after a manual `vdm switch`, both the dashboard and
`jcode-auth-sync.py` stopped recognizing the active credentials. The saved profile was
valid; the Keychain value was not parseable as JSON on read.

**Cause:** profile files are pretty-printed JSON. macOS `security` renders a generic
password containing line breaks as hexadecimal text when read with `-w`, while both VDM's
dashboard and the jcode follower expect a JSON object. The CLI wrapper still used the old
delete-then-add writer, unlike the hardened dashboard writer.

**Fix:** `vdm` now parses and reserializes the profile as one-line JSON before writing it,
uses `add-generic-password -U` to avoid the delete/read race, and silences the Keychain
tool's item dump. This keeps the CLI switch, dashboard, and jcode sync on the same wire
format.

**Proof:** switch to a saved profile, run `jcode-auth-sync.py`, then verify the jcode
credential matches the Keychain without printing either value. The dashboard's active card
must move to the selected profile as well.

---

## 2026-08-25 - an OpenClaw 400 must not rotate the active account

**Symptom:** an OpenClaw `claude-cli` request received Anthropic's `400
invalid_request_error: "You're out of extra usage"`. VDM treated the words as
billing, put the active account in cooldown, and switched the Keychain to the
next account. A request/configuration error must never mutate account selection.

**Why this needs a special case:** Anthropic intentionally uses that exact billing
sentence when a native Messages request declares a reserved tool name matching
`mcp_(?!_)[A-Za-z]` (for example `mcp_call`). That is a schema rejection. The
existing OpenAI-compatible conversion already aliases those names, but native
`/v1/messages` payloads previously reached the 400 billing classifier unchanged.

**Specific schema fix:** `requestHasReservedMcpToolName()` inspects only the native `tools`,
forced `tool_choice`, and historical `tool_use` blocks. When the exact ambiguous
`invalid_request_error` + `extra usage` combination has that evidence, VDM returns
the original 400 immediately: no cooldown, refresh, Keychain write, or failover.
The accepted real-MCP form `mcp__server__tool` is deliberately ignored. A genuine
Extra Usage exhaustion with no reserved name still follows normal account failover
for ordinary VDM clients.

**OpenClaw service isolation:** VDM already sees Claude Code's `working directory`
in native request system text. For `~/.openclaw`, an ambiguous `extra usage` 400
can try an otherwise available account in-memory, but never writes the Keychain,
marks an account unavailable, opens the global 400 circuit, or emits an account
switch. If no account answers, the original 400 returns to OpenClaw untouched.
This preserves genuine spare-account recovery without a background OpenClaw turn
changing the account used by interactive VDM clients.

**Regression:** `test/reserved-mcp-tool-names.test.mjs` executes the production
detector against definitions, forced choice, and transcript; it also pins the
early return before the billing/switch branch, plus the real-billing control and
the OpenClaw isolated-retry path.

---

## 2026-08-24 - `mcp_*` tool names are reserved upstream, and the rejection lies

**Symptom:** every jcode request on the `vdm` profile came back

    400  You're out of extra usage. Add more at claude.ai/settings/usage and keep going.

so all four accounts were marked billing-unavailable in turn and the proxy ended up parking
requests with "3 accounts rate-limited, waiting up to 24h". It read as an exhausted
subscription, and the Extra Usage failover shipped earlier the same day (below) was doing
exactly what it was told with a wrong premise.

**It was not quota.** Same token, same second, straight to `api.anthropic.com`: a two-line
`/v1/messages` request returned 200 while jcode's 66 KB request returned 400. Replaying
jcode's own captured body and bisecting it isolated the `tools` array, then a single tool:

    tools = [mcp_call]     -> 400        tools = [any other jcode tool]  -> 200

**Cause:** Anthropic reserves the `mcp_` prefix for its MCP connector and rejects a tool
list that declares one, reporting a *schema* rejection with a *billing* sentence and no
hint of the offending field. jcode ships two such tools, `mcp_call` and `mcp_search`, so
100% of its full-toolset requests on this route failed. Measured name by name, live:

    mcp_call / mcp_search / mcp_x / mcp_a / mcp_call_x  -> 400
    mcp / mcpfoo / mcpcall / mcp-call / MCP_call        -> 200
    mcp__gateway__x / mcp_ / mcp_1 / jcode_mcp_call     -> 200

The rejected shape is `mcp_` followed by a letter. Notably `mcp__server__tool` (double
underscore) is accepted, which is what Claude Code's real MCP tools use - renaming those
would break tool routing for nothing.

**Fix:** on the OpenAI-compatible route the proxy renames a reserved tool to
`vdmt_<name>` on the way out and restores the original on the way back. Three call sites,
because a name appears in three places and missing one is silent: the tool definitions
(plus a forced `tool_choice`), the assistant transcript of earlier `tool_use` blocks (a
history naming `mcp_call` is rejected exactly like a declaration), and both return paths -
the JSON response and the SSE stream. jcode always streams, so a fix covering only the JSON
path would have fixed nothing in practice.

The native `/v1/messages` route is deliberately untouched: Claude Code's MCP tools arrive as
`mcp__server__tool`, which upstream accepts.

**Regression:** `test/reserved-mcp-tool-names.test.mjs`. It extracts the real functions out
of `dashboard.mjs` instead of mirroring them, so it cannot pass while production is broken -
verified by running it against the pre-fix file, where it fails. Suite: 175/175.

**Proof it works:** `jcode run --provider-profile vdm -m claude-opus-5` returns exit 0; a
bash tool call really executed and left the file on disk; and asking jcode to use
`mcp_search` worked, i.e. the alias is invisible to the caller.

---

## 2026-08-24 - exhausted Extra Usage was treated as a malformed request

**Symptom:** jcode's `vdm` profile returned `400 Bad Request`, rendered as a local-endpoint
failure, while both the dashboard (`:3335`) and proxy (`:3336`) were healthy. The actual
upstream body was:

    You're out of extra usage. Add more at claude.ai/settings/usage and keep going.

The active account had spent its paid allowance, but VDM did not move to another available
account. The dashboard was therefore accurately healthy and unhelpfully green.

**Cause:** the 400 recovery branch only recognized billing wording such as `credit balance`,
`billing issue`, and `payment required`. Anthropic's subscription exhaustion is an
`invalid_request_error` containing `extra usage`, so it hit the ordinary malformed-request
passthrough before the switch logic.

**Patch:** `isBillingError` in `dashboard.mjs` also matches `extra usage`. That marks the
current account temporarily unavailable and proceeds to Strategy 3, the normal automatic
account failover.

**Follow-up, same incident:** every enabled account can independently have no extra usage.
The old Strategy 3 then used `pickAnyUntried()` after the selectable picker returned no
candidate, which walked into an account already blocked on its 7d quota merely because it
had not yet been tried. Billing errors now use only `pickBestAccount()`; when none remains,
VDM returns Anthropic's original 400 rather than proxying jcode's local placeholder key and
turning the useful cause into a false `401 Invalid bearer token`.

`test/extra-usage-failover.test.mjs` executes the production classifier against the exact
Anthropic message, pins the no-limited-account fallback, and verifies the original 400 is
kept.

**Dashboard correction:** the 5h and weekly bars are Anthropic plan-window rate limits.
They can be green while the distinct Extra Usage allowance that third-party apps consume is
empty. A billing error now persists `blockKind: extra-usage`; the card renders a red
`Extra usage exhausted` badge plus this distinction, and the global banner says only
`No selectable accounts` rather than claiming every case is a rate limit. This state survives
a proxy restart. A healthy Haiku plan probe now retains the `extra-usage` marker after its
retry cooldown; only a real model response can clear it, because the probe cannot observe that
separate allowance. Suite: **163 green**.

---

## 2026-08-24 - a real Claude outage looked like a VDM endpoint failure

**Symptom:** Anthropic returned HTTP `529 overloaded` during its service incident. The SSE
form of the same failure was already retried before any response reached jcode, but the HTTP
form was forwarded immediately. jcode therefore presented the local VDM endpoint as failed,
even though a different account could not fix an upstream capacity outage.

`lib.mjs` now owns the shared retry policy: only HTTP `500`, `502`, `503`, `504`, and `529`
are transient upstream capacity statuses; their bounded backoff is **1s / 2s / 4s**. VDM
retries the **same account** before sending any bytes downstream, deliberately never rotates
accounts. Once the budget is exhausted it retains Anthropic's original response and adds
`Retry-After: 5` if the upstream omitted it, so jcode has an honest retry signal.

`test/upstream-capacity-retry.test.mjs` pins the status boundary, the deadline-safe budget,
same-account/no-rotation branch, and terminal `Retry-After`. Suite: **168 green**.

---

## 2026-08-18 - HTTP 200 with the failure inside the stream, and nobody retried it

**The symptom:** every live session went Idle at 01:08 and stayed there. Not a crash, not
an error dialog - the turn simply ended and the session waited for a human. Thirteen
minutes later the user pressed enter and it resumed. Nine occurrences between 01:04 and
01:08, hitting gorilla, spider and microbe within eight seconds of each other.

Quota was not involved: the accounts in use were at 55% and 24%.

**What Anthropic actually sends.** Status line `200 OK`, stream opens, and about a second
later the failure arrives *inside the body*:

    HTTP connection established in 1292ms (status=200 OK)
    [ERROR] ... error=Overloaded elapsed_ms=1322 phase=stream_error
    Processing task completed with error for message id=33: Overloaded
    → status: Idle

**Why nothing recovered.** Both retry mechanisms look at the status line and nothing else:

- the proxy's overload branch matches `status === 529`, so a 200 never reaches it and the
  event is forwarded verbatim;
- jcode reads a 200 as success, so `max_retries = 8` never engages - the log stays on
  `attempt 1/8` for the whole episode.

An overload is transient capacity on Anthropic's side, gone in seconds. A two-second
hiccup became a thirteen-minute freeze purely because it was reported in a place neither
side inspects.

**The fix: peek before writeHead.** A retry is only safe while nothing has been written to
the client, so `peekStreamHead()` reads the head of the stream before the response line is
committed, and takes its verdict from the first event that carries one:

- `overloaded_error` / `api_error` -> transient, retry upstream (1s, 2s, 4s), **same
  account** - upstream capacity is not this account's fault and switching would spend a
  healthy account on the same wall;
- any other error -> real, hand it to the client untouched;
- anything else (`message_start`, ...) -> a genuine answer is coming, release the stream;
- `ping` carries no verdict and is skipped.

Everything consumed during the peek is replayed into the stream the caller pipes, so a
normal response loses no bytes. It costs no measurable time either: `message_start` is the
first thing Anthropic sends, so the peek almost always ends on the very first chunk -
measured TTFB 0.72s on a live streaming call through the patched proxy.

**The boundary that matters: an overload arriving AFTER the answer started is not
retried.** Bytes are already on their way to the client and a retry would duplicate them.
Pinned by its own test.

In-band retries get their own budget (`maxAttempts + overloadRetries`) so they cannot eat
the account-switching attempts, and the whole backoff (7s) fits inside
`REQUEST_DEADLINE_MS` (45s).

**Proof, both directions, against a fake upstream that overloads on call 1 and answers on
call 2:**

- patched: upstream called **twice**, client received the real answer, never saw the error
- pre-patch, same harness: upstream called **once**, client received
  `data: {"error":{"type":"overloaded_error",...}}` on a 200 - exactly the byte sequence
  jcode reported as `Overloaded`

`test/inband-overload.test.mjs` (12). Mutating the retryable-error set kills 4 of them;
removing the replay kills 4. Suite total: **156 green**.

---

## 2026-08-17 (later still) - the translated route was paying full price every turn

Found while stress-testing the new default, not from an error: nothing was broken, it was
just **billing everything twice**. Anthropic only caches a prompt when the request carries
an explicit `cache_control` breakpoint, and the translation did not set one. Measured on
the live proxy: the same 9534-token system prompt billed 9534 on two consecutive calls,
`cache_read = 0` both times. A cached read costs about a tenth of a fresh one, so this
drains the 5h window roughly ten times faster. It would have surfaced as *"vdm eats my
quota"* - the switch working perfectly while the quota vanished - and that is a bug that
hides for weeks.

**Two breakpoints, and the second one is the subtle part.**

1. Last **system** block (only when it exceeds ~200 chars: below Anthropic's minimum a
   write is wasted and still billed). Tool definitions precede system blocks in cache
   order, so they ride along.
2. Last-but-**one** conversation turn. With only the system marked, the transcript is
   re-read fresh every turn - measured across three turns, `cache_read` stayed pinned at
   the system size (9226) while the prompt grew 9236 -> 9392 -> 9604. Anchoring on the
   *newest* turn would be worse than nothing: it changes every request, so each call would
   write a new entry instead of reading one. Last-but-one keeps the growing prefix stable.

After: `cache_read` 9226 -> 9226 -> 9381, rising with the history, `cache_write` only the
few hundred tokens of each new exchange.

**`usage` now reports the truth.** OpenAI's shape has no field for cache tokens, so
`prompt_tokens` counted only fresh input and a cached turn looked ten times cheaper than
it was. It is now the real total, with `prompt_tokens_details.cached_tokens` plus the
Anthropic-native counters alongside.

**End-to-end checks on the real client, with `default_provider = "vdm"`:**

- a full task (write two modules, write tests, run them, record the outcome) - 8/8 tests
  passing and every file on disk
- an account switch mid-session while a tool was running: proxy logged
  `[proactive] account-a@example.com -> switch to account-b@example.com (priority)`, the
  answer arrived normally, no error surfaced to the client
- attribution finally works: 12 requests and 449k tokens billed to the right account,
  where before all of it read as external usage

Pinned by `test/prompt-cache.test.mjs` (11 tests), including the anchor position, the
minimum-size rule, tool_result anchors (the bulk of a coding session), block-array turns,
and a cap of two breakpoints - exceeding Anthropic's limit is a 400 that would take down
every long session at once.

---

## 2026-08-17 (later) - the OpenAI-compatible route, translated onto the Messages wire

Switching jcode to the `vdm` provider still produced eight consecutive 429s, on an account
measured at **0%** of its 5h window - so this was never quota. `/chat/completions` simply
cannot express what Anthropic requires: the identity must be the **first system block,
standing alone**, and on that route a second system message is merged into the first
upstream. Prepending is not enough; the shape itself is wrong.

Requests on that route are now **translated onto `/v1/messages`** and translated back:

- **request** - `openaiToMessages()`: system messages become `system` blocks (identity
  first, the caller's own prompt as its own block - measured *obeyed*: the reply followed
  it), `max_tokens` is defaulted (optional for OpenAI, **required** here), and OpenAI-only
  fields such as `stream_options` are dropped because the Messages API rejects unknown keys.
- **response** - `messagesToOpenai()`: content blocks collapse to a string, `stop_reason`
  maps to `finish_reason`, usage is renamed.
- **stream** - `createOpenaiSseTranslator()`: a Transform that buffers partial SSE events
  (sockets split them mid-event) and emits OpenAI chunks.

**`thinking` blocks are dropped, deliberately.** A `thinking_delta` carries no `text`, so
mapping it to content emits empty strings - exactly the "HTTP 200 with an empty answer"
symptom. Related trap, hit while testing: Opus spends its budget on thinking first, so a
small `max_tokens` returned `finish_reason: length` with no text at all. That looked like a
translation bug and was not; the same request with a real budget answered fine. Do not
diagnose an empty stream without checking `max_tokens`.

### Tools: the failure that lied

The first pass dropped `tools`, on the assumption that this profile ran without them. It
does not. Asked to run a command writing a file, the model **narrated** the call, printed
its supposed output, and the file did not exist. The transcript looked like success, which
is the worst failure mode available. The translation now covers the whole loop:

- `tools` -> Anthropic `tools`, schema intact (a lost schema means calls with wrong args)
- `tool_choice` -> `{auto|any|tool}`, with `none` actually removing the tools
- assistant `tool_calls` -> `tool_use` blocks, arguments parsed from their JSON string
- `role: "tool"` -> a **user** turn carrying `tool_result`. Anthropic has no `tool` role,
  and consecutive results merge into one turn because two adjacent user turns are a 400.
- streaming reassembles `input_json_delta` fragments under
  `tool_calls[].function.arguments`, keyed by a tool index that is **not** the Anthropic
  block index - conflating the two silently merges two calls into one.

**Verified live on the real client** (`jcode run --provider-profile vdm --model claude-opus-5`):
a plain prompt answered on the same route that 429'd minutes earlier; a one-tool prompt
produced a real bash execution with the file on disk; a three-step chained prompt produced
both files with the second built from the first, which only works if tool *results* survive
the round trip back to the model.

`test/openai-route.test.mjs` (15), `test/openai-sse.test.mjs` (9),
`test/openai-tools.test.mjs` (15), `test/prompt-cache.test.mjs` (11).
Suite total: **144 green**.

---

## 2026-08-17 - Anthropic answered "429 rate limited" to a request that was only missing an identity

**The symptom that mattered:** jcode, pointed at the proxy, logged eight consecutive 429s
and gave up, on an account that still had quota. Worse, vdm never switched away from it,
so `account-c@example.com` sat at 0% while `account-a@example.com` took every request.

**Why the switch never fired.** Anthropic returns this refusal as
`429 rate_limit_error` **with no `retry-after` header**. In `handleProxyRequest` that
parses to `retryAfter = 0`, and `const isTransient = retryAfter < 60` therefore classifies
a hard refusal as a transient burst: no `markAccountLimited`, no account switch, the 429 is
piped straight back to the client. A genuine quota 429 and an identity rejection are
byte-identical at that point, which is why this hid for so long.

**What it actually was.** An OAuth *subscription* token is only served when the request
presents Claude Code's own identity, as the **first system block, standing alone,
byte-identical**. Measured against the live API, same account, same second, account at 95%
of its 5h window throughout - so quota was constant and cannot explain the split:

| request | result |
| --- | --- |
| `/chat/completions`, no system | 429 |
| `/chat/completions`, system `"You are a helpful assistant."` | 429 |
| `/chat/completions`, system = CC prompt exactly | **200** |
| `/chat/completions`, one system = CC + `"\n\n## Identity..."` | 429 |
| `/chat/completions`, two system messages, CC first | 429 |
| `/v1/messages`, `system: [CC block, custom block]` | **200** |

Two things follow. Appending to the identity breaks it, so the fix must *prepend a block*
rather than edit the caller's text. And on `/chat/completions` a second system message is
merged into the first upstream, which breaks it too - only the native `system` **array**
keeps the blocks separate.

**The patch.** `ensureClaudeCodeIdentity(url, body)` near the top of `dashboard.mjs`,
called on the main-path body in `handleProxyRequest` right after
`Buffer.concat(bodyChunks)`. It normalises `system` (absent / string / array) into a block
array and unshifts the identity when the first block isn't already exactly it. Unknown
shapes, non-JSON bodies and bodies without `messages` are forwarded untouched.

**Update, same day: `/chat/completions` is now handled too** - see the section above. The
note that used to live here said that route was left uncovered; it no longer is.

**Verification.** `test/cc-identity.test.mjs`, 12 tests, mirrors the function verbatim
(dashboard.mjs starts a server on import, so it cannot be imported). It pins the
never-concatenate rule, block order, idempotency, `cache_control` survival (dropping it
would silently multiply cost), and the `/chat/completions` exclusion. Live check after
restart: `/v1/messages` with no system and with a custom system, both **200** on Opus,
where minutes earlier the identical requests were 429.


### The same bug also froze the account switch on REAL exhaustion

Fixing the identity was only half of it. `const isTransient = retryAfter < 60` in the
429 branch reads a *missing* `retry-after` as 0, so it classifies the refusal as a short
burst: `markAccountLimited` is skipped, no switch fires, the 429 goes back to the client.
Over the logs, **3389 of ~3500** 429s carried `retry-after: 0` - so the rule was firing
almost every time, including on genuinely exhausted accounts. That is why
`account-a@example.com` kept taking traffic at 99% while `account-c@example.com` sat at 0%.

The 429 branch now cross-checks the reading vdm already holds: a 429 on an account whose
**fresh** (< 5 min) utilization is **>= 95%** is exhaustion regardless of the header, and
the hold runs to that account's own `resetAt` (5 min when unknown, rather than inventing a
long cooldown). Both guards matter: a stale reading must not sideline a healthy account,
and mid-window bursts must stay transient or accounts get knocked out of rotation.

Pinned by `test/exhausted-429.test.mjs` (11 tests): the regression case, the freshness
edge, the 94/95% boundary, 7d-only exhaustion, missing state, and the reset fallbacks.

**Verified live**, not just in unit tests: with a temporary 5h cap forcing the active
account to look unavailable, the proxy logged
`[proactive] account-a@example.com → switch to account-b@example.com (priority)` and served
Opus 200 from the new account. The cap was removed afterwards.

---

## 2026-08-16 - a headerless 200 was erasing the rate-limit reading (and the dashboard's JS)

Two independent bugs, both found while the dashboard sat on "Loading...".

**1. One apostrophe killed the whole client script.** In the template literal that builds
the page, the Italian string `dell\'account` was escaped for the *outer* template, so it
reached the browser as `dell'account` and closed the JS string early:
`SyntaxError: Unexpected identifier 'account'`. A single syntax error voids the entire
inline `<script>`, so every card, poll and chart died at once while the server stayed
perfectly healthy (all endpoints 200 in <400ms) - which is what makes it look like a hang
rather than a crash. Italian text added inside that template needs `\\'`. There is no
build step to catch this, so after touching the template check the *served* page, not the
file: extract the inline `<script>` from `curl -s localhost:3335/` and run `node --check`
on it.

**2. `updateAccountState()` persisted zeros it had never measured.** The proxy calls it on
*every* non-error response, and `/v1/messages/count_tokens` is a plain 200 carrying none of
the unified rate-limit headers. `accountState.update()` in `lib.mjs` already defended
against that (it keeps the last reading intact), but the *persisting* branch below it read
every field as `Number(headers[k] || 0)` and wrote the result to disk - so one count_tokens
call overwrote a real 56% and a real reset epoch with `0` and `0`. `resetAt: 0` is what
`formatTimeLeft()` renders as **"rolling window"**, which is how the bug surfaced: the
active account showed 0% / rolling window while a direct probe of the same token reported
0.54. The zeroed utilization also fed the usage-cap check, so a capped account could be
re-elected.

The fix mirrors `lib.mjs`: bail out when no rate-limit header is present at all (nothing
recorded, nothing persisted), and otherwise preserve **field by field** against
`persistedState`, because a partial 429 must not blank the fields it never mentioned.

Worth knowing: the corruption self-heals within one `RATE_LIMIT_CACHE_TTL` (5 min) once the
overwrites stop, so verifying the fix means watching the state file recover, not restarting.

Tests: `test/headerless-responses.test.mjs` (5 tests). They lift the real
`updateAccountState()` out of `dashboard.mjs` with `new Function` rather than
re-implementing it, so they fail against the old code - 4 of the 5 do, verified.

---

## 2026-08-11 (later) — the hold ceiling goes from 2h to 24h

`usageCapHoldMin` was capped at 120 in two independent places (`clampSettings` and the
`POST /api/settings` guard), and the select only offered up to 1 ora. Both now go through
`MAX_HOLD_MIN = 24 * 60`, and the select offers 3/6/12/24 ore. Live value set to 1440.

Two ceilings, not one: the API guard is what the dashboard talks to, `clampSettings` is what
a hand-edited `config.json` goes through. Leaving one at 120 gives a control that stores a
number the daemon then quietly rewrites — `test/hold-window.test.mjs` asserts both.

**The transport was measured, not assumed.** Node's `requestTimeout` (300s default) covers
*receiving* a request, not answering one. Against this proxy: a request whose body was still
arriving got `HTTP/1.1 408` at **310s**; a fully received request with the response withheld
was still connected at **360s**, identically with and without `requestTimeout = 0`. A parked
hold is the second shape, so no server-side knob was needed and none was added. What can
still cut a long hold short is the **client's** own timeout — the setting's description says
so rather than promising a day of patience the proxy alone cannot guarantee.

Two things a day-long wait needs that an hour-long one didn't:

- `waitForAccountRelease` polls on a sliding tick (60s beyond 30 min left, 15s beyond 5 min,
  5s below that) instead of a flat 5s. Each tick re-reads every account file; 24h at 5s is
  ~17k disk sweeps to shave at most 25s off a rollover that a real release already wakes
  instantly via `_capHolders`.
- `formatDuration()` (new, in `lib.mjs`) for the three `[cap]` log lines and `fmtHoldMin()`
  for the toast. "waiting up to 86400s" is a number you have to divide before you know what
  the daemon agreed to.

Verified after restart: `POST {usageCapHoldMin:1440}` persists to `config.json` and reads
back 1440; `1441` is rejected and leaves 1440 in place; the served page renders the ten
options and shows **24 ore** selected in a real browser (`scratchpad/hold-row.png`); the
served client script passes `node --check`; `test/layout-check.mjs` clean at all 12 widths.
`node --test "test/*.test.mjs"` → 65 pass. Each of the 7 new checks was watched failing
against a deliberate mutation (ceiling back to 120 in either place, the 24h option deleted,
`formatDuration` flattened, the lazy poll removed).

## 2026-08-11 — usage caps, stale-limited fix, usage attribution

### 1. `lib.mjs` — usage caps (new code, plus six picker call sites)

New exports: `effectiveUtilization`, `normalizeCapPercent`, `resolveAccountCaps`,
`isOverUsageCap`, `usageCapState`, `isSelectableAccount`.

The six pickers (`pickBestAccount`, `pickDrainFirst`, `pickConserve`, `pickByPriority`,
`pickLeastLoaded`, and the `currentAvailable` check in `pickByStrategy`) previously each
inlined the same `!excluded && !disabled && isAccountAvailable(...)` filter. They now all
call `isSelectableAccount()`, so a new exclusion reason cannot be added to five of them and
forgotten in the sixth. `pickAnyUntried` gained an optional `stateManager` argument and
skips capped accounts when given one — a cap the last-resort path walks through would never
hold anything back.

Caps are resolved onto each account object as `capFiveH` / `capSevenD` (0..1, or null) by
`loadAllAccountTokens()`, the same shape as `priority` and `disabled`. That's why no picker
signature had to change.

`effectiveUtilization()` is the load-bearing detail: a window whose reset epoch has passed
reads as **0**, not as its last sample. Without it a capped account can never recover — it
is skipped, so it earns no fresh sample, so the stale value keeps it skipped forever.

### 2. `lib.mjs` — usage attribution & list pricing (new code)

New exports: `MODEL_PRICING_USD`, `pricingFor`, `billableTokens`, `listCostUsd`,
`attributionForWindow`, `ATTRIBUTION_BANDS`. Pure functions, all covered by
`test/attribution.test.mjs`.

`pricingFor` matches the **longest** model prefix, not the first — `claude-opus-4-8` must
not resolve through a shorter key. The vendor's client-side `TOK_PRICING` had the first-match
bug and stale Opus-4.6 prices; both are fixed in `dashboard.mjs` (see 6 below).

### 3. `dashboard.mjs` — the stale-limited fix (this is a real bug, not a feature)

`reconcileFromProbe()` + the `unblockSweep()` interval, and a `reconcileFromProbe` call in
`getRateLimitsForToken()` after a successful probe.

**The bug:** `accountState.limited` could only be cleared by a real response flowing through
the proxy for that account — but every picker skips a limited account, so no response could
ever arrive. `isAccountAvailable` then falls back to `resetAt`, which is the 5h *window
rollover*, not an unblock time, so the account stayed out of rotation until the window
turned. Meanwhile its dashboard card — fed by the probe, which wrote only to
`persistedState` — showed it perfectly healthy. That mismatch is the "VDM thinks it's
blocked and it isn't" symptom.

A real 429's `retryAfter` still wins: `accountState.update()` preserves an active cooldown
by design, because the probe uses a cheap model and cannot see a per-model cap (the weekly
Opus one). Verified on 11/08: a genuine `quota-7d` cooldown to 12/08 06:00 survived
the change.

`unblockSweep` (every 2 min) re-probes only accounts that are `limited` with **no** active
cooldown — the exact deadlock set. Accounts with no state at all are left alone, because a
probe would start their rate-limit window, which is the whole point of `conserve`.

### 4. `dashboard.mjs` — cap settings, sidecars, API, and the hold gate

- `DEFAULT_SETTINGS`: `usageCap5h`, `usageCap7d` (percent or null), `usageCapHoldMin`, `usdEur`.
  `sanitizeCapPercent()` treats anything outside 1..99 as "no cap" rather than clamping — 0
  would silently mute an account, which is what `.disabled` is for.
- Per-account sidecar `accounts/<name>.cap` (`{"fiveH":40,"sevenD":null}`), same pattern as
  `.priority` / `.disabled`. A null field inherits the global, field by field.
- `POST /api/account-cap`; `POST /api/settings` accepts the three cap fields (they test for
  key **presence**, since `null` is a meaningful value there).
- **The hold gate** sits in `handleProxyRequest` immediately before the `balanceMode` branch.
  When nothing is selectable it parks the request rather than answering 429, and resumes
  when a window rolls over, an account recovers, or a cap is raised from the dashboard.
  `deadline` had to become `let` — the wait is not work, so the request gets its time back.
  A transient-429 burst does not reach this gate (those don't mark accounts limited).

Verified live on 11/08:

    [cap] holding request — 2 account over cap, 1 rate-limited; waiting up to 60s
    [cap] releasing 1 held request(s): caps changed
    [cap] released after 3s — resuming

### 5. `dashboard.mjs` — cache-token accounting (fixes a large undercount)

`createUsageExtractor()` now captures `cache_read_input_tokens` and
`cache_creation_input_tokens`; `recordUsage` and the new `tokenUsageRow()` helper persist
them. In a Claude Code session the whole context is re-read as a cache read every turn, so
counting only input+output understated real consumption by roughly an order of magnitude,
which made "how much of this account is my doing" unanswerable.

`tokenUsageRow()` also replaces four near-identical `appendTokenUsage({...})` literals — a
new field added to three of the four is a silent data hole. Rows written before this change
have no cache fields; readers treat them as 0, and `attribution.measuredSince` reports how
far back complete data goes.

### 6. `dashboard.mjs` — attribution in the UI

Server: `usageAttribution()` (15s cache — /api/profiles polls every 5s over tens of
thousands of rows) exposed on each profile as `attribution`, plus `cap`.

Client: `renderAttrStrip`, `renderAttrFigures`, `renderCapMarker`, `fmtTokens`, `fmtEur`,
`setAccountCap`, `changeGlobalCap`, `changeCapHold`, `changeUsdEur`; a cap row on each card;
a "Tetto di utilizzo" section in Settings. `TOK_PRICING` refreshed and `estimateCost()` now
takes cache tokens and matches the longest prefix.

Two honesty constraints worth preserving if this is ever re-applied:

- The strip has **three** states, not two. "Non misurato" means no utilization sample covers
  that slice, so we cannot say whether the account moved; painting it as either mine or
  external would be a guess. `externalShare` is `null`, never 0, when nothing was measured,
  and `coverage` says how much of the window the split was computed from.
- Euro figures are labelled "a listino API", never "costo". These are flat-rate subscription
  accounts — no euro shown is actually spent. The figure is what the same traffic would cost
  metered, i.e. what the subscription returned. `usdEur` is a **setting**, because nothing
  here fetches an exchange rate and a baked-in constant would rot silently.

Strip colours are `#3c83f6` (mine) and `#e8590c` (external), validated as a categorical pair:
CVD ΔE 30.4 protan / 34.6 tritan, both ≥3:1 on the card surface. The first attempt — blue +
the existing `--purple` — **failed** at ΔE 5.5 under deuteranopia. They are deliberately not
`--yellow` / `--red` / `--green`, which mean warning / error / ok elsewhere on the page.

### 7. `dashboard.mjs` — the silent catch that hid all of this

The per-account `catch` in `loadProfiles()` was `catch { /* skip corrupt files */ }`. During
this work a single `ReferenceError` emptied the entire dashboard with no trace of the cause.
It now logs `Skipping account <name> while building profiles: <message>`. Keep this.

### 8. `dashboard.mjs` — layout (added after measuring, not after guessing)

The first cut of the attribution UI squashed the cards. Measured with
`test/layout-check.mjs` across 12 viewport widths, three real defects:

- **The legend rendered twice per card** — identical for the 5h and the weekly
  window, each inside a ~150px column. At 390px that alone was six wrapped lines.
  It now renders **once per card**, below both groups, and the long verdict prose
  moved out of it onto the per-window figure line (which is genuinely per-window).
  Legend is now one line at every width from 360 to 1440px.
- **The cap value was an absolutely-positioned `::after` above the track** and
  overlapped the header line at *every* width. Removed; the value now sits in
  `.rate-head` beside the utilization percentage it is meant to be compared
  against, and the track keeps only a bare 2px tick.
- **The dashboard had no `@media` rules at all** — two fixed columns with a 3rem
  gutter at any width, and six tab buttons that forced a horizontal page scroll
  below 365px. Added: stack the two windows below 640px, tighten the gutter below
  900px, drop the strip's 1px cell gap below 520px (a 1px gap on a 3px cell is a
  third of the cell), `min-width:0` on tabs plus wrapping below 400px.

`test/layout-check.mjs` fails on clipping, sibling overlap, offscreen elements,
horizontal page scroll, sub-2px strip cells, and any text block wrapping past two
lines. It caught all three of the above; keep it.

### 9. `lib.mjs` + `dashboard.mjs` — never show a zero you didn't measure

**The symptom:** a blocked account showed `Weekly 0%` on its card while
`account-state.json` on disk said `1` (100%). Not a flicker — permanent, for
exactly the accounts that were rate-limited.

**Three compounding causes, all "absent header parsed as 0":**

1. `accountState.update()` did `parseFloat(headers[k] || '0')` on every field. A
   429 routinely carries `unified-status: limited` and **no** utilization headers,
   so every reading landed as 0. Now each field is preserved independently
   (`headers[k] !== undefined ? parse(...) : previous`) — a header that reads "0"
   is a real zero and lands; an absent one leaves the previous value alone.
2. `fetchRateLimits()` flattened a headerless response into an all-zero object
   indistinguishable from a genuine zero. It now reports `rateHeaders` (the
   unified headers that actually arrived) and `hasLimits`, and
   `getRateLimitsForToken` merges a probe over the last known reading instead of
   replacing it. `reconcileFromProbe` forwards the real headers rather than
   synthesising a full set with `?? 0`, which had defeated the field-level
   preservation.
3. **The actual reason the first two weren't enough:** `accountState` is keyed by
   **access token** and starts empty on every restart, while the durable copy is
   keyed by **fingerprint**. With nothing to preserve against, the first
   status-only 429 after a restart still wrote 0 — and a blocked account never
   receives a response with full headers, so the 0 stuck forever. Startup now
   calls the new `accountState.hydrate()` for every account (the old
   `hydrateCooldowns` restored *only* cooldowns), carrying `updatedAt` from the
   snapshot so the reading's age stays honest and re-probing still triggers.

This is not cosmetic: `effectiveUtilization()` reads the same field, so a phantom
0% would have handed a capped or exhausted account straight back to the rotation.

Covered by `test/stale-readings.test.mjs` (17 tests). Reverting any one of the
three turns tests red; the third has a test that asserts the failure mode
explicitly, so the reason the bridge exists can't be forgotten.

### 10. `dashboard.mjs` — per-account cap toggle

`toggleAccountCap()` plus a switch on each card's cap row, matching the existing
enable/disable switch. On seeds both windows from the global cap when one exists
(else 75%); off clears the override.

The switch reflects **"has its own cap"**, not "is capped" — those differ when a
global cap exists, because clearing the override hands the account back to the
global rather than removing every limit. The row states which case applies
("eredita il globale (5h 75% · 7g 75%)" / "nessun tetto") so an off switch is
never mistaken for "unlimited".

### 11. `dashboard.mjs` — legend swatch and badge wrapping

The "non misurato" legend key used the strip's `repeating-linear-gradient`. That
hatch works on the strip, where adjacent cells line the diagonals up into a
continuous texture; on a lone 8px swatch it renders as one off-centre diagonal
streak — a crooked mark rather than a key. The legend key is now a flat neutral
with a border. Measured alignment was already exact (offset 0px), so this was the
hatch, not a layout fault. `test/layout-check.mjs` now fails on any legend swatch
with a gradient, on mismatched swatch sizes, and on >1px vertical offset.

`.card-top` and `.card-badges` now wrap: adding the third badge ("Cap raggiunto")
pushed the row past the viewport below ~450px and made the page scroll sideways.
The layout check caught this the moment an account first hit its cap.

### 12. `dashboard.mjs` — two CSS variables that were never defined

`--muted-foreground` (6 references) and `--surface` (2) are used by the vendor
stylesheet and **defined nowhere**, so both resolved to nothing. The visible
consequence: `.enable-sw::after` — the switch knob — had a transparent background,
so an OFF switch rendered as an empty grey pill. It only became obvious once the
cap switch introduced a control that is commonly *off*; the enable switch is on
for every healthy account, and its ON state colours the knob explicitly.

Both are now defined in `:root`. The OFF track also moved from `--muted` (a mid
grey, the same value as the knob) to `--bg`, matching the ON state's light-track /
saturated-knob pattern: measured contrast went from invisible to 5.48.

`test/layout-check.mjs` now fails on any `var(--x)` with no definition, on a knob
that resolves transparent, and on a knob/track contrast below 1.4.

### 13. `dashboard.mjs` — legend keys must be geometrically identical

The previous round replaced the "non misurato" hatch with a flat fill **plus a 1px
border** — and left the other two borderless. Under `box-sizing: border-box` that
shrinks only that key's fill from 8×8 to 6×6, so a row of three keys showed two
solid blocks and one smaller outlined one. Measuring the DOM said "all 8×8" and
passed; the defect was in the *fill*, not the box.

All three now carry the same hairline border. The check compares width, height,
radius, border width/style/colour and box-sizing across the keys and fails if they
differ at all — reverting the border to one key alone turns it red.

**Method note for the next round:** three separate measurement harnesses gave false
readings here before the isolated-page test found it — a DOM-only check that never
looked at fills, and two pixel samplers whose windows were contaminated by the
adjacent label glyphs. When a rendered mark is in question, render it in isolation
with the shipped stylesheet (`.attr-legend` alone on a blank page) and compare
computed styles; that is what `iso2.mjs`-style checks are for.

### 14. `dashboard.mjs` — cap placement and unit

The cap control sits on the **priority row**, beside it: both are knobs that decide
whether this account gets picked at all, so they belong together rather than split
across the card. `.card-priority` wraps, so on a narrow card the cap group drops to
its own line as a unit. The cap *value* is rendered **before** the utilization in
each bar header — the ceiling first, then where the account stands against it.

The percent sign lives in a `.cap-field` wrapper around the number input (a
`type=number` cannot carry a unit, and a text field would mean parsing it back out
on every edit); the spinner is hidden because it steals width from a two-digit field.

### 15. `dashboard.mjs` — the legend key was wearing the switch's clothes

The legend swatch was `<span class="sw …">`, and `sw` is the **toggle-switch**
class. Its `.sw::before` paints a 14×14 white circle with a shadow — on an 8px
square that circle covered the swatch and spilled past its right edge. That was the
round blob beside the labels, through two rounds of "fixes" aimed at the wrong
thing (first the hatch, then the border). Renamed to `key`.

A pseudo-element inherited from an unrelated component appears in neither the
markup nor a size/border check — the two things I had been measuring. The guard
that catches it asks for it directly (`getComputedStyle(el, '::before').content`),
and selects the swatches **by position** (`.lg > span:first-child`) rather than by
class, because a class-name selector silently matches nothing the day someone
renames it, and a guard that finds nothing never fails.

### 16. `dashboard.mjs` — the OFF switch: a dark knob on a near-white track

Defining `--muted-foreground` (§12) made the knob visible but dark grey on a
`--bg` track: a smudge rather than a switch. Now it follows the vendor's own `.sw`
— white knob with a shadow on a `hsl(220 13% 82%)` track. Measured contrast 1.56
OFF, 2.12 ON, against the 1.4 floor the layout check enforces.

### Outside this directory

`~/.claude/jarvis/scripts/rotate-logs.sh` — `vdm.log` added to the rotation list (it was
6.6 MB and growing unbounded; only router/topics-server were listed).

## 2026-08-07 — discovery tracing (diagnostic only, no behaviour change)

Why: after a `/login` as account-d@example.com, `vdm list` didn't show the account for ~12
minutes. The proxy log showed three `[proactive] none → account-c@example.com (priority)` switches
(02:35:15, 02:38:55, 02:43:53) before `[auto-discover]` finally saved it as auto-2 at
02:46:52. `none` means the active keychain token matched no saved account — but
`autoDiscoverAccount()` runs immediately before the strategy pick on every proxy request
(`dashboard.mjs:6330`), and there were no 400s, no circuit break and no keychain read
failures in that window. So the mechanism is still unexplained, and the proactive switch
overwrites the keychain, destroying the evidence each time.

What was added — `traceDiscovery(outcome, fp, extra)`, logging under the `discover` tag,
deduplicated by signature so steady state costs one line and only changes get written:

- every early return of `autoDiscoverAccount()` (no token / exact-fp match / same
  refreshToken / same email / auto-account cap), plus the promise rejection path
- the `_consecutive400s >= 3` branch that skips discovery entirely
- `MISMATCH:` at the pick site (`const activeAcct = ...`) when the keychain token matches
  no saved account — logs the active fingerprint next to every saved one. This is the
  decisive line: it should be unreachable given discovery ran a few lines above.

Read it back after the next `/login`:

    grep '\[discover\]' ~/.claude/jarvis/logs/vdm.log

Deliberately NOT done: suppressing the keychain write when the active token is unknown.
It looks like a two-line guard but degrades badly — if a token can never be saved, vdm
would stop moving the active pointer for good. It needs a bounded escape hatch, and it
should wait until the trace above shows what actually happens.

## 2026-08-07 — per-account enable/disable switch in the dashboard

Why: `writeAccountDisabled()`, the `.disabled` sidecar, `POST /api/account-enabled` and
`vdm disable|enable` all already existed, but nothing in the UI called that endpoint — the
account cards only had Priority ±, Remove and Switch. Toggling an account off meant
dropping to the CLI.

What was added (UI only, no change to the rotation logic):

- `.enable-wrap` / `.enable-sw` / `.badge-off` / `.card.off` / `.off-msg` styles next to the
  existing `.prio-*` rules
- `toggleEnabled(name, enable, e)` client-side, mirroring `bumpPriority`: disables the
  button while the POST is in flight, then re-renders from the server rather than trusting
  optimistic local state
- a switch on the priority row of each card, right-aligned, with an `ON`/`OFF` caption and an
  aria-label (`Disable account-c@example.com`) so it is reachable from a snapshot
- disabled cards get a `Disabled` badge, dimmed styling and the line "Excluded from
  rotation — the proxy will not pick this account"
- the `Switch to this account` button is hidden while disabled — the proxy would drop the
  account again on the next request, so offering it would be a lie
- `account-enabled` wired into `evtMsg`/`evtColors` so it reads properly in the Activity feed

No timed auto-re-enable: off stays off until switched back on. Deliberate — see the
conversation of 2026-08-07; a timed variant would need expiry state plus a countdown.

Verified against the running dashboard (jbrowser, `http://localhost:3335`): disabling
auto-1 via the API rendered badge + `OFF` + the exclusion line and removed the Switch
button; clicking the switch in the page re-enabled it (sidecar removed from disk); clicking
auto-4's switch created `auto-4.disabled` and clicking again removed it. Client script
extracted from the served HTML passes `node --check`.

## 2026-08-07 — keychain access: upsert instead of delete+add, no shell, no secrets in logs

Three defects in `readKeychain` / `writeKeychain`, all fixed together:

1. **`writeKeychain` deleted the item before re-adding it.** For the ~20-50ms between the
   two calls the credential simply did not exist, and every concurrent read failed. That is
   the source of the 391 `Keychain read failed` lines in vdm.log. Measured on a scratch
   keychain item: delete+add → 16 failed reads per 40 writes; `add-generic-password -U`
   (update in place) → 0 per 40. Now a single `-U` call, with delete+add kept only as a
   fallback so an unexpected refusal can't leave the pointer unwritable.
2. **Both helpers went through `execSync`, i.e. through /bin/sh.** The 25 recorded
   `spawnSync /bin/sh ETIMEDOUT` failures were on spawning the shell, not on the keychain.
   Now `execFileSync('security', [...])` — no shell, and no hand-quoting of a JSON blob
   full of double quotes. `readKeychain` also gained a timeout (it had none, so a hung read
   could block the daemon indefinitely — these calls are synchronous) and one retry.
3. **Failed writes logged the credentials in plaintext.** Node puts the whole argv in the
   error message, so `add-generic-password … -w '{…}'` wrote real access *and refresh*
   tokens into `~/.claude/jarvis/logs/vdm.log` — 4 lines, 8 distinct tokens, still there.
   `safeKeychainError()` now strips it; verified by forcing a failure with a marker secret
   in argv and confirming it does not survive into the logged string.

Verified after restart: 6 real account switches with 60 concurrent external reads →
0 read failures, 0 upsert fallbacks, keychain token matches the target account's file.
Note `/api/switch` sets `rotationStrategy` to `sticky` as a side effect; it was restored
to `priority` after the test.

Follow-up, same day — the fix above only stopped *new* leaks, so two more things:

- `redactSecrets()` now runs inside `log()` itself, on both the stdout line and the object
  pushed to the SSE clients. Any call site, present or future, is covered: matching
  `sk-<ant>-<kind>-<blob>` it keeps the prefix (still traceable to an account) and drops the
  rest. Fixing only `safeKeychainError` would have left every other logging path free to
  leak.
- The 8 tokens already written to `~/.claude/jarvis/logs/vdm.log` were redacted in place
  (75546 lines rewritten, 8 replacements, no other content touched), and both vdm logs went
  from `0644` — world-readable — to `0600`. The daemon was restarted so it reopens the new
  inode instead of appending to the unlinked old one.

The exposed refresh tokens do not expire on their own. They sat in a world-readable file on
this machine only, but rotating them means a `claude login` on the two accounts involved —
that part needs a human.

Still open: the `[discover]` trace from the previous patch, to be read after the next
`/login`.

## Riassunto delle sessioni in italiano, NIENTE senza lavoro (24/10)
`callHaikuSummary` usava un prompt inglese e, quando riceveva un messaggio di servizio di OpenClaw invece di
lavoro, Haiku rispondeva parlando di sé («I'm Claude…», «I appreciate you sharing this routing information…»);
quelle frasi, o in mancanza il testo grezzo del turno (`mcp__openclaw__exec: …`), finivano nella pagina Sessioni
dell'hub. Prompt e lettura della risposta stanno ora in `lib.mjs` (`SUMMARY_SYSTEM`, `parseSummary`): italiano,
forma impersonale, e `NIENTE` quando non c'è lavoro → `{ skip: true }`, il turno non entra in cronologia (nemmeno
col fallback a regole). Test: `test/summary.test.mjs`. Vale dal prossimo riavvio del proxy.
