/**************************************************************
 * COMBINED AND CORRECTED server.js WITH IN-MEMORY STORAGE
 * + 1 MINUTE INTERVALS
 **************************************************************/

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const geoip = require('geoip-lite');
const NodeCache = require('node-cache');
const sqlite3 = require('sqlite3').verbose();
const { exec, spawn } = require('child_process');
const path = require('path');
const axios = require('axios');
const fs = require('fs').promises;
const crypto = require('crypto');

// ------------------------- RPC IMPORTS -------------------------
const {
  router: rpcRoutes,
  sendRpcRequest,
  getAlgoName,
  getBlocksByTimeRange
} = require('./rpc');

const config = require('./config.js');

// ------------------------- EXPRESS SETUP -------------------------
const app = express();
const port = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// Attach RPC routes under /api
app.use('/api', rpcRoutes);

// ------------------------- WEBSOCKET SETUP -------------------------
const wss = new WebSocket.Server({ port: 5002 });

// Keep the last 240 blocks in memory
const recentBlocks = [];
const maxRecentBlocks = 240;

// Send a ping every 30 seconds to keep WS alive
const pingInterval = 30000;

// ------------------------- CACHE SETUP -------------------------
// We still use NodeCache, but only as a fallback. TTL = 60 seconds.
const cache = new NodeCache({ stdTTL: 60 });

// ------------------------- IN-MEMORY INITIAL DATA -------------------------
const peerCache = new NodeCache({ stdTTL: 600 }); // 10 minute cache for peers

// ------------------------- IN-MEMORY INITIAL DATA -------------------------
// This ensures we never lose data if the cache TTL expires or an RPC call fails.
let inMemoryInitialData = null;

// ------------------------- SQLITE SETUP -------------------------
const db = new sqlite3.Database('nodes.db');

// Create or ensure needed tables exist
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

let uniqueNodes = [];
let connectedClients = 0;

// ------------------------- WEBSOCKET CONNECTION -------------------------
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  connectedClients++;
  console.log(`Number of connected clients: ${connectedClients}`);

  // 1) Send recent blocks
  console.log('Sending recent blocks to new client:', recentBlocks.length);
  ws.send(JSON.stringify({ type: 'recentBlocks', data: recentBlocks }));

  // 2) Send initialData from memory (if we have it)
  if (inMemoryInitialData) {
    ws.send(JSON.stringify({ type: 'initialData', data: inMemoryInitialData }));
  } else {
    // If we prefer, we can also check NodeCache as fallback:
    const cached = cache.get('initialData');
    if (cached) {
      ws.send(JSON.stringify({ type: 'initialData', data: cached }));
    }
  }

  // 3) Send geo data (unique nodes) - now with caching
  const cachedGeoNodes = peerCache.get('geoNodes');
  if (cachedGeoNodes) {
    // Use cached geo data if available
    ws.send(JSON.stringify({ type: 'geoData', data: cachedGeoNodes }));
  } else if (uniqueNodes.length > 0) {
    // Fall back to in-memory data
    ws.send(JSON.stringify({ type: 'geoData', data: uniqueNodes }));
  }

  // Keep WS alive by sending pings
  const pingTimer = setInterval(() => {
    ws.ping();
  }, pingInterval);

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    connectedClients--;
    clearInterval(pingTimer);
  });
});

// ------------------------- DECODE COINBASE UTILITY -------------------------
function decodeCoinbaseData(coinbaseHex) {
  try {
    const buffer = Buffer.from(coinbaseHex, 'hex');
    const text = buffer.toString('utf8');

    // Some common patterns for pool identifiers
    const poolPatterns = [
      /\/(.*?)\//,             // /PoolName/
      /\[(.*?)\]/,             // [PoolName]
      /@(.*?)@/,               // @PoolName@
      /pool\.(.*?)\.com/,      // pool.Name.com
      /(.*?)pool/i,            // Somethingpool
      /^(?:[\x00-\xFF]*?)([\x20-\x7F]{3,})/ // fallback: readable ASCII
    ];

    let poolIdentifier = 'Unknown';
    for (const pattern of poolPatterns) {
      const match = text.match(pattern);
      if (match && match[1] && match[1].length >= 3) {
        poolIdentifier = match[1].trim();
        break;
      }
    }

    return { poolIdentifier, rawText: text };
  } catch (error) {
    console.error('Error decoding coinbase:', error);
    return { poolIdentifier: 'Unknown', rawText: '' };
  }
}

