// TDD: per-block DigiDollar oracle-bundle detection — consensus-strict.
//
// Per DIGIDOLLAR_ORACLE_ARCHITECTURE.md (V1 invariants) and
// DIGIDOLLAR_MINING_INTEGRATION_GUIDE.md:
// - The bundle is a zero-value COINBASE output (block.tx[0]) — it is NOT a
//   block-header field; the header commits to it only via the merkle root.
//   Script: OP_RETURN(0x6a) OP_ORACLE(0xbf) <push 0x03> <push v03 payload>
// - V1 accepts ONLY v0x03 (MuSig2). Raw v0x01/v0x02 payloads are rejected by
//   consensus (bad-oracle-malformed) and must NOT count as bundles.
// - v03 payload layout: bitmap_len(1) | participation_bitmap(bitmap_len) |
//   epoch(4 LE) | price_micro_usd(8 LE u64) | timestamp(8 LE i64) |
//   aggregate_sig(64) — exact length 85 + bitmap_len (86 min; 90 on the
//   35-slot mainnet/testnet roster).
// - Consensus price range: 100..100,000,000 micro-USD ($0.0001..$100).
// - Pre-activation blocks were never oracle-validated, so a stray 6abf marker
//   is NOT proof of a bundle — only a structurally valid v0x03 payload counts.
import { describe, it, expect } from 'vitest';
import { detectOracleBundle } from '../../rpc.js';

const NONE = { hasOracleBundle: false, oracleSignerCount: null, oraclePriceUsd: null, oracleEpoch: null };

/** Minimal-encoding script data push, as CScript::operator<< emits. */
function pushData(buf) {
  if (buf.length <= 0x4b) return Buffer.concat([Buffer.from([buf.length]), buf]);
  return Buffer.concat([Buffer.from([0x4c, buf.length]), buf]); // OP_PUSHDATA1
}

/** Build a v03 oracle script hex; overridable for negative tests. */
function oracleScriptHex({
  version = 0x03,
  bitmap = [0x7f, 0x00, 0x00, 0x00, 0x00],
  priceMicroUsd = 9130n,
  epoch = 123,
  timestamp = 1789000000n,
  truncateBytes = 0,
} = {}) {
  let payload = Buffer.alloc(1 + bitmap.length + 4 + 8 + 8 + 64);
  let o = 0;
  payload.writeUInt8(bitmap.length, o); o += 1;
  Buffer.from(bitmap).copy(payload, o); o += bitmap.length;
  payload.writeInt32LE(epoch, o); o += 4;
  payload.writeBigUInt64LE(priceMicroUsd, o); o += 8;
  payload.writeBigInt64LE(timestamp, o); o += 8;
  // remaining 64 bytes: zeroed aggregate signature
  if (truncateBytes > 0) payload = payload.subarray(0, payload.length - truncateBytes);
  return Buffer.concat([
    Buffer.from([0x6a, 0xbf]),          // OP_RETURN OP_ORACLE
    pushData(Buffer.from([version])),   // version push (01 03 for v3)
    pushData(payload),                  // payload push (OP_PUSHDATA1 in practice)
  ]).toString('hex');
}

/** Legacy v0x01 22-byte compact script (historical; consensus-rejected in V1). */
function legacyV1ScriptHex() {
  const data = Buffer.alloc(17); // oracle_id(1) + price(8) + timestamp(8)
  data.writeUInt8(0, 0);
  data.writeBigUInt64LE(6500n, 1);
  data.writeBigInt64LE(1789000000n, 9);
  return Buffer.concat([
    Buffer.from([0x6a, 0xbf]),
    pushData(Buffer.from([0x01])),
    pushData(data),
  ]).toString('hex');
}

const vout = (hex) => ({ value: 0, scriptPubKey: { hex, asm: '', type: 'nulldata' } });
const rewardVout = { value: 312.5, scriptPubKey: { hex: '76a914aa99', address: 'DAddr1', type: 'pubkeyhash' } };
const blockWith = (coinbaseVouts, extraTxs = []) => ({
  height: 23800000,
  hash: 'abc123',
  tx: [{ txid: 'cb', vin: [{ coinbase: 'ff' }], vout: coinbaseVouts }, ...extraTxs],
});

