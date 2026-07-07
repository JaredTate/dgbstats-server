// TDD: historical daily stats persistence + the backfill/incremental/refold
// jobs, exercised against an in-memory sqlite and a fake header-only RPC (as a
// pruned node would serve). Verifies idempotent backfill (REPLACE), additive
// incremental catch-up (ACCUMULATE), full-day refold correction, the query
// builder, and that an offline node aborts its own work without throwing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sqlite3 from 'sqlite3';
import {
  initHistoryTables,
  createHistoryTracker,
  queryDaily,
  queryHourly,
  bucketHour,
} from '../../history.js';

const dbAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbGet = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

// "today" is fixed at 2026-07-05 12:00 UTC for every test in this file.
const NOW_MS = Date.UTC(2026, 6, 5, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const nowFn = () => NOW_MS;

const DAY04 = Date.UTC(2026, 6, 4) / 1000; // 2026-07-04 00:00 UTC (seconds)
const DAY05 = Date.UTC(2026, 6, 5) / 1000; // 2026-07-05 00:00 UTC (seconds)

/**
 * Synthetic chain: heights 0..9 land on 2026-07-04 (hourly), 10..N on
 * 2026-07-05. Even heights are sha256d, odd are scrypt. difficulty = height+1.
 */
function makeChain(tip) {
  const block = (h) => {
    const time = h < 10 ? DAY04 + h * 3600 : DAY05 + (h - 10) * 3600;
    return { time, difficulty: h + 1, pow_algo: h % 2 === 0 ? 'sha256d' : 'scrypt' };
  };
  const state = { tip };
  const sendRpc = async (method, params) => {
    if (method === 'getblockchaininfo') return { blocks: state.tip };
    if (method === 'getblockhash') return `h${params[0]}`;
    if (method === 'getblockheader') {
      const h = Number(String(params[0]).slice(1));
      if (h < 0 || h > state.tip) return null;
      return block(h);
    }
    return null;
  };
  return { state, sendRpc };
}

describe('initHistoryTables', () => {
  it('creates daily_algo_stats, hourly_algo_stats and history_meta', async () => {
    const db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
    const tables = await dbAll(db, "SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables.map((t) => t.name);
    expect(names).toContain('daily_algo_stats');
    expect(names).toContain('hourly_algo_stats');
    expect(names).toContain('history_meta');
    await new Promise((r) => db.close(r));
  });
});

describe('backfill', () => {
  let db;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  it('folds headers into per-day/algo rows and records tip in meta', async () => {
    const { sendRpc } = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc, days: 30, nowFn });
    await t.backfill();

    // day04 SHA256D = heights 0,2,4,6,8 => diffs 1,3,5,7,9
    const row = await dbGet(db, 'SELECT * FROM daily_algo_stats WHERE network=? AND day=? AND algo=?', ['mainnet', '2026-07-04', 'SHA256D']);
    expect(row.block_count).toBe(5);
    expect(row.sum_difficulty).toBe(25);
    expect(row.min_difficulty).toBe(1);
    expect(row.max_difficulty).toBe(9);
    expect(row.last_height).toBe(8);
    expect(row.last_difficulty).toBe(9);

    const meta = await dbGet(db, 'SELECT * FROM history_meta WHERE network=?', ['mainnet']);
    expect(meta.last_height).toBe(19);
    expect(meta.backfill_done).toBe(1);
  });

  it('is idempotent — running twice yields identical rows (REPLACE, no doubling)', async () => {
    const { sendRpc } = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc, days: 30, nowFn });
    await t.backfill();
    await t.backfill();
    const row = await dbGet(db, 'SELECT * FROM daily_algo_stats WHERE day=? AND algo=?', ['2026-07-04', 'SHA256D']);
    expect(row.block_count).toBe(5); // NOT 10
    expect(row.sum_difficulty).toBe(25);
    const count = await dbGet(db, 'SELECT COUNT(*) AS n FROM daily_algo_stats');
    expect(count.n).toBe(4); // 2 days x 2 algos
  });
});

