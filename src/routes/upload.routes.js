// src/routes/upload.routes.js
const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/upload.controller');
const { handleProfilePhotoUpload } = require('../middleware/upload.middleware');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.post(
  '/profile-photo',
  verifyToken,
  requireRole('landlord', 'manager', 'tenant', 'scout'),
  handleProfilePhotoUpload,
  uploadController.uploadProfilePhoto
);

router.delete('/profile-photo', verifyToken, requireRole('landlord', 'manager', 'tenant', 'scout'), uploadController.removeProfilePhoto);

module.exports = router;
