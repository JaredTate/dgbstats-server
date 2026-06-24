const fs = require('fs');
const path = require('path');

/**
 * Guardrail tests for the MAINNET DigiDollar / Oracle / Deployment wiring.
 *
 * The testnet side (port 5003) has long had oracle, DD-stats and deployment
 * data fetched over RPC, cached, and pushed to WebSocket clients. These tests
 * assert the *mainnet* side (port 5002, mainnet RPC) is wired symmetrically so
 * the mainnet Activation / Oracles / DD Stats pages receive live data.
 *
 * They are deliberately static-analysis style (matching
 * digidollar-oracle-config.test.js) so they run without a live node.
 */
describe('Mainnet DigiDollar/Oracle wiring', () => {
  const projectRoot = path.resolve(__dirname, '..', '..');

  function readProjectFile(relPath) {
    return fs.readFileSync(path.join(projectRoot, relPath), 'utf8');
  }

  let serverContents;
  beforeAll(() => {
    serverContents = readProjectFile('server.js');
  });

  test('declares in-memory mainnet caches for oracle, DD stats and deployment', () => {
    expect(serverContents).toContain('mainnetOracleCache');
    expect(serverContents).toContain('mainnetDDStatsCache');
    expect(serverContents).toContain('mainnetDeploymentCache');
  });

  test('fetches mainnet oracle/DD/deployment data via the MAINNET RPC client', () => {
    // Mainnet uses sendRpcRequest (not sendTestnetRpcRequest)
    expect(serverContents).toContain("sendRpcRequest('getoracleprice'");
    expect(serverContents).toContain("sendRpcRequest('getalloracleprices'");
    expect(serverContents).toContain("sendRpcRequest('getoracles'");
    expect(serverContents).toContain("sendRpcRequest('getoraclesigners'");
    expect(serverContents).toContain("sendRpcRequest('getdigidollarstats'");
    expect(serverContents).toContain("sendRpcRequest('getdigidollardeploymentinfo'");
  });

  test('defines modified-mainnet/PRE RPC and WebSocket wiring', () => {
    const rpcContents = readProjectFile('rpc.js');

    expect(rpcContents).toContain('MAINNET_PRE_RPC_CONFIG');
    expect(rpcContents).toContain("http://127.0.0.1:14046");
    expect(rpcContents).toContain('sendMainnetPreRpcRequest');

    expect(serverContents).toContain('mainnetPreWsPort');
    expect(serverContents).toContain('wssMainnetPre');
    expect(serverContents).toContain('mainnetPreOracleCache');
    expect(serverContents).toContain('mainnetPreDDStatsCache');
    expect(serverContents).toContain('mainnetPreDeploymentCache');
    expect(serverContents).toContain('refreshAndBroadcastMainnetPreOracleData');
  });

  test('registers DigiDollar RPC endpoints for mainnet, testnet and mainnet-pre', () => {
    const rpcContents = readProjectFile('rpc.js');
    const endpoints = [
      'getdigidollardeploymentinfo',
      'getdigidollarstats',
      'getoracleprice',
      'getoracles',
      'getalloracleprices',
      'getoraclesigners',
      'listoracle',
      'getprotectionstatus'
    ];

    for (const endpoint of endpoints) {
      expect(rpcContents).toContain(`'/${endpoint}'`);
    }
    expect(rpcContents).toContain("registerDigiDollarRoutes('', sendRpcRequest, 'mainnet')");
    expect(rpcContents).toContain("registerDigiDollarRoutes('/testnet', sendTestnetRpcRequest, 'testnet')");
    expect(rpcContents).toContain("registerDigiDollarRoutes('/mainnet-pre', sendMainnetPreRpcRequest, 'mainnet-pre')");
  });

  test('defines mainnet fetch + broadcast functions', () => {
    expect(serverContents).toContain('function fetchMainnetOracleData');
    expect(serverContents).toContain('function fetchMainnetDDStatsData');
    expect(serverContents).toContain('function fetchMainnetDeploymentData');
    expect(serverContents).toContain('function broadcastMainnetOracleData');
    expect(serverContents).toContain('function broadcastMainnetDDStats');
    expect(serverContents).toContain('function broadcastMainnetDeploymentData');
    expect(serverContents).toContain('function refreshAndBroadcastMainnetOracleData');
  });

  test('broadcasts the DD message types to mainnet (wss) clients', () => {
    // The broadcast helpers must target the mainnet wss, not wssTestnet.
    const broadcastBlock = serverContents.slice(
      serverContents.indexOf('function broadcastMainnetOracleData'),
      serverContents.indexOf('function refreshAndBroadcastMainnetOracleData')
    );
    expect(broadcastBlock).toContain('wss.clients');
    expect(broadcastBlock).not.toContain('wssTestnet.clients');
    expect(broadcastBlock).toContain("type: 'oracleData'");
    expect(broadcastBlock).toContain("type: 'ddStatsData'");
    expect(broadcastBlock).toContain("type: 'ddDeploymentData'");
  });

  test('pushes cached DD data to new mainnet WebSocket clients on connect', () => {
    // The mainnet connection handler block (wss.on('connection') ... before the
    // testnet handler) must send the three DD message types from cache.
    const mainnetHandler = serverContents.slice(
      serverContents.indexOf("wss.on('connection'"),
      serverContents.indexOf("wssTestnet.on('connection'")
    );
    expect(mainnetHandler).toContain('mainnetOracleCache');
    expect(mainnetHandler).toContain('mainnetDDStatsCache');
    expect(mainnetHandler).toContain('mainnetDeploymentCache');
    expect(mainnetHandler).toContain("type: 'oracleData'");
    expect(mainnetHandler).toContain("type: 'ddStatsData'");
    expect(mainnetHandler).toContain("type: 'ddDeploymentData'");
  });

  test('starts periodic mainnet and mainnet-pre oracle/DD refresh intervals', () => {
    expect(serverContents).toContain('refreshAndBroadcastMainnetOracleData()');
    expect(serverContents).toContain('refreshAndBroadcastMainnetPreOracleData()');
  });
});
