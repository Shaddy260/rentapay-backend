// src/controllers/tenant.controller.js
const { effectiveLandlordId, getManagerAssignedPropertyIds, checkLandlordOwnership, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
//
// Implements blueprint section 4 (Tenant Onboarding), section 6
// (balance edits), and section 8 (Vacating Notice).
// NOTE: the interest/"waive interest" feature has been removed entirely
// per direct request - late payments are tracked (isOverdue, days late)
// but no longer accrue any extra charge, and there is nothing to waive.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { hashPassword } = require('../utils/password');
const { generateOTP, getOTPExpiry } = require('../utils/otp');
const { normalizePhoneOrThrow, normalizePhone } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { findEmailConflict } = require('../utils/emailUniqueness');
const { buildPrepaymentSummary } = require('../utils/prepayment');
const { buildPaymentInstructions } = require('../utils/paymentInstructions');
const { notify } = require('../services/notify.service');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { runInBatches } = require('../utils/concurrency');
const reputationService = require('../services/reputation.service');
const { checkComment } = require('../utils/commentModeration');
const landlordReputationService = require('../services/landlordReputation.service');
const staffReputationService = require('../services/staffReputation.service');
const propertyReputationService = require('../services/propertyReputation.service');
const tenantRatingReminderService = require('../services/tenantRatingReminder.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

function generateTempPassword() {
  // 8-char temp password satisfying the strength rules (3.3) by construction
  return `Rp${crypto.randomBytes(3).toString('hex')}!`;
}

// ---------------------------------------------------------------------
// ADD TENANT (blueprint section 4 - full onboarding flow)
// ---------------------------------------------------------------------
async function addTenant(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const {
      unitId,
      fullName,
      email,
      idNumber,
      moveInDate,
      rentOverride,
      dueDayOfMonth,
      emergencyContactName,
      depositAmount,
      depositPaidAt,
    } = req.body;
    let { primaryPhone, secondaryPhone, emergencyContactPhone } = req.body;

    const required = { unitId, fullName, primaryPhone, email, idNumber, moveInDate, emergencyContactName, emergencyContactPhone };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address for the tenant.' });
    }

    // FIX: same rent-amount loophole as editTenantDetails - a
    // caretaker can add tenants, and rentOverride here is effectively
    // setting that tenant's rent amount at move-in, which caretakers
    // must not be able to do.
    if (rentOverride && req.user.role === 'manager' && req.user.roleLevel === 'caretaker') {
      return res.status(403).json({
        error: 'Caretakers cannot set a custom rent amount. Contact the landlord or property manager.',
        caretakerRestricted: true,
      });
    }

    // Same normalization fix as auth.controller.js - without this, a
    // landlord typing "0712345678" here while the tenant later logs
    // in with "254712345678" (or vice versa) get stored/looked-up as
    // two different strings and never match.
    try {
      primaryPhone = normalizePhoneOrThrow(primaryPhone, 'Tenant phone number');
      if (secondaryPhone) secondaryPhone = normalizePhoneOrThrow(secondaryPhone, 'Secondary phone number');
      emergencyContactPhone = normalizePhoneOrThrow(emergencyContactPhone, 'Emergency contact phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    // "No number should open more than one user account" - blocks this
    // phone if it's already a landlord/manager account, or an ACTIVE
    // tenant under any landlord (including this one, elsewhere in the
    // portfolio). An ARCHIVED tenant's number is explicitly allowed to
    // be reused under a new (or the same) landlord - see
    // phoneUniqueness.js. This is separate from, and runs before, the
    // same-property "is this a duplicate entry" check below.
    const phoneConflict = await findPhoneConflict(primaryPhone, 'tenant');
    if (phoneConflict) return res.status(409).json({ error: phoneConflict });

    // Same rule as phone, now also enforced for email specifically
    // because tenant reputation is keyed by email (reputation.service.js)
    // - allowing two different active tenants to share an email would
    // blend their ratings into one reputation. Archived tenants'
    // emails remain reusable, same exception as phone.
    const emailConflict = await findEmailConflict(email, 'tenant');
    if (emailConflict) return res.status(409).json({ error: emailConflict });

    const { data: unit, error: unitError } = await supabase.from('units').select('*').eq('id', unitId).single();
    if (unitError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    if (unit.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not own this unit.' });
    if (unit.status === 'occupied') return res.status(400).json({ error: 'This unit is already occupied.' });
    if (unit.is_frozen) {
      return res.status(400).json({
        error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it before adding a tenant here.',
      });
    }
    if (await blockIfSubscriptionExpired(req, res, landlordId, unit.property_id)) return;

    // Item 10: flag (not silently allow) adding a tenant whose phone
    // number or ID already belongs to another active tenant in the
    // SAME apartment/property - almost always a duplicate entry
    // (re-typing the same tenant into a second unit by mistake) rather
    // than a genuine new person. Scoped to this one property, not the
    // landlord's whole portfolio, since the same person legitimately
    // renting units in two different buildings isn't a duplicate.
    // `confirmDuplicate: true` lets the landlord/manager go ahead
    // anyway once they've seen the warning (e.g. a tenant taking on a
    // second, separate unit in the same building on purpose).
    if (!req.body.confirmDuplicate) {
      const { data: existingInProperty } = await supabase
        .from('tenants')
        .select('id, full_name, primary_phone, id_number, unit_id, units!inner(property_id, unit_name)')
        .eq('landlord_id', landlordId)
        .eq('is_active', true)
        .eq('units.property_id', unit.property_id)
        .or(`primary_phone.eq.${primaryPhone},id_number.eq.${idNumber}`);

      if (existingInProperty && existingInProperty.length) {
        return res.status(409).json({
          error: `This looks like a duplicate: ${existingInProperty[0].full_name} (Unit ${existingInProperty[0].units?.unit_name}) in this same apartment already has this phone number or ID.`,
          duplicateTenant: true,
          matches: existingInProperty.map((t) => ({ id: t.id, fullName: t.full_name, unitId: t.unit_id, unitName: t.units?.unit_name })),
        });
      }
    }

    const { tenant, emailSent } = await createTenantRecord({
      landlordId,
      unit,
      unitId,
      fullName,
      primaryPhone,
      secondaryPhone,
      email,
      idNumber,
      moveInDate,
      rentOverride,
      dueDayOfMonth,
      emergencyContactName,
      emergencyContactPhone,
      depositAmount,
      depositPaidAt,
      createdByRole: req.user.role === 'manager' ? 'manager' : 'landlord',
    });

    return res.status(201).json({
      // FIX (bug: message claimed a fallback that doesn't exist -
      // "sent via SMS" - even though SMS/WhatsApp delivery was
      // disabled platform-wide and email is the ONLY channel for
      // first-time login credentials (see createTenantRecord above).
      // That made an actual delivery failure read as a success
      // through a channel that never fired, so nobody ever knew to
      // follow up with the tenant.
      message: email && !emailSent
        ? 'Tenant added, but the login-details email failed to send (check Resend domain verification). The tenant has no way to log in yet - resend or share their credentials manually.'
        : 'Tenant added and login details sent.',
      tenant: { ...tenant, password_hash: undefined },
    });
  } catch (err) {
    logger.error('[tenant] addTenant error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to add tenant.' });
  }
}

// ---------------------------------------------------------------------
// SHARED CORE (extracted from addTenant above) - lets the Tenant
// Self-Onboarding confirm step (tenantOnboarding.controller.js) write
// a reviewed request into `tenants` with EXACTLY the same behavior a
// manual add-tenant gets: temp password + OTP, first month billed,
// unit flipped to occupied, login-credentials email, one-time
// reputation email, activity log, and a first_time_credentials
// fallback row. Callers are responsible for their own validation
// (required fields, phone/email conflicts, duplicate-in-property
// checks, unit ownership/vacancy) before calling this.
// ---------------------------------------------------------------------
async function createTenantRecord({
  landlordId,
  unit,
  unitId,
  fullName,
  primaryPhone,
  secondaryPhone,
  email,
  idNumber,
  moveInDate,
  rentOverride,
  dueDayOfMonth,
  emergencyContactName,
  emergencyContactPhone,
  depositAmount,
  depositPaidAt,
  createdByRole,
  // DIRECT REQUEST ("verification of email should be once"): true
  // only when the tenant already proved they control this email
  // themselves - i.e. confirmOnboardingRequest, after the public
  // onboarding form's own email-OTP box (TenantOnboarding.jsx) was
  // verified. A manually-added tenant (addTenant) never passes this -
  // nobody but the landlord/manager/caretaker has touched that email
  // address, so it still needs proving at first login.
  emailPreVerified = false,
}) {
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  // DIRECT REQUEST ("verification of email should be once"): only
  // generate an OTP - and require verifyOTP at first login (gated by
  // is_verified, see auth.controller.js's login()) - when this tenant
  // hasn't already proven they control this email. A self-onboarded
  // tenant confirmed via confirmOnboardingRequest already did, via
  // the public form's own email-OTP step (TenantOnboarding.jsx) -
  // asking again here would just be the same proof a second time.
  const otp = emailPreVerified ? null : generateOTP();
  const otpExpiresAt = emailPreVerified ? null : getOTPExpiry();

  // Bill the first month's rent (+ extras) into the ledger right at
  // move-in, and stamp the current period so the monthly billing
  // job doesn't double-charge them again this same cycle. Without
  // this, a brand-new tenant would show a balance of 0 until the
  // next cron run, which reads as "nothing owed" even though rent
  // is due from day one.
  const rentAmount = Number(rentOverride || unit.rent_amount || 0);
  const extrasTotal = (unit.extra_charges || []).reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const today = new Date();
  const currentPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  const { data: tenant, error } = await supabase
    .from('tenants')
    .insert({
      landlord_id: landlordId,
      unit_id: unitId,
      full_name: fullName,
      primary_phone: primaryPhone,
      secondary_phone: secondaryPhone || null,
      email: email ? String(email).trim() : null,
      id_number: idNumber,
      move_in_date: moveInDate,
      rent_override: rentOverride || null,
      due_day_of_month: dueDayOfMonth || null,
      emergency_contact_name: emergencyContactName,
      emergency_contact_phone: emergencyContactPhone,
      password_hash: passwordHash,
      otp_code: otp,
      otp_expires_at: otpExpiresAt ? otpExpiresAt.toISOString() : null,
      // Same flag login() already checks (`if (!account.is_verified
      // && accountType !== 'landlord')`) to decide whether to force
      // the OTP-entry screen - setting it true here at creation time
      // is the entire fix; login() needs no changes at all.
      is_verified: emailPreVerified,
      must_change_password: true,
      balance_due: rentAmount + extrasTotal,
      last_billed_period: currentPeriod,
      // A security deposit is not rent - kept completely separate
      // from balance_due/payments, never added to what's owed or
      // counted as a payment. Only recorded when the landlord
      // actually entered an amount; deposit_status stays null (not
      // 'held') until then, so "no deposit was collected" and "a
      // deposit is being held" are never confused with each other.
      deposit_amount: depositAmount ? Number(depositAmount) : null,
      deposit_paid_at: depositAmount ? (depositPaidAt || moveInDate) : null,
      deposit_status: depositAmount ? 'held' : null,
    })
    .select()
    .single();

  if (error) throw error;

  // Flip unit to occupied (blueprint 4: "Unit status changes Vacant -> Occupied")
  await supabase.from('units').update({ status: 'occupied' }).eq('id', unitId);

  // Send login details via email (blueprint 4 flow, updated per
  // direct request: WhatsApp/SMS is disabled - email, now
  // mandatory at onboarding, is the only delivery channel).
  const emailBody = templates.tenantLoginCredentials(fullName, unit.unit_payment_code, tempPassword, otp);
  let emailSent = false;
  try {
    await sendEmail(email, 'Welcome to RentaPay - Your Login Details', wrapEmailHtml(emailBody));
    emailSent = true;
  } catch (emailErr) {
    // The tenant record, unit status flip, etc. above already
    // succeeded - don't let an email hiccup (e.g. unverified Resend
    // domain) undo any of that or fail the whole request. Logged
    // loudly since email is now the ONLY delivery channel for this
    // tenant's first-time credentials.
    logger.error('[tenant] createTenantRecord: CRITICAL - login credentials email failed to send:', emailErr.message);
    captureException(emailErr);
  }

  // Reputation email - separate from the login-credentials email on
  // purpose, so it clearly reads as "here is your standing" rather
  // than being buried in account setup. Only fires the first time
  // this email has EVER appeared as a tenant on the platform - see
  // the original comment in addTenant's history for the full reasoning.
  if (email) {
    try {
      const { data: priorTenantWithEmail } = await supabase
        .from('tenants')
        .select('id')
        .ilike('email', String(email).trim())
        .neq('id', tenant.id)
        .limit(1)
        .maybeSingle();

      if (!priorTenantWithEmail) {
        const reputation = await reputationService.getReputationByEmail(email);
        const repEmailBody = templates.tenancyReputationSummary(fullName, reputation);
        await sendEmail(email, 'Your RentaPay Tenancy Reputation', wrapEmailHtml(repEmailBody));
      }
    } catch (repEmailErr) {
      // Non-critical (unlike the credentials email above) - never
      // block or fail tenant creation over this.
      logger.error('[tenant] createTenantRecord: tenancy reputation email failed to send:', repEmailErr.message);
      captureException(repEmailErr);
    }
  }

  logActivity({ actorType: 'landlord', actorId: landlordId, action: 'tenant_added', targetType: 'tenant', targetId: tenant.id, metadata: { unitId, emailSent } });

  // Same fallback record as property_managers - see propertyManager.controller.js
  // addManager for the full reasoning. unit.unit_name/property give
  // the "unit number" context the request specifically asked for.
  const { data: unitProperty } = unit.property_id
    ? await supabase.from('properties').select('name').eq('id', unit.property_id).maybeSingle()
    : { data: null };
  await supabase.from('first_time_credentials').insert({
    landlord_id: landlordId,
    role: 'tenant',
    account_id: tenant.id,
    full_name: fullName,
    phone: primaryPhone,
    unit_name: unit.unit_name,
    property_name: unitProperty?.name || null,
    temp_password: tempPassword,
    otp,
    created_by_role: createdByRole,
    // Matches the account's own otp_expires_at (getOTPExpiry(), 24h)
    // when there IS an OTP - set explicitly rather than relying on
    // the DB column default so the two never drift apart. When this
    // tenant's email was already pre-verified (no OTP at all - see
    // emailPreVerified above), there's no OTP window to match, so
    // this is omitted entirely and the column's own 14-day default
    // applies instead, as a reasonable temp-password validity window.
    ...(otpExpiresAt ? { expires_at: otpExpiresAt.toISOString() } : {}),
  });

  return { tenant, emailSent };
}

// ---------------------------------------------------------------------
// GET TENANT BALANCE BREAKDOWN (blueprint 6.1, 6.3 - tenant portal view)
// ---------------------------------------------------------------------
async function getBalance(req, res) {
  try {
    const tenantId = req.user.role === 'tenant' ? effectiveLandlordId(req) : req.params.tenantId;

    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('*, units(*, properties(payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_description)), landlords(payment_method, paybill_number, paybill_account_number, till_number, payment_description)')
      .eq('id', tenantId)
      .maybeSingle();

    // FIX: this used to report "Tenant not found" for BOTH "no row
    // exists with this id" AND "the query itself failed" (a bad join,
    // a schema-cache mismatch after a migration, a transient DB
    // error) - so a real backend problem always looked identical to a
    // tenant that genuinely doesn't exist, with no way to tell which
    // one was actually happening. Those are now two different
    // outcomes: an actual error is logged with its real message and
    // surfaced as a 500, not silently reworded into "not found".
    if (error) {
      logger.error('[tenant] getBalance query error for tenantId', tenantId, ':', error.message);
      captureException(error);
      return res.status(500).json({ error: 'Failed to load account. Please try again in a moment.' });
    }
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // CRITICAL FIX (isolation audit): the landlord/manager/admin branch
    // of this endpoint previously had NO ownership check at all - any
    // landlord or manager account on the platform could pull another
    // landlord's tenant's balance, arrears, and payment instructions
    // just by knowing/guessing the tenant id. Every sibling function in
    // this file (getTenant, editBalance, etc.) already does this check;
    // it was just missing here.
    if (req.user.role === 'landlord' || req.user.role === 'manager') {
      const ownershipError = await checkLandlordOwnership(req, tenant.landlord_id);
      if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
      const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
      if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    }

    const unit = tenant.units;
    const rentAmount = Number(tenant.rent_override || unit.rent_amount || 0);
    const dueDay = tenant.due_day_of_month || unit.due_day_of_month;
    const extraCharges = unit.extra_charges || [];
    const extrasTotal = extraCharges.reduce((sum, c) => sum + Number(c.amount || 0), 0);

    const today = new Date();
    const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);

    // balance_due IS the current total owed (or, negative, the credit
    // available) - it already has this cycle's rent baked in by the
    // monthly billing job, plus any accrued interest. No more adding
    // rentAmount again on top of it here; that double-counting was
    // part of why displayed balances never matched what a payment
    // actually cleared.
    const currentBalance = Number(tenant.balance_due || 0);

    // Computed here (once) so both the prepayment summary and the
    // displayed due date below use the exact same real, landlord-set
    // date - no separate derived "paid through" projection that could
    // drift away from what the landlord actually configured.
    const nextCycleDueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
    const prepayment = buildPrepaymentSummary(currentBalance, rentAmount, nextCycleDueDate);

    // FIX ("remove the interest thing - no interest on late payments"):
    // late payments are still tracked (isOverdue / dueDate below still
    // work exactly as before) but no longer accrue any extra charge.
    // interest_accrued is left in the schema (untouched historical
    // data, nothing deleted) but is no longer added into the balance
    // or shown as a line item.
    //
    // FIX (due date not syncing between landlord + tenant portal): the
    // "next due date" shown once a tenant has paid for the current
    // month must roll forward to next month's due day, not stay
    // pinned to this month's date - otherwise the tenant portal keeps
    // showing an already-passed date until the billing job's next run
    // days later. If nothing is currently owed (balance <= 0, i.e.
    // this cycle is already settled or the tenant is paid ahead), the
    // due date shown is next month's due day; otherwise it's the
    // current cycle's due date that's actually still outstanding.
    // (nextCycleDueDate was already computed above, right before
    // buildPrepaymentSummary, so both use the exact same real date.)
    const displayedDueDate = currentBalance <= 0 ? nextCycleDueDate : dueDate;

    const breakdown = {
      rentAmount,
      extraCharges,
      extrasTotal,
      carriedArrears: Math.max(currentBalance, 0),
      totalDue: Math.max(currentBalance, 0),
      balance: currentBalance, // signed: positive = owed (show in red), negative = credit
      isOverdue: currentBalance > 0 && today > dueDate,
      dueDate: displayedDueDate.toISOString(), // reflects next cycle once current one is settled
    };

    return res.json({ breakdown, prepayment, paymentInstructions: buildPaymentInstructions(tenant.landlords, unit) });
  } catch (err) {
    logger.error('[tenant] getBalance error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch balance.' });
  }
}

// ---------------------------------------------------------------------
// MANUAL BALANCE EDIT (blueprint 6.5 - logged with reason)
// ---------------------------------------------------------------------
async function editBalance(req, res) {
  try {
    const { tenantId } = req.params;
    const { newBalance, reason } = req.body;

    if (newBalance == null || !reason) {
      return res.status(400).json({ error: 'newBalance and reason are required.' });
    }

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('landlord_id, units(property_id)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const { error } = await supabase.from('tenants').update({ balance_due: newBalance }).eq('id', tenantId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'balance_edited', targetType: 'tenant', targetId: tenantId, reason, metadata: { newBalance } });

    return res.json({ message: 'Balance updated.' });
  } catch (err) {
    logger.error('[tenant] editBalance error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to edit balance.' });
  }
}

// ---------------------------------------------------------------------
// VACATING NOTICE (blueprint section 8 - full flow with revoke handling)
// ---------------------------------------------------------------------
async function submitVacatingNotice(req, res) {
  try {
    const tenantId = effectiveLandlordId(req); // tenant submits their own notice
    const { vacatingDate, reason } = req.body;

    if (!vacatingDate) return res.status(400).json({ error: 'vacatingDate is required.' });

    // FIX (direct request: "he cannot give a passed date already -
    // it's either that same day or the future... grey the previous"):
    // the date picker now greys past dates out client-side (min
    // attribute), but that's only ever a courtesy - this is the real
    // enforcement. Compared as calendar dates, not instants, so
    // "today" is always valid regardless of what time of day it is.
    const todayDateStr = new Date().toISOString().slice(0, 10);
    if (vacatingDate < todayDateStr) {
      return res.status(400).json({ error: 'Vacating date cannot be in the past - choose today or a future date.' });
    }

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('*, units(*)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const { error } = await supabase
      .from('tenants')
      .update({ notice_given: true, notice_date: vacatingDate, notice_reason: reason || null, notice_submitted_at: new Date().toISOString() })
      .eq('id', tenantId);

    if (error) throw error;

    await supabase.from('units').update({ status: 'notice_given' }).eq('id', tenant.unit_id);

    // Notify landlord (blueprint 8: instant SMS + dashboard notification).
    // "Live push" urgent tier - a vacate notice is exactly the kind of
    // thing a landlord needs to see even if the portal tab isn't open,
    // so this fires a real push on top of the SMS + inbox row.
    //
    // Not awaited - same reasoning as payment.controller.js's
    // submitPaybillTransaction: the tenant's own confirmation must
    // return immediately regardless of how long notifying the
    // landlord (SMS/push/inbox) takes.
    (async () => {
      try {
        const { data: landlord } = await supabase.from('landlords').select('phone').eq('id', tenant.landlord_id).single();
        if (landlord) {
          await notify(
            'landlord',
            tenant.landlord_id,
            landlord.phone,
            templates.vacatingNoticeSubmitted(tenant.full_name, tenant.units.unit_name, vacatingDate),
            { category: 'account', title: 'Vacating Notice Submitted', urgent: true, propertyId: tenant.units?.property_id || null }
          );
        }
        await notify('tenant', tenantId, tenant.primary_phone, templates.vacatingNoticeConfirmed(tenant.full_name, vacatingDate), { category: 'account', title: 'Vacating Notice Confirmed' });
      } catch (notifyErr) {
        logger.error('[tenant] submitVacatingNotice: notify failed (non-blocking):', notifyErr.message);
        captureException(notifyErr);
      }
    })();

    logActivity({ actorType: 'tenant', actorId: tenantId, action: 'vacating_notice_submitted', targetType: 'unit', targetId: tenant.unit_id, metadata: { vacatingDate, reason } });

    return res.json({ message: 'Vacating notice submitted. Your landlord has been notified.' });
  } catch (err) {
    logger.error('[tenant] submitVacatingNotice error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit vacating notice.' });
  }
}

/**
 * Tenant cancels their own notice BEFORE the landlord acts on it
 * (blueprint 8.1: "Cancel before final confirmation - no landlord notification").
 * In our flow the landlord is notified immediately on submit, so this
 * covers the case where the tenant changes their mind shortly after.
 */
async function cancelVacatingNotice(req, res) {
  try {
    const tenantId = effectiveLandlordId(req);

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('unit_id').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    await supabase.from('tenants').update({ notice_given: false, notice_date: null, notice_reason: null }).eq('id', tenantId);
    await supabase.from('units').update({ status: 'occupied' }).eq('id', tenant.unit_id);

    logActivity({ actorType: 'tenant', actorId: tenantId, action: 'vacating_notice_cancelled', targetType: 'unit', targetId: tenant.unit_id });

    return res.json({ message: 'Vacating notice cancelled.' });
  } catch (err) {
    logger.error('[tenant] cancelVacatingNotice error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to cancel vacating notice.' });
  }
}