describe('incrementalOnce', () => {
  let db;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  it('adds only genuinely new blocks onto the affected day (accumulate)', async () => {
    const chain = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc: chain.sendRpc, days: 30, nowFn });
    await t.backfill();

    // day05 SHA256D before: heights 10,12,14,16,18 => diffs 11,13,15,17,19 (sum 75, count 5)
    const before = await dbGet(db, 'SELECT * FROM daily_algo_stats WHERE day=? AND algo=?', ['2026-07-05', 'SHA256D']);
    expect(before.block_count).toBe(5);
    expect(before.sum_difficulty).toBe(75);

    // Two new blocks arrive: height 20 (sha256d, diff 21), height 21 (scrypt, diff 22)
    chain.state.tip = 21;
    const changed = await t.incrementalOnce();
    expect(changed).toBe(true);

    const after = await dbGet(db, 'SELECT * FROM daily_algo_stats WHERE day=? AND algo=?', ['2026-07-05', 'SHA256D']);
    expect(after.block_count).toBe(6); // 5 + 1
    expect(after.sum_difficulty).toBe(96); // 75 + 21
    expect(after.last_height).toBe(20);
    expect(after.last_difficulty).toBe(21);

    const meta = await dbGet(db, 'SELECT * FROM history_meta WHERE network=?', ['mainnet']);
    expect(meta.last_height).toBe(21);
  });

  it('is a no-op when there are no new blocks', async () => {
    const chain = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc: chain.sendRpc, days: 30, nowFn });
    await t.backfill();
    const changed = await t.incrementalOnce(); // tip unchanged
    expect(changed).toBe(false);
  });
});

describe('refoldRecentDays', () => {
  let db;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  it('fully recomputes (REPLACE) the recent days, correcting any drift', async () => {
    const chain = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc: chain.sendRpc, days: 30, nowFn });
    await t.backfill();

    // Corrupt today's row to simulate additive drift / a crash.
    await new Promise((res, rej) =>
      db.run('UPDATE daily_algo_stats SET block_count=999, sum_difficulty=999999 WHERE day=? AND algo=?', ['2026-07-05', 'SHA256D'], (e) => (e ? rej(e) : res())));

    await t.refoldRecentDays(2);
    const row = await dbGet(db, 'SELECT * FROM daily_algo_stats WHERE day=? AND algo=?', ['2026-07-05', 'SHA256D']);
    expect(row.block_count).toBe(5); // corrected back to the true full-day value
    expect(row.sum_difficulty).toBe(75);
  });
});

describe('queryDaily response builder against the DB', () => {
  let db;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  it('returns the daily contract with today flagged partial', async () => {
    const { sendRpc } = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc, days: 30, nowFn });
    await t.backfill();

    const res = await queryDaily(db, 'mainnet', 30, NOW_SEC);
    expect(res.network).toBe('mainnet');
    expect(res.days).toBe(30);
    expect(res.algos).toEqual(['SHA256D', 'Scrypt']);
    expect(res.data.map((d) => d.date)).toEqual(['2026-07-04', '2026-07-05']);
    expect(res.data[0].partial).toBe(false);
    expect(res.data[1].partial).toBe(true); // today
    // day04 SHA256D avg = 25/5 = 5, hashrate = 2^32 * 25 / 86400
    const sha = res.data[0].perAlgo.SHA256D;
    expect(sha.avgDifficulty).toBe(5);
    expect(sha.hashrate).toBeCloseTo((Math.pow(2, 32) * 25) / 86400, 6);
  });
});

describe('full run() startup sequence', () => {
  it('backfills, catches up, refolds, and marks backfill_done', async () => {
    const db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
    const { sendRpc } = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc, days: 30, nowFn, intervalMs: 999999 });
    await t.run();
    t.stop();

    const meta = await dbGet(db, 'SELECT * FROM history_meta WHERE network=?', ['mainnet']);
    expect(meta.backfill_done).toBe(1);
    expect(meta.last_height).toBe(19);
    const rows = await dbAll(db, 'SELECT * FROM daily_algo_stats');
    expect(rows.length).toBe(4);
    // run() also seeds the hourly rollup (each height is its own hourly bucket)
    const hourly = await dbAll(db, 'SELECT * FROM hourly_algo_stats');
    expect(hourly.length).toBe(20); // heights 0..19, one bucket each
    await new Promise((r) => db.close(r));
  });
});

