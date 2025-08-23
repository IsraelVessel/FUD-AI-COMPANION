const { query, withTransaction } = require('../config/database')
const logger = require('../utils/logger')

class NotificationService {
  /**
   * Create a notification for a user
   * @param {Object} notificationData - Notification data
   * @param {string} notificationData.userId - User ID
   * @param {string} notificationData.title - Notification title
   * @param {string} notificationData.message - Notification message
   * @param {string} notificationData.type - Notification type
   * @param {string} notificationData.priority - Notification priority
   * @param {Object} notificationData.metadata - Additional metadata
   * @returns {Object} Created notification
   */
  async createNotification(notificationData) {
    try {
      const {
        userId,
        title,
        message,
        type = 'system',
        priority = 'normal',
        metadata = {}
      } = notificationData

      const result = await query(`
        INSERT INTO notifications (
          user_id, title, message, type, priority, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [userId, title, message, type, priority, JSON.stringify(metadata)])

      const notification = result.rows[0]

      logger.info('Notification created', {
        notificationId: notification.id,
        userId,
        type,
        priority
      })

      // Send real-time notification if needed
      await this.sendRealTimeNotification(notification)

      return notification

    } catch (error) {
      logger.error('Failed to create notification:', error)
      throw error
    }
  }

  /**
   * Create bulk notifications for multiple users
   * @param {Array} notifications - Array of notification objects
   * @returns {Array} Created notifications
   */
  async createBulkNotifications(notifications) {
    try {
      const createdNotifications = []

      await withTransaction(async (client) => {
        for (const notificationData of notifications) {
          const {
            userId,
            title,
            message,
            type = 'system',
            priority = 'normal',
            metadata = {}
          } = notificationData

          const result = await client.query(`
            INSERT INTO notifications (
              user_id, title, message, type, priority, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `, [userId, title, message, type, priority, JSON.stringify(metadata)])

          createdNotifications.push(result.rows[0])
        }
      })

      logger.info(`Created ${createdNotifications.length} bulk notifications`)

      // Send real-time notifications
      for (const notification of createdNotifications) {
        await this.sendRealTimeNotification(notification)
      }

      return createdNotifications

    } catch (error) {
      logger.error('Failed to create bulk notifications:', error)
      throw error
    }
  }

  /**
   * Get notifications for a user
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Object} Notifications with pagination info
   */
  async getUserNotifications(userId, options = {}) {
    try {
      const {
        type,
        unreadOnly = false,
        limit = 20,
        offset = 0,
        sortOrder = 'DESC'
      } = options

      let whereConditions = ['user_id = $1']
      let queryParams = [userId]
      let paramIndex = 2

      if (type) {
        whereConditions.push(`type = $${paramIndex++}`)
        queryParams.push(type)
      }

      if (unreadOnly) {
        whereConditions.push(`is_read = false`)
      }

      queryParams.push(limit, offset)

      const notificationsQuery = `
        SELECT 
          id, title, message, type, priority, is_read, read_at,
          metadata, created_at
        FROM notifications
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY created_at ${sortOrder}
        LIMIT $${paramIndex++} OFFSET $${paramIndex}
      `

      const notifications = await query(notificationsQuery, queryParams)

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM notifications
        WHERE ${whereConditions.join(' AND ')}
      `

      const countResult = await query(countQuery, queryParams.slice(0, -2))
      const totalCount = parseInt(countResult.rows[0].total)

      // Get unread count
      const unreadCountQuery = `
        SELECT COUNT(*) as unread_count
        FROM notifications
        WHERE user_id = $1 AND is_read = false
      `

      const unreadResult = await query(unreadCountQuery, [userId])
      const unreadCount = parseInt(unreadResult.rows[0].unread_count)

      return {
        notifications: notifications.rows,
        pagination: {
          totalCount,
          unreadCount,
          currentPage: Math.floor(offset / limit) + 1,
          totalPages: Math.ceil(totalCount / limit),
          hasMore: offset + limit < totalCount
        }
      }

    } catch (error) {
      logger.error('Failed to get user notifications:', error)
      throw error
    }
  }

  /**
   * Mark notification as read
   * @param {string} notificationId - Notification ID
   * @param {string} userId - User ID
   * @returns {Object} Updated notification
   */
  async markAsRead(notificationId, userId) {
    try {
      const result = await query(`
        UPDATE notifications
        SET is_read = true, read_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `, [notificationId, userId])

      if (result.rows.length === 0) {
        throw new Error('Notification not found or unauthorized')
      }

      logger.info('Notification marked as read', {
        notificationId,
        userId
      })

      return result.rows[0]

    } catch (error) {
      logger.error('Failed to mark notification as read:', error)
      throw error
    }
  }

  /**
   * Mark all notifications as read for a user
   * @param {string} userId - User ID
   * @param {string} type - Optional notification type filter
   * @returns {number} Number of notifications marked as read
   */
  async markAllAsRead(userId, type = null) {
    try {
      let updateQuery = `
        UPDATE notifications
        SET is_read = true, read_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND is_read = false
      `
      let queryParams = [userId]

      if (type) {
        updateQuery += ' AND type = $2'
        queryParams.push(type)
      }

      updateQuery += ' RETURNING id'

      const result = await query(updateQuery, queryParams)
      const markedCount = result.rows.length

      logger.info('Marked all notifications as read', {
        userId,
        type,
        count: markedCount
      })

      return markedCount

    } catch (error) {
      logger.error('Failed to mark all notifications as read:', error)
      throw error
    }
  }

  /**
   * Delete a notification
   * @param {string} notificationId - Notification ID
   * @param {string} userId - User ID
   * @returns {boolean} Success status
   */
  async deleteNotification(notificationId, userId) {
    try {
      const result = await query(`
        DELETE FROM notifications
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `, [notificationId, userId])

      if (result.rows.length === 0) {
        throw new Error('Notification not found or unauthorized')
      }

      logger.info('Notification deleted', {
        notificationId,
        userId
      })

      return true

    } catch (error) {
      logger.error('Failed to delete notification:', error)
      throw error
    }
  }

  /**
   * Send payment reminder notifications to students with overdue payments
   * @returns {number} Number of reminders sent
   */
  async sendPaymentReminders() {
    try {
      // Find students with overdue payments
      const overdueStudents = await query(`
        SELECT 
          s.id as student_id,
          s.user_id,
          s.first_name,
          s.last_name,
          sub.subscription_year,
          sub.amount,
          sub.due_date,
          u.email
        FROM students s
        JOIN users u ON s.user_id = u.id
        JOIN subscriptions sub ON s.id = sub.student_id
        WHERE 
          sub.payment_status = 'pending'
          AND sub.due_date < CURRENT_DATE
          AND s.academic_status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
            WHERE n.user_id = u.id 
            AND n.type = 'payment'
            AND n.created_at > CURRENT_DATE - INTERVAL '7 days'
          )
      `)

      let remindersSent = 0

      for (const student of overdueStudents.rows) {
        const daysOverdue = Math.floor(
          (new Date() - new Date(student.due_date)) / (1000 * 60 * 60 * 24)
        )

        await this.createNotification({
          userId: student.user_id,
          title: 'Payment Overdue - Action Required',
          message: `Dear ${student.first_name}, your subscription payment of ₦${student.amount} for ${student.subscription_year} is ${daysOverdue} days overdue. Please make payment to continue using the FUD AI Companion app.`,
          type: 'payment',
          priority: 'high',
          metadata: {
            subscriptionYear: student.subscription_year,
            amount: student.amount,
            daysOverdue,
            studentId: student.student_id
          }
        })

        remindersSent++
      }

      logger.info(`Sent ${remindersSent} payment reminder notifications`)
      return remindersSent

    } catch (error) {
      logger.error('Failed to send payment reminders:', error)
      throw error
    }
  }

  /**
   * Send system announcements to all active students
   * @param {Object} announcementData - Announcement data
   * @returns {number} Number of announcements sent
   */
  async sendSystemAnnouncement(announcementData) {
    try {
      const { title, message, priority = 'normal', metadata = {} } = announcementData

      // Get all active students
      const activeStudents = await query(`
        SELECT u.id as user_id
        FROM users u
        JOIN students s ON u.id = s.user_id
        WHERE s.academic_status = 'active' AND u.is_active = true
      `)

      const notifications = activeStudents.rows.map(student => ({
        userId: student.user_id,
        title,
        message,
        type: 'announcement',
        priority,
        metadata
      }))

      await this.createBulkNotifications(notifications)

      logger.info(`Sent system announcement to ${notifications.length} students`, {
        title,
        priority
      })

      return notifications.length

    } catch (error) {
      logger.error('Failed to send system announcement:', error)
      throw error
    }
  }

  /**
   * Send emergency notifications
   * @param {Object} emergencyData - Emergency notification data
   * @param {Array} targetUsers - Optional array of specific user IDs
   * @returns {number} Number of emergency notifications sent
   */
  async sendEmergencyNotification(emergencyData, targetUsers = null) {
    try {
      const { title, message, metadata = {} } = emergencyData

      let users
      if (targetUsers) {
        // Send to specific users
        users = targetUsers.map(userId => ({ user_id: userId }))
      } else {
        // Send to all active users
        users = await query(`
          SELECT u.id as user_id
          FROM users u
          WHERE u.is_active = true
        `)
        users = users.rows
      }

      const notifications = users.map(user => ({
        userId: user.user_id,
        title,
        message,
        type: 'emergency',
        priority: 'urgent',
        metadata
      }))

      await this.createBulkNotifications(notifications)

      logger.info(`Sent emergency notification to ${notifications.length} users`, {
        title,
        targetSpecific: !!targetUsers
      })

      return notifications.length

    } catch (error) {
      logger.error('Failed to send emergency notification:', error)
      throw error
    }
  }

  /**
   * Send real-time notification (placeholder for WebSocket/push notification integration)
   * @param {Object} notification - Notification object
   */
  async sendRealTimeNotification(notification) {
    try {
      // This would integrate with WebSocket server or push notification service
      // For now, just log the action
      logger.debug('Real-time notification sent', {
        notificationId: notification.id,
        userId: notification.user_id,
        type: notification.type,
        priority: notification.priority
      })

      // TODO: Implement WebSocket broadcast or push notification
      // Example integrations:
      // - Socket.io for web notifications
      // - Firebase Cloud Messaging for mobile push notifications
      // - SMS for urgent notifications

    } catch (error) {
      logger.error('Failed to send real-time notification:', error)
      // Don't throw error here to avoid affecting main notification creation
    }
  }

  /**
   * Get notification statistics for admin dashboard
   * @param {Object} filters - Optional filters
   * @returns {Object} Notification statistics
   */
  async getNotificationStatistics(filters = {}) {
    try {
      const { startDate, endDate, type } = filters

      let whereConditions = ['1=1']
      let queryParams = []
      let paramIndex = 1

      if (startDate) {
        whereConditions.push(`created_at >= $${paramIndex++}`)
        queryParams.push(startDate)
      }

      if (endDate) {
        whereConditions.push(`created_at <= $${paramIndex++}`)
        queryParams.push(endDate)
      }

      if (type) {
        whereConditions.push(`type = $${paramIndex++}`)
        queryParams.push(type)
      }

      const stats = await query(`
        SELECT 
          COUNT(*) as total_notifications,
          COUNT(*) FILTER (WHERE is_read = true) as read_notifications,
          COUNT(*) FILTER (WHERE is_read = false) as unread_notifications,
          COUNT(*) FILTER (WHERE priority = 'urgent') as urgent_notifications,
          COUNT(*) FILTER (WHERE priority = 'high') as high_priority_notifications,
          COUNT(*) FILTER (WHERE type = 'payment') as payment_notifications,
          COUNT(*) FILTER (WHERE type = 'emergency') as emergency_notifications,
          COUNT(*) FILTER (WHERE type = 'academic') as academic_notifications,
          COUNT(*) FILTER (WHERE type = 'system') as system_notifications,
          COUNT(*) FILTER (WHERE type = 'announcement') as announcement_notifications
        FROM notifications
        WHERE ${whereConditions.join(' AND ')}
      `, queryParams)

      const typeDistribution = await query(`
        SELECT 
          type,
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE is_read = true) as read_count,
          AVG(CASE WHEN read_at IS NOT NULL 
              THEN EXTRACT(EPOCH FROM (read_at - created_at)) 
              ELSE NULL END) as avg_read_time_seconds
        FROM notifications
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY type
        ORDER BY count DESC
      `, queryParams)

      const dailyTrends = await query(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as notifications_sent,
          COUNT(*) FILTER (WHERE is_read = true) as notifications_read
        FROM notifications
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
      `, queryParams)

      return {
        overall: stats.rows[0],
        byType: typeDistribution.rows,
        dailyTrends: dailyTrends.rows
      }

    } catch (error) {
      logger.error('Failed to get notification statistics:', error)
      throw error
    }
  }

  /**
   * Clean up old read notifications
   * @param {number} daysOld - Delete notifications older than this many days
   * @returns {number} Number of notifications deleted
   */
  async cleanupOldNotifications(daysOld = 30) {
    try {
      const result = await query(`
        DELETE FROM notifications
        WHERE is_read = true 
        AND read_at < CURRENT_DATE - INTERVAL '${daysOld} days'
        RETURNING id
      `)

      const deletedCount = result.rows.length

      logger.info(`Cleaned up ${deletedCount} old notifications older than ${daysOld} days`)

      return deletedCount

    } catch (error) {
      logger.error('Failed to cleanup old notifications:', error)
      throw error
    }
  }
}

module.exports = new NotificationService()
