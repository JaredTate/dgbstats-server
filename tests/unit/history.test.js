// TDD: historical daily per-algo stats — pure aggregation + response builder.
// Charts are reconstructed from block HEADERS (works on a pruned node), so a
// day's difficulty is the AVERAGE over all of an algo's blocks that UTC day
// (DigiByte retargets every block per algo). foldHeaders buckets headers by
// UTC day + algo; buildDailyResponse derives avgDifficulty and per-algo daily
// hashrate = 2^32 * sum_difficulty / 86400.
import { describe, it, expect } from 'vitest';
import {
  foldHeaders,
  foldHeadersHourly,
  buildDailyResponse,
  buildHourlyResponse,
  sortAlgos,
  clampDays,
  clampHours,
  bucketHour,
  computeBackfillGap,
  BLOCKS_PER_DAY,
} from '../../history.js';

// 2026-07-05 UTC anchors
const T_0459 = Date.UTC(2026, 6, 5, 4, 59, 0) / 1000; // 2026-07-05 04:59 UTC
const END_04 = Date.UTC(2026, 6, 4, 23, 59, 59) / 1000; // last second of 2026-07-04
const START_05 = Date.UTC(2026, 6, 5, 0, 0, 1) / 1000; // first second of 2026-07-05

const hdr = (height, time, difficulty, algo) => ({ height, time, difficulty, algo });

