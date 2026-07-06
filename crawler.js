/**
 * DigiByte network crawler
 *
 * Bitcoin-seeder-style reachability crawler: TCP connect -> version handshake
 * -> record user agent / protocol version / services / height -> optional
 * getaddr gossip harvest -> disconnect. Feeds the rolling "nodes seen in the
 * last 24 hours" version breakdown on the stats site.
 *
 * Design notes (mirrors DigiByte-Core/digibyte-seeder politeness):
 *  - a node is asked for getaddr at most once per 24h; other visits are
 *    handshake-only liveness pings
 *  - revisit floor of 1000s after a success; failure backoff 2h -> 8h -> 24h
 *  - rows unseen AND unattempted for 7 days are evicted
 *  - "reachable" means a completed version/verack exchange, not a TCP accept
 *
 * Coexists with the peers.dat pipeline: this module never touches the `nodes`
 * table (which is wiped on every 10-minute peers.dat refresh); it owns
 * `crawled_nodes` exclusively.
 */

const net = require('net');
const crypto = require('crypto');
const geoip = require('geoip-lite');

const NETWORKS = {
  mainnet: { magic: Buffer.from('fac3b6da', 'hex'), port: 12024, protocolVersion: 70019 },
  testnet: { magic: Buffer.from('fec6b9e7', 'hex'), port: 12033, protocolVersion: 70019 },
};

const MAX_MESSAGE_SIZE = 0x02000000; // seeder MAX_SIZE guard
const REVISIT_INTERVAL_MS = 24 * 3600 * 1000; // re-audit an already-seen node at most once per 24h (rolling window; stay a polite crawler and never re-handshake peers every round)
const GETADDR_INTERVAL_MS = 24 * 3600 * 1000;
const FAILURE_BACKOFF_MS = [2 * 3600 * 1000, 8 * 3600 * 1000, 24 * 3600 * 1000];
const EVICT_AFTER_MS = 7 * 24 * 3600 * 1000;
const GOSSIP_MAX_AGE_S = 7 * 24 * 3600; // ignore addr entries older than a week

// ---------------------------------------------------------------------------
// Hashing / primitive encodings
// ---------------------------------------------------------------------------

function sha256d(buf) {
  const h1 = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('sha256').update(h1).digest();
}

function encodeVarInt(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

function readVarInt(buf, offset) {
  if (offset >= buf.length) throw new RangeError('varint: out of bounds');
  const first = buf[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) {
    if (offset + 3 > buf.length) throw new RangeError('varint: truncated');
    return { value: buf.readUInt16LE(offset + 1), size: 3 };
  }
  if (first === 0xfe) {
    if (offset + 5 > buf.length) throw new RangeError('varint: truncated');
    return { value: buf.readUInt32LE(offset + 1), size: 5 };
  }
  if (offset + 9 > buf.length) throw new RangeError('varint: truncated');
  return { value: Number(buf.readBigUInt64LE(offset + 1)), size: 9 };
}

function encodeVarStr(s) {
  const strBuf = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeVarInt(strBuf.length), strBuf]);
}

function readVarStr(buf, offset) {
  const { value: len, size } = readVarInt(buf, offset);
  if (offset + size + len > buf.length) throw new RangeError('varstr: truncated');
  return { value: buf.toString('utf8', offset + size, offset + size + len), size: size + len };
}

// ---------------------------------------------------------------------------
// IP handling
// ---------------------------------------------------------------------------

function ipv6ToBytes(ip) {
  // Handle embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  let v4Tail = null;
  let head = ip;
  const lastColon = ip.lastIndexOf(':');
  if (ip.includes('.')) {
    v4Tail = ip.slice(lastColon + 1).split('.').map(Number);
    head = ip.slice(0, lastColon) + (v4Tail ? ':0:0' : '');
  }
  const halves = head.split('::');
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) bytes.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
  if (v4Tail) {
    bytes[12] = v4Tail[0]; bytes[13] = v4Tail[1]; bytes[14] = v4Tail[2]; bytes[15] = v4Tail[3];
  }
  return bytes;
}

