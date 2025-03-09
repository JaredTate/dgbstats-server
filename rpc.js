const express = require('express');
const axios = require('axios');
const geoip = require('geoip-lite');
const router = express.Router();

// Replace with your DigiByte RPC credentials and URL
const rpcUser = 'user';
const rpcPassword = 'password';
const rpcUrl = 'http://127.0.0.1:14044';

const sendRpcRequest = async (method, params = []) => {
  try {
    const response = await axios.post(
      rpcUrl,
      {
        jsonrpc: '1.0',
        id: 'dgb_rpc',
        method: method,
        params: params,
      },
      {
        auth: {
          username: rpcUser,
          password: rpcPassword,
        },
      }
    );

    if (response.data.error) {
      throw new Error(`RPC Error: ${JSON.stringify(response.data.error)}`);
    }

    return response.data.result;
  } catch (error) {
    console.error('Error sending RPC request:', error.message);
    console.error('Error details:', error.response ? JSON.stringify(error.response.data) : error);
    return null;
  }
};

function getAlgoName(algo) {
  switch (algo) {
    case 'sha256d':
      return 'SHA256D';
    case 'scrypt':
      return 'Scrypt';
    case 'skein':
      return 'Skein';
    case 'qubit':
      return 'Qubit';
    case 'odo':
      return 'Odo';
    default:
      return 'Unknown';
  }
}

async function getBlocksByTimeRange(startTimestamp, endBlockHeight) {
  const blocks = [];
  let currentBlockHash = await sendRpcRequest('getblockhash', [endBlockHeight]);

  while (currentBlockHash) {
    const block = await sendRpcRequest('getblock', [currentBlockHash, 2]);

    if (!block) {
      console.error(`Failed to fetch block data for block hash: ${currentBlockHash}`);
      currentBlockHash = await sendRpcRequest('getblockhash', [endBlockHeight - 1]);
      endBlockHeight--;
      continue;
    }

    if (block.time < startTimestamp) {
      break;
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

    blocks.push({
      height: block.height,
      hash: block.hash,
      algo: getAlgoName(block.pow_algo),
      txCount: block.nTx,
      difficulty: block.difficulty,
      timestamp: block.time,
      minedTo,
      poolIdentifier,
    });

    currentBlockHash = block.previousblockhash;
  }

  return blocks;
}

router.get('/getblockchaininfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('getblockchaininfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getblockchaininfo:', error);
    res.status(500).json({ error: 'Error fetching blockchain info' });
  }
});

router.get('/getpeerinfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('getpeerinfo');
    const nodesWithGeoData = data.map((node) => {
      const ip = node.addr.split(':')[0];
      const geo = geoip.lookup(ip) || {};
      const newNode = {
        ...node,
        lat: geo.ll && geo.ll[0],
        lon: geo.ll && geo.ll[1],
        city: geo.city,
        country: geo.country,
      };
      return newNode;
    });
    res.json(nodesWithGeoData);
  } catch (error) {
    console.error('Error in /api/getpeerinfo:', error);
    res.status(500).json({ error: 'Error fetching peer info' });
  }
});

router.get('/getblockreward', async (req, res) => {
  try {
    const data = await sendRpcRequest('getblockreward');
    res.json({ blockReward: data });
  } catch (error) {
    console.error('Error in /api/getblockreward:', error);
    res.status(500).json({ error: 'Error fetching block reward' });
  }
});

router.get('/getlatestblock', async (req, res) => {
  try {
    const latestBlockHash = await sendRpcRequest('getbestblockhash');
    if (!latestBlockHash) {
      throw new Error('Failed to fetch latest block hash');
    }
    const block = await sendRpcRequest('getblock', [latestBlockHash]);
    if (!block) {
      throw new Error('Failed to fetch block data');
    }
    const latestBlockInfo = {
      height: block.height,
      hash: block.hash,
      algo: block.pow_algo,
      txCount: block.nTx,
      difficulty: block.difficulty,
    };
    res.json(latestBlockInfo);
  } catch (error) {
    console.error('Error fetching latest block:', error);
    res.status(500).json({ error: 'Error fetching latest block', details: error.message, stack: error.stack });
  }
});

router.get('/getchaintxstats', async (req, res) => {
  try {
    const data = await sendRpcRequest('getchaintxstats');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getchaintxstats:', error);
    res.status(500).json({ error: 'Error fetching chain transaction stats' });
  }
});

router.get('/gettxoutsetinfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('gettxoutsetinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/gettxoutsetinfo:', error);
    res.status(500).json({ error: 'Error fetching transaction output set info' });
  }
});

module.exports = {
  router,
  sendRpcRequest,
  getAlgoName,
  getBlocksByTimeRange,
};