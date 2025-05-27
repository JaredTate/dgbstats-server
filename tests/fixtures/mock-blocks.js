/**
 * Mock Block Data
 * 
 * Contains realistic mock block data for testing block processing,
 * mining pool identification, and algorithm detection.
 */

const mockBlocks = [
  {
    hash: "000000000000000123456789abcdef123456789abcdef123456789abcdef1234",
    height: 18234567,
    version: 536870912,
    time: 1640995200,
    nTx: 1,
    difficulty: 123456789.123456,
    pow_algo: "sha256d",
    tx: [
      {
        vin: [
          {
            coinbase: "03f7d11200062f503253482f04b8864e5408" // Basic coinbase
          }
        ],
        vout: [
          {
            value: 625.0,
            n: 0,
            scriptPubKey: {
              address: "D1234567890ABCDefghijklmnopqrstuvwxyzABC"
            }
          }
        ]
      }
    ]
  },
  {
    hash: "000000000000000fedcba098765432109876543210987654321098765432109",
    height: 18234568,
    version: 536870912,
    time: 1640995260,
    nTx: 5,
    difficulty: 123456789.456789,
    pow_algo: "scrypt",
    tx: [
      {
        vin: [
          {
            coinbase: "03f8d11200092f4d696e696e67506f6f6c2f" // Contains "/MiningPool/"
          }
        ],
        vout: [
          {
            value: 625.0,
            n: 0,
            scriptPubKey: {
              address: "D9876543210FEDCBAabcdef1234567890abcdef"
            }
          }
        ]
      }
    ]
  },
  {
    hash: "000000000000000abcdef1234567890abcdef1234567890abcdef1234567890",
    height: 18234569,
    version: 536870916, // Taproot signaling bit set
    time: 1640995320,
    nTx: 12,
    difficulty: 123456789.789123,
    pow_algo: "skein",
    tx: [
      {
        vin: [
          {
            coinbase: "03f9d112000c5b537570657250b6f6c5d" // Contains "[SuperPool]"
          }
        ],
        vout: [
          {
            value: 625.0,
            n: 0,
            scriptPubKey: {
              address: "DabcdefABCDEF1234567890abcdef1234567890"
            }
          }
        ]
      }
    ]
  },
  {
    hash: "000000000000000567890abcdef1234567890abcdef1234567890abcdef12345",
    height: 18234570,
    version: 536870912,
    time: 1640995380,
    nTx: 8,
    difficulty: 123456789.111222,
    pow_algo: "qubit",
    tx: [
      {
        vin: [
          {
            coinbase: "03fad112000f40506f6f6c2e6578616d706c652e636f6d40" // Contains "@Pool.example.com@"
          }
        ],
        vout: [
          {
            value: 625.0,
            n: 0,
            scriptPubKey: {
              address: "D567890abcdef1234567890abcdef1234567890"
            }
          }
        ]
      }
    ]
  },
  {
    hash: "000000000000000890abcdef1234567890abcdef1234567890abcdef1234567",
    height: 18234571,
    version: 536870912,
    time: 1640995440,
    nTx: 3,
    difficulty: 123456789.333444,
    pow_algo: "odo",
    tx: [
      {
        vin: [
          {
            coinbase: "03fbd11200084469676950b6f6c" // Contains "DigiPool"
          }
        ],
        vout: [
          {
            value: 625.0,
            n: 0,
            scriptPubKey: {
              address: "D890abcdef1234567890abcdef1234567890abc"
            }
          }
        ]
      }
    ]
  }
];

// Mock processed blocks (what getBlocksByTimeRange should return)
const mockProcessedBlocks = mockBlocks.map(block => ({
  height: block.height,
  hash: block.hash,
  algo: getAlgoName(block.pow_algo),
  txCount: block.nTx,
  difficulty: block.difficulty,
  timestamp: block.time,
  minedTo: block.tx[0].vout[0].scriptPubKey.address,
  minerAddress: block.tx[0].vout[0].scriptPubKey.address,
  poolIdentifier: extractPoolFromCoinbase(block.tx[0].vin[0].coinbase),
  taprootSignaling: (block.version & (1 << 2)) !== 0,
  version: block.version
}));

// Helper functions for mock data processing
function getAlgoName(algo) {
  const algorithms = {
    'sha256d': 'SHA256D',
    'scrypt': 'Scrypt',
    'skein': 'Skein',
    'qubit': 'Qubit',
    'odo': 'Odo'
  };
  return algorithms[algo] || 'Unknown';
}

function extractPoolFromCoinbase(coinbaseHex) {
  try {
    const text = Buffer.from(coinbaseHex, 'hex').toString('utf8');
    
    const patterns = [
      /\/(.*?)\//,       // /PoolName/
      /\[(.*?)\]/,       // [PoolName]
      /@(.*?)@/,         // @PoolName@
      /(.*?)pool/i,      // SomethingPool
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1] && match[1].length > 2) {
        return match[1].trim();
      }
    }
    
    return 'Unknown';
  } catch (error) {
    return 'Unknown';
  }
}

// Mock block hashes for testing block hash fetching
const mockBlockHashes = [
  "000000000000000123456789abcdef123456789abcdef123456789abcdef1234",
  "000000000000000fedcba098765432109876543210987654321098765432109",
  "000000000000000abcdef1234567890abcdef1234567890abcdef1234567890",
  "000000000000000567890abcdef1234567890abcdef1234567890abcdef12345",
  "000000000000000890abcdef1234567890abcdef1234567890abcdef1234567"
];

module.exports = {
  mockBlocks,
  mockProcessedBlocks,
  mockBlockHashes,
  getAlgoName,
  extractPoolFromCoinbase
};