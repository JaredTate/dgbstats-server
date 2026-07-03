/**
 * DigiByte RPC Interface Module
 * 
 * This module provides a comprehensive interface to DigiByte's RPC server with:
 * - Smart caching system to reduce server load
 * - Rate limiting to prevent overwhelming the node
 * - Automatic retry and fallback mechanisms
 * - Enhanced block fetching for the stats dashboard
 * 
 * @author DigiByte Stats Server
 * @version 1.0.0
 */

// ============================================================================
// DEPENDENCIES
// ============================================================================

const express = require('express');
const axios = require('axios');
const geoip = require('geoip-lite');
const crypto = require('crypto');
const NodeCache = require('node-cache');

// ============================================================================
// CONFIGURATION
// ============================================================================

// RPC Connection Settings
const RPC_CONFIG = {
  user: process.env.DGB_RPC_USER || 'user',
  password: process.env.DGB_RPC_PASSWORD || 'password',
  url: process.env.DGB_RPC_URL || 'http://127.0.0.1:14044',
  timeout: {
    default: 30000,      // 30 seconds for most commands
    heavy: 120000        // 2 minutes for expensive operations like gettxoutsetinfo
  }
};

// Testnet RPC Connection Settings
const TESTNET_RPC_CONFIG = {
  user: process.env.DGB_TESTNET_RPC_USER || 'user',
  password: process.env.DGB_TESTNET_RPC_PASSWORD || 'password',
  url: process.env.DGB_TESTNET_RPC_URL || 'http://127.0.0.1:14026',
  timeout: {
    default: 30000,
    heavy: 120000
  }
};

// Modified-mainnet/PRE RPC Connection Settings
const MAINNET_PRE_RPC_CONFIG = {
  user: process.env.DGB_MAINNET_PRE_RPC_USER || process.env.DGB_PRE_RPC_USER || 'preminer',
  password: process.env.DGB_MAINNET_PRE_RPC_PASSWORD || process.env.DGB_PRE_RPC_PASSWORD || 'preminerpass',
  url: process.env.DGB_MAINNET_PRE_RPC_URL || process.env.DGB_PRE_RPC_URL || 'http://127.0.0.1:14046',
  timeout: {
    default: 30000,
    heavy: 120000
  }
};

// Rate Limiting Configuration
const RATE_LIMIT = {
  maxConcurrent: 4,     // Maximum concurrent RPC requests
  batchSize: 20,        // Size of batches when fetching multiple blocks
  batchDelay: 200       // Delay between batches in milliseconds
};

// Cache Configuration with TTL settings for different data types
const CACHE_CONFIG = {
  default: 60,          // 1 minute default TTL
  blocks: 3600,         // 1 hour for blocks (immutable)
  heavy: 3600,          // 1 hour for expensive operations
  checkPeriod: 30       // Cache cleanup interval
};

// ============================================================================
// CACHE AND STATISTICS
// ============================================================================

/**
 * Shared cache instance for all RPC requests
 * Uses smart TTL based on data type and request patterns
 */
const rpcCache = new NodeCache({ 
  stdTTL: CACHE_CONFIG.default, 
  checkperiod: CACHE_CONFIG.checkPeriod 
});

/**
 * Statistics tracking for cache performance monitoring
 */
const stats = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  pendingRequests: {
    mainnet: 0,
    testnet: 0,
    mainnetPre: 0
  }
};

// ============================================================================
// CORE RPC FUNCTIONALITY
// ============================================================================

/**
 * Enhanced transaction data fetcher that intelligently uses gettransaction vs getrawtransaction
 * 
 * This function handles the RPC error cases mentioned in the user's issue where gettransaction
 * fails for transactions not in the wallet, and properly falls back to getrawtransaction
 * with improved error logging.
 * 
 * @param {string} txid - Transaction ID to fetch
 * @param {string} blockhash - Optional block hash for confirmed transactions
 * @returns {Promise<object|null>} Transaction data or null if not found
 */
async function getTransactionData(txid, blockhash = null) {
  // Don't log every attempt to reduce noise
  
  try {
    // For mempool transactions, skip gettransaction since it only works for wallet transactions
    // and go straight to getrawtransaction which works for all mempool transactions
    const params = blockhash ? [txid, true, blockhash] : [txid, true];
    const rawTxData = await sendRpcRequest('getrawtransaction', params);
    
    if (rawTxData) {
      return {
        ...rawTxData,
        method: 'getrawtransaction',
        enhanced: false
      };
    }
  } catch (rawError) {
    // Only try gettransaction as a fallback for wallet transactions (rarely needed)
    try {
      const txData = await sendRpcRequest('gettransaction', [txid]);
      if (txData) {
        return {
          ...txData,
          method: 'gettransaction',
          enhanced: true
        };
      }
    } catch (walletError) {
      console.error(`Failed to fetch transaction ${txid}: ${rawError.message}`);
      
      // Check if it's a common error that requires txindex=1
      if (rawError.message.includes('No such mempool or blockchain transaction')) {
        console.error(`ERROR: Transaction ${txid} not found. This may require:
1. DigiByte node with txindex=1 enabled
2. Node reindex if txindex was recently enabled  
3. Transaction may not exist or be very old`);
      }
      
      return null;
    }
  }
  
  return null;
}

