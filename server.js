/**
 * DigiByte Stats Server - Main Application Entry Point
 * 
 * This is the primary server application that provides real-time DigiByte blockchain
 * statistics and network monitoring through both REST API and WebSocket connections.
 * 
 * Key Features:
 * - Real-time block notifications via WebSocket
 * - Comprehensive blockchain statistics API
 * - Peer network monitoring with geolocation
 * - Multi-layer caching for optimal performance
 * - Automatic data persistence and recovery
 * - Visit tracking and analytics
 * 
 * @author DigiByte Stats Server
 * @version 2.0.0
 */

// ============================================================================
// DEPENDENCIES
// ============================================================================

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const geoip = require('geoip-lite');
const NodeCache = require('node-cache');
const sqlite3 = require('sqlite3').verbose();
const { exec } = require('child_process');
const path = require('path');
const axios = require('axios');
const fs = require('fs').promises;
const crypto = require('crypto');
const zmq = require('zeromq');

// Import RPC functionality from dedicated module
const {
  router: rpcRoutes,
  sendRpcRequest,
  getTransactionData,
  getAlgoName,
  getBlocksByTimeRange
} = require('./rpc');

// Load application configuration
const config = require('./config.js');

// ============================================================================
// SERVER CONFIGURATION
// ============================================================================

const SERVER_CONFIG = {
  port: process.env.PORT || 5001,
  wsPort: 5002,
  corsEnabled: true,
  maxRecentBlocks: 240,
  pingInterval: 30000  // 30 seconds WebSocket ping
};

// ============================================================================
// ZEROMQ CONFIGURATION
// ============================================================================

const ZMQ_CONFIG = {
  enabled: true,  // Set to false to disable ZeroMQ
  endpoints: {
    rawtx: 'tcp://127.0.0.1:28333',      // Raw transaction data
    hashtx: 'tcp://127.0.0.1:28335',     // Transaction hashes
    rawblock: 'tcp://127.0.0.1:28332',   // Raw block data
    hashblock: 'tcp://127.0.0.1:28334'   // Block hashes
  }
};

// ============================================================================
// EXPRESS APPLICATION SETUP
// ============================================================================

const app = express();

// Configure middleware
app.use(cors());
app.use(express.json());

// Mount RPC routes under /api prefix
app.use('/api', rpcRoutes);

// ============================================================================
// WEBSOCKET SERVER SETUP
// ============================================================================

/**
 * WebSocket server for real-time blockchain updates
 * Provides live block notifications and cached data delivery
 */
const wss = new WebSocket.Server({ port: SERVER_CONFIG.wsPort });

// Track connected clients for broadcasting
let connectedClients = 0;

// ============================================================================
// DATA STORAGE AND CACHING
// ============================================================================

/**
 * In-memory storage for recent blocks
 * Maintains the latest N blocks for immediate WebSocket delivery
 */
const recentBlocks = [];

/**
 * Multi-tier caching system:
 * - NodeCache: Short-term cache with automatic expiration
 * - In-memory: Critical data that persists across cache evictions
 * - Disk: Backup persistence for server restarts
 */
const cache = new NodeCache({ stdTTL: 60 });
const peerCache = new NodeCache({ stdTTL: 600 }); // 10-minute peer cache

/**
 * Persistent storage for critical blockchain data
 * Ensures data availability even when RPC calls fail
 */
let inMemoryInitialData = null;

// ============================================================================
// DATABASE SETUP
// ============================================================================

/**
 * SQLite database for persistent data storage
 * Tracks node information, visit statistics, and unique visitors
 */
const db = new sqlite3.Database('nodes.db');

// Initialize database schema
initializeDatabase();

