/**
 * Simplified Database Integration Tests
 * 
 * Core database functionality tests with Promise-based approach
 */

const sqlite3 = require('sqlite3').verbose();
const { createTestDatabase } = require('../helpers/test-utils');
const { mockGeoData } = require('../fixtures/test-data');

describe('Database Integration Tests (Simplified)', () => {
  let db;
  
  // Helper function to promisify database operations
  const dbGet = (query, params = []) => {
    return new Promise((resolve, reject) => {
      db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  };

  const dbRun = (query, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  };

  const dbAll = (query, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  };
  
  beforeEach(() => {
    db = createTestDatabase();
  });
  
  afterEach(() => {
    return new Promise((resolve) => {
      db.close(resolve);
    });
  });

  describe('Schema Creation', () => {
    test('should create nodes table with correct schema', async () => {
      const row = await dbGet("SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'");
      expect(row).toBeDefined();
      expect(row.sql).toContain('ip TEXT PRIMARY KEY');
      expect(row.sql).toContain('country TEXT');
      expect(row.sql).toContain('city TEXT');
      expect(row.sql).toContain('lat REAL');
      expect(row.sql).toContain('lon REAL');
    });

    test('should create visits table with correct schema', async () => {
      const row = await dbGet("SELECT sql FROM sqlite_master WHERE type='table' AND name='visits'");
      expect(row).toBeDefined();
      expect(row.sql).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT');
      expect(row.sql).toContain('ip TEXT');
      expect(row.sql).toContain('timestamp DATETIME DEFAULT CURRENT_TIMESTAMP');
    });

    test('should create unique_ips table with correct schema', async () => {
      const row = await dbGet("SELECT sql FROM sqlite_master WHERE type='table' AND name='unique_ips'");
      expect(row).toBeDefined();
      expect(row.sql).toContain('ip TEXT PRIMARY KEY');
    });
  });

  describe('Basic Operations', () => {
    test('should insert and retrieve node data', async () => {
      const testNode = mockGeoData[0];
      
      const result = await dbRun(
        'INSERT INTO nodes (ip, country, city, lat, lon) VALUES (?, ?, ?, ?, ?)',
        [testNode.ip, testNode.country, testNode.city, testNode.lat, testNode.lon]
      );
      
      expect(result.changes).toBe(1);
      
      const row = await dbGet('SELECT * FROM nodes WHERE ip = ?', [testNode.ip]);
      expect(row).toMatchObject(testNode);
    });

    test('should insert visit record', async () => {
      const testIP = '192.168.1.100';
      
      const result = await dbRun(
        'INSERT INTO visits (ip) VALUES (?)',
        [testIP]
      );
      
      expect(result.changes).toBe(1);
      expect(result.lastID).toBeGreaterThan(0);
    });

    test('should insert unique IP', async () => {
      const testIP = '192.168.1.101';
      
      const result = await dbRun(
        'INSERT INTO unique_ips (ip) VALUES (?)',
        [testIP]
      );
      
      expect(result.changes).toBe(1);
    });

    test('should count records correctly', async () => {
      // Insert some test data
      await dbRun('INSERT INTO visits (ip) VALUES (?)', ['192.168.1.1']);
      await dbRun('INSERT INTO visits (ip) VALUES (?)', ['192.168.1.2']);
      await dbRun('INSERT INTO visits (ip) VALUES (?)', ['192.168.1.1']);
      
      const row = await dbGet('SELECT COUNT(*) as count FROM visits');
      expect(row.count).toBe(3);
    });
  });
});