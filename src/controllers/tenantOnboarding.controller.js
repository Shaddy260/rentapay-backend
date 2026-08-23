// src/controllers/tenantOnboarding.controller.js
//
// FEATURE: Tenant Self-Onboarding via Shared Link.
//
// A landlord/manager/caretaker generates one shareable link per
// property (see getOrCreateLink). Tenants open the link with no
// login, pick their own vacant unit, and fill in the same details a
// landlord would type in manually. That becomes a pending "request"
// any of the three roles can review, correct, and confirm - at which
// point it's written into `tenants` exactly the way addTenant does
// (via tenant.controller.js's shared createTenantRecord).

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { findEmailConflict } = require('../utils/emailUniqueness');
const { createTenantRecord } = require('./tenant.controller');
const { notify } = require('../services/notify.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');
const { generateOTP, getEmailVerificationOTPExpiry, isOTPExpired } = require('../utils/otp');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------
// Recipients for a property: the landlord + every manager/caretaker
// actually assigned to it. Centralized here so "new request" and
// "confirmed" notifications can't drift out of sync with each other.
// ---------------------------------------------------------------------
async function getPropertyStakeholders(landlordId, propertyId) {
  const [{ data: landlord }, { data: assignments }] = await Promise.all([
    supabase.from('landlords').select('id, email').eq('id', landlordId).maybeSingle(),
    supabase
      .from('property_manager_assignments')
      .select('property_managers(id, email, is_active, role_level)')
      .eq('property_id', propertyId),
  ]);

  const staff = (assignments || [])
    .map((a) => a.property_managers)
    .filter((m) => m && m.is_active !== false);

  return {
    landlord,
    managers: staff.filter((m) => m.role_level !== 'caretaker'),
    caretakers: staff.filter((m) => m.role_level === 'caretaker'),
  };
}

// Fires the "new/updated onboarding request" notice - in-app + push to
// all three roles, email to landlord + manager only (never caretaker),
// per the feature's notification table.
async function notifyNewRequest(landlordId, propertyId, requestSummary) {
  const { landlord, managers, caretakers } = await getPropertyStakeholders(landlordId, propertyId);
  const message = `${requestSummary.fullName} submitted a tenant onboarding request for Unit ${requestSummary.unitName}. Review and confirm in Tenant Onboarding Requests.`;
  const jobs = [];
  if (landlord) jobs.push(notify('landlord', landlord.id, null, message, { category: 'account', propertyId }));
  for (const m of managers) jobs.push(notify('manager', m.id, null, message, { category: 'account', propertyId }));
  for (const c of caretakers) jobs.push(notify('manager', c.id, null, message, { category: 'account', propertyId, skipEmail: true }));
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => { if (r.status === 'rejected') logger.error('[tenantOnboarding] notifyNewRequest delivery failed:', r.reason?.message || r.reason); });
}

// Fires the "confirmed" notice - in-app + push to all three roles,
// no email to anyone (per the notification table).
async function notifyConfirmed(landlordId, propertyId, requestSummary, confirmedByName) {
  const { landlord, managers, caretakers } = await getPropertyStakeholders(landlordId, propertyId);
  const message = `${requestSummary.fullName}'s onboarding for Unit ${requestSummary.unitName} was confirmed by ${confirmedByName}.`;
  const jobs = [];
  if (landlord) jobs.push(notify('landlord', landlord.id, null, message, { category: 'account', propertyId, skipEmail: true }));
  for (const m of managers) jobs.push(notify('manager', m.id, null, message, { category: 'account', propertyId, skipEmail: true }));
  for (const c of caretakers) jobs.push(notify('manager', c.id, null, message, { category: 'account', propertyId, skipEmail: true }));
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => { if (r.status === 'rejected') logger.error('[tenantOnboarding] notifyConfirmed delivery failed:', r.reason?.message || r.reason); });
}

// ---------------------------------------------------------------------
// AUTHENTICATED - landlord / manager / caretaker
// ---------------------------------------------------------------------

