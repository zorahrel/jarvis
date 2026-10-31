// Test: redundant cron schema DDL must not revoke the integrity epoch captured by an in-flight exec.
// Run against any OpenClaw 2026.10.7 dist (OC_DIST); exit 0 = every trial matched its expectation.
// Exec path mirrored: commitExecAuthorizations() captures the epoch and prepares readCurrent
// (exec-approvals-store:334,377); readCurrent #1 = beforeSpawn (child:1007); readCurrent #2 = initiateSpawn
// on the relay's "prepared" message (child:858), where production fails.
const D = process.env.OC_DIST ?? '/opt/homebrew/lib/node_modules/openclaw/dist/';
const { r: openOpenClawStateDatabase, l: runOpenClawStateWriteTransaction } = await import(D + 'openclaw-state-db-RDcuGEfu.mjs');
const { n: ensureExecApprovalsSnapshot, t: commitExecAuthorizations } = await import(D + 'exec-approvals-store-DDYe2xk8.mjs');
const { r: captureOpenClawStateWorkerContext } = await import(D + 'openclaw-state-worker-context-BIVxUjU0.mjs');
const { o: runOpenClawStateWorkerOperation } = await import(D + 'openclaw-state-worker-store-61lXp_zM.mjs');
const { createSqliteWorkerWriteAdmission } = await import(D + 'sqlite-worker-store-DV601-rB.mjs');

const revision = () => Atomics.load(new BigInt64Array(captureOpenClawStateWorkerContext().stateIntegrity.revision), 0);
const input = { agentId: 'main', matches: [], command: 'echo hi', resolvedPath: '/bin/echo',
  authorization: { source: 'current-policy', security: 'full', ask: 'off', allowlistSatisfied: false } };

// The state worker runs ensureCronRunReceiptSchema here, exactly as cron reserve (run-admission.worker:162)
// and bind (run-receipt-store:219) do on every cron run.
async function cronReceiptSchemaInWorker() {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => context.admission.assertCurrent();
  await runOpenClawStateWorkerOperation(context, (scope) => scope.execute({ type: 'cron.initializeRunReceipts', input: {} }), {
    assertCurrent, createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [context.admission.databasePath]) });
}
const INDEX = 'idx_cron_run_receipts_job_history';
const indexExists = () => runOpenClawStateWriteTransaction(({ db }) =>
  db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index' AND name = ?").get(INDEX).n === 1);

openOpenClawStateDatabase();
await ensureExecApprovalsSnapshot();
await cronReceiptSchemaInWorker();     // setup: storage already prepared, as in any gateway that ran cron once

let mismatches = 0;
async function trial(name, between, expect, setup = async () => {}, check = () => true) {
  await setup();
  const { readCurrent } = await commitExecAuthorizations(structuredClone(input));
  readCurrent();
  const before = revision();
  await between();
  const after = revision();
  let outcome = 'ok';
  try { readCurrent(); } catch (error) { outcome = 'throw'; }
  const checked = await check();
  const pass = outcome === expect && checked;
  if (!pass) mismatches++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} revision ${before} -> ${after}  readCurrent #2: ${outcome} (expected ${expect})${checked ? '' : '  + CHECK FAILED'}`);
}
await trial('nothing in between', async () => {}, 'ok');
await trial('redundant cron receipt DDL (state worker)', cronReceiptSchemaInWorker, 'ok');
// Control on the same worker path: a missing index makes the DDL real, so it must still run and revoke.
await trial('control: missing index is recreated + revokes', cronReceiptSchemaInWorker, 'throw',
  async () => {
    runOpenClawStateWriteTransaction(({ db }) => db.exec(`DROP INDEX ${INDEX}`));
    // let the worker observe that foreign schema change now, so the trial's capture starts on a fresh epoch
    await commitExecAuthorizations(structuredClone(input)).catch(() => {});
  }, indexExists);
console.log(mismatches ? `${mismatches} trial(s) failed` : 'all trials passed');
process.exitCode = mismatches ? 1 : 0;
