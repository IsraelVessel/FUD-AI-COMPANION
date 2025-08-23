const express = require('express')
const { body, validationResult } = require('express-validator')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

const { auth, studentOnly } = require('../middleware/auth')
const { query, withTransaction } = require('../config/database')
const logger = require('../utils/logger')
const PaymentService = require('../services/paymentService')

const router = express.Router()

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads', 'profiles')
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    const filename = `${req.student.id}_${Date.now()}${ext}`
    cb(null, filename)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Only image files are allowed'))
    }
  }
})

/**
 * @route   GET /api/v1/students/profile
 * @desc    Get student profile with academic and subscription info
 * @access  Private (Students only)
 */
router.get('/profile', [auth, studentOnly], async (req, res) => {
  try {
    const profileResult = await query(`
      SELECT 
        s.id, s.student_id, s.first_name, s.last_name, s.middle_name,
        s.phone, s.date_of_birth, s.gender, s.address, s.state_of_origin,
        s.local_government, s.nationality, s.profile_picture_url,
        s.academic_status, s.enrollment_date, s.expected_graduation_date,
        sa.current_level, sa.cgpa, sa.total_credit_units, sa.mode_of_entry, sa.jamb_score,
        d.name as department_name, d.code as department_code,
        f.name as faculty_name, f.code as faculty_code,
        u.email, u.email_verified, u.last_login, u.created_at
      FROM students s
      LEFT JOIN student_academics sa ON s.id = sa.student_id
      LEFT JOIN departments d ON sa.department_id = d.id
      LEFT JOIN faculties f ON d.faculty_id = f.id
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.id = $1
    `, [req.student.id])

    if (profileResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student profile not found'
      })
    }

    const student = profileResult.rows[0]

    // Get subscription status
    const subscriptionStatus = await PaymentService.getSubscriptionStatus(req.student.id)

    // Get emergency contacts
    const contactsResult = await query(
      'SELECT * FROM emergency_contacts WHERE student_id = $1 ORDER BY is_primary DESC, created_at',
      [req.student.id]
    )

    res.json({
      success: true,
      data: {
        personal: {
          id: student.id,
          studentId: student.student_id,
          firstName: student.first_name,
          lastName: student.last_name,
          middleName: student.middle_name,
          email: student.email,
          phone: student.phone,
          dateOfBirth: student.date_of_birth,
          gender: student.gender,
          address: student.address,
          stateOfOrigin: student.state_of_origin,
          localGovernment: student.local_government,
          nationality: student.nationality,
          profilePicture: student.profile_picture_url,
          emailVerified: student.email_verified,
          lastLogin: student.last_login,
          createdAt: student.created_at
        },
        academic: {
          status: student.academic_status,
          currentLevel: student.current_level,
          cgpa: student.cgpa,
          totalCreditUnits: student.total_credit_units,
          modeOfEntry: student.mode_of_entry,
          jambScore: student.jamb_score,
          enrollmentDate: student.enrollment_date,
          expectedGraduationDate: student.expected_graduation_date,
          department: {
            name: student.department_name,
            code: student.department_code
          },
          faculty: {
            name: student.faculty_name,
            code: student.faculty_code
          }
        },
        subscription: subscriptionStatus,
        emergencyContacts: contactsResult.rows
      }
    })

  } catch (error) {
    logger.error('Get student profile error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get student profile'
    })
  }
})

/**
 * @route   PUT /api/v1/students/profile
 * @desc    Update student profile
 * @access  Private (Students only)
 */
