const express = require('express')
const { body, validationResult } = require('express-validator')
const rateLimit = require('express-rate-limit')

const { auth, studentOnly } = require('../middleware/auth')
const PaymentService = require('../services/paymentService')
const logger = require('../utils/logger')

const router = express.Router()

// Rate limiting for payment endpoints
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 payment attempts per window
  message: {
    error: 'Too many payment attempts, please try again later.',
    code: 'PAYMENT_RATE_LIMIT'
  }
})

/**
 * @route   GET /api/v1/payments/subscription
 * @desc    Get current subscription status
 * @access  Private (Students only)
 */
router.get('/subscription', [auth, studentOnly], async (req, res) => {
  try {
    const { year } = req.query
    const subscriptionStatus = await PaymentService.getSubscriptionStatus(
      req.student.id,
      year
    )

    res.json({
      success: true,
      data: subscriptionStatus
    })

  } catch (error) {
    logger.error('Get subscription status error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get subscription status'
    })
  }
})

/**
 * @route   POST /api/v1/payments/initialize
 * @desc    Initialize payment for subscription
 * @access  Private (Students only)
 */
router.post('/initialize', [
  auth,
  studentOnly,
  paymentLimiter,
  body('subscriptionYear')
    .isLength({ min: 4, max: 4 })
    .isNumeric()
    .withMessage('Valid subscription year is required')
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

    const { subscriptionYear } = req.body
    const amount = 5000 // ₦5,000
    const amountInKobo = amount * 100 // Convert to kobo

    // Get student email
    const { query } = require('../config/database')
    const userResult = await query(
      'SELECT email FROM users WHERE id = $1',
      [req.user.id]
    )

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      })
    }

    const email = userResult.rows[0].email

    // Initialize payment
    const paymentResult = await PaymentService.initializePayment({
      studentId: req.student.id,
      email,
      amount: amountInKobo,
      subscriptionYear
    })

    res.json({
      success: true,
      message: 'Payment initialized successfully',
      data: paymentResult.data
    })

  } catch (error) {
    logger.error('Payment initialization error:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initialize payment'
    })
  }
})

/**
 * @route   POST /api/v1/payments/verify
 * @desc    Verify payment transaction
 * @access  Private (Students only)
 */
router.post('/verify', [
  auth,
  studentOnly,
  body('reference').notEmpty().withMessage('Payment reference is required')
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

    const { reference } = req.body

    const verificationResult = await PaymentService.verifyPayment(reference)

    res.json({
      success: true,
      message: 'Payment verified successfully',
      data: verificationResult.data
    })

  } catch (error) {
    logger.error('Payment verification error:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to verify payment'
    })
  }
})

/**
 * @route   GET /api/v1/payments/history
 * @desc    Get payment history
 * @access  Private (Students only)
 */
router.get('/history', [auth, studentOnly], async (req, res) => {
  try {
    const { limit = 10 } = req.query
    const paymentHistory = await PaymentService.getPaymentHistory(
      req.student.id,
      parseInt(limit)
    )

    res.json({
      success: true,
      data: {
        payments: paymentHistory,
        totalRecords: paymentHistory.length
      }
    })

  } catch (error) {
    logger.error('Get payment history error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get payment history'
    })
  }
})

/**
 * @route   POST /api/v1/payments/webhook
 * @desc    Handle Paystack webhook
 * @access  Public (Webhook only)
 */
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature']
    const payload = req.body

    const webhookResult = await PaymentService.handleWebhook(payload, signature)

    if (webhookResult) {
      res.status(200).json({ success: true })
    } else {
      res.status(400).json({ success: false, message: 'Webhook processing failed' })
    }

  } catch (error) {
    logger.error('Webhook handling error:', error)
    res.status(500).json({
      success: false,
      message: 'Webhook processing failed'
    })
  }
})

/**
 * @route   POST /api/v1/payments/reminder
 * @desc    Send payment reminder (Admin only)
 * @access  Private (Admin/Staff only)
 */
router.post('/reminder', [
  auth,
  body('studentId').isUUID().withMessage('Valid student ID is required')
], async (req, res) => {
  try {
    // Check if user has permission to send reminders
    if (!['admin', 'staff'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      })
    }

    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      })
    }

    const { studentId } = req.body
    const reminderSent = await PaymentService.sendPaymentReminder(studentId)

    if (reminderSent) {
      res.json({
        success: true,
        message: 'Payment reminder sent successfully'
      })
    } else {
      res.json({
        success: false,
        message: 'Payment reminder not sent - student may have already paid'
      })
    }

  } catch (error) {
    logger.error('Send payment reminder error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to send payment reminder'
    })
  }
})

module.exports = router
