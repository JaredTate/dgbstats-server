// Guard tests for the native/data dependencies that get major-version bumps
// for security fixes (sqlite3, geoip-lite). They pin the exact behavior the
// app relies on, so an upgrade that changes it fails here first:
//   - sqlite3: file-backed DBs (nodes.db, history.db) survive close/reopen,
//     the persistMainnetNodes transaction pattern, the visits/unique_ips
//     queries, and run() exposing this.lastID / this.changes.
//   - geoip-lite: lookup() result shape for IPv4/IPv6, null for private or
//     junk input (rpc.js feeds it `addr.split(':')[0]`, e.g. "[2001"), and
//     it never throws.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3pkg from 'sqlite3';
import geoip from 'geoip-lite';
import { initHistoryTables, upsertReplace, queryDaily } from '../../history.js';

const sqlite3 = sqlite3pkg.verbose();

const open = (file) =>
  new Promise((res, rej) => {
    const db = new sqlite3.Database(file, (e) => (e ? rej(e) : res(db)));
  });
const close = (db) => new Promise((res, rej) => db.close((e) => (e ? rej(e) : res())));
const run = (db, sql, p = []) =>
  new Promise((res, rej) =>
    db.run(sql, p, function onDone(e) {
      e ? rej(e) : res({ lastID: this.lastID, changes: this.changes });
    })
  );
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

