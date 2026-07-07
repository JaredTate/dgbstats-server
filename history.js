/**
 * DigiByte historical daily per-algo stats
 *
 * Reconstructs long-term (default 30-day) per-algorithm difficulty / hashrate
 * history from block HEADERS only, so it works against a PRUNED node (pruned
 * nodes keep every header). For each UTC day and each of DigiByte's mining
 * algorithms we store the block count and the sum / min / max / last of the
 * per-block difficulty. DigiByte retargets difficulty EVERY block per algo, so
 * a day's representative value is the AVERAGE over all of that algo's blocks
 * that day: avgDifficulty = sum_difficulty / block_count.
 *
 * Per-algo daily network hashrate falls out of the same sum. A block of
 * difficulty D takes ~ D * 2^32 / hashrate seconds to find, so over a day an
 * algo's hashrate ~= (avg difficulty) * 2^32 / (seconds-per-block), and
 * seconds-per-block ~= 86400 / block_count, which simplifies to
 *   hashrate = 2^32 * sum_difficulty / 86400.
 *
 * Persistence lives in its own SQLite file (history.db) so it never contends
 * with the peer/crawler/fork tables in nodes.db. Two background jobs keep it
 * fresh per network: a one-time bounded-concurrency backfill and a 60s
 * incremental updater. Both wrap every RPC call in try/catch, so a network
 * whose node is offline (e.g. testnet) logs and aborts ITS OWN work without
 * ever throwing into the process or affecting the other network.
 *
 * Pure functions (foldHeaders, buildDailyResponse) are unit-tested; the tracker
 * + DB layer are integration-tested against an in-memory sqlite and a fake RPC.
 */

const sqlite3 = require('sqlite3').verbose();
const { getAlgoName } = require('./rpc');

// DigiByte targets ~15s block spacing across all algos => 5760 blocks/day, 240/hour.
const BLOCKS_PER_DAY = 5760;
const BLOCKS_PER_HOUR = 240;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
const POW32 = Math.pow(2, 32);

// Backfill / retention windows.
const DAILY_BACKFILL_DAYS = 90; // ~3 months of daily history on startup
const HOURLY_BACKFILL_HOURS = 48; // ~2 days of hourly history on startup
const HOURLY_RETENTION_DAYS = 3; // prune hourly rows older than this each tick

// Canonical ordering for the `algos` list in the API response.
const ALGO_ORDER = ['SHA256D', 'Scrypt', 'Skein', 'Qubit', 'Odo', 'Myriad-Groestl'];

// UTC bucket keys. Day = 'YYYY-MM-DD'; hour = 'YYYY-MM-DDTHH:00:00Z' (min/sec zeroed).
const bucketDay = (timeSec) => new Date(timeSec * 1000).toISOString().slice(0, 10);
const bucketHour = (timeSec) => `${new Date(timeSec * 1000).toISOString().slice(0, 13)}:00:00Z`;

// ---------------------------------------------------------------------------
// Promisified sqlite helpers (mirrors crawler.js / forktracker.js style)
// ---------------------------------------------------------------------------

// NOTE: named dbRun/dbAll/dbGet (not run/all/get) so they never shadow, nor get
// shadowed by, the tracker's `run()` startup method inside createHistoryTracker.
const dbRun = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function onDone(err) { err ? reject(err) : resolve(this); }));
const dbAll = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbGet = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