/**
 * Enhanced RPC request function with intelligent caching and rate limiting
 * 
 * Features:
 * - MD5-based cache keys for parameter-aware caching
 * - Configurable cache TTL based on request type
 * - Graceful degradation with stale cache fallback
 * - Rate limiting to prevent node overload
 * 
 * @param {string} method - RPC method name
 * @param {Array} params - Parameters for the RPC call
 * @param {boolean} skipCache - Force bypass cache for fresh data
 * @returns {Promise<any>} RPC response data
 */
async function sendRpcRequest(method, params = [], skipCache = false) {
  return sendConfiguredRpcRequest({
    config: RPC_CONFIG,
    networkName: 'Mainnet',
    rpcId: 'dgb_rpc',
    cachePrefix: '',
    limiterKey: 'mainnet'
  }, method, params, skipCache);
}

/**
 * Enhanced RPC request function for Testnet with intelligent caching and rate limiting
 *
 * Features:
 * - MD5-based cache keys for parameter-aware caching
 * - Configurable cache TTL based on request type
 * - Graceful degradation with stale cache fallback
 * - Rate limiting to prevent node overload
 *
 * @param {string} method - RPC method name
 * @param {Array} params - Parameters for the RPC call
 * @param {boolean} skipCache - Force bypass cache for fresh data
 * @returns {Promise<any>} RPC response data
 */
async function sendTestnetRpcRequest(method, params = [], skipCache = false) {
  return sendConfiguredRpcRequest({
    config: TESTNET_RPC_CONFIG,
    networkName: 'Testnet',
    rpcId: 'dgb_testnet_rpc',
    cachePrefix: 'testnet:',
    limiterKey: 'testnet'
  }, method, params, skipCache);
}

/**
 * Enhanced RPC request function for the modified-mainnet/PRE rehearsal node.
 *
 * This is intentionally separate from normal mainnet. The PRE node still
 * reports chain=main, but it runs on its own RPC port and cache namespace.
 */
async function sendMainnetPreRpcRequest(method, params = [], skipCache = false) {
  return sendConfiguredRpcRequest({
    config: MAINNET_PRE_RPC_CONFIG,
    networkName: 'Mainnet-PRE',
    rpcId: 'dgb_mainnet_pre_rpc',
    cachePrefix: 'mainnet-pre:',
    limiterKey: 'mainnetPre'
  }, method, params, skipCache);
}

async function sendConfiguredRpcRequest(target, method, params = [], skipCache = false) {
  stats.totalRequests++;

  try {
    const cacheKey = target.cachePrefix + generateCacheKey(method, params);

    // Check cache first (unless explicitly skipped)
    if (!skipCache) {
      const cachedResult = rpcCache.get(cacheKey);
      if (cachedResult !== undefined) {
        stats.cacheHits++;
        return cachedResult;
      }
    }

    // Cache miss - need to make RPC call
    stats.cacheMisses++;

    // Apply rate limiting
    const limiterKey = target.limiterKey || 'mainnet';
    await waitForAvailableSlot(limiterKey);

    // Track this request
    stats.pendingRequests[limiterKey]++;

    try {
      // Configure timeout based on method type
      const timeout = getTimeoutForMethod(method);

      const response = await axios.post(target.config.url, {
        jsonrpc: '1.0',
        id: target.rpcId,
        method: method,
        params: params,
      }, {
        auth: {
          username: target.config.user,
          password: target.config.password,
        },
        timeout: timeout,
      });

      // Check for RPC errors
      if (response.data.error) {
        throw new Error(`${target.networkName} RPC Error: ${JSON.stringify(response.data.error)}`);
      }

      const result = response.data.result;

      // Cache the result with appropriate TTL
      cacheResultWithSmartTTL(cacheKey, result, method);

      return result;

    } finally {
      stats.pendingRequests[limiterKey]--;
    }

  } catch (error) {
    console.error(`${target.networkName} RPC Error (${method}):`, error.message);

    // Special handling for known timeout issues
    if (method === 'gettxoutsetinfo' && error.code === 'ECONNABORTED') {
      console.log(`${target.networkName} gettxoutsetinfo timed out - this is normal for this heavy command`);
    }

    // Try to return stale cached data as fallback
    const staleResult = attemptStaleDataRecovery(method, params, target.cachePrefix);
    if (staleResult !== null) {
      return staleResult;
    }

    // For critical methods, return estimated data rather than failing
    if (method === 'gettxoutsetinfo') {
      return generateEstimatedUTXOData();
    }

    return null;
  }
}

/**
 * Generate a unique cache key based on method and parameters
 *
 * @param {string} method - RPC method
 * @param {Array} params - Method parameters
 * @returns {string} MD5 hash cache key
 */
function generateCacheKey(method, params) {
  const paramsHash = crypto.createHash('md5')
    .update(JSON.stringify(params))
    .digest('hex');
  return `rpc:${method}:${paramsHash}`;
}

/**
 * Apply rate limiting by waiting for available request slots
 * Uses exponential backoff to prevent thundering herd
 */