describe('hourly rollup', () => {
  let db;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  it('backfillHourly writes one bucket per UTC hour from the SAME header source', async () => {
    const { sendRpc } = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc, days: 30, hours: 48, nowFn });
    await t.backfillHourly();

    // height 0 => 2026-07-04 00:00 UTC, sha256d, diff 1
    const row = await dbGet(db, 'SELECT * FROM hourly_algo_stats WHERE hour=? AND algo=?', ['2026-07-04T00:00:00Z', 'SHA256D']);
    expect(row.block_count).toBe(1);
    expect(row.sum_difficulty).toBe(1);
    expect(row.last_height).toBe(0);
    const all = await dbAll(db, 'SELECT * FROM hourly_algo_stats');
    expect(all.length).toBe(20);
  });

  it('incrementalOnce folds new blocks into hourly buckets', async () => {
    const chain = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc: chain.sendRpc, days: 30, hours: 48, nowFn });
    await t.backfill(); // daily + meta (cursor=19)
    await t.backfillHourly();

    chain.state.tip = 21; // height 20 (sha256d, 10:00) + height 21 (scrypt, 11:00) on 2026-07-05
    await t.incrementalOnce();

    const h10 = await dbGet(db, 'SELECT * FROM hourly_algo_stats WHERE hour=? AND algo=?', ['2026-07-05T10:00:00Z', 'SHA256D']);
    expect(h10.block_count).toBe(1);
    expect(h10.sum_difficulty).toBe(21);
    expect(h10.last_height).toBe(20);
  });

  it('prunes hourly rows older than the retention window each tick', async () => {
    const chain = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc: chain.sendRpc, days: 30, hours: 48, hourlyRetentionDays: 3, nowFn });
    await t.backfillHourly();

    // Inject a stale hourly row well outside the 3-day window (now = 2026-07-05 12:00).
    await new Promise((res, rej) =>
      db.run('INSERT INTO hourly_algo_stats (network, hour, algo, block_count, sum_difficulty, min_difficulty, max_difficulty, last_difficulty, last_height) VALUES (?,?,?,?,?,?,?,?,?)',
        ['mainnet', '2026-07-01T05:00:00Z', 'SHA256D', 1, 1, 1, 1, 1, 1], (e) => (e ? rej(e) : res())));

    const cutoff = bucketHour(NOW_SEC - 3 * 24 * 3600);
    expect('2026-07-01T05:00:00Z' < cutoff).toBe(true); // sanity: it IS stale

    await t.pruneHourly();
    const stale = await dbGet(db, 'SELECT * FROM hourly_algo_stats WHERE hour=?', ['2026-07-01T05:00:00Z']);
    expect(stale).toBeUndefined();
    // recent rows survive
    const recent = await dbGet(db, 'SELECT * FROM hourly_algo_stats WHERE hour=?', ['2026-07-04T00:00:00Z']);
    expect(recent).toBeTruthy();
  });

  it('queryHourly returns the hourly contract with the current hour partial', async () => {
    const { sendRpc } = makeChain(19);
    const t = createHistoryTracker({ db, network: 'mainnet', sendRpc, days: 30, hours: 48, nowFn });
    await t.backfillHourly();

    // Widen the query window to 48h so it spans both synthetic days.
    const res = await queryHourly(db, 'mainnet', 48, NOW_SEC);
    expect(res.network).toBe('mainnet');
    expect(res.hours).toBe(48);
    expect(res.days).toBeUndefined();
    expect(res.algos).toEqual(['SHA256D', 'Scrypt']);
    expect(res.data[0].hour < res.data[res.data.length - 1].hour).toBe(true); // oldest -> newest
    // 2026-07-04 00:00 SHA256D: avg = 1, hashrate = 2^32 * 1 / 3600
    const first = res.data.find((d) => d.hour === '2026-07-04T00:00:00Z');
    expect(first.perAlgo.SHA256D.avgDifficulty).toBe(1);
    expect(first.perAlgo.SHA256D.hashrate).toBeCloseTo((Math.pow(2, 32) * 1) / 3600, 6);
    expect(first.partial).toBe(false);
  });
});

describe('offline node resilience', () => {
  it('aborts backfill without throwing when getblockchaininfo fails', async () => {
    const db = new sqlite3.Database(':memory:');
    await initHistoryTables(db);
    const deadRpc = async (method) => {
      if (method === 'getblockchaininfo') throw new Error('ECONNREFUSED');
      return null;
    };
    const t = createHistoryTracker({ db, network: 'testnet', sendRpc: deadRpc, days: 30, nowFn });
    const ok = await t.backfill(); // must resolve, not reject
    expect(ok).toBe(false);
    const rows = await dbAll(db, 'SELECT * FROM daily_algo_stats');
    expect(rows).toHaveLength(0);
    // incremental + refold + hourly backfill are likewise silent/non-fatal
    await expect(t.incrementalOnce()).resolves.toBe(false);
    await expect(t.refoldRecentDays(2)).resolves.toBe(false);
    await expect(t.backfillHourly()).resolves.toBe(false);
    const hourly = await dbAll(db, 'SELECT * FROM hourly_algo_stats');
    expect(hourly).toHaveLength(0);
    await new Promise((r) => db.close(r));
  });
});
