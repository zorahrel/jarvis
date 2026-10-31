export const meta = {
  name: 'gauntlet',
  description: 'Gauntlet loop: fan out one worker per piece, a blind critic that RUNS the check, then one verifier per round on the fix only; loop until the bar is green, the round cap is hit, a round changes nothing, or a fix breaks something (escalated to a human)',
  whenToUse: 'Push an already-on-brief build to a much higher quality bar, when the bar is a command that exits non-zero or a named reference artefact. Not for first drafts.',
  phases: [
    { title: 'Decompose' },
    { title: 'Gauntlet' },
    { title: 'Regression' },
  ],
}

// ---------------------------------------------------------------- args
// {
//   task:         string   what to improve (required)
//   projectPath:  string   absolute repo path (required)
//   pieces:       [{name, brief}]  optional — decomposed by an agent if absent
//   checkCommand: string   the falsifiable bar, e.g. "npm run check"
//   bar:          string   prose bar for what the command cannot measure, plus the
//                          project conventions it relies on (the round-2+ verifier
//                          runs without CLAUDE.md, so it only knows what is here)
//   references:   [string] absolute paths / URLs the critic compares against
//   maxRounds:    number   per-piece worker↔critic attempts (default 3)
//   serial:       bool     pieces touch shared files — run one at a time
//                          (default false: parallel, and the verifier is told so)
//   pieceCount:   number   how many pieces to decompose into (default 5)
//   roundCost:    number   output tokens to reserve per round (default 60000)
// }

const a = args || {}
if (!a.task || !a.projectPath) throw new Error('gauntlet: task and projectPath are required')

const MAX_ROUNDS = a.maxRounds ?? 3
// A round is a worker at high effort plus a critic at high effort. Starting one
// with less than this left in the turn budget means the agent() call throws
// mid-piece, which reads as a crash instead of a budget decision.
const ROUND_COST = a.roundCost ?? 60_000
const CHECK = a.checkCommand || null
const REFS = a.references || []
const BAR = [
  CHECK ? `Hard gate: \`${CHECK}\` must exit 0. Run it yourself; do not trust a report that it passed.` : null,
  a.bar || null,
  REFS.length ? `Compare against these references: ${REFS.join(', ')}` : null,
  CHECK ? 'Regression net: every check that is green today stays green.' : null,
].filter(Boolean).join('\n')

// Fotografia dell'albero di lavoro che non tocca né l'indice vero né i ref:
// un indice privato per pezzo dentro .git (copiato da quello vero per non
// ri-hashare ogni file), `add -A` per prendere anche i file nuovi, `write-tree`
// per lo sha. Stesso sha tra due round = il fix non ha cambiato niente;
// `git diff A B` tra due fotografie = esattamente il fix di quel round, che è
// l'unica cosa che il verifier del round dopo deve guardare. Percorsi assoluti:
// GIT_INDEX_FILE relativo si risolve dalla radice, non dalla cartella corrente.
function snapshotCmd(piece) {
  const slug = String(piece.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const idx = `"$(git rev-parse --path-format=absolute --git-path gauntlet-${slug}.index)"`
  return `i=${idx} && { cp "$(git rev-parse --path-format=absolute --git-path index)" "$i" 2>/dev/null || true; } ` +
    `&& GIT_INDEX_FILE="$i" git add -A && GIT_INDEX_FILE="$i" git write-tree`
}

// worker e verifier stanno in ~/.claude/agents, non in questo repo: chi usa
// solo il workflow non li ha, e agent() con un tipo sconosciuto lancia prima di
// spawnare. Si ripiega sul subagent di default (costa di più, verifica uguale)
// e lo si dice una volta, invece di perdere il pezzo.
const missingTypes = new Set()
async function spawn(prompt, opts) {
  const { agentType, ...rest } = opts
  if (agentType && !missingTypes.has(agentType)) {
    try {
      return await agent(prompt, opts)
    } catch (e) {
      if (!/agent type '[^']*' not found/.test(String(e?.message ?? e))) throw e
      missingTypes.add(agentType)
      log(`agent type '${agentType}' not installed — using the default workflow subagent (see ~/.claude/agents/${agentType}.md)`)
    }
  }
  // Il ripiego deve dichiarare il modello: senza eredita Opus. Solo il verifier lo tiene.
  return agent(prompt, agentType === 'verifier' ? rest : { model: 'sonnet', ...rest })
}

const PIECE_SCHEMA = {
  type: 'object',
  properties: {
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'short identifier' },
          brief: { type: 'string', description: 'what this piece must achieve, concretely' },
          files: { type: 'array', items: { type: 'string' }, description: 'likely files to touch' },
        },
        required: ['name', 'brief'],
      },
    },
  },
  required: ['pieces'],
}

