#!/usr/bin/env node

/**
 * Quick test script to verify mempool data fetching works
 * This helps debug RPC issues without running the full server
 */

const { sendRpcRequest, getTransactionData } = require('./rpc');

async function testMempoolFetch() {
  console.log('🔍 Testing mempool data fetching...\n');
  
  try {
    // Test 1: Get mempool info
    console.log('1. Testing getmempoolinfo...');
    const mempoolInfo = await sendRpcRequest('getmempoolinfo');
    if (mempoolInfo) {
      console.log(`✅ Mempool size: ${mempoolInfo.size} transactions`);
      console.log(`✅ Total bytes: ${(mempoolInfo.bytes / 1024).toFixed(2)} KB`);
    } else {
      console.log('❌ Failed to get mempool info');
      return;
    }
    
    // Test 2: Get raw mempool
    console.log('\n2. Testing getrawmempool...');
    const rawMempool = await sendRpcRequest('getrawmempool', [true]);
    if (rawMempool) {
      const txIds = Object.keys(rawMempool);
      console.log(`✅ Raw mempool contains ${txIds.length} transactions`);
      
      if (txIds.length > 0) {
        // Test 3: Try to fetch a transaction
        const testTxId = txIds[0];
        console.log(`\n3. Testing transaction fetch for: ${testTxId.substring(0, 16)}...`);
        
        const txData = await getTransactionData(testTxId);
        if (txData) {
          console.log(`✅ Successfully fetched transaction via ${txData.method}`);
          console.log(`   Size: ${txData.vsize || txData.size} bytes`);
          console.log(`   Inputs: ${txData.vin ? txData.vin.length : 'unknown'}`);
          console.log(`   Outputs: ${txData.vout ? txData.vout.length : 'unknown'}`);
        } else {
          console.log('❌ Failed to fetch transaction data');
        }
      } else {
        console.log('ℹ️  Mempool is empty - no transactions to test');
      }
    } else {
      console.log('❌ Failed to get raw mempool');
    }
    
    console.log('\n🎉 Mempool test complete!');
    
  } catch (error) {
    console.error('💥 Test failed:', error.message);
    console.error('\n🔧 Possible fixes:');
    console.error('1. Check DigiByte node is running and synced');
    console.error('2. Verify RPC credentials in environment variables or rpc.js');
    console.error('3. Ensure node has txindex=1 if testing confirmed transactions');
    console.error('4. Check firewall/network connectivity to RPC port');
  }
}

// Run the test
testMempoolFetch().then(() => process.exit(0));