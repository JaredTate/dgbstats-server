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
const crypto = require('crypto');

// ------------------------- RPC IMPORTS -------------------------
const {
  router: rpcRoutes,
  sendRpcRequest,  // Now using the cached version from rpc.js directly
  getAlgoName,
  getBlocksByTimeRange,
  rpcCache,
  preloadEssentialData
} = require('./rpc');

const config = require('./config.js');

// ------------------------- CACHE SETUP -------------------------
// We'll keep using NodeCache for application-level caching
// Increase TTL to 5 minutes (300 seconds) for better performance
const cache = new NodeCache({ stdTTL: 300 });

// Note: We no longer need the sendRpcRequest wrapper since it's now
// implemented directly in rpc.js with caching and rate limiting

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

// NEW: Keep recent transactions in memory
const recentTransactions = [];
const maxRecentTransactions = 100;

// Send a ping every 30 seconds to keep WS alive
const pingInterval = 30000;

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

  // 3) Send geo data (unique nodes)
  ws.send(JSON.stringify({ type: 'geoData', data: uniqueNodes }));

  // NEW: Send recent transactions to new client
  ws.send(JSON.stringify({ type: 'recentTransactions', data: recentTransactions }));

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
      if (match) {
        poolIdentifier = match[1].trim();
        break;
      }
    }

    return { poolIdentifier };
  } catch (error) {
    console.error('Error decoding coinbase data:', error);
    return { poolIdentifier: 'Unknown' };
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

// NEW: TRANSACTION NOTIFY ENDPOINT
app.post('/api/transactionnotify', async (req, res) => {
  try {
    if (!req.body?.tx) {
      throw new Error('Transaction data missing in request body');
    }

    const tx = req.body.tx;
    // Insert new transaction at the front
    recentTransactions.unshift(tx);
    recentTransactions.splice(maxRecentTransactions);

    // Broadcast new transaction via WebSocket
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        console.log(`Sending newTransaction to client: ${tx.txid}`);
        client.send(JSON.stringify({ type: 'newTransaction', data: tx }));
      }
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('Transaction notify error:', error);
    res.sendStatus(500);
  }
});

// ------------------------- INITIAL DATA FETCH -------------------------
async function fetchInitialData(forceLoad = false) {
  try {
    console.log('Fetching initial data' + (forceLoad ? ' (forced load)' : ''));
    
    // Skip cache if force loading
    const cachedInitialData = forceLoad ? null : cache.get('initialData');
    if (cachedInitialData) {
      console.log('Using cached initial data');
      inMemoryInitialData = cachedInitialData;
      return cachedInitialData;
    }
    
    // If not in cache or forced, load data fresh
    console.log('Loading fresh initial data from RPC...');
    
    // Load data with retries
    const blockchainInfo = await sendRpcWithRetry('getblockchaininfo', [], 3);
    if (!blockchainInfo) {
      throw new Error("Failed to load blockchain info");
    }
    console.log('✓ Loaded blockchain info');
    
    const chainTxStats = await sendRpcWithRetry('getchaintxstats', [], 3);
    if (!chainTxStats) {
      throw new Error("Failed to load chain transaction stats");
    }
    console.log('✓ Loaded chain transaction stats');
    
    const txOutsetInfo = await sendRpcWithRetry('gettxoutsetinfo', [], 3);
    if (!txOutsetInfo) {
      throw new Error("Failed to load transaction outset info");
    }
    console.log('✓ Loaded transaction outset info');
    
    const blockRewardResponse = await sendRpcWithRetry('getblockreward', [], 3);
    if (!blockRewardResponse) {
      throw new Error("Failed to load block reward");
    }
    const blockReward = parseFloat(blockRewardResponse.blockreward);
    console.log('✓ Loaded block reward info');
    
    // Assemble initial data object
    const initialData = {
      blockchainInfo,
      chainTxStats,
      txOutsetInfo,
      blockReward
    };

    // Store in cache and memory
    cache.set('initialData', initialData, 600);
    inMemoryInitialData = initialData;
    
    console.log('Initial data fetch complete!');
    return initialData;
  } catch (error) {
    console.error('Error fetching initial data:', error);
    return inMemoryInitialData;
  }
}

