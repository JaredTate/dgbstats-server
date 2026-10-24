/**
 * Real-process tests for server.js.
 *
 * These spawn `node server.js` against a mock JSON-RPC node, a fresh temp
 * working directory (so nodes.db starts empty) and a local ZeroMQ publisher.
 *
 * Covers two production bugs:
 *  1. Fresh-database startup race: the schema CREATE statements ran in
 *     parallel, so `CREATE INDEX ... ON visits` could run before the visits
 *     table existed and crash the process ("no such table: visits").
 *  2. Duplicate block broadcasts: the same block arrives via ZMQ rawblock AND
 *     the blocknotify POST, and each path broadcast its own `newBlock`.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');
const zmq = require('zeromq');
const sqlite3 = require('sqlite3');

const ROOT = path.resolve(__dirname, '../..');
// server.js requires the gitignored config.js; skip where it is absent.
const HAS_CONFIG = fs.existsSync(path.join(ROOT, 'config.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Build a block whose hash matches sha256d(header), like the ZMQ handler computes. */
function makeBlock(height) {
  const header = crypto.randomBytes(80);
  const hash = Buffer.from(
    crypto.createHash('sha256').update(crypto.createHash('sha256').update(header).digest()).digest()
  ).reverse().toString('hex');
  return {
    header,
    block: {
      hash,
      height,
      version: 536870912,
      pow_algo: 'sha256d',
      nTx: 1,
      difficulty: 1,
      time: Math.floor(Date.now() / 1000),
      tx: [{
        txid: crypto.randomBytes(32).toString('hex'),
        vin: [{ coinbase: '03' + crypto.randomBytes(8).toString('hex') }],
        vout: [{ value: 1, scriptPubKey: { address: 'DTestMinerAddress' } }],
      }],
    },
  };
}

/**
 * Minimal JSON-RPC node: a short chain plus any extra blocks the test registers.
 * Methods listed in `failMethods` answer with an RPC error.
 */
