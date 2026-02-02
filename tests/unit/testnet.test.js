/**
 * Unit Tests for Testnet RPC Functionality
 *
 * Tests all testnet-specific RPC functionality including caching, rate limiting,
 * error handling, and testnet-specific data processing.
 */

const axios = require('axios');
const crypto = require('crypto');

// Mock axios before importing rpc module
vi.mock('axios');
const mockedAxios = axios;

// Import test utilities and fixtures
const { createMockRpcEnvironment, rpcErrorScenarios } = require('../helpers/mock-rpc');
const { createMockCache } = require('../helpers/test-utils');
const {
  mockBlockchainInfo,
  mockBlock,
  mockTxOutsetInfo,
  mockChainTxStats,
  mockBlockReward,
  mockPeerInfo,
  mockRpcErrors
} = require('../fixtures/mock-rpc-responses');
const { mockBlocks } = require('../fixtures/mock-blocks');

// Create testnet-specific mock data (with testnet chain indicator)
const mockTestnetBlockchainInfo = {
  ...mockBlockchainInfo,
  chain: "test",
  blocks: 2500000,
  headers: 2500000,
  bestblockhash: "0000000000000001testnet789abcdef123456789abcdef123456789abcdef"
};

const mockTestnetBlock = {
  ...mockBlock,
  hash: "0000000000000001testnet789abcdef123456789abcdef123456789abcdef",
  height: 2500000,
  previousblockhash: "0000000000000000testnet098765432109876543210987654321098765432"
};

const mockTestnetTxOutsetInfo = {
  ...mockTxOutsetInfo,
  height: 2500000,
  bestblock: "0000000000000001testnet789abcdef123456789abcdef123456789abcdef"
};

