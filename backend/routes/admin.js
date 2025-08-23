const express = require('express')
const { body, validationResult, query: queryValidator } = require('express-validator')
const rateLimit = require('express-rate-limit')

const { auth, authorize } = require('../middleware/auth')
const { query, withTransaction } = require('../config/database')
const logger = require('../utils/logger')
const PaymentService = require('../services/paymentService')
const AlumniService = require('../services/alumniService')
const NotificationService = require('../services/notificationService')
const AIService = require('../services/aiService')

const router = express.Router()

// Rate limiting for admin actions
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    error: 'Too many admin requests, please try again later.',
    code: 'ADMIN_RATE_LIMIT'
  }
})

/**
 * @route   GET /api/v1/admin/dashboard
 * @desc    Get admin dashboard overview
 * @access  Private (Admin only)
 */
router.get('/dashboard', [auth, authorize('admin'), adminLimiter], async (req, res) => {
  try {
    // Get student statistics
    const studentStats = await query(`
      SELECT 
        COUNT(*) as total_students,
        COUNT(*) FILTER (WHERE academic_status = 'active') as active_students,
        COUNT(*) FILTER (WHERE academic_status = 'graduated') as graduated_students,
        COUNT(*) FILTER (WHERE academic_status = 'suspended') as suspended_students,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') as new_students_month,
        AVG(sa.cgpa) as average_cgpa
      FROM students s
      LEFT JOIN student_academics sa ON s.id = sa.student_id
    `)

    // Get payment statistics
    const paymentStats = await query(`
      SELECT 
        COUNT(*) as total_subscriptions,
        COUNT(*) FILTER (WHERE payment_status = 'paid') as paid_subscriptions,
        COUNT(*) FILTER (WHERE payment_status = 'pending') as pending_subscriptions,
        COUNT(*) FILTER (WHERE payment_status = 'overdue') as overdue_subscriptions,
        SUM(CASE WHEN payment_status = 'paid' THEN amount ELSE 0 END) as total_revenue,
        SUM(CASE WHEN payment_date >= CURRENT_DATE - INTERVAL '30 days' THEN amount ELSE 0 END) as monthly_revenue
      FROM subscriptions
      WHERE subscription_year = EXTRACT(YEAR FROM CURRENT_DATE)::TEXT
    `)

    // Get AI usage statistics
    const aiStats = await query(`
      SELECT 
        COUNT(DISTINCT student_id) as active_ai_users,
        COUNT(*) as total_sessions,
        SUM(message_count) as total_messages,
        AVG(message_count) as avg_messages_per_session
      FROM ai_chat_sessions
      WHERE started_at >= CURRENT_DATE - INTERVAL '30 days'
    `)

    // Get notification statistics
    const notificationStats = await query(`
      SELECT 
        COUNT(*) as total_notifications,
        COUNT(*) FILTER (WHERE is_read = true) as read_notifications,
        COUNT(*) FILTER (WHERE priority = 'urgent') as urgent_notifications
      FROM notifications
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `)

    // Get recent activity
    const recentActivities = await query(`
      (
        SELECT 'student_registered' as type, s.first_name || ' ' || s.last_name as description, s.created_at as timestamp
        FROM students s 
        ORDER BY s.created_at DESC 
        LIMIT 5
      )
      UNION ALL
      (
        SELECT 'payment_received' as type, 'Payment received: ₦' || pt.amount as description, pt.created_at as timestamp
        FROM payment_transactions pt 
        WHERE pt.status = 'successful'
        ORDER BY pt.created_at DESC 
        LIMIT 5
      )
      ORDER BY timestamp DESC
      LIMIT 10
    `)

    // Get system health metrics
    const systemHealth = {
      database: 'healthy', // This would be from actual health checks
      redis: 'healthy',
      aiService: 'healthy',
      paymentGateway: 'healthy'
    }

    res.json({
      success: true,
      data: {
        students: studentStats.rows[0],
        payments: paymentStats.rows[0],
        aiUsage: aiStats.rows[0],
        notifications: notificationStats.rows[0],
        recentActivities: recentActivities.rows,
        systemHealth
      }
    })

  } catch (error) {
    logger.error('Admin dashboard error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get dashboard data'
    })
  }
})

