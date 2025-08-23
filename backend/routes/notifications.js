const express = require('express')
const { body, validationResult, query: queryValidator } = require('express-validator')

const { auth, authorize } = require('../middleware/auth')
const NotificationService = require('../services/notificationService')
const logger = require('../utils/logger')

const router = express.Router()

/**
 * @route   GET /api/v1/notifications
 * @desc    Get user notifications
 * @access  Private
 */
router.get('/', [
  auth,
  queryValidator('type').optional().isIn(['payment', 'academic', 'emergency', 'system', 'announcement']),
  queryValidator('unreadOnly').optional().isBoolean(),
  queryValidator('limit').optional().isInt({ min: 1, max: 100 }),
  queryValidator('offset').optional().isInt({ min: 0 })
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
      type,
      unreadOnly = false,
      limit = 20,
      offset = 0
    } = req.query

    const notifications = await NotificationService.getUserNotifications(
      req.user.id,
      {
        type,
        unreadOnly: unreadOnly === 'true',
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    )

    res.json({
      success: true,
      data: notifications
    })

  } catch (error) {
    logger.error('Get notifications error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get notifications'
    })
  }
})

/**
 * @route   PUT /api/v1/notifications/:id/read
 * @desc    Mark notification as read
 * @access  Private
 */
router.put('/:id/read', [auth], async (req, res) => {
  try {
    const { id } = req.params

    const notification = await NotificationService.markAsRead(id, req.user.id)

    res.json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    })

  } catch (error) {
    logger.error('Mark notification as read error:', error)
    
    if (error.message.includes('not found') || error.message.includes('unauthorized')) {
      return res.status(404).json({
        success: false,
        message: error.message
      })
    }

    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read'
    })
  }
})

/**
 * @route   PUT /api/v1/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Private
 */
router.put('/read-all', [
  auth,
  body('type').optional().isIn(['payment', 'academic', 'emergency', 'system', 'announcement'])
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

    const { type } = req.body

    const markedCount = await NotificationService.markAllAsRead(req.user.id, type)

    res.json({
      success: true,
      message: `${markedCount} notifications marked as read`,
      data: {
        markedCount
      }
    })

  } catch (error) {
    logger.error('Mark all notifications as read error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to mark all notifications as read'
    })
  }
})

/**
 * @route   DELETE /api/v1/notifications/:id
 * @desc    Delete a notification
 * @access  Private
 */
router.delete('/:id', [auth], async (req, res) => {
  try {
    const { id } = req.params

    await NotificationService.deleteNotification(id, req.user.id)

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    })

  } catch (error) {
    logger.error('Delete notification error:', error)
    
    if (error.message.includes('not found') || error.message.includes('unauthorized')) {
      return res.status(404).json({
        success: false,
        message: error.message
      })
    }

    res.status(500).json({
      success: false,
      message: 'Failed to delete notification'
    })
  }
})

/**
 * @route   POST /api/v1/notifications/announcement
 * @desc    Send system announcement (Admin only)
 * @access  Private (Admin only)
 */
router.post('/announcement', [
  auth,
  authorize(['admin', 'staff']),
  body('title').trim().isLength({ min: 1, max: 300 }).withMessage('Title is required and must be under 300 characters'),
  body('message').trim().isLength({ min: 1 }).withMessage('Message is required'),
  body('priority').optional().isIn(['low', 'normal', 'high', 'urgent']).withMessage('Invalid priority')
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

    const { title, message, priority = 'normal', metadata = {} } = req.body

    const sentCount = await NotificationService.sendSystemAnnouncement({
      title,
      message,
      priority,
      metadata: {
        ...metadata,
        sentBy: req.user.id,
        sentByRole: req.user.role
      }
    })

    res.json({
      success: true,
      message: `System announcement sent to ${sentCount} users`,
      data: {
        sentCount
      }
    })

  } catch (error) {
    logger.error('Send announcement error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to send announcement'
    })
  }
})

/**
 * @route   POST /api/v1/notifications/emergency
 * @desc    Send emergency notification (Admin only)
 * @access  Private (Admin only)
 */
router.post('/emergency', [
  auth,
  authorize(['admin']),
  body('title').trim().isLength({ min: 1, max: 300 }).withMessage('Title is required and must be under 300 characters'),
  body('message').trim().isLength({ min: 1 }).withMessage('Message is required'),
  body('targetUsers').optional().isArray().withMessage('Target users must be an array')
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

    const { title, message, targetUsers, metadata = {} } = req.body

    const sentCount = await NotificationService.sendEmergencyNotification(
      {
        title,
        message,
        metadata: {
          ...metadata,
          sentBy: req.user.id,
          emergency: true
        }
      },
      targetUsers
    )

    res.json({
      success: true,
      message: `Emergency notification sent to ${sentCount} users`,
      data: {
        sentCount,
        targetSpecific: !!targetUsers
      }
    })

  } catch (error) {
    logger.error('Send emergency notification error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to send emergency notification'
    })
  }
})

/**
 * @route   GET /api/v1/notifications/statistics
 * @desc    Get notification statistics (Admin only)
 * @access  Private (Admin only)
 */
router.get('/statistics', [
  auth,
  authorize(['admin', 'staff']),
  queryValidator('startDate').optional().isISO8601(),
  queryValidator('endDate').optional().isISO8601(),
  queryValidator('type').optional().isIn(['payment', 'academic', 'emergency', 'system', 'announcement'])
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

    const { startDate, endDate, type } = req.query

    const statistics = await NotificationService.getNotificationStatistics({
      startDate,
      endDate,
      type
    })

    res.json({
      success: true,
      data: statistics
    })

  } catch (error) {
    logger.error('Get notification statistics error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get notification statistics'
    })
  }
})

/**
 * @route   POST /api/v1/notifications/cleanup
 * @desc    Clean up old notifications (Admin only)
 * @access  Private (Admin only)
 */
router.post('/cleanup', [
  auth,
  authorize(['admin']),
  body('daysOld').optional().isInt({ min: 1, max: 365 }).withMessage('Days old must be between 1 and 365')
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

    const { daysOld = 30 } = req.body

    const deletedCount = await NotificationService.cleanupOldNotifications(daysOld)

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} old notifications`,
      data: {
        deletedCount,
        daysOld
      }
    })

  } catch (error) {
    logger.error('Cleanup notifications error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to cleanup notifications'
    })
  }
})

module.exports = router