// ------------------------- FETCH LATEST BLOCKS ON STARTUP -------------------------
async function fetchLatestBlocks() {
  try {
    console.log('Starting to fetch recent blocks...');
    
    // 1) Get chain tip
    const blockchainInfo = await sendRpcRequest('getblockchaininfo');
    if (!blockchainInfo) {
      throw new Error('Unable to fetch blockchain info');
    }
    
    const latestBlockHeight = blockchainInfo.blocks;
    console.log('Latest block height:', latestBlockHeight);

    // 2) Clear existing blocks to avoid duplication
    recentBlocks.length = 0;
    
    // 3) Calculate the range we need to fetch
    // Request more blocks than needed to ensure we get enough
    const requestedBlocks = Math.ceil(maxRecentBlocks * 1.1); // Request 10% more blocks
    const startHeight = Math.max(1, latestBlockHeight - requestedBlocks);
    
    // 4) Fetch blocks - force start timestamp to 0 to get all blocks regardless of time
    console.log(`Requesting ${requestedBlocks} blocks starting from height ${startHeight}`);
    const blocksBasic = await getBlocksByTimeRange(0, latestBlockHeight, requestedBlocks);
    
    // 5) Add all fetched blocks
    recentBlocks.push(...blocksBasic);
    
    // 6) If we still don't have enough blocks, fetch more individually
    if (recentBlocks.length < maxRecentBlocks && latestBlockHeight >= maxRecentBlocks) {
      console.log(`Only got ${recentBlocks.length} blocks, need ${maxRecentBlocks}. Fetching more...`);
      
      // Find the lowest height we already have
      const lowestHeight = recentBlocks.reduce((min, block) => 
        Math.min(min, block.height), Number.MAX_SAFE_INTEGER);
      
      // Fetch older blocks until we have enough
      let currentHeight = lowestHeight - 1;
      while (recentBlocks.length < maxRecentBlocks && currentHeight > 0) {
        console.log(`Fetching additional block at height ${currentHeight}`);
        try {
          // Get block hash
          const hash = await sendRpcRequest('getblockhash', [currentHeight]);
          if (hash) {
            // Get full block
            const block = await sendRpcRequest('getblock', [hash, 2]);
            if (block && block.tx && block.tx.length > 0) {
              // Process block like in getBlocksByTimeRange
              const coinbaseTx = block.tx[0];
              const firstOutputWithAddress = coinbaseTx.vout?.find(
                (out) => out?.scriptPubKey?.address
              );
              const minerAddress = firstOutputWithAddress
                ? firstOutputWithAddress.scriptPubKey.address
                : '';
              
              const { poolIdentifier } = decodeCoinbaseData(coinbaseTx.vin[0].coinbase);
              const taprootSignaling = (block.version & (1 << 2)) !== 0;
              
              recentBlocks.push({
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
              });
            }
          }
        } catch (error) {
          console.error(`Error fetching additional block at height ${currentHeight}:`, error.message);
        }
        
        currentHeight--;
      }
    }

    // 7) Sort and limit to exactly maxRecentBlocks
    recentBlocks.sort((a, b) => b.height - a.height);
    recentBlocks.splice(maxRecentBlocks);
    
    console.log(`Loaded ${recentBlocks.length} blocks. Height range: ${recentBlocks[0]?.height || 'none'} to ${recentBlocks[recentBlocks.length-1]?.height || 'none'}`);
    
    return recentBlocks;
  } catch (error) {
    console.error('Error fetching latest blocks:', error);
    return [];
  }
}

