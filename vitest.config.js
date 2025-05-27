import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',
    
    // Test files
    include: ['tests/**/*.test.js'],
    exclude: ['node_modules/**', 'dist/**'],
    
    // Global setup
    setupFiles: ['tests/helpers/test-setup.js'],
    
    // Timeouts
    testTimeout: 60000,
    hookTimeout: 60000,
    
    // Reporter
    reporter: ['verbose'],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './tests/coverage',
      include: ['rpc.js', 'server.js'],
      exclude: ['node_modules/**', 'tests/**'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90
      }
    },
    
    // Globals
    globals: true,
    
    // Pool options for better performance
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
});