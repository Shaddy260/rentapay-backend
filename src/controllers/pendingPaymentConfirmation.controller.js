// src/controllers/pendingPaymentConfirmation.controller.js
//
// Landlord/property-manager side of the manual Paybill payment
// confirmation flow (see payment.controller.js's submitPaybillTransaction
// for the tenant-facing submission side). A tenant pays rent by
// sending money directly to their landlord's own Till/Paybill/Phone -
// there is no Daraja/STK involvement here at all - then submits proof
// which lands in pending_payment_confirmations for a human to confirm
// or reject.
//
// Follows the same auth/scoping, response-shape, and safe-notify
// conventions already used throughout payment.controller.js and
// tenant.controller.js - see auth.middleware.js (effectiveLandlordId,
// getManagerAssignedPropertyIds) and notify.service.js.

const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
const { notify } = require('../services/notify.service');
const { logActivity } = require('../services/activityLog.service');
const { applyPaymentToBalance, buildPrepaymentSummary, buildRentPeriodLabel } = require('../utils/prepayment');
const { buildPaymentInstructions } = require('../utils/paymentInstructions');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');
const { captureException } = require('../services/sentry.service');
const tenantRatingReminderService = require('../services/tenantRatingReminder.service');
const logger = require('../utils/logger');

const TENANT_JOIN_SELECT =
  // '*' already brings back payment_instructions_snapshot (the
  // frozen account/description captured at submission time - see
  // 2026-08-payment-confirmation-instructions-snapshot.sql).
  '*, tenants(full_name, photo_url, primary_phone, email), ' +
  'units(unit_name, unit_payment_code, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_stk_phone_number, payment_override_description, ' +
  'properties(name, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_stk_phone_number, payment_override_description)), ' +
  // Direct request: the landlord/manager confirmations list needs to
  // show whether a submission is for rent or a specific utility bill
  // (and which one) - target_type alone only says 'rent'/'utility',
  // this join brings in the utility_type ('water'/'electricity') and
  // month_key so the card can say "Water bill - Jul 2026" instead of
  // a generic "utility".
  'target_invoice:target_invoice_id(utility_type, month_key), ' +
  'confirmed_by_landlord:confirmed_or_rejected_by_landlord(full_name), confirmed_by_manager:confirmed_or_rejected_by_manager(full_name)';

// FIX (direct request): "when a landlord or caretaker or manager
// confirms/rejects a payment, deleting it should only delete it for
// them - not across all three." Landlord, manager, and caretaker all
// view the exact same landlord's pending_payment_confirmations rows,
// so a real DELETE used to erase the record for every one of them at
// once. Deleting now just flips this viewer's own "hidden" flag
// instead - see hidden_for_landlord/hidden_for_manager/
// hidden_for_caretaker (add-scoped-deletes-and-help-categories.sql).
function viewerHiddenColumn(req) {
  if (req.user.role === 'manager' && req.user.roleLevel === 'caretaker') return 'hidden_for_caretaker';
  if (req.user.role === 'manager') return 'hidden_for_manager';
  return 'hidden_for_landlord';
}

