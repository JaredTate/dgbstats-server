/**
 * WEIRD-INPUT-11: /api/testnet/getblockhash/abc and /api/testnet/getblock/zz
 * returned 200 "null" and still called the node. Bad input now gets a 400
 * without an RPC call; a valid request with no result gets a 404.
 */
const express = require('express');
const request = require('supertest');
const axios = require('axios');

vi.mock('axios');

const HASH = 'a'.repeat(64);

describe('testnet block lookups validate their input', () => {
  let app;
  let rpcModule;

  beforeEach(() => {
    vi.clearAllMocks();
    delete require.cache[require.resolve('../../rpc.js')];
    process.env.DGB_TESTNET_RPC_USER = 'test-user';
    process.env.DGB_TESTNET_RPC_PASSWORD = 'test-pass';
    process.env.DGB_TESTNET_RPC_URL = 'http://127.0.0.1:14026';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    rpcModule = require('../../rpc.js');
    rpcModule.rpcCache.flushAll();
    app = express();
    app.use('/api', rpcModule.router);
  });

  afterEach(() => {
    delete process.env.DGB_TESTNET_RPC_USER;
    delete process.env.DGB_TESTNET_RPC_PASSWORD;
    delete process.env.DGB_TESTNET_RPC_URL;
    vi.restoreAllMocks();
  });

  test.each(['abc', '-1', '1.5', '99999999999999999999', '12abc', '0x10', ' 1'])(
    'getblockhash/%s is a 400 and never reaches the node', async (height) => {
      vi.spyOn(axios, 'post').mockResolvedValue({ data: { result: HASH } });
      const res = await request(app).get(`/api/testnet/getblockhash/${encodeURIComponent(height)}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/height/i);
      expect(axios.post).not.toHaveBeenCalled();
    });

  test.each(['zz', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${'a'.repeat(63)}!`])(
    'getblock/%s is a 400 and never reaches the node', async (hash) => {
      vi.spyOn(axios, 'post').mockResolvedValue({ data: { result: { hash } } });
      const res = await request(app).get(`/api/testnet/getblock/${encodeURIComponent(hash)}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/hash/i);
      expect(axios.post).not.toHaveBeenCalled();
    });

  test('a valid height still returns the hash', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { result: HASH } });
    const res = await request(app).get('/api/testnet/getblockhash/0').expect(200);
    expect(res.body).toBe(HASH);
    expect(axios.post.mock.calls[0][1]).toMatchObject({ method: 'getblockhash', params: [0] });
  });

  test('a valid hash (any case) still returns the block', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { result: { hash: HASH, height: 5 } } });
    const res = await request(app).get(`/api/testnet/getblock/${HASH.toUpperCase()}`).expect(200);
    expect(res.body.height).toBe(5);
  });

  test('a valid height the node does not know is a 404, not 200 null', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { result: null, error: { code: -8, message: 'Block height out of range' } } });
    const res = await request(app).get('/api/testnet/getblockhash/999999999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
