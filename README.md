# DigiByte Stats Server

Real-time blockchain statistics backend for the DigiByte Stats web application. This Node.js server provides WebSocket broadcasting, cached RPC access, and geographic node tracking for both mainnet and testnet networks.

## Overview

Three components are needed to run the DGB stats site:
- **dgbstats** - React frontend application
- **dgbstats-server** - This backend server
- **digibyted** - DigiByte Core node

## Features

- Real-time WebSocket broadcasting of blocks and transactions
- Intelligent caching with TTL management and disk persistence
- Geographic peer node tracking with geolocation
- Full testnet support with separate WebSocket server
- Transaction lifecycle tracking from mempool to confirmation
- Optional ZeroMQ integration for instant notifications

## Prerequisites

- **Node.js** v14.x or higher (tested with v21.7.2)
- **DigiByte Node** with RPC enabled
- **Python 3** for peers.dat parsing

## Installation

1. Clone the repository:
```bash
git clone https://github.com/JaredTate/dgbstats-server.git
cd dgbstats-server
```

2. Install Node.js (Ubuntu/Debian):
```bash
sudo apt update
sudo apt install nodejs npm
sudo npm install -g n
sudo n install 21.7.2
sudo n use 21.7.2
```

3. Install dependencies:
```bash
npm install
```

4. Create configuration file:
```bash
cp config.template.js config.js
# Edit config.js with your paths
```

## DigiByte Node Configuration

### Mainnet Configuration

Create or edit `~/.digibyte/digibyte.conf`:

```ini
# Basic Settings
server=1
daemon=1
txindex=1

# RPC Configuration
rpcuser=your_rpc_username
rpcpassword=your_secure_password
rpcallowip=127.0.0.1
rpcport=14044

# Performance Settings
rpcworkqueue=64
rpcthreads=8
maxconnections=128

# Block Notifications (optional but recommended)
blocknotify=/path/to/dgbstats-server/blocknotify.sh %s

# ZeroMQ Configuration (optional - for real-time updates)
zmqpubrawtx=tcp://127.0.0.1:28333
zmqpubhashtx=tcp://127.0.0.1:28335
zmqpubrawblock=tcp://127.0.0.1:28332
zmqpubhashblock=tcp://127.0.0.1:28334
```

### Testnet Configuration

For testnet, add to `~/.digibyte/digibyte.conf` or create `~/.digibyte/testnet4/digibyte.conf`:

```ini
# Enable Testnet
testnet=1

# Basic Settings
server=1
daemon=1
txindex=1

# RPC Configuration (testnet uses different port)
rpcuser=your_rpc_username
rpcpassword=your_secure_password
rpcallowip=127.0.0.1
rpcport=14022

# Performance Settings
rpcworkqueue=64
rpcthreads=8
maxconnections=128

# Block Notifications (optional)
blocknotify=/path/to/dgbstats-server/blocknotify.sh %s testnet
```

## Environment Variables

Set these environment variables before running the server:

```bash
# Mainnet RPC
export DGB_RPC_USER=your_username
export DGB_RPC_PASSWORD=your_password
export DGB_RPC_URL=http://127.0.0.1:14044

# Testnet RPC
export DGB_TESTNET_RPC_USER=your_username
export DGB_TESTNET_RPC_PASSWORD=your_password
export DGB_TESTNET_RPC_URL=http://127.0.0.1:14022

# Server Ports (optional - defaults shown)
export PORT=5001
export DGB_TESTNET_WS_PORT=5003
```

## Running the Server

### Development
```bash
npm start
# or
node server.js
```

### Production (with PM2)
```bash
npm install -g pm2
pm2 start server.js --name dgbstats-server
pm2 save
pm2 startup
```

### Server Ports

| Service | Port | Description |
|---------|------|-------------|
| HTTP API | 5001 | REST API endpoints |
| WebSocket (Mainnet) | 5002 | Real-time mainnet data |
| WebSocket (Testnet) | 5003 | Real-time testnet data |

## API Endpoints

### Mainnet Endpoints (`/api/*`)
- `/api/getblockchaininfo` - Blockchain state
- `/api/getlatestblock` - Latest block info
- `/api/getchaintxstats` - Transaction statistics
- `/api/gettxoutsetinfo` - UTXO set info
- `/api/getmempoolinfo` - Mempool statistics
- `/api/getpeerinfo` - Connected peers with geolocation
- `/api/getpeers` - Parsed peers.dat data
- `/api/blocknotify` - Block notification webhook

### Testnet Endpoints (`/api/testnet/*`)
All mainnet endpoints are mirrored with `/api/testnet/` prefix.

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration
```

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Detailed technical architecture
- **[CLAUDE.md](./CLAUDE.md)** - AI agent documentation
- **[tests/README.md](./tests/README.md)** - Testing guide

## License

MIT License - See [LICENSE](./LICENSE) for details.

## Credits

Developed by Jared Tate and the DigiByte community.