// ------------------------- LATEST BLOCKS FETCH -------------------------
async function fetchLatestBlocks(forceLoad = false) {
  try {
    console.log('Fetching latest blocks' + (forceLoad ? ' (forced load)' : ''));
    
    // Skip cache if force loading
    const cachedBlocks = forceLoad ? null : cache.get('recentBlocks');
    if (cachedBlocks && cachedBlocks.length > 0) {
      // Clear the array first
      recentBlocks.length = 0;
      recentBlocks.push(...cachedBlocks);
      console.log(`Loaded ${recentBlocks.length} blocks from cache`);
      return recentBlocks;
    }
    
    // Clear any previous blocks
    recentBlocks.length = 0;
    
    // Get blockchain info with retry
    const blockchainInfo = await sendRpcWithRetry('getblockchaininfo', [], 3);
    if (!blockchainInfo) {
      throw new Error("Failed to fetch blockchain info");
    }
    
    const latestBlockHeight = blockchainInfo.blocks;
    console.log(`Latest block height: ${latestBlockHeight}`);
    
    // Calculate start height - we need exactly 240 blocks
    const startHeight = Math.max(1, latestBlockHeight - maxRecentBlocks + 1);
    console.log(`Will fetch blocks from height ${startHeight} to ${latestBlockHeight} (${latestBlockHeight - startHeight + 1} blocks)`);
    
    // Use smaller batches for more reliable loading
    const BATCH_SIZE = 30; // 30 blocks per batch
    const blocks = [];
    
    // Fetch blocks in batches
    for (let batchStart = latestBlockHeight; batchStart >= startHeight; batchStart -= BATCH_SIZE) {
      const batchEnd = Math.max(startHeight, batchStart - BATCH_SIZE + 1);
      console.log(`Fetching batch: blocks ${batchEnd} to ${batchStart} (${batchStart - batchEnd + 1} blocks)`);
      
      try {
        // Use 0 timestamp to get all blocks regardless of time
        const blockBatch = await getBlocksByTimeRange(0, batchStart, Math.min(BATCH_SIZE, batchStart - batchEnd + 1));
        console.log(`Received ${blockBatch.length} blocks in batch`);
        
        if (blockBatch.length === 0) {
          console.warn(`Warning: Empty batch returned for blocks ${batchEnd} to ${batchStart}`);
          // Try individual blocks as fallback
          for (let height = batchStart; height >= batchEnd; height--) {
            try {
              const hash = await sendRpcWithRetry('getblockhash', [height], 2);
              if (hash) {
                const block = await sendRpcWithRetry('getblock', [hash, 2], 2);
                if (block) {
                  console.log(`Individually fetched block ${height}`);
                  // Process this block and add to our collection
                  // This code is similar to what's in getBlocksByTimeRange
                  const processedBlock = processBlockData(block);
                  blocks.push(processedBlock);
                }
              }
              // Small delay between individual blocks
              await new Promise(r => setTimeout(r, 100));
            } catch (e) {
              console.error(`Failed to fetch individual block ${height}:`, e.message);
            }
          }
        } else {
          blocks.push(...blockBatch);
        }
        
        // Add delay between batches
        if (batchStart > batchEnd) {
          await new Promise(r => setTimeout(r, 1000));
        }
        
        // If we have enough blocks, stop
        if (blocks.length >= maxRecentBlocks) {
          break;
        }
      } catch (batchError) {
        console.error(`Error fetching batch ${batchEnd}-${batchStart}:`, batchError);
        // Continue with next batch
      }
    }
    
    // Sort blocks by height and limit
    blocks.sort((a, b) => b.height - a.height);
    blocks.splice(maxRecentBlocks);
    
    // Add to our in-memory collection
    recentBlocks.push(...blocks);
    
    console.log(`Loaded ${recentBlocks.length} blocks, from ${recentBlocks[0]?.height} to ${recentBlocks[recentBlocks.length-1]?.height}`);
    
    // Cache the blocks
    cache.set('recentBlocks', recentBlocks, 3600);
    
    return recentBlocks;
  } catch (error) {
    console.error('Error in fetchLatestBlocks:', error);
    return recentBlocks;
  }
}

