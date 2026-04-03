const fs = require('fs');
const path = require('path');

describe('DigiDollar RC27 Oracle/Testnet Configuration', () => {
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

  test('does not contain deprecated testnet19/port 12033 references', () => {
    const filesToCheck = [
      'server.js',
      'rpc.js',
      'config.js',
      'config.template.js'
    ];

    const deprecatedMarkers = ['testnet19', '12033'];

    filesToCheck.forEach((file) => {
      const contents = readProjectFile(file);
      deprecatedMarkers.forEach((marker) => {
        expect(contents).not.toContain(marker);
      });
    });
  });

  test('oracle broadcast path remains RPC-relay based (no hardcoded threshold constants)', () => {
    const serverContents = readProjectFile('server.js');

    // Ensure server still relies on RPC methods that return oracle state
    expect(serverContents).toContain("sendTestnetRpcRequest('getoracleprice'");
    expect(serverContents).toContain("sendTestnetRpcRequest('getalloracleprices'");
    expect(serverContents).toContain("sendTestnetRpcRequest('getoracles'");
  });
});
