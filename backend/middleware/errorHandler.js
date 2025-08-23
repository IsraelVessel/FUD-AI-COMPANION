const logger = require('../utils/logger')

/**
 * Global error handling middleware
 * Should be the last middleware in the stack
 */
const errorHandler = (error, req, res, next) => {
  let statusCode = error.statusCode || 500
  let message = error.message || 'Internal Server Error'
  let code = error.code || 'INTERNAL_ERROR'

  // Log the error
  logger.error('Error Handler:', {
    message: error.message,
    stack: error.stack,
    statusCode,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.user?.id
  })

  // Handle specific error types
  switch (error.name) {
    case 'ValidationError':
      statusCode = 400
      message = 'Validation Error'
      code = 'VALIDATION_ERROR'
      break

    case 'CastError':
      statusCode = 400
      message = 'Invalid ID format'
      code = 'INVALID_ID'
      break

    case 'MongoError':
    case 'DatabaseError':
      if (error.code === 11000) {
        statusCode = 409
        message = 'Duplicate field value'
        code = 'DUPLICATE_VALUE'
      } else {
        statusCode = 500
        message = 'Database error'
        code = 'DATABASE_ERROR'
      }
      break

    case 'JsonWebTokenError':
      statusCode = 401
      message = 'Invalid token'
      code = 'INVALID_TOKEN'
      break

    case 'TokenExpiredError':
      statusCode = 401
      message = 'Token expired'
      code = 'TOKEN_EXPIRED'
      break

    case 'MulterError':
      statusCode = 400
      if (error.code === 'LIMIT_FILE_SIZE') {
        message = 'File too large'
        code = 'FILE_TOO_LARGE'
      } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        message = 'Unexpected file field'
        code = 'UNEXPECTED_FILE'
      } else {
        message = 'File upload error'
        code = 'UPLOAD_ERROR'
      }
      break
  }

  // PostgreSQL specific errors
  if (error.code) {
    switch (error.code) {
      case '23505': // Unique violation
        statusCode = 409
        message = 'Duplicate entry'
        code = 'DUPLICATE_ENTRY'
        break
      case '23503': // Foreign key violation
        statusCode = 400
        message = 'Referenced record not found'
        code = 'FOREIGN_KEY_VIOLATION'
        break
      case '23502': // Not null violation
        statusCode = 400
        message = 'Required field missing'
        code = 'REQUIRED_FIELD_MISSING'
        break
      case '42P01': // Undefined table
        statusCode = 500
        message = 'Database table not found'
        code = 'TABLE_NOT_FOUND'
        break
    }
  }

  // Rate limiting errors
  if (error.type === 'RateLimitError') {
    statusCode = 429
    message = 'Too many requests'
    code = 'RATE_LIMIT_EXCEEDED'
  }

  // Build error response
  const errorResponse = {
    success: false,
    message,
    code,
    timestamp: new Date().toISOString()
  }

  // Add error details in development
  if (process.env.NODE_ENV === 'development') {
    errorResponse.error = {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
    
    if (error.details) {
      errorResponse.details = error.details
    }
  }

  // Add request ID if available
  if (req.requestId) {
    errorResponse.requestId = req.requestId
  }

  res.status(statusCode).json(errorResponse)
}

/**
 * Handle 404 errors for unknown routes
 */
const notFoundHandler = (req, res, next) => {
  const error = new Error(`Route ${req.originalUrl} not found`)
  error.statusCode = 404
  error.code = 'ROUTE_NOT_FOUND'
  next(error)
}

/**
 * Async error wrapper
 * Wraps async route handlers to catch errors automatically
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/**
 * Custom error class for application errors
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'APP_ERROR') {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.isOperational = true
    
    Error.captureStackTrace(this, this.constructor)
  }
}

/**
 * Validation error class
 */
class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, 400, 'VALIDATION_ERROR')
    this.details = details
  }
}

/**
 * Authentication error class
 */
class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401, 'AUTHENTICATION_ERROR')
  }
}

/**
 * Authorization error class
 */
class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'AUTHORIZATION_ERROR')
  }
}

/**
 * Not found error class
 */
class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND')
  }
}

/**
 * Conflict error class
 */
class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409, 'CONFLICT')
  }
}

/**
 * Rate limit error class
 */
class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED')
  }
}

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError
}
