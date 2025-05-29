# DigiByte Stats Server - Testing Guide

This README provides comprehensive instructions for running and understanding the test suite for the DigiByte Stats Server.

## Table of Contents

- [Quick Start](#quick-start)
- [Test Suite Overview](#test-suite-overview)
- [Running Tests](#running-tests)
- [Test Categories](#test-categories)
- [Coverage Reports](#coverage-reports)
- [Test Development](#test-development)
- [CI/CD Integration](#cicd-integration)
- [Troubleshooting](#troubleshooting)

## Quick Start

### Prerequisites

- Node.js 16+ installed
- npm or yarn package manager
- SQLite3 support (usually included with Node.js)

### Installation

```bash
# Install all dependencies including test dependencies
npm install

# Verify Vitest installation
npx vitest --version
```

### Run All Tests

```bash
# Run complete test suite
npm test

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## Test Suite Overview

### Test Statistics

- **Test Framework**: Vitest 1.6.1
- **Total Test Files**: 6 test files
- **Total Test Cases**: 97 individual tests
- **Coverage Target**: >90% for all metrics
- **Execution Time**: ~5-6 seconds for full suite
- **Pass Rate**: 100% (97/97 tests passing)

### Test Architecture

```
tests/
├── unit/                    # 25 unit tests
│   ├── rpc.test.js         # RPC module functionality (19 tests)
│   └── server-core.test.js # Core server functions (6 tests)
├── integration/             # 72 integration tests
│   ├── api.test.js         # HTTP API endpoints (32 tests)
│   ├── websocket.test.js   # WebSocket functionality (19 tests)
│   ├── database.test.js    # Database operations (10 tests)
│   └── end-to-end.test.js  # Complete workflows (11 tests)
├── fixtures/                # Mock data and test fixtures
├── helpers/                 # Test utilities and setup
└── coverage/               # Generated coverage reports
    ├── index.html          # Main coverage dashboard
    ├── rpc.js.html         # RPC file coverage details
    └── server.js.html      # Server file coverage details
```

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Generate coverage report
npm run test:coverage

# Run tests with debugging
npm run test:debug
```

### Specific Test Categories

```bash
# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run specific test file
npx vitest run tests/unit/rpc.test.js

# Run tests matching a pattern
npx vitest run --reporter=verbose --grep="should handle RPC"
```

### Advanced Options

```bash
# Run tests with specific timeout
npx vitest run --testTimeout=10000

# Run tests with specific reporter
npx vitest run --reporter=verbose

# Run only changed tests (with git)
npx vitest run --changed

# Run tests with UI interface
npx vitest --ui
```

## Test Categories

### 1. Unit Tests (`/tests/unit/`)

**Purpose**: Test individual functions and modules in isolation

**Files**:
- `rpc.test.js` - Tests RPC functionality, caching, rate limiting (19 tests)
- `server-core.test.js` - Tests core server functions without HTTP dependencies (6 tests)

**Example Command**:
```bash
npm run test:unit
```

**What They Test**:

- RPC request/response handling
- Cache hit/miss scenarios
- Error handling and fallbacks
- Block processing functions
- Database operations
- Configuration management

### 2. Integration Tests (`/tests/integration/`)

**Purpose**: Test component interactions and system integration

**Files**:
- `api.test.js` - HTTP API endpoint testing (32 tests)
- `websocket.test.js` - WebSocket connection and messaging (19 tests)
- `database.test.js` - SQLite database operations (10 tests)
- `end-to-end.test.js` - Complete application workflows (11 tests)

**Example Command**:
```bash
npm run test:integration
```

**What They Test**:

- HTTP API endpoints with real requests
- WebSocket connections and real-time messaging
- Database CRUD operations
- Complete data flow scenarios
- Error handling across components

### 3. Performance Tests

**Included in integration tests**, these verify:

- Concurrent request handling
- WebSocket connection scalability
- Database performance under load
- Memory usage patterns
- Response time requirements

## Coverage Reports

### Viewing Coverage Reports

```bash
# Generate coverage report
npm run test:coverage

# Open HTML coverage report (Mac)
open tests/coverage/index.html

# Open HTML coverage report (Linux)
xdg-open tests/coverage/index.html

# Open HTML coverage report (Windows)
start tests/coverage/index.html
```

### Coverage Report Features

The HTML coverage reports provide:

1. **Main Dashboard** (`index.html`):
   - Overall coverage statistics
   - File-by-file coverage breakdown
   - Interactive navigation

2. **File-Specific Reports** (`rpc.js.html`, `server.js.html`):
   - Line-by-line coverage highlighting
   - Green = covered lines
   - Red = uncovered lines
   - Branch coverage indicators

3. **Coverage Metrics**:
   - **Lines**: Percentage of code lines executed
   - **Functions**: Percentage of functions called
   - **Branches**: Percentage of conditional branches taken
   - **Statements**: Percentage of statements executed

### Current Coverage Status

| File | Statements | Branches | Functions | Lines |
|------|------------|----------|-----------|-------|
| rpc.js | 82.51% | 79.16% | 100% | 82.51% |
| Overall | 32.78% | 78.08% | 94.44% | 32.78% |

### Coverage Goals

| Metric | Target | 
|--------|--------|
| Lines | >85% |
| Functions | >90% |
| Branches | >80% |
| Statements | >85% |

### Improving Coverage

```bash
# Generate coverage with detailed output
npm run test:coverage -- --reporter=verbose

# View coverage for specific file
npx vitest run --coverage --reporter=verbose tests/unit/rpc.test.js
```

## Test Development

### Writing New Tests

#### Basic Test Structure (Vitest)

```javascript
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Feature Name', () => {
  beforeEach(() => {
    // Setup for each test
  });

  afterEach(() => {
    // Cleanup after each test
  });

  test('should do something specific', async () => {
    // Arrange
    const input = 'test data';
    
    // Act
    const result = await functionToTest(input);
    
    // Assert
    expect(result).toEqual(expectedOutput);
  });
});
```

#### Using Vitest Mocking

```javascript
import { vi } from 'vitest';

// Mock a module
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

// Mock a function
const mockFunction = vi.fn();
mockFunction.mockReturnValue('mocked result');

// Spy on existing function
const spy = vi.spyOn(object, 'method');
```

#### Using Test Utilities

```javascript
const { createTestDatabase } = require('./helpers/test-utils');
const { mockBlockchainInfo } = require('./fixtures/mock-rpc-responses');

test('should use test utilities', async () => {
  // Use pre-built test database
  const db = createTestDatabase();
  
  // Test implementation with async/await (no done() callbacks)
  const result = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM test', (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
  
  expect(result).toBeDefined();
  
  // Cleanup
  await new Promise(resolve => db.close(resolve));
});
```

### Test Best Practices

#### 1. Test Isolation

```javascript
// ✅ Good - Each test is isolated
describe('User Management', () => {
  let testDb;
  
  beforeEach(() => {
    testDb = createTestDatabase();
  });
  
  afterEach(async () => {
    await new Promise(resolve => testDb.close(resolve));
  });
});

// ❌ Bad - Tests share state
let sharedDb;
beforeAll(() => {
  sharedDb = createTestDatabase();
});
```

#### 2. Async/Await Pattern (No done() callbacks)

```javascript
// ✅ Good - Use async/await
test('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});

// ❌ Bad - done() callbacks are deprecated in Vitest
test('should handle async operations', (done) => {
  asyncFunction((result) => {
    expect(result).toBeDefined();
    done(); // Deprecated!
  });
});
```

#### 3. Descriptive Test Names

```javascript
// ✅ Good - Describes what and when
test('should return cached blockchain info when cache hit occurs', () => {});

// ❌ Bad - Vague description
test('blockchain test', () => {});
```

#### 4. Comprehensive Assertions

```javascript
// ✅ Good - Tests complete response structure
expect(response.body).toMatchObject({
  height: expect.any(Number),
  hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  difficulty: expect.any(Number)
});

// ❌ Bad - Only tests existence
expect(response.body).toBeDefined();
```

### Adding New Test Files

1. **Create test file** in appropriate directory (`unit/` or `integration/`)
2. **Follow naming convention**: `feature-name.test.js`
3. **Import Vitest utilities**:
   ```javascript
   import { describe, test, expect, vi } from 'vitest';
   const { createTestDatabase } = require('../helpers/test-utils');
   const { mockData } = require('../fixtures/test-data');
   ```
4. **Auto-detected** by Vitest (files matching `*.test.js` pattern)

## CI/CD Integration

### GitHub Actions Setup

Create `.github/workflows/test.yml`:

```yaml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [16, 18, 20]
    
    steps:
    - uses: actions/checkout@v4
    
    - name: Setup Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v4
      with:
        node-version: ${{ matrix.node-version }}
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run tests
      run: npm run test:coverage
    
    - name: Upload coverage to Codecov
      uses: codecov/codecov-action@v3
      with:
        file: ./tests/coverage/lcov.info
```

### Pre-commit Hooks

Setup with Husky:

```bash
# Install husky
npm install --save-dev husky

# Add scripts to package.json
{
  "scripts": {
    "prepare": "husky install"
  }
}

# Create pre-commit hook
npx husky add .husky/pre-commit "npm run test:unit"
npx husky add .husky/pre-push "npm run test:coverage"
```

### Docker Testing

Create `Dockerfile.test`:

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run test:coverage

CMD ["npm", "test"]
```

Run tests in Docker:

```bash
docker build -f Dockerfile.test -t dgb-stats-test .
docker run --rm dgb-stats-test
```

## Troubleshooting

### Common Issues

#### 1. Tests Timeout

```bash
# Increase timeout globally
npx vitest run --testTimeout=30000

# Or set in specific test
test('long running test', async () => {
  // test implementation
}, 30000); // 30 second timeout
```

#### 2. Port Conflicts

```javascript
// Use random ports in tests
const testPort = 5000 + Math.floor(Math.random() * 1000);
```

#### 3. Database Locks

```javascript
// Always close databases in tests
afterEach(async () => {
  if (testDb) {
    await new Promise(resolve => testDb.close(resolve));
  }
});
```

#### 4. Vitest Configuration Issues

Check `vitest.config.js` or `package.json` for configuration:

```javascript
// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov']
    }
  }
});
```

### Debug Mode

```bash
# Run tests in debug mode
npm run test:debug

# Run specific test with debugging
npx vitest run --inspect-brk tests/unit/rpc.test.js
```

### Environment Variables

Set test-specific environment:

```bash
# Linux/Mac
NODE_ENV=test npm test

# Windows
set NODE_ENV=test && npm test
```

Or create `.env.test`:

```bash
NODE_ENV=test
PORT=0
LOG_LEVEL=error
```

### Verbose Output

```bash
# See detailed test output
npx vitest run --reporter=verbose

# See console logs in tests
npx vitest run --reporter=verbose --no-silent
```

## Performance Optimization

### Parallel Execution

```bash
# Use all CPU cores (default in Vitest)
npm test

# Disable parallel execution for debugging
npx vitest run --no-file-parallelism

# Run with specific number of threads
npx vitest run --pool.threads.maxThreads=4
```

### Test Selection

```bash
# Run only changed tests
npx vitest run --changed

# Run tests related to specific files
npx vitest run --related rpc.js server.js

# Run tests matching pattern
npx vitest run --grep "RPC"
```

### Cache Management

```bash
# No manual cache clearing needed in Vitest
# Vitest handles caching automatically
```

## Monitoring and Maintenance

### Regular Tasks

1. **Weekly**: Review test execution times
2. **Monthly**: Update dependencies and check for security issues
3. **Per Release**: Run full test suite with coverage verification
4. **Continuous**: Monitor for flaky tests and fix immediately

### Performance Monitoring

```bash
# Track test execution time
npm test | grep "Duration"

# Use Vitest UI for detailed monitoring
npx vitest --ui
```

### Updating Tests

When updating application code:

1. **Run existing tests** to check for regressions
2. **Add new tests** for new functionality
3. **Update mock data** if external APIs change
4. **Review coverage** to ensure quality standards

## Support and Contributing

### Getting Help

1. **Check this README** for common solutions
2. **Review test output** for specific error messages
3. **Check Vitest documentation** at https://vitest.dev
4. **Open an issue** with detailed reproduction steps

### Contributing Tests

1. **Follow existing patterns** in test structure
2. **Use async/await** instead of done() callbacks
3. **Add comprehensive coverage** for new features
4. **Include both positive and negative test cases**
5. **Update documentation** for new test utilities
6. **Ensure tests pass** in CI environment

### Test Quality Guidelines

- **Maintainable**: Tests should be easy to understand and modify
- **Reliable**: Tests should pass consistently without flakiness
- **Fast**: Unit tests should run quickly, integration tests reasonably fast
- **Isolated**: Tests should not depend on external services or other tests
- **Comprehensive**: Tests should cover edge cases and error conditions

---

For more detailed information about specific test categories, see the individual test files and the comprehensive documentation in `tests/CLAUDE.md`.