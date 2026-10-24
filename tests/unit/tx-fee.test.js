// TDD: FIRST-TIMER-1. The /txs page showed made-up fees (vsize x 50 sat/vB)
// for confirmed transactions, and 0 for mempool transactions. DigiByte Core
// v9 (Bitcoin Core 26 base) gives the real fee in DGB:
//   - getblock <hash> 2      -> tx.fee        (non-coinbase txs)
//   - getrawmempool true     -> entry.fees.base (top-level `fee` is gone)
//   - getmempoolentry <txid> -> entry.fees.base
// These helpers read the real fee and never invent a number.
import { describe, it, expect } from 'vitest';
import {
  blockTxFee,
  mempoolEntryFee,
  feeRateSatPerVb,
  feePriority,
  feeFields,
  addToFeeDistribution,
  emptyFeeDistribution,
  averageKnownFee,
} from '../../txfee.js';

// Real tx 42f6ca23... from mainnet block 24,443,018 (DigiExplorer: fee
// 2,000,000 sats, size 426, weight 1704). Shape as `getblock <hash> 2` returns it.
const REAL_BLOCK_TX = {
  txid: '42f6ca23192a4ebbc1572364769111ef85193ab9889f769599db0329b749245a',
  hash: '42f6ca23192a4ebbc1572364769111ef85193ab9889f769599db0329b749245a',
  version: 1,
  size: 426,
  vsize: 426,
  weight: 1704,
  locktime: 0,
  vin: [
    { txid: '572ff9d4dc4bcb340b59ab088e3b7694d02c6ed7775168df338302ebf5228eca', vout: 3, sequence: 4294967295 },
    { txid: '572ff9d4dc4bcb340b59ab088e3b7694d02c6ed7775168df338302ebf5228eca', vout: 2, sequence: 4294967295 },
  ],
  vout: [
    { value: 0.001, n: 0, scriptPubKey: { address: 'DEVdL6GVFSYSsJXKCvGVHT9fwASNv2YRzM', type: 'pubkeyhash' } },
    { value: 0, n: 1, scriptPubKey: { type: 'nulldata' } },
    { value: 99.769, n: 2, scriptPubKey: { address: 'DRGNhTiYdetetvRo3qnUFpo3PYUrVYPHZP', type: 'pubkeyhash' } },
    { value: 0.001, n: 3, scriptPubKey: { address: 'DRGNhTiYdetetvRo3qnUFpo3PYUrVYPHZP', type: 'pubkeyhash' } },
  ],
  fee: 0.02,
};

// `getrawmempool true` entry shape on Bitcoin Core 26: no top-level `fee`.
const V26_MEMPOOL_ENTRY = {
  vsize: 226, weight: 904, time: 1792880000, height: 24443018,
  descendantcount: 1, descendantsize: 226, ancestorcount: 1, ancestorsize: 226,
  wtxid: 'ab'.repeat(32),
  fees: { base: 0.0226, modified: 0.0226, ancestor: 0.0226, descendant: 0.0226 },
  depends: [], spentby: [], 'bip125-replaceable': false, unbroadcast: false,
};

describe('blockTxFee (getblock verbosity 2)', () => {
  it('returns the real fee in DGB from a real block tx', () => {
    expect(blockTxFee(REAL_BLOCK_TX)).toBe(0.02);
  });

  it('does not return the old made-up 50 sat/vB estimate', () => {
    expect(blockTxFee(REAL_BLOCK_TX)).not.toBeCloseTo(426 * 0.0000005, 8);
  });

  it('returns null when the node gave no fee (e.g. no undo data)', () => {
    const { fee, ...noFee } = REAL_BLOCK_TX;
    expect(blockTxFee(noFee)).toBeNull();
  });
});

describe('mempoolEntryFee (getrawmempool true / getmempoolentry)', () => {
  it('reads fees.base on a v26 entry', () => {
    expect(mempoolEntryFee(V26_MEMPOOL_ENTRY)).toBe(0.0226);
  });

  it('falls back to the old top-level fee field', () => {
    expect(mempoolEntryFee({ vsize: 200, fee: 0.01 })).toBe(0.01);
  });

  it('prefers fees.base over the old field', () => {
    expect(mempoolEntryFee({ fee: 0.5, fees: { base: 0.01 } })).toBe(0.01);
  });

  it('returns null when no fee is present', () => {
    expect(mempoolEntryFee({ vsize: 200 })).toBeNull();
  });
});

describe('feeRateSatPerVb', () => {
  it('matches DigiExplorer for the real tx (2,000,000 sats / 426 vB)', () => {
    expect(feeRateSatPerVb(0.02, 426)).toBe(4695);
  });

  it('returns null for unknown fee or bad size', () => {
    expect(feeRateSatPerVb(null, 426)).toBeNull();
    expect(feeRateSatPerVb(0.02, 0)).toBeNull();
    expect(feeRateSatPerVb(0.02, undefined)).toBeNull();
  });
});

