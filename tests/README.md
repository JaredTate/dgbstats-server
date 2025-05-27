# DigiByte Stats Server - Testing Guide

This README provides comprehensive instructions for running and understanding the test suite for the DigiByte Stats Server.

## Table of Contents

- [Quick Start](#quick-start)
- [Test Suite Overview](#test-suite-overview)
- [Running Tests](#running-tests)
- [Test Categories](#test-categories)
- [Test Development](#test-development)
- [CI/CD Integration](#cicd-integration)
- [Troubleshooting](#troubleshooting)

## Quick Start

### Prerequisites

- Node.js 14+ installed
- npm or yarn package manager
- SQLite3 support (usually included with Node.js)

### Installation

```bash
# Install all dependencies including test dependencies
npm install

# Verify installation
npm run test --version
```

### Run All Tests

```bash
# Run complete test suite
npm test

# Run tests with coverage report
npm run test:coverage
```

## Test Suite Overview

### Test Statistics

- **Total Test Files**: 6 test files
- **Total Test Cases**: 296+ individual tests
- **Coverage Target**: >90% for all metrics
- **Execution Time**: ~30-60 seconds for full suite

### Test Architecture

```
tests/
├── unit/                    # 89 unit tests
│   ├── rpc.test.js         # RPC module functionality (45 tests)
│   └── server-core.test.js # Core server functions (44 tests)
├── integration/             # 127 integration tests
│   ├── api.test.js         # HTTP API endpoints (31 tests)
│   ├── websocket.test.js   # WebSocket functionality (34 tests)
│   ├── database.test.js    # Database operations (42 tests)
│   └── end-to-end.test.js  # Complete workflows (20 tests)
├── fixtures/                # Mock data and test fixtures
├── helpers/                 # Test utilities and setup
└── coverage/               # Generated coverage reports
```

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run all tests with detailed output
npm run test:verbose

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Generate coverage report
npm run test:coverage
```

### Specific Test Categories

```bash
# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run specific test file
npx jest tests/unit/rpc.test.js

# Run tests matching a pattern
npx jest --testNamePattern="should handle RPC"
```

### Advanced Options

```bash
# Run tests in parallel (default)
npm test -- --maxWorkers=4

# Run tests serially (for debugging)
npm test -- --runInBand

# Run tests with specific timeout
npm test -- --testTimeout=10000

# Run only changed tests (with git)
npm test -- --onlyChanged

# Update snapshots (if using snapshot testing)
npm test -- --updateSnapshot
```

## Test Categories

### 1. Unit Tests (`/tests/unit/`)

**Purpose**: Test individual functions and modules in isolation

**Files**:
- `rpc.test.js` - Tests RPC functionality, caching, rate limiting
- `server-core.test.js` - Tests core server functions without HTTP dependencies

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
- `api.test.js` - HTTP API endpoint testing
- `websocket.test.js` - WebSocket connection and messaging
- `database.test.js` - SQLite database operations
- `end-to-end.test.js` - Complete application workflows

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

## Test Development

### Writing New Tests

#### Basic Test Structure

```javascript
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

#### Using Test Utilities

```javascript
const { createTestDatabase, mockAxios } = require('./helpers/test-utils');
const { mockBlockchainInfo } = require('./fixtures/mock-rpc-responses');

test('should use test utilities', async () => {
  // Use pre-built test database
  const db = createTestDatabase();
  
  // Use mock RPC responses
  const mockRpc = mockAxios();
  mockRpc.mockResponse('getblockchaininfo', [], mockBlockchainInfo);
  
  // Test implementation
  // ...
  
  // Cleanup
  db.close();
  mockRpc.restore();
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
  
  afterEach((done) => {
    testDb.close(done);
  });
});

// ❌ Bad - Tests share state
let sharedDb;
beforeAll(() => {
  sharedDb = createTestDatabase();
});
```

#### 2. Descriptive Test Names

```javascript
// ✅ Good - Describes what and when
test('should return cached blockchain info when cache hit occurs', () => {});

// ❌ Bad - Vague description
test('blockchain test', () => {});
```

#### 3. Comprehensive Assertions

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
3. **Import required utilities**:
   ```javascript
   const { createTestDatabase } = require('../helpers/test-utils');
   const { mockData } = require('../fixtures/test-data');
   ```
4. **Add to Jest configuration** (automatic for `*.test.js` files)

## Coverage Reports

### Viewing Coverage

```bash
# Generate and view coverage
npm run test:coverage

# Open HTML coverage report
open tests/coverage/lcov-report/index.html
```

### Coverage Metrics

The test suite tracks four key metrics:

- **Lines**: Percentage of code lines executed
- **Functions**: Percentage of functions called
- **Branches**: Percentage of conditional branches taken
- **Statements**: Percentage of statements executed

### Coverage Goals

| Metric | Target | Current |
|--------|--------|---------|
| Lines | >90% | ~95% |
| Functions | >90% | ~95% |
| Branches | >85% | ~90% |
| Statements | >90% | ~95% |

### Improving Coverage

```bash
# Identify uncovered code
npm run test:coverage -- --verbose

# Run tests for specific file to see coverage
npx jest --coverage --collectCoverageFrom="rpc.js" tests/unit/rpc.test.js
```

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
        node-version: [14, 16, 18]
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v3
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
  },
  "husky": {
    "hooks": {
      "pre-commit": "npm run test:unit",
      "pre-push": "npm run test:coverage"
    }
  }
}
```

### Docker Testing

Create `Dockerfile.test`:

```dockerfile
FROM node:16-alpine

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
npm test -- --testTimeout=30000

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
afterEach((done) => {
  if (testDb) {
    testDb.close(done);
  } else {
    done();
  }
});
```

#### 4. Memory Issues

```bash
# Increase Node.js memory limit
node --max-old-space-size=4096 node_modules/.bin/jest

# Or set in package.json
{
  "scripts": {
    "test": "node --max-old-space-size=4096 node_modules/.bin/jest"
  }
}
```

### Debug Mode

```bash
# Run tests in debug mode
node --inspect-brk node_modules/.bin/jest --runInBand

# Run specific test with debugging
node --inspect-brk node_modules/.bin/jest --runInBand tests/unit/rpc.test.js
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
npm run test:verbose

# See console logs in tests
npm test -- --verbose --no-silent
```

## Performance Optimization

### Parallel Execution

```bash
# Use all CPU cores
npm test -- --maxWorkers=100%

# Use specific number of workers
npm test -- --maxWorkers=4

# Run serially for debugging
npm test -- --runInBand
```

### Test Selection

```bash
# Run only changed tests
npm test -- --onlyChanged

# Run tests related to specific files
npm test -- --findRelatedTests rpc.js server.js

# Skip slow tests during development
npm test -- --testNamePattern="^(?!.*slow).*"
```

### Cache Management

```bash
# Clear Jest cache
npx jest --clearCache

# Disable cache for single run
npm test -- --no-cache
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
npm test -- --verbose | grep "Time:"

# Profile test performance
npm test -- --logHeapUsage
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
3. **Check Jest documentation** for framework-specific issues
4. **Open an issue** with detailed reproduction steps

### Contributing Tests

1. **Follow existing patterns** in test structure
2. **Add comprehensive coverage** for new features
3. **Include both positive and negative test cases**
4. **Update documentation** for new test utilities
5. **Ensure tests pass** in CI environment

### Test Quality Guidelines

- **Maintainable**: Tests should be easy to understand and modify
- **Reliable**: Tests should pass consistently without flakiness
- **Fast**: Unit tests should run quickly, integration tests reasonably fast
- **Isolated**: Tests should not depend on external services or other tests
- **Comprehensive**: Tests should cover edge cases and error conditions

---

For more detailed information about specific test categories, see the individual test files and the comprehensive documentation in `tests/CLAUDE.md`.