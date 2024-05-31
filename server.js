const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const geoip = require('geoip-lite');
const NodeCache = require('node-cache');
const sqlite3 = require('sqlite3').verbose();
const { exec } = require('child_process');
const path = require('path');
const axios = require('axios');
const { router: rpcRoutes, sendRpcRequest, getAlgoName, getBlocksByTimeRange } = require('./rpc');

const app = express();
const port = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());
app.use('/api', rpcRoutes);

const wss = new WebSocket.Server({ port: 5002 });
const recentBlocks = [];
const maxRecentBlocks = 240;
const pingInterval = 30000; // Send a ping every 30 seconds

const cache = new NodeCache({ stdTTL: 60 }); // Cache data for 1 minute

// Create a SQLite database connection
const db = new sqlite3.Database('nodes.db');

// Create a table to store unique IPs if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS nodes (
  ip TEXT PRIMARY KEY,
  country TEXT,
  city TEXT,
  lat REAL,
  lon REAL
)`);

// Create a table to store visit logs if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Create a table to store unique IP addresses if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS unique_ips (
  ip TEXT PRIMARY KEY
)`);

let uniqueNodes = [];
let lastUniqueNodesCount = 0;

let connectedClients = 0;

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  connectedClients++;
  console.log(`Number of connected clients: ${connectedClients}`);

  // Send the cached recent blocks to the new client
  console.log('Sending recent blocks to client:', recentBlocks);
  ws.send(JSON.stringify({ type: 'recentBlocks', data: recentBlocks }));

  // Send the cached initial data to the new client
  const initialData = cache.get('initialData');
  if (initialData) {
    console.log('Sending initial data to client:', initialData);
    ws.send(JSON.stringify({ type: 'initialData', data: initialData }));
  }

  // Send all unique nodes to the new client
  console.log('Sending all unique nodes to client:', uniqueNodes);
  ws.send(JSON.stringify({ type: 'geoData', data: uniqueNodes }));

  // Send ping messages to keep the connection alive
  const pingTimer = setInterval(() => {
    ws.ping();
  }, pingInterval);

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    connectedClients--;
    console.log(`Number of connected clients: ${connectedClients}`);
    clearInterval(pingTimer);
  });
});

// Function to fetch the latest blocks from the server and store them in the recentBlocks array
async function fetchLatestBlocks() {
  try {
    const latestBlocks = await sendRpcRequest('getblockchaininfo');
    const latestBlockHeight = latestBlocks.blocks;

    console.log('Latest block height:', latestBlockHeight);

    // Fetch the most recent blocks
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const blocks = await getBlocksByTimeRange(oneHourAgo, latestBlockHeight);

    recentBlocks.push(...blocks);
    recentBlocks.sort((a, b) => b.height - a.height);
    recentBlocks.splice(maxRecentBlocks);

    console.log('Fetched recent blocks:', recentBlocks);
  } catch (error) {
    console.error('Error fetching latest blocks:', error);
  }
}
// Fetch the latest blocks when the server starts
fetchLatestBlocks();

const fetchInitialData = async () => {
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
      blockReward,
    };

    cache.set('initialData', initialData);

    // Send the updated initial data to all connected clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'initialData', data: initialData }));
      }
    });
  } catch (error) {
    console.error('Error fetching initial data:', error);
  }
};

// Fetch initial data when the server starts
fetchInitialData();

// Fetch initial data every 30 Seconds
setInterval(fetchInitialData, 30000);

