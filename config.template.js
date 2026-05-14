// Copy this file to config.js and modify as needed
module.exports = {
    // Set environment here: 'development' or 'production'
    environment: 'development',
    
    // Environment specific paths
    paths: {
        development: {
            peersDataPath: "/Users/jt/Library/Application Support/DigiByte/peers.dat",
            testnetPeersDataPath: "/Users/jt/Library/Application Support/DigiByte/testnet24/peers.dat"
        },
        production: {
            peersDataPath: "/home/digihash/.digibyte-scrypt/peers.dat",
            testnetPeersDataPath: "/home/digihash/.digibyte-scrypt/testnet24/peers.dat"
        }
    }
};
