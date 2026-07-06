/**
 * DigiByte chain-tip / orphan / fork tracker
 *
 * Polls `getchaintips`, classifies competing tips near the current tip,
 * detects reorgs and newly-orphaned (stale) blocks between polls, grades a
 * fork-risk level, and persists an orphan history for the stats site.
 *
 * DigiByte mines a block every ~15s across 5 algorithms, so single-block stale
 * tips (branchlen 1) are a NORMAL, constant background rate — not a fork. Risk
 * only rises when a competing branch is deep (>=2), grows across successive
 * polls (actively mined), is `invalid`, or the active tip is actually replaced
 * (a reorg). Fork-risk hysteresis (hold-down) lives in createForkTracker so a
 * momentary spike does not flap the site-wide banner.
 *
 * Coexists with all existing features: this module only adds a new table
 * (orphan_blocks) and reads getchaintips; it never touches recentBlocks, the
 * peer/crawler pipeline, or existing WS message types.
 */

const RISK_ORDER = { none: 0, elevated: 1, critical: 2 };

// ---------------------------------------------------------------------------
// Pure classification / risk logic
// ---------------------------------------------------------------------------

function tipsByHash(tips) {
  const idx = {};
  for (const t of tips || []) idx[t.hash] = t;
  return idx;
}

/**
 * Turn a raw getchaintips array into a classified snapshot fragment.
 * Keeps only non-active tips within `windowBlocks` of the active height
 * (a mature node lists every historical fork; ancient ones are noise).
 */
function classifyTips(rawTips, { windowBlocks = 100, maxTips = 40 } = {}) {
  const tips = Array.isArray(rawTips) ? rawTips : [];
  const activeTip = tips.find((t) => t.status === 'active') || null;
  const active = activeTip ? { height: activeTip.height, hash: activeTip.hash } : null;
  const activeHeight = activeTip ? activeTip.height : (tips[0] ? tips[0].height : 0);

  const recent = tips
    .filter((t) => t.status !== 'active')
    .filter((t) => t.height >= activeHeight - windowBlocks)
    .map((t) => ({
      hash: t.hash,
      height: t.height,
      branchlen: t.branchlen,
      status: t.status,
      forkHeight: t.height - t.branchlen,
    }))
    .sort((a, b) => b.height - a.height);

  const capped = recent.slice(0, maxTips);
  const counts = { validFork: 0, validHeaders: 0, headersOnly: 0, invalid: 0 };
  let maxBranchLen = 0;
  for (const t of recent) {
    if (t.status === 'valid-fork') counts.validFork += 1;
    else if (t.status === 'valid-headers') counts.validHeaders += 1;
    else if (t.status === 'headers-only') counts.headersOnly += 1;
    else if (t.status === 'invalid') counts.invalid += 1;
    if (t.branchlen > maxBranchLen) maxBranchLen = t.branchlen;
  }

  return { active, activeHeight, tips: capped, counts, totalTips: recent.length, maxBranchLen };
}

/**
 * Grade fork risk from the classified tips + previous poll's tip index.
 * Pure: returns the RAW assessment; hysteresis is applied by the caller.
 */
function computeForkRisk({ tips = [], prevByHash = {}, activeHeight = 0, reorgDepth = 0, crowdThreshold = 3 }) {
  let deepest = 0;
  let deepestTip = null;
  let invalidDeep = null;
  let grew = null;
  let crowd = 0;

  for (const t of tips) {
    if (t.branchlen > deepest) { deepest = t.branchlen; deepestTip = t; }
    if (t.status === 'invalid' && t.branchlen >= 2 && !invalidDeep) invalidDeep = t;
    const prev = prevByHash[t.hash];
    if (prev && t.branchlen > prev.branchlen && !grew) grew = t;
    if (t.height >= activeHeight - 1) crowd += 1; // tips at/just below the tip height
  }

  const at = (tip, extra) => ({
    height: tip ? tip.height : activeHeight,
    branchlen: tip ? tip.branchlen : reorgDepth,
    ...extra,
  });

  // critical
  if (invalidDeep) {
    return { level: 'critical', reason: `Invalid competing branch ${invalidDeep.branchlen} blocks deep at height ${invalidDeep.height}`, ...at(invalidDeep) };
  }
  if (reorgDepth >= 3) {
    return { level: 'critical', reason: `Chain reorganization ${reorgDepth} blocks deep`, height: activeHeight, branchlen: reorgDepth };
  }
  if (deepest >= 4) {
    return { level: 'critical', reason: `Competing branch ${deepest} blocks deep at height ${deepestTip.height}`, ...at(deepestTip) };
  }
  if (grew && grew.branchlen >= 3) {
    return { level: 'critical', reason: `A competing branch is being actively extended (now ${grew.branchlen} blocks)`, ...at(grew) };
  }

  // elevated — a detected reorg is the headline; then growth, then static depth
  if (reorgDepth === 2) {
    return { level: 'elevated', reason: 'Chain reorganization 2 blocks deep', height: activeHeight, branchlen: 2 };
  }
  if (grew) {
    return { level: 'elevated', reason: `A competing branch is growing (now ${grew.branchlen} blocks)`, ...at(grew) };
  }
  if (deepest >= 2) {
    return { level: 'elevated', reason: `Competing branch ${deepest} blocks deep at height ${deepestTip.height}`, ...at(deepestTip) };
  }
  if (crowd >= crowdThreshold) {
    return { level: 'elevated', reason: `${crowd} competing tips clustered at the current height`, height: activeHeight, branchlen: 1 };
  }

  return { level: 'none', reason: 'No competing chain — single-block stale tips are normal', height: activeHeight, branchlen: deepest };
}

