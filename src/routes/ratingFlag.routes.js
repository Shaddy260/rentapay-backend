const express = require('express');
const router = express.Router();
const ratingFlagController = require('../controllers/ratingFlag.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

// Landlord views their own individual ratings (identity-safe columns
// only - see SAFE_COLUMNS in the controller) so they have something
// to flag in the first place. Manager/caretaker can view too, same
// as they can view the aggregate, but only the landlord can flag.
router.get('/:table/mine', requireRole('landlord', 'manager'), ratingFlagController.listMyRatings);

// Landlord flags a rating on their own account as bad-faith - see
// sql/add-rating-flag-for-review.sql and ratingFlag.controller.js for
// the full design. Managers/caretakers act on the landlord's behalf
// for most things in this app, but a flag is a claim of bad faith
// against a specific rating - keeping it landlord-only avoids a
// caretaker being able to quietly bury a rating about themselves.
router.post('/:table/:id/flag', requireRole('landlord'), ratingFlagController.flagRating);

module.exports = router;
