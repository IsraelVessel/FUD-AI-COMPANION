const jwt = require('jsonwebtoken')
const logger = require('./logger')

/**
 * Generate access token
 * @param {Object} payload - Token payload
 * @param {string} payload.userId - User ID
 * @param {string} payload.role - User role
 * @returns {string} JWT token
 */
function generateToken(payload) {
  try {
    return jwt.sign(
      payload,
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRE || '7d',
        issuer: 'fud-ai-companion',
        audience: 'fud-students'
      }
    )
  } catch (error) {
    logger.error('Token generation failed:', error)
    throw new Error('Token generation failed')
  }
}

/**
 * Generate refresh token
 * @param {Object} payload - Token payload
 * @returns {string} JWT refresh token
 */
function generateRefreshToken(payload) {
  try {
    return jwt.sign(
      payload,
      process.env.JWT_REFRESH_SECRET,
      {
        expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d',
        issuer: 'fud-ai-companion',
        audience: 'fud-students'
      }
    )
  } catch (error) {
    logger.error('Refresh token generation failed:', error)
    throw new Error('Refresh token generation failed')
  }
}

/**
 * Verify access token
 * @param {string} token - JWT token
 * @returns {Object|null} Decoded token payload or null if invalid
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'fud-ai-companion',
      audience: 'fud-students'
    })
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      logger.debug('Token expired')
    } else if (error.name === 'JsonWebTokenError') {
      logger.debug('Invalid token')
    } else {
      logger.error('Token verification failed:', error)
    }
    return null
  }
}

/**
 * Verify refresh token
 * @param {string} refreshToken - JWT refresh token
 * @returns {Object|null} Decoded token payload or null if invalid
 */
function verifyRefreshToken(refreshToken) {
  try {
    return jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
      issuer: 'fud-ai-companion',
      audience: 'fud-students'
    })
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      logger.debug('Refresh token expired')
    } else if (error.name === 'JsonWebTokenError') {
      logger.debug('Invalid refresh token')
    } else {
      logger.error('Refresh token verification failed:', error)
    }
    return null
  }
}

/**
 * Decode token without verification (for debugging)
 * @param {string} token - JWT token
 * @returns {Object|null} Decoded token or null if invalid
 */
function decodeToken(token) {
  try {
    return jwt.decode(token, { complete: true })
  } catch (error) {
    logger.error('Token decode failed:', error)
    return null
  }
}

/**
 * Get token expiration time
 * @param {string} token - JWT token
 * @returns {Date|null} Expiration date or null if invalid
 */
function getTokenExpiration(token) {
  try {
    const decoded = jwt.decode(token)
    if (decoded && decoded.exp) {
      return new Date(decoded.exp * 1000)
    }
    return null
  } catch (error) {
    logger.error('Failed to get token expiration:', error)
    return null
  }
}

/**
 * Check if token is expired
 * @param {string} token - JWT token
 * @returns {boolean} True if token is expired
 */
function isTokenExpired(token) {
  try {
    const decoded = jwt.decode(token)
    if (decoded && decoded.exp) {
      const now = Math.floor(Date.now() / 1000)
      return decoded.exp < now
    }
    return true
  } catch (error) {
    logger.error('Failed to check token expiration:', error)
    return true
  }
}

/**
 * Extract user ID from token
 * @param {string} token - JWT token
 * @returns {string|null} User ID or null if not found
 */
function extractUserIdFromToken(token) {
  try {
    const decoded = jwt.decode(token)
    return decoded?.userId || null
  } catch (error) {
    logger.error('Failed to extract user ID from token:', error)
    return null
  }
}

module.exports = {
  generateToken,
  generateRefreshToken,
  verifyToken,
  verifyRefreshToken,
  decodeToken,
  getTokenExpiration,
  isTokenExpired,
  extractUserIdFromToken
}