/**
 * Landlord (or admin) revokes a notice after the fact - requires a reason
 * (blueprint 8.1: "Clicks 'Revoke Notice' + enters reason").
 */
async function revokeVacatingNotice(req, res) {
  try {
    const { tenantId } = req.params;
    const { reason } = req.body;

    if (!reason) return res.status(400).json({ error: 'A reason is required to revoke a notice.' });

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('*, units(property_id)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    await supabase.from('tenants').update({ notice_given: false, notice_date: null, notice_reason: null }).eq('id', tenantId);
    await supabase.from('units').update({ status: 'occupied' }).eq('id', tenant.unit_id);

    if (tenant.email) {
      await sendEmail(tenant.email, 'Your vacating notice was revoked', wrapEmailHtml(templates.vacatingNoticeRevoked(tenant.full_name))).catch((e) =>
        logger.warn('[tenant] revokeVacatingNotice: email failed (non-fatal):', e.message)
      );
    }

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'vacating_notice_revoked', targetType: 'tenant', targetId: tenantId, reason });

    return res.json({ message: 'Vacating notice revoked.' });
  } catch (err) {
    logger.error('[tenant] revokeVacatingNotice error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to revoke vacating notice.' });
  }
}

/**
 * Edit tenant details (blueprint 11.2: "Edit tenant details anytime").
 * Deliberately excludes id_number and move_in_date from editable
 * fields - those are historical/identity records, not meant to be
 * casually changed after the fact. Phone/email/emergency contact and
 * rent/due-date overrides are the fields a landlord would realistically
 * need to correct or update.
 */
