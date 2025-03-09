const express = require('express');
const axios = require('axios');
const geoip = require('geoip-lite');
const router = express.Router();
const NodeCache = require('node-cache');
const crypto = require('crypto');

// Create a shared cache for all RPC requests - 1 minute TTL by default
const rpcCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

// Stats tracking for monitoring
let totalRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

// Replace with your DigiByte RPC credentials and URL
const rpcUser = 'user';
const rpcPassword = 'password';
const rpcUrl = 'http://127.0.0.1:14044';

// Limit concurrent RPC requests to avoid overloading
let pendingRequests = 0;
const MAX_CONCURRENT_REQUESTS = 4;

// Enhanced RPC function with caching and rate limiting
const sendRpcRequest = async (method, params = [], skipCache = false) => {
  totalRequests++;
  
  try {
    // Generate a unique cache key based on method and parameters
    const cacheKey = `rpc:${method}:${crypto.createHash('md5').update(JSON.stringify(params)).digest('hex')}`;
    
    // Check cache first (unless skipCache is true)
    if (!skipCache) {
      const cachedResult = rpcCache.get(cacheKey);
      if (cachedResult !== undefined) {
        cacheHits++;
        return cachedResult;
      }
    }
    
    // Cache miss
    cacheMisses++;
    
    // Simple rate limiting
    while (pendingRequests >= MAX_CONCURRENT_REQUESTS) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Track pending requests
    pendingRequests++;
    
    // Make the actual RPC call
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
        timeout: 30000, // 30 second timeout
      }
    );

    // Done with this request
    pendingRequests--;

    if (response.data.error) {
      throw new Error(`RPC Error: ${JSON.stringify(response.data.error)}`);
    }
    
    // Get result
    const result = response.data.result;
    
    // Cache the result with appropriate TTL based on method
    let ttl = 60; // Default: 60 seconds
    
    // Adjust TTL based on command type
    if (method === 'getblock' || method === 'getblockhash') {
      ttl = 3600; // Blocks don't change - cache for 1 hour
    }
    else if (method === 'gettxoutsetinfo') {
      ttl = 300; // Heavy command - cache for 5 minutes
    }
    
    rpcCache.set(cacheKey, result, ttl);
    
    return result;
  } catch (error) {
    pendingRequests--; // Make sure we decrement on error too
    
    console.error(`RPC Error (${method}):`, error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    
    // Return cached value if available (even if expired)
    if (!skipCache) {
      const cacheKey = `rpc:${method}:${crypto.createHash('md5').update(JSON.stringify(params)).digest('hex')}`;
      const cachedResult = rpcCache.get(cacheKey, true); // Get even if expired
      if (cachedResult !== undefined) {
        console.log(`Returning stale cached result for ${method} due to error`);
        return cachedResult;
      }
    }
    
    return null;
  }
};

// Get cache statistics
function getCacheStats() {
  return {
    keys: rpcCache.keys().length,
    hits: cacheHits,
    misses: cacheMisses,
    total: totalRequests,
    hitRate: totalRequests > 0 ? (cacheHits / totalRequests * 100).toFixed(1) + '%' : '0%',
    pendingRequests
  };
}

// Reset cache stats
function resetCacheStats() {
  totalRequests = 0;
  cacheHits = 0;
  cacheMisses = 0;
}

// Get algo name
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