/**
 * Compare two classified snapshots to detect a reorg (active tip replaced).
 * getchaintips carries no parent links, so a reorg is inferred when the prior
 * active hash is gone from the tip OR reappears as a side branch, and the new
 * active height did not simply advance by one from a different hash.
 */
function diffReorg(prev, next) {
  const empty = { reorg: false, depth: 0, orphanedHashes: [] };
  if (!prev || !prev.active || !next || !next.active) return empty;
  if (prev.active.hash === next.active.hash) return empty;

  const prevHash = prev.active.hash;
  const prevHeight = prev.active.height;
  const demoted = (next.tips || []).find((t) => t.hash === prevHash);

  // Old active tip demoted to a side branch => reorg.
  if (demoted) {
    const depth = Math.max(demoted.branchlen || 1, prevHeight - next.active.height + 1, 1);
    return { reorg: true, depth, orphanedHashes: [prevHash] };
  }
  // New active height regressed (or stayed) with a different hash => reorg.
  if (next.active.height <= prevHeight) {
    const depth = Math.max(prevHeight - next.active.height + 1, 1);
    return { reorg: true, depth, orphanedHashes: [prevHash] };
  }
  // Different hash but height advanced by one — normal extension (we simply
  // didn't have the exact parent; not treated as a reorg).
  return empty;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const run = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function onDone(err) { err ? reject(err) : resolve(this); }));
const all = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

function initializeForkTables(db) {
  return run(
    db,
    `CREATE TABLE IF NOT EXISTS orphan_blocks (
      network TEXT NOT NULL DEFAULT 'mainnet',
      hash TEXT NOT NULL,
      height INTEGER,
      branchlen INTEGER,
      status TEXT,
      algo TEXT,
      pool TEXT,
      version INTEGER,
      first_seen INTEGER,
      last_seen INTEGER,
      PRIMARY KEY (network, hash)
    )`
  ).then(() => run(db, 'CREATE INDEX IF NOT EXISTS idx_orphan_blocks_seen ON orphan_blocks(network, first_seen)'));
}

function recordOrphan(db, { network, hash, height, branchlen, status, algo = null, pool = null, version = null, now }) {
  return run(
    db,
    `INSERT INTO orphan_blocks (network, hash, height, branchlen, status, algo, pool, version, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(network, hash) DO UPDATE SET
       branchlen = excluded.branchlen,
       status = excluded.status,
       algo = COALESCE(excluded.algo, orphan_blocks.algo),
       pool = COALESCE(excluded.pool, orphan_blocks.pool),
       version = COALESCE(excluded.version, orphan_blocks.version),
       last_seen = excluded.last_seen`,
    [network, hash, height, branchlen, status, algo, pool, version, now, now]
  );
}

function getRecentOrphans(db, network, sinceMs) {
  return all(
    db,
    'SELECT * FROM orphan_blocks WHERE network = ? AND first_seen >= ? ORDER BY first_seen DESC',
    [network, sinceMs]
  );
}

/**
 * Per-day orphan counts (UTC), derived from orphan_blocks so it is idempotent
 * (distinct by hash) and survives server restarts — this is the long-term
 * "orphans per day" history that feeds the daily-averages chart.
 */