// Helper to process block data
function processBlockData(block) {
  let minedTo = '';
  let poolIdentifier = 'Unknown';

  if (block.tx && block.tx.length > 0) {
    const coinbaseTx = block.tx[0];
    if (coinbaseTx.vout && coinbaseTx.vout.length > 0) {
      const firstOutputWithAddress = coinbaseTx.vout.find(
        (out) => out?.scriptPubKey?.address
      );
      
      if (firstOutputWithAddress) {
        minedTo = firstOutputWithAddress.scriptPubKey.address;
      } else if (coinbaseTx.vout.length > 1 && 
               coinbaseTx.vout[1].scriptPubKey && 
               coinbaseTx.vout[1].scriptPubKey.address) {
        minedTo = coinbaseTx.vout[1].scriptPubKey.address;
      }
    }

    // Extract pool identifier
    if (coinbaseTx.vin && coinbaseTx.vin[0] && coinbaseTx.vin[0].coinbase) {
      const { poolIdentifier: extractedPool } = decodeCoinbaseData(coinbaseTx.vin[0].coinbase);
      poolIdentifier = extractedPool;
    }
  }

  const taprootSignaling = (block.version & (1 << 2)) !== 0;

  return {
    height: block.height,
    hash: block.hash,
    algo: getAlgoName(block.pow_algo),
    txCount: block.nTx,
    difficulty: block.difficulty,
    timestamp: block.time,
    minedTo,
    minerAddress: minedTo,
    poolIdentifier,
    taprootSignaling,
    version: block.version
  };
}

/* ------------------------------------------------------------------
 * GETPEERS + GEO STUFF
 * ------------------------------------------------------------------ */
app.get('/api/getpeers', (req, res) => {
  const pythonScriptPath = path.join(__dirname, 'parse_peers_dat.py');
  
  exec(`python3 ${pythonScriptPath}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing Python script: ${error.message}`);
      return res.status(500).json({ error: 'Error executing Python script' });
    }
    if (stderr) {
      console.error(`Python script stderr: ${stderr}`);
    }
    try {
      const output = JSON.parse(stdout);
      const uniqueIPv4Addresses = output.uniqueIPv4Addresses;
      const uniqueIPv6Addresses = output.uniqueIPv6Addresses;

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

              console.log('All unique nodes:', rows);
              uniqueNodes = rows;

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
      return res.status(500).json({ error: 'Error parsing Python script output' });
    }
  });
});

/* ------------------------------------------------------------------
 * Periodically fetch peers
 * ------------------------------------------------------------------ */
let fetchInterval = 60000; // 1 minute, per your request
const startFetchingData = () => {
  setInterval(async () => {
    try {
      const response = await axios.get(`http://localhost:${port}/api/getpeers`);
      console.log('Fetched peers data:', response.data);
    } catch (error) {
      console.error('Error fetching peers data:', error);
    }
  }, fetchInterval);
};
startFetchingData();

/* ------------------------------------------------------------------
 * runPeerScript (optional)
 * ------------------------------------------------------------------ */