function initializeDatabase() {
  // Node geolocation data table
  db.run(`CREATE TABLE IF NOT EXISTS nodes (
    ip TEXT PRIMARY KEY,
    country TEXT,
    city TEXT,
    lat REAL,
    lon REAL
  )`);

  // Visit tracking table
  db.run(`CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Unique visitor tracking
  db.run(`CREATE TABLE IF NOT EXISTS unique_ips (
    ip TEXT PRIMARY KEY
  )`);
}

// ============================================================================
// GLOBAL STATE MANAGEMENT
// ============================================================================

/**
 * Global state variables for tracking network nodes and connections
 */
let uniqueNodes = [];

// ============================================================================
// WEBSOCKET CONNECTION MANAGEMENT
// ============================================================================

/**
 * Handle new WebSocket connections
 * 
 * On connection, immediately sends:
 * 1. Recent blocks for chart display
 * 2. Initial blockchain data for dashboard
 * 3. Geo-located peer data for network map
 */
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  connectedClients++;
  console.log(`Active WebSocket connections: ${connectedClients}`);

  // Send recent blocks immediately
  console.log(`Sending ${recentBlocks.length} recent blocks to new client`);
  ws.send(JSON.stringify({ 
    type: 'recentBlocks', 
    data: recentBlocks 
  }));
  
  // Send recent confirmed transactions
  console.log('📝 Initiating confirmed transactions fetch for new client...');
  sendRecentTransactionsToClient(ws);

  // Send cached initial data
  sendInitialDataToClient(ws);
  
  // Send geo-located peer data
  sendGeoDataToClient(ws);
  
  // Auto-send mempool data for TxsPage
  sendMempoolDataToClient(ws);

  // Handle incoming messages from client
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.type === 'requestMempool') {
        console.log('Client requested mempool data');
        await sendMempoolDataToClient(ws);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });

  // Setup connection heartbeat
  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, SERVER_CONFIG.pingInterval);

  // Handle client disconnection
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    connectedClients--;
    clearInterval(pingTimer);
  });

  // Handle connection errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    connectedClients--;
    clearInterval(pingTimer);
  });
});

/**
 * Send initial blockchain data to a specific client
 * Uses in-memory cache first, falls back to NodeCache
 * 
 * @param {WebSocket} ws - WebSocket connection
 */
function sendInitialDataToClient(ws) {
  if (inMemoryInitialData) {
    ws.send(JSON.stringify({ 
      type: 'initialData', 
      data: inMemoryInitialData 
    }));
  } else {
    const cached = cache.get('initialData');
    if (cached) {
      ws.send(JSON.stringify({ 
        type: 'initialData', 
        data: cached 
      }));
    }
  }
}

/**
 * Send geo-located peer data to a specific client
 * Prioritizes cached data for performance
 * 
 * @param {WebSocket} ws - WebSocket connection
 */
function sendGeoDataToClient(ws) {
  const cachedGeoNodes = peerCache.get('geoNodes');
  if (cachedGeoNodes) {
    ws.send(JSON.stringify({ 
      type: 'geoData', 
      data: cachedGeoNodes 
    }));
  } else if (uniqueNodes.length > 0) {
    ws.send(JSON.stringify({ 
      type: 'geoData', 
      data: uniqueNodes 
    }));
  }
}

/**
 * Fetch and send mempool data to a specific client
 * @param {WebSocket} ws - WebSocket connection
 */
async function sendMempoolDataToClient(ws) {
  try {
    // Get mempool statistics
    const mempoolInfo = await sendRpcRequest('getmempoolinfo');
    
    // Get raw mempool transactions (verbose mode)
    const rawMempool = await sendRpcRequest('getrawmempool', [true]);
    
    // Process transactions
    const transactions = [];
    const txIds = Object.keys(rawMempool || {});
    let totalFee = 0;
    const feeDistribution = {
      '0-10': 0,
      '10-50': 0,
      '50-100': 0,
      '100-500': 0,
      '500+': 0
    };
    
    // Limit to 50 transactions for performance to avoid overwhelming the frontend
    for (const txid of txIds.slice(0, 50)) {
      const txData = rawMempool[txid];
      if (!txData) continue;
      
      try {
        // Use the enhanced transaction data fetcher with proper fallback handling
        const enhancedTxData = await getTransactionData(txid);
        
        // Calculate fee rate (satoshis per byte)
        const feeRate = txData.fee ? Math.round((txData.fee * 100000000) / (txData.vsize || txData.size || 1)) : 0;
        
        // Update fee distribution
        if (feeRate < 10) feeDistribution['0-10']++;
        else if (feeRate < 50) feeDistribution['10-50']++;
        else if (feeRate < 100) feeDistribution['50-100']++;
        else if (feeRate < 500) feeDistribution['100-500']++;
        else feeDistribution['500+']++;
        
        // Determine priority based on fee rate
        let priority = 'low';
        if (feeRate > 100) priority = 'high';
        else if (feeRate > 50) priority = 'medium';
        
        // Calculate transaction value
        let totalValue = 0;
        let inputs = [];
        let outputs = [];
        
        if (enhancedTxData) {
          // For gettransaction response
          if (enhancedTxData.details && Array.isArray(enhancedTxData.details)) {
            totalValue = enhancedTxData.amount || 0;
            outputs = enhancedTxData.details.map(detail => ({
              address: detail.address || '',
              amount: detail.amount || 0,
              category: detail.category || ''
            }));
          }
          // For getrawtransaction response
          else if (enhancedTxData.vout && Array.isArray(enhancedTxData.vout)) {
            for (const output of enhancedTxData.vout) {
              if (output.value) {
                totalValue += output.value;
                outputs.push({
                  address: output.scriptPubKey?.address || '',
                  amount: output.value,
                  type: output.scriptPubKey?.type || ''
                });
              }
            }
            
            // Process inputs if available
            if (enhancedTxData.vin && Array.isArray(enhancedTxData.vin)) {
              inputs = enhancedTxData.vin.map(input => ({
                txid: input.txid || '',
                vout: input.vout || 0,
                address: '', // Would need previous tx data
                amount: 0    // Would need previous tx data
              }));
            }
          }
        }
        
        totalFee += txData.fee || 0;
        
        transactions.push({
          txid: txid,
          size: txData.vsize || txData.size || 0,
          vsize: txData.vsize || txData.size || 0,
          fee: txData.fee || 0,
          value: Math.abs(totalValue), // Use absolute value
          time: txData.time || Math.floor(Date.now() / 1000),
          inputs: inputs,
          outputs: outputs,
          fee_rate: feeRate,
          priority: priority,
          confirmations: 0,
          descendantcount: txData.descendantcount || 0,
          descendantsize: txData.descendantsize || 0,
          ancestorcount: txData.ancestorcount || 0,
          ancestorsize: txData.ancestorsize || 0
        });
        
      } catch (txError) {
        console.error(`Error processing transaction ${txid}:`, txError.message);
        console.error(`This error may indicate:
1. Transaction was removed from mempool during processing
2. DigiByte node requires txindex=1 for confirmed transactions
3. Network connectivity issues with RPC server`);
        
        // Add basic transaction data even if enhanced data fails
        const feeRate = txData.fee ? Math.round((txData.fee * 100000000) / (txData.vsize || txData.size || 1)) : 0;
        let priority = 'low';
        if (feeRate > 100) priority = 'high';
        else if (feeRate > 50) priority = 'medium';
        
        transactions.push({
          txid: txid,
          size: txData.vsize || txData.size || 0,
          vsize: txData.vsize || txData.size || 0,
          fee: txData.fee || 0,
          value: 0,
          time: txData.time || Math.floor(Date.now() / 1000),
          inputs: [],
          outputs: [],
          fee_rate: feeRate,
          priority: priority,
          confirmations: 0,
          descendantcount: txData.descendantcount || 0,
          descendantsize: txData.descendantsize || 0,
          ancestorcount: txData.ancestorcount || 0,
          ancestorsize: txData.ancestorsize || 0
        });
      }
    }
    
    // Sort by time descending (newest first)
    transactions.sort((a, b) => b.time - a.time);
    
    // Calculate average fee
    const avgFee = transactions.length > 0 
      ? transactions.reduce((sum, tx) => sum + tx.fee, 0) / transactions.length
      : 0;
    
    // Send enhanced data to client
    ws.send(JSON.stringify({
      type: 'mempool',
      data: {
        stats: {
          size: mempoolInfo?.size || 0,
          bytes: mempoolInfo?.bytes || 0,
          usage: mempoolInfo?.usage || 0,
          maxmempool: mempoolInfo?.maxmempool || 300000000,
          minfee: mempoolInfo?.mempoolminfee || mempoolInfo?.minrelaytxfee || 0.00001,
          avgfee: avgFee,
          totalfee: totalFee,
          feeDistribution: feeDistribution
        },
        transactions: transactions
      }
    }));
    
  } catch (error) {
    console.error('Error fetching mempool data:', error);
    // Send empty data on error
    ws.send(JSON.stringify({
      type: 'mempool',
      data: {
        stats: {
          size: 0,
          bytes: 0,
          usage: 0,
          maxmempool: 300000000,
          minfee: 0,
          avgfee: 0,
          totalfee: 0,
          feeDistribution: {
            '0-10': 0,
            '10-50': 0,
            '50-100': 0,
            '100-500': 0,
            '500+': 0
          }
        },
        transactions: []
      }
    }));
  }
}

// ============================================================================
// COINBASE DATA PROCESSING
// ============================================================================

/**
 * Decode coinbase transaction data to extract mining pool information
 * 
 * Uses multiple regex patterns to identify common pool identifier formats
 * found in DigiByte mining pool coinbase transactions.
 * 
 * @param {string} coinbaseHex - Hex-encoded coinbase data
 * @returns {object} Decoded pool information
 */
function decodeCoinbaseData(coinbaseHex) {
  try {
    const buffer = Buffer.from(coinbaseHex, 'hex');
    const text = buffer.toString('utf8');

    // Common mining pool identifier patterns
    const poolPatterns = [
      /\/(.*?)\//,                    // Format: /PoolName/
      /\[(.*?)\]/,                    // Format: [PoolName]
      /@(.*?)@/,                      // Format: @PoolName@
      /pool\.(.*?)\.com/,             // Format: pool.Name.com
      /(.*?)pool/i,                   // Format: Somethingpool
      /^(?:[\x00-\xFF]*?)([\x20-\x7F]{3,})/ // Fallback: readable ASCII
    ];

    let poolIdentifier = 'Unknown';
    
    // Try each pattern until we find a match
    for (const pattern of poolPatterns) {
      const match = text.match(pattern);
      if (match && match[1] && match[1].length >= 3) {
        poolIdentifier = match[1].trim();
        break;
      }
    }

    return { 
      poolIdentifier, 
      rawText: text.substring(0, 100) // Limit raw text length
    };
  } catch (error) {
    console.error('Error decoding coinbase data:', error);
    return { 
      poolIdentifier: 'Unknown', 
      rawText: '' 
    };
  }
}

// ============================================================================
// BLOCKCHAIN DATA FETCHING
// ============================================================================

/**
 * Fetch and maintain the most recent blocks for real-time display
 * 
 * This function ensures we always have the latest blocks available for
 * immediate WebSocket delivery to new clients. It intelligently requests
 * more blocks than needed to account for potential RPC failures.
 * 
 * @returns {Promise<Array>} Array of recent block objects
 */
async function fetchLatestBlocks() {
  try {
    console.log('Refreshing recent blocks cache...');
    
    // Get current blockchain tip
    const blockchainInfo = await sendRpcRequest('getblockchaininfo');
    if (!blockchainInfo) {
      throw new Error('Unable to fetch blockchain info');
    }
    
    const latestBlockHeight = blockchainInfo.blocks;
    console.log(`Current blockchain height: ${latestBlockHeight}`);

    // Clear existing blocks to prevent duplicates
    recentBlocks.length = 0;
    
    // Request more blocks than needed (10% buffer)
    const requestedBlocks = Math.ceil(SERVER_CONFIG.maxRecentBlocks * 1.1);
    
    // Fetch blocks using optimized batch processing
    console.log(`Requesting ${requestedBlocks} blocks from height ${latestBlockHeight}`);
    const fetchedBlocks = await getBlocksByTimeRange(0, latestBlockHeight, requestedBlocks);
    
    // Add fetched blocks to our cache
    recentBlocks.push(...fetchedBlocks);
    
    // If we don't have enough blocks, fetch additional ones individually
    await fillRemainingBlocks(latestBlockHeight);

    // Sort and limit to exact count
    recentBlocks.sort((a, b) => b.height - a.height);
    recentBlocks.splice(SERVER_CONFIG.maxRecentBlocks);
    
    console.log(`Block cache updated: ${recentBlocks.length} blocks loaded`);
    console.log(`Height range: ${recentBlocks[0]?.height || 'none'} to ${recentBlocks[recentBlocks.length-1]?.height || 'none'}`);
    
    return recentBlocks;
  } catch (error) {
    console.error('Error fetching latest blocks:', error);
    return [];
  }
}

/**
 * Fill remaining block slots when batch fetching doesn't provide enough blocks
 * 
 * @param {number} latestHeight - Current blockchain height
 */
async function fillRemainingBlocks(latestHeight) {
  if (recentBlocks.length >= SERVER_CONFIG.maxRecentBlocks || latestHeight < SERVER_CONFIG.maxRecentBlocks) {
    return; // Already have enough blocks or blockchain is too short
  }

  console.log(`Need ${SERVER_CONFIG.maxRecentBlocks - recentBlocks.length} more blocks, fetching individually...`);
  
  // Find the lowest height we already have
  const lowestHeight = recentBlocks.reduce((min, block) => 
    Math.min(min, block.height), Number.MAX_SAFE_INTEGER);
  
  // Fetch older blocks one by one
  let currentHeight = lowestHeight - 1;
  while (recentBlocks.length < SERVER_CONFIG.maxRecentBlocks && currentHeight > 0) {
    try {
      const blockData = await fetchSingleBlockForCache(currentHeight);
      if (blockData) {
        recentBlocks.push(blockData);
      }
    } catch (error) {
      console.error(`Error fetching block at height ${currentHeight}:`, error.message);
    }
    
    currentHeight--;
  }
}

/**
 * Fetch and process a single block for the cache
 * 
 * @param {number} height - Block height to fetch
 * @returns {Promise<object|null>} Processed block data or null
 */
async function fetchSingleBlockForCache(height) {
  console.log(`Fetching individual block at height ${height}`);
  
  // Get block hash
  const hash = await sendRpcRequest('getblockhash', [height]);
  if (!hash) return null;
  
  // Get full block data
  const block = await sendRpcRequest('getblock', [hash, 2]);
  if (!block || !block.tx || block.tx.length === 0) return null;
  
  // Process mining information
  const coinbaseTx = block.tx[0];
  const addressOutput = coinbaseTx.vout?.find(output => output?.scriptPubKey?.address);
  const minerAddress = addressOutput ? addressOutput.scriptPubKey.address : '';
  
  const { poolIdentifier } = decodeCoinbaseData(coinbaseTx.vin[0].coinbase);
  const taprootSignaling = (block.version & (1 << 2)) !== 0;
  
  return {
    height: block.height,
    hash: block.hash,
    algo: getAlgoName(block.pow_algo),
    txCount: block.nTx,
    difficulty: block.difficulty,
    timestamp: block.time,
    minedTo: minerAddress,
    minerAddress,
    poolIdentifier,
    taprootSignaling,
    version: block.version
  };
}

// ============================================================================
// BLOCK NOTIFICATION HANDLING
// ============================================================================

/**
 * Handle new block notifications from the DigiByte daemon
 * 
 * This endpoint is called by the blocknotify script when a new block
 * is found. It processes the block and broadcasts it to all connected
 * WebSocket clients for real-time updates.
 */
app.post('/api/blocknotify', async (req, res) => {
  try {
    // Validate request
    if (!req.body?.blockhash) {
      throw new Error('Missing blockhash in request body');
    }

    const blockHash = req.body.blockhash;
    console.log(`New block notification: ${blockHash}`);

    // Fetch complete block data
    const fullBlock = await sendRpcRequest('getblock', [blockHash, 2]);
    if (!fullBlock || !fullBlock.tx?.[0]) {
      console.log('Invalid block data received, skipping notification');
      return res.sendStatus(200);
    }

    // Extract mining information
    const coinbaseTx = fullBlock.tx[0];
    const addressOutput = coinbaseTx.vout?.find(output => output?.scriptPubKey?.address);
    const minerAddress = addressOutput ? addressOutput.scriptPubKey.address : '';

    const { poolIdentifier } = decodeCoinbaseData(coinbaseTx.vin[0].coinbase);
    const taprootSignaling = (fullBlock.version & (1 << 2)) !== 0;

    // Create standardized block object
    const newBlock = {
      height: fullBlock.height,
      hash: fullBlock.hash,
      algo: getAlgoName(fullBlock.pow_algo),
      txCount: fullBlock.nTx,
      difficulty: fullBlock.difficulty,
      timestamp: fullBlock.time,
      minedTo: minerAddress,
      minerAddress,
      poolIdentifier,
      taprootSignaling,
      version: fullBlock.version
    };

    // Update recent blocks cache
    updateRecentBlocksCache(newBlock);

    // Broadcast to all connected WebSocket clients
    broadcastNewBlock(newBlock);

    console.log(`Block ${newBlock.height} processed and broadcast to ${connectedClients} clients`);
    res.sendStatus(200);
    
  } catch (error) {
    console.error('Block notification processing error:', error);
    res.sendStatus(500);
  }
});

/**
 * Update the recent blocks cache with a new block
 * 
 * @param {object} newBlock - New block data
 */
function updateRecentBlocksCache(newBlock) {
  // Add to front of array
  recentBlocks.unshift(newBlock);
  
  // Sort by height to ensure proper ordering
  recentBlocks.sort((a, b) => b.height - a.height);
  
  // Maintain maximum size
  recentBlocks.splice(SERVER_CONFIG.maxRecentBlocks);
}

/**
 * Broadcast new block to all connected WebSocket clients
 * 
 * @param {object} newBlock - New block data
 */
function broadcastNewBlock(newBlock) {
  const message = JSON.stringify({ 
    type: 'newBlock', 
    data: newBlock 
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error broadcasting to WebSocket client:', error);
      }
    }
  });

  console.log(`New block ${newBlock.height} broadcast to ${wss.clients.size} clients`);
}

// ============================================================================
// INITIAL DATA MANAGEMENT
// ============================================================================

/**
 * Fetch and cache essential blockchain data for dashboard display
 * 
 * This function gathers critical blockchain metrics that rarely change
 * and caches them for quick access. It gracefully handles failures of
 * expensive operations like gettxoutsetinfo.
 * 
 * @returns {Promise<object>} Initial data package
 */
async function fetchInitialData() {
  try {
    console.log('Fetching initial blockchain data...');
    
    // Get core blockchain information (rarely fails)
    const blockchainInfo = await sendRpcRequest('getblockchaininfo');
    if (!blockchainInfo) {
      throw new Error('Critical: Unable to fetch basic blockchain info');
    }
    
    // Get transaction statistics
    const chainTxStats = await sendRpcRequest('getchaintxstats');
    
    // Get current block reward
    const blockRewardResponse = await sendRpcRequest('getblockreward');
    const blockReward = parseFloat(blockRewardResponse?.blockreward || '0');
    
    // Attempt to get UTXO set info (may timeout)
    let txOutsetInfo = await fetchUTXOSetInfo(blockchainInfo);
    
    // Prepare complete data package
    const initialData = {
      blockchainInfo,
      chainTxStats,
      txOutsetInfo,
      blockReward
    };

    // Cache in multiple locations for redundancy
    cache.set('initialData', initialData);
    inMemoryInitialData = initialData;

    // Broadcast to existing WebSocket clients
    broadcastInitialData(initialData);
    
    console.log('Initial data fetch and cache update complete');
    return initialData;
    
  } catch (error) {
    console.error('Error fetching initial data:', error);
    
    // Return existing in-memory data rather than failing completely
    return inMemoryInitialData;
  }
}

/**
 * Fetch UTXO set information with fallback handling
 * 
 * @param {object} blockchainInfo - Current blockchain info
 * @returns {Promise<object>} UTXO set data
 */
async function fetchUTXOSetInfo(blockchainInfo) {
  try {
    console.log('Fetching UTXO set info (may take time)...');
    const utxoData = await sendRpcRequest('gettxoutsetinfo');
    console.log('Successfully fetched UTXO set info');
    return utxoData;
    
  } catch (error) {
    console.error('Failed to fetch fresh UTXO data:', error.message);
    
    // Try to get cached version
    const { rpcCache } = require('./rpc');
    const cacheKey = `rpc:gettxoutsetinfo:${crypto.createHash('md5').update(JSON.stringify([])).digest('hex')}`;
    let cachedData = rpcCache?.get(cacheKey, true); // Get even if expired
    
    if (cachedData) {
      console.log('Using cached UTXO data');
      if (cachedData._estimated && blockchainInfo) {
        cachedData.height = blockchainInfo.blocks;
      }
      return cachedData;
    }
    
    // Create placeholder data
    console.log('Creating placeholder UTXO data');
    return {
      height: blockchainInfo.blocks,
      bestblock: "",
      transactions: 0,
      txouts: 0, 
      bogosize: 0,
      hash_serialized_2: "",
      disk_size: 0,
      total_amount: 0,
      _estimated: true
    };
  }
}

/**
 * Broadcast initial data to all connected WebSocket clients
 * 
 * @param {object} initialData - Initial blockchain data
 */
function broadcastInitialData(initialData) {
  const message = JSON.stringify({ 
    type: 'initialData', 
    data: initialData 
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error broadcasting initial data to client:', error);
      }
    }
  });
}

// ============================================================================
// PEER NETWORK MONITORING
// ============================================================================

/**
 * Endpoint to fetch and process peer network data
 * 
 * This endpoint parses the peers.dat file to extract unique IP addresses,
 * enhances them with geolocation data, and caches the results for performance.
 * The data is used for the network visualization map.
 */
app.get('/api/getpeers', (req, res) => {
  // Check for cached peer data first
  const cachedPeers = peerCache.get('peerData');
  if (cachedPeers) {
    const timeRemaining = Math.floor((peerCache.getTtl('peerData') - Date.now()) / 1000);
    console.log(`Serving cached peer data (expires in ${timeRemaining}s)`);
    return res.json(cachedPeers);
  }

  console.log('Cache miss - fetching fresh peer data...');
  
  // Execute Python script to parse peers.dat file
  const pythonScriptPath = path.join(__dirname, 'parse_peers_dat.py');
  exec(`python3 ${pythonScriptPath}`, { timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Python script execution error: ${error.message}`);
      return res.status(500).json({ error: 'Error executing peer analysis script' });
    }
    
    if (stderr) {
      console.error(`Python script stderr: ${stderr}`);
    }

    // Parse and validate script output
    const peerData = parsePeerScriptOutput(stdout, res);
    if (!peerData) return; // Response already sent by parser
    
    // Process peer data with geolocation
    processPeerGeolocation(peerData, res);
  });
});

