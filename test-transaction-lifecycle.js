#!/usr/bin/env node
/**
 * Test Transaction Lifecycle - WebSocket Client
 * 
 * This script connects to the DigiByte Stats WebSocket server and monitors
 * transaction lifecycle events to verify the mempool → confirmed flow works correctly.
 */

const WebSocket = require('ws');

// Configuration
const WS_URL = 'ws://localhost:5002';
let messageCount = 0;

// State tracking
const state = {
  mempoolTransactions: new Set(),
  confirmedTransactions: new Set(),
  initialDataReceived: false
};

console.log('🚀 Starting Transaction Lifecycle Test');
console.log('=' .repeat(60));

// Connect to WebSocket server
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ Connected to DigiByte Stats WebSocket server');
  console.log('📡 Monitoring transaction lifecycle events...\n');
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data);
    messageCount++;
    
    console.log(`📨 Message #${messageCount} - Type: ${message.type}`);
    
    switch (message.type) {
      case 'recentTransactions':
        console.log(`   📋 Initial confirmed transactions: ${message.data?.length || 0}`);
        if (message.data && message.data.length > 0) {
          message.data.forEach(tx => state.confirmedTransactions.add(tx.txid));
          console.log(`   🔹 Latest: ${message.data[0].txid.substring(0, 16)}... (Block ${message.data[0].blockHeight})`);
        }
        state.initialDataReceived = true;
        break;
        
      case 'mempool':
        console.log(`   🏊 Mempool update: ${message.data?.transactions?.length || 0} transactions`);
        console.log(`   📊 Stats: ${message.data?.stats?.size || 0} total, ${(message.data?.stats?.bytes / 1048576).toFixed(2) || 0} MB`);
        
        if (message.data?.transactions) {
          message.data.transactions.forEach(tx => state.mempoolTransactions.add(tx.txid));
          
          if (message.data.transactions.length > 0) {
            const latest = message.data.transactions[0];
            console.log(`   🔹 Latest mempool tx: ${latest.txid.substring(0, 16)}... (${latest.value?.toFixed(4)} DGB, ${latest.priority} priority)`);
          }
        }
        break;
        
      case 'newTransaction':
        const newTx = message.data;
        console.log(`   ➕ NEW mempool transaction: ${newTx.txid.substring(0, 16)}...`);
        console.log(`      💰 Value: ${newTx.value?.toFixed(4)} DGB, Fee: ${newTx.fee?.toFixed(8)} DGB`);
        console.log(`      🚀 Priority: ${newTx.priority}, Fee Rate: ${newTx.fee_rate} sat/byte`);
        state.mempoolTransactions.add(newTx.txid);
        break;
        
      case 'transactionConfirmed':
        const { transactions: confirmedTxs, blockHeight, blockHash } = message.data;
        console.log(`   ✅ CONFIRMED: ${confirmedTxs.length} transactions moved to block ${blockHeight}`);
        console.log(`      📦 Block: ${blockHash.substring(0, 16)}...`);
        
        confirmedTxs.forEach(tx => {
          const wasInMempool = state.mempoolTransactions.has(tx.txid);
          console.log(`      🔄 ${tx.txid.substring(0, 16)}... ${wasInMempool ? '(was in mempool)' : '(not tracked)'}`);
          
          if (wasInMempool) {
            state.mempoolTransactions.delete(tx.txid);
            state.confirmedTransactions.add(tx.txid);
          }
        });
        break;
        
      case 'newBlock':
        console.log(`   🧱 New block: ${message.data.height} (${message.data.algo})`);
        console.log(`      ⛏️  Mined by: ${message.data.poolIdentifier || 'Unknown'}`);
        console.log(`      🔢 Transactions: ${message.data.txCount}`);
        break;
        
      case 'recentBlocks':
        console.log(`   📚 Recent blocks received: ${message.data?.length || 0} blocks`);
        break;
        
      case 'initialData':
        console.log(`   🏠 Initial blockchain data received`);
        console.log(`      📏 Blockchain height: ${message.data?.blockchainInfo?.blocks || 'unknown'}`);
        break;
        
      default:
        console.log(`   ❓ Unknown message type: ${message.type}`);
    }
    
    // Print current state summary
    if (state.initialDataReceived) {
      console.log(`   📊 State: ${state.mempoolTransactions.size} in mempool, ${state.confirmedTransactions.size} confirmed\n`);
    } else {
      console.log('');
    }
    
  } catch (error) {
    console.error('❌ Error parsing message:', error);
    console.log('Raw message:', data.toString());
  }
});

ws.on('close', () => {
  console.log('🔌 WebSocket connection closed');
  console.log('\n📈 Final Statistics:');
  console.log(`   📨 Total messages received: ${messageCount}`);
  console.log(`   🏊 Mempool transactions tracked: ${state.mempoolTransactions.size}`);
  console.log(`   ✅ Confirmed transactions tracked: ${state.confirmedTransactions.size}`);
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Test interrupted by user');
  ws.close();
  process.exit(0);
});

// Test timeout (30 minutes)
setTimeout(() => {
  console.log('\n⏰ Test timeout reached (30 minutes)');
  console.log('📈 Final Statistics:');
  console.log(`   📨 Total messages received: ${messageCount}`);
  console.log(`   🏊 Mempool transactions tracked: ${state.mempoolTransactions.size}`);
  console.log(`   ✅ Confirmed transactions tracked: ${state.confirmedTransactions.size}`);
  ws.close();
  process.exit(0);
}, 30 * 60 * 1000);

console.log('⏱️  Test will run for up to 30 minutes or until interrupted with Ctrl+C');
console.log('🔍 Monitoring for transaction lifecycle events...\n');