function initHistoryTables(db) {
  return dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS daily_algo_stats (
      network TEXT NOT NULL,
      day TEXT NOT NULL,
      algo TEXT NOT NULL,
      block_count INTEGER,
      sum_difficulty REAL,
      min_difficulty REAL,
      max_difficulty REAL,
      last_difficulty REAL,
      last_height INTEGER,
      PRIMARY KEY (network, day, algo)
    )`
  )
    .then(() => dbRun(
      db,
      `CREATE TABLE IF NOT EXISTS history_meta (
        network TEXT PRIMARY KEY,
        last_height INTEGER,
        backfill_done INTEGER DEFAULT 0,
        updated_at INTEGER
      )`
    ))
    .then(() => dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_daily_algo_stats_day ON daily_algo_stats(network, day)'))
    .then(() => dbRun(
      db,
      `CREATE TABLE IF NOT EXISTS hourly_algo_stats (
        network TEXT NOT NULL,
        hour TEXT NOT NULL,
        algo TEXT NOT NULL,
        block_count INTEGER,
        sum_difficulty REAL,
        min_difficulty REAL,
        max_difficulty REAL,
        last_difficulty REAL,
        last_height INTEGER,
        PRIMARY KEY (network, hour, algo)
      )`
    ))
    .then(() => dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_hourly_algo_stats_hour ON hourly_algo_stats(network, hour)'));
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

/**
 * Fold block headers into per-(bucket, algo) aggregates. Bucketing is driven by
 * `bucketOf(timeSec) -> key`, so the SAME tested implementation backs both the
 * daily and hourly rollups.
 *
 * @param {Array<{time:number, difficulty:number, algo:string, height:number}>} headers
 *        `time` is the block unix timestamp, `difficulty` the per-algo
 *        difficulty, `algo` the human-readable name (already run through
 *        getAlgoName), `height` the block height (used to pick last_*).
 * @param {(timeSec:number)=>string} bucketOf   time -> UTC bucket key
 * @param {string} keyName                       output field name ('day'|'hour')
 * @returns {Array<object>} one aggregate per (bucket, algo), sorted by bucket
 *        then algo. last_* come from the HIGHEST height in that bucket.
 */
function foldHeadersBy(headers, bucketOf, keyName) {
  const buckets = new Map();
  for (const h of headers || []) {
    if (!h || typeof h.time !== 'number' || !Number.isFinite(h.time)) continue;
    const bucket = bucketOf(h.time);
    const algo = h.algo || 'Unknown';
    const key = bucket + '\u0000' + algo;
    const diff = Number(h.difficulty) || 0;
    const height = typeof h.height === 'number' ? h.height : -1;

    let b = buckets.get(key);
    if (!b) {
      b = {
        [keyName]: bucket,
        algo,
        block_count: 0,
        sum_difficulty: 0,
        min_difficulty: diff,
        max_difficulty: diff,
        last_difficulty: diff,
        last_height: height,
      };
      buckets.set(key, b);
    }
    b.block_count += 1;
    b.sum_difficulty += diff;
    if (diff < b.min_difficulty) b.min_difficulty = diff;
    if (diff > b.max_difficulty) b.max_difficulty = diff;
    // last_* always reflect the highest height seen in the bucket
    if (height >= b.last_height) {
      b.last_height = height;
      b.last_difficulty = diff;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => {
    if (a[keyName] !== b[keyName]) return a[keyName] < b[keyName] ? -1 : 1;
    return a.algo < b.algo ? -1 : a.algo > b.algo ? 1 : 0;
  });
}

/** Fold into per-(UTC day, algo) aggregates (field: `day`). */
function foldHeaders(headers) {
  return foldHeadersBy(headers, bucketDay, 'day');
}

/** Fold into per-(UTC hour, algo) aggregates (field: `hour`). */
function foldHeadersHourly(headers) {
  return foldHeadersBy(headers, bucketHour, 'hour');
}

function sortAlgos(list) {
  return [...list].sort((a, b) => {
    const ia = ALGO_ORDER.indexOf(a);
    const ib = ALGO_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Build a history response from raw rows. Shared by the daily and hourly views;
 * they differ only in the bucket column, the entry key name, the top-level span
 * field, the hashrate window, and which bucket counts as "current" (partial).
 * Pure so it can be unit-tested with fixture rows (no DB / server needed).
 *
 * @param {object} p
 * @param {string} p.network            'mainnet' | 'testnet'
 * @param {string} p.spanName           'days' | 'hours'
 * @param {number} p.spanValue          the requested (clamped) window size
 * @param {Array<object>} p.rows        DB rows, any order
 * @param {string} p.bucketCol          row field holding the bucket ('day'|'hour')
 * @param {string} p.entryKey           output field name ('date'|'hour')
 * @param {number} p.secondsPerWindow   86400 (day) or 3600 (hour) for hashrate
 * @param {string} p.currentBucket      bucket string for "now" (flagged partial)
 * @param {number} p.now                generatedAt, unix SECONDS
 */
function buildBucketResponse({ network, spanName, spanValue, rows, bucketCol, entryKey, secondsPerWindow, currentBucket, now }) {
  const byBucket = new Map();
  const algoSet = new Set();

  for (const r of rows || []) {
    const bucketVal = r[bucketCol];
    algoSet.add(r.algo);
    if (!byBucket.has(bucketVal)) byBucket.set(bucketVal, {});
    const perAlgo = byBucket.get(bucketVal);
    const blocks = r.block_count || 0;
    const sum = r.sum_difficulty || 0;
    perAlgo[r.algo] = {
      blocks,
      avgDifficulty: blocks > 0 ? sum / blocks : 0,
      minDifficulty: r.min_difficulty,
      maxDifficulty: r.max_difficulty,
      lastDifficulty: r.last_difficulty,
      hashrate: (POW32 * sum) / secondsPerWindow,
    };
  }

  const data = Array.from(byBucket.keys())
    .sort() // ISO date/hour strings sort chronologically => oldest -> newest
    .map((bucketVal) => {
      const perAlgo = byBucket.get(bucketVal);
      const totalBlocks = Object.values(perAlgo).reduce((s, a) => s + a.blocks, 0);
      return { [entryKey]: bucketVal, partial: bucketVal === currentBucket, totalBlocks, perAlgo };
    });

  return {
    network,
    [spanName]: spanValue,
    generatedAt: now,
    algos: sortAlgos(Array.from(algoSet)),
    data,
  };
}

/** Build the /history/daily contract (hashrate over an 86400s window). */
function buildDailyResponse({ network, days, rows, now }) {
  return buildBucketResponse({
    network, spanName: 'days', spanValue: days, rows,
    bucketCol: 'day', entryKey: 'date', secondsPerWindow: SECONDS_PER_DAY,
    currentBucket: bucketDay(now), now,
  });
}

/** Build the /history/hourly contract (hashrate over a 3600s window). */
function buildHourlyResponse({ network, hours, rows, now }) {
  return buildBucketResponse({
    network, spanName: 'hours', spanValue: hours, rows,
    bucketCol: 'hour', entryKey: 'hour', secondsPerWindow: SECONDS_PER_HOUR,
    currentBucket: bucketHour(now), now,
  });
}

/**
 * Read + build the daily response straight from the DB for one network.
 * Selects rows with day >= (today - days) and hands them to buildDailyResponse.
 */
async function queryDaily(db, network, days, nowSec = Math.floor(Date.now() / 1000)) {
  const cutoff = bucketDay(nowSec - days * SECONDS_PER_DAY);
  const rows = await dbAll(
    db,
    'SELECT * FROM daily_algo_stats WHERE network = ? AND day >= ? ORDER BY day ASC, algo ASC',
    [network, cutoff]
  );
  return buildDailyResponse({ network, days, rows, now: nowSec });
}

/**
 * Read + build the hourly response straight from the DB for one network.
 * Selects rows with hour >= (now - hours) and hands them to buildHourlyResponse.
 */
async function queryHourly(db, network, hours, nowSec = Math.floor(Date.now() / 1000)) {
  const cutoff = bucketHour(nowSec - hours * SECONDS_PER_HOUR);
  const rows = await dbAll(
    db,
    'SELECT * FROM hourly_algo_stats WHERE network = ? AND hour >= ? ORDER BY hour ASC, algo ASC',
    [network, cutoff]
  );
  return buildHourlyResponse({ network, hours, rows, now: nowSec });
}

// ---------------------------------------------------------------------------
// Bounded-concurrency helper
// ---------------------------------------------------------------------------

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Results are returned in input order.
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = [];
  const width = Math.max(1, Math.min(concurrency, items.length));
  for (let c = 0; c < width; c++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = next++;
          if (idx >= items.length) break;
          results[idx] = await worker(items[idx], idx);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Upsert primitives
// ---------------------------------------------------------------------------

// The daily and hourly tables are structurally identical, differing only in the
// bucket key column ('day' vs 'hour'). table/keyCol are internal constants (never
// user input), so interpolating them into the SQL is safe.

// REPLACE-write: the aggregate is the COMPLETE value for that (bucket, algo).
// Used by backfill (folds the whole range in one pass) and the recent-window
// refolds, so re-running is idempotent — it overwrites with identical values.
function upsertReplaceRow(db, table, keyCol, network, agg) {
  return dbRun(
    db,
    `INSERT INTO ${table}
       (network, ${keyCol}, algo, block_count, sum_difficulty, min_difficulty, max_difficulty, last_difficulty, last_height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(network, ${keyCol}, algo) DO UPDATE SET
       block_count = excluded.block_count,
       sum_difficulty = excluded.sum_difficulty,
       min_difficulty = excluded.min_difficulty,
       max_difficulty = excluded.max_difficulty,
       last_difficulty = excluded.last_difficulty,
       last_height = excluded.last_height`,
    [network, agg[keyCol], agg.algo, agg.block_count, agg.sum_difficulty, agg.min_difficulty, agg.max_difficulty, agg.last_difficulty, agg.last_height]
  );
}

// ADD-onto: the aggregate holds only NEW blocks for that (bucket, algo). Used by
// the incremental updater, which only ever fetches genuinely new blocks
// (last_height+1 .. tip), so each block is folded in exactly once. min/max are
// merged, and last_* only advance when the new block sits at a higher height.
function upsertAccumulateRow(db, table, keyCol, network, agg) {
  return dbRun(
    db,
    `INSERT INTO ${table}
       (network, ${keyCol}, algo, block_count, sum_difficulty, min_difficulty, max_difficulty, last_difficulty, last_height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(network, ${keyCol}, algo) DO UPDATE SET
       block_count = ${table}.block_count + excluded.block_count,
       sum_difficulty = ${table}.sum_difficulty + excluded.sum_difficulty,
       min_difficulty = MIN(${table}.min_difficulty, excluded.min_difficulty),
       max_difficulty = MAX(${table}.max_difficulty, excluded.max_difficulty),
       last_difficulty = CASE WHEN excluded.last_height >= ${table}.last_height
                              THEN excluded.last_difficulty ELSE ${table}.last_difficulty END,
       last_height = MAX(${table}.last_height, excluded.last_height)`,
    [network, agg[keyCol], agg.algo, agg.block_count, agg.sum_difficulty, agg.min_difficulty, agg.max_difficulty, agg.last_difficulty, agg.last_height]
  );
}

// Daily wrappers (keep the original exported signatures used across tests).
const upsertReplace = (db, network, agg) => upsertReplaceRow(db, 'daily_algo_stats', 'day', network, agg);
const upsertAccumulate = (db, network, agg) => upsertAccumulateRow(db, 'daily_algo_stats', 'day', network, agg);
// Hourly wrappers.
const upsertReplaceHourly = (db, network, agg) => upsertReplaceRow(db, 'hourly_algo_stats', 'hour', network, agg);
const upsertAccumulateHourly = (db, network, agg) => upsertAccumulateRow(db, 'hourly_algo_stats', 'hour', network, agg);

// ---------------------------------------------------------------------------
// Per-network tracker (backfill + incremental + refold)
// ---------------------------------------------------------------------------

function createHistoryTracker({
  db,
  network = 'mainnet',
  sendRpc,
  days = DAILY_BACKFILL_DAYS,
  hours = HOURLY_BACKFILL_HOURS,
  hourlyRetentionDays = HOURLY_RETENTION_DAYS,
  concurrency = 12,
  intervalMs = 60000,
  log = () => {},
  nowFn = () => Date.now(),
}) {
  let timer = null;

  const getMeta = () => dbGet(db, 'SELECT * FROM history_meta WHERE network = ?', [network]);

  const setMeta = ({ last_height, backfill_done }) =>
    dbRun(
      db,
      `INSERT INTO history_meta (network, last_height, backfill_done, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(network) DO UPDATE SET
         last_height = excluded.last_height,
         backfill_done = excluded.backfill_done,
         updated_at = excluded.updated_at`,
      [network, last_height, backfill_done, nowFn()]
    );

  const setLastHeight = (h) =>
    dbRun(
      db,
      `INSERT INTO history_meta (network, last_height, backfill_done, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(network) DO UPDATE SET
         last_height = excluded.last_height,
         updated_at = excluded.updated_at`,
      [network, h, nowFn()]
    );

  async function getTip() {
    const info = await sendRpc('getblockchaininfo');
    if (!info || typeof info.blocks !== 'number') return null;
    return info.blocks;
  }

  /** Delete hourly rows older than the retention window (keeps the table tiny). */
  function pruneHourly() {
    const cutoff = bucketHour(Math.floor(nowFn() / 1000) - hourlyRetentionDays * SECONDS_PER_DAY);
    return dbRun(db, 'DELETE FROM hourly_algo_stats WHERE network = ? AND hour < ?', [network, cutoff]);
  }

  /** Fetch headers for [from..to] with bounded concurrency; nulls dropped. */
  async function fetchHeadersRange(from, to) {
    if (to < from) return [];
    const heights = [];
    for (let h = from; h <= to; h++) heights.push(h);
    const out = await mapWithConcurrency(heights, concurrency, async (height) => {
      try {
        const hash = await sendRpc('getblockhash', [height]);
        if (!hash) return null;
        const hdr = await sendRpc('getblockheader', [hash]);
        if (!hdr || typeof hdr.time !== 'number') return null;
        return { height, time: hdr.time, difficulty: hdr.difficulty, algo: getAlgoName(hdr.pow_algo) };
      } catch (e) {
        return null;
      }
    });
    return out.filter(Boolean);
  }

  /**
   * One-time DAILY backfill of the last `days` UTC days from headers. Folds the
   * whole range in one pass and REPLACE-writes, so it is idempotent. RPC failures
   * are caught and logged — the job aborts without throwing.
   */
  async function backfill() {
    try {
      const tip = await getTip();
      if (tip === null) {
        log(`[history:${network}] backfill skipped — no blockchain info (node offline?)`);
        return false;
      }
      const from = Math.max(0, tip - days * BLOCKS_PER_DAY);
      const headers = await fetchHeadersRange(from, tip);
      const aggs = foldHeaders(headers);
      for (const agg of aggs) await upsertReplace(db, network, agg);
      await setMeta({ last_height: tip, backfill_done: 1 });
      log(`[history:${network}] daily backfill complete: heights ${from}..${tip}, ${headers.length} headers -> ${aggs.length} day/algo rows`);
      return true;
    } catch (e) {
      log(`[history:${network}] backfill error: ${e.message}`);
      return false;
    }
  }

  /**
   * REPLACE-recompute the last `hoursWin` UTC hours of the HOURLY table from
   * headers, then prune. Idempotent. Used at startup to seed / correct the
   * intraday view. Does NOT move the cursor (see run() for cursor discipline).
   */
  async function backfillHourly(hoursWin = hours) {
    try {
      const tip = await getTip();
      if (tip === null) return false;
      await refreshHourlyTo(tip, hoursWin);
      await pruneHourly();
      return true;
    } catch (e) {
      log(`[history:${network}] hourly backfill error: ${e.message}`);
      return false;
    }
  }

  /**
   * Incremental catch-up: fold headers for last_height+1 .. tip and ADD them
   * onto the affected day AND hour rows, then advance last_height. Prunes the
   * hourly table every tick so it stays tiny. Skips cleanly when nothing is new
   * (still prunes). RPC failures caught and logged.
   */
  async function incrementalOnce() {
    try {
      const meta = await getMeta();
      if (!meta || typeof meta.last_height !== 'number') return false; // backfill hasn't run yet
      const tip = await getTip();
      if (tip === null) return false;
      if (tip <= meta.last_height) {
        await pruneHourly();
        return false; // nothing new
      }
      const headers = await fetchHeadersRange(meta.last_height + 1, tip);
      if (headers.length === 0) {
        await setLastHeight(tip);
        await pruneHourly();
        return false;
      }
      for (const agg of foldHeaders(headers)) await upsertAccumulate(db, network, agg);
      for (const agg of foldHeadersHourly(headers)) await upsertAccumulateHourly(db, network, agg);
      await setLastHeight(tip);
      await pruneHourly();
      log(`[history:${network}] incremental: +${headers.length} headers up to height ${tip}`);
      return true;
    } catch (e) {
      log(`[history:${network}] incremental error: ${e.message}`);
      return false;
    }
  }

  /** REPLACE-recompute the last `n` UTC days of the DAILY table to `tip`. */
  async function refoldDailyTo(tip, n) {
    // Over-fetch a margin so the fetched range starts before 00:00 UTC of the
    // oldest day we intend to fully recompute.
    const from = Math.max(0, tip - n * BLOCKS_PER_DAY - BLOCKS_PER_DAY / 8);
    const headers = await fetchHeadersRange(from, tip);
    const cutoffDay = bucketDay(Math.floor(nowFn() / 1000) - (n - 1) * SECONDS_PER_DAY);
    const recent = headers.filter((h) => bucketDay(h.time) >= cutoffDay);
    const aggs = foldHeaders(recent);
    for (const agg of aggs) await upsertReplace(db, network, agg);
    return aggs.length;
  }

  /** REPLACE-recompute the last `hoursWin` UTC hours of the HOURLY table to `tip`. */
  async function refreshHourlyTo(tip, hoursWin) {
    const from = Math.max(0, tip - hoursWin * BLOCKS_PER_HOUR - BLOCKS_PER_HOUR);
    const headers = await fetchHeadersRange(from, tip);
    const cutoffHour = bucketHour(Math.floor(nowFn() / 1000) - (hoursWin - 1) * SECONDS_PER_HOUR);
    const recent = headers.filter((h) => bucketHour(h.time) >= cutoffHour);
    const aggs = foldHeadersHourly(recent);
    for (const agg of aggs) await upsertReplaceHourly(db, network, agg);
    return aggs.length;
  }

  /**
   * Fully recompute (REPLACE) the last `n` UTC days from headers and advance
   * last_height to the observed tip, so the incremental loop never re-adds the
   * blocks this replace already accounted for. Public method kept stable.
   */
  async function refoldRecentDays(n = 2) {
    try {
      const tip = await getTip();
      if (tip === null) return false;
      const rows = await refoldDailyTo(tip, n);
      await setLastHeight(tip);
      log(`[history:${network}] refold last ${n} days -> ${rows} rows (tip ${tip})`);
      return true;
    } catch (e) {
      log(`[history:${network}] refold error: ${e.message}`);
      return false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      incrementalOnce().catch((e) => log(`[history:${network}] interval error: ${e.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /**
   * Full startup sequence for one network. Non-throwing: any RPC failure is
   * swallowed inside the individual jobs so a dead node never crashes the
   * process or blocks the other network.
   *
   * Cursor discipline: the initial daily backfill and incrementalOnce are the
   * only jobs that advance `last_height` via the exactly-once ADD path. The
   * startup recompute then REPLACE-rebuilds BOTH recent windows (last 2 days,
   * last `hours` hours) to a SINGLE tip snapshot and sets the cursor to it, so
   * neither table can be left with a gap or a double-counted block.
   */
  async function run() {
    const meta = await getMeta();
    if (!meta || !meta.backfill_done) {
      await backfill(); // 90d daily REPLACE; sets cursor = tip, backfill_done = 1
    }
    await incrementalOnce(); // ADD any gap into daily + hourly, advance cursor
    // Recompute both recent windows to one fresh tip, then set the cursor to it.
    try {
      const tip = await getTip();
      if (tip !== null) {
        await refoldDailyTo(tip, 2);
        await refreshHourlyTo(tip, hours);
        await pruneHourly();
        await setLastHeight(tip);
        log(`[history:${network}] startup sync complete (tip ${tip})`);
      }
    } catch (e) {
      log(`[history:${network}] startup sync error: ${e.message}`);
    }
    start();
  }

  return {
    backfill,
    backfillHourly,
    incrementalOnce,
    refoldRecentDays,
    refreshHourlyTo,
    pruneHourly,
    fetchHeadersRange,
    getMeta,
    run,
    start,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Top-level init — wired from server.js after the HTTP server is listening
// ---------------------------------------------------------------------------

/**
 * Open history.db, create tables, and kick off the mainnet + testnet trackers.
 * Non-blocking: backfill runs in the background. Testnet is fully guarded so a
 * missing/offline testnet node stays silent and never affects mainnet.
 *
 * @returns {{ db, ready:Promise, getDaily, getHourly, stop }}
 */
function init({
  sendRpc,
  sendTestnetRpc,
  dbFile = 'history.db',
  days = DAILY_BACKFILL_DAYS,
  hours = HOURLY_BACKFILL_HOURS,
  log = () => {},
} = {}) {
  const db = new sqlite3.Database(dbFile);
  const ready = initHistoryTables(db);

  const mainnet = createHistoryTracker({ db, network: 'mainnet', sendRpc, days, hours, log });
  const testnet = createHistoryTracker({ db, network: 'testnet', sendRpc: sendTestnetRpc, days, hours, log: () => {} });

  ready
    .then(() => {
      mainnet.run().catch((e) => log(`[history:mainnet] run failed: ${e.message}`));
      // Testnet node may be offline in some deployments — stay silent, non-fatal.
      testnet.run().catch(() => {});
    })
    .catch((e) => log(`[history] table init failed: ${e.message}`));

  return {
    db,
    ready,
    trackers: { mainnet, testnet },
    getDaily: (network, d) => queryDaily(db, network, d),
    getHourly: (network, h) => queryHourly(db, network, h),
    stop: () => {
      mainnet.stop();
      testnet.stop();
    },
  };
}

/** Clamp a value into [min, max] with a default; the shared basis for the query clamps. */
function clampInt(value, def, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Clamp a ?days= query value into [1, 90], defaulting to 30. */
function clampDays(value, def = 30, min = 1, max = 90) {
  return clampInt(value, def, min, max);
}

/** Clamp a ?hours= query value into [1, 48], defaulting to 24. */
function clampHours(value, def = 24, min = 1, max = 48) {
  return clampInt(value, def, min, max);
}

module.exports = {
  BLOCKS_PER_DAY,
  BLOCKS_PER_HOUR,
  DAILY_BACKFILL_DAYS,
  HOURLY_BACKFILL_HOURS,
  HOURLY_RETENTION_DAYS,
  bucketDay,
  bucketHour,
  initHistoryTables,
  foldHeadersBy,
  foldHeaders,
  foldHeadersHourly,
  buildDailyResponse,
  buildHourlyResponse,
  queryDaily,
  queryHourly,
  mapWithConcurrency,
  upsertReplace,
  upsertAccumulate,
  upsertReplaceHourly,
  upsertAccumulateHourly,
  createHistoryTracker,
  sortAlgos,
  clampDays,
  clampHours,
  init,
};