// Enhanced getBlocksByTimeRange with better caching and error handling
async function getBlocksByTimeRange(startTimestamp, endBlockHeight, maxBlocks = 240) {
  // Create cache key for the entire result
  const cacheKey = `blocks:range:${startTimestamp}:${endBlockHeight}:${maxBlocks}`;
  
  // Check cache first
  const cachedBlocks = rpcCache.get(cacheKey);
  if (cachedBlocks) {
    return cachedBlocks;
  }
  
  console.log(`Fetching blocks from ${endBlockHeight} (past ${startTimestamp})`);
  
  // Process in batches to avoid overwhelming RPC server
  const blocks = [];
  const batchSize = 20;
  let currentHeight = endBlockHeight;
  let attemptsRemaining = Math.min(500, maxBlocks * 1.2); // Safety to prevent infinite loops
  let blocksToFetch = maxBlocks;
  
  while (blocks.length < maxBlocks && attemptsRemaining > 0 && currentHeight > 0) {
    try {
      // Fetch batch of block hashes
      const batchHashes = [];
      for (let i = 0; i < Math.min(batchSize, blocksToFetch); i++) {
        const hash = await sendRpcRequest('getblockhash', [currentHeight--]);
        if (hash) {
          batchHashes.push(hash);
        }
        attemptsRemaining--;
      }
      
      // Now fetch block data for each hash
      for (const hash of batchHashes) {
        const block = await sendRpcRequest('getblock', [hash, 2]);
        
        if (!block) continue;
        
        // Check if block is older than startTimestamp
        if (block.time < startTimestamp && startTimestamp > 0) {
          break;
        }
        
        // Process block
        let minedTo = '';
        let poolIdentifier = 'Unknown';

        if (block.tx && block.tx.length > 0) {
          const coinbaseTx = block.tx[0];
          
          // First try to find any output with an address
          const firstOutputWithAddress = coinbaseTx.vout?.find(
            output => output?.scriptPubKey?.address
          );
          
          if (firstOutputWithAddress) {
            minedTo = firstOutputWithAddress.scriptPubKey.address;
          } else if (coinbaseTx.vout && coinbaseTx.vout.length > 1 && 
                   coinbaseTx.vout[1].scriptPubKey && 
                   coinbaseTx.vout[1].scriptPubKey.address) {
            minedTo = coinbaseTx.vout[1].scriptPubKey.address;
          }

          // Process coinbase transaction
          const coinbaseHex = coinbaseTx.vin[0].coinbase;
          try {
            const decodedCoinbase = Buffer.from(coinbaseHex, 'hex').toString('utf8', 0, 100);
            
            // Try multiple regex patterns
            const patterns = [
              /\/(.*?)\//,             // /PoolName/
              /\[(.*?)\]/,             // [PoolName]
              /@(.*?)@/,               // @PoolName@
              /pool\.(.*?)\.com/i,     // pool.Name.com
              /(.*?)pool/i,            // Namepool
            ];
            
            for (const regex of patterns) {
              const match = decodedCoinbase.match(regex);
              if (match && match[1] && match[1].length > 2) {
                poolIdentifier = match[1].trim();
                break;
              }
            }
          } catch (e) {
            // Ignore coinbase parsing errors
          }
        }
        
        // Check for taproot signaling
        const taprootSignaling = (block.version & (1 << 2)) !== 0;
        
        blocks.push({
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
        });
        
        blocksToFetch--;
        
        if (blocks.length >= maxBlocks) {
          break;
        }
      }
      
      // Add small pause between batches
      if (blocks.length < maxBlocks && currentHeight > 0) {
        await new Promise(r => setTimeout(r, 200));
      }
      
    } catch (error) {
      console.error('Error while fetching blocks:', error);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  // Sort blocks by height (descending)
  blocks.sort((a, b) => b.height - a.height);
  
  // Cache result for 5 minutes
  if (blocks.length > 0) {
    rpcCache.set(cacheKey, blocks, 300);
    console.log(`Cached ${blocks.length} blocks from heights ${blocks[0].height} to ${blocks[blocks.length-1].height}`);
  }
  
  return blocks;
}

// Preload essential data at startup
async function preloadEssentialData() {
  console.log('Preloading essential blockchain data...');
  
  try {
    // 1. Get blockchain info
    console.log('Loading blockchain info');
    const blockchainInfo = await sendRpcRequest('getblockchaininfo', [], true);
    if (!blockchainInfo) throw new Error('Failed to load blockchain info');
    
    // 2. Get transaction stats
    console.log('Loading chain transaction stats');
    const chainTxStats = await sendRpcRequest('getchaintxstats', [], true);
    
    // 3. Get tx outset info (this is expensive)
    console.log('Loading transaction outset info (this may take a while)');
    const txOutsetInfo = await sendRpcRequest('gettxoutsetinfo', [], true);
    
    // 4. Get block reward
    console.log('Loading block reward info');
    const blockReward = await sendRpcRequest('getblockreward', [], true);
    
    // 5. Get latest blocks
    console.log('Loading recent blocks');
    const latestBlockHeight = blockchainInfo.blocks;
    // Use 0 for startTimestamp to ignore time filter and just get the most recent blocks
    const blocks = await getBlocksByTimeRange(0, latestBlockHeight, 240);
    
    console.log('Essential data preloading complete!');
    console.log(`- Blockchain height: ${blockchainInfo.blocks}`);
    console.log(`- Loaded ${blocks.length} recent blocks`);
    console.log(`- Transaction outset: ${txOutsetInfo ? 'Success' : 'Failed'}`);
    console.log(`- Block reward: ${blockReward || 'Unknown'}`);
    
    return {
      blockchainInfo,
      chainTxStats,
      txOutsetInfo,
      blockReward,
      blocks,
      success: true
    };
  } catch (error) {
    console.error('Error during preloading essential data:', error);
    return { success: false, error: error.message };
  }
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

// Add stats endpoint to check cache status
router.get('/rpccachestats', (req, res) => {
  const stats = getCacheStats();
  res.json(stats);
});

// Add endpoint to manually refresh specific cache data
router.post('/refreshcache', async (req, res) => {
  try {
    const { type } = req.body || {};
    
    if (!type) {
      return res.status(400).json({ error: 'Missing type parameter' });
    }
    
    let result;
    
    switch (type) {
      case 'blockchain':
        result = await sendRpcRequest('getblockchaininfo', [], true);
        break;
      case 'txstats':
        result = await sendRpcRequest('getchaintxstats', [], true);
        break;
      case 'txoutset':
        result = await sendRpcRequest('gettxoutsetinfo', [], true);
        break;
      case 'blockreward':
        result = await sendRpcRequest('getblockreward', [], true);
        break;
      case 'blocks':
        const blockchainInfo = await sendRpcRequest('getblockchaininfo', []);
        result = await getBlocksByTimeRange(0, blockchainInfo.blocks, 240);
        break;
      default:
        return res.status(400).json({ error: 'Invalid type parameter' });
    }
    
    res.json({ success: true, type, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = {
  router,
  sendRpcRequest,
  getAlgoName,
  getBlocksByTimeRange,
  preloadEssentialData,
  getCacheStats,
  resetCacheStats,
  rpcCache
};