/** GET /api/tenant-onboarding/link/:propertyId - get-or-create the property's onboarding link. */
async function getOrCreateLink(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId } = req.params;

    const { data: property, error: propErr } = await supabase.from('properties').select('id, landlord_id, name').eq('id', propertyId).maybeSingle();
    if (propErr) throw propErr;
    if (!property || property.landlord_id !== landlordId) return res.status(404).json({ error: 'Property not found.' });

    const { data: existing, error: existingErr } = await supabase
      .from('tenant_onboarding_links')
      .select('token')
      .eq('property_id', propertyId)
      .maybeSingle();
    if (existingErr) throw existingErr;

    if (existing) return res.json({ token: existing.token, propertyName: property.name });

    const token = generateToken();
    const { data: created, error: createErr } = await supabase
      .from('tenant_onboarding_links')
      .insert({ landlord_id: landlordId, property_id: propertyId, token })
      .select('token')
      .single();
    if (createErr) throw createErr;

    return res.status(201).json({ token: created.token, propertyName: property.name });
  } catch (err) {
    logger.error('[tenantOnboarding] getOrCreateLink error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to generate onboarding link.' });
  }
}

/** GET /api/tenant-onboarding/requests?propertyId= - review list + pending count. */
async function listOnboardingRequests(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId } = req.query;
    const isManager = req.user.role === 'manager';

    let assignedPropertyIds = null;
    if (isManager) {
      assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (propertyId && !assignedPropertyIds.includes(propertyId)) {
        return res.status(403).json({ error: 'You have not been given access to this property.', notAssigned: true });
      }
    }

    let query = supabase
      .from('tenant_onboarding_requests')
      .select('*, units(unit_name), properties(name)')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (propertyId) query = query.eq('property_id', propertyId);
    else if (isManager) {
      query = assignedPropertyIds.length
        ? query.in('property_id', assignedPropertyIds)
        : query.eq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { data, error } = await query;
    if (error) throw error;

    const requests = data || [];
    return res.json({
      requests,
      pendingCount: requests.filter((r) => r.status === 'pending').length,
    });
  } catch (err) {
    logger.error('[tenantOnboarding] listOnboardingRequests error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load onboarding requests.' });
  }
}

// JWTs here only carry { id, role, landlordId?, roleLevel? } - no
// display name - so "Confirmed by [role/name]" needs a quick lookup.
// Returns both the display name and the role_level (manager/caretaker,
// null for a landlord) so confirmOnboardingRequest can store the
// latter in confirmed_by_role_level without a second query.
async function resolveActorNameAndLevel(user) {
  try {
    if (user.role === 'manager') {
      const { data } = await supabase.from('property_managers').select('full_name, role_level').eq('id', user.id).maybeSingle();
      if (data) {
        const roleLevel = data.role_level === 'caretaker' ? 'caretaker' : 'manager';
        return { name: `${data.full_name}${roleLevel === 'caretaker' ? ' (caretaker)' : ' (manager)'}`, roleLevel };
      }
      return { name: 'a property manager', roleLevel: 'manager' };
    }
    const { data } = await supabase.from('landlords').select('full_name').eq('id', user.id).maybeSingle();
    return { name: data?.full_name || 'the landlord', roleLevel: null };
  } catch (err) {
    logger.error('[tenantOnboarding] resolveActorNameAndLevel failed:', err.message);
    return { name: user.role === 'manager' ? 'a property manager' : 'the landlord', roleLevel: user.role === 'manager' ? 'manager' : null };
  }
}

