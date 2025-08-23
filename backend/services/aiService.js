const OpenAI = require('openai')
const logger = require('../utils/logger')
const { query } = require('../config/database')

class AIService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    })
    
    this.model = process.env.OPENAI_MODEL || 'gpt-4'
    this.maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS) || 1000
  }

  /**
   * Process a student message and generate AI response
   * @param {Object} params - Message processing parameters
   * @param {string} params.message - Student's message
   * @param {string} params.sessionId - Chat session ID
   * @param {Object} params.studentContext - Student's academic context
   * @param {Array} params.conversationHistory - Previous messages
   * @returns {Object} AI response with content and metadata
   */
  async processMessage({ message, sessionId, studentContext, conversationHistory = [] }) {
    const startTime = Date.now()
    
    try {
      // Build system prompt with FUD-specific context
      const systemPrompt = await this.buildSystemPrompt(studentContext)
      
      // Build conversation messages
      const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        { role: 'user', content: message }
      ]

      // Get AI response
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: 0.7,
        presence_penalty: 0.1,
        frequency_penalty: 0.1
      })

      const response = completion.choices[0].message.content
      const tokenCount = completion.usage.total_tokens
      const processingTime = Date.now() - startTime

      // Generate contextual suggestions
      const suggestions = await this.generateSuggestions(message, studentContext)

      logger.info('AI message processed successfully', {
        sessionId,
        tokenCount,
        processingTime,
        messageLength: message.length,
        responseLength: response.length
      })

      return {
        content: response,
        suggestions,
        tokenCount,
        processingTime,
        model: this.model
      }

    } catch (error) {
      logger.error('AI service error:', error)
      
      // Return fallback response
      return {
        content: this.getFallbackResponse(message),
        suggestions: [],
        tokenCount: 0,
        processingTime: Date.now() - startTime,
        error: error.message
      }
    }
  }

  /**
   * Build system prompt with FUD-specific context
   * @param {Object} studentContext - Student's academic information
   * @returns {string} System prompt
   */
  async buildSystemPrompt(studentContext) {
    const basePrompt = `You are FudBot, an AI companion for Federal University Dutse (FUD) students. You are helpful, knowledgeable, and supportive. Your role is to assist students with:

1. Academic guidance and course information
2. University policies and procedures
3. Study tips and learning strategies
4. Career advice and opportunities
5. Campus life and student services
6. General educational support

IMPORTANT GUIDELINES:
- Always be respectful, encouraging, and supportive
- Provide accurate information about FUD when available
- If you don't know something specific about FUD, be honest and suggest they contact the relevant department
- Help students stay motivated and focused on their academic goals
- Promote academic integrity and proper conduct
- Be culturally sensitive to Nigerian context

Federal University Dutse Information:
- Located in Dutse, Jigawa State, Nigeria
- Established in 2011
- Known for programs in Engineering, Sciences, Arts, Social Sciences, Education, and Management
- Academic calendar typically runs from October to July
- Uses semester system with two semesters per academic year`

    // Add student-specific context
    if (studentContext) {
      const contextDetails = []
      
      if (studentContext.first_name) {
        contextDetails.push(`Student Name: ${studentContext.first_name} ${studentContext.last_name}`)
      }
      
      if (studentContext.student_id) {
        contextDetails.push(`Student ID: ${studentContext.student_id}`)
      }
      
      if (studentContext.current_level) {
        contextDetails.push(`Current Level: ${studentContext.current_level}`)
      }
      
      if (studentContext.department) {
        contextDetails.push(`Department: ${studentContext.department}`)
      }
      
      if (studentContext.faculty) {
        contextDetails.push(`Faculty: ${studentContext.faculty}`)
      }
      
      if (studentContext.cgpa) {
        contextDetails.push(`Current CGPA: ${studentContext.cgpa}`)
      }

      if (contextDetails.length > 0) {
        return `${basePrompt}

STUDENT CONTEXT:
${contextDetails.join('\n')}

Use this context to personalize your responses when relevant.`
      }
    }

    return basePrompt
  }

  /**
   * Generate contextual suggestions for follow-up questions
   * @param {string} message - User's message
   * @param {Object} studentContext - Student context
   * @returns {Array} Array of suggestion strings
   */
  async generateSuggestions(message, studentContext) {
    const suggestions = []
    
    // Generic academic suggestions
    if (message.toLowerCase().includes('course') || message.toLowerCase().includes('subject')) {
      suggestions.push('Tell me about course registration')
      suggestions.push('What are the prerequisites for my courses?')
      suggestions.push('How do I calculate my GPA?')
    }
    
    if (message.toLowerCase().includes('exam') || message.toLowerCase().includes('test')) {
      suggestions.push('What are effective study strategies?')
      suggestions.push('How should I prepare for exams?')
      suggestions.push('Tell me about the examination rules')
    }
    
    if (message.toLowerCase().includes('career') || message.toLowerCase().includes('job')) {
      suggestions.push('What career opportunities are available in my field?')
      suggestions.push('How can I improve my employability?')
      suggestions.push('Tell me about internship opportunities')
    }

    // Level-specific suggestions
    if (studentContext?.current_level) {
      const level = studentContext.current_level
      
      if (level === 100) {
        suggestions.push('How do I adapt to university life?')
        suggestions.push('What should I know as a fresh student?')
      } else if (level >= 300) {
        suggestions.push('How should I prepare for my final year?')
        suggestions.push('What about industrial training opportunities?')
      }
    }

    // Department-specific suggestions
    if (studentContext?.department) {
      suggestions.push(`What are the career prospects in ${studentContext.department}?`)
      suggestions.push('Tell me about department-specific requirements')
    }

    // Return up to 3 most relevant suggestions
    return suggestions.slice(0, 3)
  }

  /**
   * Get fallback response when AI service fails
   * @param {string} message - User's message
   * @returns {string} Fallback response
   */
  getFallbackResponse(message) {
    const fallbacks = [
      "I'm having some technical difficulties right now. Please try asking your question again in a moment, or contact the student affairs office for immediate assistance.",
      "I apologize, but I'm unable to process your request at the moment. You can reach out to your academic advisor or visit the student portal for information.",
      "There seems to be a temporary issue with my systems. For urgent matters, please contact the university administration directly."
    ]
    
    return fallbacks[Math.floor(Math.random() * fallbacks.length)]
  }

  /**
   * Search knowledge base for relevant information
   * @param {string} query - Search query
   * @param {Object} context - Student context for filtering
   * @returns {Array} Relevant knowledge base entries
   */
  async searchKnowledgeBase(query, context = {}) {
    try {
      let searchQuery = `
        SELECT id, title, content, category, subcategory
        FROM knowledge_base
        WHERE is_active = true
        AND (
          title ILIKE $1 OR
          content ILIKE $1 OR
          $2 = ANY(keywords)
        )
      `
      
      const queryParams = [`%${query}%`, query]
      
      // Add context filters
      if (context.department) {
        searchQuery += ` AND (department_specific IS NULL OR department_specific = $${queryParams.length + 1})`
        queryParams.push(context.department_id)
      }
      
      if (context.current_level) {
        searchQuery += ` AND (level_specific IS NULL OR level_specific = $${queryParams.length + 1})`
        queryParams.push(context.current_level)
      }
      
      searchQuery += ` ORDER BY 
        CASE WHEN title ILIKE $1 THEN 1 ELSE 2 END,
        created_at DESC
        LIMIT 5`
      
      const result = await query(searchQuery, queryParams)
      return result.rows
      
    } catch (error) {
      logger.error('Knowledge base search error:', error)
      return []
    }
  }

  /**
   * Get AI usage statistics for a student
   * @param {string} studentId - Student ID
   * @param {number} days - Number of days to look back
   * @returns {Object} Usage statistics
   */
  async getUsageStats(studentId, days = 30) {
    try {
      const result = await query(`
        SELECT 
          COUNT(*) as total_messages,
          COUNT(DISTINCT session_id) as total_sessions,
          SUM(token_count) as total_tokens,
          AVG(token_count) as avg_tokens_per_message
        FROM ai_chat_messages acm
        JOIN ai_chat_sessions acs ON acm.session_id = acs.id
        WHERE acs.student_id = $1
        AND acm.created_at >= CURRENT_DATE - INTERVAL '${days} days'
        AND acm.role = 'user'
      `, [studentId])

      return result.rows[0] || {
        total_messages: 0,
        total_sessions: 0,
        total_tokens: 0,
        avg_tokens_per_message: 0
      }
      
    } catch (error) {
      logger.error('Usage stats error:', error)
      return {
        total_messages: 0,
        total_sessions: 0,
        total_tokens: 0,
        avg_tokens_per_message: 0
      }
    }
  }
}

module.exports = new AIService()