/**
 * Parse and validate output from the Python peer analysis script
 * 
 * @param {string} stdout - Script output
 * @param {object} res - Express response object
 * @returns {object|null} Parsed peer data or null if invalid
 */
function parsePeerScriptOutput(stdout, res) {
  try {
    if (!stdout || stdout.trim() === '') {
      return res.status(500).json({ error: 'Empty response from peer analysis script' });
    }
    
    const output = JSON.parse(stdout);
    
    // Validate expected structure
    if (!output.uniqueIPv4Addresses || !output.uniqueIPv6Addresses) {
      return res.status(500).json({ error: 'Invalid peer data format from script' });
    }

    const ipv4Count = output.uniqueIPv4Addresses.length;
    const ipv6Count = output.uniqueIPv6Addresses.length;
    console.log(`Parsed peer data: ${ipv4Count} IPv4, ${ipv6Count} IPv6 addresses`);
    
    return output;
    
  } catch (parseError) {
    console.error(`Error parsing peer script output: ${parseError.message}`);
    console.error('Raw output:', stdout);
    return res.status(500).json({ error: 'Error parsing peer analysis results' });
  }
}

/**
 * Process peer IP addresses with geolocation data and update database
 * 
 * @param {object} peerData - Parsed peer data from script
 * @param {object} res - Express response object
 */
