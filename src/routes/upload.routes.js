// src/routes/upload.routes.js
const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/upload.controller');
const { handleProfilePhotoUpload, handleMeterReadingPhotoUpload } = require('../middleware/upload.middleware');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.post(
  '/profile-photo',
  verifyToken,
  requireRole('landlord', 'manager', 'tenant', 'brand_ambassador', 'general_manager'),
  handleProfilePhotoUpload,
  uploadController.uploadProfilePhoto
);

router.delete('/profile-photo', verifyToken, requireRole('landlord', 'manager', 'tenant', 'brand_ambassador', 'general_manager'), uploadController.removeProfilePhoto);

// Utility sub-metering meter-reading photo (Section 1) - caretaker,
// manager, or landlord may all submit a reading, so all three may
// upload its proof photo.
router.post(
  '/meter-reading-photo',
  verifyToken,
  requireRole('landlord', 'manager'),
  handleMeterReadingPhotoUpload,
  uploadController.uploadMeterReadingPhoto
);

module.exports = router;