function getDailyOrphanStats(db, network, sinceMs) {
  return all(
    db,
    `SELECT date(first_seen / 1000, 'unixepoch') AS day,
            COUNT(*) AS count,
            MAX(branchlen) AS max_branchlen
     FROM orphan_blocks
     WHERE network = ? AND first_seen >= ?
     GROUP BY day
     ORDER BY day ASC`,
    [network, sinceMs]
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function createForkTracker({
  db,
  network = 'mainnet',
  sendRpc,
  getBlockMeta = () => null,
  getRecentBlocks = () => [],
  onSnapshot = null,
  onAlert = null,
  log = () => {},
  options = {},
}) {
  const opts = {
    windowBlocks: 240, // match the recentBlocks spine so the fork-tree map can attach branches
    maxTips: 60,
    orphanWindowMs: 24 * 3600 * 1000,
    dailyWindowDays: 30,
    riskHoldMs: 3 * 60 * 1000, // hold an elevated/critical level for at least 3 min (anti-flap)
    ...options,
  };
  let lastClassified = null;
  let lastSnapshot = null;
  let lastAlert = { network, level: 'none', reason: 'No competing chain', height: 0, branchlen: 0, updatedAt: 0 };
  let heldLevelSince = 0;
  let polling = false;
  let timer = null;

  const now = () => (options.nowFn ? options.nowFn() : lastSnapshot ? lastSnapshot.updatedAt + 1 : 1751700000000);

  async function pollOnce() {
    if (polling) return lastSnapshot;
    polling = true;
    try {
      const raw = await sendRpc('getchaintips', [], true);
      if (!raw || !Array.isArray(raw) || raw.length === 0) {
        return lastSnapshot; // keep last-good on RPC failure
      }
      const ts = now();
      const classified = classifyTips(raw, { windowBlocks: opts.windowBlocks, maxTips: opts.maxTips });
      const prevByHash = lastClassified ? tipsByHash(lastClassified.tips) : {};

      // Reorg detection vs previous poll
      const reorg = diffReorg(lastClassified, classified);

      // Record newly-appeared stale tips as orphans (enriched from block meta / recentBlocks)
      const recentBlocks = getRecentBlocks() || [];
      const metaFor = (hash) => {
        const b = recentBlocks.find((x) => x.hash === hash);
        if (b) return { algo: b.algo || null, pool: b.poolIdentifier || b.pool || null, version: b.version || null };
        return getBlockMeta(hash) || {};
      };
      for (const t of classified.tips) {
        if (!prevByHash[t.hash]) {
          const meta = metaFor(t.hash);
          await recordOrphan(db, { network, hash: t.hash, height: t.height, branchlen: t.branchlen, status: t.status, ...meta, now: ts })
            .catch((e) => log(`recordOrphan failed: ${e.message}`));
        }
      }
      // Record the orphaned active tip(s) from a reorg
      for (const h of reorg.orphanedHashes) {
        const meta = metaFor(h);
        await recordOrphan(db, { network, hash: h, height: lastClassified?.active?.height, branchlen: reorg.depth, status: 'reorged', ...meta, now: ts })
          .catch((e) => log(`recordOrphan(reorg) failed: ${e.message}`));
      }

      // Risk (raw) + hysteresis hold-down
      const raw_risk = computeForkRisk({
        tips: classified.tips,
        prevByHash,
        activeHeight: classified.activeHeight,
        reorgDepth: reorg.reorg ? reorg.depth : 0,
      });
      let effectiveLevel = raw_risk.level;
      let effectiveReason = raw_risk.reason;
      if (RISK_ORDER[raw_risk.level] >= RISK_ORDER[lastAlert.level]) {
        heldLevelSince = ts; // rising or same: refresh hold timer
      } else if (ts - heldLevelSince < opts.riskHoldMs) {
        effectiveLevel = lastAlert.level; // still within hold window: keep prior level
        effectiveReason = lastAlert.reason;
      }

      const orphans = await getRecentOrphans(db, network, ts - opts.orphanWindowMs).catch(() => []);
      const dailyRows = await getDailyOrphanStats(db, network, ts - opts.dailyWindowDays * 24 * 3600 * 1000).catch(() => []);
      const dailyOrphans = dailyRows.map((r) => ({ day: r.day, count: r.count, maxBranchlen: r.max_branchlen }));
      const dailyTotal = dailyOrphans.reduce((sum, d) => sum + d.count, 0);
      const avgPerDay = Math.round((dailyTotal / opts.dailyWindowDays) * 100) / 100;
      const snapshot = {
        network,
        updatedAt: ts,
        active: classified.active,
        counts: classified.counts,
        totalTips: classified.totalTips,
        maxBranchLen: classified.maxBranchLen,
        tips: classified.tips,
        orphans24h: orphans.length,
        orphans: orphans.slice(0, 50).map((o) => ({
          hash: o.hash, height: o.height, branchlen: o.branchlen,
          status: o.status, algo: o.algo, pool: o.pool, firstSeen: o.first_seen,
        })),
        dailyOrphans,
        avgPerDay,
        riskLevel: effectiveLevel,
      };

      lastClassified = classified;
      lastSnapshot = snapshot;
      if (onSnapshot) onSnapshot(snapshot);

      // Fire an alert only when the effective level changes
      if (effectiveLevel !== lastAlert.level) {
        lastAlert = {
          network,
          level: effectiveLevel,
          reason: effectiveLevel === 'none' ? 'Network healthy — no competing chain' : effectiveReason,
          height: raw_risk.height,
          branchlen: raw_risk.branchlen,
          updatedAt: ts,
        };
        if (onAlert) onAlert(lastAlert);
      }

      return snapshot;
    } finally {
      polling = false;
    }
  }

  return {
    pollOnce,
    getSnapshot: () => lastSnapshot,
    getAlert: () => lastAlert,
    _setLastSnapshot: (s) => { lastSnapshot = s; },
    start(intervalMs = 20000) {
      if (timer) return;
      pollOnce().catch((e) => log(`fork poll failed: ${e.message}`));
      timer = setInterval(() => { pollOnce().catch((e) => log(`fork poll failed: ${e.message}`)); }, intervalMs);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = {
  tipsByHash,
  classifyTips,
  computeForkRisk,
  diffReorg,
  initializeForkTables,
  recordOrphan,
  getRecentOrphans,
  getDailyOrphanStats,
  createForkTracker,
};
