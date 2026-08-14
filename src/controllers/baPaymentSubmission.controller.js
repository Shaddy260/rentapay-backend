// src/controllers/baPaymentSubmission.controller.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 2.
//
// Two PUBLIC endpoints, mounted alongside the Phase 1 payout-link
// routes:
//   POST /api/brand-ambassadors/payout-link/submit   - BA submits
//        (or resubmits/overwrites) their M-Pesa number, name, and
//        account email for the current month's active cycle.
//   GET  /api/brand-ambassadors/payout-link/my-submission
//        ?token=...&email=...  - lets the BA re-open the confirmation
//        view later in the same month to see what they submitted.
//
// Both require the ?token= to still match the current active cycle
// (see baPayoutLinkCycle.service.validateSubmissionToken) - a token
// from a month that has since rolled over is treated as dead, same as
// Phase 1's /payout-link/validate.

const { isValidEmail } = require('../utils/email');
const { submitPaymentDetails, getMySubmission } = require('../services/baPaymentSubmission.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// PUBLIC - submit payment details for the current cycle.
// ---------------------------------------------------------------------
async function submitPayoutLinkDetails(req, res) {
  try {
    const { token, email, mpesaNumber, name } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!mpesaNumber || !String(mpesaNumber).trim()) {
      return res.status(400).json({ error: 'Please enter the M-Pesa number to be paid.' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Please enter the name registered on this M-Pesa number.' });
    }

    const { submission, cycle, ba } = await submitPaymentDetails({
      token,
      email,
      mpesaNumber,
      submittedName: name,
    });

    return res.json({
      message: 'Your payment details have been received. Thank you!',
      submission: {
        id: submission.id,
        periodKey: cycle.period_key,
        mpesaNumber: submission.mpesa_number,
        submittedName: submission.submitted_name,
        submittedEmail: submission.submitted_email,
        submittedAt: submission.submitted_at,
        baName: ba.full_name,
      },
    });
  } catch (err) {
    if (err.linkInvalid) {
      return res.status(410).json({ error: err.message, linkExpired: true });
    }
    if (err.baNotFound) {
      return res.status(404).json({ error: err.message });
    }
    if (err.validation) {
      return res.status(400).json({ error: err.message });
    }
    // normalizePhoneOrThrow throws a plain Error with a user-facing
    // message for malformed numbers - surface it as a 400 rather than
    // a generic 500.
    if (/doesn't look like a valid/.test(err.message || '')) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('[baPaymentSubmission] submitPayoutLinkDetails error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit your payment details. Please try again.' });
  }
}

// ---------------------------------------------------------------------
// PUBLIC - re-fetch the BA's own submission for the current cycle, so
// the frontend can show/edit it again later in the same month.
// ---------------------------------------------------------------------
async function getMyPayoutLinkSubmission(req, res) {
  try {
    const { token, email } = req.query;
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const submission = await getMySubmission({ token, email });
    if (!submission) {
      return res.json({ found: false });
    }
    return res.json({
      found: true,
      submission: {
        id: submission.id,
        mpesaNumber: submission.mpesa_number,
        submittedName: submission.submitted_name,
        submittedEmail: submission.submitted_email,
        submittedAt: submission.submitted_at,
        status: submission.status,
      },
    });
  } catch (err) {
    if (err.linkInvalid) {
      return res.status(410).json({ error: err.message, linkExpired: true });
    }
    logger.error('[baPaymentSubmission] getMyPayoutLinkSubmission error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your submission.' });
  }
}

module.exports = {
  submitPayoutLinkDetails,
  getMyPayoutLinkSubmission,
};
