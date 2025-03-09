const express = require('express');
const axios = require('axios');
const geoip = require('geoip-lite');
const router = express.Router();
const NodeCache = require('node-cache');
const crypto = require('crypto');

// Add RPC caching within rpc.js - increase TTLs for better caching
const rpcCache = new NodeCache({ stdTTL: 60 }); // 10 minutes default TTL

// Replace with your DigiByte RPC credentials and URL
const rpcUser = 'user';
const rpcPassword = 'password';
const rpcUrl = 'http://127.0.0.1:14044';

// Improved queue management for RPC calls
const rpcQueue = [];
let processingQueue = false;
const MAX_CONCURRENT_CALLS = 8; // Reduce from 8 to 4
let activeRpcCalls = 0;

// Process the RPC queue
async function processRpcQueue() {
  if (processingQueue) return;
  processingQueue = true;
  
  console.log(`RPC queue length: ${rpcQueue.length}, active calls: ${activeRpcCalls}`);
  
  // Process priority items first, then regular items
  while (rpcQueue.length > 0 && activeRpcCalls < MAX_CONCURRENT_CALLS) {
    // Find next item (priority items first)
    let nextItemIndex = rpcQueue.findIndex(item => item.priority === true);
    if (nextItemIndex === -1) {
      // No priority items, take next regular item
      nextItemIndex = 0;
    }
    
    const { method, params, resolve, reject, timeout = 15000 } = rpcQueue.splice(nextItemIndex, 1)[0];
    
    try {
      activeRpcCalls++;
      // Execute with timeout
      const result = await Promise.race([
        executeRpcCall(method, params),
        new Promise((_, timeoutReject) => 
          setTimeout(() => timeoutReject(new Error(`RPC timeout after ${timeout}ms`)), timeout)
        )
      ]);
      
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      activeRpcCalls--;
    }
    
    // Small delay between processing queue items
    await new Promise(r => setTimeout(r, 50));
  }
  
  processingQueue = false;
  
  // If there are more items and we're not processing, process again
  if (rpcQueue.length > 0) {
    processRpcQueue();
  }
}

// Execute the actual RPC call
async function executeRpcCall(method, params) {
  try {
    console.log(`Executing RPC: ${method}`, params ? params.slice(0, 1) : []);
    
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
        timeout: 15000, // 15 second timeout for RPC calls
      }
    );
    
    if (response.data.error) {
      throw new Error(`RPC Error: ${JSON.stringify(response.data.error)}`);
    }

    return response.data.result;
  } catch (error) {
    console.error('RPC Error:', error.message);
    throw error;
  }
}

