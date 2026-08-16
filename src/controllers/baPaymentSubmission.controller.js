// src/controllers/baPaymentSubmission.controller.js
//
// BUILD SPEC PHASE 10 (v2) - Universal BA Payout Links + Email/OTP Gate.
//
// PUBLIC endpoints (submission - one static, universal, non-expiring
// link at /ba-payout-submit on the frontend):
//   POST /api/brand-ambassadors/payout-link/submit/request-otp
//   POST /api/brand-ambassadors/payout-link/submit/verify-otp
//   POST /api/brand-ambassadors/payout-link/submit
//   GET  /api/brand-ambassadors/payout-link/my-submission?verificationToken=...
//
// PUBLIC endpoints (correction - universal, admin-issued, 24h-rotating
// link at /ba-payout-edit?token=... on the frontend):
//   GET  /api/brand-ambassadors/payout-link/edit/validate?token=...
//   POST /api/brand-ambassadors/payout-link/edit/request-otp
//   POST /api/brand-ambassadors/payout-link/edit/verify-otp
//   POST /api/brand-ambassadors/payout-link/edit
//
// ADMIN endpoints (mounted here too, small enough not to warrant their
// own controller file):
//   GET  /api/brand-ambassadors/payout-link/edit-link/status
//   POST /api/brand-ambassadors/payout-link/edit-link/generate

const { isValidEmail } = require('../utils/email');
const { submitPaymentDetails, applyEdit, getMySubmission } = require('../services/baPaymentSubmission.service');
const {
  requestOtp,
  verifyOtp,
  validateEditLinkToken,
  getEditLinkStatus,
  generateEditLink,
} = require('../services/baPayoutSubmissionLink.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

function handleKnownErrors(res, err, fallbackMessage) {
  if (err.duplicate) return res.status(409).json({ error: err.message, duplicateSubmission: true });
  if (err.linkInvalid) return res.status(410).json({ error: err.message, linkExpired: true });
  if (err.notFound) return res.status(404).json({ error: err.message });
  if (err.validation) return res.status(400).json({ error: err.message });
  if (/doesn't look like a valid/.test(err.message || '')) return res.status(400).json({ error: err.message });
  logger.error(`[baPaymentSubmission] ${fallbackMessage}:`, err.message);
  captureException(err);
  return res.status(500).json({ error: fallbackMessage });
}

// ===================== Submission (universal link) =====================

async function requestSubmitOtp(req, res) {
  try {
    const { email } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    await requestOtp({ email, purpose: 'submit' });
    return res.json({ message: 'If that email belongs to an eligible Brand Ambassador account, a verification code has been sent to it.' });
  } catch (err) {
    return handleKnownErrors(res, err, 'Failed to send a verification code.');
  }
}

async function verifySubmitOtp(req, res) {
  try {
    const { email, code } = req.body || {};
    const result = await verifyOtp({ email, purpose: 'submit', code });
    return res.json(result);
  } catch (err) {
    return handleKnownErrors(res, err, 'Failed to verify the code.');
  }
}

async function submitPayoutLinkDetails(req, res) {
  try {
    const { verificationToken, mpesaNumber, name } = req.body || {};
    if (!mpesaNumber || !String(mpesaNumber).trim()) {
      return res.status(400).json({ error: 'Please enter the M-Pesa number to be paid.' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Please enter the name registered on this M-Pesa number.' });
    }

    const { submission, ba } = await submitPaymentDetails({ verificationToken, mpesaNumber, submittedName: name });

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
    return handleKnownErrors(res, err, 'Failed to submit your payment details. Please try again.');
  }
}

// ===================== Correction (universal 24h edit link) ============

async function validateEditLink(req, res) {
  try {
    const { token } = req.query;
    const result = await validateEditLinkToken(token);
    if (!result.ok) return res.status(410).json({ valid: false, error: result.error });
    return res.json({ valid: true });
  } catch (err) {
    logger.error('[baPaymentSubmission] validateEditLink error:', err.message);
    captureException(err);
    return res.status(500).json({ valid: false, error: 'Failed to validate this link.' });
  }
}

async function requestEditOtp(req, res) {
  try {
    const { email, token } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    await requestOtp({ email, purpose: 'edit', editLinkToken: token });
    return res.json({ message: 'If that email belongs to a Brand Ambassador with details already on file, a code has been sent to it.' });
  } catch (err) {
    return handleKnownErrors(res, err, 'Failed to send a verification code.');
  }
}

async function verifyEditOtp(req, res) {
  try {
    const { email, code } = req.body || {};
    const result = await verifyOtp({ email, purpose: 'edit', code });
    return res.json(result);
  } catch (err) {
    return handleKnownErrors(res, err, 'Failed to verify the code.');
  }
}

async function editPayoutLinkDetails(req, res) {
  try {
    const { verificationToken, mpesaNumber, name } = req.body || {};
    if (!mpesaNumber || !String(mpesaNumber).trim()) {
      return res.status(400).json({ error: 'Please enter the M-Pesa number to be paid.' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Please enter the name registered on this M-Pesa number.' });
    }

    const { submission, ba } = await applyEdit({ verificationToken, mpesaNumber, submittedName: name });

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
    return handleKnownErrors(res, err, 'Failed to update your payment details. Please try again.');
  }
}

// PUBLIC - re-fetch the verified BA's own on-file submission (used by
// the edit flow to prefill the form after OTP verification).
async function getMyPayoutLinkSubmission(req, res) {
  try {
    const { verificationToken, purpose } = req.query;
    if (!verificationToken) {
      return res.status(400).json({ error: 'Please verify your email with the code first.' });
    }
    const submission = await getMySubmission({ verificationToken, purpose: purpose === 'submit' ? 'submit' : 'edit' });
    if (!submission) return res.json({ found: false });
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
    return handleKnownErrors(res, err, 'Failed to load your submission.');
  }
}

// ===================== Admin - manage the edit link =====================

async function getEditLinkStatusHandler(req, res) {
  try {
    const status = await getEditLinkStatus();
    return res.json(status);
  } catch (err) {
    logger.error('[baPaymentSubmission] getEditLinkStatusHandler error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the correction link.' });
  }
}

async function postGenerateEditLink(req, res) {
  try {
    const result = await generateEditLink({ adminId: req.user?.id || null });
    return res.status(201).json(result);
  } catch (err) {
    logger.error('[baPaymentSubmission] postGenerateEditLink error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to generate a new correction link.' });
  }
}

module.exports = {
  requestSubmitOtp,
  verifySubmitOtp,
  submitPayoutLinkDetails,
  validateEditLink,
  requestEditOtp,
  verifyEditOtp,
  editPayoutLinkDetails,
  getMyPayoutLinkSubmission,
  getEditLinkStatusHandler,
  postGenerateEditLink,
};
