# DigiByte Stats Server - Testing Documentation

This directory contains comprehensive test suites for the DigiByte Stats Server, covering unit tests, integration tests, and end-to-end testing scenarios.

## Testing Strategy

### Test Architecture

Our testing approach follows a multi-layered strategy:

1. **Unit Tests** - Test individual functions and modules in isolation
2. **Integration Tests** - Test component interactions and system integration
3. **End-to-End Tests** - Test complete workflows and user scenarios

### Test Categories

#### Unit Tests (`/tests/unit/`)
- **rpc.test.js** - Tests RPC functionality, caching, rate limiting, and error handling
- **server-core.test.js** - Tests core server functions without HTTP/WebSocket dependencies

#### Integration Tests (`/tests/integration/`)
- **api.test.js** - Tests HTTP API endpoints with real request/response cycles
- **websocket.test.js** - Tests WebSocket connections and real-time messaging
- **database.test.js** - Tests SQLite database operations and data persistence
- **end-to-end.test.js** - Tests complete application workflows

#### Test Support (`/tests/helpers/` & `/tests/fixtures/`)
- **Mock Data** - Realistic test data for blocks, RPC responses, and peer information
- **Test Utilities** - Helper functions for database setup, WebSocket testing, and mocking
- **Mock RPC Server** - Complete mock implementation of DigiByte RPC interface

## Test Framework and Tools

### Core Testing Stack
- **Jest** - Main testing framework with mocking and assertion capabilities
- **Supertest** - HTTP endpoint testing for Express applications
- **WebSocket** - WebSocket client library for real-time communication testing
- **SQLite3** - In-memory database testing

### Key Features
- **Comprehensive Mocking** - Mock RPC calls, WebSocket connections, and external dependencies
- **Realistic Data** - Test fixtures based on actual DigiByte blockchain data
- **Performance Testing** - Load testing for concurrent connections and high-throughput scenarios
- **Error Simulation** - Testing failure scenarios and error recovery mechanisms

## Running Tests

### Test Scripts

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage reporting
npm run test:coverage

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run tests with verbose output
npm run test:verbose
```

### Coverage Reporting

Tests generate coverage reports in multiple formats:
- **Console output** - Summary during test execution
- **HTML report** - Detailed coverage report in `tests/coverage/`
- **LCOV format** - For CI/CD integration

Target coverage goals:
- **Lines**: >90%
- **Functions**: >90%
- **Branches**: >85%
- **Statements**: >90%

## Test Structure and Organization

### Directory Layout

```
tests/
├── unit/                    # Unit tests
│   ├── rpc.test.js         # RPC module tests
│   └── server-core.test.js # Server core function tests
├── integration/             # Integration tests
│   ├── api.test.js         # HTTP API tests
│   ├── websocket.test.js   # WebSocket tests
│   ├── database.test.js    # Database tests
│   └── end-to-end.test.js  # Complete workflow tests
├── fixtures/                # Test data
│   ├── mock-rpc-responses.js
│   ├── mock-blocks.js
│   └── test-data.js
├── helpers/                 # Test utilities
│   ├── test-setup.js       # Global test configuration
│   ├── test-utils.js       # Common utilities
│   ├── mock-rpc.js         # RPC mocking utilities
│   └── README.md           # Helper documentation
├── coverage/                # Coverage reports (generated)
└── CLAUDE.md               # This documentation
```

## Key Testing Areas

### 1. RPC Interface Testing

**Core Functionality:**
- RPC request/response handling
- Cache hit/miss scenarios
- Rate limiting behavior
- Error handling and fallbacks
- Timeout management

**Block Processing:**
- Block data fetching and parsing
- Mining pool identification
- Algorithm detection
- Taproot signaling detection
- Time range filtering

**Cache Management:**
- TTL-based expiration
- Stale data recovery
- Cache statistics tracking
- Memory management

### 2. HTTP API Testing

**Endpoint Coverage:**
- `/api/getblockchaininfo` - Blockchain information
- `/api/getpeerinfo` - Peer network data
- `/api/getblockreward` - Current block reward
- `/api/getlatestblock` - Latest block information
- `/api/getchaintxstats` - Transaction statistics
- `/api/gettxoutsetinfo` - UTXO set information
- `/api/rpccachestats` - Cache performance metrics
- `/api/refreshcache` - Manual cache management
- `/api/blocknotify` - Block notification handling
- `/health` - Health check endpoint

**Error Scenarios:**
- RPC connection failures
- Invalid request parameters
- Timeout handling
- Malformed responses
- Network connectivity issues

### 3. WebSocket Testing

**Connection Management:**
- Connection establishment
- Multiple concurrent connections
- Connection cleanup
- Heartbeat/ping-pong handling
- Graceful disconnection

**Message Broadcasting:**
- Initial data delivery
- Real-time block notifications
- Peer data updates
- Error message handling
- Message format validation

**Performance Testing:**
- High-frequency message delivery
- Large numbers of concurrent connections
- Message queue management
- Memory usage under load

### 4. Database Testing

**Schema Validation:**
- Table creation and structure
- Index configuration
- Constraint enforcement
- Data type validation

**CRUD Operations:**
- Node data management
- Visit tracking
- Unique IP handling
- Bulk operations
- Transaction management

**Data Integrity:**
- Foreign key constraints
- Unique constraints
- Data validation
- Concurrent access handling

**Performance:**
- Query optimization
- Index usage
- Large dataset handling
- Transaction performance

## Mock Data and Fixtures

### Mock RPC Responses

Realistic mock data based on actual DigiByte network responses:

```javascript
// Blockchain information
mockBlockchainInfo = {
  chain: "main",
  blocks: 18234567,
  difficulty: 123456789.123456,
  // ... complete structure
}