function startMockRpc(chain, { failMethods = [] } = {}) {
  const byHash = new Map(chain.map((b) => [b.hash, b]));
  const byHeight = new Map(chain.map((b) => [b.height, b]));
  const tip = () => chain[chain.length - 1];

  const handlers = {
    getblockchaininfo: () => ({
      chain: 'main', blocks: tip().height, headers: tip().height,
      bestblockhash: tip().hash, difficulty: 1, mediantime: tip().time,
      verificationprogress: 1, softforks: {},
    }),
    getblockcount: () => tip().height,
    getbestblockhash: () => tip().hash,
    getblockhash: ([h]) => byHeight.get(h)?.hash ?? null,
    getblock: ([hash]) => byHash.get(hash) ?? null,
    getpeerinfo: () => [],
    getnodeaddresses: () => [],
    getaddrmaninfo: () => ({ all_networks: { new: 0, tried: 0, total: 0 } }),
    getrawmempool: () => [],
    getmempoolinfo: () => ({ size: 0, bytes: 0, usage: 0, total_fee: 0 }),
    getchaintips: () => [{ height: tip().height, hash: tip().hash, branchlen: 0, status: 'active' }],
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let reply;
      try {
        const { id, method, params = [] } = JSON.parse(body);
        const fn = failMethods.includes(method) ? null : handlers[method];
        reply = fn
          ? { id, result: fn(params), error: null }
          : { id, result: null, error: { code: -32601, message: 'Method not found' } };
      } catch (e) {
        reply = { id: null, result: null, error: { code: -32700, message: e.message } };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        addBlock: (b) => { byHash.set(b.hash, b); },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Env for a spawned server.js: isolated ports, mock RPC, extras disabled. */
function serverEnv({ ports, mainnetUrl, testnetUrl }) {
  return {
    PORT: String(ports.http),
    DGB_WS_PORT: String(ports.ws),
    DGB_TESTNET_WS_PORT: String(ports.testnetWs),
    DGB_MAINNET_PRE_WS_PORT: String(ports.preWs),
    DGB_ZMQ_RAWBLOCK: `tcp://127.0.0.1:${ports.zmq}`,
    DGB_RPC_URL: mainnetUrl,
    DGB_TESTNET_RPC_URL: testnetUrl,
    DGB_MAINNET_PRE_ENABLED: 'false',
    DGB_CRAWLER_ENABLED: '0',
    DGB_FORK_TRACKER_ENABLED: '0',
    DGB_HISTORY_DISABLED: '1',
  };
}

async function allocatePorts() {
  return {
    http: await freePort(), ws: await freePort(), testnetWs: await freePort(),
    preWs: await freePort(), zmq: await freePort(),
  };
}

function getStatus(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

/** Spawn server.js and capture its output. */
function spawnServer({ cwd, env }) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proc = { child, output: '', exited: null };
  child.stdout.on('data', (d) => { proc.output += d; });
  child.stderr.on('data', (d) => { proc.output += d; });
  // 'close' (not 'exit') so all buffered stdout/stderr is captured first.
  child.on('close', (code, signal) => { proc.exited = { code, signal }; });

  proc.waitForLog = async (pattern, timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(proc.output)) return;
      if (proc.exited) {
        throw new Error(`server.js exited (${JSON.stringify(proc.exited)}) before ${pattern}:\n${proc.output.slice(-3000)}`);
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${pattern}:\n${proc.output.slice(-3000)}`);
  };

  proc.stop = () => new Promise((resolve) => {
    if (proc.exited) return resolve();
    child.once('close', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (!proc.exited) child.kill('SIGKILL'); }, 3000);
  });

  return proc;
}

function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const newBlocks = [];
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'newBlock') newBlocks.push(msg.data);
      } catch { /* ignore non-JSON */ }
    });
    ws.once('open', () => resolve({ ws, newBlocks }));
    ws.once('error', reject);
  });
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(data);
  });
}

function listTables(dbFile) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      db.all("SELECT name FROM sqlite_master WHERE type = 'table'", (err, rows) => {
        db.close();
        if (err) return reject(err);
        resolve(rows.map((r) => r.name));
      });
    });
  });
}

describe.skipIf(!HAS_CONFIG)('server.js process', () => {
  let tmpDir;
  let mainnetRpc;
  let testnetRpc;
  let publisher;
  let server;
  let ports;
  let mainClient;
  let testClient;

  const countFor = (list, hash) => list.filter((b) => b.hash === hash).length;

  beforeAll(async () => {
    // Fresh working dir with an EMPTY nodes.db file — the bug-2 scenario.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgbstats-proc-'));
    fs.writeFileSync(path.join(tmpDir, 'nodes.db'), '');

    const mainChain = [1, 2, 3, 4, 5].map((h) => makeBlock(h).block);
    const testChain = [1, 2, 3, 4, 5].map((h) => makeBlock(h).block);
    mainnetRpc = await startMockRpc(mainChain);
    testnetRpc = await startMockRpc(testChain);

    ports = await allocatePorts();
    publisher = new zmq.Publisher();
    await publisher.bind(`tcp://127.0.0.1:${ports.zmq}`);

    server = spawnServer({
      cwd: tmpDir,
      env: serverEnv({ ports, mainnetUrl: mainnetRpc.url, testnetUrl: testnetRpc.url }),
    });

    await server.waitForLog(/ZeroMQ initialization complete/);
    mainClient = await openClient(ports.ws);
    testClient = await openClient(ports.testnetWs);
    // ZMQ "slow joiner": give the subscription time to reach the publisher.
    await sleep(500);
  });

  afterAll(async () => {
    for (const c of [mainClient, testClient]) c?.ws.close();
    await server?.stop();
    publisher?.close();
    await mainnetRpc?.close();
    await testnetRpc?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fresh database startup', () => {
    test('starts on an empty nodes.db without crashing', () => {
      expect(server.exited).toBeNull();
      expect(server.output).not.toMatch(/no such table/i);
    });

    test('creates the core tables', async () => {
      const tables = await listTables(path.join(tmpDir, 'nodes.db'));
      expect(tables).toEqual(expect.arrayContaining(['nodes', 'visits', 'unique_ips']));
    });
  });

  describe('mainnet newBlock broadcast dedupe', () => {
    test('ZMQ first, then blocknotify: one newBlock', async () => {
      const { header, block } = makeBlock(6);
      mainnetRpc.addBlock(block);

      await publisher.send(['rawblock', header]);
      await server.waitForLog(new RegExp(`New block via ZeroMQ: ${block.hash}`), 5000);
      expect(await postJson(ports.http, '/api/blocknotify', { blockhash: block.hash })).toBe(200);
      await sleep(500);

      expect(countFor(mainClient.newBlocks, block.hash)).toBe(1);
    });

    test('blocknotify first, then ZMQ: one newBlock', async () => {
      const { header, block } = makeBlock(7);
      mainnetRpc.addBlock(block);

      expect(await postJson(ports.http, '/api/blocknotify', { blockhash: block.hash })).toBe(200);
      await publisher.send(['rawblock', header]);
      await server.waitForLog(new RegExp(`New block via ZeroMQ: ${block.hash}`), 5000);
      await sleep(500);

      expect(countFor(mainClient.newBlocks, block.hash)).toBe(1);
    });

    test('a different block at the same height (reorg) still broadcasts', async () => {
      const { block: original } = makeBlock(8);
      const { header, block: competitor } = makeBlock(8);
      mainnetRpc.addBlock(original);
      mainnetRpc.addBlock(competitor);

      expect(await postJson(ports.http, '/api/blocknotify', { blockhash: original.hash })).toBe(200);
      await publisher.send(['rawblock', header]);
      await server.waitForLog(new RegExp(`New block via ZeroMQ: ${competitor.hash}`), 5000);
      await sleep(500);

      expect(countFor(mainClient.newBlocks, original.hash)).toBe(1);
      expect(countFor(mainClient.newBlocks, competitor.hash)).toBe(1);
    });
  });

  describe('testnet newBlock broadcast dedupe', () => {
    test('the same block notified twice broadcasts once', async () => {
      const { block } = makeBlock(6);
      testnetRpc.addBlock(block);

      expect(await postJson(ports.http, '/api/testnet/blocknotify', { blockhash: block.hash })).toBe(200);
      expect(await postJson(ports.http, '/api/testnet/blocknotify', { blockhash: block.hash })).toBe(200);
      await sleep(500);

      expect(countFor(testClient.newBlocks, block.hash)).toBe(1);
    });

    test('a different block at the same height still broadcasts', async () => {
      const { block: a } = makeBlock(7);
      const { block: b } = makeBlock(7);
      testnetRpc.addBlock(a);
      testnetRpc.addBlock(b);

      expect(await postJson(ports.http, '/api/testnet/blocknotify', { blockhash: a.hash })).toBe(200);
      expect(await postJson(ports.http, '/api/testnet/blocknotify', { blockhash: b.hash })).toBe(200);
      await sleep(500);

      expect(countFor(testClient.newBlocks, a.hash)).toBe(1);
      expect(countFor(testClient.newBlocks, b.hash)).toBe(1);
    });
  });
});

// A failing getaddrmaninfo made refreshMainnetPeerData() reject. Its
// `.finally()` side-promise had no catch, so the rejection was unhandled and
// Node exited the whole process.
describe.skipIf(!HAS_CONFIG)('server.js process: getaddrmaninfo failure', () => {
  let tmpDir;
  let mainnetRpc;
  let testnetRpc;
  let server;
  let ports;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgbstats-proc-'));
    const chain = () => [1, 2, 3, 4, 5].map((h) => makeBlock(h).block);
    mainnetRpc = await startMockRpc(chain(), { failMethods: ['getaddrmaninfo'] });
    testnetRpc = await startMockRpc(chain());
    ports = await allocatePorts();

    server = spawnServer({
      cwd: tmpDir,
      env: serverEnv({ ports, mainnetUrl: mainnetRpc.url, testnetUrl: testnetRpc.url }),
    });
    await server.waitForLog(/Error fetching peer data from node: address-manager RPC \(getaddrmaninfo\) returned no data/);
    // The crash (if any) follows the rejection immediately; give it time.
    await sleep(1000);
  });

  afterAll(async () => {
    await server?.stop();
    await mainnetRpc?.close();
    await testnetRpc?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('stays up and keeps serving /health', async () => {
    expect(server.exited).toBeNull();
    expect(await getStatus(ports.http, '/health')).toBe(200);
  });

  test('logs the peer refresh failure', () => {
    expect(server.output).toMatch(/Mainnet peer refresh failed: address-manager RPC \(getaddrmaninfo\) returned no data/);
  });
});
