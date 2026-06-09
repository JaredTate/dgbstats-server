import os
import socket
import struct
import hashlib
import json
import subprocess

def parse_peers_dat(filepath):
    with open(filepath, 'rb') as file:
        data = file.read()

        if len(data) < 82:
            return [], []

        # Parse header
        message_bytes = data[:4]
        version = data[4]
        key_size = data[5]
        new_address_count = struct.unpack("<I", data[38:42])[0]
        tried_address_count = struct.unpack("<I", data[42:46])[0]
        new_bucket_count = struct.unpack("<I", data[46:50])[0] ^ (1 << 30)
        total_address_count = new_address_count + tried_address_count

        expected_min_length = 50 + (total_address_count * 62) + 32
        if len(data) < expected_min_length:
            return [], []

        # Parse peer entries
        offset = 50
        unique_addresses = set()
        ipv4_addresses = set()
        ipv6_addresses = set()

        for _ in range(total_address_count):
            peer_data = data[offset:offset+62]
            ip = parse_ip_address(peer_data[16:32])
            if ip is not None:
                if ip.ip not in unique_addresses:
                    unique_addresses.add(ip.ip)
                    if ip.version == 4:
                        ipv4_addresses.add(ip.ip)
                    elif ip.version == 6:
                        ipv6_addresses.add(ip.ip)
            offset += 62

        # Verify data integrity
        if len(ipv4_addresses) + len(ipv6_addresses) > total_address_count:
            return [], []

        # Verify checksum
        checksum = data[-32:]
        calculated_checksum = hashlib.sha256(hashlib.sha256(data[:-32]).digest()).digest()
        if checksum != calculated_checksum:
            return [], []

        return list(ipv4_addresses), list(ipv6_addresses)

def parse_ip_address(ip_bytes):
    if not ip_bytes:
        return None
    elif ip_bytes[0] == 0 and len(ip_bytes) >= 16:
        # IPv4 address
        return IPAddress(socket.inet_ntop(socket.AF_INET, ip_bytes[12:16]), 4)
    elif len(ip_bytes) == 16:
        # IPv6 address
        return IPAddress(socket.inet_ntop(socket.AF_INET6, ip_bytes), 6)
    else:
        return None

class IPAddress:
    def __init__(self, ip, version):
        self.ip = ip
        self.version = version

    def __repr__(self):
        return self.ip

# Load configuration by executing node command
def get_config():
    result = subprocess.run(['node', '-e',
        'const config = require("./config.js"); console.log(JSON.stringify(config.paths[config.environment]))'],
        capture_output=True, text=True)
    return json.loads(result.stdout)

def get_testnet_peers_path(config):
    explicit_path = config.get('testnetPeersDataPath')
    if explicit_path:
        return explicit_path

    mainnet_path = config.get('peersDataPath')
    if mainnet_path:
        return os.path.join(os.path.dirname(mainnet_path), 'testnet26', 'peers.dat')

    raise KeyError('testnetPeersDataPath')

def build_output(unique_ipv4_addresses, unique_ipv6_addresses):
    return {
        'uniqueIPv4Addresses': unique_ipv4_addresses,
        'uniqueIPv6Addresses': unique_ipv6_addresses,
        'totalUniquePeers': len(unique_ipv4_addresses) + len(unique_ipv6_addresses),
        'totalUniqueIPv4Peers': len(unique_ipv4_addresses),
        'totalUniqueIPv6Peers': len(unique_ipv6_addresses)
    }

def main():
    config = get_config()
    peers_dat_path = os.environ.get('TESTNET_PEERS_DAT_PATH') or get_testnet_peers_path(config)
    unique_ipv4_addresses, unique_ipv6_addresses = parse_peers_dat(peers_dat_path)
    print(json.dumps(build_output(unique_ipv4_addresses, unique_ipv6_addresses)))

if __name__ == '__main__':
    main()