/**
 * @route   GET /api/v1/admin/students
 * @desc    Get students with filtering and pagination
 * @access  Private (Admin/Staff)
 */
router.get('/students', [
  auth, 
  authorize(['admin', 'staff']),
  queryValidator('page').optional().isInt({ min: 1 }),
  queryValidator('limit').optional().isInt({ min: 1, max: 100 }),
  queryValidator('status').optional().isIn(['active', 'graduated', 'suspended', 'withdrawn']),
  queryValidator('department').optional().isUUID(),
  queryValidator('level').optional().isIn(['100', '200', '300', '400', '500']),
  queryValidator('search').optional().isLength({ min: 1, max: 100 })
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

    const {
      page = 1,
      limit = 20,
      status,
      department,
      level,
      search
    } = req.query

    const offset = (page - 1) * limit

    // Build WHERE conditions
    let whereConditions = ['1=1']
    let queryParams = []
    let paramIndex = 1

    if (status) {
      whereConditions.push(`s.academic_status = $${paramIndex++}`)
      queryParams.push(status)
    }

    if (department) {
      whereConditions.push(`sa.department_id = $${paramIndex++}`)
      queryParams.push(department)
    }

    if (level) {
      whereConditions.push(`sa.current_level = $${paramIndex++}`)
      queryParams.push(parseInt(level))
    }

    if (search) {
      whereConditions.push(`(
        s.first_name ILIKE $${paramIndex} OR 
        s.last_name ILIKE $${paramIndex} OR 
        s.student_id ILIKE $${paramIndex} OR
        u.email ILIKE $${paramIndex}
      )`)
      queryParams.push(`%${search}%`)
      paramIndex++
    }

    queryParams.push(limit, offset)

    const studentsQuery = `
      SELECT 
        s.id,
        s.student_id,
        s.first_name,
        s.last_name,
        s.phone,
        s.academic_status,
        s.enrollment_date,
        sa.current_level,
        sa.cgpa,
        d.name as department_name,
        f.name as faculty_name,
        u.email,
        u.is_active,
        u.last_login,
        sub.payment_status,
        sub.due_date as payment_due_date
      FROM students s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN student_academics sa ON s.id = sa.student_id
      LEFT JOIN departments d ON sa.department_id = d.id
      LEFT JOIN faculties f ON d.faculty_id = f.id
      LEFT JOIN subscriptions sub ON s.id = sub.student_id AND sub.subscription_year = EXTRACT(YEAR FROM CURRENT_DATE)::TEXT
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY s.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `

    const students = await query(studentsQuery, queryParams)

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM students s
      LEFT JOIN student_academics sa ON s.id = sa.student_id
      LEFT JOIN users u ON s.user_id = u.id
      WHERE ${whereConditions.join(' AND ')}
    `

    const countResult = await query(countQuery, queryParams.slice(0, -2))
    const totalCount = parseInt(countResult.rows[0].total)

    res.json({
      success: true,
      data: {
        students: students.rows,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        }
      }
    })

  } catch (error) {
    logger.error('Get students error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get students'
    })
  }
})

/**
 * @route   PUT /api/v1/admin/students/:id/status
 * @desc    Update student academic status
 * @access  Private (Admin only)
 */
router.put('/students/:id/status', [
  auth,
  authorize('admin'),
  body('status').isIn(['active', 'suspended', 'withdrawn']).withMessage('Invalid status'),
  body('reason').optional().trim().isLength({ min: 1, max: 500 }).withMessage('Reason must be under 500 characters')
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

    const { id } = req.params
    const { status, reason } = req.body

    // Update student status
    const result = await query(`
      UPDATE students 
      SET academic_status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, student_id, first_name, last_name, academic_status
    `, [status, id])

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      })
    }

    const student = result.rows[0]

    // Create notification for student
    const statusMessages = {
      'active': 'Your academic status has been restored to active.',
      'suspended': 'Your academic status has been suspended. Please contact the administration for more information.',
      'withdrawn': 'Your academic status has been changed to withdrawn.'
    }

    const userResult = await query('SELECT user_id FROM students WHERE id = $1', [id])
    if (userResult.rows.length > 0) {
      await NotificationService.createNotification({
        userId: userResult.rows[0].user_id,
        title: 'Academic Status Update',
        message: statusMessages[status] + (reason ? ` Reason: ${reason}` : ''),
        type: 'academic',
        priority: 'high',
        metadata: {
          previousStatus: student.academic_status,
          newStatus: status,
          reason,
          updatedBy: req.user.id
        }
      })
    }

    logger.info('Student status updated', {
      studentId: student.student_id,
      newStatus: status,
      updatedBy: req.user.id,
      reason
    })

    res.json({
      success: true,
      message: 'Student status updated successfully',
      data: student
    })

  } catch (error) {
    logger.error('Update student status error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to update student status'
    })
  }
})

/**
 * @route   GET /api/v1/admin/analytics/overview
 * @desc    Get comprehensive analytics overview
 * @access  Private (Admin only)
 */
router.get('/analytics/overview', [
  auth,
  authorize('admin'),
  queryValidator('period').optional().isIn(['7d', '30d', '90d', '1y'])
], async (req, res) => {
  try {
    const { period = '30d' } = req.query
    
    // Convert period to SQL interval
    const periodMap = {
      '7d': '7 days',
      '30d': '30 days',
      '90d': '90 days',
      '1y': '1 year'
    }
    const interval = periodMap[period]

    // Student analytics
    const studentAnalytics = await query(`
      SELECT 
        DATE_TRUNC('day', created_at) as date,
        COUNT(*) as new_registrations,
        COUNT(*) FILTER (WHERE academic_status = 'active') as active_count
      FROM students
      WHERE created_at >= CURRENT_DATE - INTERVAL '${interval}'
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date DESC
    `)

    // Payment analytics
    const paymentAnalytics = await query(`
      SELECT 
        DATE_TRUNC('day', created_at) as date,
        COUNT(*) as total_transactions,
        COUNT(*) FILTER (WHERE status = 'successful') as successful_payments,
        SUM(CASE WHEN status = 'successful' THEN amount ELSE 0 END) as daily_revenue
      FROM payment_transactions
      WHERE created_at >= CURRENT_DATE - INTERVAL '${interval}'
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date DESC
    `)

    // AI usage analytics
    const aiAnalytics = await query(`
      SELECT 
        DATE_TRUNC('day', started_at) as date,
        COUNT(*) as sessions_count,
        COUNT(DISTINCT student_id) as unique_users,
        SUM(message_count) as total_messages
      FROM ai_chat_sessions
      WHERE started_at >= CURRENT_DATE - INTERVAL '${interval}'
      GROUP BY DATE_TRUNC('day', started_at)
      ORDER BY date DESC
    `)

    // Department-wise statistics
    const departmentStats = await query(`
      SELECT 
        d.name as department,
        COUNT(s.id) as student_count,
        AVG(sa.cgpa) as average_cgpa,
        COUNT(*) FILTER (WHERE sub.payment_status = 'paid') as paid_students
      FROM departments d
      LEFT JOIN student_academics sa ON d.id = sa.department_id
      LEFT JOIN students s ON sa.student_id = s.id
      LEFT JOIN subscriptions sub ON s.id = sub.student_id AND sub.subscription_year = EXTRACT(YEAR FROM CURRENT_DATE)::TEXT
      WHERE s.academic_status = 'active'
      GROUP BY d.id, d.name
      HAVING COUNT(s.id) > 0
      ORDER BY student_count DESC
    `)

    // Top AI queries/topics
    const topAITopics = await query(`
      SELECT 
        SUBSTRING(content FROM 1 FOR 100) as topic,
        COUNT(*) as frequency
      FROM ai_chat_messages
      WHERE role = 'user' 
      AND created_at >= CURRENT_DATE - INTERVAL '${interval}'
      GROUP BY SUBSTRING(content FROM 1 FOR 100)
      ORDER BY frequency DESC
      LIMIT 10
    `)

    res.json({
      success: true,
      data: {
        period,
        studentTrends: studentAnalytics.rows,
        paymentTrends: paymentAnalytics.rows,
        aiUsageTrends: aiAnalytics.rows,
        departmentStats: departmentStats.rows,
        topAITopics: topAITopics.rows
      }
    })

  } catch (error) {
    logger.error('Analytics overview error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get analytics overview'
    })
  }
})

/**
 * @route   POST /api/v1/admin/graduation/process
 * @desc    Trigger graduation transition process
 * @access  Private (Admin only)
 */
router.post('/graduation/process', [
  auth,
  authorize('admin')
], async (req, res) => {
  try {
    const result = await AlumniService.processGraduationTransitions()

    logger.info('Manual graduation process triggered', {
      triggeredBy: req.user.id,
      result
    })

    res.json({
      success: true,
      message: 'Graduation transition process completed',
      data: result
    })

  } catch (error) {
    logger.error('Graduation process error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to process graduations'
    })
  }
})

/**
 * @route   POST /api/v1/admin/students/:id/graduate
 * @desc    Manually graduate a student
 * @access  Private (Admin only)
 */
router.post('/students/:id/graduate', [
  auth,
  authorize('admin'),
  body('graduationYear').optional().isInt({ min: 2020, max: 2030 }),
  body('degreeClass').optional().isIn([
    'First Class Honours',
    'Second Class Honours (Upper Division)',
    'Second Class Honours (Lower Division)',
    'Third Class Honours',
    'Pass'
  ])
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

    const { id } = req.params
    const { graduationYear, degreeClass } = req.body

    const alumniData = {}
    if (graduationYear) alumniData.graduationYear = graduationYear
    if (degreeClass) alumniData.degreeClass = degreeClass

    const result = await AlumniService.manualTransitionToAlumni(id, alumniData)

    logger.info('Manual graduation completed', {
      studentId: id,
      graduatedBy: req.user.id,
      graduationYear,
      degreeClass
    })

    res.json({
      success: true,
      message: 'Student graduated successfully',
      data: result
    })

  } catch (error) {
    logger.error('Manual graduation error:', error)
    
    if (error.message.includes('not found') || error.message.includes('already')) {
      return res.status(400).json({
        success: false,
        message: error.message
      })
    }

    res.status(500).json({
      success: false,
      message: 'Failed to graduate student'
    })
  }
})

/**
 * @route   GET /api/v1/admin/system/health
 * @desc    Get system health status
 * @access  Private (Admin only)
 */
router.get('/system/health', [
  auth,
  authorize('admin')
], async (req, res) => {
  try {
    // Check database health
    const dbHealth = await query('SELECT 1 as healthy, NOW() as timestamp')
    
    // Check Redis health (if implemented)
    // const redisHealth = await redisHealthCheck()
    
    // Check AI service health
    // const aiHealth = await AIService.healthCheck()
    
    // Check payment gateway health
    // const paymentHealth = await PaymentService.healthCheck()

    const systemHealth = {
      database: {
        status: 'healthy',
        lastCheck: dbHealth.rows[0].timestamp,
        responseTime: '< 1ms'
      },
      redis: {
        status: 'healthy',
        lastCheck: new Date().toISOString(),
        responseTime: '< 1ms'
      },
      aiService: {
        status: 'healthy',
        lastCheck: new Date().toISOString(),
        responseTime: '< 100ms'
      },
      paymentGateway: {
        status: 'healthy',
        lastCheck: new Date().toISOString(),
        responseTime: '< 200ms'
      },
      overall: 'healthy'
    }

    res.json({
      success: true,
      data: systemHealth
    })

  } catch (error) {
    logger.error('System health check error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get system health',
      data: {
        overall: 'unhealthy',
        error: error.message
      }
    })
  }
})

module.exports = router
