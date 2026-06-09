const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
      'parse_testnet_peers.py',
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
    expect(rpcContents).toContain("sendTestnetRpcRequest('getoraclesigners'");
    expect(rpcContents).toContain("sendTestnetRpcRequest('getprotectionstatus'");
  });

  test('testnet defaults match current testnet26 ports and peer path', () => {
    const serverContents = readProjectFile('server.js');
    const rpcContents = readProjectFile('rpc.js');
    const templateContents = readProjectFile('config.template.js');
    const testnetPeerParserContents = readProjectFile('parse_testnet_peers.py');
    const docsContents = [
      readProjectFile('README.md'),
      readProjectFile('ARCHITECTURE.md')
    ].join('\n');

    expect(serverContents).toContain("http://127.0.0.1:14026");
    expect(rpcContents).toContain("http://127.0.0.1:14026");
    expect(templateContents).toContain("testnet26/peers.dat");
    expect(testnetPeerParserContents).toContain("testnetPeersDataPath");
    expect(testnetPeerParserContents).toContain("'testnet26', 'peers.dat'");
    expect(docsContents).toContain("14026");
    expect(docsContents).not.toContain("14022");
  });

  test('peer parsers return empty results for empty peers.dat files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgbstats-peers-'));
    const emptyPeersPath = path.join(tempDir, 'peers.dat');
    fs.writeFileSync(emptyPeersPath, Buffer.alloc(0));

    try {
      const mainnetOutput = execFileSync('python3', ['parse_peers_dat.py'], {
        cwd: projectRoot,
        env: { ...process.env, PEERS_DAT_PATH: emptyPeersPath },
        encoding: 'utf8'
      });
      const testnetOutput = execFileSync('python3', ['parse_testnet_peers.py'], {
        cwd: projectRoot,
        env: { ...process.env, TESTNET_PEERS_DAT_PATH: emptyPeersPath },
        encoding: 'utf8'
      });

      expect(JSON.parse(mainnetOutput).totalUniquePeers).toBe(0);
      expect(JSON.parse(testnetOutput).totalUniquePeers).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
