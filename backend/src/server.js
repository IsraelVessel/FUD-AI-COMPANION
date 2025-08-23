const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const { connectDB } = require('../config/database')
const { connectRedis } = require('../config/redis')
const logger = require('../utils/logger')
const errorHandler = require('../middleware/errorHandler')

// Import routes
const authRoutes = require('../routes/auth')
const studentRoutes = require('../routes/students')
const academicRoutes = require('../routes/academics')
const paymentRoutes = require('../routes/payments')
const aiRoutes = require('../routes/ai')
const notificationRoutes = require('../routes/notifications')
const adminRoutes = require('../routes/admin')
const alumniRoutes = require('../routes/alumni')

const app = express()
const PORT = process.env.PORT || 3000

// Security middleware
app.use(helmet())

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  credentials: true
}))

// Rate limiting
const limiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000, // 15 minutes default
  max: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
  message: {
    error: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  }
})
app.use('/api', limiter)

// Body parsing middleware
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// Compression middleware
app.use(compression())

// Logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  })
  next()
})

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  })
})

// API routes
app.use(`/api/${process.env.API_VERSION || 'v1'}/auth`, authRoutes)
app.use(`/api/${process.env.API_VERSION || 'v1'}/students`, studentRoutes)
app.use(`/api/${process.env.API_VERSION || 'v1'}/academics`, academicRoutes)
app.use(`/api/${process.env.API_VERSION || 'v1'}/payments`, paymentRoutes)
app.use(`/api/${process.env.API_VERSION || 'v1'}/ai`, aiRoutes)
app.use(`/api/${process.env.API_VERSION || 'v1'}/notifications`, notificationRoutes)
app.use(`/api/${process.env.API_VERSION || 'v1'}/admin`, adminRoutes)
app.use(`/api/${process.env.API_VERSION || 'v1'}/alumni`, alumniRoutes)

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    code: 'ROUTE_NOT_FOUND'
  })
})

// Global error handler
app.use(errorHandler)

// Start server
async function startServer() {
  try {
    // Connect to databases
    await connectDB()
    await connectRedis()
    
    // Start HTTP server
    const server = app.listen(PORT, () => {
      logger.info(`🚀 FUD AI Companion API Server running on port ${PORT}`)
      logger.info(`📊 Environment: ${process.env.NODE_ENV}`)
      logger.info(`🔗 API Base URL: http://localhost:${PORT}/api/${process.env.API_VERSION || 'v1'}`)
    })

    // Graceful shutdown
    const gracefulShutdown = (signal) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`)
      server.close(() => {
        logger.info('HTTP server closed.')
        process.exit(0)
      })
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
    process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  } catch (error) {
    logger.error('Failed to start server:', error)
    process.exit(1)
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  process.exit(1)
})

startServer()

module.exports = app
