// TDD: crawler probe + persistence — drives probeNode() against an in-test
// fake DigiByte node (real TCP sockets, real framing) and exercises the
// SQLite layer (upsert on success/failure, backoff scheduling, rolling-24h
// selection, stale eviction) plus one full createCrawler() round.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import sqlite3 from 'sqlite3';
import {
  NETWORKS,
  buildMessage,
  createMessageParser,
  buildVersionPayload,
  parseVersionPayload,
  encodeVarInt,
  serializeNetAddr,
  probeNode,
  initializeCrawlerTables,
  recordProbeResult,
  getNodesSeenSince,
  getDueNodes,
  evictStaleNodes,
  createCrawler,
} from '../../crawler.js';

const MAGIC = NETWORKS.mainnet.magic;

/**
 * Minimal fake DigiByte node: answers version -> version+verack, getaddr -> addr.
 */
function startFakeNode({ userAgent = '/DigiByte:9.26.4/', startHeight = 23800000, addrs = [], silent = false } = {}) {
  const stats = { connections: 0 };
  const server = net.createServer((socket) => {
    stats.connections += 1;
    if (silent) return; // accept and say nothing (timeout path)
    const parser = createMessageParser(MAGIC);
    socket.on('data', (chunk) => {
      for (const msg of parser.feed(chunk)) {
        if (msg.command === 'version') {
          const theirs = parseVersionPayload(msg.payload);
          const payload = buildVersionPayload({
            protocolVersion: 70019,
            services: 1n,
            timestamp: Math.floor(Date.now() / 1000),
            recvIp: '127.0.0.1',
            recvPort: theirs.startHeight || 0,
            nonce: 42n,
            userAgent,
            startHeight,
            relay: false,
          });
          socket.write(buildMessage(MAGIC, 'version', payload));
          socket.write(buildMessage(MAGIC, 'verack', Buffer.alloc(0)));
        } else if (msg.command === 'getaddr' && addrs.length) {
          const entries = addrs.map(({ time, ip, port }) => {
            const t = Buffer.alloc(4);
            t.writeUInt32LE(time);
            return Buffer.concat([t, serializeNetAddr(ip, port, 1n)]);
          });
          socket.write(buildMessage(MAGIC, 'addr', Buffer.concat([encodeVarInt(entries.length), ...entries])));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, stats }));
  });
}

const dbAll = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));

describe('probeNode against a fake node', () => {
  let fake;
  afterEach(() => fake?.server?.close());

  it('completes the handshake and captures the stats payload', async () => {
    fake = await startFakeNode({ userAgent: '/DigiByte:8.26.2/', startHeight: 23799999 });
    const res = await probeNode({ ip: '127.0.0.1', port: fake.port, network: 'mainnet', connectTimeoutMs: 1000, sessionTimeoutMs: 2000 });
    expect(res.success).toBe(true);
    expect(res.userAgent).toBe('/DigiByte:8.26.2/');
    expect(res.protocolVersion).toBe(70019);
    expect(res.startHeight).toBe(23799999);
  });

  it('harvests addr gossip when asked', async () => {
    fake = await startFakeNode({
      addrs: [
        { time: Math.floor(Date.now() / 1000) - 60, ip: '198.51.100.7', port: 12024 },
        { time: Math.floor(Date.now() / 1000) - 120, ip: '198.51.100.8', port: 12024 },
      ],
    });
    const res = await probeNode({ ip: '127.0.0.1', port: fake.port, network: 'mainnet', getAddr: true, connectTimeoutMs: 1000, sessionTimeoutMs: 3000 });
    expect(res.success).toBe(true);
    expect(res.addrs.map(a => a.ip).sort()).toEqual(['198.51.100.7', '198.51.100.8']);
  });

  it('fails cleanly on connection refused', async () => {
    const res = await probeNode({ ip: '127.0.0.1', port: 1, network: 'mainnet', connectTimeoutMs: 500, sessionTimeoutMs: 1000 });
    expect(res.success).toBe(false);
  });

  it('fails cleanly on a silent peer (session timeout)', async () => {
    fake = await startFakeNode({ silent: true });
    const res = await probeNode({ ip: '127.0.0.1', port: fake.port, network: 'mainnet', connectTimeoutMs: 500, sessionTimeoutMs: 800 });
    expect(res.success).toBe(false);
  }, 10000);
});

