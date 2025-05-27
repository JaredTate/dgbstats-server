# DigiByte Stats Server

This project provides a comprehensive real-time statistics server for the DigiByte blockchain network. It offers both REST API endpoints and WebSocket connections for live data streaming.

## Project Overview

The DigiByte Stats Server is designed to monitor and provide analytics for the DigiByte blockchain network. It tracks blockchain statistics, peer network information, mining data, and provides real-time updates through WebSocket connections.

### Key Features

- **Real-time Block Monitoring**: Live block notifications via WebSocket
- **Comprehensive Blockchain Analytics**: Detailed blockchain statistics and metrics
- **Peer Network Visualization**: Geographic mapping of network nodes
- **Mining Pool Analytics**: Pool identification and mining statistics
- **Multi-layer Caching**: Optimized performance with intelligent caching
- **Data Persistence**: Automatic backup and recovery mechanisms
- **Visit Analytics**: Tracking and reporting of site usage

## Architecture

### Core Components

#### 1. RPC Interface (`rpc.js`)
- **Purpose**: Handles all communication with the DigiByte daemon
- **Features**:
  - Smart caching with TTL-based expiration
  - Rate limiting to prevent node overload
  - Automatic retry and fallback mechanisms
  - Batch processing for block data
  - Pool identifier extraction from coinbase data

#### 2. Main Server (`server.js`)
- **Purpose**: Primary application server handling HTTP and WebSocket connections
- **Features**:
  - Express.js REST API
  - WebSocket server for real-time updates
  - SQLite database for persistent storage
  - Multi-tier caching system
  - Automatic data synchronization

### Data Flow

```
DigiByte Node (RPC) → rpc.js → server.js → WebSocket/REST API → Client
                                     ↓
                              SQLite Database
                                     ↓
                              Cache Persistence
```

## API Endpoints

### Blockchain Information
- `GET /api/getblockchaininfo` - Basic blockchain statistics
- `GET /api/getchaintxstats` - Transaction statistics
- `GET /api/gettxoutsetinfo` - UTXO set information
- `GET /api/getblockreward` - Current block reward
- `GET /api/getlatestblock` - Latest block information

### Network Information
- `GET /api/getpeerinfo` - Connected peers with geolocation
- `GET /api/getpeers` - Parsed peer network data

### System Information
- `GET /api/rpccachestats` - RPC cache performance metrics
- `GET /api/cachestatus` - Overall cache status
- `GET /api/visitstats` - Site visit analytics
- `GET /health` - Health check endpoint

### Administrative
- `POST /api/blocknotify` - Block notification webhook (internal)
- `POST /api/refreshcache` - Manual cache refresh
- `POST /api/refresh-peers` - Manual peer data refresh

## WebSocket Events

### Client-bound Events
- `recentBlocks` - Array of recent blocks for initial load
- `initialData` - Blockchain statistics package
- `geoData` - Geo-located peer network data
- `newBlock` - Real-time new block notification

### Connection Management
- Automatic ping/pong for connection health
- Graceful disconnection handling
- Automatic reconnection support

## Configuration

### Environment Variables
- `PORT` - HTTP server port (default: 5001)
- WebSocket server runs on port 5002

### RPC Configuration
Edit the RPC connection settings in `rpc.js`:
```javascript
const RPC_CONFIG = {
  user: 'your_rpc_user',
  password: 'your_rpc_password',
  url: 'http://127.0.0.1:14044'
};
```

### Cache Configuration
Caching behavior can be adjusted in both files:
- Block data: 1 hour TTL (immutable)
- General data: 1 minute TTL
- Peer data: 10 minutes TTL
- Heavy operations: 1 hour TTL

## Database Schema

### Tables
1. **nodes** - Peer geolocation data
   - `ip` (TEXT PRIMARY KEY)
   - `country` (TEXT)
   - `city` (TEXT)
   - `lat` (REAL)
   - `lon` (REAL)

2. **visits** - Visit tracking
   - `id` (INTEGER PRIMARY KEY)
   - `ip` (TEXT)
   - `timestamp` (DATETIME)

3. **unique_ips** - Unique visitor tracking
   - `ip` (TEXT PRIMARY KEY)

## Dependencies

### Core Dependencies
- **express** - Web framework
- **ws** - WebSocket implementation
- **axios** - HTTP client for RPC calls
- **cors** - Cross-origin resource sharing
- **sqlite3** - Database engine
- **node-cache** - In-memory caching
- **geoip-lite** - IP geolocation
- **crypto** - Hash generation for cache keys

### Python Dependencies
- **python3** - Required for peer data parsing script