// Same schema server.js initializeDatabase() creates in nodes.db.
const NODES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nodes (ip TEXT PRIMARY KEY, country TEXT, city TEXT, lat REAL, lon REAL)`,
  `CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_timestamp ON visits(timestamp)`,
  `CREATE TABLE IF NOT EXISTS unique_ips (ip TEXT PRIMARY KEY)`,
];

// Copy of server.js persistMainnetNodes() against a given db handle.
function persistNodes(db, geoData) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM nodes');
      const stmt = db.prepare('INSERT INTO nodes (ip, country, city, lat, lon) VALUES (?, ?, ?, ?, ?)');
      geoData.forEach((n) => stmt.run(n.ip, n.country, n.city, n.lat, n.lon));
      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          return reject(err);
        }
        resolve();
      });
    });
  });
}

describe('sqlite3 contract (file-backed DBs)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgbstats-sqlite-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('exposes the verbose() API the app uses', () => {
    expect(typeof sqlite3.Database).toBe('function');
    expect(typeof sqlite3.VERSION).toBe('string');
  });

  it('nodes.db: transactional rewrite persists across close/reopen', async () => {
    const file = path.join(dir, 'nodes.db');
    let db = await open(file);
    for (const sql of NODES_SCHEMA) await run(db, sql);

    const batch = (n, tag) =>
      Array.from({ length: n }, (_, i) => ({ ip: `10.0.${tag}.${i}`, country: 'US', city: 'X', lat: 1.5, lon: -2.5 }));
    await persistNodes(db, batch(500, 1));
    await persistNodes(db, batch(250, 2)); // DELETE + re-insert replaces the table
    await close(db);

    db = await open(file);
    for (const sql of NODES_SCHEMA) await run(db, sql); // idempotent on an existing file
    const { count } = await get(db, 'SELECT COUNT(*) AS count FROM nodes');
    expect(count).toBe(250);
    const row = await get(db, 'SELECT * FROM nodes WHERE ip = ?', ['10.0.2.7']);
    expect(row).toEqual({ ip: '10.0.2.7', country: 'US', city: 'X', lat: 1.5, lon: -2.5 });
    await close(db);
  });

  it('visits / unique_ips: lastID, changes, CURRENT_TIMESTAMP and the 30-day window', async () => {
    const db = await open(path.join(dir, 'nodes.db'));
    for (const sql of NODES_SCHEMA) await run(db, sql);
    const a = await run(db, 'INSERT INTO visits (ip) VALUES (?)', ['203.0.113.1']);
    const b = await run(db, 'INSERT INTO visits (ip) VALUES (?)', ['203.0.113.2']);
    expect(a.lastID).toBe(1);
    expect(b.lastID).toBe(2);
    expect(b.changes).toBe(1);
    await run(db, "INSERT INTO visits (ip, timestamp) VALUES (?, datetime('now', '-40 days'))", ['203.0.113.3']);

    const recent = await get(db, "SELECT COUNT(*) AS n FROM visits WHERE timestamp > datetime('now', '-30 days')");
    expect(recent.n).toBe(2);

    await run(db, 'INSERT INTO unique_ips (ip) VALUES (?)', ['203.0.113.1']);
    await expect(run(db, 'INSERT INTO unique_ips (ip) VALUES (?)', ['203.0.113.1'])).rejects.toThrow(/UNIQUE/);
    const u = await get(db, 'SELECT COUNT(*) AS uniqueVisitors FROM unique_ips');
    expect(u.uniqueVisitors).toBe(1);
    const del = await run(db, 'DELETE FROM visits');
    expect(del.changes).toBe(3);
    await close(db);
  });

  it('history.db: tables + data survive close/reopen and re-init (migration path)', async () => {
    const file = path.join(dir, 'history.db');
    let db = await open(file);
    await initHistoryTables(db);
    const nowSec = Date.UTC(2026, 6, 5, 12) / 1000;
    await upsertReplace(db, 'mainnet', {
      day: '2026-07-04', algo: 'SHA256D', block_count: 5, sum_difficulty: 25,
      min_difficulty: 1, max_difficulty: 9, last_difficulty: 9, last_height: 8,
    });
    await close(db);

    db = await open(file);
    await initHistoryTables(db); // runs CREATE IF NOT EXISTS + ensureColumn on an existing file
    const res = await queryDaily(db, 'mainnet', 7, nowSec);
    expect(res.data.map((d) => d.date)).toEqual(['2026-07-04']);
    expect(res.data[0].perAlgo.SHA256D.avgDifficulty).toBe(5);
    const cols = (await all(db, 'PRAGMA table_info(history_meta)')).map((c) => c.name);
    expect(cols).toContain('backfill_low_height');
    await close(db);
  });
});

describe('geoip-lite contract', () => {
  const expectShape = (info) => {
    expect(info).toBeTruthy();
    expect(typeof info.country).toBe('string');
    expect(typeof info.city).toBe('string');
    expect(Array.isArray(info.ll)).toBe(true);
    expect(info.ll).toHaveLength(2);
    expect(Number.isFinite(info.ll[0])).toBe(true);
    expect(Number.isFinite(info.ll[1])).toBe(true);
  };

  it('looks up a public IPv4 address', () => {
    const info = geoip.lookup('8.8.8.8');
    expectShape(info);
    expect(info.country).toBe('US');
  });

  it('looks up a public IPv6 address', () => {
    const info = geoip.lookup('2001:4860:4860::8888');
    expectShape(info);
    expect(info.country).toBe('US');
  });

  it('looks up an IPv4-mapped IPv6 address like the IPv4 one', () => {
    const info = geoip.lookup('::ffff:8.8.8.8');
    expectShape(info);
    expect(info.country).toBe('US');
  });

  it.each(['127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', 'fe80::1'])('returns null for non-routable %s', (ip) => {
    expect(geoip.lookup(ip)).toBeNull();
  });

  // rpc.js does node.addr.split(':')[0], which yields "[2001" for IPv6 peers.
  it.each(['[2001', 'not-an-ip', '', undefined, null, '1.2.3', '999.1.1.1'])(
    'returns null and does not throw for junk input %s',
    (ip) => {
      expect(() => geoip.lookup(ip)).not.toThrow();
      expect(geoip.lookup(ip)).toBeNull();
    }
  );

  it('does not stall on a very long IPv6-like string', () => {
    const t0 = Date.now();
    expect(() => geoip.lookup('2001:db8::1%' + 'a'.repeat(100000))).not.toThrow();
    expect(() => geoip.lookup('1:'.repeat(50000))).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('zeromq native module', () => {
  it('loads and can create, connect and close a Subscriber', async () => {
    const zmq = (await import('zeromq')).default ?? (await import('zeromq'));
    const sub = new zmq.Subscriber();
    sub.connect('tcp://127.0.0.1:59999'); // connect is lazy; no server needed
    sub.subscribe('rawtx');
    sub.close();
    expect(sub.closed).toBe(true);
  });
});
