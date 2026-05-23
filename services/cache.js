const NodeCache = require('node-cache');

// Cache results for 24 hours
const cache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

function getCached(key) {
  return cache.get(key);
}

function setCache(key, value) {
  cache.set(key, value);
}

function clearCache(key) {
  cache.del(key);
}

module.exports = { getCached, setCache, clearCache };
