# dgbstats-server Repository Map

### cache-backup.json
- JSON cache snapshot used to persist and restore initial API/bootstrap data.
- Top-level keys: `initialData`, `timestamp`.
- `initialData` includes testnet blockchain info, chain tx stats, UTXO set info, block reward, and deployment data.

### check-transactions.js
- Standalone diagnostic script that checks recent blocks directly through RPC.
- Defines `checkRecentBlocks()` which:
  - Fetches `getbestblockhash` and latest block via `sendRpcRequest`.
  - Iterates backward over recent blocks and inspects coinbase/tx data.
  - Logs block and transaction observations for troubleshooting transaction indexing/visibility.
- Executes immediately as a CLI script.

### .claude/settings.local.json
- Local Claude/code-assistant permission profile for this repo.
- Controls allowed shell command patterns (npm/node/git/mkdir/grep/etc.) and deny list.
- `enableAllProjectMcpServers` is disabled.

### config.js
- Runtime configuration module exported via `module.exports`.
- Defines active environment (`development`/`production`) and filesystem paths.
- Primary configured paths: `peersDataPath` for mainnet and `testnetPeersDataPath` for testnet26 peer discovery.

### config.template.js
- Template config intended to be copied to `config.js`.
- Same structure as `config.js` with example dev/prod `peersDataPath` and `testnetPeersDataPath` values.
- Serves as environment bootstrap/reference file.

### history.js
- Historical per-algo difficulty/hashrate stats at TWO resolutions — a ~3-year (1095-day) DAILY view (for 6M / 1Y / 3Y frontend ranges) and a ~48h HOURLY intraday view — reconstructed from block HEADERS (works on a PRUNED node back to genesis). Enabled by default.
- Owns its own SQLite file `history.db` (tables `daily_algo_stats`, `hourly_algo_stats`, `history_meta`); promisified `dbRun`/`dbAll`/`dbGet` helpers mirror crawler.js/forktracker.js; `ensureColumn` migrates older DBs.
- Pure functions (unit-tested):
  - `foldHeadersBy(headers, bucketOf, keyName)` — ONE shared implementation; `foldHeaders` (UTC day) and `foldHeadersHourly` (UTC hour `YYYY-MM-DDTHH:00:00Z`) are wrappers. Buckets `[{time, difficulty, algo, height}]` into per-(bucket, algo) aggregates `{block_count, sum_difficulty, min/max/last_difficulty, last_height}`.
  - `buildBucketResponse(...)` with `buildDailyResponse` / `buildHourlyResponse` wrappers — shape rows into the API contract; derive `avgDifficulty = sum/count` and `hashrate = 2^32 * sum_difficulty / secondsPerWindow` (86400 daily, 3600 hourly); flag the final (current) bucket `partial`.
  - `computeBackfillGap({tip, days, currentLow})` — the smart-backfill brain: `null` (already covers `tip - days*5760` → SKIP), full `{targetStart..tip}` (nothing yet), or older-gap-only `{targetStart..currentLow-1}` (depth grew).
  - `bucketDay`/`bucketHour`; `sortAlgos`; `clampDays` (`?days` clamped 1–1095, default 30); `clampHours` (`?hours` clamped 1–48, default 24).
- `createHistoryTracker({db, network, sendRpc, days=1095, hours=48, hourlyRetentionDays=3, ...})` — per-network jobs, all RPC wrapped in try/catch (offline node aborts its own work, never throws):
  - `backfill()` — SMART deep DAILY backfill. Uses `computeBackfillGap` against `history_meta.backfill_low_height` to walk ONLY the missing range: SKIP when covered (fast restart), full `[targetStart..tip]` on first run, or the older gap when depth grew. Walks DESCENDING in week-sized chunks, folds + ADDs each, advances `backfill_low_height` per chunk (resumable). First entry sets `last_height=tip, backfill_done=1` up front.
  - `backfillHourly()` / `refreshHourlyTo(tip, hours)` — REPLACE-writes the last ~48h of `hourly_algo_stats` from the same header source (seeded before the deep daily walk on first run).
  - `incrementalOnce()` — every 60s folds `last_height+1 .. tip` and ADDS onto affected DAILY + HOURLY rows, advances `last_height`, and `pruneHourly()` (deletes hourly rows older than ~3 days).
  - `refoldRecentDays(2)` + startup sync — recompute both recent windows (last 2 days, last 48h) to a single tip snapshot so neither table is left with a gap or double-count.