// ---------------------------------------------------------------------
// GET /api/payments/pending-confirmations  (landlord/manager only)
// ---------------------------------------------------------------------
async function getPendingConfirmations(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const status = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const { propertyId } = req.query;

    let query = supabase
      .from('pending_payment_confirmations')
      .select(TENANT_JOIN_SELECT)
      .eq('landlord_id', landlordId)
      .eq('status', status)
      .eq(viewerHiddenColumn(req), false)
      .order('submitted_at', { ascending: true });

    // "Apartments should be independent - no data should be shared."
    // The property switcher scopes every other dashboard panel to one
    // property at a time; this list now follows the same rule instead
    // of always showing every property's submissions mixed together.
    if (propertyId === 'unassigned') query = query.is('property_id', null);
    else if (propertyId) query = query.eq('property_id', propertyId);

    // Same property-scoping pattern used elsewhere for managers (see
    // tenant.controller.js listTenantsForExport) - a manager assigned
    // to specific properties only sees confirmations for units in
    // those properties; "all properties" managers get everything, same
    // as a landlord would.
    if (req.user.role === 'manager') {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedPropertyIds.length > 0) {
        query = query.in('property_id', assignedPropertyIds);
      }
    }

    const { data: confirmations, error } = await query;
    if (error) throw error;

    // THE FIX (direct request): "show the account number or mode of
    // payment the landlord set - that should be automated... remove
    // the unit code, that's not the account number." unit_payment_code
    // is RentaPay's own internal per-unit reference (RPA-A1-001) - it
    // was never the actual M-Pesa account number a tenant sends money
    // to. buildPaymentInstructions (paymentInstructions.js) is the
    // existing single source of truth for resolving unit override >
    // property override > landlord default into the real paybill/
    // till/STK details already used everywhere else payment info is
    // shown to a tenant - this just applies that same resolution here
    // instead of falling back to the unit code.
    const { data: landlord } = await supabase
      .from('landlords')
      .select('full_name, payment_method, paybill_number, paybill_account_number, till_number, stk_phone_number, payment_description')
      .eq('id', landlordId)
      .maybeSingle();

    // FIX (bug report): "payments were made before when the account
    // was different, but when it was changed recently, the earliest
    // payments changed too - it should only affect future payments
    // that come after the change." A record submitted after
    // payment_instructions_snapshot shipped has its account/till/
    // description frozen at submission time - use that instead of
    // recomputing live off the landlord's/unit's CURRENT settings.
    // Older records with no snapshot fall back to the live
    // computation, same behavior this list has always had for them.
    const withPaymentInstructions = (confirmations || []).map((record) => ({
      ...record,
      paymentInstructions: record.payment_instructions_snapshot || buildPaymentInstructions(landlord, record.units, record.units?.properties),
    }));

    // "A resubmitted request should appear at the top of all other
    // requests regardless of the time it was sent - as for others,
    // arrange them by the time they were sent." Resubmissions first
    // (oldest-resubmitted first among themselves), then everything
    // else in the original oldest-first order.
    const sorted = [...withPaymentInstructions].sort((a, b) => {
      const aResub = !!a.resubmission_of;
      const bResub = !!b.resubmission_of;
      if (aResub !== bResub) return aResub ? -1 : 1;
      return new Date(a.submitted_at) - new Date(b.submitted_at);
    });

    return res.json({ confirmations: sorted });
  } catch (err) {
    logger.error('[pendingPaymentConfirmation] getPendingConfirmations error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch pending payment confirmations.' });
  }
}

// ---------------------------------------------------------------------
// Shared ownership check - loads the record and verifies it belongs to
// a tenant/property this landlord or manager actually has access to,
// preventing cross-account tampering per the task's explicit rule.
// ---------------------------------------------------------------------
async function loadOwnedConfirmation(req) {
  const landlordId = effectiveLandlordId(req);
  const { id } = req.params;

  const { data: record, error } = await supabase.from('pending_payment_confirmations').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!record) return { record: null, statusCode: 404, error: 'Payment confirmation not found.' };
  if (record.landlord_id !== landlordId) return { record: null, statusCode: 403, error: 'This submission is not on your account.' };

  if (req.user.role === 'manager' && record.property_id) {
    const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
    if (assignedPropertyIds.length > 0 && !assignedPropertyIds.includes(record.property_id)) {
      return { record: null, statusCode: 403, error: 'You do not have access to this apartment.' };
    }
  }

  return { record, statusCode: 200, error: null };
}

// ---------------------------------------------------------------------
// Looks up the display name of whichever user is acting (landlord or
// manager), and returns both the name and which FK column to fill in
// on pending_payment_confirmations - so the receipt sent to the
// tenant, the activity log, and the row itself all agree on who
// actually confirmed/rejected it.
// ---------------------------------------------------------------------
async function resolveActingUser(req) {
  if (req.user.role === 'manager') {
    const { data: manager } = await supabase.from('property_managers').select('full_name').eq('id', req.user.id).maybeSingle();
    return { name: manager?.full_name || 'your property manager', column: 'confirmed_or_rejected_by_manager' };
  }
  const { data: landlord } = await supabase.from('landlords').select('full_name').eq('id', req.user.id).maybeSingle();
  return { name: landlord?.full_name || 'your landlord', column: 'confirmed_or_rejected_by_landlord' };
}