async function waitForAvailableSlot(limiterKey = 'mainnet') {
  let waitTime = 100; // Start with 100ms
  
  while ((stats.pendingRequests[limiterKey] || 0) >= RATE_LIMIT.maxConcurrent) {
    await new Promise(resolve => setTimeout(resolve, waitTime));
    waitTime = Math.min(waitTime * 1.1, 1000); // Cap at 1 second
  }
}

/**
 * Get appropriate timeout for different RPC methods
 * 
 * @param {string} method - RPC method name
 * @returns {number} Timeout in milliseconds
 */
function getTimeoutForMethod(method) {
  const heavyMethods = ['gettxoutsetinfo', 'getblockhash', 'getblock'];
  return heavyMethods.includes(method) 
    ? RPC_CONFIG.timeout.heavy 
    : RPC_CONFIG.timeout.default;
}

/**
 * Cache result with smart TTL based on data characteristics
 * 
 * @param {string} cacheKey - Cache key
 * @param {any} result - Data to cache
 * @param {string} method - RPC method (for TTL determination)
 */
function cacheResultWithSmartTTL(cacheKey, result, method) {
  let ttl = CACHE_CONFIG.default;
  
  // Immutable data gets longer cache time
  if (method === 'getblock' || method === 'getblockhash') {
    ttl = CACHE_CONFIG.blocks;
  }
  // Expensive operations get longer cache time
  else if (method === 'gettxoutsetinfo') {
    ttl = CACHE_CONFIG.heavy;
  }
  
  rpcCache.set(cacheKey, result, ttl);
}

/**
 * Attempt to recover from errors using stale cached data
 * 
 * @param {string} method - RPC method
 * @param {Array} params - Method parameters
 * @returns {any|null} Stale cached data or null
 */
function attemptStaleDataRecovery(method, params, cachePrefix = '') {
  const cacheKey = cachePrefix + generateCacheKey(method, params);
  const staleResult = rpcCache.get(cacheKey, true); // Get even if expired
  
  if (staleResult !== undefined) {
    console.log(`Returning stale cached result for ${method} due to error`);
    return staleResult;
  }
  
  return null;
}

/**
 * Generate estimated UTXO set data when real data is unavailable
 * 
 * @returns {object} Estimated UTXO set structure
 */
function generateEstimatedUTXOData() {
  console.log('Returning estimated UTXO set info');
  return {
    height: 0,
    bestblock: "",
    transactions: 0,
    txouts: 0,
    bogosize: 0,
    hash_serialized_2: "",
    disk_size: 0,
    total_amount: 0,
    _estimated: true // Flag indicating this is estimated data
  };
}

// ============================================================================
// ALGORITHM UTILITIES
// ============================================================================

/**
 * Convert DigiByte algorithm identifiers to human-readable names
 * 
 * @param {string} algo - Algorithm identifier from block data
 * @returns {string} Human-readable algorithm name
 */
function getAlgoName(algo) {
  const algorithms = {
    'sha256d': 'SHA256D',
    'scrypt': 'Scrypt',
    'skein': 'Skein',
    'qubit': 'Qubit',
    'odo': 'Odo',
    // DigiByte's ALGO_GROESTL is Myriad-Groestl (Groestl-512 -> SHA256, aka
    // "groestlsha2"). It was retired at the Odocrypt fork (2019) but the node still
    // reports pow_algo "groestl" for blocks mined on it (e.g. the v9.26.2 incident).
    // Label it correctly rather than falling through to "Unknown".
    'groestl': 'Myriad-Groestl',
    'groestlsha2': 'Myriad-Groestl'
  };

  return algorithms[algo] || 'Unknown';
}

// ============================================================================
// BLOCK VERSION / BIP9 SIGNAL CLASSIFICATION
// ============================================================================

// DigiByte block nVersion layout: top bits 001 (0x20000000) mark a BIP9 version;
// the mining algo lives in the nibble at bits 8-11 (scrypt=0x0, sha256d=0x2,
// groestl=0x4, skein=0x6, qubit=0x8, odo=0xE); the low byte carries the base
// version (bit 1) plus the low BIP9 bits (algolock=bit 0, taproot=bit 2).
// SHA256D ASICs version-roll bits 13-28 (BIP310/BIP320 mask 0x1fffe000), which
// INCLUDES the DigiDollar bit 23 — so bit 23 on a rolled block is a coin flip.
// Consensus (versionbits.cpp Condition()) counts the RAW bit regardless of
// rolling, so digidollarSignaling mirrors exactly what the node counts, and
// versionRolled lets clients decide how much to trust it as an upgrade signal.
// Algolock bit 0 sits OUTSIDE the roll window and is always trustworthy.
// NOTE: DigiByte's VERSIONBITS_TOP_MASK is 0xF0000000 (versionbits.h:18), NOT
// Bitcoin's 0xE0000000 — a block with rolled bit 28 set signals NOTHING.
const VERSION_TOP_MASK = 0xf0000000;
const VERSION_TOP_BITS = 0x20000000;
const VERSION_STRUCTURAL_MASK = VERSION_TOP_BITS | 0x00000f00 | 0x000000ff;
const VERSION_BIT_ALGOLOCK = 1 << 0;
const VERSION_BIT_TAPROOT = 1 << 2;
const VERSION_BIT_DIGIDOLLAR = 1 << 23;

