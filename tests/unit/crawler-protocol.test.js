// TDD: P2P wire-format primitives for the network crawler (crawler.js).
// The crawler performs a bitcoin-seeder-style version handshake against
// DigiByte nodes to record user agents, so the framing/serialization must be
// byte-exact: 24-byte header (magic | command | length LE | sha256d checksum),
// version payload with time-less CAddress fields, addr entries with 4-byte
// timestamps, varint/varstr encodings.
import { describe, it, expect } from 'vitest';
import {
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
} from '../../crawler.js';

describe('network constants', () => {
  it('carries current DigiByte mainnet and testnet magic/ports', () => {
    expect(NETWORKS.mainnet.magic.toString('hex')).toBe('fac3b6da');
    expect(NETWORKS.mainnet.port).toBe(12024);
    expect(NETWORKS.testnet.magic.toString('hex')).toBe('fec6b9e7');
    expect(NETWORKS.testnet.port).toBe(12033);
    expect(NETWORKS.mainnet.protocolVersion).toBe(70019);
  });
});

describe('sha256d', () => {
  it('double-hashes: checksum of empty payload is 5df6e0e2', () => {
    expect(sha256d(Buffer.alloc(0)).subarray(0, 4).toString('hex')).toBe('5df6e0e2');
  });
});

describe('varint', () => {
  it.each([
    [0, '00'],
    [252, 'fc'],
    [253, 'fdfd00'],
    [0xffff, 'fdffff'],
    [0x10000, 'fe00000100'],
    [0x01000000, 'fe00000001'],
  ])('encodes %d as %s and round-trips', (n, hex) => {
    const buf = encodeVarInt(n);
    expect(buf.toString('hex')).toBe(hex);
    const { value, size } = readVarInt(buf, 0);
    expect(value).toBe(n);
    expect(size).toBe(buf.length);
  });
});

describe('varstr', () => {
  it('length-prefixes the crawler user agent', () => {
    const ua = '/DigiByte:9.26.4/';
    const buf = encodeVarStr(ua);
    expect(buf[0]).toBe(ua.length); // 17 < 0xfd, single-byte varint
    expect(buf.subarray(1).toString('ascii')).toBe(ua);
    const { value, size } = readVarStr(buf, 0);
    expect(value).toBe(ua);
    expect(size).toBe(buf.length);
  });
});

describe('netaddr', () => {
  it('serializes IPv4 as IPv4-mapped IPv6 with big-endian port (no time field)', () => {
    const buf = serializeNetAddr('203.0.113.5', 12024, 0n);
    expect(buf.length).toBe(26); // 8 services + 16 ip + 2 port
    expect(buf.subarray(0, 8).toString('hex')).toBe('0000000000000000');
    expect(buf.subarray(8, 24).toString('hex')).toBe('00000000000000000000ffffcb007105');
    expect(buf.readUInt16BE(24)).toBe(12024);
  });

  it('round-trips IPv6 addresses', () => {
    const buf = serializeNetAddr('2001:db8::1', 12024, 1n);
    const parsed = parseNetAddr(buf, 0);
    expect(parsed.ip).toBe('2001:db8::1');
    expect(parsed.port).toBe(12024);
    expect(parsed.services).toBe(1n);
  });

  it('parses IPv4-mapped back to dotted quad', () => {
    const buf = serializeNetAddr('8.8.8.8', 12024, 0n);
    expect(parseNetAddr(buf, 0).ip).toBe('8.8.8.8');
  });
});

describe('buildMessage', () => {
  it('frames a mainnet verack exactly', () => {
    const msg = buildMessage(NETWORKS.mainnet.magic, 'verack', Buffer.alloc(0));
    expect(msg.toString('hex')).toBe(
      'fac3b6da' +                          // magic
      '76657261636b000000000000' +          // "verack" NUL-padded to 12
      '00000000' +                          // length 0
      '5df6e0e2'                            // sha256d('')[0..4]
    );
  });

  it('sets payload length little-endian and a real checksum', () => {
    const payload = Buffer.from('digibyte');
    const msg = buildMessage(NETWORKS.mainnet.magic, 'ping', payload);
    expect(msg.readUInt32LE(16)).toBe(8);
    expect(msg.subarray(20, 24)).toEqual(sha256d(payload).subarray(0, 4));
    expect(msg.subarray(24).toString()).toBe('digibyte');
  });
});