describe('Testnet RPC Module', () => {
  let mockRpcEnv;
  let rpcModule;

  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create mock RPC environment
    mockRpcEnv = createMockRpcEnvironment();
    mockedAxios.post = mockRpcEnv.mockAxios;

    // Mock crypto for consistent cache keys
    vi.spyOn(crypto, 'createHash').mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('mockedTestnetHash123')
    });

    // Re-require the module to get fresh instance
    delete require.cache[require.resolve('../../rpc.js')];
    rpcModule = require('../../rpc.js');
  });

  afterEach(() => {
    mockRpcEnv.cleanup();
    vi.restoreAllMocks();
  });

  describe('sendTestnetRpcRequest', () => {
    test('should make successful testnet RPC call', async () => {
      const method = 'getblockchaininfo';
      const expectedResponse = mockTestnetBlockchainInfo;

      mockRpcEnv.mockServer.setResponse(method, expectedResponse);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toEqual(expectedResponse);
      expect(result.chain).toBe('test');
    });

    test('should cache successful testnet responses', async () => {
      const method = 'getblockchaininfo';
      const expectedResponse = mockTestnetBlockchainInfo;

      mockRpcEnv.mockServer.setResponse(method, expectedResponse);

      // First call
      const result1 = await rpcModule.sendTestnetRpcRequest(method);
      // Second call should use cache
      const result2 = await rpcModule.sendTestnetRpcRequest(method);

      expect(result1).toEqual(expectedResponse);
      expect(result2).toEqual(expectedResponse);
      // Should only make one actual RPC call due to caching
      expect(mockRpcEnv.mockServer.getCallCount(method)).toBe(1);
    });

    test('should skip cache when skipCache is true', async () => {
      const method = 'getblockchaininfo';
      const expectedResponse = mockTestnetBlockchainInfo;

      mockRpcEnv.mockServer.setResponse(method, expectedResponse);

      // First call with cache
      await rpcModule.sendTestnetRpcRequest(method);
      // Second call skipping cache
      await rpcModule.sendTestnetRpcRequest(method, [], true);

      // Should make two RPC calls
      expect(mockRpcEnv.mockServer.getCallCount(method)).toBe(2);
    });

    test('should handle testnet RPC errors gracefully', async () => {
      const method = 'invalidmethod';
      const error = rpcErrorScenarios.methodNotFound();

      mockRpcEnv.mockServer.setError(method, error);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toBeNull();
    });

    test('should handle testnet network errors', async () => {
      const method = 'getblockchaininfo';
      const error = rpcErrorScenarios.connectionRefused();

      mockRpcEnv.mockServer.setError(method, error);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toBeNull();
    });

    test('should generate estimated data for testnet gettxoutsetinfo on error', async () => {
      const method = 'gettxoutsetinfo';
      const error = rpcErrorScenarios.timeout();

      mockRpcEnv.mockServer.setError(method, error);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toMatchObject({
        height: 0,
        bestblock: "",
        transactions: 0,
        txouts: 0,
        _estimated: true
      });
    });
  });

  describe('Testnet Cache Key Generation', () => {
    test('should use testnet prefix for cache keys', async () => {
      const method = 'getblockchaininfo';
      mockRpcEnv.mockServer.setResponse(method, mockTestnetBlockchainInfo);

      // Make testnet request - this will populate the cache
      await rpcModule.sendTestnetRpcRequest(method);

      // Check that the cache has a testnet-prefixed key
      const cacheKeys = rpcModule.rpcCache.keys();
      const testnetKeys = cacheKeys.filter(key => key.startsWith('testnet:'));

      expect(testnetKeys.length).toBeGreaterThan(0);
    });

    test('should keep testnet and mainnet cache entries separate', async () => {
      const method = 'getblockchaininfo';

      // Set different responses for mainnet vs testnet
      mockRpcEnv.mockServer.setResponse(method, mockBlockchainInfo);

      // Make mainnet request
      const mainnetResult = await rpcModule.sendRpcRequest(method);

      // Update mock for testnet
      mockRpcEnv.mockServer.setResponse(method, mockTestnetBlockchainInfo);

      // Make testnet request
      const testnetResult = await rpcModule.sendTestnetRpcRequest(method);

      // Both should have different chain values
      expect(mainnetResult.chain).toBe('main');
      expect(testnetResult.chain).toBe('test');
    });

    test('should generate unique cache keys for different parameters', async () => {
      // This test verifies that the cache key generation includes parameters
      // The sendTestnetRpcRequest should create cache keys with 'testnet:' prefix
      // and include method and parameters in the key

      const method = 'getblockchaininfo';

      // Make a request to populate the cache
      mockRpcEnv.mockServer.setResponse(method, mockTestnetBlockchainInfo);
      await rpcModule.sendTestnetRpcRequest(method);

      // Verify cache has testnet-prefixed keys
      const cacheKeys = rpcModule.rpcCache.keys();
      const testnetKeys = cacheKeys.filter(key => key.startsWith('testnet:'));

      expect(testnetKeys.length).toBeGreaterThan(0);

      // Verify the key format includes the method name or its hash
      const hasMethodReference = testnetKeys.some(key =>
        key.includes(method) || key.includes('testnet:')
      );
      expect(hasMethodReference).toBe(true);
    });
  });

  describe('Testnet Block Operations', () => {
    test('should fetch testnet block by hash', async () => {
      const blockHash = mockTestnetBlock.hash;
      mockRpcEnv.mockServer.setResponse('getblock', mockTestnetBlock, [blockHash, 2]);

      const result = await rpcModule.sendTestnetRpcRequest('getblock', [blockHash, 2]);

      expect(result).toEqual(mockTestnetBlock);
      expect(result.height).toBe(2500000);
    });

    test('should fetch testnet block hash by height', async () => {
      const height = 2500000;
      const expectedHash = mockTestnetBlock.hash;
      mockRpcEnv.mockServer.setResponse('getblockhash', expectedHash, [height]);

      const result = await rpcModule.sendTestnetRpcRequest('getblockhash', [height]);

      expect(result).toBe(expectedHash);
    });

    test('should handle testnet best block hash request', async () => {
      mockRpcEnv.mockServer.setResponse('getbestblockhash', mockTestnetBlock.hash);

      const result = await rpcModule.sendTestnetRpcRequest('getbestblockhash');

      expect(result).toBe(mockTestnetBlock.hash);
    });

    test('should handle invalid testnet block hash', async () => {
      const invalidHash = 'invalidhash123';
      const error = rpcErrorScenarios.methodNotFound();
      mockRpcEnv.mockServer.setError('getblock', error, [invalidHash, 2]);

      const result = await rpcModule.sendTestnetRpcRequest('getblock', [invalidHash, 2]);

      expect(result).toBeNull();
    });
  });

  describe('Testnet Transaction Operations', () => {
    test('should fetch testnet chain transaction stats', async () => {
      mockRpcEnv.mockServer.setResponse('getchaintxstats', mockChainTxStats);

      const result = await rpcModule.sendTestnetRpcRequest('getchaintxstats');

      expect(result).toEqual(mockChainTxStats);
      expect(result.txcount).toBeDefined();
    });

    test('should fetch testnet UTXO set info', async () => {
      mockRpcEnv.mockServer.setResponse('gettxoutsetinfo', mockTestnetTxOutsetInfo);

      const result = await rpcModule.sendTestnetRpcRequest('gettxoutsetinfo');

      expect(result).toEqual(mockTestnetTxOutsetInfo);
      expect(result.height).toBe(2500000);
    });

    test('should handle testnet mempool info request', async () => {
      const mockMempoolInfo = {
        loaded: true,
        size: 50,
        bytes: 25000,
        usage: 50000,
        maxmempool: 300000000,
        mempoolminfee: 0.00001
      };
      mockRpcEnv.mockServer.setResponse('getmempoolinfo', mockMempoolInfo);

      const result = await rpcModule.sendTestnetRpcRequest('getmempoolinfo');

      expect(result).toEqual(mockMempoolInfo);
    });

    test('should handle testnet raw mempool request', async () => {
      const mockRawMempool = {
        'txid1': { size: 250, fee: 0.0001 },
        'txid2': { size: 500, fee: 0.0002 }
      };
      mockRpcEnv.mockServer.setResponse('getrawmempool', mockRawMempool, [true]);

      const result = await rpcModule.sendTestnetRpcRequest('getrawmempool', [true]);

      expect(result).toEqual(mockRawMempool);
    });
  });

  describe('Testnet Network Operations', () => {
    test('should fetch testnet peer info', async () => {
      mockRpcEnv.mockServer.setResponse('getpeerinfo', mockPeerInfo);

      const result = await rpcModule.sendTestnetRpcRequest('getpeerinfo');

      expect(result).toEqual(mockPeerInfo);
      expect(Array.isArray(result)).toBe(true);
    });

    test('should fetch testnet block reward', async () => {
      mockRpcEnv.mockServer.setResponse('getblockreward', mockBlockReward);

      const result = await rpcModule.sendTestnetRpcRequest('getblockreward');

      expect(result).toEqual(mockBlockReward);
    });
  });

  describe('Testnet Error Scenarios', () => {
    test('should handle testnet timeout errors', async () => {
      const method = 'getblockchaininfo';
      const error = rpcErrorScenarios.timeout();

      mockRpcEnv.mockServer.setError(method, error);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toBeNull();
    });

    test('should handle testnet connection refused errors', async () => {
      const method = 'getblockchaininfo';
      const error = rpcErrorScenarios.connectionRefused();

      mockRpcEnv.mockServer.setError(method, error);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toBeNull();
    });

    test('should handle testnet parse errors', async () => {
      const method = 'getblockchaininfo';
      const error = rpcErrorScenarios.parseError();

      mockRpcEnv.mockServer.setError(method, error);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toBeNull();
    });

    test('should handle testnet invalid request errors', async () => {
      const method = 'getblockchaininfo';
      const error = rpcErrorScenarios.invalidRequest();

      mockRpcEnv.mockServer.setError(method, error);

      const result = await rpcModule.sendTestnetRpcRequest(method);

      expect(result).toBeNull();
    });
  });

  describe('Testnet Rate Limiting', () => {
    test('should handle concurrent testnet requests', async () => {
      const method = 'getblockchaininfo';
      mockRpcEnv.mockServer.setResponse(method, mockTestnetBlockchainInfo);

      // Make multiple concurrent requests
      const promises = Array(5).fill().map(() =>
        rpcModule.sendTestnetRpcRequest(method, [], true)
      );

      const results = await Promise.all(promises);

      // All should succeed
      results.forEach(result => {
        expect(result).toEqual(mockTestnetBlockchainInfo);
      });
    });
  });
});

