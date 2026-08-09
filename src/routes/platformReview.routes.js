const express = require('express');
const router = express.Router();
const platformReviewController = require('../controllers/platformReview.controller');
const { optionalAuth } = require('../middleware/auth.middleware');

// DIRECT REQUEST: RentaPay itself can be reviewed - by logged-in
// users AND anonymous visitors with no account. optionalAuth attaches
// req.user if a valid token is present, but never requires one.
router.get('/', platformReviewController.listReviews);
router.post('/', optionalAuth, platformReviewController.submitReview);

module.exports = router;
