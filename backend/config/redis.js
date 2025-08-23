const redis = require('redis')
const logger = require('../utils/logger')

let redisClient = null

/**
 * Connect to Redis
 * @returns {Promise<Object>} Redis client
 */
async function connectRedis() {
  try {
    redisClient = redis.createClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: process.env.REDIS_DB || 0,
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          logger.error('Redis connection refused')
          return new Error('Redis connection refused')
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          return new Error('Retry time exhausted')
        }
        if (options.attempt > 10) {
          return undefined
        }
        return Math.min(options.attempt * 100, 3000)
      }
    })

    redisClient.on('connect', () => {
      logger.info('✅ Redis connected successfully')
    })

    redisClient.on('error', (error) => {
      logger.error('❌ Redis connection error:', error)
    })

    redisClient.on('ready', () => {
      logger.info('🔄 Redis ready for operations')
    })

    redisClient.on('end', () => {
      logger.info('🔌 Redis connection closed')
    })

    await redisClient.connect()
    return redisClient

  } catch (error) {
    logger.error('Failed to connect to Redis:', error)
    throw error
  }
}

/**
 * Get Redis client instance
 * @returns {Object} Redis client
 */
function getRedisClient() {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call connectRedis() first.')
  }
  return redisClient
}

/**
 * Cache operations wrapper
 */
const cache = {
  /**
   * Set cache value with TTL
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds
   */
  async set(key, value, ttl = 3600) {
    try {
      const client = getRedisClient()
      const serialized = JSON.stringify(value)
      await client.setEx(key, ttl, serialized)
      logger.debug(`Cache SET: ${key}`, { ttl })
    } catch (error) {
      logger.error('Cache SET error:', error)
      throw error
    }
  },

  /**
   * Get cache value
   * @param {string} key - Cache key
   * @returns {any} Cached value or null
   */
  async get(key) {
    try {
      const client = getRedisClient()
      const value = await client.get(key)
      if (value) {
        logger.debug(`Cache HIT: ${key}`)
        return JSON.parse(value)
      }
      logger.debug(`Cache MISS: ${key}`)
      return null
    } catch (error) {
      logger.error('Cache GET error:', error)
      return null
    }
  },

  /**
   * Delete cache value
   * @param {string} key - Cache key
   */
  async del(key) {
    try {
      const client = getRedisClient()
      await client.del(key)
      logger.debug(`Cache DEL: ${key}`)
    } catch (error) {
      logger.error('Cache DEL error:', error)
    }
  },

  /**
   * Check if key exists
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists
   */
  async exists(key) {
    try {
      const client = getRedisClient()
      const exists = await client.exists(key)
      return exists === 1
    } catch (error) {
      logger.error('Cache EXISTS error:', error)
      return false
    }
  },

  /**
   * Set cache with pattern-based expiration
   * @param {string} pattern - Key pattern
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds
   */
  async setWithPattern(pattern, value, ttl = 3600) {
    try {
      const key = `${pattern}:${Date.now()}`
      await this.set(key, value, ttl)
      return key
    } catch (error) {
      logger.error('Cache SET with pattern error:', error)
      throw error
    }
  },

  /**
   * Get all keys matching pattern
   * @param {string} pattern - Key pattern
   * @returns {Array} Array of keys
   */
  async getKeys(pattern) {
    try {
      const client = getRedisClient()
      return await client.keys(pattern)
    } catch (error) {
      logger.error('Cache GET keys error:', error)
      return []
    }
  },

  /**
   * Increment counter
   * @param {string} key - Counter key
   * @param {number} increment - Increment value
   * @param {number} ttl - Time to live in seconds
   * @returns {number} New counter value
   */
  async incr(key, increment = 1, ttl = 3600) {
    try {
      const client = getRedisClient()
      const value = await client.incrBy(key, increment)
      if (ttl > 0) {
        await client.expire(key, ttl)
      }
      return value
    } catch (error) {
      logger.error('Cache INCR error:', error)
      throw error
    }
  },

  /**
   * Add to set
   * @param {string} key - Set key
   * @param {string|Array} members - Member(s) to add
   * @param {number} ttl - Time to live in seconds
   */
  async sadd(key, members, ttl = 3600) {
    try {
      const client = getRedisClient()
      const membersArray = Array.isArray(members) ? members : [members]
      await client.sAdd(key, membersArray)
      if (ttl > 0) {
        await client.expire(key, ttl)
      }
    } catch (error) {
      logger.error('Cache SADD error:', error)
      throw error
    }
  },

  /**
   * Get set members
   * @param {string} key - Set key
   * @returns {Array} Set members
   */
  async smembers(key) {
    try {
      const client = getRedisClient()
      return await client.sMembers(key)
    } catch (error) {
      logger.error('Cache SMEMBERS error:', error)
      return []
    }
  },

  /**
   * Remove from set
   * @param {string} key - Set key
   * @param {string|Array} members - Member(s) to remove
   */
  async srem(key, members) {
    try {
      const client = getRedisClient()
      const membersArray = Array.isArray(members) ? members : [members]
      await client.sRem(key, membersArray)
    } catch (error) {
      logger.error('Cache SREM error:', error)
    }
  }
}

