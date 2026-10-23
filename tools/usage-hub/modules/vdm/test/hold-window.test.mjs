// The usage-cap hold ceiling. `vdm upgrade` restores the vendor's 120-minute cap,
// and the failure is silent — the dashboard would still accept "24 ore" from the
// select and quietly store 120. These tests fail loudly when that happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatDuration } from '../lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Normalised to LF on read. These tests slice the source on "\n}\n"; if git
// checked the file out with CRLF (the Windows default) that needle never
// matches, and the failure reads "<function> is not defined" — which points at
// the code rather than at the invisible byte that actually broke it.
const DASH = readFileSync(join(HERE, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');

// ── formatDuration ──

test('formatDuration keeps seconds only while seconds still read', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(3_000), '3s');
  assert.equal(formatDuration(89_000), '89s');
});

test('formatDuration switches to minutes, then to hours', () => {
  assert.equal(formatDuration(90_000), '2min');
  assert.equal(formatDuration(30 * 60_000), '30min');
  assert.equal(formatDuration(89 * 60_000), '89min');
  assert.equal(formatDuration(90 * 60_000), '1.5h');
  assert.equal(formatDuration(6 * 3_600_000), '6h');
  assert.equal(formatDuration(24 * 3_600_000), '24h');
});

test('formatDuration never renders a negative wait', () => {
  assert.equal(formatDuration(-5_000), '0s');
});

// ── the ceiling ──

test('MAX_HOLD_MIN is 24 hours', () => {
  const m = DASH.match(/const MAX_HOLD_MIN = ([^;]+);/);
  assert.ok(m, 'MAX_HOLD_MIN is gone — an upgrade probably overwrote dashboard.mjs');
  // Multiplied factors only, parsed rather than evaluated: the point is to read a
  // value out of our own source, not to run it.
  const minutes = m[1].split('*').map(p => Number(p.trim())).reduce((a, b) => a * b, 1);
  assert.equal(minutes, 1440);
});

test('both hold ceilings go through MAX_HOLD_MIN, not a literal', () => {
  // clampSettings guards the hand-edited config.json; the /api/settings guard is
  // what the dashboard select talks to. A ceiling left behind in either one wins
  // over the other, so both are asserted.
  assert.match(DASH, /s\.usageCapHoldMin = Math\.floor\(n\(s\.usageCapHoldMin, \d+, 0, MAX_HOLD_MIN\)\)/);
  assert.match(DASH, /patch\.usageCapHoldMin >= 0 && patch\.usageCapHoldMin <= MAX_HOLD_MIN/);
});

test('the settings select offers the full range up to 24h', () => {
  // Il selettore sta nella scheda Impostazioni del hub (public/vdm-tabs.js).
  const ui = readFileSync(join(HERE, '..', '..', '..', 'public', 'vdm-tabs.js'), 'utf8');
  const m = ui.match(/const hv = \[([\d,\s]+)\]/);
  assert.ok(m, 'the hold options are gone from the settings tab');
  const values = m[1].split(',').map(Number);
  assert.equal(values[0], 0, 'no "no wait" option');
  assert.equal(Math.max(...values), 1440, 'the range must reach 24h');
  // Every option must be storable: an option the API rejects is a control that
  // silently does nothing.
  assert.ok(values.every(v => v >= 0 && v <= 1440));
});

// The transport was checked and needs nothing: Node's 300s `requestTimeout` only
// covers *receiving* a request. Measured on 11/08 against this proxy — a request
// whose body was still arriving got `HTTP/1.1 408` at 310s, while a fully received
// request with the response withheld was still connected at 360s, with and without
// `requestTimeout = 0`. A parked hold is the second shape, so no server-side knob
// is involved. What can still cut a long hold short is the client's own timeout.

test('a parked request polls lazily on long waits', () => {
  // 5s ticks for 24h would be ~17k full re-reads of every account file to shave
  // at most a few seconds off a release that already wakes on its own event.
  assert.match(DASH, /const pollFor = \(remaining\) =>/);
});
