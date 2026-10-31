---
name: gauntlet-loop
description: Compose a gauntlet-loop prompt — fan out subagents, pair each with a blind critic, loop until a stated bar is met. Use when the user says "/gauntlet-loop", "gauntlet", "fai un gauntlet loop", or asks to push an existing build to a much higher quality bar by brute force. NOT for a first draft, NOT for a small fix.
---

# Gauntlet loop

A prompt structure (Matt Schumer, Aug 2026) for spending a lot of model time to
push quality past what a single pass reaches. Three parts, in this order:

1. **Task** — what to build or improve.
2. **Build method** — break the goal into the smallest independent pieces; fan
   out one worker subagent per piece; pair each worker with a **separate**
   critic subagent that did not write the code.
3. **Bar** — the stopping condition. The loop runs until every critic passes
   its piece against the bar.

The critic being separate is the whole trick: a model that just wrote something
grades its own work generously. Anthropic's *Building effective agents* (2024)
calls this the evaluator-optimizer pattern; the gauntlet loop just runs it wide
and long.

## When NOT to use it

**Never as the first prompt on a new build.** The loop optimises hard toward
whatever direction the agent happened to pick, so a wrong direction gets
polished to a mirror finish. In the source demo this produced a genuinely
beautiful landing page that matched nothing about the client's brand system.

Start from something already on brief — an approved design direction (see the
`rivet` skill for finding one), an MVP, a design system — and use the gauntlet
loop as the second pass that sharpens it. Also skip it for anything small: it
costs hours and a lot of tokens by construction.

## Writing the bar (the part that decides if this works)

The original phrasing is *"do not stop until each critic is utterly wowed
compared to \<named reference\>"*. A subjective bar like that never converges —
in the source demo it ran two hours and the critics were still unsatisfied,
because "wowed" has no false. Name a concrete reference rather than an
adjective ("compared to Call of Duty", not "make it AAA"), and prefer a bar
something can *fail*:

- **A command that exits non-zero.** Best case. `npm run check`, a test suite,
  a lint gate, a project's own harness. The critic runs it and reads the output.
- **A measured comparison.** Playwright `toHaveScreenshot` against a baseline,
  a DOM audit (`scripts/ui-audit.js`), axe-core for a11y. Numbers, not opinions.
- **A named artefact to match.** A reference photo, a competitor page, a
  screenshot. The critic puts render and reference side by side and lists
  specific mismatches.
- **Subjective, last resort.** If nothing above applies, cap the rounds
  explicitly ("at most 3 rounds") so the loop terminates on the counter.

Never let a VLM adjudicate fine geometry or pixel-level layout — it is a
gut-check ("does this look like a horse at all"), not a measuring tool. Where a
numeric harness exists, the VLM's verdict never overrides it.

Keep any existing green gate as a **regression net** in the bar: "all current
checks stay green" plus "the new goal is met". Otherwise the loop happily
trades away what already worked.

## How the loop is allowed to end

A loop that cannot say *why* it stopped will eventually report a budget as a
result. Six rules keep the ending honest — the workflow enforces them, and a
prose run should follow them too:

- **The gate decides, the counters don't.** Running out of rounds, tokens, or
  time is a reason the loop stopped; it is never evidence the bar was met.
  Report those runs as red or unverified and say which pieces are still open.
- **Never rerun an unchanged failed gate.** If a round leaves the tree exactly
  as it was (same snapshot sha of the working tree, whatever words the defects
  are written in), the worker cannot move that piece: spending another worker
  and verifier buys the same answer. Stop the piece and report it as stalled.
  Only when no snapshot was recorded does the workflow fall back to the coarser
  "same `git diff --stat` and same defects". (Prime Agent's autonomous mode
  makes the same call — it advances the attempt count instead of rerunning.)
- **A missing verdict is not a pass.** A critic that died, was skipped, or ran
  out of budget verified nothing. That piece is *unverified*, which is worse
  than red: red was measured, unverified was not.
- **From round 2, verify the fix, not the change.** Round 1 gets one open,
  blind critic. After that, ONE verifier checks a narrow claim: "defects
  D1..Dn from the previous round are closed in the diff since the tree the
  previous critic reviewed, the bar is green, nothing the fix touched broke".
  Re-running 2-4 open lenses over the whole change every round is what keeps
  loops from converging: each pass finds new scope. Anything serious the
  verifier sees outside the claim is reported to the human (`outOfScope`), it
  does not buy another round.