async function loadOwnedRequest(req) {
  const landlordId = effectiveLandlordId(req);
  const { data: request, error } = await supabase
    .from('tenant_onboarding_requests')
    .select('*, units(unit_name, status), properties(name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) throw error;
  if (!request || request.landlord_id !== landlordId) return { errorRes: { statusCode: 404, error: 'Onboarding request not found.' } };

  if (req.user.role === 'manager') {
    const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
    if (assignedPropertyIds.length && !assignedPropertyIds.includes(request.property_id)) {
      return { errorRes: { statusCode: 403, error: 'You have not been given access to this property.', notAssigned: true } };
    }
  }
  return { request };
}

/** PATCH /api/tenant-onboarding/requests/:id - correct a mistake (wrong unit/email/etc.) before confirming. */
async function editOnboardingRequest(req, res) {
  try {
    const { request, errorRes } = await loadOwnedRequest(req);
    if (errorRes) return res.status(errorRes.statusCode).json(errorRes);
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been resolved and can no longer be edited.' });

    // SECTION 9 - the tenant already verified this exact email address
    // by OTP before the request could even be submitted (see
    // submitOnboardingRequest). Email is therefore deliberately NOT
    // editable from this endpoint, under any circumstance - it's
    // excluded from `editable` entirely (not just hidden in the UI) so
    // a request built by hand against the API can't change it either.
    // If a tenant's email is genuinely wrong, the fix is to delete the
    // request and have them resubmit with a freshly-verified address.
    const editable = ['fullName', 'primaryPhone', 'secondaryPhone', 'idNumber', 'moveInDate', 'emergencyContactName', 'emergencyContactPhone', 'unitId', 'depositAmountPaid'];
    const columnMap = {
      fullName: 'full_name',
      primaryPhone: 'primary_phone',
      secondaryPhone: 'secondary_phone',
      idNumber: 'id_number',
      moveInDate: 'move_in_date',
      emergencyContactName: 'emergency_contact_name',
      emergencyContactPhone: 'emergency_contact_phone',
      unitId: 'unit_id',
      depositAmountPaid: 'deposit_amount_paid',
    };

    const update = {};
    for (const key of editable) {
      if (req.body[key] === undefined) continue;
      update[columnMap[key]] = req.body[key];
    }

    // DIRECT REQUEST: "highlight the deposit field so the landlord or
    // whoever is submitting should see, and correct if it's wrong" -
    // this is the correction path. Empty string means "clear it back
    // to blank", anything else must be a valid non-negative number.
    if (Object.prototype.hasOwnProperty.call(update, 'deposit_amount_paid')) {
      const raw = update.deposit_amount_paid;
      if (raw === null || raw === '' || raw === undefined) {
        update.deposit_amount_paid = null;
      } else {
        const parsed = Number(raw);
        if (Number.isNaN(parsed) || parsed < 0) {
          return res.status(400).json({ error: 'Deposit amount paid must be a valid, non-negative number.' });
        }
        update.deposit_amount_paid = parsed;
      }
    }


    if (update.primary_phone) {
      try {
        update.primary_phone = normalizePhoneOrThrow(update.primary_phone, 'Tenant phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }
    if (update.emergency_contact_phone) {
      try {
        update.emergency_contact_phone = normalizePhoneOrThrow(update.emergency_contact_phone, 'Emergency contact phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }
    if (update.unit_id) {
      const { data: unit } = await supabase.from('units').select('id, property_id, status').eq('id', update.unit_id).maybeSingle();
      if (!unit || unit.property_id !== request.property_id) return res.status(400).json({ error: 'That unit does not belong to this property.' });
      if (unit.status !== 'vacant') return res.status(400).json({ error: 'That unit is not vacant.' });
    }

    if (Object.keys(update).length === 0) return res.json({ request });

    const { data: updated, error } = await supabase
      .from('tenant_onboarding_requests')
      .update(update)
      .eq('id', request.id)
      .select('*, units(unit_name, status), properties(name)')
      .single();
    if (error) throw error;

    return res.json({ request: updated });
  } catch (err) {
    logger.error('[tenantOnboarding] editOnboardingRequest error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update onboarding request.' });
  }
}

/**
 * DELETE /api/tenant-onboarding/requests/:id - discard a pending
 * request (direct request: "if a random person sends the details,
 * they will sit there needing confirmation... there should be a way
 * to delete"). Only pending requests can be deleted this way -
 * confirmed ones are real tenant history (deleting would orphan
 * resulting_tenant_id's audit trail), and superseded ones are already
 * inert. Any of the three roles can delete, same as edit/confirm.
 */
async function deleteOnboardingRequest(req, res) {
  try {
    const { request, errorRes } = await loadOwnedRequest(req);
    if (errorRes) return res.status(errorRes.statusCode).json(errorRes);
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be deleted. Confirmed or superseded requests are kept as history.' });
    }

    const { error } = await supabase.from('tenant_onboarding_requests').delete().eq('id', request.id);
    if (error) throw error;

    return res.json({ message: 'Request deleted.' });
  } catch (err) {
    logger.error('[tenantOnboarding] deleteOnboardingRequest error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete onboarding request.' });
  }
}

/** POST /api/tenant-onboarding/requests/:id/confirm - writes the request into `tenants`. */
async function confirmOnboardingRequest(req, res) {
  try {
    const { request, errorRes } = await loadOwnedRequest(req);
    if (errorRes) return res.status(errorRes.statusCode).json(errorRes);
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'This request has already been resolved.' });
    }

    const { data: unit, error: unitErr } = await supabase.from('units').select('*').eq('id', request.unit_id).maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit) return res.status(404).json({ error: 'Unit no longer exists.' });
    if (unit.status !== 'vacant') {
      return res.status(400).json({ error: 'This unit is no longer vacant. It may have already been onboarded from a different request.' });
    }
    if (await blockIfSubscriptionExpired(req, res, request.landlord_id, unit.property_id || request.property_id || null)) return;

    const phoneConflict = await findPhoneConflict(request.primary_phone, 'tenant');
    if (phoneConflict) return res.status(409).json({ error: phoneConflict });
    const emailConflict = await findEmailConflict(request.email, 'tenant');
    if (emailConflict) return res.status(409).json({ error: emailConflict });

    const { tenant, emailSent } = await createTenantRecord({
      landlordId: request.landlord_id,
      unit,
      unitId: unit.id,
      fullName: request.full_name,
      primaryPhone: request.primary_phone,
      secondaryPhone: request.secondary_phone,
      email: request.email,
      idNumber: request.id_number,
      moveInDate: request.move_in_date,
      emergencyContactName: request.emergency_contact_name,
      emergencyContactPhone: request.emergency_contact_phone,
      // DIRECT REQUEST: the deposit the tenant self-reported (and the
      // landlord/manager/caretaker has had the chance to review and
      // correct via editOnboardingRequest) is what actually lands on
      // the tenant record - same field addTenant's manual "Deposit
      // amount" input writes to, just sourced from the confirmed
      // request instead of typed in fresh here.
      depositAmount: request.deposit_amount_paid,
      depositPaidAt: request.deposit_amount_paid != null ? request.move_in_date : undefined,
      createdByRole: req.user.role === 'manager' ? 'manager' : 'landlord',
      // DIRECT REQUEST ("verification of email should be once"): this
      // request could only have reached 'pending' status at all if
      // submitOnboardingRequest's own server-side check passed - it
      // rejects submission entirely unless tenant_onboarding_email_otps
      // has a verified=true row for this exact (link, email) pair. So
      // by the time a request is sitting here waiting to be confirmed,
      // the tenant has already proven they control this email - no
      // need to make them do it again via a second OTP at first login.
      emailPreVerified: true,
    });

    const { name: confirmedByName, roleLevel: confirmedByRoleLevel } = await resolveActorNameAndLevel(req.user);
    const now = new Date().toISOString();

    const { data: confirmed, error: confirmErr } = await supabase
      .from('tenant_onboarding_requests')
      .update({
        status: 'confirmed',
        confirmed_by_type: req.user.role === 'manager' ? 'manager' : 'landlord',
        confirmed_by_role_level: confirmedByRoleLevel,
        confirmed_by_id: req.user.id,
        confirmed_by_name: confirmedByName,
        confirmed_at: now,
        resulting_tenant_id: tenant.id,
      })
      .eq('id', request.id)
      .select('*, units(unit_name), properties(name)')
      .single();
    if (confirmErr) throw confirmErr;

    // Simultaneous-duplicate edge case: any OTHER still-pending request
    // for this same unit is now moot - the unit's taken. Supersede
    // them with a clear reason rather than leaving them to be
    // confirmed into an already-occupied unit later.
    const { data: others } = await supabase
      .from('tenant_onboarding_requests')
      .select('id')
      .eq('unit_id', request.unit_id)
      .eq('status', 'pending')
      .neq('id', request.id);
    if (others && others.length) {
      await supabase
        .from('tenant_onboarding_requests')
        .update({ status: 'superseded', superseded_reason: 'Superseded - unit was confirmed for another tenant.' })
        .in('id', others.map((o) => o.id));
    }

    notifyConfirmed(request.landlord_id, request.property_id, { fullName: request.full_name, unitName: unit.unit_name }, confirmedByName).catch((notifyErr) => {
      logger.error('[tenantOnboarding] notifyConfirmed failed:', notifyErr.message);
      captureException(notifyErr);
    });

    // BUG FIX (direct request: "the login details are supposed to be
    // sent to that tenant's set email... right now they are not
    // sending"): createTenantRecord already attempts this email
    // unconditionally (see tenant.controller.js) whenever email is
    // present, which it always is here (required + validated at
    // submission - see submitOnboardingRequest below). If it's not
    // arriving, the actual failure was previously invisible - this
    // used to always say "Tenant onboarded." even when the email send
    // failed, so nobody confirming a request ever found out delivery
    // didn't happen. Now the confirming landlord/manager/caretaker
    // sees it plainly and can resend/share credentials manually.
    return res.json({
      message: emailSent
        ? 'Tenant onboarded. Login details sent to their email.'
        : "Tenant onboarded, but the login-details email failed to send (check Resend domain verification). The tenant has no way to log in yet - resend or share their credentials manually.",
      emailSent,
      request: confirmed,
      tenant: { ...tenant, password_hash: undefined },
    });
  } catch (err) {
    logger.error('[tenantOnboarding] confirmOnboardingRequest error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to confirm onboarding request.' });
  }
}

