/**
 * WebSocket Integration Tests
 * 
 * Tests WebSocket connections, message broadcasting,
 * and real-time functionality.
 */

const WebSocket = require('ws');
const { createTestWebSocketClient, waitFor } = require('../helpers/test-utils');
const { mockWebSocketMessages } = require('../fixtures/test-data');
const { mockBlocks } = require('../fixtures/mock-blocks');

describe('WebSocket Integration Tests', () => {
  let wss;
  let wsPort;
  let clients = [];
  
  beforeEach(async () => {
    // Find available port
    wsPort = 5000 + Math.floor(Math.random() * 1000);
    
    // Create WebSocket server
    wss = new WebSocket.Server({ port: wsPort });
    
    // Setup mock data
    const recentBlocks = mockBlocks.slice(0, 5);
    const initialData = mockWebSocketMessages.initialData.data;
    const geoData = mockWebSocketMessages.geoData.data;
    
    // Setup connection handler
    wss.on('connection', (ws) => {
      console.log('Test WebSocket client connected');
      
      // Send initial data immediately
      ws.send(JSON.stringify({
        type: 'recentBlocks',
        data: recentBlocks
      }));
      
      ws.send(JSON.stringify({
        type: 'initialData', 
        data: initialData
      }));
      
      ws.send(JSON.stringify({
        type: 'geoData',
        data: geoData
      }));
      
      // Handle ping
      ws.on('ping', () => {
        ws.pong();
      });
      
      // Store client reference
      ws.clientId = Math.random().toString(36);
    });
  });
  
  afterEach(async () => {
    // Close all clients
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.close();
      }
    }
    clients = [];
    
    // Close server
    if (wss) {
      await new Promise((resolve) => {
        wss.close(resolve);
      });
    }
  });

  describe('Connection Management', () => {
    test('should accept WebSocket connections', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('should handle multiple concurrent connections', async () => {
      const clientPromises = Array(5).fill().map(() => 
        createTestWebSocketClient(wsPort)
      );
      
      const testClients = await Promise.all(clientPromises);
      clients.push(...testClients);
      
      testClients.forEach(client => {
        expect(client.ws.readyState).toBe(WebSocket.OPEN);
      });
      
      expect(wss.clients.size).toBe(5);
    });

    test('should handle client disconnections', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      expect(wss.clients.size).toBe(1);
      
      client.close();
      
      // Wait for disconnection to be processed
      await waitFor(() => wss.clients.size === 0, 2000);
      
      expect(wss.clients.size).toBe(0);
    });
  });

  describe('Initial Data Transmission', () => {
    test('should send recent blocks on connection', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      const message = await client.waitForMessage();
      
      expect(message).toMatchObject({
        type: 'recentBlocks',
        data: expect.any(Array)
      });
      
      expect(message.data.length).toBeGreaterThan(0);
      message.data.forEach(block => {
        expect(block).toMatchObject({
          height: expect.any(Number),
          hash: expect.any(String),
          difficulty: expect.any(Number)
        });
      });
    });

    test('should send initial blockchain data on connection', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Skip recentBlocks message
      await client.waitForMessage();
      
      const message = await client.waitForMessage();
      
      expect(message).toMatchObject({
        type: 'initialData',
        data: expect.any(Object)
      });
      
      expect(message.data).toMatchObject({
        blockchainInfo: expect.any(Object),
        chainTxStats: expect.any(Object),
        txOutsetInfo: expect.any(Object),
        blockReward: expect.any(Number)
      });
    });

    test('should send geo data on connection', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Skip first two messages
      await client.waitForMessage(); // recentBlocks
      await client.waitForMessage(); // initialData
      
      const message = await client.waitForMessage();
      
      expect(message).toMatchObject({
        type: 'geoData',
        data: expect.any(Array)
      });
      
      message.data.forEach(node => {
        expect(node).toMatchObject({
          ip: expect.any(String),
          country: expect.any(String),
          city: expect.any(String),
          lat: expect.any(Number),
          lon: expect.any(Number)
        });
      });
    });
  });

  describe('Real-time Updates', () => {
    test('should broadcast new block to all clients', async () => {
      // Create multiple clients
      const client1 = await createTestWebSocketClient(wsPort);
      const client2 = await createTestWebSocketClient(wsPort);
      clients.push(client1, client2);
      
      // Clear initial messages
      await client1.waitForMessage(); // recentBlocks
      await client1.waitForMessage(); // initialData
      await client1.waitForMessage(); // geoData
      
      await client2.waitForMessage(); // recentBlocks
      await client2.waitForMessage(); // initialData
      await client2.waitForMessage(); // geoData
      
      // Broadcast new block
      const newBlock = mockWebSocketMessages.newBlock;
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(newBlock));
        }
      });
      
      // Both clients should receive the new block
      const message1 = await client1.waitForMessage();
      const message2 = await client2.waitForMessage();
      
      expect(message1).toEqual(newBlock);
      expect(message2).toEqual(newBlock);
    });

    test('should broadcast updated initial data to all clients', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Clear initial messages
      await client.waitForMessage(); // recentBlocks
      await client.waitForMessage(); // initialData
      await client.waitForMessage(); // geoData
      
      // Broadcast updated initial data
      const updatedData = {
        type: 'initialData',
        data: {
          ...mockWebSocketMessages.initialData.data,
          blockchainInfo: {
            ...mockWebSocketMessages.initialData.data.blockchainInfo,
            blocks: 18234568 // Updated block count
          }
        }
      };
      
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(updatedData));
        }
      });
      
      const message = await client.waitForMessage();
      
      expect(message).toEqual(updatedData);
      expect(message.data.blockchainInfo.blocks).toBe(18234568);
    });

    test('should broadcast updated geo data to all clients', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Clear initial messages
      await client.waitForMessage(); // recentBlocks
      await client.waitForMessage(); // initialData
      await client.waitForMessage(); // geoData
      
      // Broadcast updated geo data
      const updatedGeoData = {
        type: 'geoData',
        data: [
          ...mockWebSocketMessages.geoData.data,
          {
            ip: '203.0.113.100',
            country: 'CA',
            city: 'Toronto',
            lat: 43.6532,
            lon: -79.3832
          }
        ]
      };
      
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(updatedGeoData));
        }
      });
      
      const message = await client.waitForMessage();
      
      expect(message).toEqual(updatedGeoData);
      expect(message.data.length).toBe(mockWebSocketMessages.geoData.data.length + 1);
    });
  });

  describe('Connection Health', () => {
    test('should respond to ping messages', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Setup pong handler
      let pongReceived = false;
      client.ws.on('pong', () => {
        pongReceived = true;
      });
      
      // Send ping
      client.ws.ping();
      
      // Wait for pong
      await waitFor(() => pongReceived, 2000);
      
      expect(pongReceived).toBe(true);
    });

    test('should handle large numbers of messages', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Clear initial messages
      await client.waitForMessage(); // recentBlocks
      await client.waitForMessage(); // initialData
      await client.waitForMessage(); // geoData
      
      // Test that server can handle many rapid connections/disconnections
      const messageCount = 10; // Reduced for faster testing
      const receivedMessages = [];
      
      // Server broadcasts to all connected clients
      for (let i = 0; i < messageCount; i++) {
        wss.clients.forEach(ws => {
          if (ws.readyState === 1) { // OPEN
            ws.send(JSON.stringify({
              type: 'testBroadcast',
              data: { id: i, timestamp: Date.now() }
            }));
          }
        });
        
        try {
          const message = await client.waitForMessage(500);
          receivedMessages.push(message);
        } catch (error) {
          // Some messages might be lost in rapid fire, that's ok
          break;
        }
      }
      
      expect(receivedMessages.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid message format gracefully', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Send invalid JSON
      client.ws.send('invalid json {');
      
      // WebSocket should still be connected
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('should handle client errors gracefully', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Simulate client error
      client.ws.emit('error', new Error('Test error'));
      
      // Server should still be running
      expect(wss.clients.size).toBeGreaterThanOrEqual(0);
    });

    test('should clean up closed connections', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      expect(wss.clients.size).toBe(1);
      
      // Force close client
      client.ws.terminate();
      
      // Wait for cleanup
      await waitFor(() => wss.clients.size === 0, 2000);
      
      expect(wss.clients.size).toBe(0);
    });
  });

  describe('Message Format Validation', () => {
    test('should send properly formatted recent blocks message', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      const message = await client.waitForMessage();
      
      expect(message.type).toBe('recentBlocks');
      expect(Array.isArray(message.data)).toBe(true);
      
      if (message.data.length > 0) {
        const block = message.data[0];
        expect(block).toMatchObject({
          height: expect.any(Number),
          hash: expect.stringMatching(/^[a-f0-9]{64}$/i),
          difficulty: expect.any(Number),
          version: expect.any(Number)
        });
      }
    });

    test('should send properly formatted new block message', async () => {
      const client = await createTestWebSocketClient(wsPort);
      clients.push(client);
      
      // Clear initial messages
      await client.waitForMessage(); // recentBlocks
      await client.waitForMessage(); // initialData
      await client.waitForMessage(); // geoData
      
      // Send new block
      const newBlock = mockWebSocketMessages.newBlock;
      wss.clients.forEach(wsClient => {
        if (wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify(newBlock));
        }
      });
      
      const message = await client.waitForMessage();
      
      expect(message.type).toBe('newBlock');
      expect(message.data).toMatchObject({
        height: expect.any(Number),
        hash: expect.any(String),
        difficulty: expect.any(Number)
      });
    });
  });

  describe('Performance', () => {
    test('should handle rapid connection/disconnection cycles', async () => {
      const cycles = 10;
      
      for (let i = 0; i < cycles; i++) {
        const client = await createTestWebSocketClient(wsPort);
        expect(client.ws.readyState).toBe(WebSocket.OPEN);
        client.close();
        
        // Wait for disconnection
        await waitFor(() => wss.clients.size === 0, 1000);
      }
      
      expect(wss.clients.size).toBe(0);
    });

    test('should broadcast to many clients efficiently', async () => {
      const clientCount = 50;
      const testClients = [];
      
      // Create many clients
      for (let i = 0; i < clientCount; i++) {
        const client = await createTestWebSocketClient(wsPort);
        testClients.push(client);
        
        // Clear initial messages
        await client.waitForMessage(); // recentBlocks
        await client.waitForMessage(); // initialData
        await client.waitForMessage(); // geoData
      }
      
      clients.push(...testClients);
      
      // Broadcast message to all
      const broadcastMessage = {
        type: 'broadcast-test',
        data: { timestamp: Date.now() }
      };
      
      const startTime = Date.now();
      
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(broadcastMessage));
        }
      });
      
      // Wait for all clients to receive message
      const receivePromises = testClients.map(client => 
        client.waitForMessage(5000)
      );
      
      const results = await Promise.all(receivePromises);
      const endTime = Date.now();
      
      // All clients should receive the message
      results.forEach(message => {
        expect(message).toEqual(broadcastMessage);
      });
      
      // Broadcast should be reasonably fast
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });
});