async function editTenantDetails(req, res) {
  try {
    const { tenantId } = req.params;
    const { fullName, secondaryPhone, email, emergencyContactName, emergencyContactPhone, rentOverride, dueDayOfMonth } = req.body;

    // FIX (direct request: "a landlord or manager or caretaker should
    // not be able to edit a tenant's email... same as tenants
    // themselves"): editOwnProfile below already locks a tenant's own
    // email as their primary login identifier and the anchor for their
    // portable reputation (reputation.service.js is keyed by email) -
    // this endpoint let a landlord/manager/caretaker edit it anyway,
    // which both bypassed that lock from the other side AND could
    // silently detach a tenant's rating history (any change here moves
    // future ratings to a different reputation.service.js aggregate
    // than the one already built up). Email is now fixed at creation
    // (addTenant) for every role - nobody can change it from here.
    if (email !== undefined) {
      return res.status(400).json({ error: 'A tenant\'s email cannot be changed after they are added. It is their login identifier and anchors their portable reputation.' });
    }

    // FIX: rentOverride is effectively a per-tenant rent amount, and
    // this general-purpose "edit tenant details" endpoint had no
    // caretaker check on it at all - a caretaker could set/change it
    // here even though the dedicated rent-amount route correctly
    // blocks them. dueDayOfMonth stays allowed - caretakers ARE meant
    // to be able to change due dates.
    if (rentOverride !== undefined && req.user.role === 'manager' && req.user.roleLevel === 'caretaker') {
      return res.status(403).json({
        error: 'Caretakers cannot change rent amounts. Contact the landlord or property manager.',
        caretakerRestricted: true,
      });
    }

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('landlord_id, units(property_id)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const updateFields = {};
    try {
      if (fullName !== undefined) updateFields.full_name = fullName;
      if (secondaryPhone !== undefined) updateFields.secondary_phone = secondaryPhone ? normalizePhoneOrThrow(secondaryPhone, 'Secondary phone number') : null;
      if (emergencyContactName !== undefined) updateFields.emergency_contact_name = emergencyContactName;
      if (emergencyContactPhone !== undefined) updateFields.emergency_contact_phone = normalizePhoneOrThrow(emergencyContactPhone, 'Emergency contact phone number');
      if (rentOverride !== undefined) updateFields.rent_override = rentOverride;
      if (dueDayOfMonth !== undefined) updateFields.due_day_of_month = dueDayOfMonth;
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    const { error } = await supabase.from('tenants').update(updateFields).eq('id', tenantId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'tenant_details_edited', targetType: 'tenant', targetId: tenantId, metadata: updateFields });

    return res.json({ message: 'Tenant details updated.' });
  } catch (err) {
    logger.error('[tenant] editTenantDetails error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update tenant details.' });
  }
}

/**
 * Fetch a single tenant's full details + payment history, for the
 * unit detail page.
 */
async function getTenant(req, res) {
  try {
    const { tenantId } = req.params;

    const { data: tenant, error } = await supabase.from('tenants').select('*, units(*)').eq('id', tenantId).single();
    if (error || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const { data: payments } = await supabase
      .from('payments')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    const rentAmount = tenant.rent_override || tenant.units.rent_amount;
    const dueDay = tenant.due_day_of_month || tenant.units.due_day_of_month;
    const today = new Date();
    const nextCycleDueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
    const prepayment = buildPrepaymentSummary(tenant.balance_due, rentAmount, nextCycleDueDate);

    return res.json({ tenant: { ...tenant, password_hash: undefined, otp_code: undefined }, payments: payments || [], prepayment });
  } catch (err) {
    logger.error('[tenant] getTenant error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch tenant.' });
  }
}

/**
 * On-demand single-tenant reminder (the "Remind" button on a unit
 * card). Distinct from the automated cron reminders in
 * jobs/rentReminders.job.js - this lets the landlord nudge a specific
 * tenant right now, regardless of the automated schedule.
 */
async function remindTenant(req, res) {
  try {
    const { tenantId } = req.params;

    const { data: tenant, error } = await supabase
      .from('tenants')
      .select(
        '*, units(property_id, rent_amount, due_day_of_month, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, properties(payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_description)), landlords(payment_method, paybill_number, paybill_account_number, till_number, payment_description)'
      )
      .eq('id', tenantId)
      .single();
    if (error || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    // FIX-ADD: tapping "Remind" for a tenant who has already paid
    // ahead (balance_due <= 0 - see prepayment.js, negative/zero means
    // settled or in credit, nothing currently owed) used to still fire
    // off a reminder SMS telling them their rent is due, which is
    // both wrong and annoying to a tenant who's already square. Now it
    // short-circuits with an informational message for the caller and
    // never contacts the tenant at all.
    if (Number(tenant.balance_due) <= 0) {
      return res.status(200).json({
        skipped: true,
        message: `${tenant.full_name} has already paid ahead and is not overdue - no reminder was sent.`,
      });
    }

    const rentAmount = tenant.rent_override || tenant.units.rent_amount;
    const dueDay = tenant.due_day_of_month || tenant.units.due_day_of_month;
    const today = new Date();
    const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
    const dueDateLabel = dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    const payInfo = buildPaymentInstructions(tenant.landlords, tenant.units);

    const message =
      today > dueDate
        ? `Hi ${tenant.full_name}, this is a reminder that your rent of KES ${rentAmount} was due on ${dueDateLabel} and is now overdue. ${payInfo.text}`
        : `Hi ${tenant.full_name}, this is a reminder that your rent of KES ${rentAmount} is due on ${dueDateLabel}. ${payInfo.text}`;

    await notify('tenant', tenant.id, tenant.primary_phone, message, { category: 'rent_reminder', title: 'Rent Reminder' });

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'manual_reminder_sent', targetType: 'tenant', targetId: tenantId });

    return res.json({ message: 'Reminder sent.' });
  } catch (err) {
    logger.error('[tenant] remindTenant error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send reminder.' });
  }
}

/**
 * Section 5 (WhatsApp reminders) - single tenant.
 *
 * Returns the tenant's phone number and the exact reminder message,
 * pre-built the same way remindTenant() builds its SMS/in-app message,
 * so the frontend can open a `wa.me` deep link with the text
 * pre-filled. This does NOT send anything itself - no WhatsApp
 * Business API is used or required. The landlord's own device/number
 * sends the message when they tap "Send" inside WhatsApp.
 */
async function getWhatsAppReminderInfo(req, res) {
  try {
    const { tenantId } = req.params;

    const { data: tenant, error } = await supabase
      .from('tenants')
      .select(
        '*, units(property_id, rent_amount, due_day_of_month, unit_name, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, properties(payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_description)), landlords(payment_method, paybill_number, paybill_account_number, till_number, payment_description)'
      )
      .eq('id', tenantId)
      .single();
    if (error || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    if (!tenant.primary_phone) {
      return res.status(400).json({ error: `${tenant.full_name} has no phone number on file.` });
    }

    if (Number(tenant.balance_due) <= 0) {
      return res.status(200).json({
        skipped: true,
        message: `${tenant.full_name} has already paid ahead and is not overdue - no reminder is needed.`,
      });
    }

    const rentAmount = tenant.rent_override || tenant.units.rent_amount;
    const dueDay = tenant.due_day_of_month || tenant.units.due_day_of_month;
    const today = new Date();
    const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
    const dueDateLabel = dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    const payInfo = buildPaymentInstructions(tenant.landlords, tenant.units);

    const message =
      today > dueDate
        ? `Hi ${tenant.full_name}, this is a reminder that your rent of KES ${rentAmount} was due on ${dueDateLabel} and is now overdue. ${payInfo.text}`
        : `Hi ${tenant.full_name}, this is a reminder that your rent of KES ${rentAmount} is due on ${dueDateLabel}. ${payInfo.text}`;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'manual_reminder_sent', targetType: 'tenant', targetId: tenantId, metadata: { channel: 'whatsapp' } });

    return res.json({ phone: tenant.primary_phone, name: tenant.full_name, message });
  } catch (err) {
    logger.error('[tenant] getWhatsAppReminderInfo error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to build WhatsApp reminder.' });
  }
}

/**
 * Section 5 (WhatsApp reminders) - bulk queue.
 *
 * Returns one { tenantId, name, phone, message } entry per overdue
 * tenant, in the same order sendBulkReminders() would notify them.
 * The frontend walks this list, opening each tenant's wa.me chat in
 * turn as the landlord sends and returns to the app ("Reminder 2 of
 * 7"). Nothing is sent server-side and no messages are logged as
 * delivered here - only the tenant tapping "Send" inside WhatsApp
 * actually sends anything.
 */
async function getWhatsAppBulkReminderQueue(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);

    const { data: landlord } = await supabase
      .from('landlords')
      .select('payment_method, paybill_number, paybill_account_number, till_number, payment_description')
      .eq('id', landlordId)
      .single();

    const { data: tenants, error } = await supabase
      .from('tenants')
      .select(
        '*, units(rent_amount, due_day_of_month, unit_name, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, properties(payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_description))'
      )
      .eq('landlord_id', landlordId)
      .eq('is_active', true);
    if (error) throw error;

    const today = new Date();
    const queue = [];
    for (const tenant of tenants || []) {
      const dueDay = tenant.due_day_of_month || tenant.units.due_day_of_month;
      const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
      if (!(today > dueDate && Number(tenant.balance_due) > 0)) continue;
      if (!tenant.primary_phone) continue;

      const rentAmount = tenant.rent_override || tenant.units.rent_amount;
      const payInfo = buildPaymentInstructions(landlord, tenant.units);
      queue.push({
        tenantId: tenant.id,
        name: tenant.full_name,
        phone: tenant.primary_phone,
        message: `Hi ${tenant.full_name}, your rent of KES ${rentAmount} for Unit ${tenant.units.unit_name} is overdue. ${payInfo.text}`,
      });
    }

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'bulk_reminders_sent', metadata: { channel: 'whatsapp', queued: queue.length } });

    return res.json({ queue });
  } catch (err) {
    logger.error('[tenant] getWhatsAppBulkReminderQueue error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to build WhatsApp reminder queue.' });
  }
}

