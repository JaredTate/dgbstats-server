const express = require('express');
const cors = require('cors');
const axios = require('axios');
const geoip = require('geoip-lite');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 5001;

// Replace with your DigiByte RPC credentials and URL
const rpcUser = 'user';
const rpcPassword = 'password';
const rpcUrl = 'http://localhost:14044';

app.use(cors());
app.use(express.json());

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

    return response.data.result;
  } catch (error) {
    console.error('Error sending RPC request:', error.message);
    console.error('Error details:', error.response.data);
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

app.get('/api/getblockchaininfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('getblockchaininfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getblockchaininfo:', error);
    res.status(500).json({ error: 'Error fetching blockchain info' });
  }
});

app.get('/api/getpeerinfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('getpeerinfo');
    
    const nodesWithGeoData = data.map((node) => {
      const ip = node.addr.split(':')[0];
      const geo = geoip.lookup(ip) || {};
      const newNode = {
        ...node,
        lat: geo.ll && geo.ll[0],
        lon: geo.ll && geo.ll[1],
        city: geo.city, // Add city information
        country: geo.country, // Add country information
      };
      return newNode;
    });
    
    res.json(nodesWithGeoData);
  } catch (error) {
    console.error('Error in /api/getpeerinfo:', error);
    res.status(500).json({ error: 'Error fetching peer info' });
  }
});



app.get('/api/getblockreward', async (req, res) => {
  try {
    const data = await sendRpcRequest('getblockreward');
    res.json({ blockReward: data });
  } catch (error) {
    console.error('Error in /api/getblockreward:', error);
    res.status(500).json({ error: 'Error fetching transaction output set info' });
  }
});

app.get('/api/getlatestblock', async (req, res) => {
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
      difficulty: block.difficulty, // Add this line
    };
    
    res.json(latestBlockInfo);
  } catch (error) {
    console.error('Error fetching latest block:', error);
    res.status(500).json({ error: 'Error fetching latest block', details: error.message, stack: error.stack });
  }
});

app.get('/api/getchaintxstats', async (req, res) => {
  try {
    const data = await sendRpcRequest('getchaintxstats');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getchaintxstats:', error);
    res.status(500).json({ error: 'Error fetching chain transaction stats' });
  }
});

app.get('/api/gettxoutsetinfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('gettxoutsetinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/gettxoutsetinfo:', error);
    res.status(500).json({ error: 'Error fetching transaction output set info' });
  }
});

const wss = new WebSocket.Server({ port: 5002 });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  // Send block notifications to the connected client
  const notifyBlock = (block) => {
    ws.send(JSON.stringify(block));
  };

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});
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

    // Notify connected WebSocket clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        console.log('Sending block data to client:', newBlock);
        client.send(JSON.stringify(newBlock));
      }
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing block notification:', error);
    res.sendStatus(500);
  }
});


app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});