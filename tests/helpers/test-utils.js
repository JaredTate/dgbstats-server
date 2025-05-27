/**
 * Test Utilities
 * 
 * Common utility functions and helpers for testing
 */

const axios = require('axios');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

/**
 * Create a test database in memory
 */
function createTestDatabase() {
  const db = new sqlite3.Database(':memory:');
  
  // Initialize test schema
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS nodes (
      ip TEXT PRIMARY KEY,
      country TEXT,
      city TEXT,
      lat REAL,
      lon REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS unique_ips (
      ip TEXT PRIMARY KEY
    )`);
  });

  return db;
}

/**
 * Mock axios for RPC testing
 */
function mockAxios() {
  const originalPost = axios.post;
  const mockResponses = new Map();
  
  axios.post = vi.fn((url, data) => {
    const key = `${data.method}:${JSON.stringify(data.params || [])}`;
    
    if (mockResponses.has(key)) {
      const response = mockResponses.get(key);
      if (response instanceof Error) {
        return Promise.reject(response);
      }
      return Promise.resolve({ data: response });
    }
    
    // Default success response
    return Promise.resolve({
      data: {
        result: `mocked-${data.method}`,
        error: null,
        id: data.id
      }
    });
  });

  return {
    mockResponse: (method, params, response) => {
      const key = `${method}:${JSON.stringify(params || [])}`;
      mockResponses.set(key, response);
    },
    mockError: (method, params, error) => {
      const key = `${method}:${JSON.stringify(params || [])}`;
      mockResponses.set(key, error);
    },
    restore: () => {
      axios.post = originalPost;
      mockResponses.clear();
    }
  };
}

/**
 * Create a test WebSocket client
 */
function createTestWebSocketClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const messages = [];
    
    ws.on('open', () => {
      resolve({
        ws,
        messages,
        send: (data) => ws.send(JSON.stringify(data)),
        close: () => ws.close(),
        waitForMessage: (timeout = 5000) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('Timeout waiting for WebSocket message'));
            }, timeout);
            
            const checkMessages = () => {
              if (messages.length > 0) {
                clearTimeout(timer);
                resolve(messages.shift());
              } else {
                setTimeout(checkMessages, 10);
              }
            };
            
            checkMessages();
          });
        }
      });
    });
    
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data));
      } catch (e) {
        messages.push(data.toString());
      }
    });
    
    ws.on('error', reject);
    
    setTimeout(() => {
      reject(new Error('WebSocket connection timeout'));
    }, 5000);
  });
}

/**
 * Wait for a condition to be true
 */
function waitFor(condition, timeout = 5000, interval = 100) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout waiting for condition'));
      } else {
        setTimeout(check, interval);
      }
    };
    
    check();
  });
}

/**
 * Create a mock cache for testing
 */
function createMockCache() {
  const cache = new Map();
  const ttls = new Map();
  
  return {
    get: (key) => {
      if (ttls.has(key) && Date.now() > ttls.get(key)) {
        cache.delete(key);
        ttls.delete(key);
        return undefined;
      }
      return cache.get(key);
    },
    set: (key, value, ttl) => {
      cache.set(key, value);
      if (ttl) {
        ttls.set(key, Date.now() + (ttl * 1000));
      }
    },
    has: (key) => {
      if (ttls.has(key) && Date.now() > ttls.get(key)) {
        cache.delete(key);
        ttls.delete(key);
        return false;
      }
      return cache.has(key);
    },
    del: (key) => {
      cache.delete(key);
      ttls.delete(key);
    },
    keys: () => Array.from(cache.keys()),
    getTtl: (key) => ttls.get(key) || 0,
    clear: () => {
      cache.clear();
      ttls.clear();
    }
  };
}

/**
 * Generate test block data
 */
function generateTestBlock(height = 1000000, algo = 'sha256d') {
  return {
    hash: `000000000000000${height.toString(16).padStart(8, '0')}`,
    height,
    version: 536870912,
    time: Math.floor(Date.now() / 1000),
    nTx: Math.floor(Math.random() * 10) + 1,
    difficulty: Math.random() * 1000000,
    pow_algo: algo,
    tx: [
      {
        vin: [
          {
            coinbase: Buffer.from(`block-${height}`).toString('hex')
          }
        ],
        vout: [
          {
            value: 625.0,
            n: 0,
            scriptPubKey: {
              address: `D${height.toString(16).padStart(33, '0')}`
            }
          }
        ]
      }
    ]
  };
}

/**
 * Generate test peer data
 */
function generateTestPeerData(count = 5) {
  const ipv4Addresses = [];
  const ipv6Addresses = [];
  
  for (let i = 0; i < count; i++) {
    ipv4Addresses.push(`192.168.${Math.floor(i / 255)}.${i % 255}`);
    if (i < 3) {
      ipv6Addresses.push(`2001:db8::${i + 1}`);
    }
  }
  
  return {
    uniqueIPv4Addresses: ipv4Addresses,
    uniqueIPv6Addresses: ipv6Addresses
  };
}

/**
 * Create a temporary test file
 */
function createTempFile(content, extension = '.tmp') {
  const fs = require('fs');
  const os = require('os');
  const tempPath = path.join(os.tmpdir(), `test-${Date.now()}${extension}`);
  
  fs.writeFileSync(tempPath, content);
  
  return {
    path: tempPath,
    cleanup: () => {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  };
}

/**
 * Suppress console output during tests
 */
function suppressConsole() {
  const originalMethods = {
    log: console.log,
    error: console.error,
    warn: console.warn
  };
  
  console.log = vi.fn();
  console.error = vi.fn();
  console.warn = vi.fn();
  
  return () => {
    console.log = originalMethods.log;
    console.error = originalMethods.error;
    console.warn = originalMethods.warn;
  };
}

/**
 * Test server lifecycle management
 */
class TestServer {
  constructor() {
    this.server = null;
    this.port = null;
  }
  
  async start(app, port = 0) {
    return new Promise((resolve, reject) => {
      this.server = app.listen(port, (err) => {
        if (err) {
          reject(err);
        } else {
          this.port = this.server.address().port;
          resolve(this.port);
        }
      });
    });
  }
  
  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve);
        this.server = null;
        this.port = null;
      });
    }
  }
}

module.exports = {
  createTestDatabase,
  mockAxios,
  createTestWebSocketClient,
  waitFor,
  createMockCache,
  generateTestBlock,
  generateTestPeerData,
  createTempFile,
  suppressConsole,
  TestServer
};