- `init({sendRpc, sendTestnetRpc, days, hours, log})` — opens `history.db`, creates tables, kicks off mainnet + testnet trackers (testnet guarded/silent), returns `{db, getDaily(network, days), getHourly(network, hours), stop()}`. Non-blocking (the ~3y first-run walk runs on a background promise; later restarts hit the SKIP fast path).
- Wired into `server.js` after the HTTP server is listening; endpoints `GET /api/history/daily`, `GET /api/history/hourly` (+ `/api/testnet/*` twins). ENABLED BY DEFAULT — turn off with `DGB_HISTORY_DISABLED=1`.

### package.json
- Node package manifest (`name: dgbstats-server`, `version: 1.0.0`).
- Scripts:
  - `test`, `test:watch`, `test:coverage`, `test:unit`, `test:integration`, `test:debug`, `dev`.
- Runtime dependencies include: `express`, `ws`, `axios`, `node-cache`, `sqlite3`, `geoip-lite`, `cors`, `zeromq`.
- Dev dependencies include: `vitest`, `@vitest/coverage-v8`, `supertest`, `concurrently`.

### package-lock.json
- NPM lockfile (lockfileVersion 3) pinning full dependency tree.
- Contains resolved package metadata/integrity for reproducible installs.
- Includes ~400 package entries under `packages`.

### rpc.js
- Core RPC/REST module; creates Express `router` and wraps DigiByte Core RPC calls.
- Handles mainnet + testnet JSON-RPC transport, timeout tuning, retries, and rate limiting.
- Implements caching and cache metrics (`node-cache`) with smart TTL and stale-data fallback logic.
- Key internal functions include:
  - `getTransactionData`, `sendRpcRequest`, `sendTestnetRpcRequest`
  - `generateCacheKey`, `waitForAvailableSlot`, `getTimeoutForMethod`
  - `cacheResultWithSmartTTL`, `attemptStaleDataRecovery`, `generateEstimatedUTXOData`
  - `getAlgoName`, `getBlocksByTimeRange`, `fetchBlockHashesBatch`, `processBlockForStats`
  - `extractMiningInfo`, `extractPoolIdentifier`, `preloadEssentialData`, `fetchBlocksInBatch`
  - `getCacheStats`, `resetCacheStats`
- Mainnet API routes (router):
  - `GET /getblockchaininfo`, `/getpeerinfo`, `/getblockreward`, `/getlatestblock`, `/getchaintxstats`, `/gettxoutsetinfo`, `/getmempoolinfo`, `/getrawmempool`, `/rpccachestats`
  - `POST /refreshcache`
- Testnet API routes (router):
  - `GET /testnet/getblockchaininfo`, `/testnet/getblockhash/:height`, `/testnet/getblock/:hash`, `/testnet/getchaintxstats`, `/testnet/gettxoutsetinfo`, `/testnet/getpeerinfo`, `/testnet/getblockreward`, `/testnet/getmempoolinfo`, `/testnet/getrawmempool`, `/testnet/getlatestblock`
  - DigiDollar/oracle routes: `/testnet/getdigidollarstats`, `/testnet/getoracleprice`, `/testnet/getoracles`, `/testnet/getalloracleprices`, `/testnet/getoraclesigners`, `/testnet/listoracle`, `/testnet/getprotectionstatus`
- Exports:
  - `router`, `sendRpcRequest`, `sendTestnetRpcRequest`, `getTransactionData`, `getAlgoName`, `getBlocksByTimeRange`, `preloadEssentialData`, `getCacheStats`, `resetCacheStats`, `rpcCache`, `fetchBlocksInBatch`.

