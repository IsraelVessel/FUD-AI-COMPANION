const { Pool } = require('pg')
const logger = require('../utils/logger')

// Database connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'fud_ai_companion',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum number of connections in the pool
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 2000, // Return error after 2 seconds if connection cannot be established
})

// Database connection function
async function connectDB() {
  try {
    // Test the connection
    const client = await pool.connect()
    await client.query('SELECT NOW()')
    client.release()
    
    logger.info('✅ PostgreSQL database connected successfully')
    return pool
  } catch (error) {
    logger.error('❌ Database connection failed:', error.message)
    throw error
  }
}

// Query function with error handling
async function query(text, params = []) {
  const start = Date.now()
  try {
    const result = await pool.query(text, params)
    const duration = Date.now() - start
    
    logger.debug('Query executed', {
      text: text.slice(0, 100),
      duration: `${duration}ms`,
      rows: result.rowCount
    })
    
    return result
  } catch (error) {
    logger.error('Database query error:', {
      text: text.slice(0, 100),
      error: error.message,
      stack: error.stack
    })
    throw error
  }
}

// Transaction wrapper
async function withTransaction(callback) {
  const client = await pool.connect()
  
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// Health check for database
async function healthCheck() {
  try {
    const result = await query('SELECT 1 as healthy, NOW() as timestamp')
    return {
      status: 'healthy',
      timestamp: result.rows[0].timestamp,
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingConnections: pool.waitingCount
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    }
  }
}

// Graceful shutdown
async function closeDB() {
  try {
    await pool.end()
    logger.info('Database connection pool closed')
  } catch (error) {
    logger.error('Error closing database connection:', error)
  }
}

module.exports = {
  connectDB,
  query,
  withTransaction,
  healthCheck,
  closeDB,
  pool
}
