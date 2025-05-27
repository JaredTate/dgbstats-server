/**
 * General Test Data
 * 
 * Contains various test data structures used across different test files
 */

const mockPeerData = {
  uniqueIPv4Addresses: [
    "192.168.1.100",
    "10.0.0.50",
    "172.16.0.25",
    "203.0.113.10",
    "198.51.100.20"
  ],
  uniqueIPv6Addresses: [
    "2001:db8::1",
    "2001:db8::2",
    "fe80::1"
  ]
};

const mockGeoData = [
  {
    ip: "192.168.1.100",
    country: "US",
    city: "New York",
    lat: 40.7128,
    lon: -74.0060
  },
  {
    ip: "10.0.0.50",
    country: "GB",
    city: "London",
    lat: 51.5074,
    lon: -0.1278
  },
  {
    ip: "172.16.0.25",
    country: "DE",
    city: "Berlin",
    lat: 52.5200,
    lon: 13.4050
  },
  {
    ip: "203.0.113.10",
    country: "JP",
    city: "Tokyo",
    lat: 35.6762,
    lon: 139.6503
  },
  {
    ip: "198.51.100.20",
    country: "AU",
    city: "Sydney",
    lat: -33.8688,
    lon: 151.2093
  }
];

const mockVisitStats = {
  visitsLast30Days: 1250,
  totalVisits: 5432,
  uniqueVisitors: 987
};

const mockCacheStatus = {
  peer: {
    hasPeerData: true,
    hasGeoNodes: true,
    peerTtl: 450,
    geoNodesTtl: 450,
    peerCount: 8
  },
  rpc: {
    stats: {
      keys: 15
    }
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
};

const mockWebSocketMessages = {
  recentBlocks: {
    type: 'recentBlocks',
    data: [
      {
        height: 18234567,
        hash: "000000000000000123456789abcdef123456789abcdef123456789abcdef1234",
        algo: "SHA256D",
        txCount: 1,
        difficulty: 123456789.123456,
        timestamp: 1640995200,
        minedTo: "D1234567890ABCDefghijklmnopqrstuvwxyzABC",
        minerAddress: "D1234567890ABCDefghijklmnopqrstuvwxyzABC",
        poolIdentifier: "Unknown",
        taprootSignaling: false,
        version: 536870912
      }
    ]
  },
  newBlock: {
    type: 'newBlock',
    data: {
      height: 18234568,
      hash: "000000000000000fedcba098765432109876543210987654321098765432109",
      algo: "Scrypt",
      txCount: 5,
      difficulty: 123456789.456789,
      timestamp: 1640995260,
      minedTo: "D9876543210FEDCBAabcdef1234567890abcdef",
      minerAddress: "D9876543210FEDCBAabcdef1234567890abcdef",
      poolIdentifier: "MiningPool",
      taprootSignaling: false,
      version: 536870912
    }
  },
  initialData: {
    type: 'initialData',
    data: {
      blockchainInfo: {
        chain: "main",
        blocks: 18234567,
        difficulty: 123456789.123456
      },
      chainTxStats: {
        txcount: 12345678,
        txrate: 0.014305555555555555
      },
      txOutsetInfo: {
        height: 18234567,
        transactions: 8765432,
        total_amount: 21000000000.12345678
      },
      blockReward: 625.0
    }
  },
  geoData: {
    type: 'geoData',
    data: mockGeoData
  }
};

const mockErrorResponses = {
  blockchainInfoError: {
    error: "Error fetching blockchain info"
  },
  peerInfoError: {
    error: "Error fetching peer info"
  },
  blockRewardError: {
    error: "Error fetching block reward"
  },
  rpcTimeoutError: {
    error: "RPC timeout"
  },
  databaseError: {
    error: "Database error retrieving visit stats"
  },
  cacheRefreshError: {
    error: "Missing type parameter"
  }
};

const testConfig = {
  testPort: 0, // Use random port
  wsTestPort: 0, // Use random port
  testTimeout: 10000,
  rpcTimeout: 5000,
  cacheTimeout: 1000
};

// Test database schemas
const testDbSchemas = {
  nodes: `CREATE TABLE IF NOT EXISTS nodes (
    ip TEXT PRIMARY KEY,
    country TEXT,
    city TEXT,
    lat REAL,
    lon REAL
  )`,
  visits: `CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  unique_ips: `CREATE TABLE IF NOT EXISTS unique_ips (
    ip TEXT PRIMARY KEY
  )`
};

// Mock coinbase data for pool identification testing
const mockCoinbaseData = {
  slashPool: "2f4d696e696e67506f6f6c2f", // "/MiningPool/"
  bracketPool: "5b5375706572506f6f6c5d", // "[SuperPool]"  
  atPool: "40506f6f6c2e6578616d706c652e636f6d40", // "@Pool.example.com@"
  namedPool: "44696769506f6f6c", // "DigiPool"
  unknownPool: "deadbeefcafe", // Unknown pattern
  emptyPool: ""
};

module.exports = {
  mockPeerData,
  mockGeoData,
  mockVisitStats,
  mockCacheStatus,
  mockWebSocketMessages,
  mockErrorResponses,
  testConfig,
  testDbSchemas,
  mockCoinbaseData
};