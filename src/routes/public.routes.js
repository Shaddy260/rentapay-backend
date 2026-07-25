const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');

// Deliberately NOT behind verifyToken - this is the free, public,
// no-login vacant-unit listings surface (direct request: "fully
// open, no login needed to search").
router.get('/listings', publicController.listVacantUnits);
router.get('/listings/counties', publicController.listSearchableAreas);
router.get('/listings/:unitId/contact', publicController.getUnitContact);

module.exports = router;