describe('feePriority', () => {
  it('keeps the existing thresholds (sat/vB)', () => {
    // DigiByte scale (network minimum ~100 sat/vB; wallets pay ~4,700-10,000)
    expect(feePriority(10051)).toBe('high');
    expect(feePriority(10000)).toBe('high');
    expect(feePriority(4695)).toBe('medium');
    expect(feePriority(1000)).toBe('medium');
    expect(feePriority(999)).toBe('low');
    expect(feePriority(100)).toBe('low');
    expect(feePriority(0)).toBe('low');
  });

  it('says unknown, not low, when the fee is unknown', () => {
    expect(feePriority(null)).toBe('unknown');
  });
});

describe('feeFields', () => {
  it('builds the payload fields from the real fee', () => {
    expect(feeFields(blockTxFee(REAL_BLOCK_TX), 426)).toEqual({
      fee: 0.02, fee_rate: 4695, priority: 'medium',
    });
  });

  it('gives null fee and fee_rate when the fee is unknown', () => {
    expect(feeFields(null, 426)).toEqual({ fee: null, fee_rate: null, priority: 'unknown' });
  });
});

describe('addToFeeDistribution', () => {
  const empty = () => emptyFeeDistribution();

  it('starts with DigiByte-scale buckets', () => {
    expect(emptyFeeDistribution()).toEqual({ '0-1000': 0, '1000-5000': 0, '5000-10000': 0, '10000-50000': 0, '50000+': 0 });
  });

  it('counts known rates in the right bucket', () => {
    const d = empty();
    [100, 4695, 9999, 10051, 60000].forEach((r) => addToFeeDistribution(d, r));
    expect(d).toEqual({ '0-1000': 1, '1000-5000': 1, '5000-10000': 1, '10000-50000': 1, '50000+': 1 });
  });

  it('does not count unknown rates as 0-10', () => {
    const d = empty();
    addToFeeDistribution(d, null);
    expect(d).toEqual(empty());
  });
});

describe('averageKnownFee', () => {
  it('averages only known fees', () => {
    expect(averageKnownFee([{ fee: 0.02 }, { fee: null }, { fee: 0.04 }])).toBeCloseTo(0.03, 10);
  });

  it('returns 0 when no fee is known', () => {
    expect(averageKnownFee([])).toBe(0);
    expect(averageKnownFee([{ fee: null }])).toBe(0);
  });
});

// Fuzz: random, missing and garbage fee fields never throw and never put NaN,
// Infinity or a negative number into the payload.
describe('fuzz: garbage fee fields', () => {
  // Small seeded PRNG so failures are reproducible.
  let seed = 0xdeadbeef;
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const GARBAGE = [
    undefined, null, NaN, Infinity, -Infinity, -0.01, -1, 0, 1e-12, 1e30,
    '0.02', '', 'abc', true, false, {}, [], [0.02], { base: 0.02 }, () => 1,
    Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE,
  ];
  const pick = () => (rand() < 0.5 ? GARBAGE[Math.floor(rand() * GARBAGE.length)] : (rand() - 0.3) * 10 ** Math.floor(rand() * 12 - 6));

  const isSafe = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

  it('never throws and never yields NaN or negative fees (2,000 cases)', () => {
    for (let i = 0; i < 2000; i++) {
      const tx = rand() < 0.1 ? pick() : { fee: pick(), vsize: pick(), size: pick() };
      const entry = rand() < 0.1 ? pick() : { fee: pick(), fees: rand() < 0.2 ? pick() : { base: pick() }, vsize: pick() };
      const vsize = pick();

      for (const fee of [blockTxFee(tx), mempoolEntryFee(entry)]) {
        expect(isSafe(fee)).toBe(true);
        const f = feeFields(fee, vsize);
        expect(isSafe(f.fee)).toBe(true);
        expect(isSafe(f.fee_rate)).toBe(true);
        expect(['high', 'medium', 'low', 'unknown']).toContain(f.priority);
        const d = emptyFeeDistribution();
        addToFeeDistribution(d, f.fee_rate);
        Object.values(d).forEach((n) => expect(Number.isInteger(n) && n >= 0).toBe(true));
      }
    }
  });

  it('averageKnownFee stays finite and non-negative on garbage lists', () => {
    for (let i = 0; i < 200; i++) {
      const list = Array.from({ length: Math.floor(rand() * 6) }, () => ({ fee: pick() }));
      const avg = averageKnownFee(list);
      expect(Number.isFinite(avg) && avg >= 0).toBe(true);
    }
  });
});