// ------------------------- BLOCK NOTIFY (NEW BLOCK) -------------------------
app.post('/api/blocknotify', async (req, res) => {
  try {
    if (!req.body?.blockhash) {
      throw new Error('blockhash is missing in request body');
    }

    const blockHash = req.body.blockhash;
    console.log('Blocknotify triggered for hash:', blockHash);

    // 1) Fetch full block
    const fullBlock = await sendRpcRequest('getblock', [blockHash, 2]);
    if (!fullBlock || !fullBlock.tx?.[0]) {
      console.log('No coinbase TX found, skipping.');
      return res.sendStatus(200);
    }

    const coinbaseTx = fullBlock.tx[0];
    const firstOutputWithAddress = coinbaseTx.vout?.find(
      (out) => out?.scriptPubKey?.address
    );
    const minerAddress = firstOutputWithAddress
      ? firstOutputWithAddress.scriptPubKey.address
      : '';

    const { poolIdentifier } = decodeCoinbaseData(coinbaseTx.vin[0].coinbase);
    const taprootSignaling = (fullBlock.version & (1 << 2)) !== 0;

    // 2) Build the new block
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

    // 3) Insert new block at front
    recentBlocks.unshift(newBlock);
    recentBlocks.sort((a, b) => b.height - a.height);
    recentBlocks.splice(maxRecentBlocks);

    // 4) Broadcast via WebSocket
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        console.log(`Sending newBlock to client: ${newBlock.height}`);
        client.send(JSON.stringify({ type: 'newBlock', data: newBlock }));
      }
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('Block notification error:', error);
    res.sendStatus(500);
  }
});

// ------------------------- INITIAL DATA FETCH -------------------------
async function fetchInitialData() {
  try {
    console.log('Fetching initial blockchain data...');
    
    // First, get the data that rarely fails
    const blockchainInfo = await sendRpcRequest('getblockchaininfo');
    if (!blockchainInfo) {
      throw new Error('Unable to fetch basic blockchain info');
    }
    
    const chainTxStats = await sendRpcRequest('getchaintxstats');
    const blockRewardResponse = await sendRpcRequest('getblockreward');
    const blockReward = parseFloat(blockRewardResponse?.blockreward || '0');
    
    // Try to get txoutsetinfo with a longer timeout, but continue if it fails
    let txOutsetInfo = null;
    try {
      console.log('Fetching UTXO set info (may take a while)...');
      txOutsetInfo = await sendRpcRequest('gettxoutsetinfo');
      console.log('Successfully fetched UTXO set info');
    } catch (txOutsetError) {
      console.error('Failed to fetch txoutsetinfo:', txOutsetError.message);
      
      // Try to get a cached version if available
      const { rpcCache } = require('./rpc');
      const cacheKey = `rpc:gettxoutsetinfo:${crypto.createHash('md5').update(JSON.stringify([])).digest('hex')}`;
      txOutsetInfo = rpcCache?.get(cacheKey, true); // Get even if expired
      
      if (txOutsetInfo) {
        console.log('Using cached txoutsetinfo data');
        
        // If we have blockchain height, update the estimate
        if (txOutsetInfo._estimated && blockchainInfo) {
          txOutsetInfo.height = blockchainInfo.blocks;
          console.log('Updated estimated UTXO data with current height');
        }
      } else {
        console.log('No UTXO data available, creating placeholder');
        txOutsetInfo = {
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

    const initialData = {
      blockchainInfo,
      chainTxStats,
      txOutsetInfo,
      blockReward
    };

    // Store in NodeCache (optional)
    cache.set('initialData', initialData);

    // Also store in memory (so we never lose it)
    inMemoryInitialData = initialData;

    // Broadcast to existing clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'initialData', data: initialData }));
      }
    });
    
    console.log('Initial data fetch complete');
    return initialData;
  } catch (error) {
    console.error('Error fetching initial data:', error);

    // NOTE: We do NOT clear inMemoryInitialData on error.
    // So we keep showing old data to users until a successful fetch.
    return inMemoryInitialData;
  }
}