const WORK_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'what you changed, one paragraph' },
    filesChanged: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesChanged'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'true only if the bar is fully met' },
    checkExitedZero: { type: 'boolean', description: 'did you run the check command, and did it exit 0' },
    defects: {
      type: 'array',
      items: { type: 'string' },
      description: 'specific, actionable defects — never vague dissatisfaction',
    },
    evidence: { type: 'string', description: 'the output or measurement you based the verdict on' },
    diffStat: {
      type: 'string',
      description: 'the last line of `git diff --stat` for the working tree, verbatim (empty string if the tree is clean)',
    },
    snapshot: { type: 'string', description: 'the tree sha printed by the snapshot command, verbatim' },
  },
  required: ['pass', 'defects'],
}

// Dal round 2: stesso verdetto più le due cose che solo un claim stretto sa dire.
const REVERIFY_SCHEMA = {
  type: 'object',
  properties: {
    ...VERDICT_SCHEMA.properties,
    defects: {
      type: 'array',
      items: { type: 'string' },
      description: 'the listed defects still open, each starting with its id ("D2: ..."), plus the check if it exits non-zero',
    },
    regressions: {
      type: 'array',
      items: { type: 'string' },
      description: 'things that worked before the fix and do not now, caused by the fix diff — file:line and the observation. Empty if none.',
    },
    outOfScope: {
      type: 'array',
      items: { type: 'string' },
      description: 'serious problems noticed outside the claim; reported to a human, they do not fail this round',
    },
  },
  required: ['pass', 'defects', 'regressions'],
}

// ------------------------------------------------------------ decompose
phase('Decompose')

let pieces = a.pieces
if (!pieces || !pieces.length) {
  const plan = await spawn(
    `Repo: ${a.projectPath}\n\n` +
    `GOAL\n${a.task}\n\n` +
    `BAR\n${BAR}\n\n` +
    `Read enough of the repo to decompose this goal into at most ${a.pieceCount ?? 5} of the ` +
    `SMALLEST INDEPENDENT pieces that can each be worked and verified on their own. ` +
    `Prefer pieces that touch disjoint files. Do not write any code — only plan. ` +
    `Each brief must state a concrete outcome, not a vibe.`,
    { label: 'decompose', phase: 'Decompose', schema: PIECE_SCHEMA, agentType: 'worker' },
  )
  pieces = plan?.pieces || []
}
if (!pieces.length) throw new Error('gauntlet: nothing to work on — decomposition returned no pieces')
log(`${pieces.length} pieces · bar: ${CHECK || 'prose only'} · max ${MAX_ROUNDS} rounds each`)

// -------------------------------------------------------------- gauntlet
phase('Gauntlet')