### server.js
- Main application entrypoint for HTTP + WebSocket backend.
- Sets up Express API server, CORS, SQLite storage, in-memory caches, and `ws` WebSocket broadcasting.
- Integrates RPC module and maintains live blockchain/mempool/testnet state.
- Major responsibilities:
  - Database lifecycle: `initializeDatabase()` and peer/visit persistence helpers.
  - Client bootstrap push: `sendInitialDataToClient`, `sendTestnetInitialDataToClient`, `sendGeoDataToClient`, `sendMempoolDataToClient`.
  - Block pipelines: `fetchLatestBlocks`, `fillRemainingBlocks`, `fetchSingleBlockForCache`, `updateRecentBlocksCache`, `broadcastNewBlock`.
  - Transaction lifecycle tracking: `updateConfirmedTransactionsCache`, `updateMempoolCache`, `monitorMempoolChanges`, `handleTransactionLifecycle`.
  - Testnet mirrors: `fetchTestnetLatestBlocks`, `updateTestnetRecentBlocksCache`, testnet mempool/confirmed tx caches and broadcast functions.
  - Oracle/DigiDollar polling: `fetchTestnetOracleData`, `fetchTestnetDDStatsData`, `fetchTestnetDeploymentData`, plus broadcast refresh orchestration.
  - Peer geolocation flows (mainnet/testnet) and cache status reporting.
  - ZeroMQ subscription handlers: `initializeZeroMQ`, `handleRawTransactions`, `handleHashTransactions`, `handleRawBlocks`, `cleanupZeroMQ`.
  - Cache persistence/recovery: `saveCacheToDisk`, `loadCacheFromDisk`.
  - Startup orchestration: `startServer()` with recurring refresh intervals.
- HTTP endpoints defined here include:
  - `POST /api/blocknotify`, `POST /api/testnet/blocknotify`
  - `GET /api/getpeers`, `GET /api/testnet/getpeers`
  - `GET /api/visitstats`, `GET /api/cachestatus`, `GET /health`
  - `GET /api/chaintips`, `GET /api/testnet/chaintips`
  - `GET /api/history/daily`, `GET /api/history/hourly` (+ `/api/testnet/*` twins; delegate to `history.js`)
  - `POST /api/refresh-peers`
- Instantiates `history.init(...)` in `startServer()` after the HTTP server is listening.
- Does not export module API; runs as executable server process.

### test-confirmed-transactions.js
- Manual WebSocket smoke test for confirmed transaction delivery.
- Defines `testConfirmedTransactions()` and connects to `ws://localhost:5002`.
- Logs/validates `recentTransactions`, `recentBlocks`, `mempool`, and other message types.
- Provides operational troubleshooting hints on connection failure.

### test-mempool.js
- CLI RPC validation script focused on mempool-related data paths.
- Imports `sendRpcRequest` and `getTransactionData` from `rpc.js`.
- Defines `testMempoolFetch()` to check:
  - `getmempoolinfo`
  - `getrawmempool`
  - Per-tx lookup/decoding for a sample txid.
- Exits process after completion.

### tests/coverage/block-navigation.js
- Coverage report frontend asset (JavaScript) for HTML report page navigation.
- Defines navigation helpers: `init`, `toggleClass`, `makeCurrent`, `goToPrevious`, `goToNext`, `jump`.
- No backend exports; browser-side utility script.

### tests/coverage/lcov-report/block-navigation.js
- Duplicate coverage-report navigation helper script under lcov HTML output.
- Same navigation functions as `tests/coverage/block-navigation.js`.
- Static generated artifact, not runtime backend logic.

### tests/coverage/lcov-report/prettify.js
- Minified/generated syntax highlighting script used by lcov HTML coverage reports.
- Contains internal short-named helper functions for tokenization/highlighting.
- Static report asset; no Node module exports used by backend.

### tests/coverage/lcov-report/sorter.js
- Generated lcov coverage report sorter/filter UI script.
- Provides functions to parse table data, add search/filter UI, and sort columns.
- Static browser-side report utility.

### tests/coverage/prettify.js
- Generated/minified syntax-highlighting script for coverage output.
- Mirrors functionality of lcov prettify asset.
- Static artifact only.

