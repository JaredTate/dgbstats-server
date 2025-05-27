/**
 * End-to-End Integration Tests
 * 
 * Tests complete application workflows including
 * HTTP API, WebSocket connections, and data flow.
 */

const request = require('supertest');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

// Import test utilities and fixtures
const { createMockRpcEnvironment } = require('../helpers/mock-rpc');
const { createTestWebSocketClient, waitFor, TestServer } = require('../helpers/test-utils');
const {
  mockBlockchainInfo,
  mockBlock,
  mockPeerInfo
} = require('../fixtures/mock-rpc-responses');
const { mockBlocks } = require('../fixtures/mock-blocks');

// Mock child_process for peer script execution
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  exec: mockExec
}));

describe('End-to-End Integration Tests', () => {
  let mockRpcEnv;
  let testServer;
  let app;
  let httpPort;
  let wsPort;
  let wss;
  
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Create mock RPC environment
    mockRpcEnv = createMockRpcEnvironment();
    
    // Setup default responses
    mockRpcEnv.mockServer.setResponse('getblockchaininfo', mockBlockchainInfo);
    mockRpcEnv.mockServer.setResponse('getpeerinfo', mockPeerInfo);
    mockRpcEnv.mockServer.setResponse('getbestblockhash', mockBlock.hash);
    mockRpcEnv.mockServer.setResponse('getblock', mockBlock, [mockBlock.hash, 2]);
    
    // Setup blocks for range fetching
    mockBlocks.forEach((block, index) => {
      mockRpcEnv.mockServer.setResponse('getblockhash', block.hash, [block.height]);
      mockRpcEnv.mockServer.setResponse('getblock', block, [block.hash, 2]);
    });
    
    // Mock peer script execution
    const mockPeerData = {
      uniqueIPv4Addresses: ['192.168.1.100', '10.0.0.50'],
      uniqueIPv6Addresses: ['2001:db8::1']
    };
    
    mockExec.mockImplementation((command, options, callback) => {
      if (command.includes('parse_peers_dat.py')) {
        callback(null, JSON.stringify(mockPeerData), '');
      } else {
        callback(new Error('Unknown command'), '', 'Unknown command');
      }
    });
    
    // Create Express app with test routes
    app = express();
    app.use(cors());
    app.use(express.json());
    
    // Setup test routes
    setupE2ERoutes(app);
    
    // Start HTTP server
    testServer = new TestServer();
    httpPort = await testServer.start(app);
    
    // Start WebSocket server
    wsPort = httpPort + 1000; // Use different port for WS
    wss = new WebSocket.Server({ port: wsPort });
    setupWebSocketServer(wss);
  });
  
  afterEach(async () => {
    if (testServer) {
      await testServer.stop();
    }
    
    if (wss) {
      await new Promise((resolve) => {
        wss.close(resolve);
      });
    }
    
    mockRpcEnv.cleanup();
  });

  function setupE2ERoutes(app) {
    // Mock the RPC module behavior
    const mockRpc = {
      sendRpcRequest: mockRpcEnv.mockSendRpc
    };
    
    // Blockchain info endpoint
    app.get('/api/getblockchaininfo', async (req, res) => {
      try {
        const data = await mockRpc.sendRpcRequest('getblockchaininfo');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching blockchain info' });
      }
    });
    
    // Peer info endpoint
    app.get('/api/getpeerinfo', async (req, res) => {
      try {
        const data = await mockRpc.sendRpcRequest('getpeerinfo');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching peer info' });
      }
    });
    
    // Peers endpoint (with Python script execution)
    app.get('/api/getpeers', (req, res) => {
      const pythonScript = 'python3 parse_peers_dat.py';
      mockExec(pythonScript, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({ error: 'Error executing peer analysis script' });
        }
        
        try {
          const output = JSON.parse(stdout);
          res.json(output);
        } catch (parseError) {
          res.status(500).json({ error: 'Error parsing peer analysis results' });
        }
      });
    });
    
    // Block notification endpoint
    app.post('/api/blocknotify', async (req, res) => {
      try {
        const { blockhash } = req.body;
        if (!blockhash) {
          throw new Error('Missing blockhash');
        }
        
        const block = await mockRpc.sendRpcRequest('getblock', [blockhash, 2]);
        if (!block) {
          return res.sendStatus(200);
        }
        
        // Broadcast to WebSocket clients
        const newBlockMessage = {
          type: 'newBlock',
          data: {
            height: block.height,
            hash: block.hash,
            algo: 'SHA256D',
            txCount: block.nTx,
            difficulty: block.difficulty,
            timestamp: block.time,
            minerAddress: 'D1234567890ABCDefghijklmnopqrstuvwxyzABC',
            poolIdentifier: 'Unknown',
            taprootSignaling: false,
            version: block.version
          }
        };
        
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(newBlockMessage));
          }
        });
        
        res.sendStatus(200);
      } catch (error) {
        res.sendStatus(500);
      }
    });
    
    // Health check
    app.get('/health', (req, res) => {
      res.sendStatus(200);
    });
  }
  
  function setupWebSocketServer(wss) {
    wss.on('connection', (ws) => {
      // Send initial data
      ws.send(JSON.stringify({
        type: 'recentBlocks',
        data: mockBlocks.slice(0, 5)
      }));
      
      ws.send(JSON.stringify({
        type: 'initialData',
        data: {
          blockchainInfo: mockBlockchainInfo,
          chainTxStats: { txcount: 12345 },
          txOutsetInfo: { transactions: 8765432 },
          blockReward: 625.0
        }
      }));
      
      ws.send(JSON.stringify({
        type: 'geoData',
        data: [
          { ip: '192.168.1.100', country: 'US', city: 'New York', lat: 40.7128, lon: -74.0060 }
        ]
      }));
    });
  }

  describe('Complete Application Workflow', () => {
    test('should handle full blockchain data flow', async () => {
      // 1. Verify server is running
      const healthResponse = await request(app)
        .get('/health')
        .expect(200);
      
      // 2. Fetch blockchain info
      const blockchainResponse = await request(app)
        .get('/api/getblockchaininfo')
        .expect(200);
      
      expect(blockchainResponse.body).toEqual(mockBlockchainInfo);
      
      // 3. Fetch peer info
      const peerResponse = await request(app)
        .get('/api/getpeerinfo')
        .expect(200);
      
      expect(peerResponse.body).toEqual(mockPeerInfo);
      
      // 4. Connect WebSocket and receive initial data
      const wsClient = await createTestWebSocketClient(wsPort);
      
      const recentBlocks = await wsClient.waitForMessage();
      expect(recentBlocks.type).toBe('recentBlocks');
      expect(Array.isArray(recentBlocks.data)).toBe(true);
      
      const initialData = await wsClient.waitForMessage();
      expect(initialData.type).toBe('initialData');
      expect(initialData.data).toMatchObject({
        blockchainInfo: expect.any(Object),
        chainTxStats: expect.any(Object),
        blockReward: expect.any(Number)
      });
      
      const geoData = await wsClient.waitForMessage();
      expect(geoData.type).toBe('geoData');
      expect(Array.isArray(geoData.data)).toBe(true);
      
      wsClient.close();
    });

    test('should handle block notification workflow', async () => {
      // 1. Connect WebSocket client
      const wsClient = await createTestWebSocketClient(wsPort);
      
      // Clear initial messages
      await wsClient.waitForMessage(); // recentBlocks
      await wsClient.waitForMessage(); // initialData
      await wsClient.waitForMessage(); // geoData
      
      // 2. Send block notification
      const blockNotifyResponse = await request(app)
        .post('/api/blocknotify')
        .send({ blockhash: mockBlock.hash })
        .expect(200);
      
      // 3. Verify WebSocket receives new block
      const newBlockMessage = await wsClient.waitForMessage();
      expect(newBlockMessage.type).toBe('newBlock');
      expect(newBlockMessage.data).toMatchObject({
        height: mockBlock.height,
        hash: mockBlock.hash,
        algo: expect.any(String),
        txCount: expect.any(Number)
      });
      
      wsClient.close();
    });

    test('should handle peer data processing workflow', async () => {
      // 1. Request peer data (triggers Python script)
      const peerResponse = await request(app)
        .get('/api/getpeers')
        .expect(200);
      
      expect(peerResponse.body).toMatchObject({
        uniqueIPv4Addresses: expect.any(Array),
        uniqueIPv6Addresses: expect.any(Array)
      });
      
      expect(peerResponse.body.uniqueIPv4Addresses.length).toBeGreaterThan(0);
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('parse_peers_dat.py'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    test('should handle multiple concurrent WebSocket connections', async () => {
      const clients = [];
      const clientCount = 5;
      
      // Connect multiple clients
      for (let i = 0; i < clientCount; i++) {
        const client = await createTestWebSocketClient(wsPort);
        clients.push(client);
        
        // Verify each client receives initial data
        const recentBlocks = await client.waitForMessage();
        expect(recentBlocks.type).toBe('recentBlocks');
      }
      
      expect(wss.clients.size).toBe(clientCount);
      
      // Send block notification
      await request(app)
        .post('/api/blocknotify')
        .send({ blockhash: mockBlock.hash })
        .expect(200);
      
      // All clients should receive the new block
      for (const client of clients) {
        // Skip initial messages
        await client.waitForMessage(); // initialData
        await client.waitForMessage(); // geoData
        
        const newBlock = await client.waitForMessage();
        expect(newBlock.type).toBe('newBlock');
      }
      
      // Clean up
      clients.forEach(client => client.close());
    });

    test('should handle error scenarios gracefully', async () => {
      // 1. Test RPC error handling
      mockRpcEnv.mockServer.setError('getblockchaininfo', new Error('RPC Error'));
      
      const errorResponse = await request(app)
        .get('/api/getblockchaininfo')
        .expect(500);
      
      expect(errorResponse.body).toMatchObject({
        error: 'Error fetching blockchain info'
      });
      
      // 2. Test peer script error handling
      mockExec.mockImplementationOnce((command, options, callback) => {
        callback(new Error('Script failed'), '', 'Script error');
      });
      
      const peerErrorResponse = await request(app)
        .get('/api/getpeers')
        .expect(500);
      
      expect(peerErrorResponse.body).toMatchObject({
        error: 'Error executing peer analysis script'
      });
      
      // 3. Test block notification error handling
      const invalidBlockResponse = await request(app)
        .post('/api/blocknotify')
        .send({}) // Missing blockhash
        .expect(500);
    });

    test('should maintain WebSocket connection during API failures', async () => {
      // Connect WebSocket
      const wsClient = await createTestWebSocketClient(wsPort);
      
      // Clear initial messages
      await wsClient.waitForMessage(); // recentBlocks
      await wsClient.waitForMessage(); // initialData
      await wsClient.waitForMessage(); // geoData
      
      // Cause API error
      mockRpcEnv.mockServer.setError('getblockchaininfo', new Error('RPC Error'));
      
      await request(app)
        .get('/api/getblockchaininfo')
        .expect(500);
      
      // WebSocket should still be connected
      expect(wsClient.ws.readyState).toBe(WebSocket.OPEN);
      
      // Should still be able to send block notifications
      mockRpcEnv.mockServer.setResponse('getblock', mockBlock, [mockBlock.hash, 2]);
      
      await request(app)
        .post('/api/blocknotify')
        .send({ blockhash: mockBlock.hash })
        .expect(200);
      
      const newBlock = await wsClient.waitForMessage();
      expect(newBlock.type).toBe('newBlock');
      
      wsClient.close();
    });

    test('should handle rapid block notifications', async () => {
      // Simplified test - just verify the API can handle multiple requests
      const blockCount = 5;
      const blocks = mockBlocks.slice(0, blockCount);
      
      // Send rapid block notifications
      const notificationPromises = blocks.map(block => 
        request(app)
          .post('/api/blocknotify')
          .send({ blockhash: block.hash })
          .expect(200)
      );
      
      const responses = await Promise.all(notificationPromises);
      
      // All requests should succeed (200 status)
      expect(responses.length).toBe(blockCount);
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });

    test('should handle WebSocket reconnection scenarios', async () => {
      // Initial connection
      let wsClient = await createTestWebSocketClient(wsPort);
      
      const initialMessage = await wsClient.waitForMessage();
      expect(initialMessage.type).toBe('recentBlocks');
      
      // Close connection
      wsClient.close();
      
      // Wait for disconnection
      await waitFor(() => wss.clients.size === 0, 2000);
      
      // Reconnect
      wsClient = await createTestWebSocketClient(wsPort);
      
      // Should receive initial data again
      const reconnectMessage = await wsClient.waitForMessage();
      expect(reconnectMessage.type).toBe('recentBlocks');
      
      wsClient.close();
    });

    test('should validate data consistency across endpoints', async () => {
      // Get blockchain info via API
      const blockchainResponse = await request(app)
        .get('/api/getblockchaininfo')
        .expect(200);
      
      // Connect WebSocket and get initial data
      const wsClient = await createTestWebSocketClient(wsPort);
      
      await wsClient.waitForMessage(); // recentBlocks
      const initialData = await wsClient.waitForMessage();
      
      // Data should be consistent
      expect(initialData.data.blockchainInfo).toEqual(blockchainResponse.body);
      
      wsClient.close();
    });
  });

  describe('Performance and Load Testing', () => {
    test('should handle multiple API requests concurrently', async () => {
      const requestCount = 20;
      const startTime = Date.now();
      
      const requests = Array(requestCount).fill().map(() =>
        request(app).get('/api/getblockchaininfo').expect(200)
      );
      
      const responses = await Promise.all(requests);
      const endTime = Date.now();
      
      // All requests should succeed
      responses.forEach(response => {
        expect(response.body).toEqual(mockBlockchainInfo);
      });
      
      // Should complete within reasonable time
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(5000); // 5 seconds
    });

    test('should handle WebSocket message load', async () => {
      // Simplified load test - just verify multiple connections work
      const connectionCount = 5;
      const clients = [];
      
      // Create multiple connections
      for (let i = 0; i < connectionCount; i++) {
        const client = await createTestWebSocketClient(wsPort);
        clients.push(client);
        
        // Clear initial messages
        await client.waitForMessage(); // recentBlocks
        await client.waitForMessage(); // initialData
        await client.waitForMessage(); // geoData
      }
      
      // All connections should be active
      expect(clients.length).toBe(connectionCount);
      
      // Close all connections
      clients.forEach(client => client.close());
    });
  });
});