// Dal round 2 non serve un altro critico aperto su tutta la change: i lens
// aperti trovano scope nuovo a ogni giro e il loop non converge. Serve UN
// verifier su un claim falsificabile: i difetti D1..Dn sono chiusi dal fix,
// la barra è verde, il fix non ha rotto niente di ciò che toccava.
function reverifyPrompt(piece, round, openDefects, prevSnapshot) {
  const ids = openDefects.map((d, i) => `D${i + 1}. ${d}`).join('\n')
  const all = openDefects.length > 1 ? `D1..D${openDefects.length}` : 'D1'
  const snap = snapshotCmd(piece)
  const scope = prevSnapshot
    ? `The previous critic photographed the tree it reviewed as ${prevSnapshot}. Photograph the tree now ` +
      `(run this verbatim — it uses a private index, never the real one):\n  ${snap}\n` +
      `then read the fix: \`git diff ${prevSnapshot} <sha you got> --stat\`, then \`git diff ${prevSnapshot} <sha you got>\`. ` +
      `That diff is the whole scope.`
    : `The previous critic recorded no snapshot, so the fix cannot be isolated: read \`git diff\` (the whole ` +
      `change) but judge only the claim. Still photograph the tree now (verbatim, private index):\n  ${snap}`
  // In parallelo gli altri pezzi scrivono nello stesso albero mentre questo si
  // verifica: il diff fra le due fotografie contiene anche i loro cambi, e la
  // barra può essere rossa per un loro lavoro a metà. Senza dirlo, il verifier
  // addebita al fix una rottura altrui e manda all'umano il pezzo sbagliato.
  // Il gate finale rifà comunque la barra su tutto l'albero, a pezzi finiti.
  const others = a.serial ? [] : pieces.filter(p => p.name !== piece.name).map(p => p.name)
  const concurrent = others.length
    ? `OTHER PIECES\nOther pieces (${others.join(', ')}) are being worked in parallel in this same repo, right now. ` +
      `The diff above can contain their edits, and a check can be red because one of them is half-done. A regression ` +
      `counts only if it traces to a change this piece's fix made (this piece's brief` +
      (piece.files?.length ? `, likely files ${piece.files.join(', ')}` : '') + `). A breakage that traces to ` +
      `another piece's change goes to outOfScope with the file, never to regressions or defects` +
      (CHECK ? `; if it is the only reason \`${CHECK}\` is red, (b) holds for this piece: the final gate reruns ` +
        `the check on the whole tree once every piece is done` : '') +
      `.\n\n`
    : ''
  return (
    `Repo: ${a.projectPath}\n\n` +
    `You are verifying ONE CLAIM about piece "${piece.name}", round ${round}. You did not write the fix ` +
    `and you have not been told what it changed.\n\n` +
    `PIECE — ${piece.name}\n${piece.brief}\n\n` +
    `BAR\n${BAR}\n\n` +
    `CLAIM\nIn round ${round - 1} a critic rejected this piece with these defects:\n${ids}\n` +
    `A worker then made a fix. The claim: (a) the fix closes ${all}; (b) the bar holds` +
    (CHECK ? ` — \`${CHECK}\` exits 0 when YOU run it` : '') +
    `; (c) the fix broke nothing that worked before it, in the files it touched.\n\n` +
    `SCOPE\n${scope}\n\n` +
    concurrent +
    // Il verifier gira senza CLAUDE.md (omitClaudeMd), il critico del round 1
    // no: un Di può citare una convenzione di progetto che la barra non dice.
    `CONVENTIONS\nYou run without CLAUDE.md. The project conventions that count are the ones stated in BAR. The ` +
    `round-1 critic had the repo's own instructions loaded: if a Di cites a convention BAR does not state, read it in ` +
    `${a.projectPath}/CLAUDE.md or ${a.projectPath}/AGENTS.md (or the one nearest the file), for that Di only.\n\n` +
    `RULES\n` +
    `- Verify the claim; do not re-audit the piece. An open review already ran in round 1. Add no requirement beyond the bar.\n` +
    `- defects: the Di still open, each starting with its id ("D2: ..."), plus the check if it exits non-zero. A Di the fix closed is not listed.\n` +
    `- regressions: something that worked before the fix and does not now, caused by the fix diff — a test or check gone red, ` +
    `behaviour removed, a check weakened so it passes. file:line and what you observed. A regression stops the loop and goes ` +
    `to a human, so never guess one: if you need proof it worked before, run it on the previous tree in a scratch worktree ` +
    (prevSnapshot
      ? `(\`git worktree add --detach "$TMPDIR/gauntlet-prev" "$(git commit-tree ${prevSnapshot} -m prev)"\`, then \`git worktree remove\` it).\n`
      : `at HEAD.\n`) +
    `- outOfScope: anything serious you notice outside the claim (outside the fix diff, or beyond the bar). It reaches the ` +
    `human; it never goes in defects and never fails this round.\n` +
    `- pass:true only if (a), (b) and (c) all hold.\n` +
    `- Report snapshot (the sha the command printed) and diffStat (the last line of \`git diff --stat\`, verbatim).`
  )
}