// ------------------------- GETPEERS + GEO STUFF -------------------------
app.get('/api/getpeers', (req, res) => {
  // First check if we have cached peer data (10 minute cache)
  const cachedPeers = peerCache.get('peerData');
  if (cachedPeers) {
    console.log('Using cached peer data (expires in', Math.floor((peerCache.getTtl('peerData') - Date.now()) / 1000), 'seconds)');
    return res.json(cachedPeers);
  }

  console.log('No cached peer data found, fetching fresh data...');
  const pythonScriptPath = path.join(__dirname, 'parse_peers_dat.py');
  exec(`python3 ${pythonScriptPath}`, { timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing Python script: ${error.message}`);
      return res.status(500).json({ error: 'Error executing Python script' });
    }
    if (stderr) {
      console.error(`Python script stderr: ${stderr}`);
    }

    try {
      // Make sure we have valid JSON output
      if (!stdout || stdout.trim() === '') {
        return res.status(500).json({ error: 'Empty response from peer script' });
      }
      const output = JSON.parse(stdout);
      
      // Validate output format
      if (!output.uniqueIPv4Addresses || !output.uniqueIPv6Addresses) {
        return res.status(500).json({ error: 'Invalid peer data format' });
      }

      const uniqueIPv4Addresses = output.uniqueIPv4Addresses;
      const uniqueIPv6Addresses = output.uniqueIPv6Addresses;
      console.log(`Parsed peer data: ${uniqueIPv4Addresses.length} IPv4, ${uniqueIPv6Addresses.length} IPv6 addresses`);
      
      // Geo-parse the IP addresses
      const geoData = [...uniqueIPv4Addresses, ...uniqueIPv6Addresses].map((ip) => {
        const geo = geoip.lookup(ip);
        return {
          ip,
          country: geo?.country || 'Unknown',
          city: geo?.city || 'Unknown',
          lat: geo?.ll?.[0] || 0,
          lon: geo?.ll?.[1] || 0
        };
      });
      console.log(`Geo-parsed ${geoData.length} IP addresses`);
      
      // Update DB
      db.serialize(() => {
        db.run('DELETE FROM nodes', (delErr) => {
          if (delErr) {
            console.error('Error clearing nodes table:', delErr);
            return res.status(500).json({ error: 'Error clearing nodes table' });
          }

          const stmt = db.prepare(`
            INSERT INTO nodes (ip, country, city, lat, lon)
            VALUES (?, ?, ?, ?, ?)
          `);

          geoData.forEach((node) => {
            stmt.run(node.ip, node.country, node.city, node.lat, node.lon);
          });

          stmt.finalize((finalizeErr) => {
            if (finalizeErr) {
              console.error('Error inserting nodes:', finalizeErr);
              return res.status(500).json({ error: 'Error inserting nodes into database' });
            }

            db.all('SELECT * FROM nodes', (selectErr, rows) => {
              if (selectErr) {
                console.error('Error retrieving nodes from DB:', selectErr);
                return res.status(500).json({ error: 'Error retrieving nodes from DB' });
              }

              console.log(`Loaded ${rows.length} peer nodes with geo data`);
              uniqueNodes = rows;

              // Cache the output for 10 minutes
              peerCache.set('peerData', output, 600);
              console.log('Peer data cached for 10 minutes');

              // Also cache the geo-parsed nodes
              peerCache.set('geoNodes', uniqueNodes, 600);
              console.log('Geo node data cached for 10 minutes');

              // Broadcast updated geo data
              wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: 'geoData', data: uniqueNodes }));
                }
              });

              res.json(output);
            });
          });
        });
      });
    } catch (parseError) {
      console.error(`Error parsing Python script output: ${parseError.message}`);
      console.error('Raw output:', stdout);
      return res.status(500).json({ error: 'Error parsing Python script output' });
    }
  });
});

// ------------------------- VISIT LOGGING MIDDLEWARE -------------------------
app.use((req, res, next) => {
  const ip = req.ip;
  db.run('INSERT INTO visits (ip) VALUES (?)', [ip], (err) => {
    if (err) {
      console.error('Error inserting visit log:', err);
    }

    // Check if IP is already in unique_ips
    db.get('SELECT COUNT(*) AS count FROM unique_ips WHERE ip = ?', [ip], (err, row) => {
      if (err) {
        console.error('Error checking unique IP:', err);
        return next();
      }

      if (row.count === 0) {
        db.run('INSERT INTO unique_ips (ip) VALUES (?)', (err) => {
          if (err) {
            console.error('Error inserting unique IP:', err);
          }
          next();
        });
      } else {
        next();
      }
    });
  });
});

// ------------------------- VISIT STATISTICS -------------------------
app.get('/api/visitstats', (req, res) => {
  db.serialize(() => {
    db.all(`
      SELECT
        (SELECT COUNT(*) FROM visits WHERE timestamp > datetime('now', '-30 days')) AS visitsLast30Days,
        (SELECT COUNT(*) FROM visits) AS totalVisits
    `, (err, rows) => {
      if (err) {
        console.error('Error retrieving visit stats:', err);
        return res.status(500).json({ error: 'Error retrieving visit stats' });
      }

      const { visitsLast30Days, totalVisits } = rows[0];

      db.get('SELECT COUNT(*) AS uniqueVisitors FROM unique_ips', (err, row) => {
        if (err) {
          console.error('Error retrieving unique visitors:', err);
          return res.status(500).json({ error: 'Error retrieving unique visitors' });
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

// ------------------------- CACHE STATUS ENDPOINT -------------------------
app.get('/api/cachestatus', (req, res) => {
  const peerCacheInfo = {
    hasPeerData: peerCache.has('peerData'),
    hasGeoNodes: peerCache.has('geoNodes'),
    peerTtl: peerCache.has('peerData') ? Math.floor((peerCache.getTtl('peerData') - Date.now()) / 1000) : null,
    geoNodesTtl: peerCache.has('geoNodes') ? Math.floor((peerCache.getTtl('geoNodes') - Date.now()) / 1000) : null,
    peerCount: uniqueNodes.length,
  };

  // Fix the reference to rpcCache by checking if it's available from the imported module
  const { rpcCache } = require('./rpc');
  const rpccacheInfo = {
    stats: rpcCache ? { 
      keys: rpcCache.keys().length,
    } : null
  };

  const cacheStatus = {
    peer: peerCacheInfo,
    rpc: rpccacheInfo,
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

// ------------------------- CACHE CONTROL ENDPOINTS -------------------------
app.post('/api/refresh-peers', async (req, res) => {
  try {
    console.log('Manual peer cache refresh requested');

    // Clear existing peer caches
    peerCache.del('peerData');
    peerCache.del('geoNodes');

    // Fetch fresh data
    const peerData = await fetchPeersWithRetry();
    res.json({
      success: true,
      message: 'Peer data refreshed',
      nodeCount: uniqueNodes.length,
      cacheStatus: {
        peerData: peerCache.has('peerData'),
        geoNodes: peerCache.has('geoNodes')
      }
    });
  } catch (error) {
    console.error('Error refreshing peers:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------- HEALTH CHECK (OPTIONAL) -------------------------
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// ------------------------- CACHE PERSISTENCE -------------------------
// This ensures we can recover data even if the server restarts
// Save cache data to disk for critical information
async function saveCacheToDisk() {
  try {
    const dataToSave = {
      initialData: inMemoryInitialData,
      timestamp: Date.now()
    };
    
    await fs.writeFile(
      path.join(__dirname, 'cache-backup.json'),
      JSON.stringify(dataToSave, null, 2),
      'utf8'
    );
    
    console.log('Cache data saved to disk successfully');
  } catch (error) {
    console.error('Failed to save cache to disk:', error);
  }
}

// Load cache data from disk on startup
async function loadCacheFromDisk() {
  try {
    const filePath = path.join(__dirname, 'cache-backup.json');
    
    // Check if the file exists
    try {
      await fs.access(filePath);
    } catch (e) {
      console.log('No cache backup file found');
      return null;
    }

    const fileData = await fs.readFile(filePath, 'utf8');
    const cacheData = JSON.parse(fileData);

    // Check if the data is too old (older than 1 day)
    if (Date.now() - cacheData.timestamp > 86400000) {
      console.log('Cache backup is too old, not using it');
      return null;
    }

    console.log('Loaded cache data from disk');
    return cacheData;
  } catch (error) {
    console.error('Failed to load cache from disk:', error);
    return null;
  }
}

// ------------------------- STARTUP LOGIC -------------------------
async function fetchPeersWithRetry() {
  console.log("Starting peer data fetch...");
  const maxRetries = 3;
  const retryDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Peer fetch attempt ${attempt}/${maxRetries}`);
      
      // First check if server is ready
      const healthCheck = await axios.get(`http://localhost:${port}/health`).catch(() => null);
      if (!healthCheck) {
        console.log(`Server not ready for peer fetch, waiting ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }

      // Make direct request to local endpoint
      const response = await axios.get(`http://localhost:${port}/api/getpeers`);
      
      if (response.data && (response.data.uniqueIPv4Addresses || response.data.uniqueIPv6Addresses)) {
        const ipv4Count = response.data.uniqueIPv4Addresses?.length || 0;
        const ipv6Count = response.data.uniqueIPv6Addresses?.length || 0;
        console.log(`Successfully fetched peer data: ${ipv4Count} IPv4 and ${ipv6Count} IPv6 addresses`);
        return response.data;
      } else {
        console.warn("Peer data response was invalid:", response.data);
        throw new Error("Invalid peer data response");
      }
    } catch (error) {
      console.log(`Peer fetch attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      
      // On last attempt, try to return cached data if available
      if (attempt === maxRetries) {
        console.error('Max retries reached for peer fetch');
        if (peerCache.has('peerData')) {
          console.log('Using previously cached peer data as fallback');
          return peerCache.get('peerData');
        }
        throw new Error('Failed to fetch peer data after multiple attempts');
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

async function startServer() {
  try {
    console.log('Starting DigiByte Stats server...');

    // 0) Try to load cache from disk before anything else
    console.log('Checking for cached data from previous run...');
    const diskCache = await loadCacheFromDisk();
    if (diskCache && diskCache.initialData) {
      console.log('Loaded initial data from disk cache');
      inMemoryInitialData = diskCache.initialData;
    }

    // 1) Start the server
    const server = app.listen(port, () => {
      console.log(`Server listening at http://localhost:${port}`);
    });

    // 2) Initialize data in parallel:
    console.log('Phase 1: Fetching initial data...');
    await Promise.all([
      fetchLatestBlocks(),    // populates recentBlocks
      fetchInitialData(),    // stores in memory + broadcasts
    ]);
    console.log('Essential blockchain data loaded successfully');

    // 3) Now explicitly load peer data
    console.log('Phase 2: Loading peer data...');
    try {
      // Fetch peers directly from the peers.dat file
      const peerData = await fetchPeersWithRetry();
      console.log(`Successfully loaded peer data with ${uniqueNodes.length} nodes`);
    } catch (peerError) {
      console.error('Error loading peer data:', peerError);
      console.log('Continuing without peer data - will retry in the background');
    }

    // 4) Set up periodic updates
    console.log('Setting up periodic data refresh cycles...');
    
    // Regularly update blocks
    setInterval(() => {
      fetchLatestBlocks().catch(err => {
        console.error('Error in scheduled blocks update:', err);
      });
    }, 60000); // Every minute
    
    // Regularly update initial data
    setInterval(() => {
      fetchInitialData().catch(err => {
        console.error('Error in scheduled data update:', err);
      });
    }, 60000); // Every minute
    
    // Update peers less frequently
    setInterval(() => {
      fetchPeersWithRetry().catch(err => {
        console.error('Error in scheduled peer update:', err);
      });
    }, 600000); // Every 10 minutes
    
    // Save cache to disk periodically
    setInterval(() => {
      saveCacheToDisk().catch(err => {
        console.error('Error saving cache to disk:', err);
      });
    }, 60000); // Every minute

    // Final status report
    console.log("\n=== SERVER INITIALIZED SUCCESSFULLY ===");
    console.log(`Blocks loaded: ${recentBlocks.length}`);
    console.log(`Latest block: ${recentBlocks[0]?.height || 'None'}`);
    console.log(`Peers loaded: ${uniqueNodes.length}`);
    console.log("===================================\n");
  } catch (error) {
    console.error('CRITICAL ERROR DURING STARTUP:', error);
    process.exit(1);
  }
}

// Start the server
startServer();