describe('crawler persistence', () => {
  let db;
  const NOW = 1751700000000;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initializeCrawlerTables(db);
  });
  afterEach(() => new Promise((r) => db.close(r)));

  it('upserts a success and resets failure state', async () => {
    await recordProbeResult(db, {
      network: 'mainnet', ip: '1.1.1.1', port: 12024, now: NOW,
      result: { success: true, userAgent: '/DigiByte:9.26.4/', protocolVersion: 70019, services: 1n, startHeight: 5 },
    });
    await recordProbeResult(db, { network: 'mainnet', ip: '1.1.1.1', port: 12024, now: NOW + 1000, result: { success: false } });
    await recordProbeResult(db, {
      network: 'mainnet', ip: '1.1.1.1', port: 12024, now: NOW + 2000,
      result: { success: true, userAgent: '/DigiByte:9.26.4/', protocolVersion: 70019, services: 1n, startHeight: 6 },
    });
    const rows = await dbAll(db, 'SELECT * FROM crawled_nodes');
    expect(rows).toHaveLength(1);
    expect(rows[0].fail_count).toBe(0);
    expect(rows[0].last_seen).toBe(NOW + 2000);
    expect(rows[0].first_seen).toBe(NOW);
    expect(rows[0].user_agent).toBe('/DigiByte:9.26.4/');
  });

  it('applies escalating failure backoff to next_attempt', async () => {
    const node = { network: 'mainnet', ip: '2.2.2.2', port: 12024 };
    await recordProbeResult(db, { ...node, now: NOW, result: { success: false } });
    let [row] = await dbAll(db, 'SELECT * FROM crawled_nodes');
    expect(row.fail_count).toBe(1);
    expect(row.next_attempt).toBe(NOW + 2 * 3600 * 1000);
    await recordProbeResult(db, { ...node, now: NOW, result: { success: false } });
    [row] = await dbAll(db, 'SELECT * FROM crawled_nodes');
    expect(row.next_attempt).toBe(NOW + 8 * 3600 * 1000);
    await recordProbeResult(db, { ...node, now: NOW, result: { success: false } });
    [row] = await dbAll(db, 'SELECT * FROM crawled_nodes');
    expect(row.next_attempt).toBe(NOW + 24 * 3600 * 1000);
  });

  it('enforces the 1000s revisit floor after success', async () => {
    await recordProbeResult(db, {
      network: 'mainnet', ip: '3.3.3.3', port: 12024, now: NOW,
      result: { success: true, userAgent: '/DigiByte:9.26.4/' },
    });
    const [row] = await dbAll(db, 'SELECT * FROM crawled_nodes');
    expect(row.next_attempt).toBe(NOW + 1000 * 1000);
  });

  it('selects due nodes and honors next_attempt', async () => {
    await recordProbeResult(db, { network: 'mainnet', ip: '4.4.4.4', port: 12024, now: NOW - 3 * 3600 * 1000, result: { success: false } });
    const notDue = await getDueNodes(db, 'mainnet', NOW - 2 * 3600 * 1000, 10);
    expect(notDue).toHaveLength(0);
    const due = await getDueNodes(db, 'mainnet', NOW, 10);
    expect(due.map(n => n.ip)).toEqual(['4.4.4.4']);
  });

  it('returns 24h sightings and evicts stale rows', async () => {
    await recordProbeResult(db, { network: 'mainnet', ip: '5.5.5.5', port: 12024, now: NOW - 3600 * 1000, result: { success: true, userAgent: '/DigiByte:8.26.2/' } });
    await recordProbeResult(db, { network: 'mainnet', ip: '6.6.6.6', port: 12024, now: NOW - 30 * 3600 * 1000, result: { success: true, userAgent: '/DigiByte:8.26.2/' } });
    const seen = await getNodesSeenSince(db, 'mainnet', NOW - 24 * 3600 * 1000);
    expect(seen.map(n => n.ip)).toEqual(['5.5.5.5']);
    // 6.6.6.6 last seen 30h ago -> not stale yet (7d); simulate 8 days
    const evicted = await evictStaleNodes(db, 'mainnet', NOW + 8 * 24 * 3600 * 1000);
    expect(evicted).toBe(2);
  });
});

describe('createCrawler round', () => {
  let db, fake;
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await initializeCrawlerTables(db);
  });
  afterEach(async () => {
    fake?.server?.close();
    await new Promise((r) => db.close(r));
  });

  it('probes seeds, records sightings, and reports a snapshot', async () => {
    fake = await startFakeNode({ userAgent: '/DigiByte:9.26.4/' });
    const snapshots = [];
    const crawler = createCrawler({
      db,
      network: 'mainnet',
      options: { concurrency: 4, connectTimeoutMs: 1000, sessionTimeoutMs: 2000, allowUnroutable: true },
      seedProviders: [async () => [{ ip: '127.0.0.1', port: fake.port }]],
      onSnapshot: (snap) => snapshots.push(snap),
    });
    await crawler.crawlOnce();
    const rows = await dbAll(db, 'SELECT * FROM crawled_nodes');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_agent).toBe('/DigiByte:9.26.4/');
    expect(snapshots.length).toBeGreaterThan(0);
    const snap = snapshots[snapshots.length - 1];
    expect(snap.totalUniqueNodes).toBe(1);
    expect(snap.versions[0].userAgent).toBe('/DigiByte:9.26.4/');
    // Default target series is the DigiDollar release line
    expect(snap.targetSeries).toBe('9.26');
    expect(snap.upgradedCount).toBe(1);
  });

  it('does not re-probe a known not-due node even when re-seeded every round', async () => {
    fake = await startFakeNode({ userAgent: '/DigiByte:9.26.4/' });
    const crawler = createCrawler({
      db,
      network: 'mainnet',
      options: { concurrency: 2, connectTimeoutMs: 1000, sessionTimeoutMs: 2000, allowUnroutable: true },
      seedProviders: [async () => [{ ip: '127.0.0.1', port: fake.port }]], // re-advertises each round
    });
    await crawler.crawlOnce();
    await crawler.crawlOnce(); // node has next_attempt = now + 1000s -> must be skipped
    expect(fake.stats.connections).toBe(1);
  });
});