function processPeerGeolocation(peerData, res) {
  const { uniqueIPv4Addresses, uniqueIPv6Addresses } = peerData;
  
  // Combine and geo-locate all IP addresses
  const allIPs = [...uniqueIPv4Addresses, ...uniqueIPv6Addresses];
  const geoData = allIPs.map((ip) => {
    const geoInfo = geoip.lookup(ip);
    return {
      ip,
      country: geoInfo?.country || 'Unknown',
      city: geoInfo?.city || 'Unknown',
      lat: geoInfo?.ll?.[0] || 0,
      lon: geoInfo?.ll?.[1] || 0
    };
  });
  
  console.log(`Geo-located ${geoData.length} IP addresses`);
  
  // Update database with new peer data
  updatePeerDatabase(geoData, peerData, res);
}

/**
 * Update SQLite database with new peer information
 * 
 * @param {Array} geoData - Geo-located peer data
 * @param {object} peerData - Original peer data
 * @param {object} res - Express response object
 */
function updatePeerDatabase(geoData, peerData, res) {
  db.serialize(() => {
    // Clear existing nodes
    db.run('DELETE FROM nodes', (deleteError) => {
      if (deleteError) {
        console.error('Error clearing nodes table:', deleteError);
        return res.status(500).json({ error: 'Database error during node cleanup' });
      }

      // Insert new node data
      const insertStatement = db.prepare(`
        INSERT INTO nodes (ip, country, city, lat, lon)
        VALUES (?, ?, ?, ?, ?)
      `);

      geoData.forEach((node) => {
        insertStatement.run(node.ip, node.country, node.city, node.lat, node.lon);
      });

      insertStatement.finalize((finalizeError) => {
        if (finalizeError) {
          console.error('Error inserting node data:', finalizeError);
          return res.status(500).json({ error: 'Database error during node insertion' });
        }

        // Retrieve and cache updated data
        finalizePeerDataUpdate(peerData, res);
      });
    });
  });
}

