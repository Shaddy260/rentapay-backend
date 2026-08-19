// src/routes/utilitySubmetering.routes.js
//
// Utility Sub-Metering - see RentaPay-Utility-Submetering-Spec.pdf.
// Caretaker, manager, or landlord may submit/correct readings and
// work the review screen (Sections 1-6) - caretaker is a roleLevel
// under 'manager' in this app, not a separate top-level role, so
// requireRole('landlord', 'manager') already covers all three.

const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/utilitySubmetering.controller');

router.use(verifyToken, requireRole('landlord', 'manager'));

router.post('/meters', ctrl.createMeter);
router.post('/meters/bulk', ctrl.bulkCreateMeters);
router.get('/meters', ctrl.listMeters);
router.patch('/meters/:meterId', ctrl.updateMeter);
router.delete('/meters/:meterId', ctrl.deleteMeter);

router.post('/meters/:meterId/readings', ctrl.submitReading);
router.post('/readings/bulk', ctrl.bulkSubmitReadings);
router.get('/meters/:meterId/readings', ctrl.listReadings);
router.patch('/readings/:readingId', ctrl.correctReading);
router.get('/readings/:readingId/corrections', ctrl.getReadingCorrections);

router.get('/readings/:readingId/review', ctrl.getReview);
router.patch('/runs/:runId/units/:runUnitId', ctrl.overrideRunUnit);
router.post('/runs/:runId/finalize', ctrl.finalizeRun);

module.exports = router;