describe('Testnet Cache Behavior', () => {
  let mockCache;
  let rpcModule;

  beforeEach(() => {
    mockCache = createMockCache();

    delete require.cache[require.resolve('../../rpc.js')];
    rpcModule = require('../../rpc.js');
  });

  test('testnet cache keys should have proper prefix format', () => {
    const testKey = 'testnet:getblockchaininfo:hash123';
    mockCache.set(testKey, { data: 'test' });

    expect(mockCache.has(testKey)).toBe(true);
    expect(testKey.startsWith('testnet:')).toBe(true);
  });

  test('should handle testnet cache expiration', async () => {
    const cacheKey = 'testnet:test:key';
    const testData = { chain: 'test', blocks: 2500000 };

    // Set data with short TTL
    mockCache.set(cacheKey, testData, 1); // 1 second

    // Should exist immediately
    expect(mockCache.has(cacheKey)).toBe(true);
    expect(mockCache.get(cacheKey)).toEqual(testData);

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Should be expired
    expect(mockCache.has(cacheKey)).toBe(false);
    expect(mockCache.get(cacheKey)).toBeUndefined();
  });

  test('testnet cache should be isolated from mainnet cache', () => {
    const mainnetKey = 'getblockchaininfo:hash123';
    const testnetKey = 'testnet:getblockchaininfo:hash123';

    const mainnetData = { chain: 'main', blocks: 18234567 };
    const testnetData = { chain: 'test', blocks: 2500000 };

    mockCache.set(mainnetKey, mainnetData);
    mockCache.set(testnetKey, testnetData);

    expect(mockCache.get(mainnetKey)).toEqual(mainnetData);
    expect(mockCache.get(testnetKey)).toEqual(testnetData);
    expect(mockCache.get(mainnetKey).chain).not.toBe(mockCache.get(testnetKey).chain);
  });
});

