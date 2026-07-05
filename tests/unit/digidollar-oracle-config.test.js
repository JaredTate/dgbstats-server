const fs = require('fs');
const path = require('path');

describe('DigiDollar Oracle/Testnet Configuration', () => {
  const projectRoot = path.resolve(__dirname, '..', '..');

  function readProjectFile(relPath) {
    return fs.readFileSync(path.join(projectRoot, relPath), 'utf8');
  }

  test('does not contain deprecated oracle consensus references', () => {
    const filesToCheck = [
      'server.js',
      'rpc.js',
      'config.js',
      'config.template.js'
    ];

    const deprecatedMarkers = ['5-of-9', '9-of-15'];

    filesToCheck.forEach((file) => {
      const contents = readProjectFile(file);
      deprecatedMarkers.forEach((marker) => {
        expect(contents).not.toContain(marker);
      });
    });
  });

  test('does not contain deprecated testnet25/port 12032 references in active config/docs', () => {
    const filesToCheck = [
      'server.js',
      'rpc.js',
      'config.js',
      'config.template.js',
      'README.md',
      'ARCHITECTURE.md',
      'REPO_MAP.md'
    ];

    const deprecatedMarkers = ['testnet25/peers.dat', '12032'];

    filesToCheck.forEach((file) => {
      const contents = readProjectFile(file);
      deprecatedMarkers.forEach((marker) => {
        expect(contents).not.toContain(marker);
      });
    });
  });

  test('oracle broadcast path remains RPC-relay based (no hardcoded threshold constants)', () => {
    const serverContents = readProjectFile('server.js');
    const rpcContents = readProjectFile('rpc.js');

    // Ensure server still relies on RPC methods that return oracle state
    expect(serverContents).toContain("sendTestnetRpcRequest('getoracleprice'");
    expect(serverContents).toContain("sendTestnetRpcRequest('getalloracleprices'");
    expect(serverContents).toContain("sendTestnetRpcRequest('getoracles'");
    expect(serverContents).toContain("sendTestnetRpcRequest('getoraclesigners'");
    expect(serverContents).toContain("sendTestnetRpcRequest('getdigidollardeploymentinfo'");
    expect(rpcContents).toContain("registerDigiDollarRoutes('/testnet', sendTestnetRpcRequest, 'testnet')");
    expect(rpcContents).toContain("getoraclesigners");
    expect(rpcContents).toContain("getprotectionstatus");
  });

  test('testnet defaults match current testnet26 ports and peer path', () => {
    const serverContents = readProjectFile('server.js');
    const rpcContents = readProjectFile('rpc.js');
    const templateContents = readProjectFile('config.template.js');
    const docsContents = [
      readProjectFile('README.md'),
      readProjectFile('ARCHITECTURE.md')
    ].join('\n');

    expect(serverContents).toContain("http://127.0.0.1:14026");
    expect(rpcContents).toContain("http://127.0.0.1:14026");
    expect(templateContents).toContain("testnet26/peers.dat");
    expect(docsContents).toContain("14026");
    expect(docsContents).not.toContain("14022");
  });

  test('peer discovery uses node RPC, not the removed peers.dat parsers', () => {
    const serverContents = readProjectFile('server.js');
    const rpcContents = readProjectFile('rpc.js');

    // The legacy Python peers.dat parsers have been removed: they assumed a
    // fixed 62-byte record layout and could not read the modern addrman
    // format-4 (BIP155) file (mainnet failed closed, testnet returned garbage).
    expect(fs.existsSync(path.join(projectRoot, 'parse_peers_dat.py'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'parse_testnet_peers.py'))).toBe(false);

    // The server no longer shells out to a Python interpreter for peer data.
    expect(serverContents).not.toContain('python3');
    expect(serverContents).not.toContain("require('child_process')");

    // Peer data is now read from the node's address manager over RPC.
    expect(rpcContents).toContain("'getnodeaddresses'");
    expect(rpcContents).toContain("'getaddrmaninfo'");
    expect(serverContents).toContain('fetchPeersFromNode(sendRpcRequest)');
    expect(serverContents).toContain('fetchPeersFromNode(sendTestnetRpcRequest)');
  });
});
