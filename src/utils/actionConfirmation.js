// src/utils/actionConfirmation.js
//
// RentaPay — General Manager Sectioned Build Spec, Section 6.
//
// A handful of admin controllers (landlord suspend/activate/delete,
// Brand Ambassador suspend/reactivate/offboard/restore, ...) were
// written back when only admin could ever call them, and each one
// independently re-checks the admin's own login password before doing
// anything destructive. Section 5 opened their ROUTES up to General
// Manager too (read-only), and Section 6 now opens the WRITES up as
// well - but a General Manager confirms differently:
//
//   - admin confirms with their own login password, exactly as
//     before (unchanged).
//   - general_manager confirms with their Operations PIN + a
//     mandatory reason, already verified by
//     requireOperationsPinConfirmation at the router level, before
//     the request ever reaches a controller. Per the spec: "The login
//     password plays no role here - it's used only to log in." A
//     General Manager caller will never have (or be asked for) the
//     admin password.
//
// Controllers reachable by both roles call confirmAdminOrGmAction(req)
// once at the top instead of hand-rolling verifyAdminPassword(password)
// - it does the right check for whichever role is actually calling.

const { comparePassword } = require('./password');

async function verifyAdminPassword(password) {
  const adminPasswordHash = process.env.SUPER_ADMIN_PASSWORD_HASH;
  if (!adminPasswordHash || !password) return false;
  return comparePassword(password, adminPasswordHash);
}

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function confirmAdminOrGmAction(req) {
  if (req.user && req.user.role === 'general_manager') {
    // Already PIN+reason confirmed by requireOperationsPinConfirmation
    // before this request reached the controller.
    return { ok: true };
  }
  const passwordOk = await verifyAdminPassword(req.body && req.body.password);
  return passwordOk ? { ok: true } : { ok: false, error: 'Incorrect admin password.' };
}

/** True if this request was made (and PIN+reason confirmed) by a General Manager rather than admin. */
function isGmAction(req) {
  return !!(req.user && req.user.role === 'general_manager');
}

module.exports = { verifyAdminPassword, confirmAdminOrGmAction, isGmAction };
