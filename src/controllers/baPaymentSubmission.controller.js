// src/controllers/baPaymentSubmission.controller.js
//
// BUILD SPEC PHASE 10 - Fix: BA Payout Submission Overwrite Bug.
//
// PUBLIC endpoints:
//   POST /api/brand-ambassadors/payout-link/submit
//        - the BA's ONE-TIME submission (M-Pesa number, name, account
//          email). No resubmission - see the service for the full
//          server-side duplicate guard.
//   GET  /api/brand-ambassadors/payout-link/my-submission
//        ?token=...&email=...  - re-open the confirmation view.
//   POST /api/brand-ambassadors/payout-link/edit-submit
//        - the ONLY correction path: requires a valid, unexpired,
//          unused 24h admin-issued edit link (?editToken=).
//
// ADMIN endpoint (mounted here too, small enough not to warrant its
// own controller file):
//   POST /api/brand-ambassadors/:id/payout-link/generate-edit-link

const { isValidEmail } = require('../utils/email');
const { submitPaymentDetails, applyEdit, getMySubmission } = require('../services/baPaymentSubmission.service');
const { generateEditLink } = require('../services/baPayoutSubmissionLink.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// PUBLIC - the one-time submission.
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

    const { submission, ba } = await submitPaymentDetails({
      token,
      email,
      mpesaNumber,
      submittedName: name,
    });

    return res.json({
      message: 'Your payment details have been received. Thank you! This link has now been used and cannot be submitted again - if anything needs correcting later, ask RentaPay for a correction link.',
      submission: {
        id: submission.id,
        mpesaNumber: submission.mpesa_number,
        submittedName: submission.submitted_name,
        submittedEmail: submission.submitted_email,
        submittedAt: submission.submitted_at,
        baName: ba.full_name,
      },
    });
  } catch (err) {
    if (err.duplicate) {
      return res.status(409).json({ error: err.message, duplicateSubmission: true });
    }
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
// PUBLIC - the only correction path: a valid 24h admin-issued edit
// link. Never a second pass through submitPayoutLinkDetails.
// ---------------------------------------------------------------------
async function editPayoutLinkDetails(req, res) {
  try {
    const { editToken, mpesaNumber, name, email } = req.body || {};
    if (!mpesaNumber || !String(mpesaNumber).trim()) {
      return res.status(400).json({ error: 'Please enter the M-Pesa number to be paid.' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Please enter the name registered on this M-Pesa number.' });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const { submission, ba } = await applyEdit({
      editToken,
      mpesaNumber,
      submittedName: name,
      email,
    });

    return res.json({
      message: 'Your payment details have been updated. Thank you!',
      submission: {
        id: submission.id,
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
    if (err.notFound) {
      return res.status(404).json({ error: err.message });
    }
    if (err.validation) {
      return res.status(400).json({ error: err.message });
    }
    if (/doesn't look like a valid/.test(err.message || '')) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('[baPaymentSubmission] editPayoutLinkDetails error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update your payment details. Please try again.' });
  }
}

// ---------------------------------------------------------------------
// PUBLIC - re-fetch the BA's own on-file submission, by either their
// original (now-used) submission token or a valid edit token, so the
// frontend can show/prefill it again.
// ---------------------------------------------------------------------
async function getMyPayoutLinkSubmission(req, res) {
  try {
    const { token, editToken, email } = req.query;
    if (!editToken && (!email || !isValidEmail(email))) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const submission = await getMySubmission({ token, editToken, email });
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

// ---------------------------------------------------------------------
// ADMIN - generate the 24h edit link for a BA who already submitted
// once. The only route back into their details.
// ---------------------------------------------------------------------
async function postGenerateEditLink(req, res) {
  try {
    const { id } = req.params;
    const result = await generateEditLink({ baId: id, adminId: req.user?.id || null });
    return res.status(201).json(result);
  } catch (err) {
    if (err.notFound) {
      return res.status(404).json({ error: err.message });
    }
    if (err.validation) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('[baPaymentSubmission] postGenerateEditLink error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to generate an edit link.' });
  }
}

module.exports = {
  submitPayoutLinkDetails,
  editPayoutLinkDetails,
  getMyPayoutLinkSubmission,
  postGenerateEditLink,
};
