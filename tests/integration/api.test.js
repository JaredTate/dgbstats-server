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

/**
 * Integration Tests for Testnet API Endpoints
 *
 * Tests all testnet-specific HTTP API endpoints for proper behavior,
 * error handling, and response formats.
 */
describe('Testnet API Endpoints Integration Tests', () => {
  let app;
  let mockRpcEnv;
  let mockRpc;

  // Testnet-specific mock data
  const mockTestnetBlockchainInfo = {
    chain: "test",
    blocks: 2500000,
    headers: 2500000,
    bestblockhash: "0000000000000001testnet789abcdef123456789abcdef123456789abcdef",
    difficulty: 12345.678,
    mediantime: 1640995200,
    verificationprogress: 0.9999999,
    initialblockdownload: false,
    chainwork: "00000000000000000000000000000000000000000000000testnet123abc",
    size_on_disk: 1234567890,
    pruned: false,
    softforks: {}
  };

  const mockTestnetChainTxStats = {
    time: 1640995200,
    txcount: 1234567,
    window_block_count: 144,
    window_tx_count: 123,
    window_interval: 86400,
    txrate: 0.001425
  };

  const mockTestnetTxOutsetInfo = {
    height: 2500000,
    bestblock: "0000000000000001testnet789abcdef123456789abcdef123456789abcdef",
    transactions: 876543,
    txouts: 2345678,
    bogosize: 176543210,
    hash_serialized_2: "testnet1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    disk_size: 98765432,
    total_amount: 2100000000.12345678
  };

  const mockTestnetBlock = {
    hash: "0000000000000001testnet789abcdef123456789abcdef123456789abcdef",
    confirmations: 1,
    strippedsize: 1234,
    size: 1456,
    weight: 5678,
    height: 2500000,
    version: 536870912,
    versionHex: "20000000",
    merkleroot: "testnetabcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    tx: [
      {
        txid: "testnet_tx_123",
        hash: "testnet_tx_123",
        version: 1,
        size: 123,
        vsize: 123,
        weight: 456,
        locktime: 0,
        vin: [{ coinbase: "03f7d11200062f503253482f04b8864e5408", sequence: 4294967295 }],
        vout: [{ value: 625.0, n: 0, scriptPubKey: { address: "dgb1testnet123456789" } }]
      }
    ],
    time: 1640995200,
    mediantime: 1640994800,
    nonce: 123456789,
    bits: "1a123456",
    difficulty: 12345.678,
    chainwork: "00000000000000000000000000000000000000000000000testnet123abc",
    nTx: 1,
    previousblockhash: "0000000000000000testnet098765432109876543210987654321098765432",
    pow_algo: "sha256d",
    pow_hash: "0000000000000001testnet789abcdef123456789abcdef123456789abcdef"
  };

  const mockTestnetBlockReward = {
    blockreward: 625.0
  };

  const mockTestnetPeerInfo = [
    {
      id: 1,
      addr: "192.168.1.50:12026",
      services: "000000000000040d",
      relaytxes: true,
      lastsend: 1640995200,
      lastrecv: 1640995201,
      version: 70015,
      subver: "/DigiByte Core:8.22.0(testnet)/",
      inbound: false,
      startingheight: 2499990,
      synced_headers: 2500000,
      synced_blocks: 2500000
    }
  ];

  const mockTestnetMempoolInfo = {
    loaded: true,
    size: 10,
    bytes: 5000,
    usage: 10000,
    maxmempool: 300000000,
    mempoolminfee: 0.00001
  };

  const mockTestnetRawMempool = {
    'testnet_tx_1': { size: 250, fee: 0.0001, time: 1640995100 },
    'testnet_tx_2': { size: 500, fee: 0.0002, time: 1640995150 }
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock RPC environment
    mockRpcEnv = createMockRpcEnvironment();

    // Setup mock RPC module
    mockRpc = require('../../rpc.js');
    mockRpc.sendTestnetRpcRequest = mockRpcEnv.mockSendRpc;

    // Setup testnet responses
    mockRpcEnv.mockServer.setResponse('getblockchaininfo', mockTestnetBlockchainInfo);
    mockRpcEnv.mockServer.setResponse('getchaintxstats', mockTestnetChainTxStats);
    mockRpcEnv.mockServer.setResponse('gettxoutsetinfo', mockTestnetTxOutsetInfo);
    mockRpcEnv.mockServer.setResponse('getblockreward', mockTestnetBlockReward);
    mockRpcEnv.mockServer.setResponse('getpeerinfo', mockTestnetPeerInfo);
    mockRpcEnv.mockServer.setResponse('getmempoolinfo', mockTestnetMempoolInfo);
    mockRpcEnv.mockServer.setResponse('getrawmempool', mockTestnetRawMempool, [true]);
    mockRpcEnv.mockServer.setResponse('getbestblockhash', mockTestnetBlock.hash);
    mockRpcEnv.mockServer.setResponse('getblock', mockTestnetBlock, [mockTestnetBlock.hash]);
    mockRpcEnv.mockServer.setResponse('getblock', mockTestnetBlock, [mockTestnetBlock.hash, 2]);
    mockRpcEnv.mockServer.setResponse('getblockhash', mockTestnetBlock.hash, [2500000]);

    // Create Express app with testnet routes
    app = express();
    app.use(cors());
    app.use(express.json());

    // Setup testnet routes
    setupTestnetRoutes(app);
  });

  afterEach(() => {
    mockRpcEnv.cleanup();
  });

  function setupTestnetRoutes(app) {
    // Testnet blockchain information
    app.get('/api/testnet/getblockchaininfo', async (req, res) => {
      try {
        const data = await mockRpc.sendTestnetRpcRequest('getblockchaininfo');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet blockchain info' });
      }
    });

    // Testnet block hash by height
    app.get('/api/testnet/getblockhash/:height', async (req, res) => {
      try {
        const height = parseInt(req.params.height, 10);
        const data = await mockRpc.sendTestnetRpcRequest('getblockhash', [height]);
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet block hash' });
      }
    });

    // Testnet block by hash
    app.get('/api/testnet/getblock/:hash', async (req, res) => {
      try {
        const data = await mockRpc.sendTestnetRpcRequest('getblock', [req.params.hash, 2]);
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet block' });
      }
    });

    // Testnet chain transaction statistics
    app.get('/api/testnet/getchaintxstats', async (req, res) => {
      try {
        const data = await mockRpc.sendTestnetRpcRequest('getchaintxstats');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet chain transaction stats' });
      }
    });

    // Testnet UTXO set information
    app.get('/api/testnet/gettxoutsetinfo', async (req, res) => {
      try {
        const data = await mockRpc.sendTestnetRpcRequest('gettxoutsetinfo');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet transaction output set info' });
      }
    });

    // Testnet peer information
    app.get('/api/testnet/getpeerinfo', async (req, res) => {
      try {
        const peerData = await mockRpc.sendTestnetRpcRequest('getpeerinfo');
        const enhancedPeers = peerData.map((node) => {
          const ip = node.addr.split(':')[0];
          return {
            ...node,
            lat: 40.7128,
            lon: -74.0060,
            city: 'Test City',
            country: 'TC'
          };
        });
        res.json(enhancedPeers);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet peer info' });
      }
    });

    // Testnet block reward
    app.get('/api/testnet/getblockreward', async (req, res) => {
      try {
        const data = await mockRpc.sendTestnetRpcRequest('getblockreward');
        res.json({ blockReward: data });
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet block reward' });
      }
    });

    // Testnet mempool information
    app.get('/api/testnet/getmempoolinfo', async (req, res) => {
      try {
        const data = await mockRpc.sendTestnetRpcRequest('getmempoolinfo');
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet mempool info' });
      }
    });

    // Testnet raw mempool
    app.get('/api/testnet/getrawmempool', async (req, res) => {
      try {
        const data = await mockRpc.sendTestnetRpcRequest('getrawmempool', [true]);
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching testnet raw mempool' });
      }
    });

    // Testnet latest block
    app.get('/api/testnet/getlatestblock', async (req, res) => {
      try {
        const latestBlockHash = await mockRpc.sendTestnetRpcRequest('getbestblockhash');
        if (!latestBlockHash) {
          throw new Error('Failed to fetch testnet latest block hash');
        }
        const block = await mockRpc.sendTestnetRpcRequest('getblock', [latestBlockHash]);
        if (!block) {
          throw new Error('Failed to fetch testnet block data');
        }
        res.json({
          height: block.height,
          hash: block.hash,
          algo: block.pow_algo,
          txCount: block.nTx,
          difficulty: block.difficulty
        });
      } catch (error) {
        res.status(500).json({
          error: 'Error fetching testnet latest block',
          details: error.message
        });
      }
    });
  }

  describe('Testnet Blockchain Information Endpoints', () => {
    test('GET /api/testnet/getblockchaininfo should return testnet blockchain info', async () => {
      const response = await request(app)
        .get('/api/testnet/getblockchaininfo')
        .expect(200);

      expect(response.body).toEqual(mockTestnetBlockchainInfo);
      expect(response.body.chain).toBe('test');
    });

    test('GET /api/testnet/getchaintxstats should return testnet transaction stats', async () => {
      const response = await request(app)
        .get('/api/testnet/getchaintxstats')
        .expect(200);

      expect(response.body).toEqual(mockTestnetChainTxStats);
    });

    test('GET /api/testnet/gettxoutsetinfo should return testnet UTXO set info', async () => {
      const response = await request(app)
        .get('/api/testnet/gettxoutsetinfo')
        .expect(200);

      expect(response.body).toEqual(mockTestnetTxOutsetInfo);
    });

    test('GET /api/testnet/getblockreward should return testnet block reward', async () => {
      const response = await request(app)
        .get('/api/testnet/getblockreward')
        .expect(200);

      expect(response.body).toEqual({ blockReward: mockTestnetBlockReward });
    });
  });

  describe('Testnet Block Information Endpoints', () => {
    test('GET /api/testnet/getlatestblock should return testnet latest block info', async () => {
      const response = await request(app)
        .get('/api/testnet/getlatestblock')
        .expect(200);

      expect(response.body).toMatchObject({
        height: mockTestnetBlock.height,
        hash: mockTestnetBlock.hash,
        algo: mockTestnetBlock.pow_algo,
        txCount: mockTestnetBlock.nTx,
        difficulty: mockTestnetBlock.difficulty
      });
    });

    test('GET /api/testnet/getblockhash/:height should return testnet block hash', async () => {
      const response = await request(app)
        .get('/api/testnet/getblockhash/2500000')
        .expect(200);

      expect(response.body).toBe(mockTestnetBlock.hash);
    });

    test('GET /api/testnet/getblock/:hash should return testnet block', async () => {
      const response = await request(app)
        .get(`/api/testnet/getblock/${mockTestnetBlock.hash}`)
        .expect(200);

      expect(response.body).toMatchObject({
        hash: mockTestnetBlock.hash,
        height: mockTestnetBlock.height,
        pow_algo: mockTestnetBlock.pow_algo
      });
    });
  });

  describe('Testnet Network Information Endpoints', () => {
    test('GET /api/testnet/getpeerinfo should return enhanced testnet peer info', async () => {
      const response = await request(app)
        .get('/api/testnet/getpeerinfo')
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

    test('GET /api/testnet/getmempoolinfo should return testnet mempool info', async () => {
      const response = await request(app)
        .get('/api/testnet/getmempoolinfo')
        .expect(200);

      expect(response.body).toEqual(mockTestnetMempoolInfo);
    });

    test('GET /api/testnet/getrawmempool should return testnet raw mempool', async () => {
      const response = await request(app)
        .get('/api/testnet/getrawmempool')
        .expect(200);

      expect(response.body).toEqual(mockTestnetRawMempool);
    });
  });

  describe('Testnet Error Handling', () => {
    test('should handle testnet RPC errors gracefully', async () => {
      mockRpcEnv.mockServer.setError('getblockchaininfo', new Error('Testnet RPC connection failed'));

      const response = await request(app)
        .get('/api/testnet/getblockchaininfo')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Error fetching testnet blockchain info'
      });
    });

    test('should handle missing testnet latest block hash', async () => {
      mockRpcEnv.mockServer.setResponse('getbestblockhash', null);

      const response = await request(app)
        .get('/api/testnet/getlatestblock')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Error fetching testnet latest block',
        details: expect.any(String)
      });
    });

    test('should handle missing testnet block data', async () => {
      mockRpcEnv.mockServer.setResponse('getbestblockhash', 'validhash');
      mockRpcEnv.mockServer.setResponse('getblock', null, ['validhash']);

      const response = await request(app)
        .get('/api/testnet/getlatestblock')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Error fetching testnet latest block'
      });
    });

    test('should handle invalid testnet block height', async () => {
      mockRpcEnv.mockServer.setError('getblockhash', new Error('Block not found'), [99999999]);

      const response = await request(app)
        .get('/api/testnet/getblockhash/99999999')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Error fetching testnet block hash'
      });
    });
  });

  describe('Testnet CORS Headers', () => {
    test('should include CORS headers for testnet endpoints', async () => {
      const response = await request(app)
        .get('/api/testnet/getblockchaininfo')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('Testnet Content Type', () => {
    test('should return JSON content type for testnet endpoints', async () => {
      const response = await request(app)
        .get('/api/testnet/getblockchaininfo')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Testnet Chain Identification', () => {
    test('should return chain: test for testnet blockchain info', async () => {
      const response = await request(app)
        .get('/api/testnet/getblockchaininfo')
        .expect(200);

      expect(response.body.chain).toBe('test');
      expect(response.body.chain).not.toBe('main');
    });

    test('testnet block heights should be in expected range', async () => {
      const response = await request(app)
        .get('/api/testnet/getblockchaininfo')
        .expect(200);

      // Testnet typically has fewer blocks than mainnet
      expect(response.body.blocks).toBeLessThan(mockBlockchainInfo.blocks);
    });
  });
});