// ---------------------------------------------------------------------
// PUBLIC - no auth. Deliberately mirrors public.controller.js's
// "hard-lock server-side, never trust the frontend" pattern.
// ---------------------------------------------------------------------

/** GET /api/public/onboarding/:token - property name + vacant units for the form. */
async function getOnboardingForm(req, res) {
  try {
    const { token } = req.params;
    const { data: link, error } = await supabase
      .from('tenant_onboarding_links')
      .select('id, property_id, properties(name)')
      .eq('token', token)
      .maybeSingle();
    if (error) throw error;
    if (!link) return res.status(404).json({ error: 'This onboarding link is invalid.' });

    const { data: units, error: unitsErr } = await supabase
      .from('units')
      .select('id, unit_name, unit_type, requires_deposit, deposit_amount_expected')
      .eq('property_id', link.property_id)
      .eq('status', 'vacant')
      .order('unit_name');
    if (unitsErr) throw unitsErr;

    // DIRECT REQUEST: the deposit question on the onboarding form
    // needs to know, per unit, whether this landlord's property even
    // requires a deposit at all - and if so, what amount is expected -
    // so the form can hint the tenant appropriately instead of asking
    // a bare, context-free "deposit paid?" question.
    const unitsWithDeposit = (units || []).map((u) => ({
      id: u.id,
      unit_name: u.unit_name,
      unit_type: u.unit_type,
      requiresDeposit: !!u.requires_deposit,
      depositAmountExpected: u.requires_deposit ? (u.deposit_amount_expected ?? null) : null,
    }));

    return res.json({ propertyName: link.properties?.name || 'this property', units: unitsWithDeposit });
  } catch (err) {
    logger.error('[tenantOnboarding] getOnboardingForm error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load onboarding form.' });
  }
}