router.put('/profile', [
  auth,
  studentOnly,
  body('firstName').optional().trim().isLength({ min: 1 }).withMessage('First name is required'),
  body('lastName').optional().trim().isLength({ min: 1 }).withMessage('Last name is required'),
  body('phone').optional().isMobilePhone().withMessage('Valid phone number required'),
  body('dateOfBirth').optional().isDate().withMessage('Valid date of birth required'),
  body('gender').optional().isIn(['Male', 'Female', 'Other']).withMessage('Valid gender required')
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
      firstName,
      lastName,
      middleName,
      phone,
      dateOfBirth,
      gender,
      address,
      stateOfOrigin,
      localGovernment
    } = req.body

    // Build update query dynamically
    const updateFields = []
    const updateValues = []
    let valueIndex = 1

    if (firstName !== undefined) {
      updateFields.push(`first_name = $${valueIndex++}`)
      updateValues.push(firstName)
    }
    if (lastName !== undefined) {
      updateFields.push(`last_name = $${valueIndex++}`)
      updateValues.push(lastName)
    }
    if (middleName !== undefined) {
      updateFields.push(`middle_name = $${valueIndex++}`)
      updateValues.push(middleName)
    }
    if (phone !== undefined) {
      updateFields.push(`phone = $${valueIndex++}`)
      updateValues.push(phone)
    }
    if (dateOfBirth !== undefined) {
      updateFields.push(`date_of_birth = $${valueIndex++}`)
      updateValues.push(dateOfBirth)
    }
    if (gender !== undefined) {
      updateFields.push(`gender = $${valueIndex++}`)
      updateValues.push(gender)
    }
    if (address !== undefined) {
      updateFields.push(`address = $${valueIndex++}`)
      updateValues.push(address)
    }
    if (stateOfOrigin !== undefined) {
      updateFields.push(`state_of_origin = $${valueIndex++}`)
      updateValues.push(stateOfOrigin)
    }
    if (localGovernment !== undefined) {
      updateFields.push(`local_government = $${valueIndex++}`)
      updateValues.push(localGovernment)
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      })
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`)
    updateValues.push(req.student.id)

    const updateQuery = `
      UPDATE students 
      SET ${updateFields.join(', ')}
      WHERE id = $${valueIndex}
      RETURNING id, first_name, last_name, middle_name, phone, date_of_birth, gender, address, state_of_origin, local_government
    `

    const result = await query(updateQuery, updateValues)

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      })
    }

    logger.info('Student profile updated', {
      studentId: req.student.id,
      updatedFields: updateFields.slice(0, -1) // Exclude updated_at
    })

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: result.rows[0]
    })

  } catch (error) {
    logger.error('Update student profile error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    })
  }
})

/**
 * @route   POST /api/v1/students/profile/picture
 * @desc    Upload profile picture
 * @access  Private (Students only)
 */
router.post('/profile/picture', [auth, studentOnly], upload.single('profilePicture'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      })
    }

    const profilePictureUrl = `/uploads/profiles/${req.file.filename}`

    // Update profile picture URL in database
    await query(
      'UPDATE students SET profile_picture_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [profilePictureUrl, req.student.id]
    )

    logger.info('Profile picture updated', {
      studentId: req.student.id,
      filename: req.file.filename
    })

    res.json({
      success: true,
      message: 'Profile picture updated successfully',
      data: {
        profilePictureUrl
      }
    })

  } catch (error) {
    logger.error('Upload profile picture error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to upload profile picture'
    })
  }
})

/**
 * @route   GET /api/v1/students/emergency-contacts
 * @desc    Get emergency contacts
 * @access  Private (Students only)
 */
router.get('/emergency-contacts', [auth, studentOnly], async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM emergency_contacts WHERE student_id = $1 ORDER BY is_primary DESC, created_at',
      [req.student.id]
    )

    res.json({
      success: true,
      data: result.rows
    })

  } catch (error) {
    logger.error('Get emergency contacts error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get emergency contacts'
    })
  }
})

/**
 * @route   POST /api/v1/students/emergency-contacts
 * @desc    Add emergency contact
 * @access  Private (Students only)
 */
router.post('/emergency-contacts', [
  auth,
  studentOnly,
  body('contactType').isIn(['parent', 'guardian', 'sibling', 'spouse', 'other']).withMessage('Valid contact type required'),
  body('fullName').trim().isLength({ min: 1 }).withMessage('Full name is required'),
  body('phonePrimary').isMobilePhone().withMessage('Valid primary phone number required'),
  body('phoneSecondary').optional().isMobilePhone().withMessage('Valid secondary phone number required'),
  body('email').optional().isEmail().withMessage('Valid email required')
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
      contactType,
      fullName,
      relationship,
      phonePrimary,
      phoneSecondary,
      email,
      address,
      isPrimary = false
    } = req.body

    // If setting as primary, unset other primary contacts
    if (isPrimary) {
      await query(
        'UPDATE emergency_contacts SET is_primary = false WHERE student_id = $1',
        [req.student.id]
      )
    }

    const result = await query(`
      INSERT INTO emergency_contacts (
        student_id, contact_type, full_name, relationship,
        phone_primary, phone_secondary, email, address, is_primary
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      req.student.id, contactType, fullName, relationship,
      phonePrimary, phoneSecondary, email, address, isPrimary
    ])

    logger.info('Emergency contact added', {
      studentId: req.student.id,
      contactId: result.rows[0].id
    })

    res.status(201).json({
      success: true,
      message: 'Emergency contact added successfully',
      data: result.rows[0]
    })

  } catch (error) {
    logger.error('Add emergency contact error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to add emergency contact'
    })
  }
})