function bytesToIp(bytes) {
  const v4Prefix = Buffer.from('00000000000000000000ffff', 'hex');
  if (bytes.subarray(0, 12).equals(v4Prefix)) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  const groups = [];
  for (let i = 0; i < 8; i++) groups.push(bytes.readUInt16BE(i * 2).toString(16));
  // Compress the longest run of zero groups (leftmost on ties), per RFC 5952
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== '0') continue;
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
    i = j;
  }
  if (bestLen < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

function ipToBytes(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    return Buffer.concat([Buffer.from('00000000000000000000ffff', 'hex'), Buffer.from(parts)]);
  }
  return ipv6ToBytes(ip);
}

function serializeNetAddr(ip, port, services) {
  const buf = Buffer.alloc(26);
  buf.writeBigUInt64LE(BigInt(services), 0);
  ipToBytes(ip).copy(buf, 8);
  buf.writeUInt16BE(port, 24);
  return buf;
}

function parseNetAddr(buf, offset) {
  if (offset + 26 > buf.length) throw new RangeError('netaddr: truncated');
  return {
    services: buf.readBigUInt64LE(offset),
    ip: bytesToIp(buf.subarray(offset + 8, offset + 24)),
    port: buf.readUInt16BE(offset + 24),
  };
}

function isRoutable(ip) {
  const family = net.isIP(ip);
  if (family === 0) return false;
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return false;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return false; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // ULA
  if (lower.startsWith('::ffff:')) return isRoutable(lower.slice(7));
  return true;
}

// ---------------------------------------------------------------------------
// Message framing
// ---------------------------------------------------------------------------

function buildMessage(magic, command, payload) {
  const header = Buffer.alloc(24);
  magic.copy(header, 0);
  header.write(command, 4, 'ascii');
  header.writeUInt32LE(payload.length, 16);
  sha256d(payload).copy(header, 20, 0, 4);
  return Buffer.concat([header, payload]);
}

/**
 * Stateful stream parser: scans for magic, verifies checksums, skips corrupt
 * messages, and flags protocol garbage (oversize declared length) as fatal.
 */
function createMessageParser(magic) {
  let buffer = Buffer.alloc(0);
  const parser = {
    fatal: false,
    feed(chunk) {
      if (parser.fatal) return [];
      buffer = Buffer.concat([buffer, chunk]);
      const messages = [];
      for (;;) {
        const idx = buffer.indexOf(magic);
        if (idx === -1) {
          buffer = buffer.subarray(Math.max(0, buffer.length - (magic.length - 1)));
          break;
        }
        if (idx > 0) buffer = buffer.subarray(idx);
        if (buffer.length < 24) break;
        const length = buffer.readUInt32LE(16);
        if (length > MAX_MESSAGE_SIZE) {
          parser.fatal = true;
          break;
        }
        if (buffer.length < 24 + length) break;
        const command = buffer.toString('ascii', 4, 16).replace(/\0+$/, '');
        const payload = buffer.subarray(24, 24 + length);
        const checksum = buffer.subarray(20, 24);
        if (sha256d(payload).subarray(0, 4).equals(checksum)) {
          messages.push({ command, payload: Buffer.from(payload) });
        }
        buffer = buffer.subarray(24 + length);
      }
      return messages;
    },
  };
  return parser;
}

// ---------------------------------------------------------------------------
// version / addr payloads
// ---------------------------------------------------------------------------

function buildVersionPayload({ protocolVersion, services, timestamp, recvIp, recvPort, nonce, userAgent, startHeight, relay }) {
  const head = Buffer.alloc(20);
  head.writeInt32LE(protocolVersion, 0);
  head.writeBigUInt64LE(BigInt(services), 4);
  head.writeBigInt64LE(BigInt(timestamp), 12);
  const tail = Buffer.alloc(5);
  tail.writeInt32LE(startHeight, 0);
  tail[4] = relay ? 1 : 0;
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);
  return Buffer.concat([
    head,
    serializeNetAddr(recvIp, recvPort, 0),        // addr_recv (no time field in version msg)
    serializeNetAddr('0.0.0.0', 0, services),      // addr_from
    nonceBuf,
    encodeVarStr(userAgent),
    tail,
  ]);
}

