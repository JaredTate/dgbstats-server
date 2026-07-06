// TDD: fork tracker pure logic — turns getchaintips into a classified snapshot,
// detects reorgs/orphans between polls, and grades fork risk. DigiByte's 15s
// blocks across 5 algos produce frequent single-block stale tips (branchlen 1),
// which are NORMAL; risk rises only when a competing branch is deep, growing
// across polls, invalid, or a real reorg replaces the active tip.
import { describe, it, expect } from 'vitest';
import {
  classifyTips,
  computeForkRisk,
  diffReorg,
  tipsByHash,
} from '../../forktracker.js';

const active = (height, hash) => ({ height, hash, branchlen: 0, status: 'active' });
const fork = (height, hash, branchlen, status = 'valid-fork') => ({ height, hash, branchlen, status });

describe('classifyTips', () => {
  it('separates the active tip and counts recent competing tips by status', () => {
    const raw = [
      active(1000, 'A'),
      fork(999, 'f1', 1, 'valid-fork'),
      fork(998, 'f2', 2, 'valid-headers'),
      fork(1000, 'f3', 3, 'invalid'),
      fork(997, 'h1', 1, 'headers-only'),
    ];
    const out = classifyTips(raw, { windowBlocks: 100, maxTips: 50 });
    expect(out.active).toEqual({ height: 1000, hash: 'A' });
    expect(out.counts).toEqual({ validFork: 1, validHeaders: 1, headersOnly: 1, invalid: 1 });
    expect(out.maxBranchLen).toBe(3);
    expect(out.totalTips).toBe(4);
    // forkHeight is derived height - branchlen
    const f2 = out.tips.find((t) => t.hash === 'f2');
    expect(f2.forkHeight).toBe(996);
  });

  it('drops ancient side chains outside the recent window', () => {
    const raw = [
      active(23801927, 'A'),
      fork(23801926, 'recent', 1),      // 1 back — kept
      fork(23800000, 'ancient', 1),     // ~1900 back — dropped
    ];
    const out = classifyTips(raw, { windowBlocks: 100, maxTips: 50 });
    expect(out.tips.map((t) => t.hash)).toEqual(['recent']);
    expect(out.counts.validFork).toBe(1);
  });

  it('sorts tips by height desc and caps to maxTips', () => {
    const raw = [active(500, 'A')];
    for (let i = 1; i <= 60; i++) raw.push(fork(500 - i, `f${i}`, 1));
    const out = classifyTips(raw, { windowBlocks: 1000, maxTips: 40 });
    expect(out.tips).toHaveLength(40);
    expect(out.tips[0].height).toBeGreaterThan(out.tips[39].height);
  });

  it('handles an empty / missing active tip without throwing', () => {
    expect(classifyTips([], {}).active).toBeNull();
    expect(classifyTips(null, {}).tips).toEqual([]);
  });
});

describe('computeForkRisk', () => {
  const activeHeight = 1000;

  it('is none for only single-block stale tips (normal churn)', () => {
    const tips = [fork(999, 'f1', 1), fork(998, 'f2', 1)];
    const r = computeForkRisk({ tips, prevByHash: {}, activeHeight });
    expect(r.level).toBe('none');
  });

  it('is elevated when a competing branch reaches length 2', () => {
    const tips = [fork(1000, 'f1', 2)];
    const r = computeForkRisk({ tips, prevByHash: {}, activeHeight });
    expect(r.level).toBe('elevated');
    expect(r.branchlen).toBe(2);
    expect(r.reason).toMatch(/branch/i);
  });

  it('is elevated when a tip grew across polls (actively mined fork)', () => {
    const tips = [fork(1001, 'f1', 1)];
    const prevByHash = { f1: { ...fork(1000, 'f1', 1), branchlen: 1 } };
    // same hash reported deeper would be growth; simulate growth via branchlen bump
    const grew = computeForkRisk({ tips: [fork(1001, 'f1', 2)], prevByHash: { f1: { branchlen: 1 } }, activeHeight });
    expect(grew.level).toBe('elevated');
    expect(grew.reason).toMatch(/grow/i);
  });

  it('is critical for a deep (>=4) competing branch', () => {
    const tips = [fork(1003, 'f1', 4)];
    const r = computeForkRisk({ tips, prevByHash: {}, activeHeight });
    expect(r.level).toBe('critical');
  });

  it('is critical for an invalid branch of length >= 2', () => {
    const tips = [fork(1001, 'bad', 2, 'invalid')];
    const r = computeForkRisk({ tips, prevByHash: {}, activeHeight });
    expect(r.level).toBe('critical');
    expect(r.reason).toMatch(/invalid/i);
  });

  it('is critical when a reorg of depth >= 3 was detected', () => {
    const r = computeForkRisk({ tips: [], prevByHash: {}, activeHeight, reorgDepth: 3 });
    expect(r.level).toBe('critical');
    expect(r.reason).toMatch(/reorg/i);
  });

  it('is elevated on a shallow (depth 2) reorg', () => {
    const r = computeForkRisk({ tips: [], prevByHash: {}, activeHeight, reorgDepth: 2 });
    expect(r.level).toBe('elevated');
  });

  it('is elevated when many tips crowd the current height', () => {
    const tips = [fork(1000, 'a', 1), fork(1000, 'b', 1), fork(999, 'c', 1)];
    const r = computeForkRisk({ tips, prevByHash: {}, activeHeight, crowdThreshold: 3 });
    expect(r.level).toBe('elevated');
  });
});

describe('diffReorg', () => {
  it('reports no reorg when the active tip simply advances by one', () => {
    const prev = { active: { height: 1000, hash: 'A' }, tips: [] };
    const next = { active: { height: 1001, hash: 'B' }, tips: [] };
    const d = diffReorg(prev, next);
    expect(d.reorg).toBe(false);
    expect(d.depth).toBe(0);
  });

  it('detects a reorg when the old active tip becomes a side branch', () => {
    const prev = { active: { height: 1000, hash: 'A' }, tips: [] };
    const next = { active: { height: 1000, hash: 'B' }, tips: [fork(1000, 'A', 1)] };
    const d = diffReorg(prev, next);
    expect(d.reorg).toBe(true);
    expect(d.depth).toBeGreaterThanOrEqual(1);
    expect(d.orphanedHashes).toContain('A');
  });

  it('detects a deeper reorg when the new active height regressed', () => {
    const prev = { active: { height: 1005, hash: 'A' }, tips: [] };
    const next = { active: { height: 1004, hash: 'B' }, tips: [fork(1005, 'A', 3)] };
    const d = diffReorg(prev, next);
    expect(d.reorg).toBe(true);
    expect(d.depth).toBeGreaterThanOrEqual(2);
  });

  it('handles a missing previous snapshot', () => {
    const d = diffReorg(null, { active: { height: 1, hash: 'A' }, tips: [] });
    expect(d.reorg).toBe(false);
  });
});

describe('tipsByHash', () => {
  it('indexes tips by hash', () => {
    const idx = tipsByHash([fork(1, 'a', 1), fork(2, 'b', 2)]);
    expect(idx.a.height).toBe(1);
    expect(idx.b.branchlen).toBe(2);
  });
});