- **A fix that breaks what worked goes to a human.** If the round-N fix
  introduced a regression, stop the piece and escalate: no round N+1. Late
  fixes on code that is getting worse are how the loop spends money to lose
  quality (in real runs, about 6 of the 27 round-3 majors were regressions
  from the previous round's fix).
- **Keep the cap at 3.** Rounds beyond it rarely converge; what is still red
  after 3 goes to a human with its open defects.

## Composing the prompt

Fill this in and hand it back to the user (or run it, if they asked you to):

```
TASK
<what to build or improve, with the starting point named — repo path, current
 build, approved direction>

BUILD METHOD
Break this into the smallest independent pieces. Fan out one subagent per
piece. Pair each with a separate critic subagent that did not do the work; the
critic verifies against the bar below and sends the piece back with specific
defects if it fails. From round 2, one verifier checks only that the listed
defects are closed by the fix, the bar is green and the fix broke nothing.
Stop a piece when a round changes nothing; escalate it to me when a fix
breaks what worked. At most 3 rounds.

BAR
<the falsifiable condition — command, measurement, or named reference>
<the regression net — what must stay green>
<round cap, if the bar is subjective>
```

## Prefer the workflow when the bar is a command

A prompt asks the orchestrating agent to behave; a workflow script *guarantees*
the shape. When the bar is something runnable, use `Workflow` with
`~/.claude/workflows/gauntlet.js` instead — deterministic fan-out, critics that
actually execute the check, and a loop that stops on the exit code rather than
on a mood. Pass `args`: `{ task, projectPath, pieces[], checkCommand, bar,
references[], maxRounds, serial, pieceCount, roundCost }`.

It returns an explicit `outcome` — `green`, `red`, or `unverified` — plus
`failed[]` (each with `stalled` and `escalated`), `escalate[]` (pieces whose
fix broke what worked, with the regressions: a human decides), `outOfScope[]`
(problems a verifier saw outside its claim, not checked by the loop),
`unverified[]` (each with `reason: budget | critic-missing | error`; `error`
means an agent call threw mid-piece, with the message in `error`), and the
final regression verdict. Report that field as-is: only `green` means the bar
was met, and `escalate` / `outOfScope` go to the human even when it is green.

Two things the caller has to hand over, because the loop cannot find them:

- **Project conventions go in `bar`, spelled out.** From round 2 the verifier
  runs without CLAUDE.md, so naming rules, closed lists of domain terms and
  which checks count reach it only through `bar`. For a convention a round-1
  defect cites and `bar` does not state, it is told to read the repo's own
  CLAUDE.md / AGENTS.md, for that defect only.
- **Pieces that share files: `serial: true`.** The default is parallel, and
  then the diff a verifier reads can hold the other pieces' edits too. It is
  told so: a breakage it traces to another piece goes to `outOfScope`, not to
  `regressions`, and the final gate reruns the check on the whole tree.

Its own tests live next to it, run them after any edit:

```bash
node ~/.claude/workflows/gauntlet.test.mjs
```

Reach for the prose prompt when the work is exploratory enough that you cannot
name the pieces up front.

## Same pattern in an ad-hoc workflow script

When you write the loop yourself instead of calling `gauntlet.js`, copy its
shape, not just its idea:

- **Workers:** `agent(prompt, { agentType: 'worker', schema })`. The lean
  `worker` agent (`~/.claude/agents/worker.md`) has only Bash, Read, Edit,
  Write, WebFetch, ToolSearch, Monitor and TaskStop: no Artifact, Skill, MCP
  or agent tools. Measured on a real run: 13.1k tokens on the first turn
  against 24.7k for the default workflow subagent. A stage that needs an MCP
  tool (context7, exa, gateway) or WebSearch stays on the default subagent.
- **Round-1 critic:** open and blind, on `worker` too. Have it record a
  snapshot of the tree it reviewed (`git write-tree` on a private index, see
  `snapshotCmd` in `gauntlet.js`), so the next round can isolate the fix.
- **Round >= 2:** ONE `agent(claim, { agentType: 'verifier', schema })` with
  the numbered defects, `git diff <previous snapshot> <now>` as the scope, and
  `regressions` / `outOfScope` in the schema. The verifier runs without
  CLAUDE.md (4.4k first-turn tokens against 12.1k with it): put every project
  convention the claim depends on in the prompt. If other workers write in the
  same tree meanwhile, say so and name them, or it will charge their breakage
  to this fix and escalate the wrong piece.
- **Stop rules in code, not in the prompt:** same snapshot twice = stalled;
  any regression from round 2 on = escalate, no next round; cap 3.