function parseVersionPayload(payload) {
  const out = { protocolVersion: 0, services: 0n, userAgent: '', startHeight: 0 };
  try {
    if (payload.length >= 4) out.protocolVersion = payload.readInt32LE(0);
    if (payload.length >= 12) out.services = payload.readBigUInt64LE(4);
    // 12..20 timestamp, 20..46 addr_recv, 46..72 addr_from, 72..80 nonce
    if (payload.length > 80) {
      const ua = readVarStr(payload, 80);
      out.userAgent = ua.value;
      const heightOffset = 80 + ua.size;
      if (payload.length >= heightOffset + 4) out.startHeight = payload.readInt32LE(heightOffset);
    }
  } catch (e) {
    // Truncated or malformed tail: keep whatever parsed cleanly.
  }
  return out;
}

function parseAddrPayload(payload) {
  const addrs = [];
  try {
    const { value: count, size } = readVarInt(payload, 0);
    let offset = size;
    for (let i = 0; i < count; i++) {
      if (offset + 30 > payload.length) break;
      const time = payload.readUInt32LE(offset);
      const addr = parseNetAddr(payload, offset + 4);
      addrs.push({ time, services: addr.services, ip: addr.ip, port: addr.port });
      offset += 30;
    }
  } catch (e) {
    return [];
  }
  return addrs;
}

// ---------------------------------------------------------------------------
// User agent parsing / aggregation
// ---------------------------------------------------------------------------

/**
 * Extract the numeric core version from a '/DigiByte:x.y.z(...)/' user agent.
 * Returns an int array ([9,26,4]) or null for non-core agents.
 */