function classifyBlockVersion(version) {
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return { taprootSignaling: false, digidollarSignaling: false, algolockSignaling: false, versionRolled: false };
  }
  const v = version >>> 0;
  const top = (v & VERSION_TOP_MASK) === VERSION_TOP_BITS;
  // Rolled detection uses the looser 001x shape (0xE0000000): a rolled block
  // whose bit 28 landed on 1 fails the consensus top-mask but is still very
  // much a version-rolled block and must be reported as such.
  const bip9Era = (v & 0xe0000000) === VERSION_TOP_BITS;
  const residual = (v & ~VERSION_STRUCTURAL_MASK & ~VERSION_BIT_DIGIDOLLAR) >>> 0;
  return {
    taprootSignaling: top && (v & VERSION_BIT_TAPROOT) !== 0,
    digidollarSignaling: top && (v & VERSION_BIT_DIGIDOLLAR) !== 0,
    algolockSignaling: top && (v & VERSION_BIT_ALGOLOCK) !== 0,
    versionRolled: bip9Era && residual !== 0,
  };
}

/**
 * Merge freshly fetched blocks with blocks already in the cache.
 *
 * The 60s refresh can complete with a slightly stale view of the tip while
 * ZMQ/blocknotify have already delivered newer blocks — merging (instead of
 * clobbering) guarantees the cache never regresses. Dedupes by hash with the
 * freshly fetched copy winning, sorts newest-first, caps at maxBlocks.
 *
 * @param {Array} existing - Blocks currently in the cache
 * @param {Array} fetched - Blocks returned by the refresh
 * @param {number} maxBlocks - Cache size cap
 * @returns {Array} Merged, deduped, newest-first block list
 */
function mergeRecentBlocks(existing, fetched, maxBlocks) {
  const byHash = new Map();
  for (const block of [...(existing || []), ...(fetched || [])]) {
    if (block && block.hash) byHash.set(block.hash, block);
  }
  return Array.from(byHash.values())
    .sort((a, b) => b.height - a.height)
    .slice(0, maxBlocks);
}

// ============================================================================
// ADVANCED BLOCK FETCHING
// ============================================================================

/**
 * Enhanced block fetching with intelligent batching and caching
 * 
 * Features:
 * - Time-range filtering for historical analysis
 * - Intelligent batching to reduce RPC load
 * - Duplicate prevention and height tracking
 * - Mining pool identification from coinbase data
 * - Taproot signaling detection
 * 
 * @param {number} startTimestamp - Unix timestamp for earliest blocks (0 for all)
 * @param {number} endBlockHeight - Latest block height to fetch from
 * @param {number} maxBlocks - Maximum number of blocks to return
 * @returns {Promise<Array>} Array of processed block objects
 */
async function getBlocksByTimeRange(startTimestamp, endBlockHeight, maxBlocks = 240) {
  // Create cache key for the entire result set
  const cacheKey = `blocks:range:${startTimestamp}:${endBlockHeight}:${maxBlocks}`;
  
  // Check cache first
  const cachedBlocks = rpcCache.get(cacheKey);
  if (cachedBlocks) {
    return cachedBlocks;
  }
  
  console.log(`Fetching blocks from height ${endBlockHeight} (after timestamp ${startTimestamp})`);
  
  const blocks = [];
  let currentHeight = endBlockHeight;
  let attemptsRemaining = Math.min(1000, maxBlocks * 2);
  
  // Track processed heights to prevent duplicates
  const processedHeights = new Set();
  
  while (blocks.length < maxBlocks && attemptsRemaining > 0 && currentHeight > 0) {
    try {
      // Fetch blocks in batches for efficiency
      const batchHashes = await fetchBlockHashesBatch(
        currentHeight, 
        Math.min(RATE_LIMIT.batchSize, maxBlocks - blocks.length),
        processedHeights
      );
      
      // Update current height for next iteration
      currentHeight -= batchHashes.length;
      
      // Process each block in the batch
      for (const hash of batchHashes) {
        const processedBlock = await processBlockForStats(hash);
        
        if (!processedBlock) continue;
        
        // Apply time filter if specified
        if (startTimestamp > 0 && processedBlock.timestamp < startTimestamp) {
          break;
        }
        
        blocks.push(processedBlock);
        
        if (blocks.length >= maxBlocks) {
          console.log(`Reached target of ${maxBlocks} blocks`);
          break;
        }
      }
      
      // Rate limiting pause between batches
      if (blocks.length < maxBlocks && currentHeight > 0) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.batchDelay));
      }
      
      attemptsRemaining -= batchHashes.length;
      
    } catch (error) {
      console.error('Error in block batch processing:', error);
      await new Promise(resolve => setTimeout(resolve, 500));
      attemptsRemaining--;
    }
  }
  
  console.log(`Block fetching complete: ${blocks.length}/${maxBlocks} blocks processed`);
  
  // Sort by height (descending) and cache result
  blocks.sort((a, b) => b.height - a.height);
  
  if (blocks.length > 0) {
    rpcCache.set(cacheKey, blocks, 300); // Cache for 5 minutes
    console.log(`Cached ${blocks.length} blocks (heights ${blocks[0].height} to ${blocks[blocks.length-1].height})`);
  }
  
  return blocks;
}

