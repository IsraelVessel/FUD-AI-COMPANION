const express = require('express')
const { body, validationResult } = require('express-validator')
const { auth, studentOnly } = require('../middleware/auth')
const { query, withTransaction } = require('../config/database')
const logger = require('../utils/logger')
const AIService = require('../services/aiService')
const rateLimit = require('express-rate-limit')

const router = express.Router()

// Rate limiting for AI interactions
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per user
  message: {
    error: 'Too many AI requests, please wait before sending another message.',
    code: 'AI_RATE_LIMIT'
  },
  keyGenerator: (req) => req.user?.id || req.ip
})

/**
 * @route   POST /api/v1/ai/chat
 * @desc    Send message to AI companion
 * @access  Private (Students only)
 */
router.post('/chat', [
  auth,
  studentOnly,
  aiLimiter,
  body('message').trim().isLength({ min: 1, max: 2000 }).withMessage('Message is required and must be under 2000 characters'),
  body('sessionId').optional().isUUID().withMessage('Invalid session ID')
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

    const { message, sessionId } = req.body
    const studentId = req.student.id

    // Create or get session
    let session
    if (sessionId) {
      // Verify session belongs to student
      const sessionResult = await query(
        'SELECT id, title, is_active FROM ai_chat_sessions WHERE id = $1 AND student_id = $2',
        [sessionId, studentId]
      )
      
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Chat session not found'
        })
      }
      
      session = sessionResult.rows[0]
      
      if (!session.is_active) {
        return res.status(400).json({
          success: false,
          message: 'Chat session is not active'
        })
      }
    } else {
      // Create new session
      const newSessionResult = await query(
        `INSERT INTO ai_chat_sessions (student_id, title, started_at, is_active)
         VALUES ($1, $2, CURRENT_TIMESTAMP, true)
         RETURNING id, title`,
        [studentId, message.substring(0, 50) + '...']
      )
      session = newSessionResult.rows[0]
    }

    // Get student context for personalized responses
    const studentContext = await getStudentContext(studentId)

    // Process with AI service
    const aiResponse = await AIService.processMessage({
      message,
      sessionId: session.id,
      studentContext,
      conversationHistory: await getConversationHistory(session.id)
    })

    // Save messages to database
    await withTransaction(async (client) => {
      // Save user message
      await client.query(
        `INSERT INTO ai_chat_messages (session_id, role, content, token_count, created_at)
         VALUES ($1, 'user', $2, $3, CURRENT_TIMESTAMP)`,
        [session.id, message, estimateTokenCount(message)]
      )

      // Save AI response
      await client.query(
        `INSERT INTO ai_chat_messages (session_id, role, content, token_count, created_at)
         VALUES ($1, 'assistant', $2, $3, CURRENT_TIMESTAMP)`,
        [session.id, aiResponse.content, aiResponse.tokenCount]
      )

      // Update session message count
      await client.query(
        'UPDATE ai_chat_sessions SET message_count = message_count + 2 WHERE id = $1',
        [session.id]
      )
    })

    logger.info('AI chat interaction completed', {
      studentId,
      sessionId: session.id,
      messageLength: message.length,
      responseLength: aiResponse.content.length
    })

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        response: aiResponse.content,
        suggestions: aiResponse.suggestions,
        metadata: {
          tokensUsed: aiResponse.tokenCount,
          processingTime: aiResponse.processingTime
        }
      }
    })

  } catch (error) {
    logger.error('AI chat error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to process AI request',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    })
  }
})

/**
 * @route   GET /api/v1/ai/sessions
 * @desc    Get chat sessions for current student
 * @access  Private (Students only)
 */
router.get('/sessions', [auth, studentOnly], async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query
    const offset = (page - 1) * limit

    const sessionsResult = await query(
      `SELECT id, title, started_at, ended_at, message_count, is_active
       FROM ai_chat_sessions 
       WHERE student_id = $1 
       ORDER BY started_at DESC 
       LIMIT $2 OFFSET $3`,
      [req.student.id, limit, offset]
    )

    const totalResult = await query(
      'SELECT COUNT(*) FROM ai_chat_sessions WHERE student_id = $1',
      [req.student.id]
    )

    res.json({
      success: true,
      data: {
        sessions: sessionsResult.rows,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalResult.rows[0].count / limit),
          totalSessions: parseInt(totalResult.rows[0].count)
        }
      }
    })

  } catch (error) {
    logger.error('Get sessions error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get chat sessions'
    })
  }
})

