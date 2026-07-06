// TDD: fork-tracker persistence + one full poll round. Exercises the SQLite
// orphan store and createForkTracker against an injected fake RPC (getchaintips)
// and a block-meta lookup, asserting the chainTips snapshot + orphan recording
// + forkAlert firing behave correctly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sqlite3 from 'sqlite3';
import {
  initializeForkTables,
  recordOrphan,
  getRecentOrphans,
  getDailyOrphanStats,
  createForkTracker,
} from '../../forktracker.js';

const DAY = 24 * 3600 * 1000;
// Fixed UTC noon timestamps on three consecutive days.
const D_05 = Date.UTC(2026, 6, 5, 12, 0, 0); // 2026-07-05
const D_04 = Date.UTC(2026, 6, 4, 12, 0, 0); // 2026-07-04
const D_03 = Date.UTC(2026, 6, 3, 12, 0, 0); // 2026-07-03

const dbAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const active = (height, hash) => ({ height, hash, branchlen: 0, status: 'active' });
const fork = (height, hash, branchlen, status = 'valid-fork') => ({ height, hash, branchlen, status });

describe('orphan persistence', () => {
  let db;
  const NOW = 1751700000000;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initializeForkTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  it('records an orphan and reads it back within the window', async () => {
    await recordOrphan(db, {
      network: 'mainnet', hash: 'x1', height: 1000, branchlen: 1, status: 'valid-fork',
      algo: 'SHA256D', pool: 'DigiHash', version: 536870912, now: NOW,
    });
    const rows = await getRecentOrphans(db, 'mainnet', NOW - 24 * 3600 * 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hash: 'x1', height: 1000, algo: 'SHA256D', pool: 'DigiHash' });
  });

  it('upserts by (network, hash) — updates branchlen/status, keeps first_seen', async () => {
    await recordOrphan(db, { network: 'mainnet', hash: 'x1', height: 1000, branchlen: 1, status: 'valid-fork', now: NOW });
    await recordOrphan(db, { network: 'mainnet', hash: 'x1', height: 1000, branchlen: 3, status: 'invalid', now: NOW + 5000 });
    const rows = await dbAll(db, 'SELECT * FROM orphan_blocks');
    expect(rows).toHaveLength(1);
    expect(rows[0].branchlen).toBe(3);
    expect(rows[0].status).toBe('invalid');
    expect(rows[0].first_seen).toBe(NOW);
  });

  it('aggregates orphans into per-day counts (ascending, distinct by hash)', async () => {
    await recordOrphan(db, { network: 'mainnet', hash: 'a1', height: 1, branchlen: 1, status: 'valid-fork', now: D_03 });
    await recordOrphan(db, { network: 'mainnet', hash: 'a2', height: 2, branchlen: 2, status: 'valid-fork', now: D_03 + 3600000 });
    await recordOrphan(db, { network: 'mainnet', hash: 'b1', height: 3, branchlen: 1, status: 'valid-fork', now: D_05 });
    // re-recording an existing hash must not double-count the day
    await recordOrphan(db, { network: 'mainnet', hash: 'a1', height: 1, branchlen: 3, status: 'invalid', now: D_03 + 7200000 });
    const rows = await getDailyOrphanStats(db, 'mainnet', D_03 - DAY);
    expect(rows.map((r) => ({ day: r.day, count: r.count }))).toEqual([
      { day: '2026-07-03', count: 2 },
      { day: '2026-07-05', count: 1 },
    ]);
    expect(rows[0].max_branchlen).toBe(3); // a1 updated to branchlen 3
  });

  it('excludes orphans older than the window and scopes by network', async () => {
    await recordOrphan(db, { network: 'mainnet', hash: 'old', height: 1, branchlen: 1, status: 'valid-fork', now: NOW - 48 * 3600 * 1000 });
    await recordOrphan(db, { network: 'mainnet', hash: 'new', height: 2, branchlen: 1, status: 'valid-fork', now: NOW - 1 * 3600 * 1000 });
    await recordOrphan(db, { network: 'testnet', hash: 't', height: 3, branchlen: 1, status: 'valid-fork', now: NOW });
    const rows = await getRecentOrphans(db, 'mainnet', NOW - 24 * 3600 * 1000);
    expect(rows.map((r) => r.hash)).toEqual(['new']);
  });
});

