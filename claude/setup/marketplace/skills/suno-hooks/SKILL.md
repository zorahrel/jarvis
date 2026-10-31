---
name: suno-hooks
version: 1.0.0
description: |
  Reverse-engineer a generated song take (Suno, Udio, any text-to-music model) into a prompt
  that reproduces the parts you love. Use when a generation nails something — a chant, an
  ad-lib, a doubled word — and the next generation loses it, or when a take is ruined by
  stuttering syllables. It isolates the vocal, transcribes it word by word, diffs SUNG against
  WRITTEN to reveal what the model improvised, and splits fast repetitions into hooks (write
  them down) and artifacts (ban them). Output: a ready Style / Exclude / Lyrics package.
license: MIT
compatibility: claude-code opencode openclaw
---

# suno-hooks — get the magic back out of a take

**The problem this solves.** A model sings things nobody wrote. Those improvisations are often
the best part of the take, and they live nowhere: not in the lyrics box, not in the style, not
in your notes. Regenerate and they are gone. Meanwhile the same mechanism produces the defect
everyone hates — `o-o-o-otra vez`, a syllable machine-gunned into itself.

Both are "the model repeated something". The difference is **where** the repetition sits:

| | what repeats | what to do |
|---|---|---|
| **hook** | a whole word, several times (`no, no, no`) | **write it in the lyrics**, literally, so it survives |
| **artifact** | a piece *inside* one word | **ban it** in the section tag and in Exclude |

A transcriber gives you the test for free: if the ASR sees the repetition as separate words,
it is a hook; if it sees a single word, the repetition was sub-lexical — the defect.

## Requirements

- `demucs` (vocal isolation) — `uv tool install --with numpy --with soundfile demucs`
- `whisper-cli` (whisper.cpp) + a ggml model (`ggml-large-v3.bin` is worth it here)
- python: `librosa numpy scipy`
- On Apple silicon set `DEMUCS_DEVICE=mps` (25 s a track instead of ~3 min)

## Workflow

**1. Get the take and the text that produced it.** Audio file + the lyrics you actually typed.
On Suno both come from the private feed of your own logged-in session:
`GET https://studio-api.prod.suno.com/api/feed/v2?page=0` with the Clerk `__session` cookie
(`metadata.prompt` = written lyrics, `metadata.tags` = style, `audio_url` = mp3). Without that,
paste the lyrics into a file by hand.

**2. Run the analysis.**

```bash
python3 scripts/hooks.py TAKE.mp3 --lyrics written.txt --lang es --out report.md
# reuses a stem you already have:  --stem /path/vocals.wav
```

You get: the full transcription with timestamps, a table of **what the model added** (aligned
against the written text, not line by line — singers breathe mid-line and line matching lies),
and every fast repetition **labelled hook or artifact**.

**3. Read it with your ears open.** The tool says where and what; only you know which of the
improvisations is the thing you fell in love with. Play the timestamps it prints.

**4. Write the package.** Rules that matter, in order of impact:

- **Transcribe what is SUNG, not what you wrote.** Models drop and change words — if the take
  you love sings `Otra vez y no me pare` while your text said `Ponme otra vez…`, the chorus of
  the new prompt is the sung one.
- **Wanted repetitions go in the lyrics, spelled out**, one word per note:
  `No, no, no, no, no, no, no, no` — count them from the report (`«no»×8`).
  Put a section tag that legitimises them: `[Intro | chant, each "no" a separate short note]`.
- **Unwanted repetitions get banned twice**: in every *other* section tag
  (`legato, hold every word to the end, no chopped syllables`) and in **Exclude**
  (`vocal stutter, stutter edits, stuttering syllables, glitch vocals, chopped vocals,
  gated vocals, granular effects, echo repeats, slapback delay`).
- **Style field**: comma-separated tags, ~15–30 words, most important first. Mixing instructions
  (dB, Hz, sidechain) are ignored; BPM is a hint, not a setting. Negatives never go here — they
  belong in Exclude, where the model actually reads them.
- **Structure lives in the lyrics box**, as `[Section | instructions]` headers.
- Breaks and fills: if the drums keep dropping out where you don't want them, say
  `drums never stop, no fill, no drum roll` in the section tags *and* put
  `drum fill, drum roll, drum break, breakdown, silence` in Exclude.

**5. Generate, then measure the same way.** Run `hooks.py` on the new take: the hook events
should now sit exactly where you wrote them, and nowhere else. That is the pass/fail.

## Generating (scripts/suno_api.py)

One client, shared by every session — three different clients on one account is what trips the
abuse checks in the first place.

```bash
python3 scripts/suno_api.py --dry              # only reads the feed: proves auth, spends nothing
python3 scripts/suno_api.py brief.json OUTDIR  # generates and downloads
```

`brief.json` = `{title, tags, negative_tags, prompt, mv}`. The schema was recovered by
intercepting the real request the web app makes (fill the form, abort the POST: zero credits):

| | |
|---|---|
| host | `studio-api-prod.suno.com` — hyphen, *not* `studio-api.prod.suno.com` |
| endpoint | `POST /api/generate/v2-web/` |
| body | flat: `prompt / tags / title / negative_tags / mv` + `generation_type: "TEXT"`, `token: null` |
| headers | `device-id` (stable uuid), `browser-token` = `{"token": base64({"timestamp": ms})}` |
| auth | Clerk JWT minted from the `__client` cookies: `GET clerk.suno.com/v1/client` → session id → `POST /client/sessions/<sid>/tokens`. Lives ~1 h, mint one per call |

State: `SUNO_STATE` (default `~/.claude/jarvis/state/browser-states/sunostate.json`, exported from a
logged-in browser session), device id: `~/.claude/jarvis/state/suno-device-id` — **one for everybody**.

### When it answers 422 `token_validation_failed`

That is Suno's anti-bot check, and it comes and goes: the same call succeeded and then stopped
within the same hour. The UI shows the other half of it — a Cloudflare Turnstile
("Verify you are human") in front of *Create*.

- **Don't** solve the Turnstile programmatically, and **don't** dress the request up as Chrome
  (spoofed `user-agent`, `sec-ch-ua*` client hints) to slip past the fingerprint check. Both are
  circumventing a control the service put there on purpose.
- **Do** fall back to the UI: fill the form in a **visible** browser window and let the human tick
  the box and press Create. Everything else in this skill still applies — the package you paste is
  the same one.

## Worked example (why the rule is the way it is)

A take whose written intro was one line, `Suena otra vez`. What it actually sang:

| time | sung |
|---|---|
| 0.03 → 2.27 s | **no · no · no · no · no · no · no · no** |
| 2.40 s | Suena otra vez |
| 3.24 → 5.39 s | eight more `no`, twice as fast |
| 5.70 → 11.55 s | otra vez, otra vez, otra, otra, otra vez, otra vez, otra vez |

`hooks.py` recovered exactly that as "added by the model" (`«no»×8, «no»×8, «otra»×3`), and of the
ten fast repetitions in the track it labelled **one hook** (5.0 s, the chant) and **nine artifacts**
— all nine inside chorus lines where nothing was written as repeated. Which is the whole point:
the same detector was counting the singer's best moment as a defect until it was asked *what*
repeats, not just *how fast*.
