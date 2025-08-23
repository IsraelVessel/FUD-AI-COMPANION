const express = require('express')
const { auth, alumniOnly } = require('../middleware/auth')

const router = express.Router()

router.get('/profile', [auth, alumniOnly], async (req, res) => {
  res.json({
    success: true,
    message: 'Alumni profile endpoint - To be implemented'
  })
})

router.get('/directory', [auth, alumniOnly], async (req, res) => {
  res.json({
    success: true,
    message: 'Alumni directory endpoint - To be implemented'
  })
})

module.exports = router