/**
 * @route   GET /api/v1/ai/sessions/:sessionId/messages
 * @desc    Get messages from a specific chat session
 * @access  Private (Students only)
 */
router.get('/sessions/:sessionId/messages', [auth, studentOnly], async (req, res) => {
  try {
    const { sessionId } = req.params
    const { page = 1, limit = 50 } = req.query

    // Verify session belongs to student
    const sessionResult = await query(
      'SELECT id FROM ai_chat_sessions WHERE id = $1 AND student_id = $2',
      [sessionId, req.student.id]
    )

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Chat session not found'
      })
    }

    const offset = (page - 1) * limit

    const messagesResult = await query(
      `SELECT id, role, content, created_at
       FROM ai_chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at ASC 
       LIMIT $2 OFFSET $3`,
      [sessionId, limit, offset]
    )

    res.json({
      success: true,
      data: {
        messages: messagesResult.rows
      }
    })

  } catch (error) {
    logger.error('Get messages error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get messages'
    })
  }
})

/**
 * @route   DELETE /api/v1/ai/sessions/:sessionId
 * @desc    Delete a chat session
 * @access  Private (Students only)
 */
router.delete('/sessions/:sessionId', [auth, studentOnly], async (req, res) => {
  try {
    const { sessionId } = req.params

    // Verify session belongs to student and delete
    const result = await query(
      'DELETE FROM ai_chat_sessions WHERE id = $1 AND student_id = $2 RETURNING id',
      [sessionId, req.student.id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Chat session not found'
      })
    }

    logger.info('Chat session deleted', {
      sessionId,
      studentId: req.student.id
    })

    res.json({
      success: true,
      message: 'Chat session deleted successfully'
    })

  } catch (error) {
    logger.error('Delete session error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to delete chat session'
    })
  }
})

/**
 * @route   GET /api/v1/ai/knowledge/search
 * @desc    Search knowledge base
 * @access  Private (Students only)
 */
router.get('/knowledge/search', [auth, studentOnly], async (req, res) => {
  try {
    const { q, category, department } = req.query

    if (!q || q.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 3 characters long'
      })
    }

    let searchQuery = `
      SELECT id, category, subcategory, title, content
      FROM knowledge_base 
      WHERE is_active = true 
      AND (
        title ILIKE $1 OR 
        content ILIKE $1 OR 
        $2 = ANY(keywords)
      )
    `
    const queryParams = [`%${q}%`, q]

    if (category) {
      searchQuery += ` AND category = $${queryParams.length + 1}`
      queryParams.push(category)
    }

    if (department) {
      searchQuery += ` AND (department_specific IS NULL OR department_specific = $${queryParams.length + 1})`
      queryParams.push(department)
    }

    searchQuery += ` ORDER BY 
      CASE WHEN title ILIKE $1 THEN 1 ELSE 2 END,
      created_at DESC 
      LIMIT 20`

    const results = await query(searchQuery, queryParams)

    res.json({
      success: true,
      data: {
        results: results.rows.map(row => ({
          ...row,
          content: row.content.substring(0, 200) + '...'
        })),
        query: q,
        totalResults: results.rows.length
      }
    })

  } catch (error) {
    logger.error('Knowledge search error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to search knowledge base'
    })
  }
})

// Helper functions
async function getStudentContext(studentId) {
  const contextResult = await query(`
    SELECT 
      s.first_name, s.last_name, s.student_id,
      sa.current_level, sa.cgpa,
      d.name as department, f.name as faculty
    FROM students s
    LEFT JOIN student_academics sa ON s.id = sa.student_id
    LEFT JOIN departments d ON sa.department_id = d.id
    LEFT JOIN faculties f ON d.faculty_id = f.id
    WHERE s.id = $1
  `, [studentId])

  return contextResult.rows[0] || {}
}

async function getConversationHistory(sessionId, limit = 10) {
  const historyResult = await query(
    `SELECT role, content, created_at
     FROM ai_chat_messages 
     WHERE session_id = $1 
     ORDER BY created_at DESC 
     LIMIT $2`,
    [sessionId, limit]
  )

  return historyResult.rows.reverse()
}

function estimateTokenCount(text) {
  // Rough estimation: ~4 characters per token
  return Math.ceil(text.length / 4)
}

module.exports = router