describe('detectOracleBundle', () => {
  it('detects a valid v0x03 bundle and decodes signers, price, and epoch', () => {
    const block = blockWith([rewardVout, vout(oracleScriptHex())]);
    expect(detectOracleBundle(block)).toEqual({
      hasOracleBundle: true,
      oracleSignerCount: 7,        // popcount(0x7f) — the 7-signature quorum
      oraclePriceUsd: 0.00913,     // 9130 micro-USD
      oracleEpoch: 123,
    });
  });

  it('decodes a larger signer set and different price (90-byte mainnet payload)', () => {
    const block = blockWith([rewardVout, vout(oracleScriptHex({ bitmap: [0xff, 0xff, 0x07, 0x00, 0x00], priceMicroUsd: 10500n, epoch: 594917 }))]);
    expect(detectOracleBundle(block)).toEqual({
      hasOracleBundle: true,
      oracleSignerCount: 19,
      oraclePriceUsd: 0.0105,
      oracleEpoch: 594917,
    });
  });

  it('accepts the 86-byte minimum payload (bitmap_len = 1)', () => {
    const block = blockWith([rewardVout, vout(oracleScriptHex({ bitmap: [0x7f] }))]);
    expect(detectOracleBundle(block)).toEqual({
      hasOracleBundle: true,
      oracleSignerCount: 7,
      oraclePriceUsd: 0.00913,
      oracleEpoch: 123,
    });
  });

  it('reports no bundle for an ordinary coinbase', () => {
    const block = blockWith([rewardVout, vout('6a24aa21a9ed' + '00'.repeat(32))]); // witness commitment
    expect(detectOracleBundle(block)).toEqual(NONE);
  });

  it('rejects legacy v0x01 compact payloads (consensus bad-oracle-malformed)', () => {
    const block = blockWith([rewardVout, vout(legacyV1ScriptHex())]);
    expect(detectOracleBundle(block)).toEqual(NONE);
  });

  it('rejects v0x02 payloads', () => {
    const block = blockWith([rewardVout, vout(oracleScriptHex({ version: 0x02 }))]);
    expect(detectOracleBundle(block)).toEqual(NONE);
  });

  it('rejects a bare marker with no valid payload (pre-activation garbage)', () => {
    const block = blockWith([rewardVout, vout('6abf0103')]);
    expect(detectOracleBundle(block)).toEqual(NONE);
  });

  it('rejects a truncated v0x03 payload (length must be exactly 85 + bitmap_len)', () => {
    const block = blockWith([rewardVout, vout(oracleScriptHex({ truncateBytes: 4 }))]);
    expect(detectOracleBundle(block)).toEqual(NONE);
  });

  it('rejects out-of-range prices (consensus bounds 100..100,000,000 micro-USD)', () => {
    const low = blockWith([rewardVout, vout(oracleScriptHex({ priceMicroUsd: 99n }))]);
    const high = blockWith([rewardVout, vout(oracleScriptHex({ priceMicroUsd: 100000001n }))]);
    expect(detectOracleBundle(low)).toEqual(NONE);
    expect(detectOracleBundle(high)).toEqual(NONE);
  });

  it('ignores oracle-looking outputs on non-coinbase transactions', () => {
    const block = blockWith([rewardVout], [{ txid: 'other', vout: [vout(oracleScriptHex())] }]);
    expect(detectOracleBundle(block)).toEqual(NONE);
  });

  it('handles missing/empty block shapes without throwing', () => {
    expect(detectOracleBundle(null)).toEqual(NONE);
    expect(detectOracleBundle({})).toEqual(NONE);
    expect(detectOracleBundle({ tx: [] })).toEqual(NONE);
    expect(detectOracleBundle({ tx: [{ vout: null }] })).toEqual(NONE);
  });
});
