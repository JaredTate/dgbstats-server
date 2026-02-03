# DigiByte Stats Server - Technical Architecture

## Executive Summary

DigiByte Stats Server is a **high-performance Node.js backend** providing real-time blockchain data for the DigiByte Stats web application. The server delivers:

- **Real-Time Data Delivery**: WebSocket broadcasting of new blocks and transactions
- **Comprehensive RPC Interface**: Cached access to 15+ DigiByte node RPC commands
- **Network Monitoring**: Geographic peer node tracking with geolocation enrichment
- **Multi-Layer Caching**: Intelligent caching with TTL management and disk persistence
- **Transaction Lifecycle**: Full tracking from mempool to confirmation

## System Overview

The server acts as a middleware layer between the React frontend and a DigiByte full node, providing optimized data access with caching, rate limiting, and real-time broadcasting.

**Dual Network Support**: The server supports both DigiByte mainnet and testnet, allowing developers and users to interact with either network through separate API endpoints and WebSocket connections.

```
                    DigiByte Stats Server Architecture
                    ════════════════════════════════════

    React Frontend → WebSocket (5002) → Server → RPC → DigiByte Node
         ↓               ↓                ↓         ↓         ↓
    Real-time UI    Broadcast         Express   Cached    Blockchain
    Updates         Messages          REST API  Requests  Data

    Additional Data Sources:
    ├── ZeroMQ (optional) ──── Real-time tx/block notifications
    ├── SQLite Database ────── Peer geolocation & visit analytics
    └── peers.dat Parser ───── Network peer discovery
```

## Active File & Folder Structure

### Directory Organization
```
dgbstats-server/                   # Root directory
│
├── Core Application
│   ├── server.js                  # Main server (3,579 lines)
│   │   ├── HTTP/Express server (port 5001)
│   │   ├── WebSocket server mainnet (port 5002)
│   │   ├── WebSocket server testnet (port 5003)
│   │   ├── Cache management
│   │   ├── Database operations
│   │   └── ZeroMQ integration
│   │
│   ├── rpc.js                     # RPC interface (1,249 lines)
│   │   ├── Express router (/api/*)
│   │   ├── RPC request handling
│   │   ├── Intelligent caching
│   │   ├── Rate limiting
│   │   └── DigiDollar/Oracle endpoints (testnet)
│   │
│   └── config.js                  # Environment configuration
│       └── Development/production paths
│
├── Configuration & Data
│   ├── package.json               # Dependencies & scripts
│   ├── vitest.config.js           # Test framework config
│   ├── nodes.db                   # SQLite database
│   ├── cache-backup.json          # Persistent cache storage
│   └── config.template.js         # Config template
│
├── Utility Scripts
│   ├── blocknotify.sh             # DigiByte node webhook script
│   ├── parse_peers_dat.py         # Python mainnet peer parser
│   ├── parse_testnet_peers.py     # Python testnet peer parser
│   └── check-transactions.js      # Debug utility
│
├── Test Suite
│   ├── tests/
│   │   ├── unit/
│   │   │   ├── rpc.test.js        # RPC unit tests
│   │   │   ├── server-core.test.js # Server logic tests
│   │   │   └── testnet.test.js    # Testnet-specific tests
│   │   │
│   │   ├── integration/
│   │   │   ├── api.test.js        # REST API tests
│   │   │   ├── database.test.js   # SQLite tests
│   │   │   ├── websocket.test.js  # WebSocket tests
│   │   │   └── end-to-end.test.js # Full E2E tests
│   │   │
│   │   ├── fixtures/
│   │   │   ├── mock-blocks.js     # Mock block data
│   │   │   ├── mock-rpc-responses.js # Mock RPC data
│   │   │   └── test-data.js       # Test constants
│   │   │
│   │   └── helpers/
│   │       ├── mock-rpc.js        # RPC mocking
│   │       ├── test-setup.js      # Environment setup
│   │       └── test-utils.js      # Utility functions
│   │
│   └── Legacy Test Files
│       ├── test-confirmed-transactions.js
│       ├── test-mempool.js
│       ├── test-transaction-lifecycle.js
│       └── test-websocket.js
│
├── Documentation
│   ├── README.md                  # Setup guide
│   └── CLAUDE.md                  # AI agent documentation
│
└── node_modules/                  # NPM dependencies
```

