const { query, withTransaction } = require('../config/database')
const logger = require('../utils/logger')

class AlumniService {
  /**
   * Check for students eligible for graduation and transition them to alumni
   * This method should be run periodically (e.g., daily via cron job)
   */
  async processGraduationTransitions() {
    try {
      logger.info('Starting graduation transition process')

      // Find students eligible for graduation
      const eligibleStudents = await this.findEligibleGraduates()
      
      let transitionedCount = 0
      
      for (const student of eligibleStudents) {
        try {
          await this.transitionToAlumni(student)
          transitionedCount++
        } catch (error) {
          logger.error(`Failed to transition student ${student.student_id}:`, error)
        }
      }

      logger.info(`Graduation transition completed. ${transitionedCount}/${eligibleStudents.length} students transitioned to alumni.`)

      return {
        totalEligible: eligibleStudents.length,
        transitioned: transitionedCount
      }

    } catch (error) {
      logger.error('Graduation transition process failed:', error)
      throw error
    }
  }

  /**
   * Find students eligible for graduation based on academic requirements
   * @returns {Array} Array of eligible students
   */
  async findEligibleGraduates() {
    try {
      const result = await query(`
        SELECT 
          s.id,
          s.user_id,
          s.student_id,
          s.first_name,
          s.last_name,
          s.middle_name,
          s.phone,
          s.academic_status,
          s.enrollment_date,
          sa.current_level,
          sa.cgpa,
          sa.total_credit_units,
          d.name as department_name,
          d.id as department_id,
          f.name as faculty_name,
          u.email
        FROM students s
        JOIN student_academics sa ON s.id = sa.student_id
        JOIN departments d ON sa.department_id = d.id
        JOIN faculties f ON d.faculty_id = f.id
        JOIN users u ON s.user_id = u.id
        WHERE 
          s.academic_status = 'active'
          AND sa.current_level >= 400  -- Final year and above
          AND sa.cgpa >= 1.0           -- Minimum CGPA requirement
          AND sa.total_credit_units >= 120  -- Minimum credit units for graduation
          AND NOT EXISTS (
            SELECT 1 FROM alumni a WHERE a.former_student_id = s.id
          )
      `)

      return result.rows

    } catch (error) {
      logger.error('Error finding eligible graduates:', error)
      throw error
    }
  }

  /**
   * Transition a student to alumni status
   * @param {Object} student - Student record
   */
  async transitionToAlumni(student) {
    try {
      await withTransaction(async (client) => {
        // Calculate graduation year
        const graduationYear = new Date().getFullYear()
        
        // Determine degree class based on CGPA
        const degreeClass = this.calculateDegreeClass(student.cgpa)
        
        // Create alumni record
        const alumniResult = await client.query(`
          INSERT INTO alumni (
            user_id,
            former_student_id,
            graduation_year,
            degree_awarded,
            class_of_degree,
            final_cgpa,
            phone,
            email,
            is_active
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
          RETURNING id
        `, [
          student.user_id,
          student.id,
          graduationYear,
          `Bachelor of ${student.department_name}`, // Assuming Bachelor's degree
          degreeClass,
          student.cgpa,
          student.phone,
          student.email
        ])

        const alumniId = alumniResult.rows[0].id

        // Update student status to graduated
        await client.query(`
          UPDATE students 
          SET 
            academic_status = 'graduated',
            actual_graduation_date = CURRENT_DATE,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [student.id])

        // Update user role to alumni
        await client.query(`
          UPDATE users 
          SET role = 'alumni', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [student.user_id])

        // Create graduation notification
        await client.query(`
          INSERT INTO notifications (
            user_id,
            title,
            message,
            type,
            priority,
            metadata
          )
          VALUES ($1, $2, $3, 'academic', 'high', $4)
        `, [
          student.user_id,
          'Congratulations on Your Graduation!',
          `Congratulations ${student.first_name}! You have successfully graduated and have been transitioned to our alumni community. Welcome to the FUD Alumni Network!`,
          JSON.stringify({
            graduationYear,
            degreeClass,
            cgpa: student.cgpa,
            alumniId
          })
        ])

        logger.info('Student successfully transitioned to alumni', {
          studentId: student.student_id,
          userId: student.user_id,
          alumniId,
          graduationYear,
          degreeClass
        })
      })

    } catch (error) {
      logger.error(`Failed to transition student ${student.student_id} to alumni:`, error)
      throw error
    }
  }

