import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_HOLIDAYS,
  DEFAULT_PRICE_BOOK,
  finalizePriceBook,
  isPeak,
  mergePriceBooks,
  normalizeHolidays,
  priceMessage,
  toEpochMs,
} from '../lib/pricing.js';

const at = (iso) => Date.parse(iso);
const NO_HOLIDAYS = new Set();
const FLASH = DEFAULT_PRICE_BOOK.models['deepseek-flash'];

function receipt(overrides = {}) {
  return priceMessage({
    model: 'deepseek-flash',
    timestamp: at('2026-10-28T10:00:00+08:00'),
    holidays: NO_HOLIDAYS,
    book: DEFAULT_PRICE_BOOK,
    usage: { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1000000 },
    ...overrides,
  });
}

// ── exact peak/off-peak boundaries in Beijing time ─────────────────────────
{
  const cases = [
    ['2026-10-28T08:59:59+08:00', false],
    ['2026-10-28T09:00:00+08:00', true],
    ['2026-10-28T11:59:59+08:00', true],
    ['2026-10-28T12:00:00+08:00', false],
    ['2026-10-28T13:59:59+08:00', false],
    ['2026-10-28T14:00:00+08:00', true],
    ['2026-10-28T17:59:59+08:00', true],
    ['2026-10-28T18:00:00+08:00', false],
  ];
  for (const [iso, expected] of cases) {
    assert.equal(isPeak(at(iso), NO_HOLIDAYS), expected, iso);
  }
}

// ── timestamp formats: Z, +08:00, and timezone-less ────────────────────────
{
  const warnings = [];
  const z = toEpochMs('2026-10-28T10:00:00Z', (message) => warnings.push(message));
  assert.ok(Number.isFinite(z));
  assert.equal(isPeak(z, NO_HOLIDAYS), false, '10:00Z is 18:00 Beijing');

  const offset = toEpochMs('2026-10-28T10:00:00+08:00');
  assert.equal(isPeak(offset, NO_HOLIDAYS), true);
  assert.equal(toEpochMs(Math.floor(offset / 1000)), offset, 'epoch seconds normalized to milliseconds');

  const naive = toEpochMs('2026-10-28T10:00:00', (message) => warnings.push(message));
  assert.equal(isPeak(naive, NO_HOLIDAYS), true, 'timezone-less is interpreted as +08:00');
  assert.ok(warnings.some((message) => message.includes('缺少时区')));
  assert.equal(toEpochMs('not-a-time'), null);
  assert.equal(toEpochMs(''), null);
}

// ── weekends and holidays are off-peak ─────────────────────────────────────
{
  assert.equal(isPeak(at('2026-10-31T10:00:00+08:00'), NO_HOLIDAYS), false, 'Saturday');
  assert.equal(isPeak(at('2026-11-01T10:00:00+08:00'), NO_HOLIDAYS), false, 'Sunday');
  assert.equal(
    isPeak(at('2026-10-01T10:00:00+08:00'), new Set(['2026-10-01'])),
    false,
    'National Day',
  );
  assert.equal(isPeak(at('2026-10-01T10:00:00+08:00'), NO_HOLIDAYS), true, 'without the holiday it is a normal weekday peak');
}

// ── holiday fallback never degrades to "no holidays" ──────────────────────
{
  const empty = normalizeHolidays([]);
  assert.equal(empty.source, 'default');
  assert.ok(empty.dates.size >= DEFAULT_HOLIDAYS.length);
  assert.ok(empty.dates.has('2026-10-01'));

  const missing = normalizeHolidays(undefined);
  assert.equal(missing.source, 'default');

  const allInvalid = normalizeHolidays(['not-a-date', '2026-13-40', 42]);
  assert.equal(allInvalid.source, 'default');
  assert.ok(allInvalid.dates.has('2026-10-01'));
  assert.ok(allInvalid.invalid >= 3);

  const partial = normalizeHolidays(['2026-10-01', 'bad']);
  assert.equal(partial.source, 'config');
  assert.ok(partial.dates.has('2026-10-01'));
  assert.equal(partial.invalid, 1);

  const disabled = normalizeHolidays([], undefined, false);
  assert.equal(disabled.source, 'none');
  assert.equal(disabled.dates.size, 0);

  const override = normalizeHolidays(['2026-10-01'], undefined, true);
  assert.equal(override.source, 'config');
  assert.equal(override.dates.size, 1, 'non-empty config replaces builtin table rather than merging');

  const futureWarnings = [];
  normalizeHolidays([], (message) => futureWarnings.push(message), true, 2027);
  assert.ok(futureWarnings.some((message) => message.includes('2026')));
}

// ── cross-tier session = sum of per-message prices ─────────────────────────
{
  const peak = receipt({ timestamp: at('2026-10-28T10:00:00+08:00') });
  const offpeak = receipt({ timestamp: at('2026-10-28T22:00:00+08:00') });
  assert.equal(peak.tier, 'peak');
  assert.equal(offpeak.tier, 'offpeak');
  assert.ok(Math.abs(peak.cost - 2) < 1e-9);
  assert.ok(Math.abs(offpeak.cost - 1) < 1e-9);
  assert.ok(Math.abs(peak.cost + offpeak.cost - 3) < 1e-9);
}