## Core Architecture Components

### 1. HTTP Server (`server.js`)

**Purpose**: Express-based REST API server and WebSocket host

**Port Configuration**:
- HTTP Server: Port 5001
- WebSocket Server (Mainnet): Port 5002
- WebSocket Server (Testnet): Port 5003

**Key Responsibilities**:
- Route handling for all API endpoints
- WebSocket connection management
- Periodic data refresh scheduling
- Cache persistence and recovery
- Database operations (SQLite)

### 2. RPC Interface (`rpc.js`)

**Purpose**: Intelligent interface to DigiByte node RPC

**Key Features**:
- MD5-based cache key generation
- Concurrent request limiting (max 4)
- Exponential backoff for rate limiting
- Stale cache fallback on errors
- Timeout management (30s default, 120s heavy)

### 3. WebSocket Server

**Purpose**: Real-time data broadcasting to connected clients

**Message Types**:
| Type | Direction | Purpose |
|------|-----------|---------|
| `recentBlocks` | Server→Client | Initial 240 blocks on connect |
| `newBlock` | Server→Client | Real-time block notification |
| `recentTransactions` | Server→Client | Confirmed transaction cache |
| `transactionConfirmed` | Server→Client | Tx moved to block |
| `mempool` | Server→Client | Mempool stats and transactions |
| `initialData` | Server→Client | Blockchain info bundle (includes deploymentInfo) |
| `geoData` | Server→Client | Geographic peer locations |
| `newTransaction` | Server→Client | New mempool transaction notification |
| `removedTransaction` | Server→Client | Transaction removed from mempool |
| `confirmedTransactions` | Server→Client | Bulk confirmations via ZeroMQ |
| `requestMempool` | Client→Server | Client requests mempool refresh |

## API Endpoints

### Core Blockchain Endpoints

| Endpoint | Method | Purpose | RPC Command | Cache TTL |
|----------|--------|---------|-------------|-----------|
| `/api/getblockchaininfo` | GET | Blockchain state | `getblockchaininfo` | 60s |
| `/api/getlatestblock` | GET | Latest block info | `getbestblockhash`, `getblock` | 1h |
| `/api/getblockreward` | GET | Current block reward | `getblockreward` | 60s |
| `/api/getchaintxstats` | GET | Transaction statistics | `getchaintxstats` | 60s |
| `/api/gettxoutsetinfo` | GET | UTXO set info (expensive) | `gettxoutsetinfo` | 1h |

### Transaction & Mempool Endpoints

| Endpoint | Method | Purpose | RPC Command | Cache TTL |
|----------|--------|---------|-------------|-----------|
| `/api/getmempoolinfo` | GET | Mempool statistics | `getmempoolinfo` | 60s |
| `/api/getrawmempool` | GET | Full mempool txs | `getrawmempool` | 60s |

### Network & Peer Endpoints

| Endpoint | Method | Purpose | Data Source | Cache TTL |
|----------|--------|---------|-------------|-----------|
| `/api/getpeerinfo` | GET | Connected peers + geo | RPC + geoip-lite | 60s |
| `/api/getpeers` | GET | Parsed peers.dat | Python script | 15m |
| `/api/refresh-peers` | POST | Force peer refresh | Cache bypass | - |

### System Management Endpoints

| Endpoint | Method | Purpose | Data Source |
|----------|--------|---------|-------------|
| `/api/blocknotify` | POST | Block notification webhook | DigiByte node |
| `/api/visitstats` | GET | Visit analytics | SQLite |
| `/api/cachestatus` | GET | Cache monitoring | All caches |
| `/api/rpccachestats` | GET | RPC cache stats | RPC cache |
| `/api/refreshcache` | POST | Manual cache refresh | Cache bypass |
| `/health` | GET | Health check | - |

## Testnet Support

The server provides full testnet support with dedicated RPC connections, WebSocket server, and API routes. This allows developers to test applications against the DigiByte testnet without affecting mainnet operations.

### Testnet Configuration