// ---------------------------------------------------------------------
// PATCH /api/payments/pending-confirmations/:id/confirm (landlord/manager only)
// ---------------------------------------------------------------------
async function confirmPendingPayment(req, res) {
  try {
    const { record, statusCode, error } = await loadOwnedConfirmation(req);
    if (!record) return res.status(statusCode).json({ error });
    if (record.status !== 'pending') {
      return res.status(409).json({ error: 'This submission has already been actioned.' });
    }
    // FIX (direct request: "made the payment be confirmed multiple
    // times, so billing issue"): submitPaybillTransaction flags a
    // submission as a likely duplicate (same M-Pesa transaction code
    // as an already-confirmed record) via `duplicate_of`, but that
    // was only ever enforced in the frontend - PendingPaymentConfirmations.jsx
    // simply hides the Confirm button when duplicate_of is set. The
    // backend itself had no matching check, so it would happily
    // confirm a flagged duplicate (and credit the tenant's balance a
    // second time for the same real payment) via any direct API call,
    // a stale/replayed request, or a future UI bug - server-side
    // authorization can't rely on a button being hidden client-side.
    // Same reasoning as the pending-status guard right above: this
    // needs to be true at the source of truth, not just in the UI.
    if (record.duplicate_of) {
      return res.status(409).json({ error: 'This looks like a duplicate of a payment already confirmed. Contact the tenant to verify before confirming, or reject/delete it if it was submitted in error.' });
    }
    if (await blockIfSubscriptionExpired(req, res, record.landlord_id, record.property_id)) return;

    const nowIso = new Date().toISOString();
    const actingUser = await resolveActingUser(req);
    const { data: updated, error: updateErr } = await supabase
      .from('pending_payment_confirmations')
      .update({
        status: 'confirmed',
        [actingUser.column]: req.user.id,
        confirmed_or_rejected_at: nowIso,
      })
      .eq('id', record.id)
      .eq('status', 'pending') // guard against a double-confirm race
      .select()
      .single();
    if (updateErr) throw updateErr;

    // Reuse the same balance-update logic every other payment path
    // uses (see payment.controller.js recordManualPayment /
    // processRentPaymentCallback) so this can never drift into
    // different math. Rent and utility bills are credited completely
    // independently (Phase 2) - a rent confirmation never touches a
    // utility invoice and vice versa.
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('*, units(rent_amount, due_day_of_month)')
      .eq('id', record.tenant_id)
      .single();
    if (tenantErr || !tenant) throw tenantErr || new Error('Tenant not found for confirmed payment.');

    const amountPaid = Number(record.amount_paid);
    let currentlyOwed = 0;
    let newBalance = 0;
    let prepaymentInfo = null;
    let billLabel = 'Paybill payment';
    // FIX (receipt showed "Rent period —" and "Balance after this
    // payment —" for a confirmed self-reported paybill payment): this
    // insert into `payments` was missing rent_period and balance_after
    // entirely - the two other payment-recording paths (STK push,
    // manual subscription) both set these via buildRentPeriodLabel/
    // newBalance, but this one (a landlord/manager confirming a
    // tenant's submitted M-Pesa code) never did, even though it
    // already computes newBalance and prepaymentInfo right below. Left
    // null for utility-bill payments (target_type === 'utility') -
    // "rent period" genuinely doesn't apply to a utility bill.
    let rentPeriodLabel = null;
    let rentBalanceAfter = null;

    if (record.target_type === 'utility' && record.target_invoice_id) {
      const { data: invoice, error: invoiceErr } = await supabase
        .from('utility_invoices')
        .select('*')
        .eq('id', record.target_invoice_id)
        .single();
      if (invoiceErr || !invoice) throw invoiceErr || new Error('Utility invoice not found for confirmed payment.');

      currentlyOwed = Math.round((Number(invoice.amount) - Number(invoice.amount_paid || 0)) * 100) / 100;
      const newAmountPaid = Math.round((Number(invoice.amount_paid || 0) + amountPaid) * 100) / 100;
      const newStatus = newAmountPaid >= Number(invoice.amount) ? 'paid' : 'partially_paid';
      newBalance = Math.max(0, Math.round((Number(invoice.amount) - newAmountPaid) * 100) / 100);

      await supabase.from('utility_invoices').update({ amount_paid: newAmountPaid, status: newStatus, updated_at: nowIso }).eq('id', invoice.id);
      billLabel = `${invoice.utility_type} bill`;
    } else {
      currentlyOwed = Number(tenant.balance_due) || 0;
      const rentAmount = Number(tenant.rent_override || tenant.units?.rent_amount || 0);
      newBalance = applyPaymentToBalance(currentlyOwed, amountPaid);
      const dueDay = tenant.due_day_of_month || tenant.units?.due_day_of_month;
      const today = new Date();
      const nextCycleDueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
      prepaymentInfo = buildPrepaymentSummary(newBalance, rentAmount, nextCycleDueDate);
      rentPeriodLabel = buildRentPeriodLabel(new Date(nowIso), prepaymentInfo, rentAmount);
      rentBalanceAfter = newBalance;
      await supabase.from('tenants').update({ balance_due: newBalance }).eq('id', record.tenant_id);
    }

    // Insert into the same `payments` table getPaymentHistory /
    // getPaymentHistoryFull already read from, so it shows up
    // immediately in both the tenant portal and the landlord's
    // Payment History with zero extra polling logic on either side.
    const { data: paymentRow, error: paymentInsertErr } = await supabase
      .from('payments')
      .insert({
        tenant_id: record.tenant_id,
        unit_id: record.unit_id,
        landlord_id: record.landlord_id,
        amount: amountPaid,
        payment_method: 'paybill',
        mpesa_transaction_id: record.transaction_code,
        status: 'completed',
        paid_by: 'self',
        paid_at: nowIso,
        recorded_note: `Confirmed by ${actingUser.name}`,
        target_type: record.target_type || 'rent',
        target_invoice_id: record.target_invoice_id || null,
        rent_period: rentPeriodLabel,
        balance_after: rentBalanceAfter,
      })
      .select()
      .single();
    if (paymentInsertErr) throw paymentInsertErr;

    // Safe, non-throwing receipt notification - never blocks confirm.
    try {
      await notify(
        'tenant',
        record.tenant_id,
        tenant.primary_phone,
        `Your Paybill payment of KES ${amountPaid.toLocaleString()} (ref ${record.transaction_code}) for your ${billLabel} has been confirmed by ${actingUser.name}.`,
        { category: 'account', title: 'Payment Confirmed' }
      );
    } catch (notifyErr) {
      logger.error('[pendingPaymentConfirmation] confirm: notify failed (non-blocking):', notifyErr.message);
      captureException(notifyErr);
    }

    // DIRECT REQUEST: a tenant payment landing is one of the two
    // triggers for the "rate this tenant" popup (the other is
    // random). Non-blocking - never let this hold up the confirm.
    tenantRatingReminderService.queuePaymentReminder({
      landlordId: record.landlord_id,
      tenantId: record.tenant_id,
      propertyId: record.property_id,
    });

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'pending_payment_confirmed',
      targetType: 'pending_payment_confirmation',
      targetId: record.id,
      metadata: { transactionCode: record.transaction_code, amountPaid, balanceBefore: currentlyOwed, balanceAfter: newBalance },
    });

    return res.json({ message: 'Payment confirmed.', confirmation: updated, payment: paymentRow, prepayment: prepaymentInfo });
  } catch (err) {
    logger.error('[pendingPaymentConfirmation] confirmPendingPayment error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to confirm payment.' });
  }
}

