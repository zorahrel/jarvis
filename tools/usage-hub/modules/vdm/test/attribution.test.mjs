import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billableTokens,
  listCostUsd,
  pricingFor,
  attributionForWindow,
  ATTRIBUTION_BANDS,
} from '../lib.mjs';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const WIN = { from: NOW - 5 * HOUR, to: NOW, key: 'u5h' };

const rec = (minutesAgo, over = {}) => ({
  ts: NOW - minutesAgo * 60_000,
  account: 'me@example.com',
  model: 'claude-opus-5',
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  ...over,
});

const sample = (minutesAgo, u5h) => ({ ts: NOW - minutesAgo * 60_000, u5h, u7d: 0 });

// ── billableTokens ──

test('billableTokens counts cache tokens, which are most of a coding turn', () => {
  const r = rec(1, { inputTokens: 20, outputTokens: 500, cacheReadTokens: 90_000, cacheCreationTokens: 2_000 });
  assert.equal(billableTokens(r), 92_520);
});

test('billableTokens treats a pre-cache-accounting row as zero cache, not as missing', () => {
  // Rows written before cache fields existed have neither key.
  assert.equal(billableTokens({ inputTokens: 10, outputTokens: 5 }), 15);
});

// ── pricing ──

test('pricingFor matches the longest model prefix, not the first', () => {
  // 'claude-opus-4-8' must not resolve via a shorter 'claude-opus-4' style key.
  assert.deepEqual(pricingFor('claude-opus-4-8'), { input: 5, output: 25 });
  assert.deepEqual(pricingFor('claude-fable-5'), { input: 10, output: 50 });
  assert.deepEqual(pricingFor('claude-haiku-4-5-20251001'), { input: 1, output: 5 });
});

test('pricingFor falls back to Opus rates for a model it has never heard of', () => {
  assert.deepEqual(pricingFor('claude-something-9'), { input: 5, output: 25 });
  assert.deepEqual(pricingFor(undefined), { input: 5, output: 25 });
});

test('listCostUsd prices cache reads at a tenth of input and writes above it', () => {
  const p = { input: 5, output: 25 };
  const read = listCostUsd(rec(1, { cacheReadTokens: 1e6 }));
  const write = listCostUsd(rec(1, { cacheCreationTokens: 1e6 }));
  const plain = listCostUsd(rec(1, { inputTokens: 1e6 }));
  assert.equal(plain, p.input);
  assert.equal(read, p.input * 0.1);
  assert.equal(write, p.input * 1.25);
  assert.ok(read < plain && plain < write, 'read < input < write');
});

test('listCostUsd sums every token class', () => {
  const cost = listCostUsd(rec(1, {
    inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheCreationTokens: 1e6,
  }));
  assert.equal(cost, 5 + 25 + 0.5 + 6.25);
});

// ── attributionForWindow: my own numbers ──

test('records outside the window are excluded', () => {
  const r = attributionForWindow(
    [rec(10, { outputTokens: 100 }), rec(60 * 9, { outputTokens: 999 })],
    [], WIN);
  assert.equal(r.myTokens, 100);
  assert.equal(r.requests, 1);
});

test('token breakdown exposes cache separately from input and output', () => {
  const r = attributionForWindow([
    rec(10, { inputTokens: 20, outputTokens: 50, cacheReadTokens: 90_000, cacheCreationTokens: 2_000 }),
  ], [], WIN);
  assert.deepEqual(r.tokenBreakdown, {
    inputTokens: 20,
    outputTokens: 50,
    cacheReadTokens: 90_000,
    cacheCreationTokens: 2_000,
  });
  assert.equal(r.myTokens, 92_070);
});

test('records land in the chronological band matching their timestamp', () => {
  const r = attributionForWindow([rec(1, { outputTokens: 50 })], [], WIN);
  assert.equal(r.bands.length, ATTRIBUTION_BANDS);
  assert.equal(r.bands[ATTRIBUTION_BANDS - 1].myTokens, 50, 'a minute ago belongs in the last band');
  assert.equal(r.bands[0].myTokens, 0);
  assert.equal(r.bands.reduce((s, b) => s + b.myTokens, 0), r.myTokens, 'bands sum to the total');
});

