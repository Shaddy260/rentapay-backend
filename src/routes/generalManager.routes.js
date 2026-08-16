// src/routes/generalManager.routes.js
//
// RentaPay — General Manager Accounts (Sectioned Build Spec).
//
// Distinct from admin.routes.js's /general-managers endpoints (admin
// managing GM accounts - Section 2). This file is the GM's OWN
// self-service actions on their own account - every route here is
// requireRole('general_manager'), never 'admin', since these act on
// req.user.id (the caller's own account) rather than a target id from
// the URL. Mounted at /api/manager-account in server.js, matching the
// dedicated frontend URL from Section 3.

const express = require('express');
const router = express.Router();
const generalManagerController = require('../controllers/generalManager.controller');
const generalManagerLogController = require('../controllers/generalManagerLog.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken, requireRole('general_manager'));

// SECTION 4 — Operations PIN Setup (Onboarding + Settings)
router.post('/operations-pin', generalManagerController.setOperationsPin);
router.patch('/operations-pin', generalManagerController.changeOperationsPin);
router.post('/operations-pin/forgot', generalManagerController.requestOperationsPinReset);
router.post('/operations-pin/reset', generalManagerController.resetOperationsPin);

// SECTION 8 — a General Manager's own dedicated log page (day/week/
// month views of their own PIN-confirmed activity). Always reads
// req.user.id - there is no id param here, so a General Manager can
// never browse anyone else's history this way.
router.get('/my-logs', generalManagerLogController.getMyLogs);

module.exports = router;