/**
 * Bulk reminder to every overdue tenant under this landlord
 * (blueprint 11.2: "Send bulk SMS reminders to all overdue tenants").
 */
async function sendBulkReminders(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);

    const { data: landlord } = await supabase
      .from('landlords')
      .select('payment_method, paybill_number, paybill_account_number, till_number, payment_description')
      .eq('id', landlordId)
      .single();

    const { data: tenants, error } = await supabase
      .from('tenants')
      .select(
        '*, units(rent_amount, due_day_of_month, unit_name, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, properties(payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_description))'
      )
      .eq('landlord_id', landlordId)
      .eq('is_active', true);

    if (error) throw error;

    const today = new Date();

    // PERFORMANCE FIX: this used to be a plain `for...of` awaiting
    // notify() (SMS + push) one tenant at a time - the landlord's
    // "bulk remind" click sat waiting on the full round-trip of every
    // single overdue tenant's SMS before the next one even started.
    // Same bounded-concurrency fix as the cron jobs.
    let remindedCount = 0;
    await runInBatches(
      tenants || [],
      async (tenant) => {
        const rentAmount = tenant.rent_override || tenant.units.rent_amount;
        const dueDay = tenant.due_day_of_month || tenant.units.due_day_of_month;
        const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
        // Per-tenant, since a unit-level payment override only applies
        // to that one unit - a single landlord-wide payInfo would show
        // the wrong instructions to every tenant on an overridden unit.
        const payInfo = buildPaymentInstructions(landlord, tenant.units);

        if (today > dueDate && Number(tenant.balance_due) > 0) {
          await notify(
            'tenant',
            tenant.id,
            tenant.primary_phone,
            `Hi ${tenant.full_name}, your rent of KES ${rentAmount} for Unit ${tenant.units.unit_name} is overdue. ${payInfo.text}`,
            { category: 'rent_reminder', title: 'Rent Reminder' }
          );
          remindedCount += 1;
        }
      },
      {
        concurrency: 10,
        onError: (err, tenant) => { logger.error(`[tenant] sendBulkReminders: failed for tenant ${tenant.id}:`, err.message); captureException(err); },
      }
    );

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'bulk_reminders_sent', metadata: { remindedCount } });

    return res.json({ message: `Reminders sent to ${remindedCount} overdue tenant(s).`, remindedCount });
  } catch (err) {
    logger.error('[tenant] sendBulkReminders error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send bulk reminders.' });
  }
}

/**
 * Transfer a tenant from one unit to another (blueprint 7.3, 11.2).
 * The vacated unit becomes vacant; the destination unit must already
 * be vacant (can't transfer into an occupied unit).
 */
async function transferTenant(req, res) {
  try {
    const { tenantId } = req.params;
    const { newUnitId } = req.body;

    if (!newUnitId) return res.status(400).json({ error: 'newUnitId is required.' });

    const { data: tenant, error: tenantError } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
    if (tenantError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }

    const { data: newUnit, error: unitError } = await supabase.from('units').select('*').eq('id', newUnitId).single();
    if (unitError || !newUnit) return res.status(404).json({ error: 'Destination unit not found.' });

    // THE FIX for "tenants should be apartment specific, should not
    // migrate any data to another apartment": this used to accept ANY
    // unit id as a valid transfer destination as long as it was
    // vacant - with no check that it even belonged to this landlord's
    // account, let alone the same apartment/property. A landlord or
    // manager who knew (or guessed) a unit id from a completely
    // different account could move one of their own tenants into it.
    // Ownership is checked the same way the tenant's own record is
    // checked just above.
    if ((req.user.role === 'landlord' || req.user.role === 'manager') && newUnit.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'That unit does not belong to your account.' });
    }
    if (req.user.role === 'manager') {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedPropertyIds.length > 0 && !assignedPropertyIds.includes(newUnit.property_id)) {
        return res.status(403).json({ error: 'You have not been given access to that unit\u2019s apartment.' });
      }
    }
    if (newUnit.status !== 'vacant') {
      return res.status(400).json({ error: 'Destination unit must be vacant to receive a transferred tenant.' });
    }

    const oldUnitId = tenant.unit_id;

    // Re-check destination unit status right before writing (closes a
    // race where the frontend's list of "vacant" units was fetched
    // moments earlier and is now stale).
    const { data: freshUnit, error: freshUnitError } = await supabase
      .from('units')
      .select('status')
      .eq('id', newUnitId)
      .single();
    if (freshUnitError || !freshUnit) return res.status(404).json({ error: 'Destination unit not found.' });
    if (freshUnit.status !== 'vacant') {
      return res.status(400).json({ error: 'Destination unit must be vacant to receive a transferred tenant.' });
    }

    // THE FIX for "a tenant vanished after a transfer": every write
    // below used to be fire-and-forget - the .error each call returns
    // was never checked, so if any one of them silently failed, the
    // code carried on as if it had succeeded. Matches what was
    // reported: the tenant's own unit_id update could fail while
    // execution continued - the OLD unit still got flipped to
    // 'vacant' anyway, orphaning the tenant from every list that finds
    // tenants by joining through unit status, even though the tenant
    // row itself was never deleted. Every write is now checked, and a
    // failure at any step throws before any further writes happen and
    // before the "you've been moved" SMS goes out.
    const { error: tenantUpdateError } = await supabase.from('tenants').update({ unit_id: newUnitId }).eq('id', tenantId);
    if (tenantUpdateError) throw new Error(`Failed to move tenant to new unit: ${tenantUpdateError.message}`);

    const { error: oldUnitError } = await supabase.from('units').update({ status: 'vacant' }).eq('id', oldUnitId);
    if (oldUnitError) throw new Error(`Tenant moved, but failed to free up old unit: ${oldUnitError.message}`);

    const { error: newUnitError } = await supabase.from('units').update({ status: 'occupied' }).eq('id', newUnitId);
    if (newUnitError) throw new Error(`Tenant moved, but failed to mark new unit occupied: ${newUnitError.message}`);

    if (tenant.email) {
      await sendEmail(
        tenant.email,
        'You have been moved to a new unit',
        wrapEmailHtml(`Hi ${tenant.full_name}, you have been moved to Unit ${newUnit.unit_name}. Your new payment code is ${newUnit.unit_payment_code}.`)
      ).catch((e) => { logger.warn('[tenant] moveTenant: email failed (non-fatal):', e.message); captureException(e); });
    }

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'tenant_transferred', targetType: 'tenant', targetId: tenantId, metadata: { fromUnit: oldUnitId, toUnit: newUnitId } });

    return res.json({ message: 'Tenant transferred.' });
  } catch (err) {
    logger.error('[tenant] transferTenant error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to transfer tenant.' });
  }
}

/**
 * Tenant's own payment history (blueprint 12: "Full record of all
 * past payments with dates and amounts").
 */
// Shared by getPaymentHistory (JSON) and exportPaymentHistoryPdf (PDF)
// below, so the PDF can never show different rows than the in-app
// history the tenant is already looking at.
async function loadOwnPaymentHistory(tenantId) {
  const { data: tenantRow } = await supabase.from('tenants').select('history_visible_from').eq('id', tenantId).maybeSingle();

  let query = supabase
    .from('payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  // A restore that explicitly excluded old history hides it from the
  // tenant's OWN view only - the landlord/manager side (below) and
  // the archive record always show everything, on record, forever.
  if (tenantRow?.history_visible_from) {
    query = query.gte('created_at', tenantRow.history_visible_from);
  }

  const { data: payments, error } = await query;
  if (error) throw error;
  return payments || [];
}

async function getPaymentHistory(req, res) {
  try {
    const tenantId = effectiveLandlordId(req);
    const payments = await loadOwnPaymentHistory(tenantId);
    return res.json({ payments });
  } catch (err) {
    logger.error('[tenant] getPaymentHistory error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch payment history.' });
  }
}

// FEATURE (Section 8: rent history export) - PDF counterpart to the
// CSV export already available client-side on the tenant portal.
async function exportPaymentHistoryPdf(req, res) {
  try {
    const tenantId = effectiveLandlordId(req);

    const [payments, { data: tenant }] = await Promise.all([
      loadOwnPaymentHistory(tenantId),
      supabase.from('tenants').select('full_name, units(unit_name, properties(name))').eq('id', tenantId).maybeSingle(),
    ]);

    const { generatePaymentHistoryPdf } = require('../services/pdfReport.service');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-payment-history-${new Date().toISOString().slice(0, 10)}.pdf"`);

    generatePaymentHistoryPdf(res, {
      tenantName: tenant?.full_name || 'Tenant',
      unitName: tenant?.units?.unit_name || '',
      propertyName: tenant?.units?.properties?.name || '',
      payments,
      generatedAt: new Date(),
    });
  } catch (err) {
    logger.error('[tenant] exportPaymentHistoryPdf error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate payment history PDF.' });
  }
}

/**
 * Tenant's own profile (blueprint 12: "View own details - contact
 * landlord for changes" - read-only by design, hence no corresponding
 * edit endpoint here; editTenantDetails above is landlord/admin-only).
 */
async function getProfile(req, res) {
  try {
    const tenantId = effectiveLandlordId(req);

    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('*, units(*, properties(name, rules_text, caretaker_name, caretaker_phone, primary_contact_manager_id, contact_manager:primary_contact_manager_id(full_name, phone), payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_description)), landlords(full_name, phone, email, payment_method, paybill_number, paybill_account_number, till_number, payment_description)')
      .eq('id', tenantId)
      .maybeSingle();
    if (error) {
      logger.error('[tenant] getProfile query error for tenantId', tenantId, ':', error.message);
      captureException(error);
      return res.status(500).json({ error: 'Failed to load account. Please try again in a moment.' });
    }
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const paymentInstructions = buildPaymentInstructions(tenant.landlords, tenant.units);

    return res.json({ profile: { ...tenant, password_hash: undefined, otp_code: undefined }, paymentInstructions });
  } catch (err) {
    logger.error('[tenant] getProfile error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch profile.' });
  }
}

// ---------------------------------------------------------------------
// TENANT SELF-EDIT (direct request: "give tenants the ability to edit
// their own details rather than contact your landlord thing") - lets
// a logged-in tenant update their own contact-type details directly,
// the same way editTenantDetails lets a landlord/manager do it.
//
// Deliberately NOT self-editable here: full_name, id_number, and
// move_in_date (identity/record-keeping fields the landlord relies on
// matching official documents), and rentOverride/dueDayOfMonth
// (financial terms). Those still require the landlord/manager route
// above. Only the contact-type fields a tenant would reasonably need
// to fix themselves (a new phone number, a typo'd email, an outdated
// emergency contact) are exposed here.
// ---------------------------------------------------------------------
async function editOwnProfile(req, res) {
  try {
    const tenantId = effectiveLandlordId(req); // role === 'tenant' -> req.user.id
    const { secondaryPhone, email, emergencyContactName, emergencyContactPhone } = req.body;

    // FIX (adopt the same pattern updateMyProfile in
    // brandAmbassador.controller.js already uses): reject only an
    // actual CHANGE to email, not merely its presence in the body.
    // The old version 400'd on presence alone, so the tenant portal's
    // self-edit form - which shows email as a pre-filled read-only
    // field - failed to save ANYTHING, even just a secondary phone or
    // emergency contact update, purely because email rode along
    // unchanged in the payload.
    if (email !== undefined) {
      const { data: current, error: fetchErr } = await supabase.from('tenants').select('email').eq('id', tenantId).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (String(email).trim().toLowerCase() !== (current?.email || '').toLowerCase()) {
        return res.status(400).json({ error: 'Your primary email cannot be changed after registration. Contact your landlord if you need to update it.' });
      }
    }

    const updateFields = {};
    try {
      if (secondaryPhone !== undefined) updateFields.secondary_phone = secondaryPhone ? normalizePhoneOrThrow(secondaryPhone, 'Secondary phone number') : null;
      if (emergencyContactName !== undefined) updateFields.emergency_contact_name = emergencyContactName;
      if (emergencyContactPhone !== undefined) {
        updateFields.emergency_contact_phone = emergencyContactPhone
          ? normalizePhoneOrThrow(emergencyContactPhone, 'Emergency contact phone number')
          : null;
      }
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error } = await supabase.from('tenants').update(updateFields).eq('id', tenantId);
    if (error) throw error;

    logActivity({ actorType: 'tenant', actorId: tenantId, action: 'tenant_self_edited_profile', targetType: 'tenant', targetId: tenantId, metadata: updateFields });

    return res.json({ message: 'Your details have been updated.' });
  } catch (err) {
    logger.error('[tenant] editOwnProfile error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update your details.' });
  }
}