describe('createMessageParser', () => {
  const magic = NETWORKS.mainnet.magic;

  it('extracts messages across fragmented chunks', () => {
    const parser = createMessageParser(magic);
    const msg = buildMessage(magic, 'verack', Buffer.alloc(0));
    const first = parser.feed(msg.subarray(0, 10));
    expect(first).toHaveLength(0);
    const rest = parser.feed(msg.subarray(10));
    expect(rest).toHaveLength(1);
    expect(rest[0].command).toBe('verack');
    expect(rest[0].payload.length).toBe(0);
  });

  it('resyncs by scanning for magic after garbage', () => {
    const parser = createMessageParser(magic);
    const msg = buildMessage(magic, 'verack', Buffer.alloc(0));
    const out = parser.feed(Buffer.concat([Buffer.from('junkjunk'), msg]));
    expect(out).toHaveLength(1);
    expect(out[0].command).toBe('verack');
  });

  it('drops messages with bad checksums but keeps parsing', () => {
    const parser = createMessageParser(magic);
    const bad = buildMessage(magic, 'verack', Buffer.alloc(0));
    bad[20] ^= 0xff; // corrupt checksum
    const good = buildMessage(magic, 'pong', Buffer.alloc(8));
    const out = parser.feed(Buffer.concat([bad, good]));
    expect(out).toHaveLength(1);
    expect(out[0].command).toBe('pong');
  });

  it('flags oversize declared lengths as fatal', () => {
    const parser = createMessageParser(magic);
    const evil = buildMessage(magic, 'verack', Buffer.alloc(0));
    evil.writeUInt32LE(0x02000001, 16);
    parser.feed(evil);
    expect(parser.fatal).toBe(true);
  });
});

describe('version payload', () => {
  const fields = {
    protocolVersion: 70019,
    services: 0n,
    timestamp: 1751700000,
    recvIp: '203.0.113.5',
    recvPort: 12024,
    nonce: 0x0123456789abcdefn,
    userAgent: '/dgbstats-crawler:1.0/',
    startHeight: 23800000,
    relay: false,
  };

  it('round-trips through build + parse', () => {
    const payload = buildVersionPayload(fields);
    const parsed = parseVersionPayload(payload);
    expect(parsed.protocolVersion).toBe(70019);
    expect(parsed.services).toBe(0n);
    expect(parsed.userAgent).toBe('/dgbstats-crawler:1.0/');
    expect(parsed.startHeight).toBe(23800000);
  });

  it('has the canonical layout offsets', () => {
    const payload = buildVersionPayload(fields);
    expect(payload.readInt32LE(0)).toBe(70019);        // version
    expect(payload.readBigUInt64LE(4)).toBe(0n);       // services
    expect(Number(payload.readBigInt64LE(12))).toBe(1751700000); // timestamp
    // 20..46 addr_recv (26B), 46..72 addr_from (26B), 72..80 nonce
    expect(payload.readBigUInt64LE(72)).toBe(0x0123456789abcdefn);
    expect(payload[80]).toBe(fields.userAgent.length); // varstr length
  });

  it('parses truncated ancient version payloads without throwing', () => {
    const payload = buildVersionPayload(fields).subarray(0, 46); // stops after addr_recv
    const parsed = parseVersionPayload(payload);
    expect(parsed.protocolVersion).toBe(70019);
    expect(parsed.userAgent).toBe('');
    expect(parsed.startHeight).toBe(0);
  });
});

describe('addr payload', () => {
  it('parses a hand-built two-entry addr message', () => {
    const entry = (time, ip, port) => Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(time); return b; })(),
      serializeNetAddr(ip, port, 1n),
    ]);
    const payload = Buffer.concat([
      encodeVarInt(2),
      entry(1751600000, '198.51.100.7', 12024),
      entry(1751600500, '2001:db8::2', 12024),
    ]);
    const addrs = parseAddrPayload(payload);
    expect(addrs).toHaveLength(2);
    expect(addrs[0]).toMatchObject({ time: 1751600000, ip: '198.51.100.7', port: 12024 });
    expect(addrs[1].ip).toBe('2001:db8::2');
  });

  it('returns [] for a malformed payload instead of throwing', () => {
    expect(parseAddrPayload(Buffer.from('ff00', 'hex'))).toEqual([]);
  });
});

describe('isRoutable', () => {
  it.each([
    ['8.8.8.8', true],
    ['203.0.113.5', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['192.168.1.1', false],
    ['172.16.0.9', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['2001:db8::1', true],
    ['not-an-ip', false],
  ])('%s -> %s', (ip, expected) => {
    expect(isRoutable(ip)).toBe(expected);
  });
});

describe('parseUserAgentVersion', () => {
  it('parses plain core user agents', () => {
    expect(parseUserAgentVersion('/DigiByte:8.26.2/')).toEqual([8, 26, 2]);
    expect(parseUserAgentVersion('/DigiByte:9.26.4/')).toEqual([9, 26, 4]);
  });

  it('parses suffixed core builds', () => {
    expect(parseUserAgentVersion('/DigiByte:9.26.3(dgb-bitcore)/')).toEqual([9, 26, 3]);
    expect(parseUserAgentVersion('/DigiByte:8.26.2(ramnic)/')).toEqual([8, 26, 2]);
  });

  it('rejects non-core agents', () => {
    expect(parseUserAgentVersion('/digj:0.16.2/DigiByte Wallet:9.26/')).toBeNull();
    expect(parseUserAgentVersion('')).toBeNull();
    expect(parseUserAgentVersion(null)).toBeNull();
  });
});

describe('compareCoreVersion', () => {
  it('orders element-wise with missing parts as zero', () => {
    expect(compareCoreVersion([9, 26, 4], [8, 26])).toBeGreaterThan(0);
    expect(compareCoreVersion([8, 26], [8, 26, 0])).toBe(0);
    expect(compareCoreVersion([8, 22, 2], [8, 26])).toBeLessThan(0);
  });
});