// One piece through the worker <-> blind-critic loop. The critic never sees the
// worker's self-report: it inspects the repo and runs the check itself.
async function runPiece(piece) {
  const where = piece.files?.length ? `\nLikely files: ${piece.files.join(', ')}` : ''
  let defects = []
  let lastVerdict = null
  let lastState = null
  let lastSnapshot = null
  // Ciò che i verifier vedono fuori dal claim: non fa girare round, arriva all'umano.
  const notes = []

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Budget is shared across the whole turn, so a piece that starts a round it
    // cannot finish takes the rest of the run down with it. Stopping here ends
    // the piece as unverified — which is what it is — instead of as a failure
    // the worker could have fixed.
    if (budget.total && budget.remaining() < ROUND_COST) {
      log(`⊘ ${piece.name} — out of budget before round ${round}`)
      return {
        piece: piece.name, passed: false, unverified: true, budgetExhausted: true,
        rounds: round - 1, verdict: lastVerdict, notes,
      }
    }

    const fix = defects.length
      ? `\n\nA critic rejected the previous round. Fix exactly these defects:\n- ${defects.join('\n- ')}`
      : ''

    await spawn(
      `Repo: ${a.projectPath}\n\n` +
      `GOAL\n${a.task}\n\n` +
      `YOUR PIECE — ${piece.name}\n${piece.brief}${where}\n\n` +
      `BAR\n${BAR}${fix}\n\n` +
      `Implement this piece in the repo. Stay inside your piece: do not refactor ` +
      `unrelated code and do not weaken any existing check to make it pass. ` +
      (CHECK ? `Run \`${CHECK}\` before you finish and leave it green. ` : '') +
      `Report what you changed.`,
      { label: `work:${piece.name}`, phase: 'Gauntlet', schema: WORK_SCHEMA, effort: 'high', agentType: 'worker' },
    )

    const verdict = round > 1
      ? await spawn(reverifyPrompt(piece, round, defects, lastSnapshot), {
        label: `verify:${piece.name}:r${round}`, phase: 'Gauntlet', schema: REVERIFY_SCHEMA, agentType: 'verifier',
      })
      : await spawn(
      `Repo: ${a.projectPath}\n\n` +
      `You are a CRITIC. You did not write this code and you have not been told what was ` +
      `changed — find out yourself (\`git diff\`, read the files, run things).\n\n` +
      `PIECE UNDER REVIEW — ${piece.name}\n${piece.brief}\n\n` +
      `BAR\n${BAR}\n\n` +
      (CHECK
        ? `Run \`${CHECK}\` yourself and read its output. If it exits non-zero, this fails — no exceptions.\n`
        : '') +
      (REFS.length
        ? `Put the result next to the reference(s) and list concrete mismatches, not impressions.\n`
        : '') +
      `Default to pass:false when you are uncertain. Every defect must be specific enough ` +
      `for someone else to fix without asking you a question. Do not invent work beyond the bar: ` +
      `if the bar is met, pass.\n` +
      `Also report diffStat: the last line of \`git diff --stat\` verbatim. It decides whether ` +
      `the previous round changed anything at all, so do not paraphrase or estimate it.\n` +
      `Finally photograph the tree you reviewed and report the sha it prints as snapshot. Run this ` +
      `verbatim — it uses a private index, never the real one:\n  ${snapshotCmd(piece)}\n` +
      `The next round verifies only the fix made on top of this snapshot.`,
      { label: `critic:${piece.name}`, phase: 'Gauntlet', schema: VERDICT_SCHEMA, effort: 'high', agentType: 'worker' },
    )

    // A dead agent is NOT an approval. agent() returns null when the subagent
    // is skipped or dies on a terminal API error (rate limit, outage) — and a
    // critic that never answered has verified nothing. Counting that as a pass
    // reports work that was never done, so it ends the piece as UNVERIFIED.
    if (!verdict) {
      log(`⚠ ${piece.name} — round ${round}: critic did not return (skipped or API error)`)
      return { piece: piece.name, passed: false, unverified: true, rounds: round, verdict: lastVerdict, notes }
    }
    lastVerdict = verdict
    for (const note of verdict.outOfScope || []) notes.push({ round, note })

    // Il fix di questo round ha rotto ciò che funzionava: un round N+1 farebbe
    // solo un altro fix tardivo su codice che peggiora (a r3 circa 6 major su 27
    // erano regressioni del fix prima). Decide un umano. Viene prima del pass:
    // un pass con una regressione dentro non è un pass.
    const regressions = round > 1 ? (verdict.regressions || []) : []
    if (regressions.length) {
      log(`⚠ ESCALATE ${piece.name} — the round ${round} fix broke what worked (${regressions.length}): ${regressions.join(' · ')} — a human decides, no round ${round + 1}`)
      return { piece: piece.name, passed: false, escalated: true, regressions, rounds: round, verdict, notes }
    }
    if (verdict.pass) {
      log(`✓ ${piece.name} — passed at round ${round}`)
      return { piece: piece.name, passed: true, rounds: round, verdict, notes }
    }
    defects = verdict.defects || []

    // A round that left the tree exactly as it was, against the same defects,
    // has told us the worker cannot move this piece — rerunning it just spends
    // another worker and critic to be told the same thing. Prime Agent's gate
    // policy calls this out explicitly: never rerun an unchanged failed gate.
    // Only trust it when the critic actually reported a fingerprint; a missing
    // diffStat is unknown, not "unchanged".
    const state = verdict.diffStat != null ? `${verdict.diffStat}\x00${defects.join('|')}` : null
    // Con due fotografie il confronto è esatto: stesso sha = il worker non ha
    // toccato niente, qualunque sia il testo dei difetti (dal round 2 li scrive un
    // altro agente, con altre parole). diffStat + difetti resta solo per chi non
    // riporta la fotografia: è grossolano, due fix diversi possono avere lo stesso stat.
    const unchanged = verdict.snapshot && lastSnapshot
      ? verdict.snapshot === lastSnapshot
      : state !== null && state === lastState
    if (unchanged) {
      log(`⊘ ${piece.name} — round ${round} changed nothing, stopping`)
      return { piece: piece.name, passed: false, stalled: true, rounds: round, verdict, notes }
    }
    lastState = state
    lastSnapshot = verdict.snapshot || null

    log(`✗ ${piece.name} — round ${round}: ${defects.length} defect(s)`)
  }

  log(`⊘ ${piece.name} — round cap (${MAX_ROUNDS}) reached, still red`)
  return { piece: piece.name, passed: false, rounds: MAX_ROUNDS, verdict: lastVerdict, notes }
}

