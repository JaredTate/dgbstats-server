/**
 * Vitest Test Setup
 * 
 * Global test configuration and setup for all test files
 */

import { vi } from 'vitest';

// Mock console methods for cleaner test output
const originalError = console.error;
const originalLog = console.log;
const originalWarn = console.warn;

beforeAll(() => {
  // Suppress console output during tests unless explicitly testing logging
  console.error = vi.fn();
  console.log = vi.fn();
  console.warn = vi.fn();
});

afterAll(() => {
  // Restore console methods
  console.error = originalError;
  console.log = originalLog;
  console.warn = originalWarn;
});

// Global test utilities
global.testUtils = {
  // Utility to restore console for specific tests
  restoreConsole: () => {
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
  },
  
  // Utility to mock console for specific tests
  mockConsole: () => {
    console.error = vi.fn();
    console.log = vi.fn();
    console.warn = vi.fn();
  },
  
  // Wait for async operations
  wait: (ms = 100) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // Generate random test data
  randomString: (length = 10) => Math.random().toString(36).substr(2, length),
  randomPort: () => Math.floor(Math.random() * 10000) + 20000,
  randomIP: () => `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
};

// Clean up environment variables for tests
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Use random port for tests