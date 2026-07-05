// TDD: rolling-24h aggregation for the crawler — turns crawled_nodes rows into
// the nodeVersions24h payload the frontend renders (totals, sorted user-agent
// breakdown with percentages, upgrade progress vs a target core series).
import { describe, it, expect } from 'vitest';
import { aggregateVersions } from '../../crawler.js';

const NOW = 1751700000000;
const HOUR = 3600 * 1000;

const row = (userAgent, lastSeenAgoHours, ip = `10.0.0.${Math.floor(Math.random() * 250)}`) => ({
  ip,
  port: 12024,
  user_agent: userAgent,
  last_seen: NOW - lastSeenAgoHours * HOUR,
});

describe('aggregateVersions', () => {
  it('counts only rows seen within the window', () => {
    const rows = [
      row('/DigiByte:9.26.4/', 1, '1.1.1.1'),
      row('/DigiByte:9.26.4/', 23, '2.2.2.2'),
      row('/DigiByte:9.26.4/', 25, '3.3.3.3'), // outside 24h
    ];
    const out = aggregateVersions(rows, { now: NOW, windowHours: 24, targetSeries: '8.26' });
    expect(out.totalUniqueNodes).toBe(2);
    expect(out.versions).toHaveLength(1);
    expect(out.versions[0]).toMatchObject({ userAgent: '/DigiByte:9.26.4/', count: 2 });
    expect(out.windowHours).toBe(24);
    expect(out.updatedAt).toBe(NOW);
  });

  it('sorts versions by count desc and computes 1-decimal percentages', () => {
    const rows = [
      ...Array.from({ length: 327 }, (_, i) => row('/DigiByte:8.26.2/', 1, `8.26.2.${i}`)),
      ...Array.from({ length: 119 }, (_, i) => row('/DigiByte:9.26.4/', 2, `9.26.4.${i}`)),
      ...Array.from({ length: 2 }, (_, i) => row('/digj:0.16.2/DigiByte Wallet:9.26/', 3, `digj.${i}`)),
    ];
    const out = aggregateVersions(rows, { now: NOW, windowHours: 24, targetSeries: '8.26' });
    expect(out.totalUniqueNodes).toBe(448);
    expect(out.versions[0].userAgent).toBe('/DigiByte:8.26.2/');
    expect(out.versions[1].userAgent).toBe('/DigiByte:9.26.4/');
    expect(out.versions[0].percent).toBe(73.0);
    expect(out.versions[1].percent).toBe(26.6);
    // digj wallet is listed but never counted as upgraded
    expect(out.versions[2].count).toBe(2);
    expect(out.upgradedCount).toBe(446);
  });

  it('marks the highest parsed core version as latest', () => {
    const rows = [
      row('/DigiByte:8.26.2/', 1, 'a'),
      row('/DigiByte:9.26.4/', 1, 'b'),
      row('/DigiByte:9.26.3/', 1, 'c'),
    ];
    const out = aggregateVersions(rows, { now: NOW, windowHours: 24, targetSeries: '8.26' });
    expect(out.latestVersion).toBe('9.26.4');
    const latestRows = out.versions.filter(v => v.isLatest);
    expect(latestRows).toHaveLength(1);
    expect(latestRows[0].userAgent).toBe('/DigiByte:9.26.4/');
  });

  it('computes upgrade progress against the target series', () => {
    const rows = [
      row('/DigiByte:9.26.4/', 1, 'a'),   // >= 8.26
      row('/DigiByte:8.26.1/', 1, 'b'),   // >= 8.26
      row('/DigiByte:8.22.2/', 1, 'c'),   // below
      row('/digj:0.16.2/DigiByte Wallet:9.26/', 1, 'd'), // unparseable
    ];
    const out = aggregateVersions(rows, { now: NOW, windowHours: 24, targetSeries: '8.26' });
    expect(out.targetSeries).toBe('8.26');
    expect(out.upgradedCount).toBe(2);
    expect(out.upgradedPercent).toBe(50.0);
  });

  it('dedupes by ip:port keeping the freshest sighting', () => {
    const rows = [
      { ip: '1.1.1.1', port: 12024, user_agent: '/DigiByte:8.26.2/', last_seen: NOW - 20 * HOUR },
      { ip: '1.1.1.1', port: 12024, user_agent: '/DigiByte:9.26.4/', last_seen: NOW - 1 * HOUR },
    ];
    const out = aggregateVersions(rows, { now: NOW, windowHours: 24, targetSeries: '8.26' });
    expect(out.totalUniqueNodes).toBe(1);
    expect(out.versions[0].userAgent).toBe('/DigiByte:9.26.4/');
  });

  it('handles empty input', () => {
    const out = aggregateVersions([], { now: NOW, windowHours: 24, targetSeries: '8.26' });
    expect(out.totalUniqueNodes).toBe(0);
    expect(out.versions).toEqual([]);
    expect(out.upgradedPercent).toBe(0);
    expect(out.latestVersion).toBeNull();
  });
});