// tenant, or the tenant is deleted, the unit should automatically go
// back to vacant." There was previously no way to remove a tenant at
// all (only vacating-notice/transfer, both of which move a tenant
// somewhere else rather than removing them outright) - the unit was
// permanently stuck on 'occupied' with no path back to 'vacant' short
// of a landlord manually flipping the status dropdown themselves,
// which they'd only think to do if they remembered the unit even
// existed. This soft-deletes the tenant (is_active = false, so their
// payment history stays intact for records) and flips the unit's
// status back to 'vacant' in the same operation, atomically.
// ---------------------------------------------------------------------
async function deleteTenant(req, res) {
  try {
    const { tenantId } = req.params;
    const landlordId = effectiveLandlordId(req);

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('*, units(property_id)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });
    // HIGH FIX (isolation audit): this used to check
    // `req.user.role === 'landlord' && ...`, which meant a `manager`
    // token skipped the ownership check ENTIRELY (the `&&` short-
    // circuited to false before ever comparing landlord_id) - any
    // property manager account, on any landlord's portfolio, could
    // permanently remove a tenant that wasn't theirs. Now covers both
    // roles, same as every other tenant-action endpoint in this file,
    // plus the manager property-assignment check.
    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== landlordId) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const { error: updateTenantError } = await supabase
      .from('tenants')
      .update({ is_active: false, left_at: new Date().toISOString() })
      .eq('id', tenantId);
    if (updateTenantError) throw updateTenantError;

    // NEW (batch 8): let the tenant know their tenancy has ended and
    // their old login has been deactivated - non-critical, so a
    // failure here never undoes the archive itself above.
    if (tenant.email) {
      try {
        const endedBody = templates.tenancyEnded(tenant.full_name);
        await sendEmail(tenant.email, 'Your RentaPay tenancy has ended', wrapEmailHtml(endedBody));
      } catch (notifyErr) {
        logger.error('[tenant] deleteTenant: tenancy-ended email failed to send:', notifyErr.message);
        captureException(notifyErr);
      }
    }

    // Only vacate the unit if THIS tenant was the one occupying it -
    // guards against a stale/duplicate request accidentally vacating a
    // unit that's since been reassigned to someone else.
    const { data: unit } = await supabase.from('units').select('id, status').eq('id', tenant.unit_id).maybeSingle();
    if (unit && unit.status === 'occupied') {
      await supabase.from('units').update({ status: 'vacant' }).eq('id', tenant.unit_id);
    }

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'tenant_removed',
      targetType: 'tenant',
      targetId: tenantId,
      metadata: { unitId: tenant.unit_id },
    });

    return res.json({ message: 'Tenant removed and unit marked vacant.' });
  } catch (err) {
    logger.error('[tenant] deleteTenant error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to remove tenant.' });
  }
}

// ---------------------------------------------------------------------
// ARCHIVED TENANTS - direct request: "we should have in menu a UI for
// payment histories and details of archived and deleted tenants...
// with a UI to restore them." Every "delete" in this app is actually
// deleteTenant's soft-delete above (is_active = false) - nothing here
// is a new deletion path, this just makes what was already being kept
// actually visible and recoverable instead of looking gone forever.
// ---------------------------------------------------------------------
/**
 * True if this archived tenant's phone or email now belongs to a
 * DIFFERENT active tenant elsewhere - i.e. another landlord has since
 * added them using the same identity. Used to hide/block restore
 * (direct request: "hide the restore button... tell them they have
 * another acct under another landlord"). Their historical ratings/
 * payments still count toward the portable reputation regardless -
 * this only gates which landlord can pull the ACTIVE account back.
 */
async function findRestoreConflict(archivedTenant) {
  const orParts = [`primary_phone.eq.${archivedTenant.primary_phone}`];
  if (archivedTenant.email) orParts.push(`email.eq.${archivedTenant.email}`);

  // NOTE: maybeSingle() throws if the phone matches one active tenant
  // and the email matches a DIFFERENT active tenant (2 rows for an
  // .or() filter). Use limit(1) + take the first match instead, so a
  // genuine conflict on either field still blocks the restore without
  // ever throwing.
  const { data: claimedByRows } = await supabase
    .from('tenants')
    .select('id, landlord_id, full_name, landlords(full_name)')
    .eq('is_active', true)
    .neq('id', archivedTenant.id)
    .or(orParts.join(','))
    .limit(1);

  return claimedByRows?.[0] || null;
}

async function listArchivedTenants(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);

    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('*, units(id, unit_name, status, property_id, properties(name))')
      .eq('landlord_id', landlordId)
      .eq('is_active', false)
      .order('left_at', { ascending: false });
    if (error) throw error;

    // Total paid, per archived tenant, so this list doubles as the
    // "payment history and details" summary the request asked for
    // without a separate round trip per row.
    const tenantIds = (tenants || []).map((t) => t.id);
    let totalsByTenant = {};
    if (tenantIds.length) {
      const { data: payments } = await supabase
        .from('payments')
        .select('tenant_id, amount, status')
        .in('tenant_id', tenantIds)
        .eq('status', 'completed');
      totalsByTenant = (payments || []).reduce((acc, p) => {
        acc[p.tenant_id] = (acc[p.tenant_id] || 0) + Number(p.amount);
        return acc;
      }, {});
    }

    const result = await Promise.all(
      (tenants || []).map(async (t) => {
        const conflict = await findRestoreConflict(t);
        return {
          ...t,
          totalPaidHistorically: totalsByTenant[t.id] || 0,
          // Frontend hides/disables the Restore button when this is set.
          claimedElsewhere: conflict ? { landlordName: conflict.landlords?.full_name || 'another landlord' } : null,
        };
      })
    );
    return res.json({ archivedTenants: result });
  } catch (err) {
    logger.error('[tenant] listArchivedTenants error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch archived tenants.' });
  }
}

async function restoreTenant(req, res) {
  try {
    const { tenantId } = req.params;
    const landlordId = effectiveLandlordId(req);
    const { unitId, includeHistory } = req.body;

    if (!unitId) return res.status(400).json({ error: 'Choose which unit to restore this tenant into.' });
    if (includeHistory === undefined) {
      return res.status(400).json({ error: 'Specify whether to restore their payment history too (includeHistory: true/false).' });
    }

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Archived tenant not found.' });
    if (tenant.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this tenant.' });
    if (tenant.is_active) return res.status(400).json({ error: 'This tenant is not archived.' });

    // The core conflict case from the spec: this tenant's phone/email
    // may have been picked up by a different landlord since being
    // archived here. Reject even if the frontend's Restore button was
    // somehow still clickable (stale UI, race condition) - this is
    // the authoritative check.
    const conflict = await findRestoreConflict(tenant);
    if (conflict) {
      return res.status(409).json({
        error: 'This tenant already has an active account under another landlord and can\'t be restored here.',
        claimedElsewhere: true,
      });
    }

    // FIX ("if they choose a unit that's occupied, give an error - not
    // just vanishing the tenant"): same guard as transferTenant, same
    // reasoning - re-check right before writing rather than trusting
    // whatever the frontend's unit list happened to show a moment ago.
    const { data: destUnit, error: unitErr } = await supabase.from('units').select('id, status, landlord_id, property_id').eq('id', unitId).single();
    if (unitErr || !destUnit) return res.status(404).json({ error: 'Destination unit not found.' });
    if (destUnit.landlord_id !== landlordId) return res.status(403).json({ error: 'That unit is not on your account.' });
    const propertyAccessError = await checkManagerPropertyAccess(req, destUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (destUnit.status !== 'vacant') return res.status(400).json({ error: 'Destination unit must be vacant to restore a tenant into it.' });

    const updateFields = {
      is_active: true,
      left_at: null,
      unit_id: unitId,
      // Never automated either way - exactly what was asked for a
      // moment ago in the request body, nothing inferred.
      history_visible_from: includeHistory ? null : new Date().toISOString(),
    };

    const { error: tenantUpdateErr } = await supabase.from('tenants').update(updateFields).eq('id', tenantId);
    if (tenantUpdateErr) throw new Error(`Failed to restore tenant: ${tenantUpdateErr.message}`);

    const { error: unitUpdateErr } = await supabase.from('units').update({ status: 'occupied' }).eq('id', unitId);
    if (unitUpdateErr) throw new Error(`Tenant restored, but failed to mark the unit occupied: ${unitUpdateErr.message}`);

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'tenant_restored',
      targetType: 'tenant',
      targetId: tenantId,
      metadata: { unitId, includeHistory },
    });

    return res.json({ message: `${tenant.full_name} restored${includeHistory ? ' with their full payment history' : ' with a clean payment history'}.` });
  } catch (err) {
    logger.error('[tenant] restoreTenant error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to restore tenant.' });
  }
}

// ---------------------------------------------------------------------
// TENANT LISTS FOR EXPORT (Excel download tab + "Add to WhatsApp
// Group" tab, per apartment):
//   - 'current'  : everyone currently active in the apartment (or one
//                  unit, if unitId given) - unit-specific per request.
//   - 'joined'   : tenants whose move_in_date falls in the given
//                  {year, month}.
//   - 'left'     : tenants whose left_at falls in the given
//                  {year, month} - archiving a tenant (deleteTenant
//                  above) automatically puts them on this list from
//                  that point on, no separate action needed.
//   - 'left_all' : every tenant who has ever left, all time.
// Every row carries contact details + photo_url so the frontend can
// render the "tap to expand" contact card, and the Excel sheet can
// link/show the profile picture.
// ---------------------------------------------------------------------
async function listTenantsForExport(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, unitId, listType = 'current', year, month } = req.query;

    if (req.user.role === 'manager') {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (propertyId && !assignedPropertyIds.includes(propertyId)) {
        return res.status(403).json({ error: 'You do not have access to this apartment.' });
      }
    }

    let unitsQuery = supabase.from('units').select('id, unit_name, property_id').eq('landlord_id', landlordId);
    if (unitId) unitsQuery = unitsQuery.eq('id', unitId);
    else if (propertyId) unitsQuery = unitsQuery.eq('property_id', propertyId);
    const { data: units, error: unitsErr } = await unitsQuery;
    if (unitsErr) throw unitsErr;
    const unitIds = (units || []).map((u) => u.id);
    const unitNameById = Object.fromEntries((units || []).map((u) => [u.id, u.unit_name]));
    if (unitIds.length === 0) return res.json({ tenants: [] });

    let query = supabase
      .from('tenants')
      .select('id, full_name, primary_phone, secondary_phone, email, photo_url, id_number, unit_id, move_in_date, left_at, is_active, emergency_contact_name, emergency_contact_phone')
      .in('unit_id', unitIds);

    if (listType === 'current') {
      query = query.eq('is_active', true);
    } else if (listType === 'joined') {
      if (!year || !month) return res.status(400).json({ error: 'year and month are required for the "joined" list.' });
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const end = new Date(Number(year), Number(month), 1).toISOString().slice(0, 10); // first day of next month
      query = query.gte('move_in_date', start).lt('move_in_date', end);
    } else if (listType === 'left') {
      if (!year || !month) return res.status(400).json({ error: 'year and month are required for the "left" list.' });
      const start = new Date(Number(year), Number(month) - 1, 1).toISOString();
      const end = new Date(Number(year), Number(month), 1).toISOString();
      query = query.eq('is_active', false).gte('left_at', start).lt('left_at', end);
    } else if (listType === 'left_all') {
      query = query.eq('is_active', false).order('left_at', { ascending: false });
    } else {
      return res.status(400).json({ error: "listType must be 'current', 'joined', 'left', or 'left_all'." });
    }

    const { data: tenants, error } = await query;
    if (error) throw error;

    const rows = (tenants || []).map((t) => ({
      id: t.id,
      fullName: t.full_name,
      unitName: unitNameById[t.unit_id] || '—',
      phone: t.primary_phone,
      secondaryPhone: t.secondary_phone || '',
      email: t.email || '',
      photoUrl: t.photo_url || '',
      idNumber: t.id_number,
      emergencyContactName: t.emergency_contact_name,
      emergencyContactPhone: t.emergency_contact_phone,
      moveInDate: t.move_in_date,
      leftAt: t.left_at,
      isActive: t.is_active,
    }));

    return res.json({ tenants: rows });
  } catch (err) {
    logger.error('[tenant] listTenantsForExport error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch tenant list.' });
  }
}

