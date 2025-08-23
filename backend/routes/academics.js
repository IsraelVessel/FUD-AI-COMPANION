const express = require('express')
const { auth, studentOnly } = require('../middleware/auth')

const router = express.Router()

router.get('/courses', [auth, studentOnly], async (req, res) => {
  res.json({
    success: true,
    message: 'Courses endpoint - To be implemented'
  })
})

router.get('/results', [auth, studentOnly], async (req, res) => {
  res.json({
    success: true,
    message: 'Academic results endpoint - To be implemented'
  })
})

module.exports = router