// ---------------------------------------------------------------------
// PATCH /api/payments/pending-confirmations/:id/reject (landlord/manager only)
// ---------------------------------------------------------------------
async function rejectPendingPayment(req, res) {
  try {
    const { record, statusCode, error } = await loadOwnedConfirmation(req);
    if (!record) return res.status(statusCode).json({ error });
    if (record.status !== 'pending') {
      return res.status(409).json({ error: 'This submission has already been actioned.' });
    }
    if (await blockIfSubscriptionExpired(req, res, record.landlord_id, record.property_id)) return;

    const { reason } = req.body;
    const nowIso = new Date().toISOString();
    const actingUser = await resolveActingUser(req);

    const { data: updated, error: updateErr } = await supabase
      .from('pending_payment_confirmations')
      .update({
        status: 'rejected',
        rejection_reason: reason || null,
        [actingUser.column]: req.user.id,
        confirmed_or_rejected_at: nowIso,
      })
      .eq('id', record.id)
      .eq('status', 'pending')
      .select()
      .single();
    if (updateErr) throw updateErr;

    try {
      const { data: tenant } = await supabase.from('tenants').select('primary_phone').eq('id', record.tenant_id).maybeSingle();
      const reasonSuffix = reason ? ` Reason: ${reason}.` : '';
      await notify(
        'tenant',
        record.tenant_id,
        tenant?.primary_phone,
        `Your Paybill payment submission (ref ${record.transaction_code}) was not confirmed by ${actingUser.name}.${reasonSuffix} Please check the details and resubmit.`,
        { category: 'account', title: 'Payment Not Confirmed' }
      );
    } catch (notifyErr) {
      logger.error('[pendingPaymentConfirmation] reject: notify failed (non-blocking):', notifyErr.message);
      captureException(notifyErr);
    }

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'pending_payment_rejected',
      targetType: 'pending_payment_confirmation',
      targetId: record.id,
      reason,
      metadata: { transactionCode: record.transaction_code },
    });

    return res.json({ message: 'Submission rejected.', confirmation: updated });
  } catch (err) {
    logger.error('[pendingPaymentConfirmation] rejectPendingPayment error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reject payment.' });
  }
}