/**
 * Fetch a batch of block hashes efficiently
 * 
 * @param {number} startHeight - Starting block height
 * @param {number} batchSize - Number of hashes to fetch
 * @param {Set} processedHeights - Set of already processed heights
 * @returns {Promise<Array>} Array of block hashes
 */
async function fetchBlockHashesBatch(startHeight, batchSize, processedHeights) {
  const hashes = [];
  let currentHeight = startHeight;
  
  for (let i = 0; i < batchSize && currentHeight > 0; i++) {
    // Skip already processed heights
    if (processedHeights.has(currentHeight)) {
      currentHeight--;
      i--; // Don't count this as part of the batch
      continue;
    }
    
    processedHeights.add(currentHeight);
    
    try {
      const hash = await sendRpcRequest('getblockhash', [currentHeight]);
      if (hash) {
        hashes.push(hash);
      }
    } catch (error) {
      console.error(`Failed to fetch hash for height ${currentHeight}:`, error.message);
    }
    
    currentHeight--;
  }
  
  return hashes;
}

/**
 * Process a single block into stats-friendly format
 * 
 * @param {string} blockHash - Block hash to process
 * @returns {Promise<object|null>} Processed block object or null
 */
async function processBlockForStats(blockHash) {
  try {
    const block = await sendRpcRequest('getblock', [blockHash, 2]);
    if (!block || !block.tx || block.tx.length === 0) {
      return null;
    }
    
    // Extract mining information from coinbase transaction
    const miningInfo = extractMiningInfo(block.tx[0]);

    // Classify BIP9 signaling bits (taproot bit 2, digidollar bit 23, algolock bit 0)
    const signals = classifyBlockVersion(block.version);

    return {
      height: block.height,
      hash: block.hash,
      algo: getAlgoName(block.pow_algo),
      txCount: block.nTx,
      difficulty: block.difficulty,
      timestamp: block.time,
      minedTo: miningInfo.address,
      minerAddress: miningInfo.address,
      poolIdentifier: miningInfo.poolId,
      taprootSignaling: signals.taprootSignaling,
      digidollarSignaling: signals.digidollarSignaling,
      algolockSignaling: signals.algolockSignaling,
      versionRolled: signals.versionRolled,
      version: block.version
    };
    
  } catch (error) {
    console.error(`Error processing block ${blockHash}:`, error.message);
    return null;
  }
}

/**
 * Extract mining information from coinbase transaction
 * 
 * @param {object} coinbaseTx - Coinbase transaction object
 * @returns {object} Mining info with address and pool identifier
 */
function extractMiningInfo(coinbaseTx) {
  let address = '';
  let poolId = 'Unknown';
  
  // Find first output with an address (miner reward)
  const addressOutput = coinbaseTx.vout?.find(output => output?.scriptPubKey?.address);
  if (addressOutput) {
    address = addressOutput.scriptPubKey.address;
  }
  
  // Extract pool identifier from coinbase data
  if (coinbaseTx.vin?.[0]?.coinbase) {
    poolId = extractPoolIdentifier(coinbaseTx.vin[0].coinbase);
  }
  
  return { address, poolId };
}

/**
 * Extract pool identifier from coinbase hex data
 * 
 * @param {string} coinbaseHex - Hex-encoded coinbase data
 * @returns {string} Pool identifier or 'Unknown'
 */
function extractPoolIdentifier(coinbaseHex) {
  try {
    const text = Buffer.from(coinbaseHex, 'hex').toString('utf8', 0, 120);

    // 1. Explicit tag formats — content must be printable ASCII with a letter,
    //    so binary extranonce bytes can't leak into the identifier.
    const tagged = [
      /\/([\x20-\x7E]{3,40}?)\//,     // /PoolName/
      /\[([\x20-\x7E]{3,40}?)\]/,     // [PoolName]
      /@([\x20-\x7E]{3,40}?)@/,       // @PoolName@
    ];
    for (const pattern of tagged) {
      const match = text.match(pattern);
      if (match && /[A-Za-z]/.test(match[1])) return match[1].trim();
    }

    // 2. Bare domain names (solopool.org, m2pool.com, zpool.ca, letsmine.it, ...).
    //    The TLD alternation stops the match before stray printable bytes that
    //    trail the tag ("solopool.orgH" -> "solopool.org").
    const DOMAIN_RE = /([a-z0-9][a-z0-9-]{0,40}(?:\.[a-z0-9][a-z0-9-]{0,40})*\.(?:com|org|net|io|ca|it|ru|de|uk|eu|info|pro|xyz|top|club|site|pool|space|cloud|dev|me|cc|tv|us|pl|cz|fr|nl|ch|at|be|se|no|fi|es|pt|br|in|jp|kr|sg|hk|au|nz))/i;
    const domain = text.match(DOMAIN_RE);
    if (domain) return domain[1];

    // 3. Longest human-readable run (e.g. "Mined on HashedMax"); '|' separates
    //    tag segments in some coinbases. Trailing extranonce bytes decode as
    //    hex/digit tokens or single characters — trim those. Bare "solo" is a
    //    ckpool marker, not a pool name — returning Unknown lets callers group
    //    by payout address.
    const runs = text.match(/[\x20-\x7E]{4,}/g) || [];
    runs.sort((a, b) => b.length - a.length);
    if (runs[0]) {
      const segments = runs[0].split('|').filter((s) => /[A-Za-z]/.test(s));
      segments.sort((a, b) => b.length - a.length);
      let cleaned = (segments[0] || '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').trim();
      const innerDomain = cleaned.match(DOMAIN_RE);
      if (innerDomain) return innerDomain[1];
      const tokens = cleaned.split(/\s+/);
      while (tokens.length > 1 && (/^[0-9a-f]{6,}$/i.test(tokens[tokens.length - 1]) || tokens[tokens.length - 1].length === 1)) {
        tokens.pop();
      }
      cleaned = tokens.join(' ');
      if (cleaned.length >= 4 && /[A-Za-z]/.test(cleaned) && !/^solo$/i.test(cleaned)) return cleaned;
    }

    return 'Unknown';
  } catch (error) {
    return 'Unknown';
  }
}

