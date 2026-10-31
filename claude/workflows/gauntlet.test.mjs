// Test harness for gauntlet.js (the workflow next to this file).
// The Workflow tool runs a script body with agent()/parallel()/phase()/log()/args/budget
// injected and a top-level `return`, so the script is not an importable ESM module.
// We reproduce that shape: strip `export` from meta and wrap the body in an AsyncFunction.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// Il workflow accanto a questo file, non un path assoluto: così la stessa copia
// gira sia da ~/.claude/workflows/ sia da un checkout del repo.
const SRC = readFileSync(new URL('./gauntlet.js', import.meta.url), 'utf8')
  .replace('export const meta', 'const meta')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function run({ args, critics, budgetTotal = null, spend = 0, regression = null, missingTypes = [], throwOn = null }) {
  const calls = []
  // Ogni spawn con prompt e opzioni: servono ai test su tipo d'agente e claim stretto.
  const spawns = []
  const judged = {}
  let spent = 0

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    // Come il runtime vero: un agentType non installato lancia prima di spawnare.
    if (opts.agentType && missingTypes.includes(opts.agentType)) {
      throw new Error(`agent({agentType}): agent type '${opts.agentType}' not found. Available agents: general-purpose`)
    }
    if (throwOn && label === throwOn) throw new Error('WorkflowBudgetExceededError: budget exceeded')
    calls.push(label)
    spawns.push({ label, prompt, opts })
    spent += spend
    if (label.startsWith('decompose')) return { pieces: args.pieces }
    if (label.startsWith('work:')) return { summary: 'done', filesChanged: ['a.ts'] }
    if (label.startsWith('regression')) return regression ?? { pass: true, defects: [], evidence: 'exit 0' }
    // Round 1 = critic:<pezzo>, dal round 2 = verify:<pezzo>:r<n>. Stessa sequenza
    // di verdetti per pezzo, qualunque sia l'etichetta.
    if (label.startsWith('critic:') || label.startsWith('verify:')) {
      const piece = label.split(':')[1]
      const seq = critics[piece]
      const n = judged[piece] = (judged[piece] ?? -1) + 1
      return typeof seq === 'function' ? seq(n) : (seq[Math.min(n, seq.length - 1)])
    }
    throw new Error(`unexpected agent label: ${label}`)
  }

  const parallel = async thunks => {
    const out = []
    for (const t of thunks) { try { out.push(await t()) } catch { out.push(null) } }
    return out
  }
  const budget = {
    total: budgetTotal,
    spent: () => spent,
    remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - spent)),
  }
  const logs = []
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', SRC)
  const result = await fn(args, agent, parallel, parallel, () => {}, m => logs.push(m), budget)
  return { result, calls, spawns, logs }
}

// Quanti verdetti ha chiesto per un pezzo (critico del round 1 + verifier dopo).
const judges = (calls, piece) => calls.filter(c => c === `critic:${piece}` || c.startsWith(`verify:${piece}:`)).length

const base = {
  task: 'improve', projectPath: '/repo', checkCommand: 'npm run check',
  pieces: [{ name: 'p1', brief: 'do p1' }], serial: true,
}
const fail = (diffStat, defects = ['d1'], snapshot) => ({ pass: false, defects, diffStat, snapshot, evidence: 'exit 1' })
let n = 0
const ok = (name, cond, extra = '') => {
  n++
  assert.ok(cond, `T${n} ${name} FAILED ${extra}`)
  console.log(`  ok  T${n} ${name}`)
}

// T1 — critic passes immediately
{
  const { result, calls } = await run({
    args: base, critics: { p1: [{ pass: true, defects: [], diffStat: '1 file changed' }] },
  })
  ok('pass al primo round → outcome green', result.outcome === 'green' && result.passed.length === 1, JSON.stringify(result))
  ok('un solo critic invocato', calls.filter(c => c === 'critic:p1').length === 1)
}