| Component | Configuration |
|-----------|---------------|
| Testnet RPC Port | 14022 |
| Testnet WebSocket Server | Port 5003 |
| Testnet API Base Path | `/api/testnet/*` |

### Testnet API Endpoints

All testnet endpoints mirror the mainnet API structure but are prefixed with `/api/testnet/`:

| Endpoint | Purpose |
|----------|---------|
| `/api/testnet/getblockchaininfo` | Testnet blockchain info |
| `/api/testnet/getblockhash/:height` | Testnet block hash by height |
| `/api/testnet/getblock/:hash` | Testnet block data |
| `/api/testnet/getlatestblock` | Testnet latest block info |
| `/api/testnet/getblockreward` | Testnet current block reward |
| `/api/testnet/getchaintxstats` | Testnet transaction statistics |
| `/api/testnet/gettxoutsetinfo` | Testnet UTXO set info |
| `/api/testnet/getmempoolinfo` | Testnet mempool statistics |
| `/api/testnet/getrawmempool` | Testnet full mempool transactions |
| `/api/testnet/getpeerinfo` | Testnet connected peers with geolocation |
| `/api/testnet/getpeers` | Testnet peer discovery (testnet13/peers.dat) |
| `/api/testnet/blocknotify` | Testnet block notification webhook (POST) |

### DigiDollar/Oracle Endpoints (Testnet Only)

| Endpoint | Purpose |
|----------|---------|
| `/api/testnet/getdigidollarstats` | DigiDollar system statistics |
| `/api/testnet/getoracleprice` | Current oracle price data |
| `/api/testnet/getoracles` | Network-wide oracle information |
| `/api/testnet/getalloracleprices` | Per-oracle price breakdown |
| `/api/testnet/listoracle` | Local oracle status |
| `/api/testnet/getprotectionstatus` | DigiDollar protection system status |

### Testnet WebSocket

The testnet WebSocket server runs on port 5003 and supports the same message types as mainnet:

- `recentBlocks` - Initial testnet blocks on connect (240 blocks)
- `recentTransactions` - Confirmed transaction cache
- `newBlock` - Real-time testnet block notification
- `initialData` - Testnet blockchain info bundle (includes deploymentInfo)
- `mempool` - Testnet mempool stats and transactions
- `geoData` - Testnet peer geolocation data (from testnet13/peers.dat)

## Data Flow Architecture

### Block Notification Flow
```
DigiByte Node (new block mined)
       ↓
blocknotify.sh script executes
       ↓
POST /api/blocknotify { blockhash }
       ↓
Fetch block via RPC (getblock verbose=2)
       ↓
Extract mining info (algo, pool, miner)
       ↓
Update recentBlocks cache (max 240)
       ↓
Process confirmed transactions
       ↓
WebSocket broadcast (type: 'newBlock')
       ↓
All connected clients receive update
```

### Transaction Lifecycle Flow
```
1. MEMPOOL PHASE
   ├─ New tx detected (ZeroMQ or polling)
   ├─ Decoded and added to mempoolCache
   ├─ Broadcast: type: 'newTransaction'
   └─ Tracked in mempoolTransactionHistory (3-min retention)

2. CONFIRMATION PHASE
   ├─ Block mined (blocknotify webhook)
   ├─ Match block txs against mempool
   ├─ Move confirmed txs to recentTransactionsCache
   ├─ Remove from mempoolCache
   └─ Broadcast: type: 'transactionConfirmed'

3. POST-CONFIRMATION
   ├─ Maintained in recentTransactionsCache (max 10)
   ├─ Include confirmation count
   └─ Available via WebSocket 'recentTransactions'
```

### Caching Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DigiByte Node (RPC)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
┌─────────┐          ┌─────────┐          ┌─────────────┐
│   RPC   │          │ ZeroMQ  │          │ blocknotify │
│ Requests│          │ Events  │          │   Webhook   │
└────┬────┘          └────┬────┘          └──────┬──────┘
     │                    │                      │
     └────────────────────┼──────────────────────┘
                          │
          ┌───────────────▼───────────────┐
          │    Cache Layer 1: RPC Cache   │
          │   (NodeCache with smart TTL)  │
          │   - Default: 60 seconds       │
          │   - Blocks: 1 hour            │
          │   - Heavy ops: 1 hour         │
          └───────────────┬───────────────┘
                          │
     ┌────────────────────┼────────────────────┐
     │                    │                    │
     ▼                    ▼                    ▼
