/**
 * Unit tests for RPC-based peer discovery (rpc.js)
 *
 * Covers buildPeerData() and fetchPeersFromNode(), which replace the legacy
 * peers.dat binary parsing. The old Python parsers assumed a fixed 62-byte
 * record layout and could not read the modern addrman format-4 (BIP155) file:
 * mainnet failed closed (0 nodes), testnet failed open (garbage addresses).
 * These functions read the node's address manager directly over RPC instead.
 */

const { buildPeerData, fetchPeersFromNode } = require('../../rpc.js');

// Representative `getnodeaddresses 0` output
const sampleNodeAddresses = [
  { time: 1779081358, services: 1033, address: '129.212.182.152', port: 12024, network: 'ipv4' },
  { time: 1779081300, services: 1033, address: '209.198.157.217', port: 12024, network: 'ipv4' },
  { time: 1779081200, services: 1033, address: '2602:ff4d:10f:10e:105:191c:f5bb:50a6', port: 12024, network: 'ipv6' },
  { time: 1779081100, services: 9, address: 'abcdefghij234567abcdefghij234567abcdefghij234567abcd.onion', port: 12024, network: 'onion' },
];

// Representative `getaddrmaninfo` output
const sampleAddrmanInfo = {
  ipv4: { new: 16868, tried: 397, total: 17265 },
  ipv6: { new: 12478, tried: 165, total: 12643 },
  onion: { new: 0, tried: 0, total: 0 },
  i2p: { new: 0, tried: 0, total: 0 },
  cjdns: { new: 0, tried: 0, total: 0 },
  all_networks: { new: 29346, tried: 562, total: 29908 },
};

describe('buildPeerData', () => {
  test('classifies IPv4 and IPv6 addresses into separate lists', () => {
    const result = buildPeerData(sampleNodeAddresses, sampleAddrmanInfo);
    expect(result.uniqueIPv4Addresses).toEqual(
      expect.arrayContaining(['129.212.182.152', '209.198.157.217'])
    );
    expect(result.uniqueIPv6Addresses).toEqual(['2602:ff4d:10f:10e:105:191c:f5bb:50a6']);
  });

  test('excludes non-geolocatable networks (onion/i2p/cjdns) from the IP lists', () => {
    const result = buildPeerData(sampleNodeAddresses, sampleAddrmanInfo);
    const all = [...result.uniqueIPv4Addresses, ...result.uniqueIPv6Addresses];
    expect(all.some((a) => a.endsWith('.onion'))).toBe(false);
  });

  test('deduplicates repeated addresses', () => {
    const dupes = [
      { address: '1.2.3.4', network: 'ipv4' },
      { address: '1.2.3.4', network: 'ipv4' },
      { address: '1.2.3.5', network: 'ipv4' },
    ];
    const result = buildPeerData(dupes, null);
    expect(result.uniqueIPv4Addresses).toEqual(['1.2.3.4', '1.2.3.5']);
    expect(result.totalUniqueIPv4Peers).toBe(2);
  });

  test('computes peer totals', () => {
    const result = buildPeerData(sampleNodeAddresses, sampleAddrmanInfo);
    expect(result.totalUniqueIPv4Peers).toBe(2);
    expect(result.totalUniqueIPv6Peers).toBe(1);
    expect(result.totalUniquePeers).toBe(3);
  });

  test('extracts addrman totals from getaddrmaninfo', () => {
    const result = buildPeerData(sampleNodeAddresses, sampleAddrmanInfo);
    expect(result.addrman.total).toBe(29908);
    expect(result.addrman.new).toBe(29346);
    expect(result.addrman.tried).toBe(562);
  });

  test('includes a per-network addrman breakdown', () => {
    const result = buildPeerData(sampleNodeAddresses, sampleAddrmanInfo);
    expect(result.addrman.byNetwork.ipv4).toEqual({ new: 16868, tried: 397, total: 17265 });
    expect(result.addrman.byNetwork.ipv6.total).toBe(12643);
    expect(result.addrman.byNetwork.onion.total).toBe(0);
  });

  test('returns addrman: null when getaddrmaninfo is unavailable', () => {
    const result = buildPeerData(sampleNodeAddresses, null);
    expect(result.addrman).toBeNull();
    expect(result.totalUniquePeers).toBe(3); // address list still works
  });

  test('handles null / empty getnodeaddresses without throwing', () => {
    expect(buildPeerData(null, null).totalUniquePeers).toBe(0);
    expect(buildPeerData([], sampleAddrmanInfo).totalUniquePeers).toBe(0);
    expect(buildPeerData([], sampleAddrmanInfo).addrman.total).toBe(29908);
  });

  test('ignores malformed address entries', () => {
    const messy = [
      { address: '8.8.8.8', network: 'ipv4' },
      { network: 'ipv4' },             // no address
      null,                            // null entry
      { address: 42, network: 'ipv4' },// non-string address
    ];
    expect(buildPeerData(messy, null).uniqueIPv4Addresses).toEqual(['8.8.8.8']);
  });

  test('produces deterministic, sorted output', () => {
    const unsorted = [
      { address: '9.9.9.9', network: 'ipv4' },
      { address: '1.1.1.1', network: 'ipv4' },
      { address: '5.5.5.5', network: 'ipv4' },
    ];
    expect(buildPeerData(unsorted, null).uniqueIPv4Addresses).toEqual(['1.1.1.1', '5.5.5.5', '9.9.9.9']);
  });
});

describe('fetchPeersFromNode', () => {
  test('queries getnodeaddresses and getaddrmaninfo and assembles peer data', async () => {
    const calls = [];
    const mockRpc = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getnodeaddresses') return sampleNodeAddresses;
      if (method === 'getaddrmaninfo') return sampleAddrmanInfo;
      throw new Error(`unexpected RPC ${method}`);
    };
    const result = await fetchPeersFromNode(mockRpc);
    expect(calls.map((c) => c.method).sort()).toEqual(['getaddrmaninfo', 'getnodeaddresses']);
    expect(calls.find((c) => c.method === 'getnodeaddresses').params).toEqual([0]);
    expect(result.totalUniquePeers).toBe(3);
    expect(result.addrman.total).toBe(29908);
  });

  test('degrades gracefully when an RPC returns null', async () => {
    const mockRpc = async (method) => {
      if (method === 'getnodeaddresses') return null;  // RPC failed
      if (method === 'getaddrmaninfo') return sampleAddrmanInfo;
      return null;
    };
    const result = await fetchPeersFromNode(mockRpc);
    expect(result.totalUniquePeers).toBe(0);
    expect(result.addrman.total).toBe(29908);
  });
});