// T2 — always red but the tree keeps changing: must burn the full cap, then report red
{
  const { result, calls } = await run({
    args: base, critics: { p1: i => fail(`${i + 1} files changed`) },
  })
  ok('cap raggiunto → outcome red, non green', result.outcome === 'red' && result.passed.length === 0)
  ok('ha usato tutti e 3 i tentativi', judges(calls, 'p1') === 3, JSON.stringify(calls))
  ok('non marcato stalled', result.failed[0].stalled === false)
}

// T3 — the core fix: identical diff + identical defects must stop the loop early
{
  const { result, calls } = await run({
    args: base, critics: { p1: () => fail('2 files changed, 3 insertions(+)') },
  })
  ok('stallo rilevato → stalled true', result.failed[0]?.stalled === true, JSON.stringify(result.failed))
  ok('si ferma al 2° tentativo invece di 3', judges(calls, 'p1') === 2, JSON.stringify(calls))
  ok('stallo non è successo', result.outcome === 'red')
}

// T3b — a critic that omits diffStat must NOT be treated as "unchanged"
{
  const { calls } = await run({
    args: base, critics: { p1: () => ({ pass: false, defects: ['d1'], evidence: 'exit 1' }) },
  })
  ok('diffStat assente → nessuno stallo dedotto, cap pieno', judges(calls, 'p1') === 3, JSON.stringify(calls))
}

// T4 — dead critic is not an approval
{
  const { result } = await run({ args: base, critics: { p1: () => null } })
  ok('critic morto → unverified, mai green', result.outcome === 'unverified' && result.unverified[0].reason === 'critic-missing', JSON.stringify(result))
}

// T5 — budget exhaustion stops before the round and reports unverified
{
  const { result, calls } = await run({
    args: base, critics: { p1: i => fail(`${i + 1} files changed`) },
    budgetTotal: 100_000, spend: 25_000,
  })
  ok('budget finito → unverified con reason budget', result.outcome === 'unverified' && result.unverified[0].reason === 'budget', JSON.stringify(result))
  ok('non ha esaurito i 3 tentativi', judges(calls, 'p1') < 3, JSON.stringify(calls))
}

// T6 — regression red flips a run whose pieces all passed
{
  const green = [{ pass: true, defects: [], diffStat: '1 file changed' }]
  const { result } = await run({
    args: base, critics: { p1: green },
    regression: { pass: false, defects: ['check exits 1 on the full tree'], evidence: 'exit 1' },
  })
  ok('pezzi verdi ma regression rossa → outcome red', result.outcome === 'red', JSON.stringify(result))
  ok('i pezzi restano riportati come passati', result.passed.length === 1 && result.failed.length === 0)
}

// T7 — dal round 2 UN verifier con un claim stretto, non un altro critico aperto
{
  const { spawns } = await run({
    args: base,
    critics: { p1: i => fail(`${i + 1} files changed`, i === 0 ? ['primo difetto', 'secondo difetto'] : ['D1: ancora aperto'], `snap${i}`) },
  })
  const judgeSpawns = spawns.filter(s => s.label.startsWith('critic:') || s.label.startsWith('verify:'))
  const [r1, r2, r3] = judgeSpawns
  ok('round 1 = critico aperto, non il verifier', r1.label === 'critic:p1' && r1.opts.agentType !== 'verifier', JSON.stringify(r1.opts))
  ok('round 1 fotografa l\'albero (write-tree su indice privato)', /GIT_INDEX_FILE=.*git write-tree/.test(r1.prompt))
  ok('dal round 2 agentType verifier', r2?.opts.agentType === 'verifier' && r3?.opts.agentType === 'verifier', JSON.stringify(judgeSpawns.map(s => s.opts)))
  ok('claim numerato con i difetti del round prima', r2.prompt.includes('D1. primo difetto') && r2.prompt.includes('D2. secondo difetto'), r2.prompt)
  ok('scope = diff dalla fotografia precedente', r2.prompt.includes('git diff snap0') && r3.prompt.includes('git diff snap1'), r2.prompt)
  ok('un solo giudizio per round', judgeSpawns.length === 3, JSON.stringify(judgeSpawns.map(s => s.label)))
}