/**
 * Finalize peer data update by caching results and broadcasting
 * 
 * @param {object} peerData - Original peer data
 * @param {object} res - Express response object
 */
function finalizePeerDataUpdate(peerData, res) {
  db.all('SELECT * FROM nodes', (selectError, rows) => {
    if (selectError) {
      console.error('Error retrieving updated nodes:', selectError);
      return res.status(500).json({ error: 'Database error during node retrieval' });
    }

    console.log(`Updated database with ${rows.length} peer nodes`);
    uniqueNodes = rows;

    // Cache both raw peer data and geo-processed nodes
    peerCache.set('peerData', peerData, 600);    // 10 minutes
    peerCache.set('geoNodes', uniqueNodes, 600); // 10 minutes
    console.log('Peer data cached for 10 minutes');

    // Broadcast updated geo data to WebSocket clients
    broadcastGeoData(uniqueNodes);

    // Send response
    res.json(peerData);
  });
}

/**
 * Broadcast geo-located peer data to all WebSocket clients
 * 
 * @param {Array} geoNodes - Geo-located node data
 */
function broadcastGeoData(geoNodes) {
  const message = JSON.stringify({ 
    type: 'geoData', 
    data: geoNodes 
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error broadcasting geo data to client:', error);
      }
    }
  });
}

/**
 * Fetch and send recent confirmed transactions to a specific client
 * Simplified and optimized version that focuses on reliability over completeness
 * @param {WebSocket} ws - WebSocket connection
 */
async function sendRecentTransactionsToClient(ws) {
  try {
    console.log('Fetching 10 most recent confirmed transactions...');
    
    const transactions = [];
    const blocksToCheck = Math.min(3, recentBlocks.length); // Check last 3 blocks only
    
    for (let i = 0; i < blocksToCheck && transactions.length < 10; i++) {
      const block = recentBlocks[i];
      if (!block || !block.hash) continue;
      
      try {
        // Get full block data with transactions
        const fullBlock = await sendRpcRequest('getblock', [block.hash, 2]);
        if (!fullBlock || !fullBlock.tx || fullBlock.tx.length <= 1) continue;
        
        console.log(`Processing block ${fullBlock.height} with ${fullBlock.tx.length} transactions`);
        
        // Process transactions (skip coinbase, limit to prevent overload)
        const txsToProcess = Math.min(fullBlock.tx.length - 1, 10);
        
        for (let j = 1; j <= txsToProcess && transactions.length < 10; j++) {
          const tx = fullBlock.tx[j];
          if (!tx || !tx.txid) continue;
          
          try {
            // Use simpler data extraction from block data
            let totalValue = 0;
            let inputs = [];
            let outputs = [];
            
            // Process outputs from block data
            if (tx.vout && Array.isArray(tx.vout)) {
              for (const output of tx.vout) {
                if (output.value) {
                  totalValue += output.value;
                  outputs.push({
                    address: output.scriptPubKey?.address || 'Unknown',
                    amount: output.value,
                    type: output.scriptPubKey?.type || ''
                  });
                }
              }
            }
            
            // Process inputs from block data (basic info only)
            if (tx.vin && Array.isArray(tx.vin)) {
              inputs = tx.vin.map(input => ({
                txid: input.txid || '',
                vout: input.vout !== undefined ? input.vout : -1,
                address: '', // Cannot determine without additional RPC call
                amount: 0    // Cannot determine without additional RPC call
              }));
            }
            
            // Estimate fee (simple calculation)
            const estimatedFee = 0.0001 * (inputs.length || 1);
            const txSize = tx.vsize || tx.size || 250; // Default size estimate
            const feeRate = Math.round((estimatedFee * 100000000) / txSize);
            
            // Determine priority based on estimated fee rate
            let priority = 'low';
            if (feeRate > 100) priority = 'high';
            else if (feeRate > 50) priority = 'medium';
            
            // Calculate confirmations
            const confirmations = recentBlocks[0] ? (recentBlocks[0].height - fullBlock.height + 1) : 1;
            
            transactions.push({
              txid: tx.txid,
              blockHeight: fullBlock.height,
              blockHash: fullBlock.hash,
              blocktime: fullBlock.time,
              time: fullBlock.time,
              value: totalValue,
              size: txSize,
              vsize: tx.vsize || txSize,
              fee: estimatedFee,
              fee_rate: feeRate,
              priority: priority,
              inputs: inputs,
              outputs: outputs,
              confirmations: confirmations
            });
            
            console.log(`Added transaction ${tx.txid.substring(0, 8)}... (${totalValue.toFixed(2)} DGB)`);
            
          } catch (txError) {
            console.error(`Error processing transaction ${tx.txid}:`, txError.message);
            // Continue with next transaction rather than failing completely
          }
        }
        
      } catch (blockError) {
        console.error(`Error processing block ${block.hash}:`, blockError.message);
        // Continue with next block rather than failing completely
      }
    }
    
    // Sort by most recent first (by block height, then by position in block)
    transactions.sort((a, b) => {
      if (a.blockHeight !== b.blockHeight) {
        return b.blockHeight - a.blockHeight;
      }
      return b.time - a.time;
    });
    
    // Limit to exactly 10 most recent transactions
    const recentTransactions = transactions.slice(0, 10);
    
    // Send to client
    ws.send(JSON.stringify({
      type: 'recentTransactions',
      data: recentTransactions
    }));
    
    console.log(`✅ Sent ${recentTransactions.length} recent confirmed transactions to client`);
    
    if (recentTransactions.length > 0) {
      console.log(`   Latest: ${recentTransactions[0].txid.substring(0, 8)}... (Block ${recentTransactions[0].blockHeight})`);
      console.log(`   Oldest: ${recentTransactions[recentTransactions.length-1].txid.substring(0, 8)}... (Block ${recentTransactions[recentTransactions.length-1].blockHeight})`);
    }
    
  } catch (error) {
    console.error('❌ Error fetching recent transactions:', error);
    
    // Send placeholder data instead of empty array to provide user feedback
    const placeholderTransactions = recentBlocks.slice(0, 3).map((block, index) => ({
      txid: `placeholder-${block.height}-${index}`,
      blockHeight: block.height,
      blockHash: block.hash,
      blocktime: block.timestamp,
      time: block.timestamp,
      value: 0,
      size: 250,
      vsize: 250,
      fee: 0.0001,
      fee_rate: 40,
      priority: 'medium',
      inputs: [],
      outputs: [],
      confirmations: recentBlocks[0] ? (recentBlocks[0].height - block.height + 1) : 1,
      placeholder: true // Mark as placeholder for frontend
    }));
    
    ws.send(JSON.stringify({
      type: 'recentTransactions',
      data: placeholderTransactions
    }));
    
    console.log(`⚠️  Sent ${placeholderTransactions.length} placeholder transactions due to error`);
  }
}

/**
 * Monitor mempool for changes and broadcast updates
 * This function is optional and can be enabled by uncommenting
 * the setInterval call in the startup sequence
 */
