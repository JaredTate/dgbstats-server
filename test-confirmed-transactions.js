#!/usr/bin/env node

/**
 * Test script to verify confirmed transactions are being sent properly
 * This helps debug the recent transactions functionality
 */

const WebSocket = require('ws');

function testConfirmedTransactions() {
  console.log('🔍 Testing confirmed transactions delivery...\n');
  
  const ws = new WebSocket('ws://localhost:5002');
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected successfully');
    console.log('📡 Waiting for recent confirmed transactions...\n');
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      console.log(`📨 Received message type: ${message.type}`);
      
      if (message.type === 'recentTransactions') {
        console.log('🎉 CONFIRMED TRANSACTIONS RECEIVED!');
        console.log(`   Count: ${message.data?.length || 0}`);
        
        if (message.data && message.data.length > 0) {
          console.log('\n📄 Transaction Details:');
          message.data.forEach((tx, index) => {
            console.log(`   ${index + 1}. ${tx.txid?.substring(0, 16)}...`);
            console.log(`      Block: ${tx.blockHeight}`);
            console.log(`      Value: ${tx.value} DGB`);
            console.log(`      Fee: ${tx.fee} DGB`);
            console.log(`      Confirmations: ${tx.confirmations}`);
            console.log(`      Placeholder: ${tx.placeholder || false}`);
            console.log('');
          });
          
          console.log('✅ SUCCESS: Confirmed transactions are being delivered!');
        } else {
          console.log('⚠️  Empty confirmed transactions array received');
        }
        
      } else if (message.type === 'recentBlocks') {
        console.log(`✅ Recent blocks received: ${message.data?.length || 0} blocks`);
        if (message.data && message.data.length > 0) {
          console.log(`   Latest block: ${message.data[0].height}`);
          console.log(`   Transactions in latest: ${message.data[0].txCount}`);
        }
        
      } else if (message.type === 'mempool') {
        console.log(`✅ Mempool data received: ${message.data?.transactions?.length || 0} transactions`);
        
      } else {
        console.log(`ℹ️  Other message: ${message.type}`);
      }
      
    } catch (error) {
      console.error('❌ Error parsing message:', error.message);
    }
  });
  
  ws.on('error', (error) => {
    console.error('💥 WebSocket error:', error.message);
    console.error('\n🔧 Possible fixes:');
    console.error('1. Ensure dgbstats-server is running (node server.js)');
    console.error('2. Check WebSocket port 5002 is available');
    console.error('3. Verify DigiByte node is running and accessible');
    console.error('4. Check DigiByte node has recent blocks with transactions');
  });
  
  ws.on('close', () => {
    console.log('\n👋 WebSocket connection closed');
    process.exit(0);
  });
  
  // Auto-close after 15 seconds
  setTimeout(() => {
    console.log('\n⏰ Test timeout - closing connection');
    ws.close();
  }, 15000);
}

// Add some helpful debugging info
console.log('🧪 DigiByte Confirmed Transactions Test');
console.log('=====================================');
console.log('This test connects to the dgbstats-server and waits for confirmed transactions.');
console.log('If successful, you should see transaction details within a few seconds.\n');

testConfirmedTransactions();