// T8 — il lavoro gira sull'agente snello worker
{
  const { spawns } = await run({ args: base, critics: { p1: i => fail(`${i + 1} files changed`, ['d1'], `snap${i}`) } })
  const work = spawns.filter(s => s.label.startsWith('work:'))
  ok('ogni work: usa agentType worker', work.length === 3 && work.every(s => s.opts.agentType === 'worker'), JSON.stringify(work.map(s => s.opts)))
  const gate = spawns.find(s => s.label === 'regression')
  ok('anche il gate finale gira su worker', gate?.opts.agentType === 'worker', JSON.stringify(gate?.opts))
}

// T9 — il fix del round 2 rompe ciò che funzionava: escalation, niente round 3
{
  const { result, calls, logs } = await run({
    args: base,
    critics: { p1: [
      fail('1 file changed', ['d1'], 'snapA'),
      { pass: false, defects: [], regressions: ['src/a.ts:10 test auth rosso dopo il fix, verde a snapA'], diffStat: '2 files changed', snapshot: 'snapB', evidence: 'exit 1' },
    ] },
  })
  ok('regressione del fix → escalation, non round 3', judges(calls, 'p1') === 2 && calls.filter(c => c.startsWith('work:')).length === 2, JSON.stringify(calls))
  ok('escalate riporta pezzo, round e regressione', result.escalate?.[0]?.piece === 'p1' && result.escalate[0].round === 2 && /test auth/.test(result.escalate[0].regressions[0]), JSON.stringify(result.escalate))
  ok('escalation = red, mai green', result.outcome === 'red' && result.failed[0]?.escalated === true, JSON.stringify(result))
  ok('log dice ESCALATE', logs.some(l => l.includes('ESCALATE')), JSON.stringify(logs))
}

// T9b — pass:true con una regressione dentro non è un pass
{
  const { result } = await run({
    args: base,
    critics: { p1: [fail('1 file changed', ['d1'], 'snapA'), { pass: true, defects: [], regressions: ['lint indebolito'], diffStat: '2 files changed', snapshot: 'snapB' }] },
  })
  ok('regressione vince su pass:true', result.outcome === 'red' && result.passed.length === 0 && result.escalate?.length === 1, JSON.stringify(result))
}

// T10 — stallo esatto: stessa fotografia dell'albero anche se il testo dei difetti cambia
{
  const { result, calls } = await run({
    args: base,
    critics: { p1: [fail('3 files changed', ['d1'], 'snapA'), fail('3 files changed', ['D1: ancora aperto'], 'snapA'), fail('3 files changed', ['x'], 'snapA')] },
  })
  ok('stesso snapshot → stalled al round 2', result.failed[0]?.stalled === true && judges(calls, 'p1') === 2, JSON.stringify({ calls, failed: result.failed }))
}

// T11 — diffStat uguale ma albero diverso: nessuno stallo finto
{
  const { result, calls } = await run({
    args: base,
    critics: { p1: i => fail('2 files changed, 3 insertions(+)', ['d1'], `snap${i}`) },
  })
  ok('snapshot diversi → niente stallo, cap pieno', judges(calls, 'p1') === 3 && result.failed[0].stalled === false, JSON.stringify(calls))
}

// T12 — ciò che il verifier vede fuori dal claim arriva all'umano senza far girare altri round
{
  const { result, logs } = await run({
    args: base,
    critics: { p1: [fail('1 file changed', ['d1'], 'snapA'), { pass: true, defects: [], regressions: [], outOfScope: ['run_command passa tutto l\'env del server'], diffStat: '1 file changed', snapshot: 'snapB' }] },
  })
  ok('fuori claim → riportato, il pezzo resta verde', result.outcome === 'green' && result.outOfScope?.[0]?.piece === 'p1' && /env del server/.test(result.outOfScope[0].note), JSON.stringify(result))
  ok('fuori claim → nel log', logs.some(l => l.includes('env del server')), JSON.stringify(logs))
}

