const redis = require('redis');
const client = redis.createClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

client.on('connect', () => {
    console.log('Connected to Redis');
});

client.on('error', (err) => {
    console.log('Redis error:', err);
});

module.exports = client;