  /**
   * Calculate degree class based on CGPA
   * @param {number} cgpa - Student's CGPA
   * @returns {string} Degree class
   */
  calculateDegreeClass(cgpa) {
    if (cgpa >= 4.5) {
      return 'First Class Honours'
    } else if (cgpa >= 3.5) {
      return 'Second Class Honours (Upper Division)'
    } else if (cgpa >= 2.5) {
      return 'Second Class Honours (Lower Division)'
    } else if (cgpa >= 1.5) {
      return 'Third Class Honours'
    } else if (cgpa >= 1.0) {
      return 'Pass'
    } else {
      return 'Fail'
    }
  }

  /**
   * Manually transition a student to alumni (for admin use)
   * @param {string} studentId - Student ID
   * @param {Object} alumniData - Additional alumni data
   */
  async manualTransitionToAlumni(studentId, alumniData = {}) {
    try {
      // Get student details
      const studentResult = await query(`
        SELECT 
          s.*,
          sa.cgpa,
          sa.total_credit_units,
          d.name as department_name,
          u.email
        FROM students s
        JOIN student_academics sa ON s.id = sa.student_id
        JOIN departments d ON sa.department_id = d.id
        JOIN users u ON s.user_id = u.id
        WHERE s.id = $1
      `, [studentId])

      if (studentResult.rows.length === 0) {
        throw new Error('Student not found')
      }

      const student = studentResult.rows[0]

      // Check if already alumni
      const existingAlumni = await query(
        'SELECT id FROM alumni WHERE former_student_id = $1',
        [studentId]
      )

      if (existingAlumni.rows.length > 0) {
        throw new Error('Student is already an alumnus')
      }

      // Transition to alumni with custom data
      const customStudent = {
        ...student,
        ...alumniData // Override with custom data if provided
      }

      await this.transitionToAlumni(customStudent)

      return {
        success: true,
        message: 'Student successfully transitioned to alumni'
      }

    } catch (error) {
      logger.error('Manual alumni transition failed:', error)
      throw error
    }
  }

  /**
   * Get alumni statistics
   * @returns {Object} Alumni statistics
   */
  async getAlumniStatistics() {
    try {
      const stats = await query(`
        SELECT 
          COUNT(*) as total_alumni,
          COUNT(*) FILTER (WHERE graduation_year = EXTRACT(YEAR FROM CURRENT_DATE)) as current_year_graduates,
          COUNT(*) FILTER (WHERE class_of_degree = 'First Class Honours') as first_class_count,
          COUNT(*) FILTER (WHERE class_of_degree LIKE 'Second Class%') as second_class_count,
          AVG(final_cgpa) as average_cgpa,
          MIN(graduation_year) as earliest_graduation_year,
          MAX(graduation_year) as latest_graduation_year
        FROM alumni
        WHERE is_active = true
      `)

      const graduationTrends = await query(`
        SELECT 
          graduation_year,
          COUNT(*) as graduates_count,
          AVG(final_cgpa) as average_cgpa
        FROM alumni
        WHERE is_active = true
        GROUP BY graduation_year
        ORDER BY graduation_year DESC
        LIMIT 10
      `)

      const degreeClassDistribution = await query(`
        SELECT 
          class_of_degree,
          COUNT(*) as count,
          ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM alumni WHERE is_active = true)), 2) as percentage
        FROM alumni
        WHERE is_active = true
        GROUP BY class_of_degree
        ORDER BY count DESC
      `)

      return {
        overall: stats.rows[0],
        graduationTrends: graduationTrends.rows,
        degreeClassDistribution: degreeClassDistribution.rows
      }

    } catch (error) {
      logger.error('Error getting alumni statistics:', error)
      throw error
    }
  }

