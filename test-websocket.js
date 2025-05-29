#!/usr/bin/env node

/**
 * Test WebSocket connection and mempool data delivery
 * This verifies the frontend will receive real transaction data
 */

const WebSocket = require('ws');

function testWebSocketConnection() {
  console.log('🔌 Testing WebSocket connection to dgbstats-server...\n');
  
  const ws = new WebSocket('ws://localhost:5002');
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected successfully');
    console.log('📡 Requesting mempool data...\n');
    
    // Request mempool data
    ws.send(JSON.stringify({ type: 'requestMempool' }));
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      console.log(`📨 Received message type: ${message.type}`);
      
      if (message.type === 'mempool') {
        console.log(`✅ Mempool data received!`);
        console.log(`   Transaction count: ${message.data.transactions?.length || 0}`);
        console.log(`   Mempool size: ${message.data.stats?.size || 0}`);
        console.log(`   Total fees: ${message.data.stats?.totalfee || 0} DGB`);
        console.log(`   Fee distribution:`, message.data.stats?.feeDistribution || 'none');
        
        if (message.data.transactions?.length > 0) {
          const tx = message.data.transactions[0];
          console.log(`\n📄 Sample transaction:`);
          console.log(`   TXID: ${tx.txid?.substring(0, 16)}...`);
          console.log(`   Value: ${tx.value} DGB`);
          console.log(`   Fee: ${tx.fee} DGB`);
          console.log(`   Priority: ${tx.priority}`);
        }
        
        console.log('\n🎉 Frontend will receive real transaction data!');
      } else if (message.type === 'recentBlocks') {
        console.log(`✅ Recent blocks received: ${message.data?.length || 0} blocks`);
      } else if (message.type === 'initialData') {
        console.log(`✅ Initial blockchain data received`);
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
    console.error('3. Verify no firewall blocking the connection');
  });
  
  ws.on('close', () => {
    console.log('\n👋 WebSocket connection closed');
    process.exit(0);
  });
  
  // Auto-close after 10 seconds
  setTimeout(() => {
    console.log('\n⏰ Test timeout - closing connection');
    ws.close();
  }, 10000);
}

testWebSocketConnection();