┌────────────┐    ┌──────────────┐    ┌──────────────┐
│   Blocks   │    │ Transactions │    │   Mempool    │
│   Cache    │    │    Cache     │    │    Cache     │
│ (240 max)  │    │  (10 max)    │    │  (volatile)  │
└──────┬─────┘    └──────┬───────┘    └──────┬───────┘
       │                 │                   │
       └─────────────────┼───────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   Cache Layer 2: In-Memory    │
         │  (Critical data persistence)  │
         └───────────────┬───────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   Cache Layer 3: Disk         │
         │ (cache-backup.json recovery)  │
         │ - Auto-save: every 60 seconds │
         │ - Auto-load: on server start  │
         │ - Invalidate: data > 24 hours │
         └───────────────┬───────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   Database (nodes.db)         │
         │  - nodes: peer geolocation    │
         │  - visits: request tracking   │
         │  - unique_ips: unique visitors│
         └───────────────────────────────┘
```

## Technology Stack

### Runtime & Framework
```yaml
Runtime:
  - Node.js: 14.x+ (tested with 21.7.2)

Server Framework:
  - Express: 4.18.2

Real-Time Communication:
  - ws: 8.17.0 (WebSocket server)
  - zeromq: 6.4.2 (optional real-time events)

Data Storage:
  - sqlite3: 5.1.7 (peer data, analytics)
  - node-cache: 5.1.2 (in-memory caching)

HTTP Client:
  - axios: 1.6.8 (RPC calls)

Geolocation:
  - geoip-lite: 1.4.10 (IP to location)

Utilities:
  - cors: 2.8.5 (CORS middleware)
  - child_process: 1.0.2 (Python script execution)

Testing:
  - vitest: 1.6.0
  - supertest: 6.3.4
  - concurrently: 8.2.2
```

### External Dependencies
- **DigiByte Node**: Full node with RPC enabled
- **Python 3**: For peers.dat parsing script
- **ZeroMQ** (optional): Real-time event subscriptions

## Configuration

### Environment Variables
```bash
# Mainnet RPC Configuration
DGB_RPC_USER=user           # RPC authentication username
DGB_RPC_PASSWORD=password   # RPC authentication password
DGB_RPC_URL=http://127.0.0.1:14044  # RPC endpoint

# Testnet RPC Configuration
DGB_TESTNET_RPC_URL=http://127.0.0.1:14022  # Testnet RPC endpoint
DGB_TESTNET_RPC_USER=user                    # Testnet RPC username
DGB_TESTNET_RPC_PASSWORD=password            # Testnet RPC password
DGB_TESTNET_WS_PORT=5003                     # Testnet WebSocket port

# Server Configuration
PORT=5001                   # HTTP server port
```

### Server Configuration (`server.js`)
```javascript
const SERVER_CONFIG = {
  port: 5001,
  wsPort: 5002,
  testnetWsPort: 5003,  // Testnet WebSocket
  corsEnabled: true,
  maxRecentBlocks: 240,
  pingInterval: 30000  // WebSocket keepalive
};
```

### RPC Configuration (`rpc.js`)
```javascript
const RPC_CONFIG = {
  timeout: {
    default: 30000,    // 30 seconds
    heavy: 120000      // 2 minutes (gettxoutsetinfo)
  }
};

const RATE_LIMIT = {
  maxConcurrent: 4,    // Max parallel RPC requests
  batchSize: 20,       // Blocks per batch
  batchDelay: 200      // ms between batches
};

