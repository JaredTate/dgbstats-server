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
    // 1) Get chain tip
    const blockchainInfo = await sendRpcRequest('getblockchaininfo');
    const latestBlockHeight = blockchainInfo.blocks;
    console.log('Latest block height:', latestBlockHeight);

    // 2) Get blocks from last hour
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const blocksBasic = await getBlocksByTimeRange(oneHourAgo, latestBlockHeight);

    // 3) For each block, fetch full data
    const fetchedFullBlocks = [];
    for (const b of blocksBasic) {
      const fullBlock = await sendRpcRequest('getblock', [b.hash, 2]);
      if (!fullBlock || !fullBlock.tx?.[0]) continue;

      const coinbaseTx = fullBlock.tx[0];
      const firstOutputWithAddress = coinbaseTx.vout?.find(
        (out) => out?.scriptPubKey?.address
      );
      const minerAddress = firstOutputWithAddress
        ? firstOutputWithAddress.scriptPubKey.address
        : '';

      const { poolIdentifier } = decodeCoinbaseData(coinbaseTx.vin[0].coinbase);
      const taprootSignaling = (fullBlock.version & (1 << 2)) !== 0;

      fetchedFullBlocks.push({
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
      });
    }

    // 4) Sort descending by height, keep up to 240
    recentBlocks.push(...fetchedFullBlocks);
    recentBlocks.sort((a, b) => b.height - a.height);
    recentBlocks.splice(maxRecentBlocks);

    console.log(`Loaded ${recentBlocks.length} preloaded blocks.`);
  } catch (error) {
    console.error('Error fetching latest blocks:', error);
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
    const blockchainInfo = await sendRpcRequest('getblockchaininfo');
    const chainTxStats = await sendRpcRequest('getchaintxstats');
    const txOutsetInfo = await sendRpcRequest('gettxoutsetinfo');
    const blockRewardResponse = await sendRpcRequest('getblockreward');
    const blockReward = parseFloat(blockRewardResponse.blockreward);

    const initialData = {
      blockchainInfo,
      chainTxStats,
      txOutsetInfo,
      blockReward
    };

    // 1) Store in NodeCache (optional)
    cache.set('initialData', initialData);

    // 2) Also store in memory (so we never lose it)
    inMemoryInitialData = initialData;

    // 3) Broadcast to existing clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'initialData', data: initialData }));
      }
    });
  } catch (error) {
    console.error('Error fetching initial data:', error);

    // NOTE: We do NOT clear inMemoryInitialData on error.
    // So we keep showing old data to users until a successful fetch.
  }
}

/* ------------------------------------------------------------------
 * GETPEERS + GEO STUFF
 * ------------------------------------------------------------------ */
app.get('/api/getpeers', (req, res) => {
  // First check if we have cached peer data (10 minute cache)
  const cachedPeers = peerCache.get('peerData');
  if (cachedPeers) {
    console.log('Using cached peer data (expires in', Math.floor(peerCache.getTtl('peerData') / 1000), 'seconds)');
    return res.json(cachedPeers);
  }
  
  console.log('No cached peer data found, fetching fresh data...');
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

// ------------------------- CACHE STATUS ENDPOINT -------------------------
app.get('/api/cachestatus', (req, res) => {
  const peerCacheInfo = {
    hasPeerData: peerCache.has('peerData'),
    hasGeoNodes: peerCache.has('geoNodes'),
    peerTtl: peerCache.has('peerData') ? Math.floor((peerCache.getTtl('peerData') - Date.now()) / 1000) : null,
    geoNodesTtl: peerCache.has('geoNodes') ? Math.floor((peerCache.getTtl('geoNodes') - Date.now()) / 1000) : null,
    peerCount: uniqueNodes.length,
  };

  const rpccacheInfo = {
    stats: rpcCache ? getCacheStats() : null
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

// ------------------------- STARTUP LOGIC -------------------------
async function fetchPeersWithRetry() {
  const maxRetries = 3;
  const retryDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Optionally check if server is ready
      const healthCheck = await axios.get(`http://localhost:${port}/health`).catch(() => null);
      if (!healthCheck) {
        console.log(`Server not ready, attempt ${attempt}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }

      const response = await axios.get(`http://localhost:${port}/api/getpeers`);
      console.log('Successfully fetched peers data');
      return response.data;
    } catch (error) {
      console.log(`Peer fetch attempt ${attempt}/${maxRetries} failed`);
      if (attempt === maxRetries) {
        console.error('Max retries reached for peer fetch');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  // If all attempts failed but we have cached data, use that
  if (peerCache.has('peerData')) {
    console.log('All fetch attempts failed, using cached peer data');
    return peerCache.get('peerData');
  }

  throw new Error('Failed to fetch peer data');
}

// ------------------------- MAIN SERVER STARTUP -------------------------
async function startServer() {
  try {
    console.log('Starting DigiByte Stats server...');

    // 1) Start the server
    const server = app.listen(port, () => {
      console.log(`Server listening at http://localhost:${port}`);
    });

    // 2) Initialize data in parallel:
    console.log('Phase 1: Fetching initial data...');
    await Promise.all([
      fetchInitialData(),    // stores in memory + broadcasts
      fetchLatestBlocks()    // populates recentBlocks
    ]);
    console.log('Essential blockchain data loaded successfully');

    console.log('Phase 2: Preloading peer data...');
    await fetchPeersWithRetry();
    console.log('Peer data loaded successfully');

    // 3) Periodic updates:
    console.log('Setting up periodic data refresh cycles...');
    setInterval(fetchInitialData, 60000); // Every minute
    setInterval(fetchLatestBlocks, 60000); // Every minute
    setInterval(fetchPeersWithRetry, 600000); // Every 10 minutes for peers

    console.log(`Ready to serve with ${recentBlocks.length} blocks and ${uniqueNodes.length} peers`);
  } catch (error) {
    console.error('Error during startup:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