// Block data with mining information
mockBlock = {
  height: 18234567,
  hash: "000000000000000123...",
  pow_algo: "sha256d",
  tx: [/* coinbase transaction */],
  // ... complete block structure
}
```

### Test Scenarios

**Normal Operations:**
- Successful RPC calls
- Valid block processing
- Proper cache behavior
- Correct WebSocket messaging

**Error Conditions:**
- RPC connection failures
- Network timeouts
- Invalid data formats
- Database errors
- Memory pressure scenarios

**Edge Cases:**
- Empty responses
- Malformed JSON
- Very large datasets
- Rapid request sequences
- Concurrent access patterns

## Performance Testing

### Load Testing Scenarios

**API Load Testing:**
- Concurrent HTTP requests
- Sustained request rates
- Memory usage monitoring
- Response time measurement

**WebSocket Load Testing:**
- Multiple simultaneous connections
- High-frequency message broadcasting
- Connection churn testing
- Memory leak detection

**Database Performance:**
- Large dataset operations
- Complex query performance
- Concurrent transaction handling
- Index effectiveness

### Performance Benchmarks

**Target Metrics:**
- API response time: <200ms (95th percentile)
- WebSocket message latency: <50ms
- Database query time: <100ms
- Memory usage: <512MB under load
- Concurrent connections: >1000 WebSocket connections

## Continuous Integration

### Test Automation

Tests are designed to run in CI/CD environments with:
- **Deterministic behavior** - No flaky tests due to timing or external dependencies
- **Isolated execution** - Tests don't interfere with each other
- **Fast execution** - Complete test suite runs in <5 minutes
- **Clear reporting** - Detailed failure information and coverage reports

### Environment Setup

**Requirements:**
- Node.js 14+
- SQLite3 support
- WebSocket support
- Sufficient memory for concurrent testing

**Configuration:**
- Environment variables for test configuration
- Mock data for external dependencies
- In-memory database for fast testing
- Parallel test execution support

## Debugging and Troubleshooting

### Common Issues

**Test Failures:**
1. **RPC Mock Issues** - Verify mock responses match expected format
2. **Timing Issues** - Use proper async/await patterns and timeouts
3. **Database Conflicts** - Ensure proper test isolation and cleanup
4. **WebSocket Errors** - Check connection lifecycle management

**Performance Issues:**
1. **Memory Leaks** - Monitor test memory usage and cleanup
2. **Slow Tests** - Profile test execution and optimize bottlenecks
3. **Flaky Tests** - Identify and fix non-deterministic behavior

### Debugging Tools

**Built-in Utilities:**
- Console output restoration for debugging
- Test data generation helpers
- Mock inspection utilities
- Performance timing helpers

**External Tools:**
- Jest debugging with `--verbose` flag
- Coverage analysis with detailed reports
- Memory profiling with Node.js tools
- WebSocket connection debugging

## Best Practices

### Test Writing Guidelines

**Structure:**
- Descriptive test names that explain the scenario
- Arrange-Act-Assert pattern for clarity
- Proper test isolation and cleanup
- Comprehensive error condition testing

**Mocking:**
- Mock external dependencies consistently
- Use realistic mock data
- Verify mock interactions
- Reset mocks between tests

**Assertions:**
- Test both success and failure scenarios
- Verify complete response structures
- Check side effects and state changes
- Use appropriate assertion methods

### Maintenance

**Regular Tasks:**
- Update mock data to match current blockchain state
- Review and update performance benchmarks
- Maintain test documentation
- Monitor test execution times

**Code Quality:**
- Regular refactoring of test code
- Remove obsolete tests
- Update tests when features change
- Maintain consistent coding style

## Future Enhancements

### Planned Improvements

**Test Coverage:**
- Additional error scenarios
- Edge case coverage expansion
- Performance regression testing
- Security vulnerability testing

**Test Infrastructure:**
- Automated test data generation
- Visual test reporting
- Test result trending
- Integration with monitoring systems

**Advanced Testing:**
- Property-based testing
- Mutation testing
- Chaos engineering scenarios
- Load testing automation

---

For questions about testing or to contribute improvements, please refer to the main project documentation or submit issues through the project repository.