async function monitorMempoolChanges() {
  try {
    // Get current mempool transaction IDs
    const currentMempool = await sendRpcRequest('getrawmempool', [false]);
    if (!currentMempool || !Array.isArray(currentMempool)) return;
    
    // Initialize tracking set if not exists
    if (!global.knownMempoolTxs) {
      global.knownMempoolTxs = new Set(currentMempool);
      return;
    }
    
    // Check for new transactions
    const newTxIds = currentMempool.filter(txid => !global.knownMempoolTxs.has(txid));
    
    if (newTxIds.length > 0) {
      // Get details for new transactions (limit to prevent overload)
      const rawMempool = await sendRpcRequest('getrawmempool', [true]);
      
      for (const txid of newTxIds.slice(0, 10)) {
        if (rawMempool[txid]) {
          const txData = rawMempool[txid];
          const feeRate = txData.fee ? Math.round((txData.fee * 100000000) / (txData.vsize || txData.size || 1)) : 0;
          
          const newTx = {
            txid: txid,
            size: txData.vsize || txData.size || 0,
            fee: txData.fee || 0,
            time: txData.time || Math.floor(Date.now() / 1000),
            inputs: txData.depends ? txData.depends.length : 1,
            outputs: 2,
            fee_rate: feeRate,
            priority: feeRate > 100 ? 'high' : feeRate > 50 ? 'medium' : 'low'
          };
          
          // Broadcast to all clients
          const message = JSON.stringify({
            type: 'newTransaction',
            data: newTx
          });
          
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.send(message);
              } catch (error) {
                console.error('Error broadcasting new transaction:', error);
              }
            }
          });
          
          global.knownMempoolTxs.add(txid);
        }
      }
    }
    
    // Check for removed transactions (confirmed in blocks)
    const removedTxIds = Array.from(global.knownMempoolTxs).filter(txid => !currentMempool.includes(txid));
    
    for (const txid of removedTxIds) {
      const message = JSON.stringify({
        type: 'removedTransaction',
        data: { txid }
      });
      
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(message);
          } catch (error) {
            console.error('Error broadcasting removed transaction:', error);
          }
        }
      });
      
      global.knownMempoolTxs.delete(txid);
    }
    
  } catch (error) {
    console.error('Error monitoring mempool:', error);
  }
}

// ============================================================================
// VISIT TRACKING AND ANALYTICS
// ============================================================================

/**
 * Middleware to track all incoming requests for analytics
 * Records both total visits and unique IP addresses
 */
app.use((req, res, next) => {
  const clientIP = req.ip;
  
  // Record the visit
  db.run('INSERT INTO visits (ip) VALUES (?)', [clientIP], (error) => {
    if (error) {
      console.error('Error logging visit:', error);
    }

    // Check and record unique IP
    db.get('SELECT COUNT(*) AS count FROM unique_ips WHERE ip = ?', [clientIP], (error, row) => {
      if (error) {
        console.error('Error checking unique IP:', error);
        return next();
      }

      // Add to unique IPs if not seen before
      if (row.count === 0) {
        db.run('INSERT INTO unique_ips (ip) VALUES (?)', [clientIP], (error) => {
          if (error) {
            console.error('Error recording unique IP:', error);
          }
          next();
        });
      } else {
        next();
      }
    });
  });
});

/**
 * Endpoint to retrieve visit statistics
 * Provides total visits, unique visitors, and recent activity metrics
 */
app.get('/api/visitstats', (req, res) => {
  db.serialize(() => {
    // Query visit statistics
    db.all(`
      SELECT
        (SELECT COUNT(*) FROM visits WHERE timestamp > datetime('now', '-30 days')) AS visitsLast30Days,
        (SELECT COUNT(*) FROM visits) AS totalVisits
    `, (error, rows) => {
      if (error) {
        console.error('Error retrieving visit statistics:', error);
        return res.status(500).json({ error: 'Database error retrieving visit stats' });
      }

      const { visitsLast30Days, totalVisits } = rows[0];

      // Get unique visitor count
      db.get('SELECT COUNT(*) AS uniqueVisitors FROM unique_ips', (error, row) => {
        if (error) {
          console.error('Error retrieving unique visitor count:', error);
          return res.status(500).json({ error: 'Database error retrieving visitor stats' });
        }

        const { uniqueVisitors } = row;
        res.json({
          visitsLast30Days,
          totalVisits,
          uniqueVisitors
        });
      });
    });
  });
});

// ============================================================================
// CACHE AND SYSTEM STATUS
// ============================================================================

/**
 * Endpoint to check cache status across all caching layers
 * Useful for monitoring and debugging performance issues
 */
app.get('/api/cachestatus', (req, res) => {
  // Peer cache information
  const peerCacheInfo = {
    hasPeerData: peerCache.has('peerData'),
    hasGeoNodes: peerCache.has('geoNodes'),
    peerTtl: peerCache.has('peerData') ? 
      Math.floor((peerCache.getTtl('peerData') - Date.now()) / 1000) : null,
    geoNodesTtl: peerCache.has('geoNodes') ? 
      Math.floor((peerCache.getTtl('geoNodes') - Date.now()) / 1000) : null,
    peerCount: uniqueNodes.length,
  };

  // RPC cache information
  const { rpcCache } = require('./rpc');
  const rpcCacheInfo = {
    stats: rpcCache ? { 
      keys: rpcCache.keys().length,
    } : null
  };

  // Complete cache status
  const cacheStatus = {
    peer: peerCacheInfo,
    rpc: rpcCacheInfo,
    initialData: {
      inMemory: !!inMemoryInitialData,
      inCache: cache.has('initialData')
    },
    blocks: {
      count: recentBlocks.length,
      latest: recentBlocks.length > 0 ? recentBlocks[0].height : null
    },
    connections: connectedClients
  };

  res.json(cacheStatus);
});

/**
 * Manual peer cache refresh endpoint
 * Allows administrators to force a fresh peer data fetch
 */
