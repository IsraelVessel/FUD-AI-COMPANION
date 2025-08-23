const axios = require('axios')
const crypto = require('crypto')
const logger = require('../utils/logger')
const { query, withTransaction } = require('../config/database')

class PaymentService {
  constructor() {
    this.secretKey = process.env.PAYSTACK_SECRET_KEY
    this.publicKey = process.env.PAYSTACK_PUBLIC_KEY
    this.webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET
    this.baseURL = 'https://api.paystack.co'
    
    if (!this.secretKey) {
      throw new Error('PAYSTACK_SECRET_KEY is required')
    }
  }

  /**
   * Initialize payment transaction
   * @param {Object} params - Payment parameters
   * @param {string} params.studentId - Student ID
   * @param {string} params.email - Student email
   * @param {number} params.amount - Amount in kobo (NGN * 100)
   * @param {string} params.subscriptionYear - Subscription year
   * @returns {Object} Payment initialization response
   */
  async initializePayment({ studentId, email, amount, subscriptionYear }) {
    try {
      // Create subscription record
      const subscription = await this.createSubscription(studentId, subscriptionYear, amount / 100)
      
      // Generate payment reference
      const reference = this.generateReference(studentId, subscriptionYear)
      
      // Paystack initialization payload
      const payload = {
        email,
        amount, // Amount in kobo
        reference,
        callback_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/callback`,
        metadata: {
          student_id: studentId,
          subscription_id: subscription.id,
          subscription_year: subscriptionYear,
          custom_fields: [
            {
              display_name: 'Student ID',
              variable_name: 'student_id',
              value: studentId
            },
            {
              display_name: 'Subscription Year',
              variable_name: 'subscription_year', 
              value: subscriptionYear
            }
          ]
        },
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer']
      }

      const response = await axios.post(
        `${this.baseURL}/transaction/initialize`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
          }
        }
      )

      if (!response.data.status) {
        throw new Error(`Paystack error: ${response.data.message}`)
      }

      // Save transaction record
      await this.createTransaction({
        subscriptionId: subscription.id,
        reference,
        amount: amount / 100,
        paystackReference: response.data.data.reference,
        accessCode: response.data.data.access_code
      })

      logger.info('Payment initialized successfully', {
        studentId,
        reference,
        amount,
        subscriptionYear
      })

      return {
        success: true,
        data: {
          authorizationUrl: response.data.data.authorization_url,
          accessCode: response.data.data.access_code,
          reference: response.data.data.reference,
          subscriptionId: subscription.id
        }
      }

    } catch (error) {
      logger.error('Payment initialization failed:', error)
      throw new Error(`Payment initialization failed: ${error.message}`)
    }
  }

  /**
   * Verify payment transaction
   * @param {string} reference - Payment reference
   * @returns {Object} Verification response
   */
  async verifyPayment(reference) {
    try {
      const response = await axios.get(
        `${this.baseURL}/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${this.secretKey}`
          }
        }
      )

      if (!response.data.status) {
        throw new Error(`Verification failed: ${response.data.message}`)
      }

      const transaction = response.data.data
      
      // Update local transaction record
      await this.updateTransactionStatus(reference, transaction)

      logger.info('Payment verified successfully', {
        reference,
        status: transaction.status,
        amount: transaction.amount
      })

      return {
        success: true,
        data: transaction
      }

    } catch (error) {
      logger.error('Payment verification failed:', error)
      throw new Error(`Payment verification failed: ${error.message}`)
    }
  }

  /**
   * Handle Paystack webhook
   * @param {Object} payload - Webhook payload
   * @param {string} signature - Webhook signature
   * @returns {boolean} Success status
   */
  async handleWebhook(payload, signature) {
    try {
      // Verify webhook signature
      if (!this.verifyWebhookSignature(payload, signature)) {
        throw new Error('Invalid webhook signature')
      }

      const event = payload.event
      const data = payload.data

      logger.info('Processing webhook event', { event, reference: data.reference })

      switch (event) {
        case 'charge.success':
          await this.handleSuccessfulPayment(data)
          break
        case 'charge.failed':
          await this.handleFailedPayment(data)
          break
        case 'transfer.success':
          await this.handleSuccessfulTransfer(data)
          break
        case 'transfer.failed':
          await this.handleFailedTransfer(data)
          break
        default:
          logger.debug('Unhandled webhook event:', event)
      }

      return true

    } catch (error) {
      logger.error('Webhook processing failed:', error)
      return false
    }
  }

  /**
   * Get student subscription status
   * @param {string} studentId - Student ID
   * @param {string} year - Subscription year
   * @returns {Object} Subscription status
   */
  async getSubscriptionStatus(studentId, year = new Date().getFullYear().toString()) {
    try {
      const result = await query(`
        SELECT 
          s.*,
          pt.status as transaction_status,
          pt.created_at as payment_date
        FROM subscriptions s
        LEFT JOIN payment_transactions pt ON s.id = pt.subscription_id
        WHERE s.student_id = $1 AND s.subscription_year = $2
        ORDER BY s.created_at DESC
        LIMIT 1
      `, [studentId, year])

      if (result.rows.length === 0) {
        return {
          hasSubscription: false,
          status: 'inactive',
          daysRemaining: 0
        }
      }

      const subscription = result.rows[0]
      const now = new Date()
      const dueDate = new Date(subscription.due_date)
      const daysRemaining = Math.max(0, Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24)))

      return {
        hasSubscription: true,
        status: subscription.payment_status,
        daysRemaining,
        amount: subscription.amount,
        dueDate: subscription.due_date,
        paymentDate: subscription.payment_date
      }

    } catch (error) {
      logger.error('Error getting subscription status:', error)
      throw error
    }
  }

  /**
   * Get payment history for student
   * @param {string} studentId - Student ID
   * @param {number} limit - Number of records to return
   * @returns {Array} Payment history
   */
  async getPaymentHistory(studentId, limit = 10) {
    try {
      const result = await query(`
        SELECT 
          s.subscription_year,
          s.amount,
          s.payment_status,
          s.payment_date,
          s.due_date,
          pt.transaction_reference,
          pt.payment_method,
          pt.status as transaction_status
        FROM subscriptions s
        LEFT JOIN payment_transactions pt ON s.id = pt.subscription_id
        WHERE s.student_id = $1
        ORDER BY s.created_at DESC
        LIMIT $2
      `, [studentId, limit])

      return result.rows

    } catch (error) {
      logger.error('Error getting payment history:', error)
      throw error
    }
  }

  /**
   * Send payment reminder
   * @param {string} studentId - Student ID
   * @returns {boolean} Success status
   */
  async sendPaymentReminder(studentId) {
    try {
      // Get student details
      const studentResult = await query(`
        SELECT s.first_name, s.last_name, u.email
        FROM students s
        JOIN users u ON s.user_id = u.id
        WHERE s.id = $1
      `, [studentId])

      if (studentResult.rows.length === 0) {
        throw new Error('Student not found')
      }

      const student = studentResult.rows[0]
      
      // Get subscription status
      const subscription = await this.getSubscriptionStatus(studentId)

      if (subscription.status === 'paid') {
        return false // Already paid
      }

      // Send reminder email/notification
      // This would integrate with your email service
      logger.info('Payment reminder sent', {
        studentId,
        email: student.email,
        daysRemaining: subscription.daysRemaining
      })

      return true

    } catch (error) {
      logger.error('Error sending payment reminder:', error)
      throw error
    }
  }

  // Helper methods

  /**
   * Create subscription record
   */
  async createSubscription(studentId, subscriptionYear, amount) {
    const currentYear = new Date().getFullYear()
    const dueDate = new Date(currentYear + 1, 0, 31) // January 31st of next year

    const result = await query(`
      INSERT INTO subscriptions (
        student_id, subscription_year, amount, payment_status, due_date
      )
      VALUES ($1, $2, $3, 'pending', $4)
      ON CONFLICT (student_id, subscription_year) 
      DO UPDATE SET 
        amount = EXCLUDED.amount,
        due_date = EXCLUDED.due_date,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [studentId, subscriptionYear, amount, dueDate])

    return result.rows[0]
  }

  /**
   * Create transaction record
   */
  async createTransaction(params) {
    const { subscriptionId, reference, amount, paystackReference, accessCode } = params

    await query(`
      INSERT INTO payment_transactions (
        subscription_id, transaction_reference, amount, 
        payment_provider, provider_transaction_id, status, metadata
      )
      VALUES ($1, $2, $3, 'paystack', $4, 'pending', $5)
    `, [
      subscriptionId, 
      reference, 
      amount, 
      paystackReference,
      JSON.stringify({ access_code: accessCode })
    ])
  }

  /**
   * Update transaction status
   */
  async updateTransactionStatus(reference, transactionData) {
    await withTransaction(async (client) => {
      // Update transaction
      await client.query(`
        UPDATE payment_transactions 
        SET 
          status = $1,
          payment_method = $2,
          metadata = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE transaction_reference = $4
      `, [
        transactionData.status === 'success' ? 'successful' : 'failed',
        transactionData.channel,
        JSON.stringify(transactionData),
        reference
      ])

      // If successful, update subscription
      if (transactionData.status === 'success') {
        const transactionResult = await client.query(
          'SELECT subscription_id FROM payment_transactions WHERE transaction_reference = $1',
          [reference]
        )

        if (transactionResult.rows.length > 0) {
          await client.query(`
            UPDATE subscriptions 
            SET 
              payment_status = 'paid',
              payment_date = CURRENT_DATE,
              payment_method = $1,
              payment_reference = $2,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
          `, [
            transactionData.channel,
            reference,
            transactionResult.rows[0].subscription_id
          ])
        }
      }
    })
  }

  /**
   * Generate payment reference
   */
  generateReference(studentId, subscriptionYear) {
    const timestamp = Date.now()
    return `FUD_${studentId}_${subscriptionYear}_${timestamp}`
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    if (!this.webhookSecret) {
      logger.warn('Webhook secret not configured, skipping signature verification')
      return true
    }

    const hash = crypto
      .createHmac('sha512', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex')

    return hash === signature
  }

  /**
   * Handle successful payment
   */
  async handleSuccessfulPayment(data) {
    try {
      await this.updateTransactionStatus(data.reference, data)
      
      // Send success notification
      logger.info('Payment processed successfully', {
        reference: data.reference,
        amount: data.amount,
        customer: data.customer.email
      })

    } catch (error) {
      logger.error('Error handling successful payment:', error)
    }
  }

  /**
   * Handle failed payment
   */
  async handleFailedPayment(data) {
    try {
      await this.updateTransactionStatus(data.reference, data)
      
      logger.warn('Payment failed', {
        reference: data.reference,
        reason: data.gateway_response
      })

    } catch (error) {
      logger.error('Error handling failed payment:', error)
    }
  }

  /**
   * Handle successful transfer (for refunds)
   */
  async handleSuccessfulTransfer(data) {
    logger.info('Transfer successful', {
      reference: data.reference,
      amount: data.amount
    })
  }

  /**
   * Handle failed transfer
   */
  async handleFailedTransfer(data) {
    logger.warn('Transfer failed', {
      reference: data.reference,
      reason: data.failure_reason
    })
  }
}

module.exports = new PaymentService()