// Un agent() che lancia (budget sforato a metà round, tipo d'agente negato) non
// deve far sparire il pezzo: parallel() lo trasformerebbe in null e il filtro
// sotto lo toglierebbe, fino a un GREEN su 0/0 pezzi. Resta, come non verificato.
const guarded = p => runPiece(p).catch(e => ({
  piece: p.name, passed: false, unverified: true, error: String(e?.message ?? e), rounds: 0, notes: [],
}))

let results
if (a.serial) {
  // Pieces share files: concurrent edits would clobber each other.
  results = []
  for (const p of pieces) results.push(await guarded(p))
} else {
  results = await parallel(pieces.map(p => () => guarded(p)))
}
results = results.filter(Boolean)

// ------------------------------------------------------------ regression
phase('Regression')

let regression = null
if (CHECK) {
  regression = await spawn(
    `Repo: ${a.projectPath}\n\n` +
    `Run \`${CHECK}\` once on the current tree and report the verdict verbatim. ` +
    `Then run \`git diff --stat\` and report it. Fix nothing — this is a read-only final gate.`,
    { label: 'regression', phase: 'Regression', schema: VERDICT_SCHEMA, effort: 'low', agentType: 'worker' },
  )
  if (regression && !regression.pass) log(`REGRESSION RED: ${(regression.defects || []).join(' · ')}`)
}

// Three outcomes, never conflated: verified-green, verified-red, and never
// verified at all (agent died / was skipped / budget ran out). The last one is
// the dangerous one to report as success — it means the piece may not have been
// worked. Running out of rounds, budget, or time is a reason the loop stopped;
// it is never evidence that the bar was met.
const unverified = results.filter(r => r.unverified)
const failed = results.filter(r => !r.passed && !r.unverified)
const stalled = failed.filter(r => r.stalled)
const escalated = failed.filter(r => r.escalated)
const passed = results.filter(r => r.passed)
const outOfScope = results.flatMap(r => (r.notes || []).map(n => ({ piece: r.piece, round: n.round, note: n.note })))

if (failed.length) log(`${failed.length}/${results.length} pieces ended red (${stalled.length} stopped early: nothing changed)`)
if (escalated.length) log(`ESCALATE — ${escalated.length} piece(s) need a human, a fix broke what worked: ${escalated.map(r => r.piece).join(', ')}`)
if (outOfScope.length) log(`${outOfScope.length} problem(s) seen outside the claim, NOT checked by the loop: ${outOfScope.map(o => `${o.piece}: ${o.note}`).join(' · ')}`)
if (unverified.length) log(`${unverified.length}/${results.length} pieces NOT VERIFIED — rerun them: ${unverified.map(r => r.error ? `${r.piece} (${r.error})` : r.piece).join(', ')}`)

const outcome = unverified.length ? 'unverified'
  : (failed.length || (regression && !regression.pass)) ? 'red'
  : 'green'
log(outcome === 'green'
  ? `GREEN — ${passed.length}/${results.length} pieces verified against the bar`
  : `${outcome.toUpperCase()} — the bar is not met; do not report this run as done`)

return {
  outcome,
  task: a.task,
  bar: BAR,
  passed: passed.map(r => r.piece),
  failed: failed.map(r => ({
    piece: r.piece,
    stalled: !!r.stalled,
    escalated: !!r.escalated,
    defects: r.verdict?.defects || [],
  })),
  escalate: escalated.map(r => ({ piece: r.piece, round: r.rounds, regressions: r.regressions })),
  outOfScope,
  unverified: unverified.map(r => (r.error
    ? { piece: r.piece, reason: 'error', error: r.error }
    : { piece: r.piece, reason: r.budgetExhausted ? 'budget' : 'critic-missing' })),
  rounds: Object.fromEntries(results.map(r => [r.piece, r.rounds])),
  regression: regression ? { pass: regression.pass, evidence: regression.evidence } : null,
}