function runPeerScript() {
  const env = process.env.NODE_ENV || 'development';
  const pythonProcess = spawn('python3', ['parse_peers_dat.py'], {
    env: { ...process.env, NODE_ENV: env }
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`parse_peers_dat.py stdout: ${data}`);
  });
  pythonProcess.stderr.on('data', (data) => {
    console.error(`parse_peers_dat.py stderr: ${data}`);
  });
  pythonProcess.on('close', (code) => {
    console.log(`parse_peers_dat.py script exited with code ${code}`);
  });
}

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
        db.run('INSERT INTO unique_ips (ip) VALUES (?)', [ip], (err) => {
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

// ------------------------- HEALTH CHECK (OPTIONAL) -------------------------
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// ------------------------- SERVER INITIALIZATION -------------------------
// New dedicated function to initialize all data
async function initializeAllData() {
  console.log("=== STARTING COMPREHENSIVE DATA INITIALIZATION ===");
  
  try {
    // 1) First preload all essential RPC data (blockchain info, network info, etc.)
    console.log("\n=== PHASE 1: PRELOADING ESSENTIAL RPC DATA ===");
    const blockchainInfo = await preloadEssentialData();
    if (!blockchainInfo) {
      throw new Error("Failed to preload essential data - blockchainInfo is null");
    }
    console.log(`✅ Successfully loaded blockchain info: Height ${blockchainInfo.blocks}, Chain ${blockchainInfo.chain}`);
    
    // 2) Next fetch application initial data
    console.log("\n=== PHASE 2: FETCHING APPLICATION INITIAL DATA ===");
    const initialData = await fetchInitialData(true); // Force fresh data load
    if (!initialData) {
      throw new Error("Failed to fetch initial application data");
    }
    console.log("✅ Successfully loaded initial application data");
    
    // Output some key stats from the data
    console.log(`   - Current Difficulty: ${initialData.blockchainInfo.difficulty}`);
    console.log(`   - Current Block Reward: ${initialData.blockReward}`);
    console.log(`   - Total Supply: ${initialData.txOutsetInfo?.total_amount || 'Unknown'} DGB`);
    
    // 3) Then load all recent blocks
    console.log("\n=== PHASE 3: LOADING ALL RECENT BLOCKS ===");
    await fetchLatestBlocks(true); // Force fresh blocks load
    if (!recentBlocks.length) {
      throw new Error("Failed to load any blocks");
    }
    console.log(`✅ Successfully loaded ${recentBlocks.length} blocks`);
    console.log(`   - Latest Block: ${recentBlocks[0]?.height}`);
    console.log(`   - Oldest Block: ${recentBlocks[recentBlocks.length-1]?.height}`);
    
    // 4) Finally fetch peer data
    console.log("\n=== PHASE 4: LOADING PEER DATA ===");
    const peerData = await fetchPeersWithRetry();
    console.log(`✅ Successfully loaded peer data with ${uniqueNodes.length} nodes`);
    
    console.log("\n=== ALL DATA INITIALIZATION COMPLETE ===");
    console.log(`Server is now fully loaded with ${recentBlocks.length} blocks and ready to handle requests`);
    
    return true;
  } catch (error) {
    console.error("\n❌ CRITICAL ERROR DURING DATA INITIALIZATION:", error);
    return false;
  }
}

// Helper function for RPC retries
async function sendRpcWithRetry(method, params = [], maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await sendRpcRequest(method, params);
      if (result) {
        return result;
      }
      
      console.log(`RPC ${method} returned null on attempt ${attempt}/${maxRetries}, retrying...`);
      await new Promise(r => setTimeout(r, 1000));
    } catch (error) {
      lastError = error;
      console.error(`Error on attempt ${attempt}/${maxRetries} for ${method}:`, error.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  throw new Error(`Failed to execute ${method} after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

// ------------------------- MAIN SERVER STARTUP -------------------------
async function startServer() {
  try {
    // Add a status flag to track initialization
    let dataInitialized = false;
    
    console.log("=== DIGIBYTE STATS SERVER STARTING ===");
    
    // 1) Start HTTP server first to handle health checks during initialization
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(port, () => {
        console.log(`Server listening at http://localhost:${port}`);
        resolve(s);
      }).on('error', reject);
    });
    
    // Add route for checking initialization status
    app.get('/api/status', (req, res) => {
      res.json({
        initialized: dataInitialized,
        blockCount: recentBlocks.length,
        clientCount: connectedClients,
        uptime: Math.floor(process.uptime())
      });
    });
    
    // 2) Now initialize all data
    console.log("Starting data initialization...");
    const initSuccess = await initializeAllData();
    
    if (!initSuccess) {
      console.error("❌ FATAL ERROR: Failed to initialize data. Server will continue but may not function correctly.");
      // Don't exit - allow server to run with partial data if available
    } else {
      dataInitialized = true;
      console.log("✅ Server ready with all data initialized!");
    }
    
    // 3) Set up periodic refresh cycles (even if init failed for some data)
    console.log("Setting up periodic data refresh cycles...");
    
    // Update blocks every minute
    setInterval(() => {
      console.log("Running scheduled block update...");
      fetchLatestBlocks().catch(err => console.error("Error in block update:", err));
    }, 60000);
    
    // Update initial data every minute, offset by 30 seconds
    setTimeout(() => {
      setInterval(() => {
        console.log("Running scheduled initial data update...");
        fetchInitialData().catch(err => console.error("Error in initial data update:", err));
      }, 60000);
    }, 30000);
    
    // Update peers every 2 minutes
    setInterval(() => {
      console.log("Running scheduled peer data update...");
      fetchPeersWithRetry().catch(err => console.error("Error in peer update:", err));
    }, 120000);
    
    // Log cache stats every 5 minutes
    setInterval(() => {
      const stats = rpcCache.getStats();
      console.log(`RPC Cache stats - hits: ${stats.hits}, misses: ${stats.misses}, keys: ${Object.keys(rpcCache.keys()).length}`);
    }, 300000);
    
    console.log("All startup procedures complete!");

  } catch (error) {
    console.error('💥 CRITICAL ERROR DURING SERVER STARTUP:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