const CACHE_CONFIG = {
  default: 60,         // 1 minute
  blocks: 3600,        // 1 hour (immutable)
  heavy: 3600          // 1 hour (expensive ops)
};
```

### ZeroMQ Configuration (Optional)
```javascript
const ZMQ_CONFIG = {
  enabled: true,
  endpoints: {
    rawtx: 'tcp://127.0.0.1:28333',
    hashtx: 'tcp://127.0.0.1:28335',
    rawblock: 'tcp://127.0.0.1:28332',
    hashblock: 'tcp://127.0.0.1:28334'
  }
};
```

## Database Schema

### SQLite Database (`nodes.db`)

#### `nodes` Table
```sql
CREATE TABLE nodes (
  ip TEXT PRIMARY KEY,
  country TEXT,
  city TEXT,
  lat REAL,
  lon REAL
);
```
Purpose: Store geo-located peer node information

#### `visits` Table
```sql
CREATE TABLE visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
Purpose: Track all incoming requests for analytics

#### `unique_ips` Table
```sql
CREATE TABLE unique_ips (
  ip TEXT PRIMARY KEY
);
```
Purpose: Track unique visitor IPs for deduplication

## Server Startup Sequence

```
Phase 0: Load Cached Data
├─ Read cache-backup.json
├─ Validate data freshness (< 24 hours)
└─ Populate in-memory caches

Phase 1: Start Servers
├─ Initialize Express HTTP server (port 5001)
├─ Initialize WebSocket server (port 5002)
└─ Configure CORS and middleware

Phase 2: Load Blockchain Data
├─ Fetch latest 240 blocks
├─ Fetch blockchain info, tx stats, supply
└─ Calculate block reward

Phase 2.5: Initialize Transaction Caches
├─ Load confirmed transactions
├─ Load mempool cache
└─ Initialize transaction history Map

Phase 3: Load Network Data
├─ Execute parse_peers_dat.py
├─ Geolocate IP addresses (geoip-lite)
└─ Populate nodes database

Phase 4: Initialize ZeroMQ (if enabled)
├─ Connect to rawtx endpoint
├─ Connect to rawblock endpoint
└─ Set up message handlers

Phase 5: Schedule Periodic Tasks
├─ Blocks refresh: every 60 seconds
├─ Initial data refresh: every 60 seconds
├─ Confirmed transactions: every 30 seconds
├─ Mempool refresh: every 30 seconds
├─ Peer data refresh: every 10 minutes
└─ Cache persistence: every 60 seconds
```

## Rate Limiting & Performance

### RPC Rate Limiting
```javascript
// Concurrent request limiting
const waitForAvailableSlot = async () => {
  let waitTime = 100;  // Initial backoff
  while (pendingRequests >= RATE_LIMIT.maxConcurrent) {
    await new Promise(r => setTimeout(r, waitTime));
    waitTime = Math.min(waitTime * 2, 1000);  // Cap at 1 second
  }
};
```

### Batch Processing
- Block fetches: 20 blocks per batch
- 200ms delay between batches
- Prevents overwhelming DigiByte node

### Cache Key Generation
```javascript
// MD5-based cache keys for parameter awareness
const getCacheKey = (method, params) => {
  const paramHash = crypto.createHash('md5')
    .update(JSON.stringify(params))
    .digest('hex');
  return `rpc:${method}:${paramHash}`;
};
```

## Error Handling & Resilience

### RPC Error Recovery
```javascript
// Stale cache fallback
try {
  const result = await makeRpcCall(method, params);
  return result;
} catch (error) {
  const staleData = rpcCache.get(cacheKey, true);  // ignoreExpired
  if (staleData) {
    console.log(`Using stale cache for ${method}`);
    return staleData;
  }
  throw error;
}
```

### gettxoutsetinfo Fallback
```javascript
// Return estimated data on timeout (expected for this expensive call)
if (error.code === 'ETIMEDOUT' && method === 'gettxoutsetinfo') {
  return {
    total_amount: estimatedSupply,
    txouts: estimatedUTXOs,
    _estimated: true
  };
}
```

### WebSocket Error Isolation
- Per-client error handling
- Errors don't affect other clients
- Automatic cleanup on disconnect

### ZeroMQ Graceful Degradation
- Falls back to polling if ZeroMQ unavailable
- Doesn't block server startup
- Retry logic for reconnection

## Testing Architecture

### Test Framework
```yaml
Framework: Vitest 1.6.0
Coverage Provider: V8
HTTP Testing: Supertest 6.3.4

Coverage Targets:
  - Lines: 90%
  - Functions: 90%
  - Statements: 90%
  - Branches: 85%
```