// ---------------------------------------------------------------------
// Shared per-viewer dismiss logic used by both the single-record and
// bulk delete endpoints below - hides the record for THIS viewer only
// (landlord vs manager vs caretaker), unless it's a flagged duplicate,
// in which case it's cleared for every viewer type at once (see the
// comment on dismissRecord's caller for why). Hard-deletes the row
// only once every viewer type has hidden it.
// ---------------------------------------------------------------------
async function dismissRecord(req, record) {
  const { data: updated, error: updateErr } = record.duplicate_of
    ? await supabase
        .from('pending_payment_confirmations')
        .update({ hidden_for_landlord: true, hidden_for_manager: true, hidden_for_caretaker: true })
        .eq('id', record.id)
        .select('hidden_for_landlord, hidden_for_manager, hidden_for_caretaker')
        .single()
    : await supabase
        .from('pending_payment_confirmations')
        .update({ [viewerHiddenColumn(req)]: true })
        .eq('id', record.id)
        .select('hidden_for_landlord, hidden_for_manager, hidden_for_caretaker')
        .single();
  if (updateErr) throw updateErr;

  if (updated.hidden_for_landlord && updated.hidden_for_manager && updated.hidden_for_caretaker) {
    const { error: deleteErr } = await supabase.from('pending_payment_confirmations').delete().eq('id', record.id);
    if (deleteErr) throw deleteErr;
  }

  logActivity({
    actorType: req.user.role,
    actorId: req.user.id,
    action: 'pending_payment_confirmation_deleted',
    targetType: 'pending_payment_confirmation',
    targetId: record.id,
    metadata: { transactionCode: record.transaction_code, status: record.status },
  });
}