  /**
   * Search alumni directory
   * @param {Object} filters - Search filters
   * @returns {Array} Alumni search results
   */
  async searchAlumni(filters = {}) {
    try {
      const {
        graduationYear,
        degreeClass,
        department,
        name,
        limit = 50,
        offset = 0
      } = filters

      let whereConditions = ['a.is_active = true']
      let queryParams = []
      let paramIndex = 1

      if (graduationYear) {
        whereConditions.push(`a.graduation_year = $${paramIndex++}`)
        queryParams.push(graduationYear)
      }

      if (degreeClass) {
        whereConditions.push(`a.class_of_degree = $${paramIndex++}`)
        queryParams.push(degreeClass)
      }

      if (department) {
        whereConditions.push(`a.degree_awarded ILIKE $${paramIndex++}`)
        queryParams.push(`%${department}%`)
      }

      if (name) {
        whereConditions.push(`(
          s.first_name ILIKE $${paramIndex} OR 
          s.last_name ILIKE $${paramIndex} OR 
          CONCAT(s.first_name, ' ', s.last_name) ILIKE $${paramIndex}
        )`)
        queryParams.push(`%${name}%`)
        paramIndex++
      }

      queryParams.push(limit, offset)

      const searchQuery = `
        SELECT 
          a.id,
          a.graduation_year,
          a.degree_awarded,
          a.class_of_degree,
          a.final_cgpa,
          a.current_occupation,
          a.current_employer,
          a.linkedin_profile,
          s.first_name,
          s.last_name,
          s.student_id,
          a.created_at
        FROM alumni a
        JOIN students s ON a.former_student_id = s.id
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY a.graduation_year DESC, s.last_name, s.first_name
        LIMIT $${paramIndex++} OFFSET $${paramIndex}
      `

      const result = await query(searchQuery, queryParams)

      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM alumni a
        JOIN students s ON a.former_student_id = s.id
        WHERE ${whereConditions.join(' AND ')}
      `

      const countResult = await query(countQuery, queryParams.slice(0, -2)) // Remove limit and offset

      return {
        alumni: result.rows,
        totalCount: parseInt(countResult.rows[0].total),
        currentPage: Math.floor(offset / limit) + 1,
        totalPages: Math.ceil(countResult.rows[0].total / limit)
      }

    } catch (error) {
      logger.error('Error searching alumni:', error)
      throw error
    }
  }

  /**
   * Update alumni profile
   * @param {string} alumniId - Alumni ID
   * @param {Object} updateData - Data to update
   */
  async updateAlumniProfile(alumniId, updateData) {
    try {
      const {
        currentOccupation,
        currentEmployer,
        linkedinProfile,
        phone,
        email,
        address,
        achievements
      } = updateData

      // Build update query dynamically
      const updateFields = []
      const updateValues = []
      let valueIndex = 1

      if (currentOccupation !== undefined) {
        updateFields.push(`current_occupation = $${valueIndex++}`)
        updateValues.push(currentOccupation)
      }
      if (currentEmployer !== undefined) {
        updateFields.push(`current_employer = $${valueIndex++}`)
        updateValues.push(currentEmployer)
      }
      if (linkedinProfile !== undefined) {
        updateFields.push(`linkedin_profile = $${valueIndex++}`)
        updateValues.push(linkedinProfile)
      }
      if (phone !== undefined) {
        updateFields.push(`phone = $${valueIndex++}`)
        updateValues.push(phone)
      }
      if (email !== undefined) {
        updateFields.push(`email = $${valueIndex++}`)
        updateValues.push(email)
      }
      if (address !== undefined) {
        updateFields.push(`address = $${valueIndex++}`)
        updateValues.push(address)
      }
      if (achievements !== undefined) {
        updateFields.push(`achievements = $${valueIndex++}`)
        updateValues.push(JSON.stringify(achievements))
      }

      if (updateFields.length === 0) {
        throw new Error('No fields to update')
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`)
      updateValues.push(alumniId)

      const updateQuery = `
        UPDATE alumni 
        SET ${updateFields.join(', ')}
        WHERE id = $${valueIndex}
        RETURNING *
      `

      const result = await query(updateQuery, updateValues)

      if (result.rows.length === 0) {
        throw new Error('Alumni not found')
      }

      logger.info('Alumni profile updated', { alumniId })

      return result.rows[0]

    } catch (error) {
      logger.error('Error updating alumni profile:', error)
      throw error
    }
  }
}

module.exports = new AlumniService()