// ============================================================================
// INITIALIZATION AND PRELOADING
// ============================================================================

/**
 * Preload essential blockchain data at startup
 * 
 * This function ensures critical data is cached before the server
 * starts serving requests, improving initial response times.
 * 
 * @returns {Promise<object>} Preload results with success status
 */
async function preloadEssentialData() {
  console.log('Preloading essential blockchain data...');
  
  try {
    // Load core blockchain information
    console.log('-> Loading blockchain info');
    const blockchainInfo = await sendRpcRequest('getblockchaininfo', [], true);
    if (!blockchainInfo) throw new Error('Failed to load blockchain info');
    
    // Load transaction statistics  
    console.log('-> Loading chain transaction stats');
    const chainTxStats = await sendRpcRequest('getchaintxstats', [], true);
    
    // Load UTXO set info (expensive operation)
    console.log('-> Loading transaction outset info (may take time)');
    const txOutsetInfo = await sendRpcRequest('gettxoutsetinfo', [], true);
    
    // Load current block reward
    console.log('-> Loading block reward info');
    const blockReward = await sendRpcRequest('getblockreward', [], true);
    
    // Load recent blocks for immediate display
    console.log('-> Loading recent blocks');
    const latestHeight = blockchainInfo.blocks;
    const blocks = await getBlocksByTimeRange(0, latestHeight, 240);
    
    console.log('Essential data preloading complete!');
    console.log(`-> Blockchain height: ${blockchainInfo.blocks}`);
    console.log(`-> Loaded blocks: ${blocks.length}`);
    console.log(`-> UTXO set: ${txOutsetInfo ? 'Success' : 'Failed'}`);
    console.log(`-> Block reward: ${blockReward || 'Unknown'}`);
    
    return {
      blockchainInfo,
      chainTxStats,
      txOutsetInfo,
      blockReward,
      blocks,
      success: true
    };
  } catch (error) {
    console.error('Error during essential data preloading:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// PERFORMANCE UTILITIES
// ============================================================================

/**
 * Batch block fetching for improved performance
 * 
 * @param {Array<string>} hashes - Array of block hashes
 * @returns {Promise<Array>} Array of block objects
 */
async function fetchBlocksInBatch(hashes) {
  const results = [];
  const batchSize = 5; // Conservative batch size
  
  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize);
    
    // Process batch in parallel
    const batchPromises = batch.map(hash => 
      sendRpcRequest('getblock', [hash, 2])
    );
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // Rate limiting between batches
    if (i + batchSize < hashes.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return results;
}

/**
 * Get comprehensive cache statistics
 * 
 * @returns {object} Cache performance metrics
 */
function getCacheStats() {
  const hitRate = stats.totalRequests > 0 
    ? (stats.cacheHits / stats.totalRequests * 100).toFixed(1) + '%' 
    : '0%';
  const pendingRequestsByTarget = { ...stats.pendingRequests };
    
  return {
    keys: rpcCache.keys().length,
    hits: stats.cacheHits,
    misses: stats.cacheMisses,
    total: stats.totalRequests,
    hitRate: hitRate,
    pendingRequests: Object.values(pendingRequestsByTarget).reduce((sum, count) => sum + count, 0),
    pendingRequestsByTarget
  };
}

/**
 * Reset cache statistics (useful for monitoring)
 */
function resetCacheStats() {
  stats.totalRequests = 0;
  stats.cacheHits = 0;
  stats.cacheMisses = 0;
}

// ============================================================================
// EXPRESS ROUTER SETUP
// ============================================================================

const router = express.Router();

// Basic blockchain information
router.get('/getblockchaininfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('getblockchaininfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getblockchaininfo:', error);
    res.status(500).json({ error: 'Error fetching blockchain info' });
  }
});

// Authoritative BIP9 deployment status (used by the Pool Upgrade Tracker for the
// official `algolock` signalling window stats alongside the per-pool heuristic).
router.get('/getdeploymentinfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('getdeploymentinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getdeploymentinfo:', error);
    res.status(500).json({ error: 'Error fetching deployment info' });
  }
});

