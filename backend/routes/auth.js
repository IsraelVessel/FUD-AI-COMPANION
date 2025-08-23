const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { body, validationResult } = require('express-validator')
const rateLimit = require('express-rate-limit')

const { query, withTransaction } = require('../config/database')
const auth = require('../middleware/auth')
const logger = require('../utils/logger')
const { sendEmail } = require('../services/emailService')
const { generateToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt')

const router = express.Router()

// Rate limiting for authentication routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.',
    code: 'AUTH_RATE_LIMIT'
  },
  standardHeaders: true,
  legacyHeaders: false
})

/**
 * @route   POST /api/v1/auth/register
 * @desc    Register a new student
 * @access  Public
 */
router.post('/register', [
  authLimiter,
  // Validation middleware
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('studentId').isLength({ min: 5, max: 20 }).withMessage('Valid student ID is required'),
  body('firstName').trim().isLength({ min: 1 }).withMessage('First name is required'),
  body('lastName').trim().isLength({ min: 1 }).withMessage('Last name is required'),
  body('phone').optional().isMobilePhone().withMessage('Valid phone number is required')
], async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      })
    }

    const {
      email,
      password,
      studentId,
      firstName,
      lastName,
      middleName,
      phone,
      dateOfBirth,
      gender,
      departmentId
    } = req.body

    // Check if user already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    )
    
    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists',
        code: 'EMAIL_EXISTS'
      })
    }

    // Check if student ID already exists
    const existingStudent = await query(
      'SELECT id FROM students WHERE student_id = $1',
      [studentId]
    )
    
    if (existingStudent.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Student with this ID already exists',
        code: 'STUDENT_ID_EXISTS'
      })
    }

    // Create user with transaction
    const result = await withTransaction(async (client) => {
      // Hash password
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12
      const passwordHash = await bcrypt.hash(password, saltRounds)

      // Create user
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, role, is_active, email_verified)
         VALUES ($1, $2, 'student', true, false)
         RETURNING id, email, role, created_at`,
        [email, passwordHash]
      )

      const user = userResult.rows[0]

      // Create student profile
      const studentResult = await client.query(
        `INSERT INTO students (
          user_id, student_id, first_name, last_name, middle_name,
          phone, date_of_birth, gender, enrollment_date, academic_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE, 'active')
        RETURNING id, student_id, first_name, last_name, enrollment_date`,
        [user.id, studentId, firstName, lastName, middleName, phone, dateOfBirth, gender]
      )

      const student = studentResult.rows[0]

      // Create student academic record if department is provided
      if (departmentId) {
        await client.query(
          `INSERT INTO student_academics (student_id, department_id, current_level)
           VALUES ($1, $2, 100)`,
          [student.id, departmentId]
        )
      }

      return { user, student }
    })

    // Generate tokens
    const token = generateToken({ userId: result.user.id, role: result.user.role })
    const refreshToken = generateRefreshToken({ userId: result.user.id })

    // Log successful registration
    logger.info('Student registered successfully', {
      userId: result.user.id,
      studentId: result.student.student_id,
      email: result.user.email
    })

    // Send welcome email (async, don't wait for it)
    sendEmail({
      to: email,
      subject: 'Welcome to FUD AI Companion',
      template: 'welcome',
      data: {
        firstName,
        studentId: result.student.student_id
      }
    }).catch(error => {
      logger.error('Failed to send welcome email:', error)
    })

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role
        },
        student: {
          id: result.student.id,
          studentId: result.student.student_id,
          firstName: result.student.first_name,
          lastName: result.student.last_name,
          enrollmentDate: result.student.enrollment_date
        },
        tokens: {
          accessToken: token,
          refreshToken
        }
      }
    })

  } catch (error) {
    logger.error('Registration error:', error)
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    })
  }
})

/**
 * @route   POST /api/v1/auth/login
 * @desc    Login user
 * @access  Public
 */
router.post('/login', [
  authLimiter,
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 1 }).withMessage('Password is required')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      })
    }

    const { email, password } = req.body

    // Get user with student details
    const userResult = await query(`
      SELECT 
        u.id, u.email, u.password_hash, u.role, u.is_active, u.email_verified,
        s.id as student_id, s.student_id as student_number, s.first_name, s.last_name,
        s.academic_status, s.profile_picture_url
      FROM users u
      LEFT JOIN students s ON u.id = s.user_id
      WHERE u.email = $1
    `, [email])

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS'
      })
    }

    const user = userResult.rows[0]

    // Check if account is active
    if (!user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated',
        code: 'ACCOUNT_DEACTIVATED'
      })
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash)
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS'
      })
    }

    // Update last login
    await query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    )

    // Generate tokens
    const token = generateToken({ userId: user.id, role: user.role })
    const refreshToken = generateRefreshToken({ userId: user.id })

    logger.info('User logged in successfully', {
      userId: user.id,
      email: user.email,
      role: user.role
    })

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          emailVerified: user.email_verified
        },
        profile: user.role === 'student' ? {
          studentId: user.student_id,
          studentNumber: user.student_number,
          firstName: user.first_name,
          lastName: user.last_name,
          academicStatus: user.academic_status,
          profilePicture: user.profile_picture_url
        } : null,
        tokens: {
          accessToken: token,
          refreshToken
        }
      }
    })

  } catch (error) {
    logger.error('Login error:', error)
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    })
  }
})

/**
 * @route   POST /api/v1/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post('/refresh', [
  body('refreshToken').notEmpty().withMessage('Refresh token is required')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      })
    }

    const { refreshToken } = req.body

    // Verify refresh token
    const decoded = verifyRefreshToken(refreshToken)
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN'
      })
    }

    // Get user details
    const userResult = await query(
      'SELECT id, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    )

    if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
      return res.status(401).json({
        success: false,
        message: 'User not found or inactive',
        code: 'USER_NOT_FOUND'
      })
    }

    const user = userResult.rows[0]

    // Generate new access token
    const newAccessToken = generateToken({ userId: user.id, role: user.role })

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        accessToken: newAccessToken
      }
    })

  } catch (error) {
    logger.error('Token refresh error:', error)
    res.status(500).json({
      success: false,
      message: 'Token refresh failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    })
  }
})

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout user
 * @access  Private
 */
router.post('/logout', auth, async (req, res) => {
  try {
    // In a more sophisticated setup, you would blacklist the token
    // For now, we just send a success response
    logger.info('User logged out', { userId: req.user.id })

    res.json({
      success: true,
      message: 'Logged out successfully'
    })

  } catch (error) {
    logger.error('Logout error:', error)
    res.status(500).json({
      success: false,
      message: 'Logout failed'
    })
  }
})

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get current user profile
 * @access  Private
 */
router.get('/me', auth, async (req, res) => {
  try {
    const userResult = await query(`
      SELECT 
        u.id, u.email, u.role, u.is_active, u.email_verified, u.last_login, u.created_at,
        s.id as student_id, s.student_id as student_number, s.first_name, s.last_name,
        s.middle_name, s.phone, s.date_of_birth, s.gender, s.academic_status,
        s.profile_picture_url, s.enrollment_date,
        sa.current_level, sa.cgpa, sa.total_credit_units,
        d.name as department_name, f.name as faculty_name
      FROM users u
      LEFT JOIN students s ON u.id = s.user_id
      LEFT JOIN student_academics sa ON s.id = sa.student_id
      LEFT JOIN departments d ON sa.department_id = d.id
      LEFT JOIN faculties f ON d.faculty_id = f.id
      WHERE u.id = $1
    `, [req.user.id])

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      })
    }

    const user = userResult.rows[0]

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          isActive: user.is_active,
          emailVerified: user.email_verified,
          lastLogin: user.last_login,
          createdAt: user.created_at
        },
        profile: user.role === 'student' ? {
          studentId: user.student_id,
          studentNumber: user.student_number,
          firstName: user.first_name,
          lastName: user.last_name,
          middleName: user.middle_name,
          phone: user.phone,
          dateOfBirth: user.date_of_birth,
          gender: user.gender,
          academicStatus: user.academic_status,
          profilePicture: user.profile_picture_url,
          enrollmentDate: user.enrollment_date,
          currentLevel: user.current_level,
          cgpa: user.cgpa,
          totalCreditUnits: user.total_credit_units,
          department: user.department_name,
          faculty: user.faculty_name
        } : null
      }
    })

  } catch (error) {
    logger.error('Get profile error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get profile'
    })
  }
})

module.exports = router
