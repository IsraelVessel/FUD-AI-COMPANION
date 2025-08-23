const jwt = require('jsonwebtoken')
const { query } = require('../config/database')
const logger = require('../utils/logger')

/**
 * Authentication middleware
 * Verifies JWT token and adds user info to request
 */
const auth = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.header('Authorization')
    const token = authHeader && authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : null

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided',
        code: 'NO_TOKEN'
      })
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      
      // Get user from database to ensure they still exist and are active
      const userResult = await query(
        'SELECT id, email, role, is_active FROM users WHERE id = $1',
        [decoded.userId]
      )

      if (userResult.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        })
      }

      const user = userResult.rows[0]

      if (!user.is_active) {
        return res.status(401).json({
          success: false,
          message: 'Account is deactivated',
          code: 'ACCOUNT_DEACTIVATED'
        })
      }

      // Add user info to request
      req.user = {
        id: user.id,
        email: user.email,
        role: user.role
      }

      next()

    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired',
          code: 'TOKEN_EXPIRED'
        })
      } else if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid token',
          code: 'INVALID_TOKEN'
        })
      } else {
        throw jwtError
      }
    }

  } catch (error) {
    logger.error('Auth middleware error:', error)
    res.status(500).json({
      success: false,
      message: 'Authentication failed',
      code: 'AUTH_ERROR'
    })
  }
}

/**
 * Role-based authorization middleware
 * @param {string|Array} roles - Required role(s)
 */
const authorize = (roles) => {
  return (req, res, next) => {
    const userRole = req.user?.role
    const allowedRoles = Array.isArray(roles) ? roles : [roles]

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        code: 'INSUFFICIENT_PERMISSIONS'
      })
    }

    next()
  }
}

/**
 * Student-only middleware
 * Ensures user is a student and adds student info to request
 */
const studentOnly = async (req, res, next) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({
        success: false,
        message: 'Student access required',
        code: 'STUDENT_ACCESS_REQUIRED'
      })
    }

    // Get student details
    const studentResult = await query(
      'SELECT id, student_id, academic_status FROM students WHERE user_id = $1',
      [req.user.id]
    )

    if (studentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student profile not found',
        code: 'STUDENT_NOT_FOUND'
      })
    }

    const student = studentResult.rows[0]

    // Add student info to request
    req.student = {
      id: student.id,
      studentId: student.student_id,
      academicStatus: student.academic_status
    }

    next()

  } catch (error) {
    logger.error('Student middleware error:', error)
    res.status(500).json({
      success: false,
      message: 'Student verification failed'
    })
  }
}

/**
 * Alumni-only middleware
 * Ensures user is an alumni
 */
const alumniOnly = async (req, res, next) => {
  try {
    if (req.user.role !== 'alumni') {
      return res.status(403).json({
        success: false,
        message: 'Alumni access required',
        code: 'ALUMNI_ACCESS_REQUIRED'
      })
    }

    // Get alumni details
    const alumniResult = await query(
      'SELECT id, graduation_year FROM alumni WHERE user_id = $1',
      [req.user.id]
    )

    if (alumniResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Alumni profile not found',
        code: 'ALUMNI_NOT_FOUND'
      })
    }

    const alumni = alumniResult.rows[0]

    // Add alumni info to request
    req.alumni = {
      id: alumni.id,
      graduationYear: alumni.graduation_year
    }

    next()

  } catch (error) {
    logger.error('Alumni middleware error:', error)
    res.status(500).json({
      success: false,
      message: 'Alumni verification failed'
    })
  }
}

/**
 * Optional authentication middleware
 * Adds user info if token is provided, but doesn't require it
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization')
    const token = authHeader && authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : null

    if (!token) {
      return next()
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      
      const userResult = await query(
        'SELECT id, email, role, is_active FROM users WHERE id = $1',
        [decoded.userId]
      )

      if (userResult.rows.length > 0 && userResult.rows[0].is_active) {
        const user = userResult.rows[0]
        req.user = {
          id: user.id,
          email: user.email,
          role: user.role
        }
      }
    } catch (jwtError) {
      // Token is invalid but we don't reject the request
      logger.debug('Optional auth - invalid token:', jwtError.message)
    }

    next()

  } catch (error) {
    logger.error('Optional auth middleware error:', error)
    next() // Continue without authentication
  }
}

module.exports = {
  auth,
  authorize,
  studentOnly,
  alumniOnly,
  optionalAuth
}