// Peer information with geolocation data
router.get('/getpeerinfo', async (req, res) => {
  try {
    const peerData = await sendRpcRequest('getpeerinfo');
    
    // Enhance peer data with geolocation
    const enhancedPeers = peerData.map((node) => {
      const ip = node.addr.split(':')[0];
      const geoData = geoip.lookup(ip) || {};
      
      return {
        ...node,
        lat: geoData.ll && geoData.ll[0],
        lon: geoData.ll && geoData.ll[1],
        city: geoData.city,
        country: geoData.country,
      };
    });
    
    res.json(enhancedPeers);
  } catch (error) {
    console.error('Error in /api/getpeerinfo:', error);
    res.status(500).json({ error: 'Error fetching peer info' });
  }
});

// Current block reward
router.get('/getblockreward', async (req, res) => {
  try {
    const data = await sendRpcRequest('getblockreward');
    res.json({ blockReward: data });
  } catch (error) {
    console.error('Error in /api/getblockreward:', error);
    res.status(500).json({ error: 'Error fetching block reward' });
  }
});

// Latest block information
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
    
    res.json({
      height: block.height,
      hash: block.hash,
      algo: block.pow_algo,
      txCount: block.nTx,
      difficulty: block.difficulty,
    });
  } catch (error) {
    console.error('Error fetching latest block:', error);
    res.status(500).json({ 
      error: 'Error fetching latest block', 
      details: error.message 
    });
  }
});

// Chain transaction statistics
router.get('/getchaintxstats', async (req, res) => {
  try {
    const data = await sendRpcRequest('getchaintxstats');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getchaintxstats:', error);
    res.status(500).json({ error: 'Error fetching chain transaction stats' });
  }
});

// UTXO set information
router.get('/gettxoutsetinfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('gettxoutsetinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/gettxoutsetinfo:', error);
    res.status(500).json({ error: 'Error fetching transaction output set info' });
  }
});

// Mempool information endpoint
router.get('/getmempoolinfo', async (req, res) => {
  try {
    const data = await sendRpcRequest('getmempoolinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getmempoolinfo:', error);
    res.status(500).json({ error: 'Error fetching mempool info' });
  }
});

// Raw mempool data endpoint
router.get('/getrawmempool', async (req, res) => {
  try {
    // Get verbose mempool data with full transaction details
    const data = await sendRpcRequest('getrawmempool', [true]);
    res.json(data);
  } catch (error) {
    console.error('Error in /api/getrawmempool:', error);
    res.status(500).json({ error: 'Error fetching raw mempool' });
  }
});

// Cache performance statistics
router.get('/rpccachestats', (req, res) => {
  const stats = getCacheStats();
  res.json(stats);
});

// Manual cache refresh endpoint
router.post('/refreshcache', async (req, res) => {
  try {
    const { type } = req.body || {};
    
    if (!type) {
      return res.status(400).json({ error: 'Missing type parameter' });
    }
    
    let result;
    
    // Refresh specific data types
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

// ============================================================================
// TESTNET API ROUTES
// ============================================================================

// Testnet blockchain information
router.get('/testnet/getblockchaininfo', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('getblockchaininfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/getblockchaininfo:', error);
    res.status(500).json({ error: 'Error fetching testnet blockchain info' });
  }
});

// Testnet BIP9 deployment status
router.get('/testnet/getdeploymentinfo', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('getdeploymentinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/getdeploymentinfo:', error);
    res.status(500).json({ error: 'Error fetching testnet deployment info' });
  }
});

// Testnet block hash by height
router.get('/testnet/getblockhash/:height', async (req, res) => {
  try {
    const height = parseInt(req.params.height, 10);
    const data = await sendTestnetRpcRequest('getblockhash', [height]);
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/getblockhash:', error);
    res.status(500).json({ error: 'Error fetching testnet block hash' });
  }
});

// Testnet block by hash
router.get('/testnet/getblock/:hash', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('getblock', [req.params.hash, 2]);
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/getblock:', error);
    res.status(500).json({ error: 'Error fetching testnet block' });
  }
});

// Testnet chain transaction statistics
router.get('/testnet/getchaintxstats', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('getchaintxstats');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/getchaintxstats:', error);
    res.status(500).json({ error: 'Error fetching testnet chain transaction stats' });
  }
});

// Testnet UTXO set information
router.get('/testnet/gettxoutsetinfo', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('gettxoutsetinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/gettxoutsetinfo:', error);
    res.status(500).json({ error: 'Error fetching testnet transaction output set info' });
  }
});

// Testnet peer information with geolocation data
router.get('/testnet/getpeerinfo', async (req, res) => {
  try {
    const peerData = await sendTestnetRpcRequest('getpeerinfo');

    // Enhance peer data with geolocation
    const enhancedPeers = peerData.map((node) => {
      const ip = node.addr.split(':')[0];
      const geoData = geoip.lookup(ip) || {};

      return {
        ...node,
        lat: geoData.ll && geoData.ll[0],
        lon: geoData.ll && geoData.ll[1],
        city: geoData.city,
        country: geoData.country,
      };
    });

    res.json(enhancedPeers);
  } catch (error) {
    console.error('Error in /api/testnet/getpeerinfo:', error);
    res.status(500).json({ error: 'Error fetching testnet peer info' });
  }
});

