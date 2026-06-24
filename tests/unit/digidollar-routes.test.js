const express = require('express');
const request = require('supertest');
const axios = require('axios');

vi.mock('axios');

describe('DigiDollar production RPC routes', () => {
  let app;
  let rpcModule;

  beforeEach(() => {
    vi.clearAllMocks();
    delete require.cache[require.resolve('../../rpc.js')];

    process.env.DGB_RPC_USER = 'main-user';
    process.env.DGB_RPC_PASSWORD = 'main-pass';
    process.env.DGB_RPC_URL = 'http://127.0.0.1:14044';
    process.env.DGB_TESTNET_RPC_USER = 'test-user';
    process.env.DGB_TESTNET_RPC_PASSWORD = 'test-pass';
    process.env.DGB_TESTNET_RPC_URL = 'http://127.0.0.1:14026';
    process.env.DGB_MAINNET_PRE_RPC_USER = 'pre-user';
    process.env.DGB_MAINNET_PRE_RPC_PASSWORD = 'pre-pass';
    process.env.DGB_MAINNET_PRE_RPC_URL = 'http://127.0.0.1:14046';

    axios.post.mockImplementation((url, body) => Promise.resolve({
      data: {
        result: {
          url,
          method: body.method,
          params: body.params
        }
      }
    }));

    rpcModule = require('../../rpc.js');
    rpcModule.rpcCache.flushAll();

    app = express();
    app.use('/api', rpcModule.router);
  });

  afterEach(() => {
    delete process.env.DGB_RPC_USER;
    delete process.env.DGB_RPC_PASSWORD;
    delete process.env.DGB_RPC_URL;
    delete process.env.DGB_TESTNET_RPC_USER;
    delete process.env.DGB_TESTNET_RPC_PASSWORD;
    delete process.env.DGB_TESTNET_RPC_URL;
    delete process.env.DGB_MAINNET_PRE_RPC_USER;
    delete process.env.DGB_MAINNET_PRE_RPC_PASSWORD;
    delete process.env.DGB_MAINNET_PRE_RPC_URL;
  });

  test('routes DigiDollar stats to mainnet, testnet, and PRE RPC targets', async () => {
    await request(app).get('/api/getdigidollarstats').expect(200);
    await request(app).get('/api/testnet/getdigidollarstats').expect(200);
    await request(app).get('/api/mainnet-pre/getdigidollarstats').expect(200);

    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:14044',
      expect.objectContaining({ id: 'dgb_rpc', method: 'getdigidollarstats' }),
      expect.objectContaining({ auth: { username: 'main-user', password: 'main-pass' } })
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:14026',
      expect.objectContaining({ id: 'dgb_testnet_rpc', method: 'getdigidollarstats' }),
      expect.objectContaining({ auth: { username: 'test-user', password: 'test-pass' } })
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:14046',
      expect.objectContaining({ id: 'dgb_mainnet_pre_rpc', method: 'getdigidollarstats' }),
      expect.objectContaining({ auth: { username: 'pre-user', password: 'pre-pass' } })
    );

    expect(rpcModule.rpcCache.keys()).toEqual(expect.arrayContaining([
      expect.stringMatching(/^rpc:getdigidollarstats:/),
      expect.stringMatching(/^testnet:rpc:getdigidollarstats:/),
      expect.stringMatching(/^mainnet-pre:rpc:getdigidollarstats:/)
    ]));
  });

  test('clamps oracle signer block counts before forwarding to RPC', async () => {
    await request(app).get('/api/mainnet-pre/getoraclesigners?blocks=0').expect(200);
    await request(app).get('/api/mainnet-pre/getoraclesigners?blocks=abc').expect(200);
    await request(app).get('/api/mainnet-pre/getoraclesigners?blocks=2500').expect(200);

    expect(axios.post.mock.calls.map(call => call[1].params)).toEqual([
      [1],
      [100],
      [1000]
    ]);
  });
});
