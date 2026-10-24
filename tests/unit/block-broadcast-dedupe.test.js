// TDD: a block reaches the server via BOTH ZMQ rawblock and the blocknotify
// POST. createSeenBlockFilter() lets only the first sighting of a hash through,
// so each block is broadcast once.
import { describe, it, expect } from 'vitest';
import { createSeenBlockFilter } from '../../rpc.js';

describe('createSeenBlockFilter', () => {
  it('passes a hash the first time and rejects repeats', () => {
    const isNew = createSeenBlockFilter();
    expect(isNew('aaa')).toBe(true);
    expect(isNew('aaa')).toBe(false);
    expect(isNew('aaa')).toBe(false);
  });

  it('passes a different hash at the same height (reorg)', () => {
    const isNew = createSeenBlockFilter();
    expect(isNew('height100-a')).toBe(true);
    expect(isNew('height100-b')).toBe(true);
  });

  it('keeps separate state per filter (mainnet vs testnet)', () => {
    const mainnet = createSeenBlockFilter();
    const testnet = createSeenBlockFilter();
    expect(mainnet('same')).toBe(true);
    expect(testnet('same')).toBe(true);
  });

  it('remembers only the most recent `max` hashes', () => {
    const isNew = createSeenBlockFilter(2);
    isNew('h1');
    isNew('h2');
    isNew('h3'); // evicts h1
    expect(isNew('h3')).toBe(false);
    expect(isNew('h2')).toBe(false);
    expect(isNew('h1')).toBe(true);
  });
});
