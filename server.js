const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const dns = require('dns');
const geoip = require('geoip-lite');
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

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  // Send the cached recent blocks to the new client
  console.log('Sending recent blocks to client:', recentBlocks);
  ws.send(JSON.stringify({ type: 'recentBlocks', data: recentBlocks }));

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
let cachedData = [];
let lastFetchTime = 0;

app.get('/api/seedNodes', async (req, res) => {
  res.json(cachedData);
});

const fetchSeedNodes = async () => {
  try {
    const addresses = await new Promise((resolve, reject) => {
      dns.resolveAny('seed.digibyte.io', (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });

    const newAddresses = addresses.filter((address) => address.type === 'A');
    const uniqueAddresses = newAddresses.filter((address) => !cachedData.some((node) => node.ip === address.address));

    const newGeoData = uniqueAddresses.map((address) => {
      const geo = geoip.lookup(address.address);
      return {
        ip: address.address,
        country: geo?.country || 'Unknown',
        city: geo?.city || 'Unknown',
        lat: geo?.ll[0] || 0,
        lon: geo?.ll[1] || 0,
      };
    });

    cachedData = [...cachedData, ...newGeoData];
    cachedData = [...new Set(cachedData.map(JSON.stringify))].map(JSON.parse);
    lastFetchTime = Date.now();
  } catch (error) {
    console.error('Error fetching seed nodes:', error);
  }
};

const startFetchingData = () => {
  setInterval(async () => {
    const currentTime = Date.now();
    if (currentTime - lastFetchTime >= cacheDuration) {
      cachedData = []; // Clear the cache if it's expired
    }
    await fetchSeedNodes();
  }, fetchInterval);
};

startFetchingData();

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});