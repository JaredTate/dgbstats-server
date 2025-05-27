/**
 * Mock RPC Response Data
 * 
 * Contains realistic mock responses for DigiByte RPC calls
 * used throughout the test suite.
 */

const mockBlockchainInfo = {
  chain: "main",
  blocks: 18234567,
  headers: 18234567,
  bestblockhash: "000000000000000123456789abcdef123456789abcdef123456789abcdef1234",
  difficulty: 123456789.123456,
  mediantime: 1640995200,
  verificationprogress: 0.9999999,
  initialblockdownload: false,
  chainwork: "0000000000000000000000000000000000000000000000123456789abcdef",
  size_on_disk: 12345678901,
  pruned: false,
  softforks: {
    bip34: { type: "buried", active: true, height: 1000000 },
    bip66: { type: "buried", active: true, height: 1250000 },
    bip65: { type: "buried", active: true, height: 1500000 }
  }
};

const mockChainTxStats = {
  time: 1640995200,
  txcount: 12345678,
  window_block_count: 144,
  window_tx_count: 1234,
  window_interval: 86400,
  txrate: 0.014305555555555555
};

const mockTxOutsetInfo = {
  height: 18234567,
  bestblock: "000000000000000123456789abcdef123456789abcdef123456789abcdef1234",
  transactions: 8765432,
  txouts: 23456789,
  bogosize: 1765432109,
  hash_serialized_2: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  disk_size: 987654321,
  total_amount: 21000000000.12345678
};

const mockBlockReward = {
  blockreward: 625.0
};

const mockBlock = {
  hash: "000000000000000123456789abcdef123456789abcdef123456789abcdef1234",
  confirmations: 1,
  strippedsize: 1234,
  size: 1456,
  weight: 5678,
  height: 18234567,
  version: 536870912,
  versionHex: "20000000",
  merkleroot: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  tx: [
    {
      txid: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      hash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      version: 1,
      size: 123,
      vsize: 123,
      weight: 456,
      locktime: 0,
      vin: [
        {
          coinbase: "03f7d11200062f503253482f04b8864e5408",
          sequence: 4294967295
        }
      ],
      vout: [
        {
          value: 625.0,
          n: 0,
          scriptPubKey: {
            asm: "OP_DUP OP_HASH160 1234567890abcdef1234567890abcdef12345678 OP_EQUALVERIFY OP_CHECKSIG",
            hex: "76a9141234567890abcdef1234567890abcdef1234567888ac",
            reqSigs: 1,
            type: "pubkeyhash",
            address: "D1234567890ABCDefghijklmnopqrstuvwxyzABC"
          }
        }
      ]
    }
  ],
  time: 1640995200,
  mediantime: 1640994800,
  nonce: 123456789,
  bits: "1a123456",
  difficulty: 123456789.123456,
  chainwork: "0000000000000000000000000000000000000000000000123456789abcdef",
  nTx: 1,
  previousblockhash: "000000000000000fedcba098765432109876543210987654321098765432109",
  pow_algo: "sha256d",
  pow_hash: "000000000000000123456789abcdef123456789abcdef123456789abcdef1234"
};

const mockPeerInfo = [
  {
    id: 1,
    addr: "192.168.1.100:12024",
    addrbind: "192.168.1.1:58432",
    addrlocal: "192.168.1.1:58432",
    services: "000000000000040d",
    relaytxes: true,
    lastsend: 1640995200,
    lastrecv: 1640995201,
    bytessent: 123456,
    bytesrecv: 234567,
    conntime: 1640990000,
    timeoffset: 0,
    pingtime: 0.025,
    minping: 0.025,
    version: 70015,
    subver: "/DigiByte Core:8.22.0/",
    inbound: false,
    addnode: false,
    startingheight: 18234560,
    banscore: 0,
    synced_headers: 18234567,
    synced_blocks: 18234567,
    inflight: [],
    whitelisted: false,
    permissions: [],
    minfeefilter: 0.00000000,
    bytessent_per_msg: {
      addr: 1234,
      block: 12345,
      getdata: 2345,
      headers: 3456,
      inv: 4567,
      ping: 567,
      pong: 678,
      sendheaders: 789,
      tx: 5678,
      verack: 24,
      version: 126
    },
    bytesrecv_per_msg: {
      addr: 2345,
      block: 23456,
      getdata: 3456,
      headers: 4567,
      inv: 5678,
      ping: 678,
      pong: 789,
      sendheaders: 890,
      tx: 6789,
      verack: 24,
      version: 126
    }
  },
  {
    id: 2,
    addr: "10.0.0.50:12024",
    addrbind: "10.0.0.1:45678",
    addrlocal: "10.0.0.1:45678",
    services: "000000000000040d",
    relaytxes: true,
    lastsend: 1640995200,
    lastrecv: 1640995201,
    bytessent: 654321,
    bytesrecv: 765432,
    conntime: 1640990000,
    timeoffset: 0,
    pingtime: 0.035,
    minping: 0.025,
    version: 70015,
    subver: "/DigiByte Core:8.22.0/",
    inbound: true,
    addnode: false,
    startingheight: 18234560,
    banscore: 0,
    synced_headers: 18234567,
    synced_blocks: 18234567,
    inflight: [],
    whitelisted: false,
    permissions: [],
    minfeefilter: 0.00000000,
    bytessent_per_msg: {
      addr: 2345,
      block: 23456,
      getdata: 3456,
      headers: 4567,
      inv: 5678,
      ping: 678,
      pong: 789,
      sendheaders: 890,
      tx: 6789,
      verack: 24,
      version: 126
    },
    bytesrecv_per_msg: {
      addr: 1234,
      block: 12345,
      getdata: 2345,
      headers: 3456,
      inv: 4567,
      ping: 567,
      pong: 678,
      sendheaders: 789,
      tx: 5678,
      verack: 24,
      version: 126
    }
  }
];

const mockRpcErrors = {
  connectionRefused: {
    code: 'ECONNREFUSED',
    message: 'connect ECONNREFUSED 127.0.0.1:14044'
  },
  timeout: {
    code: 'ECONNABORTED',
    message: 'timeout of 30000ms exceeded'
  },
  rpcError: {
    error: {
      code: -1,
      message: 'Method not found'
    }
  },
  invalidResponse: {
    error: {
      code: -32700,
      message: 'Parse error'
    }
  }
};

module.exports = {
  mockBlockchainInfo,
  mockChainTxStats,
  mockTxOutsetInfo,
  mockBlockReward,
  mockBlock,
  mockPeerInfo,
  mockRpcErrors
};