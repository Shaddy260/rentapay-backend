const express = require('express');
const router = express.Router();
const pushController = require('../controllers/push.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Public - the frontend needs this before the person is necessarily
// logged in isn't required here (subscribing itself does need auth,
// but the public key alone is not sensitive - it's sent to the push
// service by design).
router.get('/vapid-public-key', pushController.getVapidPublicKey);

router.use(verifyToken);
router.post('/subscribe', pushController.subscribe);
router.post('/unsubscribe', pushController.unsubscribe);

module.exports = router;