/**
 * POST /api/public/onboarding/:token/check-duplicate - SECTION 9:
 * while the tenant is still filling in the form (before submission),
 * check whether the phone number or email they've typed already
 * belongs to some other account anywhere in the system, so likely
 * duplicates get caught early instead of landing on whoever reviews
 * the request afterward.
 *
 * Deliberately reuses the exact same conflict lookups the app already
 * trusts for account uniqueness (findPhoneConflict / findEmailConflict)
 * so this can never drift out of sync with what actually blocks an
 * account from being created - but only a single generic boolean ever
 * leaves this endpoint. It never says which of the two fields matched,
 * and never surfaces anything about the existing account (role, name,
 * landlord, property) - by design, this response has no path for any
 * of that to leak.
 */
async function checkOnboardingDuplicate(req, res) {
  try {
    const { token } = req.params;
    const { data: link, error: linkErr } = await supabase
      .from('tenant_onboarding_links')
      .select('id')
      .eq('token', token)
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return res.status(404).json({ error: 'This onboarding link is invalid.' });

    const { phone, email } = req.body;

    // Best-effort only - an unrecognizable phone shape or invalid
    // email just skips that half of the check rather than erroring
    // out. Real format validation still happens at submission time;
    // this endpoint's only job is an early, non-blocking heads-up.
    let normalizedPhone = null;
    if (phone) {
      try {
        normalizedPhone = normalizePhoneOrThrow(phone, 'Phone number');
      } catch {
        normalizedPhone = null;
      }
    }
    const normalizedEmail = email && isValidEmail(email) ? String(email).trim() : null;

    const checks = [];
    if (normalizedPhone) checks.push(findPhoneConflict(normalizedPhone, 'tenant'));
    if (normalizedEmail) checks.push(findEmailConflict(normalizedEmail, 'tenant'));
    if (!checks.length) return res.json({ possibleDuplicate: false });

    const results = await Promise.all(checks);
    // Collapse to a single boolean - which specific check(s) hit, and
    // what they'd otherwise say about the existing account, is never
    // allowed to reach the response.
    const possibleDuplicate = results.some((r) => !!r);

    return res.json({ possibleDuplicate });
  } catch (err) {
    logger.error('[tenantOnboarding] checkOnboardingDuplicate error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to check your details. Please try again.' });
  }
}