// ---------------------------------------------------------------------
// "Add to WhatsApp Group" tab - creates (first use) or adds to
// (subsequent uses) a real WhatsApp group for this apartment's tenant
// list, via the whatsapp-web.js session in whatsapp.service.js. The
// group id is saved on the property so repeat use adds newcomers to
// the SAME group instead of creating a new one every time.
// ---------------------------------------------------------------------
// REPLACES the old "Add to WhatsApp Group" action (direct request:
// "remove the add to whatsapp feature and replace it with something
// relevant"). That feature depended on a third-party WhatsApp
// automation service and only ever did one thing: dump phone numbers
// into a group chat outside RentaPay entirely, with no record of what
// was actually said. This keeps the same checkbox-selection UI
// (TenantListExport.jsx) but sends a real, tracked SMS straight from
// RentaPay to just the selected tenants - useful for things a full
// property-wide announcement is overkill for (e.g. "you three still
// haven't paid this week", "reminder for the tenants meeting Friday").
async function sendBulkSmsToSelectedTenants(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, tenantIds, message } = req.body;
    if (!propertyId) return res.status(400).json({ error: 'propertyId is required.' });
    if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
      return res.status(400).json({ error: 'tenantIds must be a non-empty array.' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Enter a message to send.' });
    }

    if (req.user.role === 'manager') {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (!assignedPropertyIds.includes(propertyId)) {
        return res.status(403).json({ error: 'You do not have access to this apartment.' });
      }
    }

    const { data: property, error: propErr } = await supabase
      .from('properties')
      .select('id, name')
      .eq('id', propertyId)
      .eq('landlord_id', landlordId)
      .maybeSingle();
    if (propErr) throw propErr;
    if (!property) return res.status(404).json({ error: 'Apartment not found on your account.' });

    const { data: tenants, error: tenantsErr } = await supabase
      .from('tenants')
      .select('id, primary_phone, units!inner(landlord_id)')
      .in('id', tenantIds)
      .eq('units.landlord_id', landlordId);
    if (tenantsErr) throw tenantsErr;
    const usable = (tenants || []).filter((t) => t.primary_phone);
    if (usable.length === 0) return res.status(400).json({ error: 'None of the selected tenants have a usable phone number.' });

    const results = await Promise.allSettled(
      usable.map((t) => notify('tenant', t.id, t.primary_phone, message.trim(), { title: 'Message from your landlord', category: 'direct_message', urgent: true }))
    );
    // FIX: notify() now only rejects when a recipient got NOTHING
    // (no SMS, no portal inbox row) - so "fulfilled" here means the
    // message genuinely landed somewhere for that tenant, not just
    // that the function call didn't throw.
    const sentCount = results.filter((r) => r.status === 'fulfilled').length;
    if (sentCount === 0 && usable.length > 0) {
      return res.status(502).json({ error: 'Failed to deliver the message to any selected tenant. Please try again.' });
    }

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'bulk_sms_sent_to_selected_tenants',
      targetType: 'property',
      targetId: propertyId,
      metadata: { count: sentCount, of: usable.length },
    });

    return res.json({ message: `Sent to ${sentCount} of ${usable.length} selected tenant${usable.length === 1 ? '' : 's'}.` });
  } catch (err) {
    logger.error('[tenant] sendBulkSmsToSelectedTenants error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send message.' });
  }
}


// ---------------------------------------------------------------------
// SETTLE A TENANT'S SECURITY DEPOSIT (direct request: "a security
// deposit refundable upon vacating depending on damages"). Completely
// separate from balance_due/payments - this never adds to or draws
// from what the tenant owes in rent. Can be called independently of
// removing the tenant (a landlord may settle the deposit before or
// after formally removing them from the unit).
// ---------------------------------------------------------------------
async function settleDeposit(req, res) {
  try {
    const { tenantId } = req.params;
    const landlordId = effectiveLandlordId(req);
    const { status, refundedAmount, deductionReason } = req.body;

    if (!['refunded', 'partially_refunded', 'forfeited'].includes(status)) {
      return res.status(400).json({ error: 'status must be refunded, partially_refunded, or forfeited.' });
    }

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('id, landlord_id, deposit_amount, units(property_id)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });
    // HIGH FIX (isolation audit): same bug as deleteTenant above - the
    // `req.user.role === 'landlord' && ...` check let manager tokens
    // bypass ownership entirely and settle (refund/forfeit) a deposit
    // for a tenant on a completely different landlord's account.
    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== landlordId) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (!tenant.deposit_amount) {
      return res.status(400).json({ error: 'No deposit was recorded for this tenant.' });
    }
    if (status !== 'forfeited' && (refundedAmount == null || Number(refundedAmount) < 0 || Number(refundedAmount) > Number(tenant.deposit_amount))) {
      return res.status(400).json({ error: 'refundedAmount must be between 0 and the original deposit amount.' });
    }

    const { data: updated, error } = await supabase
      .from('tenants')
      .update({
        deposit_status: status,
        deposit_refunded_amount: status === 'forfeited' ? 0 : Number(refundedAmount),
        deposit_deduction_reason: deductionReason || null,
        deposit_settled_at: new Date().toISOString(),
        deposit_settled_by_type: req.user.role,
        deposit_settled_by_id: req.user.id,
      })
      .eq('id', tenantId)
      .select('id, deposit_amount, deposit_status, deposit_refunded_amount, deposit_deduction_reason, deposit_settled_at')
      .single();
    if (error) throw error;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'tenant_deposit_settled',
      targetType: 'tenant',
      targetId: tenantId,
      metadata: { status, refundedAmount: updated.deposit_refunded_amount, deductionReason: deductionReason || null },
    });

    return res.json({ message: 'Deposit settled.', tenant: updated });
  } catch (err) {
    logger.error('[tenant] settleDeposit error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to settle deposit.' });
  }
}

// ---------------------------------------------------------------------
// TENANT REPUTATION - landlords rating tenants, portable by email
// (rentapay-notes: email is the durable cross-landlord identity
// thread). Ratings live in tenant_ratings and are aggregated by
// reputation.service.js across every landlord that tenant has ever
// had, not just the one submitting/viewing right now.
// ---------------------------------------------------------------------

/**
 * A landlord/manager rates a tenant they currently manage. One row
 * per landlord+tenant-email+category - rating the same tenant again
 * updates the existing rating rather than stacking duplicates,
 * matching the unique index in the migration.
 */
const RATING_CATEGORIES = ['overall', 'payment', 'property_care', 'communication', 'conduct'];

/**
 * DIRECT REQUEST: raters submit every category (overall, payment,
 * property_care, communication, conduct) together in a single
 * action, instead of one category per submit. The endpoint accepts a
 * `ratings` array of { category, rating, comment } and upserts each
 * row in one pass. The legacy single { rating, category, comment }
 * shape still works too, wrapped into a one-item array, so nothing
 * else calling this endpoint breaks.
 */
async function rateTenant(req, res) {
  try {
    const { tenantId } = req.params;
    const landlordId = effectiveLandlordId(req);

    let entries = Array.isArray(req.body.ratings) ? req.body.ratings : null;
    if (!entries) {
      const { rating, category, comment } = req.body;
      entries = [{ rating, category: category || 'overall', comment }];
    }
    if (!entries.length) {
      return res.status(400).json({ error: 'At least one category rating is required.' });
    }

    const cleanedEntries = [];
    for (const entry of entries) {
      const ratingNum = Number(entry.rating);
      const ratingCategory = entry.category || 'overall';
      if (!RATING_CATEGORIES.includes(ratingCategory)) {
        return res.status(400).json({ error: `Category must be one of: ${RATING_CATEGORIES.join(', ')}.` });
      }
      if (!ratingNum) {
        if (ratingCategory === 'overall') {
          return res.status(400).json({ error: 'Overall rating is required.' });
        }
        continue; // optional category left blank in this submission
      }
      if (ratingNum < 1 || ratingNum > 5 || !Number.isInteger(ratingNum)) {
        return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5.' });
      }
      if (checkComment(entry.comment).blocked) {
        return res.status(400).json({ error: 'Please remove abusive or profane language from your comment.' });
      }
      cleanedEntries.push({ ratingNum, ratingCategory, comment: entry.comment || null });
    }
    if (!cleanedEntries.length) {
      return res.status(400).json({ error: 'At least one category rating is required.' });
    }

    const { data: tenant, error: tenantError } = await supabase.from('tenants').select('*, units(*)').eq('id', tenantId).single();
    if (tenantError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });
    if (tenant.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this tenant.' });
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (!tenant.email) {
      return res.status(400).json({ error: 'This tenant has no email on file, so a rating cannot be linked to their portable reputation.' });
    }

    const normalizedEmail = reputationService.normalizeEmail(tenant.email);
    const raterRole = req.user.role === 'landlord' ? 'landlord' : (req.user.roleLevel === 'caretaker' ? 'caretaker' : 'manager');
    const nowIso = new Date().toISOString();

    const rows = cleanedEntries.map(({ ratingNum, ratingCategory, comment }) => ({
      landlord_id: landlordId,
      tenant_id: tenant.id,
      unit_id: tenant.unit_id,
      tenant_email: normalizedEmail,
      tenant_phone: tenant.primary_phone,
      tenant_name_at_rating: tenant.full_name,
      rating: ratingNum,
      category: ratingCategory,
      rater_role: raterRole,
      comment,
      updated_at: nowIso,
    }));

    const { data: savedRatings, error } = await supabase
      .from('tenant_ratings')
      .upsert(rows, { onConflict: 'landlord_id,tenant_email,category,rater_role' })
      .select();
    if (error) throw error;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'tenant_rated',
      targetType: 'tenant',
      targetId: tenant.id,
      metadata: { categories: cleanedEntries.map((e) => e.ratingCategory), raterRole },
    });

    // Clear this tenant from the rater's "still needs rating" queue
    // (used by the reminder popups) now that a rating's been given.
    try {
      await supabase
        .from('tenant_rating_reminders')
        .delete()
        .eq('tenant_id', tenant.id)
        .eq('rater_user_type', tenantRatingReminderService.raterUserType(req.user.role))
        .eq('rater_user_id', req.user.id);
    } catch (dismissErr) {
      logger.error('[tenant] rateTenant reminder-clear error:', dismissErr.message);
    }

    const reputation = await reputationService.getReputationByEmail(normalizedEmail);
    return res.status(201).json({ message: 'Rating saved.', ratingRecords: savedRatings, reputation });
  } catch (err) {
    logger.error('[tenant] rateTenant error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to save rating.' });
  }
}