app.post('/api/refresh-peers', async (req, res) => {
  try {
    console.log('Manual peer cache refresh requested');

    // Clear existing caches
    peerCache.del('peerData');
    peerCache.del('geoNodes');

    // Force fresh peer data fetch
    const refreshResult = await refreshPeerData();
    
    res.json({
      success: true,
      message: 'Peer data refreshed successfully',
      nodeCount: uniqueNodes.length,
      cacheStatus: {
        peerData: peerCache.has('peerData'),
        geoNodes: peerCache.has('geoNodes')
      }
    });
  } catch (error) {
    console.error('Error during manual peer refresh:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Health check endpoint for monitoring systems
 */
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// ============================================================================
// DATA PERSISTENCE
// ============================================================================

/**
 * Save critical cache data to disk for recovery after server restarts
 * This ensures continuity of service even during maintenance
 */
async function saveCacheToDisk() {
  try {
    const backupData = {
      initialData: inMemoryInitialData,
      timestamp: Date.now()
    };
    
    await fs.writeFile(
      path.join(__dirname, 'cache-backup.json'),
      JSON.stringify(backupData, null, 2),
      'utf8'
    );
    
    console.log('Cache data successfully saved to disk');
  } catch (error) {
    console.error('Failed to save cache to disk:', error);
  }
}

/**
 * Load cache data from disk during server startup
 * Provides continuity from previous server sessions
 * 
 * @returns {Promise<object|null>} Loaded cache data or null
 */
async function loadCacheFromDisk() {
  try {
    const filePath = path.join(__dirname, 'cache-backup.json');
    
    // Check if backup file exists
    try {
      await fs.access(filePath);
    } catch (e) {
      console.log('No cache backup file found - starting fresh');
      return null;
    }

    const fileData = await fs.readFile(filePath, 'utf8');
    const cacheData = JSON.parse(fileData);

    // Validate data age (reject if older than 24 hours)
    const maxAge = 86400000; // 24 hours in milliseconds
    if (Date.now() - cacheData.timestamp > maxAge) {
      console.log('Cache backup is too old, ignoring');
      return null;
    }

    console.log('Successfully loaded cache data from disk');
    return cacheData;
  } catch (error) {
    console.error('Failed to load cache from disk:', error);
    return null;
  }
}

// ============================================================================
// BACKGROUND TASKS AND UTILITIES
// ============================================================================

/**
 * Fetch peer data with retry logic for robustness
 * Handles temporary network issues and server startup delays
 * 
 * @returns {Promise<object>} Peer data from successful fetch
 */
async function refreshPeerData() {
  const maxRetries = 3;
  const retryDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Peer data fetch attempt ${attempt}/${maxRetries}`);
      
      // Verify server is ready
      const healthCheck = await axios.get(`http://localhost:${SERVER_CONFIG.port}/health`)
        .catch(() => null);
      
      if (!healthCheck) {
        console.log(`Server not ready, waiting ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }

      // Fetch peer data from our own endpoint
      const response = await axios.get(`http://localhost:${SERVER_CONFIG.port}/api/getpeers`);
      
      if (response.data && (response.data.uniqueIPv4Addresses || response.data.uniqueIPv6Addresses)) {
        const ipv4Count = response.data.uniqueIPv4Addresses?.length || 0;
        const ipv6Count = response.data.uniqueIPv6Addresses?.length || 0;
        console.log(`Successfully fetched peer data: ${ipv4Count} IPv4 + ${ipv6Count} IPv6`);
        return response.data;
      } else {
        throw new Error("Invalid peer data response format");
      }
    } catch (error) {
      console.log(`Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      
      // On final attempt, try cached data
      if (attempt === maxRetries) {
        console.error('Max retries reached for peer fetch');
        if (peerCache.has('peerData')) {
          console.log('Using previously cached peer data as fallback');
          return peerCache.get('peerData');
        }
        throw new Error('Failed to fetch peer data after multiple attempts');
      }

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// ============================================================================
// ZEROMQ TRANSACTION MONITORING
// ============================================================================

/**
 * ZeroMQ subscribers for real-time blockchain events
 */
let zmqSubRawTx = null;
let zmqSubHashTx = null;
let zmqSubRawBlock = null;
let zmqSubHashBlock = null;

/**
 * Initialize ZeroMQ subscribers for real-time transaction monitoring
 * Connects to DigiByte node's ZMQ endpoints if enabled in config
 */
async function initializeZeroMQ() {
  if (!ZMQ_CONFIG.enabled) {
    console.log('ZeroMQ disabled in configuration');
    return;
  }

  try {
    console.log('Initializing ZeroMQ subscribers...');

    // Subscribe to raw transactions
    if (ZMQ_CONFIG.endpoints.rawtx) {
      zmqSubRawTx = new zmq.Subscriber;
      zmqSubRawTx.connect(ZMQ_CONFIG.endpoints.rawtx);
      zmqSubRawTx.subscribe('rawtx');
      
      console.log(`✓ Connected to rawtx endpoint: ${ZMQ_CONFIG.endpoints.rawtx}`);
      
      // Handle raw transaction data
      handleRawTransactions();
    }

    // Subscribe to transaction hashes
    if (ZMQ_CONFIG.endpoints.hashtx) {
      zmqSubHashTx = new zmq.Subscriber;
      zmqSubHashTx.connect(ZMQ_CONFIG.endpoints.hashtx);
      zmqSubHashTx.subscribe('hashtx');
      
      console.log(`✓ Connected to hashtx endpoint: ${ZMQ_CONFIG.endpoints.hashtx}`);
      
      // Handle transaction hashes
      handleHashTransactions();
    }

    // Subscribe to raw blocks (for confirmed transactions)
    if (ZMQ_CONFIG.endpoints.rawblock) {
      zmqSubRawBlock = new zmq.Subscriber;
      zmqSubRawBlock.connect(ZMQ_CONFIG.endpoints.rawblock);
      zmqSubRawBlock.subscribe('rawblock');
      
      console.log(`✓ Connected to rawblock endpoint: ${ZMQ_CONFIG.endpoints.rawblock}`);
      
      // Handle raw block data
      handleRawBlocks();
    }

    console.log('ZeroMQ initialization complete');
    
  } catch (error) {
    console.error('Failed to initialize ZeroMQ:', error);
    console.log('Falling back to mempool polling mode');
  }
}

/**
 * Handle incoming raw transaction data from ZeroMQ
 * Processes and broadcasts new transactions to WebSocket clients
 */
async function handleRawTransactions() {
  for await (const [topic, message] of zmqSubRawTx) {
    try {
      // Parse the raw transaction
      const txHex = message.toString('hex');
      
      // Get transaction details via RPC (since we have the hash)
      // For now, we'll need to decode the raw transaction
      const txid = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(message).digest())
        .digest()
        .reverse()
        .toString('hex');
      
      // Get full transaction details using enhanced transaction fetcher
      const txData = await getTransactionData(txid);
      
      if (txData) {
        // Calculate transaction value
        let totalValue = 0;
        if (txData.vout && Array.isArray(txData.vout)) {
          for (const output of txData.vout) {
            if (output.value) {
              totalValue += output.value;
            }
          }
        }
        
        // Calculate fee (would need input values for accurate fee)
        const estimatedFee = 0.0001 * (txData.vin ? txData.vin.length : 1);
        const txSize = txData.vsize || txData.size || message.length / 2;
        
        const newTransaction = {
          txid: txid,
          value: totalValue,
          size: txSize,
          fee: estimatedFee,
          feeRate: txSize > 0 ? Math.round((estimatedFee * 100000000) / txSize) : 0,
          time: txData.time || Math.floor(Date.now() / 1000),
          inputs: txData.vin ? txData.vin.length : 0,
          outputs: txData.vout ? txData.vout.length : 0,
          confirmations: 0,
          inMempool: true
        };
        
        // Broadcast to all WebSocket clients
        const wsMessage = JSON.stringify({
          type: 'newTransaction',
          data: newTransaction
        });
        
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(wsMessage);
            } catch (error) {
              console.error('Error broadcasting new transaction:', error);
            }
          }
        });
        
        console.log(`New transaction broadcast: ${txid}`);
      }
      
    } catch (error) {
      console.error('Error processing raw transaction:', error);
    }
  }
}

/**
 * Handle incoming transaction hashes from ZeroMQ
 * Lighter weight than raw transactions, fetches details as needed
 */
async function handleHashTransactions() {
  for await (const [topic, message] of zmqSubHashTx) {
    try {
      const txid = message.toString('hex');
      // Reduced logging to prevent spam
      if (Math.random() < 0.1) { // Only log 10% of transactions
        console.log(`New transaction hash: ${txid}`);
      }
      
      // Optionally fetch full transaction details
      // This is more efficient than processing raw transactions
      
    } catch (error) {
      console.error('Error processing transaction hash:', error);
    }
  }
}

/**
 * Handle incoming raw blocks from ZeroMQ
 * Processes blocks to extract confirmed transactions
 */
async function handleRawBlocks() {
  for await (const [topic, message] of zmqSubRawBlock) {
    try {
      // Calculate block hash
      const blockHash = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(message.slice(0, 80)).digest())
        .digest()
        .reverse()
        .toString('hex');
      
      console.log(`New block via ZeroMQ: ${blockHash}`);
      
      // Process the block using existing block notification logic
      const fullBlock = await sendRpcRequest('getblock', [blockHash, 2]);
      if (fullBlock && fullBlock.tx) {
        // Update recent blocks cache
        const coinbaseTx = fullBlock.tx[0];
        const addressOutput = coinbaseTx.vout?.find(output => output?.scriptPubKey?.address);
        const minerAddress = addressOutput ? addressOutput.scriptPubKey.address : '';
        
        const { poolIdentifier } = decodeCoinbaseData(coinbaseTx.vin[0].coinbase);
        const taprootSignaling = (fullBlock.version & (1 << 2)) !== 0;
        
        const newBlock = {
          height: fullBlock.height,
          hash: fullBlock.hash,
          algo: getAlgoName(fullBlock.pow_algo),
          txCount: fullBlock.nTx,
          difficulty: fullBlock.difficulty,
          timestamp: fullBlock.time,
          minedTo: minerAddress,
          minerAddress,
          poolIdentifier,
          taprootSignaling,
          version: fullBlock.version
        };
        
        updateRecentBlocksCache(newBlock);
        broadcastNewBlock(newBlock);
        
        // Send recent transactions from this block
        const blockTransactions = [];
        for (let i = 1; i < Math.min(fullBlock.tx.length, 20); i++) {
          const tx = fullBlock.tx[i];
          if (!tx) continue;
          
          let totalValue = 0;
          if (tx.vout && Array.isArray(tx.vout)) {
            for (const output of tx.vout) {
              if (output.value) {
                totalValue += output.value;
              }
            }
          }
          
          const txSize = tx.vsize || tx.size || 0;
          const estimatedFee = 0.0001 * (tx.vin ? tx.vin.length : 1);
          
          blockTransactions.push({
            txid: tx.txid || tx.hash,
            blockHeight: fullBlock.height,
            blockHash: fullBlock.hash,
            time: tx.time || fullBlock.time,
            value: totalValue,
            size: txSize,
            fee: estimatedFee,
            feeRate: txSize > 0 ? Math.round((estimatedFee * 100000000) / txSize) : 0,
            inputs: tx.vin ? tx.vin.length : 0,
            outputs: tx.vout ? tx.vout.length : 0,
            confirmations: 1
          });
        }
        
        // Broadcast confirmed transactions
        if (blockTransactions.length > 0) {
          const wsMessage = JSON.stringify({
            type: 'confirmedTransactions',
            data: blockTransactions
          });
          
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.send(wsMessage);
              } catch (error) {
                console.error('Error broadcasting confirmed transactions:', error);
              }
            }
          });
        }
      }
      
    } catch (error) {
      console.error('Error processing raw block from ZeroMQ:', error);
    }
  }
}

/**
 * Cleanup ZeroMQ connections
 */
function cleanupZeroMQ() {
  console.log('Cleaning up ZeroMQ connections...');
  
  if (zmqSubRawTx) {
    zmqSubRawTx.close();
    zmqSubRawTx = null;
  }
  
  if (zmqSubHashTx) {
    zmqSubHashTx.close();
    zmqSubHashTx = null;
  }
  
  if (zmqSubRawBlock) {
    zmqSubRawBlock.close();
    zmqSubRawBlock = null;
  }
  
  if (zmqSubHashBlock) {
    zmqSubHashBlock.close();
    zmqSubHashBlock = null;
  }
  
  console.log('ZeroMQ cleanup complete');
}

// ============================================================================
// SERVER STARTUP AND INITIALIZATION
// ============================================================================

/**
 * Main server startup function
 * Orchestrates the initialization of all server components in the correct order
 */
async function startServer() {
  try {
    console.log('='.repeat(60));
    console.log('  DIGIBYTE STATS SERVER - STARTING UP');
    console.log('='.repeat(60));

    // Phase 0: Load any existing cache from disk
    console.log('Phase 0: Loading cached data from previous session...');
    const diskCache = await loadCacheFromDisk();
    if (diskCache && diskCache.initialData) {
      console.log('✓ Restored initial data from disk cache');
      inMemoryInitialData = diskCache.initialData;
    } else {
      console.log('- No usable disk cache found');
    }

    // Phase 1: Start the HTTP server
    console.log('\nPhase 1: Starting HTTP server...');
    const server = app.listen(SERVER_CONFIG.port, () => {
      console.log(`✓ HTTP server listening on port ${SERVER_CONFIG.port}`);
      console.log(`✓ WebSocket server listening on port ${SERVER_CONFIG.wsPort}`);
    });

    // Phase 2: Initialize essential blockchain data
    console.log('\nPhase 2: Loading essential blockchain data...');
    await Promise.all([
      fetchLatestBlocks().then(() => console.log('✓ Recent blocks loaded')),
      fetchInitialData().then(() => console.log('✓ Initial blockchain data cached'))
    ]);

    // Phase 3: Load peer network data
    console.log('\nPhase 3: Loading peer network data...');
    try {
      await refreshPeerData();
      console.log(`✓ Peer data loaded: ${uniqueNodes.length} nodes`);
    } catch (peerError) {
      console.error('⚠ Error loading peer data:', peerError.message);
      console.log('  Continuing without peer data - will retry in background');
    }

    // Phase 4: Initialize ZeroMQ for real-time transaction monitoring
    console.log('\nPhase 4: Initializing ZeroMQ for real-time monitoring...');
    try {
      await initializeZeroMQ();
      console.log('✓ ZeroMQ initialized successfully');
    } catch (zmqError) {
      console.error('⚠ ZeroMQ initialization failed:', zmqError.message);
      console.log('  Continuing with polling-based updates');
    }

    // Phase 5: Setup periodic maintenance tasks
    console.log('\nPhase 5: Setting up periodic maintenance...');
    
    // Blockchain data updates (every minute)
    setInterval(() => {
      fetchLatestBlocks().catch(err => 
        console.error('Scheduled blocks update failed:', err));
    }, 60000);
    
    setInterval(() => {
      fetchInitialData().catch(err => 
        console.error('Scheduled data update failed:', err));
    }, 60000);
    
    // Peer data updates (every 10 minutes)
    setInterval(() => {
      refreshPeerData().catch(err => 
        console.error('Scheduled peer update failed:', err));
    }, 600000);
    
    // Cache persistence (every minute)
    setInterval(() => {
      saveCacheToDisk().catch(err => 
        console.error('Cache save failed:', err));
    }, 60000);
    
    // Optional: Mempool monitoring (every 10 seconds)
    // Uncomment the following block to enable real-time mempool updates
    /*
    setInterval(() => {
      monitorMempoolChanges().catch(err => 
        console.error('Mempool monitoring error:', err));
    }, 10000);
    */

    console.log('✓ Periodic maintenance scheduled');

    // Final status report
    console.log('\n' + '='.repeat(60));
    console.log('  SERVER STARTUP COMPLETE');
    console.log('='.repeat(60));
    console.log(`Blockchain height: ${inMemoryInitialData?.blockchainInfo?.blocks || 'Unknown'}`);
    console.log(`Recent blocks: ${recentBlocks.length}/${SERVER_CONFIG.maxRecentBlocks}`);
    console.log(`Latest block: ${recentBlocks[0]?.height || 'None'}`);
    console.log(`Peer nodes: ${uniqueNodes.length}`);
    console.log(`WebSocket clients: ${connectedClients}`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('  CRITICAL STARTUP ERROR');
    console.error('='.repeat(60));
    console.error(error);
    console.error('='.repeat(60));
    process.exit(1);
  }
}

// ============================================================================
// APPLICATION ENTRY POINT
// ============================================================================

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  cleanupZeroMQ();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  cleanupZeroMQ();
  process.exit(0);
});

// Start the server
startServer();