/**
 * POST /api/public/onboarding/:token/email/send-otp - tenant enters
 * an email, gets a 6-digit code to prove they actually control it.
 *
 * DIRECT REQUEST: "there should be a way a tenant verifies the
 * entered email... under the email once he enters it there should
 * appear a box to verify the email... once verified is when he can
 * submit that form... if not verified, throw an error for them to
 * verify the email first". Scoped to (onboarding_link_id, email) -
 * not to any account, since none exists yet at this point - a fresh
 * OTP is generated and any prior one for this exact link+email pair
 * is overwritten (upsert), same pattern as resendLandlordEmailOTP.
 */
async function sendOnboardingEmailOtp(req, res) {
  try {
    const { token } = req.params;
    const { email } = req.body;
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const { data: link, error: linkErr } = await supabase
      .from('tenant_onboarding_links')
      .select('id')
      .eq('token', token)
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return res.status(404).json({ error: 'This onboarding link is invalid.' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const otp = generateOTP();
    const expiresAt = getEmailVerificationOTPExpiry();

    const { error: upsertErr } = await supabase
      .from('tenant_onboarding_email_otps')
      .upsert(
        {
          onboarding_link_id: link.id,
          email: normalizedEmail,
          otp_code: otp,
          expires_at: expiresAt.toISOString(),
          verified: false,
          failed_attempts: 0,
          locked_until: null,
        },
        { onConflict: 'onboarding_link_id,email' }
      );
    if (upsertErr) throw upsertErr;

    try {
      await sendEmail(
        normalizedEmail,
        'Verify your email - RentaPay',
        wrapEmailHtml(`Your verification code is: ${otp}\n\nThis code expires in 10 minutes. Enter it on the tenant onboarding form to verify your email.`)
      );
    } catch (emailErr) {
      logger.error('[tenantOnboarding] sendOnboardingEmailOtp: failed to send:', emailErr.message);
      captureException(emailErr);
      return res.status(502).json({ error: 'Could not send the verification email. Please check the address and try again.' });
    }

    return res.json({ message: 'Verification code sent to your email.' });
  } catch (err) {
    logger.error('[tenantOnboarding] sendOnboardingEmailOtp error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send verification code.' });
  }
}

/** POST /api/public/onboarding/:token/email/verify-otp - checks the code the tenant typed in. */
async function verifyOnboardingEmailOtp(req, res) {
  try {
    const { token } = req.params;
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and code are required.' });

    const { data: link, error: linkErr } = await supabase
      .from('tenant_onboarding_links')
      .select('id')
      .eq('token', token)
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return res.status(404).json({ error: 'This onboarding link is invalid.' });

    const normalizedEmail = String(email).trim();
    const { data: record, error: recordErr } = await supabase
      .from('tenant_onboarding_email_otps')
      .select('*')
      .eq('onboarding_link_id', link.id)
      .ilike('email', normalizedEmail)
      .maybeSingle();
    if (recordErr) throw recordErr;
    if (!record) return res.status(400).json({ error: 'Request a verification code for this email first.' });

    // Same lockout convention as verifyLandlordEmailOTP - 5 wrong
    // codes locks it out for a while rather than allowing unlimited
    // guesses against a 6-digit code.
    if (record.locked_until && new Date(record.locked_until) > new Date()) {
      return res.status(423).json({ error: `Too many incorrect codes. Try again after ${record.locked_until}, or request a new code.` });
    }
    if (isOTPExpired(record.expires_at)) {
      return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    }
    if (record.otp_code !== String(otp).trim()) {
      const failedAttempts = (record.failed_attempts || 0) + 1;
      const update = { failed_attempts: failedAttempts };
      if (failedAttempts >= 5) {
        const lockUntil = new Date();
        lockUntil.setMinutes(lockUntil.getMinutes() + 15);
        update.locked_until = lockUntil.toISOString();
      }
      await supabase.from('tenant_onboarding_email_otps').update(update).eq('id', record.id);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    await supabase
      .from('tenant_onboarding_email_otps')
      .update({ verified: true, failed_attempts: 0, locked_until: null })
      .eq('id', record.id);

    return res.json({ verified: true });
  } catch (err) {
    logger.error('[tenantOnboarding] verifyOnboardingEmailOtp error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify code.' });
  }
}

/** POST /api/public/onboarding/:token/submit - tenant's own submission. */
async function submitOnboardingRequest(req, res) {
  try {
    const { token } = req.params;
    const { data: link, error: linkErr } = await supabase
      .from('tenant_onboarding_links')
      .select('id, landlord_id, property_id, properties(name)')
      .eq('token', token)
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return res.status(404).json({ error: 'This onboarding link is invalid.' });

    const { unitId, fullName, email, idNumber, moveInDate, emergencyContactName, depositAmountPaid } = req.body;
    let { primaryPhone, secondaryPhone, emergencyContactPhone } = req.body;

    const required = { unitId, fullName, primaryPhone, email, idNumber, moveInDate, emergencyContactName, emergencyContactPhone };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return res.status(400).json({ error: `Please fill in: ${missing.join(', ')}` });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid, active email address.' });

    // DIRECT REQUEST: deposit amount paid is optional - a tenant who
    // hasn't paid anything (or hasn't paid yet) just leaves it empty.
    // Validated here (not just parsed) so a garbage value doesn't
    // silently become NaN/0 in the database.
    let depositAmountPaidValue = null;
    if (depositAmountPaid !== undefined && depositAmountPaid !== null && String(depositAmountPaid).trim() !== '') {
      const parsed = Number(depositAmountPaid);
      if (Number.isNaN(parsed) || parsed < 0) {
        return res.status(400).json({ error: 'Deposit amount paid must be a valid, non-negative number.' });
      }
      depositAmountPaidValue = parsed;
    }

    // DIRECT REQUEST ("if not verified, throw an error for them to
    // verify the email first"): enforced server-side, not just as a
    // disabled-submit-button UI nicety - a fresh submitOnboarding
    // request with the same token could otherwise skip the frontend
    // gate entirely.
    const { data: emailOtpRecord, error: emailOtpErr } = await supabase
      .from('tenant_onboarding_email_otps')
      .select('verified')
      .eq('onboarding_link_id', link.id)
      .ilike('email', String(email).trim())
      .maybeSingle();
    if (emailOtpErr) throw emailOtpErr;
    if (!emailOtpRecord?.verified) {
      return res.status(400).json({ error: 'Please verify your email address before submitting.', emailNotVerified: true });
    }

    try {
      primaryPhone = normalizePhoneOrThrow(primaryPhone, 'Your phone number');
      if (secondaryPhone) secondaryPhone = normalizePhoneOrThrow(secondaryPhone, 'Secondary phone number');
      emergencyContactPhone = normalizePhoneOrThrow(emergencyContactPhone, 'Emergency contact phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    // Section 7 - block submission outright (not just a soft heads-up)
    // when the tenant's own email or phone is already registered to an
    // ACTIVE account elsewhere. Previously this only surfaced as a
    // vague, non-blocking "may have already been used" hint (see
    // checkOnboardingDuplicate above) while the request still reached
    // the landlord's queue - they'd discover the real conflict only on
    // review and have to go back to the tenant for corrected details.
    // findPhoneConflict/findEmailConflict's own messages name the
    // account TYPE it's registered under (landlord/manager/tenant) -
    // per spec that's never revealed here, so only their truthiness is
    // used; the message below is worded fresh, naming just the field.
    const [phoneConflict, emailConflict] = await Promise.all([
      findPhoneConflict(primaryPhone, 'tenant'),
      findEmailConflict(email, 'tenant'),
    ]);
    if (emailConflict || phoneConflict) {
      const messages = [];
      if (emailConflict) messages.push('This email is already registered.');
      if (phoneConflict) messages.push('This phone number is already registered.');
      return res.status(409).json({
        error: messages.join(' '),
        fields: [...(emailConflict ? ['email'] : []), ...(phoneConflict ? ['primaryPhone'] : [])],
      });
    }

    const { data: unit, error: unitErr } = await supabase
      .from('units')
      .select('id, unit_name, property_id, status, requires_deposit')
      .eq('id', unitId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit || unit.property_id !== link.property_id) return res.status(404).json({ error: 'That unit could not be found.' });
    if (unit.status !== 'vacant') {
      return res.status(400).json({ error: 'This unit is already onboarded. Please contact your landlord or manager directly for changes.' });
    }

    // DIRECT REQUEST: "system should mark that as zero if the
    // landlord's apartment is marked as requires deposit but N/A" -
    // if this unit requires a deposit and the tenant left the field
    // empty, record it as an explicit 0 rather than leaving it blank/
    // unknown, so the reviewing landlord/manager/caretaker sees "0"
    // to correct, not an ambiguous dash that could just mean "wasn't
    // asked". Units that don't require a deposit at all are left null -
    // there's nothing to default there.
    if (unit.requires_deposit && depositAmountPaidValue === null) {
      depositAmountPaidValue = 0;
    }


    // Resubmission logic: same tenant (same phone), same unit, on
    // this link, submitting again while still pending updates their
    // existing row instead of creating a duplicate. Scoped to
    // unit_id too (matches idx_onboarding_requests_pending_unit_phone_per_link)
    // - if they instead pick a DIFFERENT unit on resubmit, that's
    // treated as a new request for that unit, not an edit of the old
    // one; the old pending row for the abandoned unit is left as-is
    // for a landlord/manager/caretaker to notice and clear up.
    const { data: existingPending, error: existingErr } = await supabase
      .from('tenant_onboarding_requests')
      .select('id')
      .eq('onboarding_link_id', link.id)
      .eq('unit_id', unitId)
      .eq('primary_phone', primaryPhone)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingErr) throw existingErr;

    const payload = {
      onboarding_link_id: link.id,
      landlord_id: link.landlord_id,
      property_id: link.property_id,
      unit_id: unitId,
      full_name: fullName,
      primary_phone: primaryPhone,
      secondary_phone: secondaryPhone || null,
      email: String(email).trim(),
      id_number: idNumber,
      move_in_date: moveInDate,
      emergency_contact_name: emergencyContactName,
      emergency_contact_phone: emergencyContactPhone,
      deposit_amount_paid: depositAmountPaidValue,
      status: 'pending',
    };

    let savedRequest;
    if (existingPending) {
      const { data, error } = await supabase
        .from('tenant_onboarding_requests')
        .update(payload)
        .eq('id', existingPending.id)
        .select()
        .single();
      if (error) throw error;
      savedRequest = data;
    } else {
      const { data, error } = await supabase.from('tenant_onboarding_requests').insert(payload).select().single();
      if (error) throw error;
      savedRequest = data;
    }

    notifyNewRequest(link.landlord_id, link.property_id, { fullName, unitName: unit.unit_name }).catch((notifyErr) => {
      logger.error('[tenantOnboarding] notifyNewRequest failed:', notifyErr.message);
      captureException(notifyErr);
    });

    return res.status(201).json({
      message: 'Submitted. The landlord, manager, or caretaker will review and confirm your details shortly.',
      request: savedRequest,
    });
  } catch (err) {
    logger.error('[tenantOnboarding] submitOnboardingRequest error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit your details. Please try again.' });
  }
}

module.exports = {
  getOrCreateLink,
  listOnboardingRequests,
  editOnboardingRequest,
  deleteOnboardingRequest,
  confirmOnboardingRequest,
  getOnboardingForm,
  checkOnboardingDuplicate,
  sendOnboardingEmailOtp,
  verifyOnboardingEmailOtp,
  submitOnboardingRequest,
};