/**
 * GET /tenants/rating-reminders/next
 * DIRECT REQUEST: powers the random "rate this tenant" popup - also
 * surfaces payment-triggered nudges first if one is queued.
 */
async function getNextRatingReminder(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const reminder = await tenantRatingReminderService.getNextReminder({
      role: req.user.role,
      roleLevel: req.user.roleLevel,
      userId: req.user.id,
      landlordId,
    });
    return res.json({ reminder });
  } catch (err) {
    logger.error('[tenant] getNextRatingReminder error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load rating reminders.' });
  }
}

/** POST /tenants/rating-reminders/:reminderId/snooze  body: { mode: 'later' | 'not_today' } */
async function snoozeRatingReminder(req, res) {
  try {
    const { reminderId } = req.params;
    const mode = req.body.mode === 'not_today' ? 'not_today' : 'later';
    await tenantRatingReminderService.snoozeReminder({
      reminderId,
      userId: req.user.id,
      userType: tenantRatingReminderService.raterUserType(req.user.role),
      mode,
    });
    return res.json({ message: 'Reminder snoozed.' });
  } catch (err) {
    logger.error('[tenant] snoozeRatingReminder error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to snooze reminder.' });
  }
}

/**
 * A tenant flags a rating left about them as bad-faith (direct
 * request: give tenants the same recourse landlords already have via
 * ratingFlag.controller.js). Scoped by tenant_email, not just
 * tenant_id, so this also covers ratings left by a PRIOR landlord
 * (tenant_ratings.tenant_id gets set null if that old tenancy row is
 * ever archived/deleted, but the email-keyed row itself persists).
 */
async function flagTenantRating(req, res) {
  try {
    const { ratingId } = req.params;
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please explain why you believe this rating is unfair.' });

    const { data: me, error: meError } = await supabase.from('tenants').select('id, email').eq('id', req.user.id).maybeSingle();
    if (meError || !me || !me.email) return res.status(404).json({ error: 'Tenant record not found.' });
    const myEmail = reputationService.normalizeEmail(me.email);

    const { data: rating, error: fetchError } = await supabase
      .from('tenant_ratings')
      .select('id, tenant_email, flag_status')
      .eq('id', ratingId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!rating) return res.status(404).json({ error: 'Rating not found.' });
    if (reputationService.normalizeEmail(rating.tenant_email) !== myEmail) {
      return res.status(403).json({ error: 'This rating is not about you.' });
    }
    if (rating.flag_status === 'flagged') {
      return res.status(409).json({ error: 'This rating already has a pending flag.' });
    }
    if (rating.flag_status === 'removed') {
      return res.status(409).json({ error: 'This rating was already removed from your reputation.' });
    }

    const { error: updateError } = await supabase
      .from('tenant_ratings')
      .update({
        flag_status: 'flagged',
        flagged_by_tenant_id: me.id,
        flag_reason: reason,
        flagged_at: new Date().toISOString(),
        flag_resolved_at: null,
        flag_resolution_note: null,
      })
      .eq('id', ratingId);
    if (updateError) throw updateError;

    logActivity({ actorType: 'tenant', actorId: me.id, action: 'rating_flagged', targetType: 'tenant_ratings', targetId: ratingId, metadata: { reason } });

    const reputation = await reputationService.getReputationByEmail(myEmail);
    return res.json({ message: 'Rating flagged for review. It is excluded from your reputation average while pending.', reputation });
  } catch (err) {
    logger.error('[tenant] flagTenantRating error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to flag rating.' });
  }
}


async function getTenantReputation(req, res) {
  try {
    const { tenantId } = req.params;
    const { data: tenant, error } = await supabase.from('tenants').select('id, email, landlord_id, units(property_id)').eq('id', tenantId).single();
    if (error || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    if ((req.user.role === 'landlord' || req.user.role === 'manager') && tenant.landlord_id !== effectiveLandlordId(req)) {
      return res.status(403).json({ error: 'You do not manage this tenant.' });
    }
    if (req.user.role === 'tenant' && req.user.id !== tenant.id) {
      return res.status(403).json({ error: 'You can only view your own reputation.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    if (!tenant.email) return res.json({ reputation: { tenantEmail: null, totalRatings: 0, averageRating: null, byCategory: {}, priorLandlordCount: 0, ratings: [] } });

    const reputation = await reputationService.getReputationByEmail(tenant.email);
    return res.json({ reputation });
  } catch (err) {
    logger.error('[tenant] getTenantReputation error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch reputation.' });
  }
}

// ---------------------------------------------------------------------
// FEATURE (direct request #4 - tenant reputation flow): a tenant can
// generate a shareable link to their own portable reputation summary,
// to paste into a WhatsApp inquiry message when contacting a landlord
// about a vacant unit on the public listings page. Opt-in and
// tenant-initiated only - nothing is ever shared automatically.
//
// A signed JWT (not a DB row) carries the tenant's normalized email -
// reputation is already keyed by email (reputation.service.js), so no
// new table is needed just to resolve "whose score is this". A long
// expiry (90 days) keeps the link usable across a whole unit search
// without living forever if it ever leaks.
// ---------------------------------------------------------------------
const jwt = require('jsonwebtoken');
const REPUTATION_SHARE_SECRET = process.env.JWT_SECRET;
const REPUTATION_SHARE_EXPIRES_IN = '90d';

async function getMyReputationShareLink(req, res) {
  try {
    const { data: me, error } = await supabase.from('tenants').select('id, email, full_name').eq('id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!me) return res.status(404).json({ error: 'Tenant not found.' });
    if (!me.email) {
      return res.status(400).json({ error: 'Add an email address to your profile before sharing your reputation.' });
    }

    const normalizedEmail = reputationService.normalizeEmail(me.email);
    const token = jwt.sign({ purpose: 'reputation_share', tenantEmail: normalizedEmail, tenantName: me.full_name }, REPUTATION_SHARE_SECRET, {
      expiresIn: REPUTATION_SHARE_EXPIRES_IN,
    });

    const frontendUrl = process.env.FRONTEND_URL || 'https://rentapay.co.ke';
    const shareUrl = `${frontendUrl}/reputation/${token}`;

    // Handed back alongside the link so the frontend can show a live
    // preview of what a landlord would see, without a second request.
    const reputation = await reputationService.getReputationByEmail(normalizedEmail);

    return res.json({ shareUrl, reputation });
  } catch (err) {
    logger.error('[tenant] getMyReputationShareLink error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to generate share link.' });
  }
}

/**
 * Reputations table for the landlord dashboard - every active tenant
 * this landlord currently manages, each with their portable,
 * cross-landlord reputation score attached.
 */
async function listTenantReputations(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);

    let unitsQuery = supabase.from('units').select('id, property_id').eq('landlord_id', landlordId);
    if (req.user.role === 'manager') {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedPropertyIds.length > 0) unitsQuery = unitsQuery.in('property_id', assignedPropertyIds);
    }
    const { data: units, error: unitsErr } = await unitsQuery;
    if (unitsErr) throw unitsErr;
    const unitIds = (units || []).map((u) => u.id);
    if (!unitIds.length) return res.json({ reputations: [] });

    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, full_name, email, primary_phone, is_active, unit_id, units!inner(unit_name, properties(name))')
      .in('unit_id', unitIds)
      .eq('is_active', true)
      .not('email', 'is', null);
    if (error) throw error;

    const reputations = await reputationService.getReputationsByEmails((tenants || []).map((t) => t.email));

    const rows = (tenants || []).map((t) => {
      const rep = reputations[reputationService.normalizeEmail(t.email)] || { totalRatings: 0, averageRating: null, priorLandlordCount: 0 };
      return {
        tenantId: t.id,
        fullName: t.full_name,
        email: t.email,
        unitName: t.units?.unit_name,
        propertyName: t.units?.properties?.name,
        averageRating: rep.averageRating,
        totalRatings: rep.totalRatings,
        priorLandlordCount: rep.priorLandlordCount,
      };
    });

    rows.sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0));

    return res.json({ reputations: rows });
  } catch (err) {
    logger.error('[tenant] listTenantReputations error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch tenant reputations.' });
  }
}

// ---------------------------------------------------------------------
// MIRROR SIDE - tenant rates their own (current) landlord. Deliberately
// scoped to the tenant's own active landlord_id, and the read side
// (getMyLandlordReputation) only ever returns the AGGREGATE, never a
// list of individual ratings - see landlordReputation.service.js.
// ---------------------------------------------------------------------

async function rateLandlord(req, res) {
  try {
    const tenantId = effectiveLandlordId(req); // tenant routes use this helper for req.user.id too
    const { rating, category, comment } = req.body;

    const ratingNum = Number(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5 || !Number.isInteger(ratingNum)) {
      return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5.' });
    }
    const allowedCategories = ['overall', 'maintenance_response', 'deposit_handling', 'communication'];
    const ratingCategory = category || 'overall';
    if (!allowedCategories.includes(ratingCategory)) {
      return res.status(400).json({ error: `Category must be one of: ${allowedCategories.join(', ')}.` });
    }
    if (checkComment(comment).blocked) {
      return res.status(400).json({ error: 'Please remove abusive or profane language from your comment.' });
    }

    const { data: tenant, error: tenantError } = await supabase.from('tenants').select('id, landlord_id, is_active').eq('id', tenantId).single();
    if (tenantError || !tenant) return res.status(404).json({ error: 'Tenant account not found.' });

    const { data: savedRating, error } = await supabase
      .from('landlord_ratings')
      .upsert(
        {
          landlord_id: tenant.landlord_id,
          tenant_id: tenant.id,
          rating: ratingNum,
          category: ratingCategory,
          comment: comment || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,landlord_id,category' }
      )
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: 'tenant', actorId: tenant.id, action: 'landlord_rated', targetType: 'landlord', targetId: tenant.landlord_id, metadata: { rating: ratingNum, category: ratingCategory } });

    const reputation = await landlordReputationService.getLandlordReputation(tenant.landlord_id);
    return res.status(201).json({ message: 'Rating saved.', ratingRecord: savedRating, reputation });
  } catch (err) {
    logger.error('[tenant] rateLandlord error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to save rating.' });
  }
}

async function getMyLandlordReputation(req, res) {
  try {
    const tenantId = effectiveLandlordId(req);
    const { data: tenant, error } = await supabase.from('tenants').select('landlord_id').eq('id', tenantId).single();
    if (error || !tenant) return res.status(404).json({ error: 'Tenant account not found.' });

    const reputation = await landlordReputationService.getLandlordReputation(tenant.landlord_id);
    return res.json({ reputation });
  } catch (err) {
    logger.error('[tenant] getMyLandlordReputation error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch landlord reputation.' });
  }
}

// Phase 1 of the utility-billing rework: real invoices a tenant can
// see and pay separately from rent (see utilitySubmetering.controller
// finalizeRun, which is the only writer of utility_invoices rows).
// Landlord/manager can pass ?tenantId= to view another tenant's bills;
// a tenant can only ever see their own.
async function getUtilityInvoices(req, res) {
  try {
    const tenantId = req.user.role === 'tenant' ? req.user.id : req.query.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required.' });

    if (req.user.role !== 'tenant') {
      const { data: tenant } = await supabase.from('tenants').select('id, landlord_id').eq('id', tenantId).maybeSingle();
      if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
      if (effectiveLandlordId(req) !== tenant.landlord_id) return res.status(403).json({ error: 'Not authorized for this tenant.' });
    }

    const { data: invoices, error } = await supabase
      .from('utility_invoices')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const byType = {};
    for (const inv of invoices || []) {
      if (!byType[inv.utility_type]) byType[inv.utility_type] = { utilityType: inv.utility_type, totalOwed: 0, invoices: [] };
      byType[inv.utility_type].invoices.push(inv);
      if (inv.status !== 'paid') byType[inv.utility_type].totalOwed += Number(inv.amount) - Number(inv.amount_paid || 0);
    }
    for (const key of Object.keys(byType)) byType[key].totalOwed = Math.round(byType[key].totalOwed * 100) / 100;

    return res.json({ invoices, byType: Object.values(byType) });
  } catch (err) {
    logger.error('[tenant] getUtilityInvoices error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load utility invoices.' });
  }
}

