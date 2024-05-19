const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const dns = require('dns');
const geoip = require('geoip-lite');
const NodeCache = require('node-cache');
const sqlite3 = require('sqlite3').verbose();
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

// Fetch initial data every 1 minute
setInterval(fetchInitialData, 60000);

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
const fetchInterval = 30 * 1000; // 30 seconds in milliseconds

const fetchSeedNodes = async () => {
  try {
    const addresses = await new Promise((resolve, reject) => {
      dns.resolve4('seed.digibyte.io', (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });

    console.log('Fetched addresses:', addresses);

    // Insert or update the fetched IPs in the database
    const stmt = db.prepare(`INSERT OR REPLACE INTO nodes (ip, country, city, lat, lon, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)`);

    addresses.forEach((ip) => {
      const geo = geoip.lookup(ip);
      stmt.run(ip, geo?.country || 'Unknown', geo?.city || 'Unknown', geo?.ll[0] || 0, geo?.ll[1] || 0, Date.now());
    });

    stmt.finalize();

    // Retrieve all unique nodes from the database
    db.all('SELECT * FROM nodes', (err, rows) => {
      if (err) {
        console.error('Error retrieving nodes from database:', err);
        return;
      }

      console.log('All unique nodes:', rows);
      uniqueNodes = rows;

      // Check if the number of unique nodes has increased
      if (uniqueNodes.length > lastUniqueNodesCount) {
        console.log(`Unique nodes count increased from ${lastUniqueNodesCount} to ${uniqueNodes.length}`);
        lastUniqueNodesCount = uniqueNodes.length;
      } else {
        console.log(`Unique nodes count remains at ${uniqueNodes.length}`);
      }

      // Send the updated geo data to the connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'geoData', data: uniqueNodes }));
        }
      });
    });
  } catch (error) {
    console.error('Error fetching seed nodes:', error);
  }
};

const startFetchingData = () => {
  setInterval(async () => {
    await fetchSeedNodes();
  }, fetchInterval);
};

startFetchingData();

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});