// ── cache hits are not charged at the miss rate twice ──────────────────────
{
  // DSH: inputTokens is cache-miss input; cacheRead is separate and total
  // includes both. Miss = 1000, not 200.
  const dsh = receipt({
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 800,
      totalTokens: 1900,
    },
  });
  assert.equal(dsh.inputMissTokens, 1000);
  const expectedDsh = (1000 / 1e6) * 2 + (800 / 1e6) * 0.04 + (100 / 1e6) * 8;
  assert.ok(Math.abs(dsh.cost - expectedDsh) < 1e-12);

  // OpenAI style: inputTokens includes the cached prompt and total is
  // input + output. Miss = 200.
  const inclusive = receipt({
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 800,
      totalTokens: 1100,
    },
  });
  assert.equal(inclusive.inputMissTokens, 200);
  const expectedInclusive = (200 / 1e6) * 2 + (800 / 1e6) * 0.04 + (100 / 1e6) * 8;
  assert.ok(Math.abs(inclusive.cost - expectedInclusive) < 1e-12);
}

// ── unknown model: tokens counted, cost zero ───────────────────────────────
{
  const unknown = receipt({ model: 'not-in-table' });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.unknownModel, true);
  assert.equal(unknown.cost, 0);
  assert.equal(unknown.inputMissTokens, 1000000);
}

// ── missing fields / offpeak fallback / no separate cache-write price ──────
{
  const table = finalizePriceBook({
    models: {
      custom: {
        peak: { input_miss: 2, output: 8 },
        offpeak: {},
      },
    },
  });
  const price = table.book.models.custom;
  assert.equal(price.peak.input_hit, 0, 'missing input_hit is zero');
  assert.equal(price.offpeak.input_miss, 1, 'offpeak defaults to 50% of peak');
  assert.equal(price.offpeak.output, 4);
  assert.deepEqual(Object.keys(price.peak).sort(), ['input_hit', 'input_miss', 'output']);
  assert.ok(table.warnings.some((warning) => warning.includes('offpeak')));
}

// ── cache writes have no separate charge: they are miss input ─────────────
{
  // DSH can report cache-write tokens inside the miss input. The price tier
  // has only three fields, so the charge is exactly input × input_miss.
  assert.deepEqual(Object.keys(FLASH.peak).sort(), ['input_hit', 'input_miss', 'output']);
  const withWrites = receipt({
    usage: { inputTokens: 1500, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1500 },
  });
  assert.equal(withWrites.cost, (1500 / 1e6) * 2, 'writes are billed at input_miss, never separately');
}

// ── the official output price is exactly 8 CNY / 1M at peak ───────────────
{
  const outputOnly = receipt({
    usage: { inputTokens: 0, outputTokens: 1000000, cacheReadTokens: 0, totalTokens: 1000000 },
  });
  assert.equal(outputOnly.tier, 'peak');
  assert.equal(outputOnly.cost, 8);
  const offpeakOutput = receipt({
    timestamp: at('2026-10-28T22:00:00+08:00'),
    usage: { inputTokens: 0, outputTokens: 1000000, cacheReadTokens: 0, totalTokens: 1000000 },
  });
  assert.equal(offpeakOutput.cost, 4, 'offpeak is 50% of peak');
}

// ── merge priority and invalid timestamps ─────────────────────────────────
{
  const official = mergePriceBooks(DEFAULT_PRICE_BOOK, {
    models: { 'deepseek-flash': { peak: { output: 6 } } },
  });
  assert.equal(official.models['deepseek-flash'].peak.output, 6);
  assert.equal(official.models['deepseek-flash'].peak.input_miss, 2, 'untouched fields survive');
  const local = mergePriceBooks(official, {
    models: { 'deepseek-flash': { peak: { output: 5 } } },
  });
  assert.equal(local.models['deepseek-flash'].peak.output, 5);

  const skipped = receipt({ timestamp: Number.NaN });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.cost, 0);
  assert.equal(isPeak(Number.NaN, NO_HOLIDAYS), null);
}

// ── a new model with only peak prices gets the documented 50% offpeak ─────
{
  const merged = mergePriceBooks(DEFAULT_PRICE_BOOK, {
    models: { 'gpt-4o-local': { peak: { input_miss: 3, input_hit: 0.3, output: 12 } } },
  });
  const finalized = finalizePriceBook(merged);
  const price = finalized.book.models['gpt-4o-local'];
  assert.deepEqual(price.peak, { input_miss: 3, input_hit: 0.3, output: 12 });
  assert.deepEqual(
    price.offpeak,
    { input_miss: 1.5, input_hit: 0.15, output: 6 },
    'a brand-new model must not get 0 off-peak prices (night turns would be free)',
  );
}

// ── the shipped JSON is valid and carries the official flash prices ───────
{
  const official = JSON.parse(readFileSync(new URL('../prices/official-prices.json', import.meta.url), 'utf8'));
  assert.deepEqual(official.models['deepseek-flash'].peak, { input_miss: 2, input_hit: 0.04, output: 8 });
  assert.deepEqual(official.models['deepseek-flash'].offpeak, { input_miss: 1, input_hit: 0.02, output: 4 });
  assert.deepEqual(official.models['deepseek-chat'].peak, { input_miss: 2, input_hit: 0.2, output: 8 });
  for (const model of Object.values(official.models)) {
    assert.deepEqual(Object.keys(model.peak).sort(), ['input_hit', 'input_miss', 'output']);
    assert.deepEqual(Object.keys(model.offpeak).sort(), ['input_hit', 'input_miss', 'output']);
  }
}

// ── the built-in table contains the required models ────────────────────────
{
  assert.ok(DEFAULT_PRICE_BOOK.models['deepseek-flash']);
  assert.ok(DEFAULT_PRICE_BOOK.models['deepseek-v4-pro']);
  assert.ok(FLASH.peak.input_miss > 0);
}

console.log('pricing tests passed');
