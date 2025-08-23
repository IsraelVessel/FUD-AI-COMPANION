const winston = require('winston')
const path = require('path')

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4
}

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue'
}

// Tell winston that you want to link the colors defined above to the severity levels
winston.addColors(colors)

// Define which level of logging to show based on environment
const level = () => {
  const env = process.env.NODE_ENV || 'development'
  return env === 'development' ? 'debug' : 'info'
}

// Define different log formats
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => {
      const { timestamp, level, message, ...meta } = info
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''
      return `${timestamp} [${level}]: ${message} ${metaStr}`
    }
  )
)

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
)

// Define the transports
const transports = [
  // Console transport for development
  new winston.transports.Console({
    level: level(),
    format: logFormat,
    handleExceptions: true,
    handleRejections: true
  })
]

// Add file transports for production
if (process.env.NODE_ENV !== 'test') {
  // Ensure logs directory exists
  const fs = require('fs')
  const logsDir = path.join(__dirname, '..', 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  // Error logs - separate file for errors
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      handleExceptions: true,
      handleRejections: true
    })
  )

  // Combined logs - all levels
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  )

  // HTTP logs - for API requests
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'http.log'),
      level: 'http',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  )
}

// Create the logger
const logger = winston.createLogger({
  level: level(),
  levels,
  format: fileFormat,
  transports,
  exitOnError: false
})

// Add a stream method for Morgan HTTP logger integration
logger.stream = {
  write: (message) => {
    logger.http(message.trim())
  }
}

// Add helper methods for structured logging
logger.logRequest = (req, res, responseTime) => {
  logger.http('HTTP Request', {
    method: req.method,
    url: req.originalUrl,
    statusCode: res.statusCode,
    responseTime: `${responseTime}ms`,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    userId: req.user?.id
  })
}

logger.logError = (error, context = {}) => {
  logger.error('Application Error', {
    message: error.message,
    stack: error.stack,
    ...context
  })
}

logger.logAuth = (action, userId, details = {}) => {
  logger.info(`Auth: ${action}`, {
    userId,
    ...details
  })
}

logger.logPayment = (action, details = {}) => {
  logger.info(`Payment: ${action}`, details)
}

logger.logAI = (action, details = {}) => {
  logger.info(`AI: ${action}`, details)
}

// Security/audit logging
logger.logSecurity = (event, details = {}) => {
  logger.warn(`Security: ${event}`, {
    timestamp: new Date().toISOString(),
    ...details
  })
}

// Performance logging
logger.logPerformance = (operation, duration, details = {}) => {
  logger.debug(`Performance: ${operation}`, {
    duration: `${duration}ms`,
    ...details
  })
}

// Database operation logging
logger.logDB = (operation, details = {}) => {
  logger.debug(`Database: ${operation}`, details)
}

module.exports = logger