### tests/coverage/sorter.js
- Generated coverage table sorting/filtering script.
- Includes table traversal, sort indicator handling, and UI enablement helpers.
- Static artifact only.

### tests/fixtures/mock-blocks.js
- Fixture module with realistic mock block objects across multiple DigiByte algos.
- Builds derived `mockProcessedBlocks` for processed block-stat expectations.
- Helper functions:
  - `getAlgoName(algo)`
  - `extractPoolFromCoinbase(coinbaseHex)`
- Exports:
  - `mockBlocks`, `mockProcessedBlocks`, `mockBlockHashes`, `getAlgoName`, `extractPoolFromCoinbase`.

### tests/fixtures/mock-rpc-responses.js
- Canonical mock payloads for core RPC responses and error scenarios.
- Includes fixtures for blockchain info, chain tx stats, UTXO set info, block reward, block details, peer list, and RPC errors.
- Exports:
  - `mockBlockchainInfo`, `mockChainTxStats`, `mockTxOutsetInfo`, `mockBlockReward`, `mockBlock`, `mockPeerInfo`, `mockRpcErrors`.

### tests/fixtures/test-data.js
- Cross-test fixture bundle for peer/geolocation data, cache snapshots, websocket message shapes, and error payloads.
- Also defines test runtime settings, SQL schema DDL strings, and coinbase pattern samples.
- Exports:
  - `mockPeerData`, `mockGeoData`, `mockVisitStats`, `mockCacheStatus`, `mockWebSocketMessages`, `mockErrorResponses`, `testConfig`, `testDbSchemas`, `mockCoinbaseData`.

### tests/helpers/mock-rpc.js
- Mock RPC framework for deterministic unit/integration testing.
- Defines `MockRpcServer` class with method/params keyed response, error, delay, and call-count tracking.
- Helper factories:
  - `mockAxiosPost(mockRpcServer)`
  - `mockSendRpcRequest(mockRpcServer)`
  - `createMockRpcEnvironment()`
- Includes `rpcErrorScenarios` convenience builders (connection refused, timeout, method-not-found, parse, invalid request).
- Exports:
  - `MockRpcServer`, `mockAxiosPost`, `mockSendRpcRequest`, `createMockRpcEnvironment`, `rpcErrorScenarios`.

### tests/helpers/test-setup.js
- Vitest global setup file (referenced by `vitest.config.js`).
- Globally mocks/suppresses `console.log/error/warn` during tests.
- Restores console methods in teardown hooks.
- Adds global `testUtils` helpers (console toggles, async wait, random data helpers).
- Sets test environment vars (`NODE_ENV=test`, `PORT=0`).

### tests/helpers/test-utils.js
- General-purpose test utility module for db/ws/cache/mock scaffolding.
- Functions:
  - `createTestDatabase`, `mockAxios`, `createTestWebSocketClient`, `waitFor`, `createMockCache`, `generateTestBlock`, `generateTestPeerData`, `createTempFile`, `suppressConsole`.
- Defines `TestServer` class for start/stop lifecycle handling of HTTP app instances.
- Exports all helper functions + `TestServer` class.

### tests/integration/api.test.js
- Integration test suite for HTTP API endpoint behavior.
- Contains helper route wiring (`setupTestRoutes`, `setupTestnetRoutes`) around mocked RPC handlers.
- Covers mainnet and testnet endpoint groups:
  - Blockchain info, block data, network info, cache actions, analytics/status, health, CORS/content-type/error handling.
- Includes extensive request/response assertions (~40 tests).

### tests/integration/database.test.js
- Focused integration tests for SQLite schema and basic CRUD behavior.
- Verifies table creation and simple insert/query operations against test DB.
- Suite sections: schema creation and basic operations.

### tests/integration/end-to-end.test.js
- End-to-end workflow tests combining HTTP + WebSocket behavior in app-like flows.
- Helper setup functions: `setupE2ERoutes`, `setupWebSocketServer`.
- Validates complete request/update paths and lightweight performance/load scenarios.