### Test Commands
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Generate coverage report
npm run test:unit     # Unit tests only
npm run test:integration # Integration tests only
```

### Test Organization
```
tests/
├── unit/             # Isolated function tests
│   ├── rpc.test.js
│   └── server-core.test.js
│
├── integration/      # Component interaction tests
│   ├── api.test.js
│   ├── database.test.js
│   ├── websocket.test.js
│   └── end-to-end.test.js
│
├── fixtures/         # Test data
│   ├── mock-blocks.js
│   ├── mock-rpc-responses.js
│   └── test-data.js
│
└── helpers/          # Test utilities
    ├── mock-rpc.js
    ├── test-setup.js
    └── test-utils.js
```

## Deployment

### System Requirements
- Node.js 14.x or higher
- DigiByte node with RPC enabled
- Python 3 (for peers.dat parsing)
- SQLite3
- ~512MB RAM minimum
- ZeroMQ (optional, for real-time events)

### DigiByte Node Configuration
```ini
# Required in digibyte.conf
server=1
rpcuser=your_username
rpcpassword=your_password
rpcallowip=127.0.0.1
txindex=1  # Required for full transaction lookup

# Optional: Block notifications
blocknotify=/path/to/blocknotify.sh %s

# Optional: ZeroMQ
zmqpubrawtx=tcp://127.0.0.1:28333
zmqpubhashblock=tcp://127.0.0.1:28334
zmqpubrawblock=tcp://127.0.0.1:28332
zmqpubhashtx=tcp://127.0.0.1:28335
```

### Running the Server
```bash
# Development
node server.js

# Production (with process manager)
pm2 start server.js --name dgbstats-server

# With environment variables
DGB_RPC_USER=user DGB_RPC_PASSWORD=pass node server.js
```

## Design Patterns

### Architectural Patterns
1. **Multi-Tier Caching**: RPC → In-Memory → Disk persistence
2. **Event-Driven**: WebSocket broadcasting, ZeroMQ subscriptions
3. **Rate Limiting**: Exponential backoff, concurrent request limits
4. **Graceful Degradation**: Stale cache fallback, estimated data

### Code Patterns
1. **Async/Await**: Throughout for RPC and database operations
2. **Error Boundaries**: Per-request isolation, no cascade failures
3. **Factory Functions**: Cache key generation, transaction processing
4. **Observer Pattern**: WebSocket client management

## Architecture Summary

### Key Statistics
- **Core Files**: 3 (server.js ~3,579 lines, rpc.js ~1,249 lines, config.js)
- **API Endpoints**: 34 REST endpoints (16 mainnet, 12 testnet, 6 DigiDollar/Oracle)
- **WebSocket Servers**: 2 (mainnet port 5002, testnet port 5003)
- **WebSocket Message Types**: 10 server-to-client, 1 client-to-server
- **Database Tables**: 3 (nodes, visits, unique_ips)
- **Test Files**: 7 (3 unit, 4 integration)
- **Test Cases**: 147 active tests with 95%+ coverage
- **Dependencies**: 13 production packages

### Network Support
- **Mainnet**: Full support with RPC (port 14044), WebSocket (port 5002)
- **Testnet**: Full support with RPC (port 14022), WebSocket (port 5003)
- **Peer Discovery**: Separate peers.dat parsing for each network

### Performance Characteristics
- Max concurrent RPC requests: 4
- Default cache TTL: 60 seconds
- Block cache TTL: 1 hour
- Recent blocks maintained: 240
- Confirmed transactions cached: 10
- WebSocket ping interval: 30 seconds
- Cache persistence interval: 60 seconds
- Peer data refresh: 10 minutes

### Reliability Features
- Stale cache fallback on RPC errors
- Estimated data for expensive operations
- Per-client WebSocket error isolation
- ZeroMQ fallback to polling
- Automatic cache recovery on restart
- Testnet isolation from mainnet data

---

*Architecture Document v1.1*
*Last Updated: 2026-02-02*
*DigiByte Stats Server - Real-Time Blockchain Data Provider*