/**
 * Session operations
 */
const session = {
  /**
   * Create session
   * @param {string} sessionId - Session ID
   * @param {Object} data - Session data
   * @param {number} ttl - Time to live in seconds
   */
  async create(sessionId, data, ttl = 86400) { // 24 hours default
    try {
      const key = `session:${sessionId}`
      await cache.set(key, data, ttl)
      logger.debug(`Session created: ${sessionId}`)
    } catch (error) {
      logger.error('Session create error:', error)
      throw error
    }
  },

  /**
   * Get session
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Session data
   */
  async get(sessionId) {
    try {
      const key = `session:${sessionId}`
      return await cache.get(key)
    } catch (error) {
      logger.error('Session get error:', error)
      return null
    }
  },

  /**
   * Update session
   * @param {string} sessionId - Session ID
   * @param {Object} data - Updated session data
   * @param {number} ttl - Time to live in seconds
   */
  async update(sessionId, data, ttl = 86400) {
    try {
      const key = `session:${sessionId}`
      await cache.set(key, data, ttl)
      logger.debug(`Session updated: ${sessionId}`)
    } catch (error) {
      logger.error('Session update error:', error)
      throw error
    }
  },

  /**
   * Delete session
   * @param {string} sessionId - Session ID
   */
  async delete(sessionId) {
    try {
      const key = `session:${sessionId}`
      await cache.del(key)
      logger.debug(`Session deleted: ${sessionId}`)
    } catch (error) {
      logger.error('Session delete error:', error)
    }
  }
}

/**
 * Rate limiting operations
 */
const rateLimit = {
  /**
   * Check rate limit
   * @param {string} identifier - Rate limit identifier (IP, user ID, etc.)
   * @param {number} limit - Request limit
   * @param {number} window - Time window in seconds
   * @returns {Object} Rate limit info
   */
  async check(identifier, limit = 100, window = 3600) {
    try {
      const key = `rate_limit:${identifier}`
      const current = await cache.incr(key, 1, window)
      
      const remaining = Math.max(0, limit - current)
      const resetTime = Date.now() + (window * 1000)

      return {
        current,
        limit,
        remaining,
        resetTime,
        blocked: current > limit
      }
    } catch (error) {
      logger.error('Rate limit check error:', error)
      return {
        current: 0,
        limit,
        remaining: limit,
        resetTime: Date.now() + (window * 1000),
        blocked: false
      }
    }
  }
}

/**
 * Health check for Redis
 */
async function healthCheck() {
  try {
    const client = getRedisClient()
    await client.ping()
    return {
      status: 'healthy',
      timestamp: new Date().toISOString()
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    }
  }
}

/**
 * Close Redis connection
 */
async function closeRedis() {
  try {
    if (redisClient) {
      await redisClient.quit()
      redisClient = null
      logger.info('Redis connection closed')
    }
  } catch (error) {
    logger.error('Error closing Redis connection:', error)
  }
}

module.exports = {
  connectRedis,
  getRedisClient,
  cache,
  session,
  rateLimit,
  healthCheck,
  closeRedis
}