// ---------------------------------------------------------------------
// DELETE /api/payments/pending-confirmations/:id (landlord/manager only)
// Only allowed on confirmed/rejected records - a still-pending record
// must be confirmed or rejected first.
// ---------------------------------------------------------------------
async function deletePendingConfirmation(req, res) {
  try {
    const { record, statusCode, error } = await loadOwnedConfirmation(req);
    if (!record) return res.status(statusCode).json({ error });

    // A pending record can only be deleted directly if it's a flagged
    // duplicate (duplicate_of set) - there's nothing to "confirm or
    // reject" about a submission that reused an already-confirmed
    // transaction code, it just needs clearing out. Every other
    // pending record still has to go through confirm/reject first, so
    // a real payment is never silently discarded.
    if (record.status === 'pending' && !record.duplicate_of) {
      return res.status(409).json({ error: 'Confirm or reject this submission before deleting it.' });
    }

    await dismissRecord(req, record);

    return res.json({ message: 'Removed from your list.' });
  } catch (err) {
    logger.error('[pendingPaymentConfirmation] deletePendingConfirmation error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete record.' });
  }
}

// ---------------------------------------------------------------------
// POST /api/payments/pending-confirmations/bulk-delete (landlord/manager/caretaker)
//
// Multi-select "Delete selected" / "Delete all" (spec: Pending Payment
// Confirmations Card, multi-select delete). Two shapes of request:
//   { ids: ['uuid', ...] }                     - delete just these
//   { all: true, status, propertyId }          - delete everything
//     currently visible to this viewer under that status/property
//     filter (same scoping getPendingConfirmations uses)
//
// Every record still goes through the same per-viewer dismiss rule as
// the single-delete endpoint (dismissRecord above) - this is bulk
// convenience, not a different deletion mechanism. Still-pending,
// non-duplicate records are silently skipped (can't be deleted without
// a confirm/reject decision first) and reported back in `skipped` so
// the frontend can tell the person some rows were left untouched.
// ---------------------------------------------------------------------
async function bulkDeletePendingConfirmations(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    let records = [];

    if (Array.isArray(req.body.ids) && req.body.ids.length > 0) {
      if (req.body.ids.length > 200) {
        return res.status(400).json({ error: 'Too many records selected at once (max 200).' });
      }
      const { data, error } = await supabase
        .from('pending_payment_confirmations')
        .select('*')
        .in('id', req.body.ids)
        .eq('landlord_id', landlordId);
      if (error) throw error;
      records = data || [];
    } else if (req.body.all) {
      const status = ['pending', 'confirmed', 'rejected'].includes(req.body.status) ? req.body.status : 'pending';
      let query = supabase
        .from('pending_payment_confirmations')
        .select('*')
        .eq('landlord_id', landlordId)
        .eq('status', status)
        .eq(viewerHiddenColumn(req), false);
      if (req.body.propertyId === 'unassigned') query = query.is('property_id', null);
      else if (req.body.propertyId) query = query.eq('property_id', req.body.propertyId);
      const { data, error } = await query;
      if (error) throw error;
      records = data || [];
    } else {
      return res.status(400).json({ error: 'Provide either ids (array) or all: true.' });
    }

    // Same manager property-scoping as getPendingConfirmations/
    // loadOwnedConfirmation - a manager restricted to specific
    // properties can't bulk-delete records outside those properties,
    // even if they somehow got the id.
    if (req.user.role === 'manager') {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedPropertyIds.length > 0) {
        records = records.filter((r) => !r.property_id || assignedPropertyIds.includes(r.property_id));
      }
    }

    const skipped = [];
    let deletedCount = 0;
    for (const record of records) {
      if (record.status === 'pending' && !record.duplicate_of) {
        skipped.push(record.id);
        continue;
      }
      await dismissRecord(req, record);
      deletedCount += 1;
    }

    return res.json({ message: `Removed ${deletedCount} record${deletedCount === 1 ? '' : 's'} from your list.`, deletedCount, skipped });
  } catch (err) {
    logger.error('[pendingPaymentConfirmation] bulkDeletePendingConfirmations error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete records.' });
  }
}

module.exports = {
  getPendingConfirmations,
  confirmPendingPayment,
  rejectPendingPayment,
  deletePendingConfirmation,
  bulkDeletePendingConfirmations,
};