### tests/integration/history-db.test.js
- Integration tests for `history.js` persistence + the backfill/incremental/refold jobs against an in-memory sqlite and a fake header-only RPC.
- Covers daily + hourly table creation, idempotent backfill, additive incremental catch-up (ACCUMULATE) into both daily and hourly, full-day refold correction, `queryDaily`/`queryHourly`, hourly backfill/pruning, the full `run()` startup sequence, offline-node resilience (no throw), and the SMART deep-backfill (first-run walks + records `backfill_low_height`, restart SKIPS, partial coverage extends only the older gap — asserted by counting which heights `getblockheader` was called for).

### tests/integration/websocket.test.js
- Integration tests dedicated to WebSocket behavior.
- Validates connection lifecycle, initial payload delivery, realtime updates, error handling, message format, and performance expectations.
- Structured into 8 describe blocks with 18 tests.

### tests/unit/history.test.js
- Unit tests for `history.js` pure functions (daily + hourly).
- `foldHeaders`/`foldHeadersHourly`: UTC-day and UTC-hour bucketing across the respective boundary, per-algo sum/min/max/last/count, and `last_*` taken from the highest height; `bucketHour` zeroes minutes/seconds to a Z-suffixed ISO string.
- `buildDailyResponse`/`buildHourlyResponse`: `avgDifficulty = sum/count`, `hashrate = 2^32 * sum_difficulty / secondsPerWindow` (86400 daily, 3600 hourly), final bucket flagged `partial`, canonical `algos`, and the full response contract (`days`/`date` vs `hours`/`hour`).
- `computeBackfillGap`: no-coverage → full range, already-covered → null (skip), partial → older-gap-only, depth-increase extension, genesis clamp.
- Helper coverage for `sortAlgos`, `clampDays` (1–1095 bound), and `clampHours`.

### tests/unit/rpc.test.js
- Unit tests for `rpc.js` internals and behaviors.
- Covers `sendRpcRequest`, algorithm mapping (`getAlgoName`), cache stats, block processing, pool identifier extraction, error paths, preload behavior, batch fetch behavior, and cache semantics.
- Organized into 10 describe sections with 22 tests.

### tests/unit/server-core.test.js
- Unit tests for core `server.js` logic pieces.
- Covers coinbase decoding, cache persistence/recovery patterns, block processing, DB helpers, utility logic, configuration, and error handling.
- Organized into 8 describe sections with 17 tests.

### tests/unit/testnet.test.js
- Unit tests for testnet-focused RPC and cache behavior.
- Covers `sendTestnetRpcRequest`, cache-key behavior, block/transaction/network operations, error and rate-limiting behavior.
- Includes future-implementation expectation suites for testnet block fetching and transaction caching.
- Organized into 11 describe sections with 32 tests.

### test-transaction-lifecycle.js
- Long-running manual WebSocket observer for mempool → confirmed transaction lifecycle.
- Tracks in-memory sets for mempool and confirmed txids and logs transitions by message type.
- Handles message types including `recentTransactions`, `mempool`, `newTransaction`, `transactionConfirmed`, `newBlock`, `recentBlocks`, `initialData`.
- Includes graceful shutdown handlers and 30-minute timeout.

### test-websocket.js
- Manual WebSocket smoke test script for frontend-facing realtime payloads.
- Defines `testWebSocketConnection()` and requests mempool updates after connection.
- Logs and validates message types (`mempool`, `recentBlocks`, `initialData`, etc.) and sample transaction fields.
- Auto-closes after timeout.

### vitest.config.js
- Vitest configuration module (`defineConfig`) for this repository.
- Test setup:
  - Node environment, include pattern `tests/**/*.test.js`, setup file `tests/helpers/test-setup.js`.
  - Timeouts, verbose reporter, forked pool with `singleFork`.
- Coverage setup:
  - Provider `v8`, reporters `text/html/lcov`, output dir `tests/coverage`.
  - Coverage target include: `rpc.js`, `server.js`.
  - Thresholds: lines/functions/statements 90%, branches 85%.
