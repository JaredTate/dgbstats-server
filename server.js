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

// Import RPC functionality from dedicated module
const {
  router: rpcRoutes,
  sendRpcRequest,
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

  // Send cached initial data
  sendInitialDataToClient(ws);
  
  // Send geo-located peer data
  sendGeoDataToClient(ws);

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

    // Phase 4: Setup periodic maintenance tasks
    console.log('\nPhase 4: Setting up periodic maintenance...');
    
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

// Start the server
startServer();