// T13 — chi clona solo il repo non ha worker/verifier: si ripiega sul default, non si perde il pezzo
{
  const { result, spawns, logs } = await run({
    args: base, missingTypes: ['worker', 'verifier'],
    critics: { p1: [fail('1 file changed', ['d1'], 'snapA'), { pass: true, defects: [], regressions: [], snapshot: 'snapB' }] },
  })
  ok('agentType mancante → default subagent, pezzo verificato', result.outcome === 'green' && spawns.every(s => !s.opts.agentType), JSON.stringify({ result, types: spawns.map(s => s.opts.agentType) }))
  ok('il ripiego è detto nel log, una volta per tipo', logs.filter(l => l.includes("'worker' not installed")).length === 1 && logs.some(l => l.includes("'verifier' not installed")), JSON.stringify(logs))
}

// T14 — un agent() che lancia in parallelo non fa sparire il pezzo (mai green su 0/0)
{
  const { result } = await run({
    args: { ...base, serial: false, pieces: [{ name: 'p1', brief: 'x' }, { name: 'p2', brief: 'y' }] },
    critics: { p1: [{ pass: true, defects: [], diffStat: '1 file changed' }], p2: [{ pass: true, defects: [] }] },
    throwOn: 'work:p2',
  })
  ok('pezzo che lancia → unverified con reason error, non green', result.outcome === 'unverified' && result.unverified[0]?.piece === 'p2' && result.unverified[0].reason === 'error' && /budget exceeded/.test(result.unverified[0].error), JSON.stringify(result))
}

// T15 — in parallelo il diff del verifier contiene anche i cambi degli altri pezzi: glielo si dice
{
  const r2 = [fail('1 file changed', ['d1'], 'snapA'), { pass: true, defects: [], regressions: [], snapshot: 'snapB' }]
  const two = { ...base, serial: false, pieces: [{ name: 'p1', brief: 'x', files: ['src/a.ts'] }, { name: 'p2', brief: 'y' }] }
  const par = await run({ args: two, critics: { p1: r2, p2: [{ pass: true, defects: [] }] } })
  const v = par.spawns.find(s => s.label === 'verify:p1:r2')?.prompt || ''
  // Solo la sezione, fino alla successiva: RULES nomina outOfScope comunque.
  const sec = (v.split('OTHER PIECES')[1] || '').split('\nCONVENTIONS')[0]
  ok('parallelo → il verifier sa che p2 scrive nello stesso repo', sec.includes('p2') && !sec.includes('(p1'), v)
  ok('parallelo → rottura di un altro pezzo va in outOfScope, non in regressions', /another piece/.test(sec) && sec.includes('outOfScope'), sec)
  const ser = await run({ args: { ...two, serial: true }, critics: { p1: r2, p2: [{ pass: true, defects: [] }] } })
  const one = await run({ args: { ...base, serial: false }, critics: { p1: r2 } })
  const quiet = [ser, one].map(x => x.spawns.find(s => s.label === 'verify:p1:r2')?.prompt || '')
  ok('seriale o pezzo unico → nessun avviso sugli altri pezzi', quiet.every(p => p && !p.includes('OTHER PIECES')), JSON.stringify(quiet.map(p => p.length)))
}

// T16 — il verifier gira senza CLAUDE.md: le convenzioni arrivano dalla barra, e sa dove leggere quelle citate dal critico
{
  const { spawns } = await run({
    args: { ...base, bar: 'Nomi in inglese; termini di dominio solo dall\'elenco in AGENTS.md' },
    critics: { p1: [fail('1 file changed', ['d1'], 'snapA'), { pass: true, defects: [], regressions: [], snapshot: 'snapB' }] },
  })
  const v = spawns.find(s => s.label === 'verify:p1:r2')?.prompt || ''
  ok('verifier: le convenzioni messe nella barra gli arrivano', v.includes('termini di dominio solo dall\'elenco in AGENTS.md'), v)
  ok('verifier: sa di girare senza CLAUDE.md e dove leggere una convenzione citata da un Di', /without CLAUDE\.md/.test(v) && v.includes('/repo/CLAUDE.md') && v.includes('/repo/AGENTS.md'), v)
}

console.log(`\n${n} assert, tutti verdi`)
