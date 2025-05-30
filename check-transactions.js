#!/usr/bin/env node
/**
 * Check Transaction Availability - Debug Script
 * 
 * This script directly calls the RPC to check if recent blocks contain transactions
 * and helps debug why confirmed transactions might not be loading.
 */

const { sendRpcRequest, getBlocksByTimeRange } = require('./rpc');

async function checkRecentBlocks() {
  try {
    console.log('🔍 Checking recent blocks for transactions...\n');
    
    // Get blockchain info
    const blockchainInfo = await sendRpcRequest('getblockchaininfo');
    const currentHeight = blockchainInfo.blocks;
    console.log(`Current blockchain height: ${currentHeight}`);
    
    // Check last 10 blocks
    console.log('\nChecking last 10 blocks:');
    console.log('='.repeat(60));
    
    let totalTransactions = 0;
    let blocksWithTransactions = 0;
    
    for (let i = 0; i < 10; i++) {
      const height = currentHeight - i;
      const hash = await sendRpcRequest('getblockhash', [height]);
      const block = await sendRpcRequest('getblock', [hash, 2]);
      
      const nonCoinbaseTxs = block.tx.length - 1;
      totalTransactions += nonCoinbaseTxs;
      
      if (nonCoinbaseTxs > 0) {
        blocksWithTransactions++;
        console.log(`✅ Block ${height}: ${nonCoinbaseTxs} transactions`);
        
        // Show first few transactions
        for (let j = 1; j <= Math.min(3, block.tx.length - 1); j++) {
          const tx = block.tx[j];
          let value = 0;
          if (tx.vout) {
            value = tx.vout.reduce((sum, out) => sum + (out.value || 0), 0);
          }
          console.log(`   - ${tx.txid.substring(0, 16)}... (${value.toFixed(2)} DGB)`);
        }
        if (nonCoinbaseTxs > 3) {
          console.log(`   ... and ${nonCoinbaseTxs - 3} more transactions`);
        }
      } else {
        console.log(`⬜ Block ${height}: Only coinbase transaction`);
      }
    }
    
    console.log('='.repeat(60));
    console.log(`\nSummary:`);
    console.log(`- Blocks with transactions: ${blocksWithTransactions}/10`);
    console.log(`- Total non-coinbase transactions: ${totalTransactions}`);
    
    // Check mempool
    console.log('\nChecking mempool:');
    const mempoolInfo = await sendRpcRequest('getmempoolinfo');
    console.log(`- Mempool size: ${mempoolInfo.size} transactions`);
    console.log(`- Mempool bytes: ${(mempoolInfo.bytes / 1048576).toFixed(2)} MB`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the check
checkRecentBlocks();