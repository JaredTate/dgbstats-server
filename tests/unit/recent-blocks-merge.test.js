// TDD: fetchLatestBlocks must MERGE freshly fetched blocks with blocks already
// in the cache (e.g. delivered by ZMQ/blocknotify between refreshes) instead of
// clobbering the array — otherwise a slightly-stale range fetch regresses the
// tip and "loses" blocks the clients already saw.
import { describe, it, expect } from 'vitest';
import { mergeRecentBlocks } from '../../rpc.js';

const mk = (height, hash = `hash-${height}`) => ({ height, hash });

describe('mergeRecentBlocks', () => {
  it('returns fetched blocks sorted newest-first when cache is empty', () => {
    const merged = mergeRecentBlocks([], [mk(10), mk(12), mk(11)], 240);
    expect(merged.map(b => b.height)).toEqual([12, 11, 10]);
  });

  it('preserves newer blocks already in the cache that the fetch missed', () => {
    const existing = [mk(105), mk(104)];        // arrived via ZMQ after the fetch started
    const fetched = [mk(103), mk(102), mk(101)]; // stale range result
    const merged = mergeRecentBlocks(existing, fetched, 240);
    expect(merged.map(b => b.height)).toEqual([105, 104, 103, 102, 101]);
  });

  it('dedupes by hash, preferring the freshly fetched copy', () => {
    const existing = [{ height: 100, hash: 'same', poolIdentifier: 'stale' }];
    const fetched = [{ height: 100, hash: 'same', poolIdentifier: 'fresh' }, mk(99)];
    const merged = mergeRecentBlocks(existing, fetched, 240);
    expect(merged).toHaveLength(2);
    expect(merged[0].poolIdentifier).toBe('fresh');
  });

  it('caps the result at max blocks, keeping the newest', () => {
    const existing = [mk(300)];
    const fetched = Array.from({ length: 250 }, (_, i) => mk(299 - i));
    const merged = mergeRecentBlocks(existing, fetched, 240);
    expect(merged).toHaveLength(240);
    expect(merged[0].height).toBe(300);
    expect(merged[239].height).toBe(300 - 239);
  });

  it('filters null entries and blocks without hashes', () => {
    const merged = mergeRecentBlocks([null, { height: 5 }], [mk(4), undefined], 240);
    expect(merged.map(b => b.height)).toEqual([4]);
  });
});