/**
 * @route   PUT /api/v1/students/emergency-contacts/:id
 * @desc    Update emergency contact
 * @access  Private (Students only)
 */
router.put('/emergency-contacts/:id', [auth, studentOnly], async (req, res) => {
  try {
    const { id } = req.params
    const {
      contactType,
      fullName,
      relationship,
      phonePrimary,
      phoneSecondary,
      email,
      address,
      isPrimary
    } = req.body

    // Verify contact belongs to student
    const existingContact = await query(
      'SELECT id FROM emergency_contacts WHERE id = $1 AND student_id = $2',
      [id, req.student.id]
    )

    if (existingContact.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Emergency contact not found'
      })
    }

    // If setting as primary, unset other primary contacts
    if (isPrimary) {
      await query(
        'UPDATE emergency_contacts SET is_primary = false WHERE student_id = $1 AND id != $2',
        [req.student.id, id]
      )
    }

    const result = await query(`
      UPDATE emergency_contacts 
      SET 
        contact_type = COALESCE($1, contact_type),
        full_name = COALESCE($2, full_name),
        relationship = COALESCE($3, relationship),
        phone_primary = COALESCE($4, phone_primary),
        phone_secondary = COALESCE($5, phone_secondary),
        email = COALESCE($6, email),
        address = COALESCE($7, address),
        is_primary = COALESCE($8, is_primary),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9 AND student_id = $10
      RETURNING *
    `, [
      contactType, fullName, relationship, phonePrimary,
      phoneSecondary, email, address, isPrimary, id, req.student.id
    ])

    res.json({
      success: true,
      message: 'Emergency contact updated successfully',
      data: result.rows[0]
    })

  } catch (error) {
    logger.error('Update emergency contact error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to update emergency contact'
    })
  }
})

/**
 * @route   DELETE /api/v1/students/emergency-contacts/:id
 * @desc    Delete emergency contact
 * @access  Private (Students only)
 */
router.delete('/emergency-contacts/:id', [auth, studentOnly], async (req, res) => {
  try {
    const { id } = req.params

    const result = await query(
      'DELETE FROM emergency_contacts WHERE id = $1 AND student_id = $2 RETURNING id',
      [id, req.student.id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Emergency contact not found'
      })
    }

    logger.info('Emergency contact deleted', {
      studentId: req.student.id,
      contactId: id
    })

    res.json({
      success: true,
      message: 'Emergency contact deleted successfully'
    })

  } catch (error) {
    logger.error('Delete emergency contact error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to delete emergency contact'
    })
  }
})

/**
 * @route   GET /api/v1/students/dashboard
 * @desc    Get student dashboard data
 * @access  Private (Students only)
 */
router.get('/dashboard', [auth, studentOnly], async (req, res) => {
  try {
    // Get basic student info
    const studentResult = await query(`
      SELECT s.first_name, s.last_name, s.student_id, sa.current_level, sa.cgpa
      FROM students s
      LEFT JOIN student_academics sa ON s.id = sa.student_id
      WHERE s.id = $1
    `, [req.student.id])

    if (studentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      })
    }

    const student = studentResult.rows[0]

    // Get subscription status
    const subscriptionStatus = await PaymentService.getSubscriptionStatus(req.student.id)

    // Get recent AI chat sessions
    const recentChatsResult = await query(`
      SELECT id, title, started_at, message_count
      FROM ai_chat_sessions
      WHERE student_id = $1
      ORDER BY started_at DESC
      LIMIT 5
    `, [req.student.id])

    // Get upcoming course registrations or deadlines (mock data for now)
    const upcomingEvents = [
      {
        type: 'Course Registration',
        title: 'Second Semester Registration',
        date: '2024-01-15',
        description: 'Registration deadline for 2023/2024 second semester'
      }
    ]

    res.json({
      success: true,
      data: {
        student: {
          firstName: student.first_name,
          lastName: student.last_name,
          studentId: student.student_id,
          currentLevel: student.current_level,
          cgpa: student.cgpa
        },
        subscription: subscriptionStatus,
        recentChats: recentChatsResult.rows,
        upcomingEvents,
        notifications: {
          unread: 0 // TODO: Implement notifications count
        }
      }
    })

  } catch (error) {
    logger.error('Get student dashboard error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get dashboard data'
    })
  }
})

module.exports = router