describe('createForkTracker poll round', () => {
  let db;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initializeForkTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  const makeTracker = (tipsSequence, extra = {}) => {
    let call = 0;
    const snapshots = [];
    const alerts = [];
    const tracker = createForkTracker({
      db,
      network: 'mainnet',
      sendRpc: async () => tipsSequence[Math.min(call++, tipsSequence.length - 1)],
      getBlockMeta: (hash) => ({ algo: 'SHA256D', pool: 'TestPool', version: 1, timestamp: 0 }),
      getRecentBlocks: () => [],
      onSnapshot: (s) => snapshots.push(s),
      onAlert: (a) => alerts.push(a),
      windowBlocks: 100,
      ...extra,
    });
    return { tracker, snapshots, alerts };
  };

  it('builds a chainTips snapshot and records new stale tips as orphans', async () => {
    const { tracker, snapshots } = makeTracker([[
      active(1000, 'A'),
      fork(999, 'stale1', 1),
    ]]);
    const snap = await tracker.pollOnce();
    expect(snap.active).toEqual({ height: 1000, hash: 'A' });
    expect(snap.tips.map((t) => t.hash)).toContain('stale1');
    expect(snap.counts.validFork).toBe(1);
    expect(snapshots).toHaveLength(1);
    // the newly-seen stale tip is persisted as an orphan, enriched via getBlockMeta
    const orphans = await dbAll(db, 'SELECT * FROM orphan_blocks');
    expect(orphans.map((o) => o.hash)).toContain('stale1');
    expect(orphans.find((o) => o.hash === 'stale1').algo).toBe('SHA256D');
    // snapshot carries historical daily stats for the long-term chart
    expect(Array.isArray(snap.dailyOrphans)).toBe(true);
    expect(snap.dailyOrphans.length).toBeGreaterThanOrEqual(1);
    expect(typeof snap.avgPerDay).toBe('number');
    // Averaged over days actually tracked (1 day here), NOT the full window —
    // otherwise a fresh tracker reads misleadingly low.
    expect(snap.trackedDays).toBe(1);
    expect(snap.avgPerDay).toBe(1); // 1 orphan / 1 tracked day
  });

  it('fires a forkAlert only when the risk level changes', async () => {
    const { tracker, alerts } = makeTracker([
      [active(1000, 'A'), fork(999, 's', 1)],           // none
      [active(1001, 'A2'), fork(1001, 'deep', 2)],       // elevated (branch depth 2)
      [active(1002, 'A3'), fork(1002, 'deep2', 2)],      // still elevated -> no new alert
    ]);
    await tracker.pollOnce();
    await tracker.pollOnce();
    await tracker.pollOnce();
    const levels = alerts.map((a) => a.level);
    // none -> elevated is one transition; staying elevated does not re-alert
    expect(levels).toContain('elevated');
    expect(levels.filter((l) => l === 'elevated')).toHaveLength(1);
  });

  it('detects a reorg (active tip replaced) and records the orphaned tip', async () => {
    const { tracker, alerts } = makeTracker([
      [active(1005, 'OLD')],
      [active(1004, 'NEW'), fork(1005, 'OLD', 2)],   // active regressed + OLD demoted => 2-deep reorg
    ]);
    await tracker.pollOnce();
    await tracker.pollOnce();
    const orphans = await dbAll(db, 'SELECT * FROM orphan_blocks');
    expect(orphans.map((o) => o.hash)).toContain('OLD');
    expect(alerts.some((a) => /reorg/i.test(a.reason))).toBe(true);
  });

  it('survives a null RPC result without wiping the last snapshot', async () => {
    const { tracker } = makeTracker([[active(1000, 'A'), fork(999, 's', 1)]]);
    const first = await tracker.pollOnce();
    // now RPC returns null
    const nullTracker = createForkTracker({
      db, network: 'mainnet',
      sendRpc: async () => null,
      getBlockMeta: () => null, getRecentBlocks: () => [],
      onSnapshot: () => {}, onAlert: () => {},
    });
    nullTracker._setLastSnapshot(first);
    const snap = await nullTracker.pollOnce();
    expect(snap).toEqual(first); // unchanged, last-good retained
  });
});