function parseUserAgentVersion(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return null;
  const match = userAgent.match(/\/DigiByte:(\d+(?:\.\d+)*)[^/]*\//);
  if (!match) return null;
  return match[1].split('.').map(Number);
}

function compareCoreVersion(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Build the nodeVersions24h payload from crawled_nodes rows.
 */
function aggregateVersions(rows, { now, windowHours, targetSeries }) {
  const windowStart = now - windowHours * 3600 * 1000;
  const freshest = new Map();
  for (const row of rows) {
    if (!row || typeof row.last_seen !== 'number' || row.last_seen < windowStart || row.last_seen > now) continue;
    const key = `${row.ip}:${row.port}`;
    const prev = freshest.get(key);
    if (!prev || row.last_seen > prev.last_seen) freshest.set(key, row);
  }
  const total = freshest.size;
  const counts = new Map();
  const target = targetSeries.split('.').map(Number);
  let upgradedCount = 0;
  let latest = null;
  for (const row of freshest.values()) {
    const ua = row.user_agent || '(unknown)';
    counts.set(ua, (counts.get(ua) || 0) + 1);
    const version = parseUserAgentVersion(ua);
    if (version) {
      if (compareCoreVersion(version, target) >= 0) upgradedCount += 1;
      if (!latest || compareCoreVersion(version, latest) > 0) latest = version;
    }
  }
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  const versions = [...counts.entries()]
    .map(([userAgent, count]) => {
      const version = parseUserAgentVersion(userAgent);
      return {
        userAgent,
        count,
        percent: pct(count),
        isLatest: !!(version && latest && compareCoreVersion(version, latest) === 0),
      };
    })
    .sort((a, b) => b.count - a.count || a.userAgent.localeCompare(b.userAgent));
  return {
    windowHours,
    totalUniqueNodes: total,
    updatedAt: now,
    latestVersion: latest ? latest.join('.') : null,
    targetSeries,
    upgradedCount,
    upgradedPercent: pct(upgradedCount),
    versions,
  };
}

// ---------------------------------------------------------------------------
// Probe (one node, one session)
// ---------------------------------------------------------------------------

function probeNode({
  ip,
  port,
  network = 'mainnet',
  getAddr = false,
  connectTimeoutMs = 5000,
  sessionTimeoutMs = 30000,
  userAgent = '/dgbstats-crawler:1.0/',
  startHeight = 0,
}) {
  const { magic, protocolVersion } = NETWORKS[network];
  return new Promise((resolve) => {
    const started = Date.now();
    const result = { success: false, ip, port, addrs: [] };
    let settled = false;
    let sessionTimer = null;

    const socket = net.connect({ host: ip, port, family: net.isIP(ip) === 6 ? 6 : 4 });
    socket.setNoDelay(true);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(sessionTimer);
      socket.destroy();
      if (error) result.error = error;
      result.durationMs = Date.now() - started;
      resolve(result);
    };

    socket.setTimeout(connectTimeoutMs, () => finish('connect-timeout'));
    socket.on('error', (err) => finish(err.code || 'socket-error'));
    socket.on('close', () => finish(result.success ? null : 'closed-before-handshake'));

    const parser = createMessageParser(magic);
    let gotVersion = false;
    let gotVerack = false;

    const maybeAdvance = () => {
      if (!gotVersion || !gotVerack) return;
      result.success = true;
      if (getAddr) {
        socket.write(buildMessage(magic, 'getaddr', Buffer.alloc(0)));
        // finish() happens on the first multi-entry addr batch or session timeout
      } else {
        finish(null);
      }
    };

    socket.on('connect', () => {
      socket.setTimeout(0);
      sessionTimer = setTimeout(() => finish(result.success ? null : 'session-timeout'), sessionTimeoutMs);
      const payload = buildVersionPayload({
        protocolVersion,
        services: 0,
        timestamp: Math.floor(Date.now() / 1000),
        recvIp: net.isIP(ip) ? ip : '0.0.0.0',
        recvPort: port,
        nonce: crypto.randomBytes(8).readBigUInt64LE(0),
        userAgent,
        startHeight,
        relay: false,
      });
      socket.write(buildMessage(magic, 'version', payload));
    });

    socket.on('data', (chunk) => {
      let messages;
      try {
        messages = parser.feed(chunk);
      } catch (e) {
        return finish('parse-error');
      }
      if (parser.fatal) return finish('protocol-garbage');
      for (const msg of messages) {
        if (msg.command === 'version' && !gotVersion) {
          gotVersion = true;
          const fields = parseVersionPayload(msg.payload);
          result.userAgent = fields.userAgent;
          result.protocolVersion = fields.protocolVersion;
          result.services = fields.services;
          result.startHeight = fields.startHeight;
          socket.write(buildMessage(magic, 'verack', Buffer.alloc(0)));
          maybeAdvance();
        } else if (msg.command === 'verack' && !gotVerack) {
          gotVerack = true;
          maybeAdvance();
        } else if (msg.command === 'addr' && getAddr && result.success) {
          const batch = parseAddrPayload(msg.payload);
          result.addrs.push(...batch);
          if (batch.length > 1 || result.addrs.length > 1000) finish(null);
        } else if (msg.command === 'ping' && msg.payload.length === 8) {
          socket.write(buildMessage(magic, 'pong', msg.payload));
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const run = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const all = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

function initializeCrawlerTables(db) {
  return run(
    db,
    `CREATE TABLE IF NOT EXISTS crawled_nodes (
      network TEXT NOT NULL DEFAULT 'mainnet',
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      user_agent TEXT,
      protocol_version INTEGER,
      services TEXT,
      start_height INTEGER,
      first_seen INTEGER,
      last_seen INTEGER,
      last_attempt INTEGER,
      last_getaddr INTEGER,
      fail_count INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0,
      country TEXT,
      city TEXT,
      lat REAL,
      lon REAL,
      PRIMARY KEY (network, ip, port)
    )`
  ).then(() => run(db, 'CREATE INDEX IF NOT EXISTS idx_crawled_nodes_last_seen ON crawled_nodes(network, last_seen)'));
}

async function recordProbeResult(db, { network, ip, port, now, result, geo = null, didGetAddr = false }) {
  if (result.success) {
    await run(
      db,
      `INSERT INTO crawled_nodes (network, ip, port, user_agent, protocol_version, services, start_height,
         first_seen, last_seen, last_attempt, last_getaddr, fail_count, next_attempt, country, city, lat, lon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(network, ip, port) DO UPDATE SET
         user_agent = excluded.user_agent,
         protocol_version = excluded.protocol_version,
         services = excluded.services,
         start_height = excluded.start_height,
         last_seen = excluded.last_seen,
         last_attempt = excluded.last_attempt,
         last_getaddr = COALESCE(excluded.last_getaddr, crawled_nodes.last_getaddr),
         fail_count = 0,
         next_attempt = excluded.next_attempt,
         country = COALESCE(excluded.country, crawled_nodes.country),
         city = COALESCE(excluded.city, crawled_nodes.city),
         lat = COALESCE(excluded.lat, crawled_nodes.lat),
         lon = COALESCE(excluded.lon, crawled_nodes.lon)`,
      [
        network, ip, port,
        result.userAgent || null,
        result.protocolVersion || null,
        result.services != null ? result.services.toString() : null,
        result.startHeight || null,
        now, now, now,
        didGetAddr ? now : null,
        now + REVISIT_INTERVAL_MS,
        geo?.country || null, geo?.city || null, geo?.lat ?? null, geo?.lon ?? null,
      ]
    );
  } else {
    const tiers = FAILURE_BACKOFF_MS;
    await run(
      db,
      `INSERT INTO crawled_nodes (network, ip, port, last_attempt, fail_count, next_attempt)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(network, ip, port) DO UPDATE SET
         last_attempt = excluded.last_attempt,
         fail_count = crawled_nodes.fail_count + 1,
         next_attempt = excluded.last_attempt + CASE
           WHEN crawled_nodes.fail_count + 1 <= 1 THEN ${tiers[0]}
           WHEN crawled_nodes.fail_count + 1 = 2 THEN ${tiers[1]}
           ELSE ${tiers[2]} END`,
      [network, ip, port, now, now + tiers[0]]
    );
  }
}

function getNodesSeenSince(db, network, sinceMs) {
  return all(db, 'SELECT * FROM crawled_nodes WHERE network = ? AND last_seen >= ? ORDER BY last_seen DESC', [network, sinceMs]);
}

function getDueNodes(db, network, now, limit) {
  return all(
    db,
    'SELECT ip, port, last_getaddr, fail_count FROM crawled_nodes WHERE network = ? AND next_attempt <= ? ORDER BY next_attempt ASC LIMIT ?',
    [network, now, limit]
  );
}

async function evictStaleNodes(db, network, now) {
  const cutoff = now - EVICT_AFTER_MS;
  const res = await run(
    db,
    `DELETE FROM crawled_nodes WHERE network = ?
       AND (last_seen IS NULL OR last_seen < ?)
       AND (last_attempt IS NULL OR last_attempt < ?)`,
    [network, cutoff, cutoff]
  );
  return res.changes;
}

// ---------------------------------------------------------------------------
// Crawler lifecycle
// ---------------------------------------------------------------------------

function createCrawler({ db, network = 'mainnet', options = {}, seedProviders = [], onSnapshot = null, log = () => {} }) {
  const opts = {
    concurrency: Number(process.env.DGB_CRAWLER_CONCURRENCY) || 48,
    connectTimeoutMs: 5000,
    sessionTimeoutMs: 30000,
    batchSize: 400,
    windowHours: 24,
    targetSeries: process.env.DGB_CRAWLER_TARGET_SERIES || '9.26', // DigiDollar release line
    intervalMs: 60 * 1000,
    allowUnroutable: false,
    startHeight: 0,
    ...options,
  };
  const frontier = new Map(); // "ip:port" -> {ip, port} not yet probed this lifetime
  let running = false;
  let crawling = false;
  let timer = null;
  let lastSnapshot = null;

  const enqueue = (ip, port) => {
    if (!ip || !port) return;
    if (!opts.allowUnroutable && !isRoutable(ip)) return;
    const key = `${ip}:${port}`;
    if (!frontier.has(key)) frontier.set(key, { ip, port });
  };

  async function gatherSeeds() {
    for (const provider of seedProviders) {
      try {
        const seeds = await provider();
        for (const s of seeds || []) enqueue(s.ip, s.port || NETWORKS[network].port);
      } catch (err) {
        log(`crawler seed provider failed: ${err.message}`);
      }
    }
  }

  async function probeBatch(targets, now) {
    let index = 0;
    const worker = async () => {
      for (;;) {
        const i = index++;
        if (i >= targets.length || !crawling) return;
        const target = targets[i];
        const wantAddr = !target.last_getaddr || now - target.last_getaddr > GETADDR_INTERVAL_MS;
        const result = await probeNode({
          ip: target.ip,
          port: target.port,
          network,
          getAddr: wantAddr,
          connectTimeoutMs: opts.connectTimeoutMs,
          sessionTimeoutMs: opts.sessionTimeoutMs,
          startHeight: opts.startHeight,
        });
        const geo = result.success ? (() => {
          const info = geoip.lookup(target.ip);
          return info ? { country: info.country || null, city: info.city || null, lat: info.ll?.[0] ?? null, lon: info.ll?.[1] ?? null } : null;
        })() : null;
        await recordProbeResult(db, {
          network, ip: target.ip, port: target.port, now: Date.now(), result, geo,
          didGetAddr: result.success && wantAddr,
        });
        if (result.success) {
          const fresh = Math.floor(Date.now() / 1000) - GOSSIP_MAX_AGE_S;
          for (const addr of result.addrs) {
            if (addr.time > fresh) enqueue(addr.ip, addr.port);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, targets.length) }, worker));
  }

  async function crawlOnce() {
    if (crawling) return lastSnapshot;
    crawling = true;
    try {
      const now = Date.now();
      await gatherSeeds();
      const due = await getDueNodes(db, network, now, opts.batchSize);
      const dueKeys = new Set(due.map((n) => `${n.ip}:${n.port}`));
      // Known nodes that are not due yet must not be re-probed even if a seed
      // provider re-advertises them every round (politeness floor).
      const notDue = await all(db, 'SELECT ip, port FROM crawled_nodes WHERE network = ? AND next_attempt > ?', [network, now]);
      const notDueKeys = new Set(notDue.map((n) => `${n.ip}:${n.port}`));
      const fromFrontier = [];
      for (const [key, target] of frontier) {
        if (fromFrontier.length + due.length >= opts.batchSize) break;
        frontier.delete(key);
        if (!dueKeys.has(key) && !notDueKeys.has(key)) fromFrontier.push(target);
      }
      const targets = [...due, ...fromFrontier];
      if (targets.length > 0) {
        log(`crawler(${network}): probing ${targets.length} nodes (${due.length} revisits, ${fromFrontier.length} new)`);
        await probeBatch(targets, now);
      }
      await evictStaleNodes(db, network, Date.now());
      const rows = await getNodesSeenSince(db, network, Date.now() - opts.windowHours * 3600 * 1000);
      lastSnapshot = aggregateVersions(rows, { now: Date.now(), windowHours: opts.windowHours, targetSeries: opts.targetSeries });
      if (onSnapshot) onSnapshot(lastSnapshot);
      return lastSnapshot;
    } finally {
      crawling = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      crawlOnce().catch((err) => log(`crawler round failed: ${err.message}`));
      timer = setInterval(() => {
        crawlOnce().catch((err) => log(`crawler round failed: ${err.message}`));
      }, opts.intervalMs);
    },
    stop() {
      running = false;
      crawling = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
    crawlOnce,
    getSnapshot: () => lastSnapshot,
    enqueue,
  };
}

module.exports = {
  NETWORKS,
  sha256d,
  encodeVarInt,
  readVarInt,
  encodeVarStr,
  readVarStr,
  serializeNetAddr,
  parseNetAddr,
  buildMessage,
  createMessageParser,
  buildVersionPayload,
  parseVersionPayload,
  parseAddrPayload,
  isRoutable,
  parseUserAgentVersion,
  compareCoreVersion,
  aggregateVersions,
  probeNode,
  initializeCrawlerTables,
  recordProbeResult,
  getNodesSeenSince,
  getDueNodes,
  evictStaleNodes,
  createCrawler,
};