## Installation and Setup

### Prerequisites
1. DigiByte Core node running with RPC enabled
2. Node.js (v14+ recommended)
3. Python 3.x

### Installation Steps
1. Clone the repository
2. Install dependencies: `npm install`
3. Configure RPC credentials in `rpc.js`
4. Ensure Python script `parse_peers_dat.py` is executable
5. Start the server: `node server.js`

### DigiByte Node Configuration
Add to your `digibyte.conf`:
```
server=1
rpcuser=your_username
rpcpassword=your_password
rpcallowip=127.0.0.1
rpcport=14044
blocknotify=./blocknotify.sh %s
```

## Performance Considerations

### Caching Strategy
- **Three-tier caching**: Memory → NodeCache → Disk persistence
- **Smart TTL**: Different cache durations based on data volatility
- **Stale data fallback**: Serves old data rather than failing

### Rate Limiting
- Maximum 4 concurrent RPC requests
- Batch processing for block fetching
- Exponential backoff for failed requests

### Database Optimization
- Indexed primary keys for fast lookups
- Minimal data storage with computed fields
- Automatic cleanup of old visit data

## Monitoring and Debugging

### Cache Statistics
Access `/api/rpccachestats` for detailed cache performance:
- Hit/miss ratios
- Cache key counts
- Pending request tracking

### System Status
Monitor overall system health via `/api/cachestatus`:
- Memory usage
- Database connections
- WebSocket client count
- Data freshness indicators

### Logging
The server provides comprehensive logging for:
- RPC call performance
- Cache operations
- WebSocket connections
- Error conditions
- Startup/shutdown events

## Error Handling

### RPC Failures
- Automatic retry with exponential backoff
- Stale cache data as fallback
- Graceful degradation for non-critical operations

### Database Errors
- Robust error handling for SQLite operations
- Automatic schema creation
- Transaction rollback on failures

### Network Issues
- WebSocket reconnection logic
- Peer data retry mechanisms
- Health check endpoints

## Security Considerations

### Access Control
- No authentication required for read-only endpoints
- Administrative endpoints should be protected
- Rate limiting prevents abuse

### Data Privacy
- IP addresses stored for analytics (consider GDPR compliance)
- No sensitive blockchain data exposure
- Secure RPC communication (localhost only)

## Development Guidelines

### Code Structure
- Modular design with clear separation of concerns
- Comprehensive error handling
- Detailed logging and monitoring
- Consistent coding style with JSDoc comments

### Testing Recommendations
- Unit tests for core RPC functions
- Integration tests for API endpoints
- WebSocket connection testing
- Performance testing under load

### Deployment Considerations
- Process management (PM2 recommended)
- Log rotation and monitoring
- Database backup strategies
- Graceful shutdown handling

## Troubleshooting

### Common Issues

1. **RPC Connection Failures**
   - Verify DigiByte node is running
   - Check RPC credentials and port
   - Ensure firewall allows connections

2. **Cache Performance Issues**
   - Monitor cache hit rates
   - Adjust TTL values if needed
   - Check memory usage

3. **WebSocket Connection Problems**
   - Verify port 5002 is accessible
   - Check for firewall blocking
   - Monitor connection counts

4. **Peer Data Issues**
   - Ensure Python script is executable
   - Check peers.dat file location
   - Verify geolocation database

### Useful Commands

```bash
# Check server status
curl http://localhost:5001/health

# View cache statistics
curl http://localhost:5001/api/rpccachestats

# Manual cache refresh
curl -X POST http://localhost:5001/api/refreshcache \
  -H "Content-Type: application/json" \
  -d '{"type": "blockchain"}'

# Check peer data
curl http://localhost:5001/api/getpeers
```

## Future Enhancements

### Planned Features
- Historical data charting
- Mining pool statistics
- Network health metrics
- Alert system for anomalies
- REST API documentation (OpenAPI)

### Optimization Opportunities
- Redis integration for distributed caching
- Database partitioning for large datasets
- CDN integration for static assets
- Horizontal scaling capabilities

## Contributing

### Development Setup
1. Fork the repository
2. Create feature branch
3. Follow existing code style
4. Add comprehensive tests
5. Update documentation
6. Submit pull request

### Code Quality
- ESLint configuration provided
- JSDoc comments required
- Error handling mandatory
- Performance considerations important

## License

[Add your license information here]

## Support

For issues and questions:
1. Check this documentation
2. Review error logs
3. Test with health endpoints
4. Open GitHub issue if needed

---

**Last Updated**: [Current Date]
**Version**: 2.0.0