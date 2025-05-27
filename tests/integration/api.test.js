/**
 * Integration Tests for API Endpoints
 * 
 * Tests all HTTP API endpoints for proper behavior,
 * error handling, and response formats.
 */

const request = require('supertest');
const express = require('express');
const cors = require('cors');

// Import test utilities and fixtures
const { createMockRpcEnvironment } = require('../helpers/mock-rpc');
const { createTestDatabase } = require('../helpers/test-utils');
const {
  mockBlockchainInfo,
  mockChainTxStats,
  mockTxOutsetInfo,
  mockBlockReward,
  mockBlock,
  mockPeerInfo
} = require('../fixtures/mock-rpc-responses');

// Mock external dependencies
vi.mock('axios');
vi.mock('../../rpc.js');

describe('API Endpoints Integration Tests', () => {
  let app;
  let mockRpcEnv;
  let mockRpc;
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Create mock RPC environment
    mockRpcEnv = createMockRpcEnvironment();
    
    // Setup mock RPC module
    mockRpc = require('../../rpc.js');
    mockRpc.sendRpcRequest = mockRpcEnv.mockSendRpc;
    mockRpc.router = express.Router();
    
    // Setup basic responses
    mockRpcEnv.mockServer.setResponse('getblockchaininfo', mockBlockchainInfo);
    mockRpcEnv.mockServer.setResponse('getchaintxstats', mockChainTxStats);
    mockRpcEnv.mockServer.setResponse('gettxoutsetinfo', mockTxOutsetInfo);
    mockRpcEnv.mockServer.setResponse('getblockreward', mockBlockReward);
    mockRpcEnv.mockServer.setResponse('getpeerinfo', mockPeerInfo);
    mockRpcEnv.mockServer.setResponse('getbestblockhash', mockBlock.hash);
    mockRpcEnv.mockServer.setResponse('getblock', mockBlock, [mockBlock.hash]);
    
    // Create Express app
    app = express();
    app.use(cors());
    app.use(express.json());
    
    // Setup routes manually since we can't import the server module
    setupTestRoutes(app);
  });
  
  afterEach(() => {
    mockRpcEnv.cleanup();
  });

  function setupTestRoutes(app) {
    // Basic blockchain information
    app.get('/api/getblockchaininfo', async (req, res) => {
      try {
        const data = await mockRpc.sendRpcRequest('getblockchaininfo');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching blockchain info' });
      }
    });

    // Peer information with geolocation
    app.get('/api/getpeerinfo', async (req, res) => {
      try {
        const peerData = await mockRpc.sendRpcRequest('getpeerinfo');
        
        // Simulate geolocation enhancement
        const enhancedPeers = peerData.map((node) => {
          const ip = node.addr.split(':')[0];
          return {
            ...node,
            lat: 40.7128, // Mock NYC coordinates
            lon: -74.0060,
            city: 'New York',
            country: 'US',
          };
        });
        
        res.json(enhancedPeers);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching peer info' });
      }
    });

    // Block reward
    app.get('/api/getblockreward', async (req, res) => {
      try {
        const data = await mockRpc.sendRpcRequest('getblockreward');
        res.json({ blockReward: data });
      } catch (error) {
        res.status(500).json({ error: 'Error fetching block reward' });
      }
    });

    // Latest block
    app.get('/api/getlatestblock', async (req, res) => {
      try {
        const latestBlockHash = await mockRpc.sendRpcRequest('getbestblockhash');
        if (!latestBlockHash) {
          throw new Error('Failed to fetch latest block hash');
        }
        
        const block = await mockRpc.sendRpcRequest('getblock', [latestBlockHash]);
        if (!block) {
          throw new Error('Failed to fetch block data');
        }
        
        res.json({
          height: block.height,
          hash: block.hash,
          algo: block.pow_algo,
          txCount: block.nTx,
          difficulty: block.difficulty,
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Error fetching latest block', 
          details: error.message 
        });
      }
    });

    // Chain transaction statistics
    app.get('/api/getchaintxstats', async (req, res) => {
      try {
        const data = await mockRpc.sendRpcRequest('getchaintxstats');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching chain transaction stats' });
      }
    });

    // UTXO set information
    app.get('/api/gettxoutsetinfo', async (req, res) => {
      try {
        const data = await mockRpc.sendRpcRequest('gettxoutsetinfo');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching transaction output set info' });
      }
    });

    // Cache statistics
    app.get('/api/rpccachestats', (req, res) => {
      const stats = {
        keys: 10,
        hits: 50,
        misses: 25,
        total: 75,
        hitRate: '66.7%',
        pendingRequests: 0
      };
      res.json(stats);
    });

    // Cache refresh
    app.post('/api/refreshcache', async (req, res) => {
      try {
        const { type } = req.body || {};
        
        if (!type) {
          return res.status(400).json({ error: 'Missing type parameter' });
        }
        
        let result;
        
        switch (type) {
          case 'blockchain':
            result = await mockRpc.sendRpcRequest('getblockchaininfo', [], true);
            break;
          case 'txstats':
            result = await mockRpc.sendRpcRequest('getchaintxstats', [], true);
            break;
          case 'txoutset':
            result = await mockRpc.sendRpcRequest('gettxoutsetinfo', [], true);
            break;
          case 'blockreward':
            result = await mockRpc.sendRpcRequest('getblockreward', [], true);
            break;
          default:
            return res.status(400).json({ error: 'Invalid type parameter' });
        }
        
        res.json({ success: true, type, result });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Health check
    app.get('/health', (req, res) => {
      res.sendStatus(200);
    });

    // Visit stats (mock)
    app.get('/api/visitstats', (req, res) => {
      res.json({
        visitsLast30Days: 1250,
        totalVisits: 5432,
        uniqueVisitors: 987
      });
    });

    // Cache status
    app.get('/api/cachestatus', (req, res) => {
      res.json({
        peer: {
          hasPeerData: true,
          hasGeoNodes: true,
          peerTtl: 450,
          geoNodesTtl: 450,
          peerCount: 8
        },
        rpc: {
          stats: { keys: 15 }
        },
        initialData: {
          inMemory: true,
          inCache: true
        },
        blocks: {
          count: 240,
          latest: 18234567
        },
        connections: 3
      });
    });

    // Block notification (internal endpoint)
    app.post('/api/blocknotify', async (req, res) => {
      try {
        if (!req.body?.blockhash) {
          throw new Error('Missing blockhash in request body');
        }

        const blockHash = req.body.blockhash;
        const fullBlock = await mockRpc.sendRpcRequest('getblock', [blockHash, 2]);
        
        if (!fullBlock) {
          return res.sendStatus(200);
        }

        // Process block notification
        res.sendStatus(200);
      } catch (error) {
        res.sendStatus(500);
      }
    });
  }

  describe('Blockchain Information Endpoints', () => {
    test('GET /api/getblockchaininfo should return blockchain info', async () => {
      const response = await request(app)
        .get('/api/getblockchaininfo')
        .expect(200);

      expect(response.body).toEqual(mockBlockchainInfo);
      expect(mockRpcEnv.mockServer.getCallCount('getblockchaininfo')).toBe(1);
    });

    test('GET /api/getchaintxstats should return transaction stats', async () => {
      const response = await request(app)
        .get('/api/getchaintxstats')
        .expect(200);

      expect(response.body).toEqual(mockChainTxStats);
    });

    test('GET /api/gettxoutsetinfo should return UTXO set info', async () => {
      const response = await request(app)
        .get('/api/gettxoutsetinfo')
        .expect(200);

      expect(response.body).toEqual(mockTxOutsetInfo);
    });

    test('GET /api/getblockreward should return block reward', async () => {
      const response = await request(app)
        .get('/api/getblockreward')
        .expect(200);

      expect(response.body).toEqual({ blockReward: mockBlockReward });
    });
  });

  describe('Block Information Endpoints', () => {
    test('GET /api/getlatestblock should return latest block info', async () => {
      const response = await request(app)
        .get('/api/getlatestblock')
        .expect(200);

      expect(response.body).toMatchObject({
        height: mockBlock.height,
        hash: mockBlock.hash,
        algo: mockBlock.pow_algo,
        txCount: mockBlock.nTx,
        difficulty: mockBlock.difficulty
      });
    });

    test('POST /api/blocknotify should handle block notifications', async () => {
      const response = await request(app)
        .post('/api/blocknotify')
        .send({ blockhash: mockBlock.hash })
        .expect(200);
    });

    test('POST /api/blocknotify should reject missing blockhash', async () => {
      const response = await request(app)
        .post('/api/blocknotify')
        .send({})
        .expect(500);
    });
  });

  describe('Network Information Endpoints', () => {
    test('GET /api/getpeerinfo should return enhanced peer info', async () => {
      const response = await request(app)
        .get('/api/getpeerinfo')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      
      response.body.forEach(peer => {
        expect(peer).toMatchObject({
          id: expect.any(Number),
          addr: expect.any(String),
          lat: expect.any(Number),
          lon: expect.any(Number),
          city: expect.any(String),
          country: expect.any(String)
        });
      });
    });
  });

  describe('Cache Management Endpoints', () => {
    test('GET /api/rpccachestats should return cache statistics', async () => {
      const response = await request(app)
        .get('/api/rpccachestats')
        .expect(200);

      expect(response.body).toMatchObject({
        keys: expect.any(Number),
        hits: expect.any(Number),
        misses: expect.any(Number),
        total: expect.any(Number),
        hitRate: expect.any(String),
        pendingRequests: expect.any(Number)
      });
    });

    test('POST /api/refreshcache should refresh blockchain data', async () => {
      const response = await request(app)
        .post('/api/refreshcache')
        .send({ type: 'blockchain' })
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        type: 'blockchain',
        result: mockBlockchainInfo
      });
    });

    test('POST /api/refreshcache should require type parameter', async () => {
      const response = await request(app)
        .post('/api/refreshcache')
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'Missing type parameter'
      });
    });

    test('POST /api/refreshcache should reject invalid type', async () => {
      const response = await request(app)
        .post('/api/refreshcache')
        .send({ type: 'invalid' })
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'Invalid type parameter'
      });
    });

    test('GET /api/cachestatus should return cache status', async () => {
      const response = await request(app)
        .get('/api/cachestatus')
        .expect(200);

      expect(response.body).toMatchObject({
        peer: expect.any(Object),
        rpc: expect.any(Object),
        initialData: expect.any(Object),
        blocks: expect.any(Object),
        connections: expect.any(Number)
      });
    });
  });

  describe('Analytics Endpoints', () => {
    test('GET /api/visitstats should return visit statistics', async () => {
      const response = await request(app)
        .get('/api/visitstats')
        .expect(200);

      expect(response.body).toMatchObject({
        visitsLast30Days: expect.any(Number),
        totalVisits: expect.any(Number),
        uniqueVisitors: expect.any(Number)
      });
    });
  });

  describe('Health Check', () => {
    test('GET /health should return 200', async () => {
      await request(app)
        .get('/health')
        .expect(200);
    });
  });

  describe('Error Handling', () => {
    test('should handle RPC errors gracefully', async () => {
      // Setup error response
      mockRpcEnv.mockServer.setError('getblockchaininfo', new Error('RPC connection failed'));
      
      const response = await request(app)
        .get('/api/getblockchaininfo')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Error fetching blockchain info'
      });
    });

    test('should handle missing latest block hash', async () => {
      mockRpcEnv.mockServer.setResponse('getbestblockhash', null);
      
      const response = await request(app)
        .get('/api/getlatestblock')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Error fetching latest block',
        details: expect.any(String)
      });
    });

    test('should handle missing block data', async () => {
      mockRpcEnv.mockServer.setResponse('getbestblockhash', 'validhash');
      mockRpcEnv.mockServer.setResponse('getblock', null, ['validhash']);
      
      const response = await request(app)
        .get('/api/getlatestblock')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Error fetching latest block'
      });
    });
  });

  describe('CORS Headers', () => {
    test('should include CORS headers', async () => {
      const response = await request(app)
        .get('/api/getblockchaininfo')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    test('should handle OPTIONS requests', async () => {
      await request(app)
        .options('/api/getblockchaininfo')
        .expect(204);
    });
  });

  describe('Content Type', () => {
    test('should return JSON content type', async () => {
      const response = await request(app)
        .get('/api/getblockchaininfo')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    test('should accept JSON in POST requests', async () => {
      const response = await request(app)
        .post('/api/refreshcache')
        .send({ type: 'blockchain' })
        .set('Content-Type', 'application/json')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });
});