// Enhanced sendRpcRequest with proper queuing
const sendRpcRequest = async (method, params = []) => {
  try {
    // Create a cache key based on method and parameters
    const cacheKey = `rpc:${method}:${crypto.createHash('md5').update(JSON.stringify(params)).digest('hex')}`;
    
    // Check if we have a cached response
    const cachedResponse = rpcCache.get(cacheKey);
    if (cachedResponse) {
      // Don't log every cache hit to reduce console noise
      return cachedResponse;
    }
    
    console.log(`RPC Cache MISS for ${method}`);
    
    // Add to queue and wait for result
    const result = await new Promise((resolve, reject) => {
      rpcQueue.push({ method, params, resolve, reject });
      processRpcQueue(); // Trigger queue processing
    });
    
    // Cache the successful response
    if (result) {
      // Use different TTLs for different methods
      let ttl = 600; // default 10 minutes
      
      if (method === 'getblock') ttl = 1200; // 1 hour for blocks
      if (method === 'getblockhash') ttl = 120; // 1 hour for block hashes
      if (method === 'getblockchaininfo') ttl = 120; // 5 minutes for blockchain info
      
      rpcCache.set(cacheKey, result, ttl);
    }

    return result;
  } catch (error) {
    console.error('Error in sendRpcRequest:', error.message);
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

// Improved getBlocksByTimeRange to use much fewer RPC calls
async function getBlocksByTimeRange(startTimestamp, endBlockHeight, maxBlocks = 50) {
  // Create a cache key for the full result
  const cacheKey = `blocks:${startTimestamp}:${endBlockHeight}:${maxBlocks}`;
  const cachedBlocks = rpcCache.get(cacheKey);
  
  if (cachedBlocks) {
    console.log(`Cache HIT for getBlocksByTimeRange ${startTimestamp}-${endBlockHeight}`);
    return cachedBlocks;
  }
  
  console.log(`Cache MISS for getBlocksByTimeRange ${startTimestamp}-${endBlockHeight}, fetching up to ${maxBlocks} blocks`);
  
  const blocks = [];
  
  try {
    // New strategy: Get block hashes in batches first
    let currentHeight = endBlockHeight;
    let foundEnoughBlocks = false;
    let blockHashes = [];
    
    // First get all block hashes in a loop to minimize the number of RPC calls
    while (blockHashes.length < maxBlocks && currentHeight > 0 && !foundEnoughBlocks) {
      // Get hashes in batches of 20 (arbitrary batch size)
      const batchSize = Math.min(20, maxBlocks - blockHashes.length);
      const batchHashes = [];
      
      for (let i = 0; i < batchSize; i++) {
        if (currentHeight <= 0) break;
        const hash = await sendRpcRequest('getblockhash', [currentHeight--]);
        if (hash) batchHashes.push({ height: currentHeight + 1, hash });
      }
      
      // Get timestamps for this batch with a single bulk call
      // Note: This would require custom bulk RPC endpoint, so for now we'll just
      // check timestamps individually when processing blocks below

      blockHashes.push(...batchHashes);
    }
    
    console.log(`Fetched ${blockHashes.length} block hashes, now getting block details`);
    
    // Now get block details for each hash
    let processedCount = 0;
    for (const {height, hash} of blockHashes) {
      if (processedCount >= maxBlocks) break;
      
      const block = await sendRpcRequest('getblock', [hash, 2]);
      if (!block) continue;
      
      // Check timestamp
      if (block.time < startTimestamp) {
        foundEnoughBlocks = true;
        break;
      }
      
      // Process block and extract data
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
          } 
          else if (coinbaseTx.vout.length > 1 && 
                  coinbaseTx.vout[1].scriptPubKey && 
                  coinbaseTx.vout[1].scriptPubKey.address) {
            minedTo = coinbaseTx.vout[1].scriptPubKey.address;
          }
        }

        // Extract pool identifier 
        const coinbaseHex = coinbaseTx.vin[0].coinbase;
        try {
          const decodedCoinbase = Buffer.from(coinbaseHex, 'hex').toString('utf8');
          const poolPatterns = [
            /\/(.*?)\//,             // /PoolName/
            /\[(.*?)\]/,             // [PoolName]
            /@(.*?)@/,               // @PoolName@
            /pool\.(.*?)\.com/,      // pool.Name.com
            /(.*?)pool/i,            // Somethingpool
          ];
          
          for (const pattern of poolPatterns) {
            const match = decodedCoinbase.match(pattern);
            if (match && match[1] && match[1].length >= 2) {
              poolIdentifier = match[1].trim();
              break;
            }
          }
        } catch (e) {} // Ignore coinbase decode errors
      }
      
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
      
      processedCount++;
      
      // Add small delay every 10 blocks
      if (processedCount % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Cache the results for longer
    const cacheDuration = maxBlocks > 100 ? 1800 : 600; // 30 mins for large sets, 10 mins for small
    rpcCache.set(cacheKey, blocks, cacheDuration);
    
    console.log(`Completed fetching ${blocks.length} blocks for time range query`);
    return blocks;
    
  } catch (error) {
    console.error('Error in getBlocksByTimeRange:', error);
    return blocks; // Return what we have so far
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

// Enhanced method to preload ALL essential data with better error handling
async function preloadEssentialData() {
  console.log("=== PRELOADING ESSENTIAL RPC DATA ===");
  
  const results = {
    success: true,
    errors: [],
    data: {}
  };
  
  // Helper function to run a preload task with error handling
  const runPreloadTask = async (name, method, params = []) => {
    try {
      console.log(`  - Loading ${name}...`);
      const data = await sendRpcRequest(method, params);
      if (!data) {
        throw new Error(`${name} returned null or undefined`);
      }
      results.data[method] = data;
      console.log(`  ✓ ${name} loaded successfully`);
      return data;
    } catch (error) {
      console.error(`  ✗ Error loading ${name}:`, error.message);
      results.success = false;
      results.errors.push({ name, error: error.message });
      return null;
    }
  };
  
  // 1. Blockchain info - critical
  const blockchainInfo = await runPreloadTask('blockchain info', 'getblockchaininfo');
  if (!blockchainInfo) {
    throw new Error("Failed to load blockchain info - critical error");
  }
  
  // 2. Network info
  await runPreloadTask('network info', 'getnetworkinfo');
  
  // 3. Chain transaction stats - important for transaction graphs
  await runPreloadTask('chain transaction stats', 'getchaintxstats');
  
  // 4. Transaction outset info - important for supply info
  // This is slow, so add a longer timeout
  try {
    console.log("  - Loading transaction outset info (this may take a while)...");
    // Add to queue with higher priority and longer timeout
    const result = await new Promise((resolve, reject) => {
      // Add to front of queue for priority
      rpcQueue.unshift({ 
        method: 'gettxoutsetinfo', 
        params: [], 
        resolve, 
        reject,
        priority: true,
        timeout: 45000 // 45 seconds timeout for this heavy operation
      });
      processRpcQueue(); // Trigger queue processing
    });
    
    if (!result) {
      throw new Error("gettxoutsetinfo returned null");
    }
    
    results.data['gettxoutsetinfo'] = result;
    console.log("  ✓ Transaction outset info loaded successfully");
  } catch (error) {
    console.error("  ✗ Error loading transaction outset info:", error.message);
    results.success = false;
    results.errors.push({ name: 'transaction outset info', error: error.message });
  }
  
  // 5. Block reward info - critical
  const blockReward = await runPreloadTask('block reward info', 'getblockreward');
  if (!blockReward) {
    console.warn("Block reward info couldn't be loaded - will use default");
  }
  
  // 6. Best block hash - needed for latest block
  const bestBlockHash = await runPreloadTask('latest block hash', 'getbestblockhash');
  
  // 7. Latest block details - if we have the hash
  if (bestBlockHash) {
    await runPreloadTask('latest block details', 'getblock', [bestBlockHash, 2]);
  }
  
  // 8. Peer info - for node map
  await runPreloadTask('peer info', 'getpeerinfo');
  
  // Summary
  if (results.success) {
    console.log("=== ALL ESSENTIAL DATA PRELOADED SUCCESSFULLY ===");
  } else {
    console.warn(`=== PRELOADING COMPLETED WITH ${results.errors.length} ERRORS ===`);
    console.warn("The following items failed to load:", 
      results.errors.map(e => e.name).join(', '));
  }
  
  return blockchainInfo; // Still return blockchainInfo for downstream use
}

module.exports = {
  router,
  sendRpcRequest,
  getAlgoName,
  getBlocksByTimeRange,
  rpcCache,
  preloadEssentialData
};