// src/routes/settings.routes.js
const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/settings.controller');

// Public router - mount at /api/settings (no auth). Read by every
// portal's Help modal, including the logged-out login screen.
const publicRouter = express.Router();
publicRouter.get('/public/help-contacts', ctrl.getPublicHelpContacts);

// Admin router - mount at /api/admin/settings.
const adminRouter = express.Router();
adminRouter.get('/', verifyToken, requireRole('admin'), ctrl.getAdminSettings);
adminRouter.patch('/help-contacts', verifyToken, requireRole('admin'), ctrl.updateHelpContacts);

module.exports = { publicRouter, adminRouter };