// Combined rent + utility totals for the tenant portal's "you owe
// rent + water + electricity = X" bottom line. Rent and each utility
// type stay fully independent numbers - this just adds them up for
// display, it never merges the underlying balances.
async function getAccountSummary(req, res) {
  try {
    const tenantId = req.user.id;
    const { data: tenant, error } = await supabase.from('tenants').select('balance_due').eq('id', tenantId).maybeSingle();
    if (error) throw error;
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const { data: invoices, error: invErr } = await supabase
      .from('utility_invoices')
      .select('utility_type, amount, amount_paid, status')
      .eq('tenant_id', tenantId)
      .neq('status', 'paid');
    if (invErr) throw invErr;

    const byType = {};
    for (const inv of invoices || []) {
      const owed = Math.round((Number(inv.amount) - Number(inv.amount_paid || 0)) * 100) / 100;
      byType[inv.utility_type] = Math.round(((byType[inv.utility_type] || 0) + owed) * 100) / 100;
    }

    const rentOwed = Math.max(0, Number(tenant.balance_due) || 0);
    const utilitiesTotal = Object.values(byType).reduce((a, b) => a + b, 0);
    const totalOwed = Math.round((rentOwed + utilitiesTotal) * 100) / 100;

    return res.json({ rentOwed, utilities: byType, totalOwed });
  } catch (err) {
    logger.error('[tenant] getAccountSummary error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load account summary.' });
  }
}

module.exports = {
  addTenant,
  deleteTenant,
  settleDeposit,
  listArchivedTenants,
  restoreTenant,
  getBalance,
  getTenant,
  editTenantDetails,
  editBalance,
  submitVacatingNotice,
  cancelVacatingNotice,
  revokeVacatingNotice,
  remindTenant,
  sendBulkReminders,
  getWhatsAppReminderInfo,
  getWhatsAppBulkReminderQueue,
  transferTenant,
  getPaymentHistory,
  exportPaymentHistoryPdf,
  getProfile,
  editOwnProfile,
  listTenantsForExport,
  sendBulkSmsToSelectedTenants,
  rateTenant,
  getNextRatingReminder,
  snoozeRatingReminder,
  getTenantReputation,
  flagTenantRating,
  listTenantReputations,
  rateLandlord,
  getUtilityInvoices,
  getAccountSummary,
  getMyLandlordReputation,
  getMyReputationAsLandlord,
  listRateableStaff,
  rateStaff,
  getMyStaffReputation,
  rateProperty,
  getMyPropertyReputation,
  getMyReputationShareLink,
  createTenantRecord,
};

// ---------------------------------------------------------------------
// direct request #8: "Landlords/Managers/Caretakers currently have no
// visibility into their own ratings at all." These four functions
// close that gap - one for the landlord's own aggregate (built on the
// landlord_ratings table that already existed for rateLandlord
// above), and three for tenants rating/viewing their property's
// manager and caretaker (built on the new staff_ratings table).
// ---------------------------------------------------------------------

/** A landlord viewing their own aggregate rating, as left by tenants. */
async function getMyReputationAsLandlord(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const reputation = await landlordReputationService.getLandlordReputation(landlordId);
    return res.json({ reputation });
  } catch (err) {
    logger.error('[tenant] getMyReputationAsLandlord error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch your reputation.' });
  }
}

/**
 * Resolves the manager and/or caretaker assigned to the calling
 * tenant's own property, so the tenant portal knows who it can offer
 * a "rate" button for. Same "no assignment rows = covers every
 * property" convention used in public.controller.js's getUnitContact.
 * Only surfaces a manager/caretaker who is both still active (not
 * removed by the landlord) AND has actually logged in and set a real
 * password at least once (not just invited) - see isSetUp below.
 */
async function listRateableStaff(req, res) {
  try {
    const { data: tenant, error: tenantErr } = await supabase.from('tenants').select('id, landlord_id, unit_id, units(property_id)').eq('id', req.user.id).single();
    if (tenantErr || !tenant) return res.status(404).json({ error: 'Tenant record not found.' });

    const propertyId = tenant.units?.property_id || null;

    const { data: managers, error: mErr } = await supabase
      .from('property_managers')
      .select('id, full_name, role_level, must_change_password, property_manager_assignments(property_id)')
      .eq('landlord_id', tenant.landlord_id)
      .eq('is_active', true);
    if (mErr) throw mErr;

    // FIX (direct request): "manager and caretaker accounts that have
    // not been set up... should not be listed to be rated." is_active
    // alone only rules out a REMOVED manager - a landlord adding a
    // brand-new manager creates their row as is_active: true right
    // away (so the temp-password email works immediately), but that
    // person hasn't actually done anything as a manager yet until
    // they log in and set a real password. must_change_password only
    // flips to false once that first real login happens (see
    // auth.controller.js's changePassword) - a reliable "has this
    // account actually been set up" signal, distinct from is_active.
    const isSetUp = (m) => m.must_change_password !== true;

    const coversThisProperty = (m) => !propertyId || !m.property_manager_assignments?.length || m.property_manager_assignments.some((a) => a.property_id === propertyId);

    const pick = (roleLevel) => (managers || []).find((m) => m.role_level === roleLevel && isSetUp(m) && coversThisProperty(m));

    const manager = pick('manager');
    const caretaker = pick('caretaker');

    const staffRatings = await staffReputationService.getStaffReputationsByIds([manager?.id, caretaker?.id].filter(Boolean));

    return res.json({
      manager: manager ? { id: manager.id, fullName: manager.full_name, ...staffRatings[manager.id] } : null,
      caretaker: caretaker ? { id: caretaker.id, fullName: caretaker.full_name, ...staffRatings[caretaker.id] } : null,
    });
  } catch (err) {
    logger.error('[tenant] listRateableStaff error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your property staff.' });
  }
}

/** Tenant rates a property manager or caretaker (upsert, 1 per tenant per staff member). */
async function rateStaff(req, res) {
  try {
    const { staffId } = req.params;
    const { rating, comment } = req.body;

    const ratingNum = Number(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5 || !Number.isInteger(ratingNum)) {
      return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5.' });
    }
    if (checkComment(comment).blocked) {
      return res.status(400).json({ error: 'Please remove abusive or profane language from your comment.' });
    }

    const { data: tenant, error: tenantErr } = await supabase.from('tenants').select('id, landlord_id').eq('id', req.user.id).single();
    if (tenantErr || !tenant) return res.status(404).json({ error: 'Tenant record not found.' });

    const { data: staff, error: staffErr } = await supabase.from('property_managers').select('id, landlord_id, role_level, is_active').eq('id', staffId).maybeSingle();
    if (staffErr) throw staffErr;
    // Only your own landlord's manager/caretaker can be rated - never
    // someone else's, and never a deactivated account.
    if (!staff || staff.landlord_id !== tenant.landlord_id || !staff.is_active) {
      return res.status(404).json({ error: 'This person is not available to rate.' });
    }

    const { data: savedRating, error } = await supabase
      .from('staff_ratings')
      .upsert(
        {
          landlord_id: tenant.landlord_id,
          manager_id: staff.id,
          role_level: staff.role_level,
          tenant_id: tenant.id,
          rating: ratingNum,
          comment: comment || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,manager_id' }
      )
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: 'tenant', actorId: tenant.id, action: 'staff_rated', targetType: staff.role_level, targetId: staff.id, metadata: { rating: ratingNum } });

    const reputation = await staffReputationService.getStaffReputation(staff.id);
    return res.status(201).json({ message: 'Rating saved.', ratingRecord: savedRating, reputation });
  } catch (err) {
    logger.error('[tenant] rateStaff error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to save rating.' });
  }
}

/** A property manager or caretaker viewing their own aggregate rating. */
async function getMyStaffReputation(req, res) {
  try {
    const reputation = await staffReputationService.getStaffReputation(req.user.id);
    return res.json({ reputation });
  } catch (err) {
    logger.error('[tenant] getMyStaffReputation error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch your reputation.' });
  }
}

// ---------------------------------------------------------------------
// PROPERTY REPUTATION - direct request: a reputation for the PROPERTY
// itself, sitting alongside the landlord/manager/caretaker ones, but
// rated by whoever is CURRENTLY a tenant of that property (not tied
// to one specific staff member), and - unlike the others - shown
// publicly on the vacant-units listing page (see public.controller.js
// and propertyReputation.service.js for why it's the only reputation
// ever exposed outside an authenticated portal).
// ---------------------------------------------------------------------

/** A tenant rates their own property (upsert, one per tenant+property+category). */
async function rateProperty(req, res) {
  try {
    const { rating, category, comment } = req.body;

    const ratingNum = Number(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5 || !Number.isInteger(ratingNum)) {
      return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5.' });
    }

    const allowedCategories = ['overall', 'safety', 'maintenance', 'noise', 'water_electricity', 'value_for_money'];
    const ratingCategory = category || 'overall';
    if (!allowedCategories.includes(ratingCategory)) {
      return res.status(400).json({ error: 'Invalid rating category.' });
    }
    if (checkComment(comment).blocked) {
      return res.status(400).json({ error: 'Please remove abusive or profane language from your comment.' });
    }

    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('id, landlord_id, unit_id, is_active, units(property_id)')
      .eq('id', req.user.id)
      .single();
    if (tenantErr || !tenant) return res.status(404).json({ error: 'Tenant record not found.' });
    if (!tenant.is_active) {
      return res.status(403).json({ error: 'Only current tenants can rate their property.' });
    }

    const propertyId = tenant.units?.property_id;
    if (!propertyId) {
      return res.status(400).json({ error: 'Your unit is not linked to a property, so there is nothing to rate yet.' });
    }

    const { data: savedRating, error } = await supabase
      .from('property_ratings')
      .upsert(
        {
          property_id: propertyId,
          landlord_id: tenant.landlord_id,
          tenant_id: tenant.id,
          unit_id: tenant.unit_id,
          rating: ratingNum,
          category: ratingCategory,
          comment: comment || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,property_id,category' }
      )
      .select()
      .single();
    if (error) throw error;

    logActivity({
      actorType: 'tenant',
      actorId: tenant.id,
      action: 'property_rated',
      targetType: 'property',
      targetId: propertyId,
      metadata: { rating: ratingNum, category: ratingCategory },
    });

    const reputation = await propertyReputationService.getPropertyReputation(propertyId);
    return res.status(201).json({ message: 'Rating saved.', ratingRecord: savedRating, reputation });
  } catch (err) {
    logger.error('[tenant] rateProperty error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to save rating.' });
  }
}

/** A tenant viewing their own property's aggregate reputation. */
async function getMyPropertyReputation(req, res) {
  try {
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('id, units(property_id)')
      .eq('id', req.user.id)
      .single();
    if (tenantErr || !tenant) return res.status(404).json({ error: 'Tenant record not found.' });

    const propertyId = tenant.units?.property_id;
    if (!propertyId) return res.json({ reputation: { propertyId: null, totalRatings: 0, averageRating: null, byCategory: {} } });

    const reputation = await propertyReputationService.getPropertyReputation(propertyId);
    return res.json({ reputation });
  } catch (err) {
    logger.error('[tenant] getMyPropertyReputation error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch property reputation.' });
  }
}