describe('foldHeaders — UTC day bucketing', () => {
  it('splits blocks straddling a UTC midnight into different day buckets', () => {
    const headers = [
      hdr(100, END_04, 10, 'SHA256D'),
      hdr(101, START_05, 20, 'SHA256D'),
    ];
    const out = foldHeaders(headers);
    expect(out).toHaveLength(2);
    const d04 = out.find((r) => r.day === '2026-07-04');
    const d05 = out.find((r) => r.day === '2026-07-05');
    expect(d04.block_count).toBe(1);
    expect(d05.block_count).toBe(1);
    expect(d04.algo).toBe('SHA256D');
  });

  it('uses new Date(time*1000).toISOString().slice(0,10) as the UTC day', () => {
    const out = foldHeaders([hdr(1, T_0459, 5, 'Scrypt')]);
    expect(out[0].day).toBe('2026-07-05');
  });

  it('ignores headers with a non-numeric time', () => {
    const out = foldHeaders([
      hdr(1, T_0459, 5, 'Scrypt'),
      { height: 2, time: 'nope', difficulty: 9, algo: 'Scrypt' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].block_count).toBe(1);
  });

  it('returns [] for empty / nullish input', () => {
    expect(foldHeaders([])).toEqual([]);
    expect(foldHeaders(null)).toEqual([]);
    expect(foldHeaders(undefined)).toEqual([]);
  });
});

describe('foldHeaders — per-algo sum / min / max / last / count', () => {
  const day = Date.UTC(2026, 6, 5, 12, 0, 0) / 1000;
  const headers = [
    hdr(200, day + 0, 100, 'SHA256D'),
    hdr(201, day + 15, 50, 'Scrypt'),
    hdr(202, day + 30, 300, 'SHA256D'),
    hdr(203, day + 45, 200, 'SHA256D'),
    hdr(204, day + 60, 75, 'Scrypt'),
  ];

  it('aggregates each algo independently in the same day', () => {
    const out = foldHeaders(headers);
    const sha = out.find((r) => r.algo === 'SHA256D');
    const scrypt = out.find((r) => r.algo === 'Scrypt');

    expect(sha.block_count).toBe(3);
    expect(sha.sum_difficulty).toBe(600); // 100 + 300 + 200
    expect(sha.min_difficulty).toBe(100);
    expect(sha.max_difficulty).toBe(300);

    expect(scrypt.block_count).toBe(2);
    expect(scrypt.sum_difficulty).toBe(125); // 50 + 75
    expect(scrypt.min_difficulty).toBe(50);
    expect(scrypt.max_difficulty).toBe(75);
  });

  it('takes last_difficulty / last_height from the HIGHEST height in the bucket', () => {
    // Feed out of height order to prove it is height- (not iteration-) driven.
    const shuffled = [
      hdr(203, day + 45, 200, 'SHA256D'), // highest height => this is "last"
      hdr(200, day + 0, 100, 'SHA256D'),
      hdr(202, day + 30, 300, 'SHA256D'),
    ];
    const out = foldHeaders(shuffled);
    const sha = out.find((r) => r.algo === 'SHA256D');
    expect(sha.last_height).toBe(203);
    expect(sha.last_difficulty).toBe(200);
  });

  it('sorts output by day then algo', () => {
    const d1 = Date.UTC(2026, 6, 4, 1, 0, 0) / 1000;
    const d2 = Date.UTC(2026, 6, 5, 1, 0, 0) / 1000;
    const out = foldHeaders([
      hdr(1, d2, 1, 'Skein'),
      hdr(2, d1, 1, 'Scrypt'),
      hdr(3, d2, 1, 'Qubit'),
      hdr(4, d1, 1, 'Odo'),
    ]);
    expect(out.map((r) => `${r.day}/${r.algo}`)).toEqual([
      '2026-07-04/Odo',
      '2026-07-04/Scrypt',
      '2026-07-05/Qubit',
      '2026-07-05/Skein',
    ]);
  });
});

describe('buildDailyResponse — derivation math + shape', () => {
  const NOW = Math.floor(Date.UTC(2026, 6, 5, 18, 0, 0) / 1000); // "today" = 2026-07-05
  const rows = [
    // yesterday, complete
    { network: 'mainnet', day: '2026-07-04', algo: 'SHA256D', block_count: 4, sum_difficulty: 800, min_difficulty: 100, max_difficulty: 300, last_difficulty: 250, last_height: 1003 },
    { network: 'mainnet', day: '2026-07-04', algo: 'Scrypt', block_count: 2, sum_difficulty: 120, min_difficulty: 50, max_difficulty: 70, last_difficulty: 70, last_height: 1002 },
    // today, partial
    { network: 'mainnet', day: '2026-07-05', algo: 'SHA256D', block_count: 1, sum_difficulty: 200, min_difficulty: 200, max_difficulty: 200, last_difficulty: 200, last_height: 1010 },
  ];

  it('derives avgDifficulty = sum/count and hashrate = 2^32*sum/86400', () => {
    const res = buildDailyResponse({ network: 'mainnet', days: 30, rows, now: NOW });
    const y = res.data.find((d) => d.date === '2026-07-04');
    const sha = y.perAlgo.SHA256D;
    expect(sha.avgDifficulty).toBe(200); // 800 / 4
    expect(sha.hashrate).toBeCloseTo((Math.pow(2, 32) * 800) / 86400, 6);
    expect(sha.minDifficulty).toBe(100);
    expect(sha.maxDifficulty).toBe(300);
    expect(sha.lastDifficulty).toBe(250);
    expect(sha.blocks).toBe(4);
  });

  it('flags the final (today) entry partial and totals blocks per day', () => {
    const res = buildDailyResponse({ network: 'mainnet', days: 30, rows, now: NOW });
    expect(res.data.map((d) => d.date)).toEqual(['2026-07-04', '2026-07-05']); // oldest -> newest
    expect(res.data[0].partial).toBe(false);
    expect(res.data[0].totalBlocks).toBe(6); // 4 + 2
    expect(res.data[1].partial).toBe(true); // today
    expect(res.data[1].totalBlocks).toBe(1);
  });

  it('emits the full response contract', () => {
    const res = buildDailyResponse({ network: 'mainnet', days: 30, rows, now: NOW });
    expect(res).toMatchObject({ network: 'mainnet', days: 30, generatedAt: NOW });
    expect(res.algos).toEqual(['SHA256D', 'Scrypt']); // canonical order, distinct present
    expect(Object.keys(res.data[0].perAlgo).sort()).toEqual(['SHA256D', 'Scrypt']);
    const keys = Object.keys(res.data[0].perAlgo.SHA256D).sort();
    expect(keys).toEqual(['avgDifficulty', 'blocks', 'hashrate', 'lastDifficulty', 'maxDifficulty', 'minDifficulty']);
  });

  it('handles no rows without throwing', () => {
    const res = buildDailyResponse({ network: 'testnet', days: 7, rows: [], now: NOW });
    expect(res.algos).toEqual([]);
    expect(res.data).toEqual([]);
  });
});

describe('sortAlgos / clampDays helpers', () => {
  it('orders algos canonically and appends unknowns alphabetically', () => {
    expect(sortAlgos(['Scrypt', 'SHA256D', 'Odo', 'Zzz', 'Aaa'])).toEqual([
      'SHA256D', 'Scrypt', 'Odo', 'Aaa', 'Zzz',
    ]);
  });

  it('clamps days into [1,90] with a default of 30', () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays('abc')).toBe(30);
    expect(clampDays('7')).toBe(7);
    expect(clampDays('0')).toBe(1);
    expect(clampDays('365')).toBe(365); // 1-year view
    expect(clampDays('1095')).toBe(1095); // 3-year view
    expect(clampDays('1825')).toBe(1825); // 5-year view
    expect(clampDays('6000')).toBe(6000); // genesis-covering "All" max
    expect(clampDays('99999')).toBe(6000); // clamped to the genesis bound
  });

  it('clamps hours into [1,48] with a default of 24', () => {
    expect(clampHours(undefined)).toBe(24);
    expect(clampHours('abc')).toBe(24);
    expect(clampHours('12')).toBe(12);
    expect(clampHours('0')).toBe(1);
    expect(clampHours('999')).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// Hourly rollup — same fold, bucketed by UTC hour; hashrate over a 3600s window
// ---------------------------------------------------------------------------

const H_1430 = Date.UTC(2026, 6, 5, 14, 30, 0) / 1000; // 2026-07-05 14:30 UTC
const H_1459 = Date.UTC(2026, 6, 5, 14, 59, 59) / 1000; // last second of the 14:00 hour
const H_1500 = Date.UTC(2026, 6, 5, 15, 0, 1) / 1000; // first second of the 15:00 hour

describe('bucketHour', () => {
  it('zeroes minutes/seconds and emits a Z-suffixed ISO hour string', () => {
    expect(bucketHour(H_1430)).toBe('2026-07-05T14:00:00Z');
    expect(bucketHour(H_1459)).toBe('2026-07-05T14:00:00Z');
    expect(bucketHour(H_1500)).toBe('2026-07-05T15:00:00Z');
  });
});

describe('foldHeadersHourly — UTC hour bucketing', () => {
  it('splits blocks straddling a UTC hour boundary into different hour buckets', () => {
    const out = foldHeadersHourly([
      hdr(100, H_1459, 10, 'SHA256D'),
      hdr(101, H_1500, 20, 'SHA256D'),
    ]);
    expect(out).toHaveLength(2);
    const h14 = out.find((r) => r.hour === '2026-07-05T14:00:00Z');
    const h15 = out.find((r) => r.hour === '2026-07-05T15:00:00Z');
    expect(h14.block_count).toBe(1);
    expect(h15.block_count).toBe(1);
    // aggregates carry `hour` (not `day`)
    expect(h14.day).toBeUndefined();
  });

  it('aggregates per algo within one hour and takes last_* from highest height', () => {
    const out = foldHeadersHourly([
      hdr(203, H_1430 + 45, 200, 'SHA256D'),
      hdr(200, H_1430 + 0, 100, 'SHA256D'),
      hdr(202, H_1430 + 30, 300, 'SHA256D'),
      hdr(201, H_1430 + 15, 50, 'Scrypt'),
    ]);
    const sha = out.find((r) => r.algo === 'SHA256D');
    expect(sha.hour).toBe('2026-07-05T14:00:00Z');
    expect(sha.block_count).toBe(3);
    expect(sha.sum_difficulty).toBe(600);
    expect(sha.min_difficulty).toBe(100);
    expect(sha.max_difficulty).toBe(300);
    expect(sha.last_height).toBe(203);
    expect(sha.last_difficulty).toBe(200);
  });
});

describe('buildHourlyResponse — derivation math + shape', () => {
  const NOW = Math.floor(Date.UTC(2026, 6, 5, 15, 20, 0) / 1000); // current hour = 15:00
  const rows = [
    { network: 'mainnet', hour: '2026-07-05T14:00:00Z', algo: 'SHA256D', block_count: 4, sum_difficulty: 800, min_difficulty: 100, max_difficulty: 300, last_difficulty: 250, last_height: 1003 },
    { network: 'mainnet', hour: '2026-07-05T14:00:00Z', algo: 'Scrypt', block_count: 2, sum_difficulty: 120, min_difficulty: 50, max_difficulty: 70, last_difficulty: 70, last_height: 1002 },
    { network: 'mainnet', hour: '2026-07-05T15:00:00Z', algo: 'SHA256D', block_count: 1, sum_difficulty: 200, min_difficulty: 200, max_difficulty: 200, last_difficulty: 200, last_height: 1010 },
  ];

  it('derives hashrate over a 3600s window (2^32*sum/3600)', () => {
    const res = buildHourlyResponse({ network: 'mainnet', hours: 24, rows, now: NOW });
    const h14 = res.data.find((d) => d.hour === '2026-07-05T14:00:00Z');
    const sha = h14.perAlgo.SHA256D;
    expect(sha.avgDifficulty).toBe(200); // 800/4
    expect(sha.hashrate).toBeCloseTo((Math.pow(2, 32) * 800) / 3600, 6);
  });

  it('flags the current-hour entry partial and orders oldest -> newest', () => {
    const res = buildHourlyResponse({ network: 'mainnet', hours: 24, rows, now: NOW });
    expect(res.data.map((d) => d.hour)).toEqual(['2026-07-05T14:00:00Z', '2026-07-05T15:00:00Z']);
    expect(res.data[0].partial).toBe(false);
    expect(res.data[0].totalBlocks).toBe(6);
    expect(res.data[1].partial).toBe(true); // current hour
  });

  it('emits the hourly contract with `hours` + `hour` (not `days`/`date`)', () => {
    const res = buildHourlyResponse({ network: 'mainnet', hours: 24, rows, now: NOW });
    expect(res).toMatchObject({ network: 'mainnet', hours: 24, generatedAt: NOW });
    expect(res.days).toBeUndefined();
    expect(res.algos).toEqual(['SHA256D', 'Scrypt']);
    expect(res.data[0].date).toBeUndefined();
    expect(typeof res.data[0].hour).toBe('string');
    const keys = Object.keys(res.data[0].perAlgo.SHA256D).sort();
    expect(keys).toEqual(['avgDifficulty', 'blocks', 'hashrate', 'lastDifficulty', 'maxDifficulty', 'minDifficulty']);
  });
});

// ---------------------------------------------------------------------------
// Smart deep-backfill gap decision (the "don't re-walk 3 years every restart")
// ---------------------------------------------------------------------------

describe('computeBackfillGap', () => {
  const TIP = 10_000_000;
  const DAYS = 1095;
  const target = Math.max(0, TIP - DAYS * BLOCKS_PER_DAY); // = TIP - 6,307,200

  it('no coverage yet (currentLow null) => full range [targetStart..tip]', () => {
    expect(computeBackfillGap({ tip: TIP, days: DAYS, currentLow: null })).toEqual({ start: target, end: TIP });
    expect(computeBackfillGap({ tip: TIP, days: DAYS, currentLow: undefined })).toEqual({ start: target, end: TIP });
  });

  it('already covers the target (currentLow <= targetStart) => null (SKIP)', () => {
    expect(computeBackfillGap({ tip: TIP, days: DAYS, currentLow: target })).toBeNull(); // exactly at target
    expect(computeBackfillGap({ tip: TIP, days: DAYS, currentLow: target - 1 })).toBeNull(); // deeper than target
    // Sliding window: tip grew so the target moved forward past the old low => skip.
    const oldLow = TIP - DAYS * BLOCKS_PER_DAY; // old target start
    expect(computeBackfillGap({ tip: TIP + 5000, days: DAYS, currentLow: oldLow })).toBeNull();
  });

  it('partial coverage (currentLow > targetStart) => older gap ONLY [targetStart..currentLow-1]', () => {
    const currentLow = target + 500_000; // only partially deep
    expect(computeBackfillGap({ tip: TIP, days: DAYS, currentLow })).toEqual({ start: target, end: currentLow - 1 });
  });

  it('deepening the config extends the gap down without re-walking covered heights', () => {
    // Was backfilled 90 days deep; now configured for 1095 days.
    const low90 = TIP - 90 * BLOCKS_PER_DAY;
    const gap = computeBackfillGap({ tip: TIP, days: 1095, currentLow: low90 });
    expect(gap).toEqual({ start: TIP - 1095 * BLOCKS_PER_DAY, end: low90 - 1 });
    expect(gap.end).toBeLessThan(low90); // never re-touches already-covered heights
  });

  it('clamps the target start to 0 near genesis', () => {
    expect(computeBackfillGap({ tip: 100, days: DAYS, currentLow: null })).toEqual({ start: 0, end: 100 });
    expect(computeBackfillGap({ tip: 100, days: DAYS, currentLow: 0 })).toBeNull();
  });
});