test('a record exactly at the window end does not fall off the last band', () => {
  const r = attributionForWindow([rec(0, { outputTokens: 7 })], [], WIN);
  assert.equal(r.bands[ATTRIBUTION_BANDS - 1].myTokens, 7);
});

test('per-model breakdown splits tokens and cost by model', () => {
  const r = attributionForWindow([
    rec(5, { model: 'claude-opus-5', outputTokens: 1e6 }),
    rec(6, { model: 'claude-haiku-4-5', outputTokens: 1e6 }),
  ], [], WIN);
  assert.equal(r.byModel['claude-opus-5'].costUsd, 25);
  assert.equal(r.byModel['claude-haiku-4-5'].costUsd, 5);
  assert.equal(r.myCostUsd, 30);
});

// ── attributionForWindow: the external share (the part that must not lie) ──

test('utilization rising while this proxy saw traffic is attributed to me', () => {
  const r = attributionForWindow(
    [rec(30, { outputTokens: 1000 }), rec(20, { outputTokens: 1000 })],
    [sample(40, 0.1), sample(30, 0.3), sample(20, 0.5)],
    WIN);
  assert.equal(r.externalShare, 0, 'every measured rise happened where I had traffic');
});

test('utilization rising with no traffic here is attributed to someone else', () => {
  const r = attributionForWindow(
    [], // this proxy saw nothing at all
    [sample(40, 0.1), sample(30, 0.3), sample(20, 0.5)],
    WIN);
  assert.equal(r.externalShare, 1, 'the account moved without me — that is external usage');
});

test('external share is a genuine split when both sources are active', () => {
  // Rise of 0.2 in a band with my traffic, 0.2 in a band without.
  const r = attributionForWindow(
    [rec(30, { outputTokens: 1000 })],
    [sample(40, 0.1), sample(30, 0.3), sample(10, 0.5)],
    WIN);
  assert.equal(r.measuredRise.toFixed(4), '0.4000');
  assert.equal(r.externalShare.toFixed(4), '0.5000');
});

test('a window rollover mid-sample does not read as negative external usage', () => {
  const r = attributionForWindow(
    [],
    [sample(40, 0.9), sample(30, 0.05), sample(20, 0.1)], // 5h window reset between samples
    WIN);
  assert.ok(r.measuredRise >= 0, 'a utilization drop must not subtract from the rise');
  assert.equal(r.measuredRise.toFixed(4), '0.0500');
});

test('externalShare is null rather than 0 when nothing was measured', () => {
  const r = attributionForWindow([rec(5, { outputTokens: 10 })], [], WIN);
  assert.equal(r.externalShare, null, 'no samples means unknown, not "all mine"');
  assert.equal(r.coverage, 0);
});

test('coverage reports how much of the window the samples actually cover', () => {
  const full = attributionForWindow(
    [],
    Array.from({ length: 300 }, (_, i) => sample(i, 0.5)), // a sample every minute for 5h
    WIN);
  assert.ok(full.coverage > 0.9, `expected near-full coverage, got ${full.coverage}`);

  const sparse = attributionForWindow([], [sample(10, 0.1), sample(9, 0.2)], WIN);
  assert.ok(sparse.coverage < 0.1, `expected sparse coverage, got ${sparse.coverage}`);
  assert.equal(sparse.externalShare, 1, 'the split still computes — coverage says how much to trust it');
});

test('a single sample yields no rise: a delta needs two points', () => {
  const r = attributionForWindow([], [sample(30, 0.5)], WIN);
  assert.equal(r.measuredRise, 0);
  assert.equal(r.externalShare, null);
});

test('samples outside the window are ignored', () => {
  const r = attributionForWindow([], [sample(60 * 9, 0.1), sample(60 * 8, 0.9)], WIN);
  assert.equal(r.measuredRise, 0);
});

test('the 7d window reads u7d, not u5h', () => {
  const win7 = { from: NOW - 7 * 24 * HOUR, to: NOW, key: 'u7d' };
  const samples = [
    { ts: NOW - 3 * HOUR, u5h: 0.9, u7d: 0.1 },
    { ts: NOW - 2 * HOUR, u5h: 0.1, u7d: 0.4 },
  ];
  const r = attributionForWindow([], samples, win7);
  assert.equal(r.measuredRise.toFixed(4), '0.3000', 'must follow the weekly series');
});
