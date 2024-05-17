const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const dns = require('dns');
const geoip = require('geoip-lite');
const NodeCache = require('node-cache');
const { router: rpcRoutes, sendRpcRequest, getAlgoName } = require('./rpc');

const app = express();
const port = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());
app.use('/api', rpcRoutes);

const wss = new WebSocket.Server({ port: 5002 });
const recentBlocks = [];
const maxRecentBlocks = 25;
const pingInterval = 30000; // Send a ping every 30 seconds

let uniqueIPs = new Set();
let cachedGeoData = [];

const cache = new NodeCache({ stdTTL: 60 }); // Cache data for 1 minute

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  // Send the cached recent blocks to the new client
  console.log('Sending recent blocks to client:', recentBlocks);
  ws.send(JSON.stringify({ type: 'recentBlocks', data: recentBlocks }));

  // Send the current cached geo data to the new client
  console.log('Sending current cached geo data to client:', cachedGeoData);
  ws.send(JSON.stringify({ type: 'geoData', data: cachedGeoData }));

  // Send the cached initial data to the new client
  const initialData = cache.get('initialData');
  if (initialData) {
    console.log('Sending initial data to client:', initialData);
    ws.send(JSON.stringify({ type: 'initialData', data: initialData }));
  }

  // Send ping messages to keep the connection alive
  const pingTimer = setInterval(() => {
    ws.ping();
  }, pingInterval);

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
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
    for (let i = 0; i < maxRecentBlocks; i++) {
      const blockHeight = latestBlockHeight - i;
      if (blockHeight < 0) break;

      const blockHash = await sendRpcRequest('getblockhash', [blockHeight]);
      const block = await sendRpcRequest('getblock', [blockHash]);

      const newBlock = {
        height: block.height,
        hash: block.hash,
        algo: getAlgoName(block.pow_algo),
        txCount: block.nTx,
        difficulty: block.difficulty,
      };

      console.log('Fetched block:', newBlock);
      recentBlocks.push(newBlock);
    }

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

app.post('/api/blocknotify', async (req, res) => {
  try {
    if (!req.body) {
      throw new Error('Request body is missing');
    }

    const blockHash = req.body.blockhash;
    console.log('Received block notification for:', blockHash);

    const block = await sendRpcRequest('getblock', [blockHash]);
    if (!block) {
      throw new Error('Failed to fetch block data');
    }

    const newBlock = {
      height: block.height,
      hash: block.hash,
      algo: getAlgoName(block.pow_algo),
      txCount: block.nTx,
      difficulty: block.difficulty,
    };

    console.log('New block data:', newBlock);

    // Store the new block in the recentBlocks array
    recentBlocks.unshift(newBlock);
    if (recentBlocks.length > maxRecentBlocks) {
      recentBlocks.pop();
    }

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

const cacheDuration = 60 * 60 * 1000; // 1 hour in milliseconds
const fetchInterval = 15 * 1000; // 15 seconds in milliseconds
let lastFetchTime = 0;

const fetchSeedNodes = async () => {
  let uniqueIPs = new Set();
  let cachedGeoData = [];

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

    // Add the fetched IPs to the uniqueIPs set
    addresses.forEach((ip) => uniqueIPs.add(ip));

    console.log('Unique IPs:', uniqueIPs);

    // Create new geo data array
    const newGeoData = Array.from(uniqueIPs).map((ip) => {
      const geo = geoip.lookup(ip);
      return {
        ip,
        country: geo?.country || 'Unknown',
        city: geo?.city || 'Unknown',
        lat: geo?.ll[0] || 0,
        lon: geo?.ll[1] || 0,
      };
    });

    console.log('New geo data:', newGeoData);

    // Check if there are any changes in the geo data
    if (JSON.stringify(newGeoData) !== JSON.stringify(cachedGeoData)) {
      // Update the cached geo data
      cachedGeoData = newGeoData;

      // Send the updated geo data to the connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'geoData', data: cachedGeoData }));
        }
      });
    }

    lastFetchTime = Date.now();
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