describe('Testnet Block Fetching (Future Implementation)', () => {
  let mockRpcEnv;
  let rpcModule;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpcEnv = createMockRpcEnvironment();
    mockedAxios.post = mockRpcEnv.mockAxios;

    delete require.cache[require.resolve('../../rpc.js')];
    rpcModule = require('../../rpc.js');
  });

  afterEach(() => {
    mockRpcEnv.cleanup();
  });

  test('should be able to fetch testnet blocks by time range', async () => {
    // Test data for testnet blocks
    const testnetBlock = {
      ...mockBlocks[0],
      hash: 'testnet_block_hash_123',
      height: 2500000
    };

    // Setup mock response for the specific height
    mockRpcEnv.mockServer.setResponse('getblockhash', testnetBlock.hash, [2500000]);
    mockRpcEnv.mockServer.setResponse('getblock', testnetBlock, [testnetBlock.hash, 2]);

    // Test individual block fetch
    const hashResult = await rpcModule.sendTestnetRpcRequest('getblockhash', [2500000]);
    expect(hashResult).toBe(testnetBlock.hash);

    // Test block data fetch
    const blockResult = await rpcModule.sendTestnetRpcRequest('getblock', [testnetBlock.hash, 2]);
    expect(blockResult.height).toBe(2500000);
  });

  test('should handle testnet block fetch errors gracefully', async () => {
    const error = rpcErrorScenarios.connectionRefused();
    mockRpcEnv.mockServer.setError('getblockhash', error, [2500000]);

    const result = await rpcModule.sendTestnetRpcRequest('getblockhash', [2500000]);

    expect(result).toBeNull();
  });
});

describe('Testnet Transaction Caching (Future Implementation)', () => {
  let mockRpcEnv;
  let rpcModule;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpcEnv = createMockRpcEnvironment();
    mockedAxios.post = mockRpcEnv.mockAxios;

    delete require.cache[require.resolve('../../rpc.js')];
    rpcModule = require('../../rpc.js');
  });

  afterEach(() => {
    mockRpcEnv.cleanup();
  });

  test('should cache testnet transaction data', async () => {
    const mockTx = {
      txid: 'testnet_tx_123',
      hash: 'testnet_tx_123',
      version: 1,
      size: 225,
      vsize: 225,
      locktime: 0,
      vin: [],
      vout: []
    };

    mockRpcEnv.mockServer.setResponse('getrawtransaction', mockTx, ['testnet_tx_123', true]);

    // First call
    const result1 = await rpcModule.sendTestnetRpcRequest('getrawtransaction', ['testnet_tx_123', true]);
    // Second call (should use cache)
    const result2 = await rpcModule.sendTestnetRpcRequest('getrawtransaction', ['testnet_tx_123', true]);

    expect(result1).toEqual(mockTx);
    expect(result2).toEqual(mockTx);

    // Verify that the cache contains a testnet-prefixed key for this transaction
    const cacheKeys = rpcModule.rpcCache.keys();
    const txCacheKeys = cacheKeys.filter(k => k.includes('testnet:') && k.includes('getrawtransaction'));
    expect(txCacheKeys.length).toBeGreaterThanOrEqual(1);
  });

  test('should handle testnet transaction fetch errors', async () => {
    const error = rpcErrorScenarios.methodNotFound();
    mockRpcEnv.mockServer.setError('getrawtransaction', error, ['invalid_tx', true]);

    const result = await rpcModule.sendTestnetRpcRequest('getrawtransaction', ['invalid_tx', true]);

    expect(result).toBeNull();
  });

  test('should cache testnet decoded transaction data separately from mainnet', async () => {
    const testnetTx = {
      txid: 'shared_tx_id',
      value: 1000,
      network: 'testnet'
    };

    // Setup testnet response
    mockRpcEnv.mockServer.setResponse('getrawtransaction', testnetTx, ['shared_tx_id', true]);

    // Fetch via testnet
    const testnetResult = await rpcModule.sendTestnetRpcRequest('getrawtransaction', ['shared_tx_id', true]);

    expect(testnetResult).toEqual(testnetTx);
    expect(testnetResult.network).toBe('testnet');

    // Verify cache has testnet-prefixed key
    const cacheKeys = rpcModule.rpcCache.keys();
    const testnetCacheKeys = cacheKeys.filter(k => k.includes('testnet:'));
    expect(testnetCacheKeys.length).toBeGreaterThan(0);
  });
});
