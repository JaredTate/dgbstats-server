/**
 * Transaction fee helpers.
 *
 * Read the REAL fee that DigiByte Core reports. Never estimate one.
 * DigiByte Core v9 (Bitcoin Core 26 base) gives fees in DGB:
 *   - getblock <hash> 2      -> tx.fee          (each non-coinbase tx)
 *   - getrawmempool true     -> entry.fees.base (top-level `fee` was removed)
 *   - getmempoolentry <txid> -> entry.fees.base
 * When no valid fee is present the result is null ("unknown").
 */

const SATS_PER_DGB = 100000000;
// No real fee can exceed the 21 billion DGB maximum supply.
const MAX_FEE_DGB = 21000000000;

/** Return a valid fee in DGB, or null for missing/garbage values. */
function cleanFee(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_FEE_DGB) return null;
  return value;
}

/** Fee in DGB of a tx from `getblock <hash> 2`, or null. */
function blockTxFee(tx) {
  return cleanFee(tx?.fee);
}

/** Fee in DGB of a `getrawmempool true` / `getmempoolentry` entry, or null. */
function mempoolEntryFee(entry) {
  const base = cleanFee(entry?.fees?.base);
  return base !== null ? base : cleanFee(entry?.fee);
}

/** Fee rate in sat/vB (rounded), or null if fee or size is unknown. */
function feeRateSatPerVb(feeDgb, vsize) {
  const fee = cleanFee(feeDgb);
  if (fee === null) return null;
  if (typeof vsize !== 'number' || !Number.isFinite(vsize) || vsize <= 0) return null;
  const rate = Math.round((fee * SATS_PER_DGB) / vsize);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Priority label from a fee rate in sat/vB, on the DigiByte scale: the network
 * minimum is ~100 sat/vB (0.001 DGB/kB) and wallets pay ~4,700-10,000 sat/vB.
 * (The old 50/100 thresholds came from Bitcoin and marked every DGB tx 'high'.)
 */
function feePriority(feeRate) {
  if (feeRate === null || feeRate === undefined) return 'unknown';
  if (feeRate >= 10000) return 'high';
  if (feeRate >= 1000) return 'medium';
  return 'low';
}

/** The fee fields of a tx payload: { fee (DGB|null), fee_rate (sat/vB|null), priority }. */
function feeFields(feeDgb, vsize) {
  const fee = cleanFee(feeDgb);
  const feeRate = feeRateSatPerVb(fee, vsize);
  return { fee, fee_rate: feeRate, priority: feePriority(feeRate) };
}

/** Empty mempool fee distribution (sat/vB buckets, DigiByte scale). */
function emptyFeeDistribution() {
  return { '0-1000': 0, '1000-5000': 0, '5000-10000': 0, '10000-50000': 0, '50000+': 0 };
}

/** Count a fee rate in the mempool fee distribution. Unknown rates are skipped. */
function addToFeeDistribution(distribution, feeRate) {
  if (feeRate === null || feeRate === undefined) return;
  if (feeRate < 1000) distribution['0-1000']++;
  else if (feeRate < 5000) distribution['1000-5000']++;
  else if (feeRate < 10000) distribution['5000-10000']++;
  else if (feeRate < 50000) distribution['10000-50000']++;
  else distribution['50000+']++;
}

/** Average fee in DGB over txs with a known fee; 0 when none is known. */
function averageKnownFee(transactions) {
  const known = (transactions || []).map((tx) => cleanFee(tx?.fee)).filter((f) => f !== null);
  if (known.length === 0) return 0;
  return known.reduce((sum, f) => sum + f, 0) / known.length;
}

module.exports = {
  cleanFee,
  blockTxFee,
  mempoolEntryFee,
  feeRateSatPerVb,
  feePriority,
  feeFields,
  addToFeeDistribution,
  emptyFeeDistribution,
  averageKnownFee,
};
