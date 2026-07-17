#!/usr/bin/env node
/**
 * Cross-validate dgbstats-server's detectOracleBundle() against DigiByte
 * Core's own getoraclesigners RPC on live chain data.
 *
 * For every bundle the node reports in the last N blocks (authoritative,
 * consensus-validated), fetch the raw block (getblock verbosity 2), run our
 * coinbase parser, and require an exact match on signer_count, price_usd,
 * and epoch. Also sweeps the same window for false positives: blocks our
 * parser flags that the node does NOT list.
 *
 * Usage: node scripts/validate-oracle-parse.js [blocks=200]
 * Requires DGB_RPC_URL / DGB_RPC_USER / DGB_RPC_PASSWORD env (cookie auth ok).
 */
const { sendRpcRequest, detectOracleBundle } = require('../rpc.js');

async function main() {
  const scan = parseInt(process.argv[2] || '200', 10);
  const signers = await sendRpcRequest('getoraclesigners', [scan]);
  if (!signers) throw new Error('getoraclesigners returned nothing');

  console.log(`chain_height=${signers.chain_height} scan_blocks=${signers.scan_blocks} bundle_count=${signers.bundle_count}`);
  const authoritative = new Map((signers.bundles || []).map(b => [b.blockhash, b]));

  let ok = 0, mismatched = 0, checked = 0;

  // 1. Every node-reported bundle must decode identically in our parser.
  for (const [blockhash, ref] of authoritative) {
    const block = await sendRpcRequest('getblock', [blockhash, 2]);
    const ours = detectOracleBundle(block);
    checked++;
    const match = ours.hasOracleBundle === true
      && ours.oracleSignerCount === ref.signer_count
      && Math.abs(ours.oraclePriceUsd - ref.price_usd) < 1e-9
      && ours.oracleEpoch === ref.epoch;
    if (match) {
      ok++;
    } else {
      mismatched++;
      console.log(`MISMATCH height=${ref.height} node={signers:${ref.signer_count}, price:${ref.price_usd}, epoch:${ref.epoch}} ours=${JSON.stringify(ours)}`);
    }
  }

  // 2. False-positive sweep over the same window.
  let falsePositives = 0;
  const tip = signers.chain_height;
  for (let h = tip; h > tip - Math.min(scan, 200); h--) {
    const hash = await sendRpcRequest('getblockhash', [h]);
    if (!hash) continue;
    const block = await sendRpcRequest('getblock', [hash, 2]);
    const ours = detectOracleBundle(block);
    if (ours.hasOracleBundle && !authoritative.has(hash)) {
      falsePositives++;
      console.log(`FALSE POSITIVE height=${h} ours=${JSON.stringify(ours)}`);
    }
  }

  console.log(`\nRESULT: ${ok}/${checked} node-reported bundles decoded identically; ${mismatched} mismatches; ${falsePositives} false positives in sweep`);
  process.exit(mismatched || falsePositives ? 1 : 0);
}

main().catch((e) => { console.error('validate-oracle-parse failed:', e.message); process.exit(2); });