// Testnet current block reward
router.get('/testnet/getblockreward', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('getblockreward');
    res.json({ blockReward: data });
  } catch (error) {
    console.error('Error in /api/testnet/getblockreward:', error);
    res.status(500).json({ error: 'Error fetching testnet block reward' });
  }
});

// Testnet mempool information
router.get('/testnet/getmempoolinfo', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('getmempoolinfo');
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/getmempoolinfo:', error);
    res.status(500).json({ error: 'Error fetching testnet mempool info' });
  }
});

// Testnet raw mempool data
router.get('/testnet/getrawmempool', async (req, res) => {
  try {
    const data = await sendTestnetRpcRequest('getrawmempool', [true]);
    res.json(data);
  } catch (error) {
    console.error('Error in /api/testnet/getrawmempool:', error);
    res.status(500).json({ error: 'Error fetching testnet raw mempool' });
  }
});

// Testnet latest block information
router.get('/testnet/getlatestblock', async (req, res) => {
  try {
    const latestBlockHash = await sendTestnetRpcRequest('getbestblockhash');
    if (!latestBlockHash) {
      throw new Error('Failed to fetch testnet latest block hash');
    }

    const block = await sendTestnetRpcRequest('getblock', [latestBlockHash]);
    if (!block) {
      throw new Error('Failed to fetch testnet block data');
    }

    res.json({
      height: block.height,
      hash: block.hash,
      algo: block.pow_algo,
      txCount: block.nTx,
      difficulty: block.difficulty,
    });
  } catch (error) {
    console.error('Error fetching testnet latest block:', error);
    res.status(500).json({
      error: 'Error fetching testnet latest block',
      details: error.message
    });
  }
});

// ============================================================================
// DIGIDOLLAR API ENDPOINTS
// ============================================================================

function routePath(prefix, endpoint) {
  return prefix ? `${prefix}${endpoint}` : endpoint;
}

function clampSignerBlockCount(value) {
  const requestedBlocks = Number.parseInt(value || '100', 10);
  return Number.isFinite(requestedBlocks)
    ? Math.max(1, Math.min(1000, requestedBlocks))
    : 100;
}

function registerDigiDollarRoutes(prefix, sendRequest, label) {
  router.get(routePath(prefix, '/getdigidollardeploymentinfo'), async (req, res) => {
    try {
      const data = await sendRequest('getdigidollardeploymentinfo');
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/getdigidollardeploymentinfo')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} DigiDollar deployment info`, details: error.message });
    }
  });

  router.get(routePath(prefix, '/getdigidollarstats'), async (req, res) => {
    try {
      const data = await sendRequest('getdigidollarstats');
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/getdigidollarstats')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} DigiDollar stats`, details: error.message });
    }
  });

  router.get(routePath(prefix, '/getoracleprice'), async (req, res) => {
    try {
      const data = await sendRequest('getoracleprice');
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/getoracleprice')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} oracle price`, details: error.message });
    }
  });

  router.get(routePath(prefix, '/getoracles'), async (req, res) => {
    try {
      const data = await sendRequest('getoracles');
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/getoracles')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} oracles`, details: error.message });
    }
  });

  router.get(routePath(prefix, '/getalloracleprices'), async (req, res) => {
    try {
      const data = await sendRequest('getalloracleprices');
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/getalloracleprices')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} all oracle prices`, details: error.message });
    }
  });

  router.get(routePath(prefix, '/getoraclesigners'), async (req, res) => {
    try {
      const blocks = clampSignerBlockCount(req.query.blocks);
      const data = await sendRequest('getoraclesigners', [blocks]);
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/getoraclesigners')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} oracle bundle signers`, details: error.message });
    }
  });

  router.get(routePath(prefix, '/listoracle'), async (req, res) => {
    try {
      const data = await sendRequest('listoracle');
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/listoracle')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} local oracle status`, details: error.message });
    }
  });

  router.get(routePath(prefix, '/getprotectionstatus'), async (req, res) => {
    try {
      const data = await sendRequest('getprotectionstatus');
      res.json(data);
    } catch (error) {
      console.error(`Error in /api${routePath(prefix, '/getprotectionstatus')}:`, error);
      res.status(500).json({ error: `Error fetching ${label} protection status`, details: error.message });
    }
  });
}

registerDigiDollarRoutes('', sendRpcRequest, 'mainnet');
registerDigiDollarRoutes('/testnet', sendTestnetRpcRequest, 'testnet');
registerDigiDollarRoutes('/mainnet-pre', sendMainnetPreRpcRequest, 'mainnet-pre');

// ============================================================================
// MODULE EXPORTS
// ============================================================================

module.exports = {
  router,
  sendRpcRequest,
  sendTestnetRpcRequest,
  sendMainnetPreRpcRequest,
  getTransactionData,
  getAlgoName,
  classifyBlockVersion,
  extractPoolIdentifier,
  mergeRecentBlocks,
  getBlocksByTimeRange,
  preloadEssentialData,
  getCacheStats,
  resetCacheStats,
  rpcCache,
  fetchBlocksInBatch
};