// server.js
app.post('/api/blocknotify', async (req, res) => {
  try {
    if (!req.body) {
      throw new Error('Request body is missing');
    }

    const blockHash = req.body.blockhash;
    console.log('Received block notification for:', blockHash);

    const block = await sendRpcRequest('getblock', [blockHash, 2]);
    if (!block) {
      console.error(`Failed to fetch block data for block hash: ${blockHash}`);
      res.sendStatus(200);
      return;
    }

    let minedTo = '';
    let poolIdentifier = 'Unknown';

    if (block.tx && block.tx.length > 0) {
      const coinbaseTx = block.tx[0];
      if (coinbaseTx.vout && coinbaseTx.vout.length > 1 && coinbaseTx.vout[1].scriptPubKey && coinbaseTx.vout[1].scriptPubKey.address) {
        minedTo = coinbaseTx.vout[1].scriptPubKey.address;
      }

      // Extract pool identifier from coinbase transaction
      const coinbaseHex = coinbaseTx.vin[0].coinbase;
      const decodedCoinbase = Buffer.from(coinbaseHex, 'hex').toString('ascii');
      const poolIdentifierRegex = /\/(.*)\//;
      const match = decodedCoinbase.match(poolIdentifierRegex);
      if (match && match[1]) {
        poolIdentifier = match[1];
      }
    }

    const newBlock = {
      height: block.height,
      hash: block.hash,
      algo: getAlgoName(block.pow_algo),
      txCount: block.nTx,
      difficulty: block.difficulty,
      timestamp: block.time,
      minedTo,
      poolIdentifier,
    };

    console.log('New block data:', newBlock);

    // Store the new block in the recentBlocks array
    recentBlocks.unshift(newBlock);
    recentBlocks.splice(maxRecentBlocks);

    // Notify connected WebSocket clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        console.log('Sending new block to client:', newBlock);
        client.send(JSON.stringify({ type: 'newBlock', data: newBlock }));
      }
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing block notification:', error);
    res.sendStatus(500);
  }
});

app.get('/api/getpeers', (req, res) => {
  const pythonScriptPath = path.join(__dirname, 'parse_peers_dat.py');
  const peersDatPath = '/Users/jt/Library/Application Support/DigiByte/peers.dat';

  exec(`python3 ${pythonScriptPath} ${peersDatPath}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing Python script: ${error.message}`);
      res.status(500).json({ error: 'Error executing Python script' });
      return;
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
          lat: geo?.ll[0] || 0,
          lon: geo?.ll[1] || 0,
        };
      });

      // Update the unique nodes in the database
      db.serialize(() => {
        // Clear the existing nodes table
        db.run('DELETE FROM nodes', (err) => {
          if (err) {
            console.error('Error clearing nodes table:', err);
            res.status(500).json({ error: 'Error clearing nodes table' });
            return;
          }

          // Insert the new unique nodes into the database
          const stmt = db.prepare(`INSERT INTO nodes (ip, country, city, lat, lon)
            VALUES (?, ?, ?, ?, ?)`);

          geoData.forEach((node) => {
            stmt.run(node.ip, node.country, node.city, node.lat, node.lon);
          });

          stmt.finalize((err) => {
            if (err) {
              console.error('Error inserting nodes into database:', err);
              res.status(500).json({ error: 'Error inserting nodes into database' });
              return;
            }

            // Retrieve all unique nodes from the database
            db.all('SELECT * FROM nodes', (err, rows) => {
              if (err) {
                console.error('Error retrieving nodes from database:', err);
                res.status(500).json({ error: 'Error retrieving nodes from database' });
                return;
              }

              console.log('All unique nodes:', rows);
              uniqueNodes = rows;

              // Send the updated geo data to the connected clients
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
      res.status(500).json({ error: 'Error parsing Python script output' });
    }
  });
});

const fetchInterval = 30 * 1000; // 30 seconds in milliseconds

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

// Middleware to log visits
app.use((req, res, next) => {
  const ip = req.ip;
  db.run('INSERT INTO visits (ip) VALUES (?)', [ip], (err) => {
    if (err) {
      console.error('Error inserting visit log:', err);
    }
    // Check if the IP address is unique and insert it into the unique_ips table
    db.run('INSERT OR IGNORE INTO unique_ips (ip) VALUES (?)', [ip], (err) => {
      if (err) {
        console.error('Error inserting unique IP:', err);
      }
      next();
    });
  });
});

// API endpoint to get visit statistics
app.get('/api/visitstats', (req, res) => {
  db.all(`
    SELECT
      (SELECT COUNT(*) FROM visits WHERE timestamp > datetime('now', '-30 days')) AS visitsLast30Days,
      (SELECT COUNT(*) FROM visits) AS totalVisits,
      (SELECT COUNT(*) FROM unique_ips) AS uniqueVisitors
  `, (err, rows) => {
    if (err) {
      console.error('Error retrieving visit stats:', err);
      res.status(500).json({ error: 'Error retrieving visit stats' });
      return;
    }
    res.json(rows[0]);
  });
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});