/**
 * Mock RPC Helper
 * 
 * Provides mock implementations of RPC functions for testing
 */

const {
  mockBlockchainInfo,
  mockChainTxStats,
  mockTxOutsetInfo,
  mockBlockReward,
  mockBlock,
  mockPeerInfo,
  mockRpcErrors
} = require('../fixtures/mock-rpc-responses');

const { mockBlocks, mockBlockHashes } = require('../fixtures/mock-blocks');

/**
 * Mock RPC server that responds to various DigiByte RPC methods
 */
class MockRpcServer {
  constructor() {
    this.responses = new Map();
    this.errors = new Map();
    this.delays = new Map();
    this.callCounts = new Map();
    
    // Set up default responses
    this.setupDefaults();
  }
  
  setupDefaults() {
    this.setResponse('getblockchaininfo', mockBlockchainInfo);
    this.setResponse('getchaintxstats', mockChainTxStats);
    this.setResponse('gettxoutsetinfo', mockTxOutsetInfo);
    this.setResponse('getblockreward', mockBlockReward);
    this.setResponse('getpeerinfo', mockPeerInfo);
    this.setResponse('getbestblockhash', mockBlocks[0].hash);
    
    // Set up block hash responses
    mockBlocks.forEach((block, index) => {
      this.setResponse('getblockhash', block.hash, [block.height]);
      this.setResponse('getblock', block, [block.hash, 2]);
    });
  }
  
  /**
   * Set a response for a specific RPC method and parameters
   */
  setResponse(method, response, params = []) {
    const key = this.generateKey(method, params);
    this.responses.set(key, response);
  }
  
  /**
   * Set an error response for a specific RPC method
   */
  setError(method, error, params = []) {
    const key = this.generateKey(method, params);
    this.errors.set(key, error);
  }
  
  /**
   * Set a delay for a specific RPC method
   */
  setDelay(method, delay, params = []) {
    const key = this.generateKey(method, params);
    this.delays.set(key, delay);
  }
  
  /**
   * Get response for a method call
   */
  async getResponse(method, params = []) {
    const key = this.generateKey(method, params);
    
    // Track call count
    this.callCounts.set(key, (this.callCounts.get(key) || 0) + 1);
    
    // Apply delay if set
    const delay = this.delays.get(key);
    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    // Check for error first
    if (this.errors.has(key)) {
      throw this.errors.get(key);
    }
    
    // Return response
    if (this.responses.has(key)) {
      return this.responses.get(key);
    }
    
    // Check for wildcard method response
    const wildcardKey = this.generateKey(method, []);
    if (this.responses.has(wildcardKey)) {
      return this.responses.get(wildcardKey);
    }
    
    throw new Error(`No mock response set for ${method} with params ${JSON.stringify(params)}`);
  }
  
  /**
   * Get call count for a method
   */
  getCallCount(method, params = []) {
    const key = this.generateKey(method, params);
    return this.callCounts.get(key) || 0;
  }
  
  /**
   * Reset all call counts
   */
  resetCallCounts() {
    this.callCounts.clear();
  }
  
  /**
   * Clear all responses, errors, and delays
   */
  clear() {
    this.responses.clear();
    this.errors.clear();
    this.delays.clear();
    this.callCounts.clear();
  }
  
  /**
   * Generate key for method and parameters
   */
  generateKey(method, params) {
    return `${method}:${JSON.stringify(params)}`;
  }
}

/**
 * Mock axios.post for RPC testing
 */
function mockAxiosPost(mockRpcServer) {
  return vi.fn(async (url, data) => {
    const { method, params = [] } = data;
    
    try {
      const result = await mockRpcServer.getResponse(method, params);
      return {
        data: {
          result,
          error: null,
          id: data.id
        }
      };
    } catch (error) {
      if (error.code) {
        // RPC error
        return {
          data: {
            result: null,
            error: error,
            id: data.id
          }
        };
      }
      // Network error
      throw error;
    }
  });
}

/**
 * Mock sendRpcRequest function
 */
function mockSendRpcRequest(mockRpcServer) {
  return vi.fn(async (method, params = [], skipCache = false) => {
    try {
      return await mockRpcServer.getResponse(method, params);
    } catch (error) {
      // Throw all errors so API routes can handle them properly
      throw error;
    }
  });
}

/**
 * Create a complete mock RPC environment
 */
function createMockRpcEnvironment() {
  const mockServer = new MockRpcServer();
  const mockAxios = mockAxiosPost(mockServer);
  const mockSendRpc = mockSendRpcRequest(mockServer);
  
  return {
    mockServer,
    mockAxios,
    mockSendRpc,
    cleanup: () => {
      mockServer.clear();
    }
  };
}

/**
 * Mock common RPC error scenarios
 */
const rpcErrorScenarios = {
  connectionRefused: () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:14044');
    error.code = 'ECONNREFUSED';
    return error;
  },
  
  timeout: () => {
    const error = new Error('timeout of 30000ms exceeded');
    error.code = 'ECONNABORTED';
    return error;
  },
  
  methodNotFound: () => ({
    code: -32601,
    message: 'Method not found'
  }),
  
  parseError: () => ({
    code: -32700,
    message: 'Parse error'
  }),
  
  invalidRequest: () => ({
    code: -32600,
    message: 'Invalid Request'
  })
};

module.exports = {
  MockRpcServer,
  mockAxiosPost,
  mockSendRpcRequest,
  createMockRpcEnvironment,
  rpcErrorScenarios
};