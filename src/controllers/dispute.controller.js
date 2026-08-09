// src/controllers/dispute.controller.js
//
// FEATURE (direct request: "dispute a charge - a lightweight 'this
// doesn't look right' button on any line item that opens a chat
// thread pre-filled with context"): today, disputing a payment means
// typing the whole situation out from scratch in chat, or worse,
// texting the landlord on WhatsApp where RentaPay has no visibility at
// all. This gives the payment row itself a one-tap "This doesn't look
// right" action that:
//
//   1. writes a charge_disputes row (so the payment can carry a
//      "Disputed" badge and the landlord gets a real worklist instead
//      of having to remember which chat threads had a complaint in them)
//   2. posts a pre-filled context bubble - date, amount, method,
//      status, plus whatever the raiser typed - into the SAME
//      landlord_tenant chat thread already used for "Text your
//      landlord"/"Text your tenant", via chat.controller's
//      insertChatMessage so it gets the same push notification and
//      read-receipt behaviour as any other message.
//
// A dispute is raised almost always by the tenant, but a
// landlord/manager can also flag their own recorded entry (e.g. a
// manual payment they suspect they mis-keyed) - see raised_by_role.
const supabase = require('../config/supabase');
const { effectiveLandlordId, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { insertChatMessage, lookupSenderName, senderRoleTag } = require('./chat.controller');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');

function formatPaymentContext(payment) {
  const date = payment.paid_at ? new Date(payment.paid_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'an unrecorded date';
  const amount = `KES ${Number(payment.amount).toLocaleString()}`;
  const method = (payment.payment_method || '').replace('_', ' ');
  return `${date} · ${amount} · ${method} · status: ${payment.status}`;
}

// ---------------------------------------------------------------------
// POST /api/disputes
// Body: { paymentId, reason? }
// Tenant: can only dispute their own payment.
// Landlord/manager: can dispute a payment on their own account (a
//   manager needs property access to the tenant's unit, same rule as
//   texting that tenant in chat.controller.js).
// ---------------------------------------------------------------------
async function createDispute(req, res) {
  try {
    const { role, id } = req.user;
    const { paymentId, reason } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId is required.' });
    if (!['tenant', 'landlord', 'manager'].includes(role)) {
      return res.status(403).json({ error: 'Only a tenant, landlord, or property manager can raise a dispute.' });
    }

    const { data: payment, error: fetchError } = await supabase
      .from('payments')
      .select('id, tenant_id, landlord_id, amount, paid_at, payment_method, status, units(property_id)')
      .eq('id', paymentId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    if (role === 'tenant') {
      if (payment.tenant_id !== id) return res.status(403).json({ error: 'This is not your payment.' });
    } else {
      const landlordId = effectiveLandlordId(req);
      if (payment.landlord_id !== landlordId) return res.status(403).json({ error: 'This payment is not on your account.' });
      if (role === 'manager') {
        const propertyAccessError = await checkManagerPropertyAccess(req, payment.units?.property_id);
        if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
      }
      // Only gate the landlord/manager side - a tenant must still be
      // able to flag a charge as wrong even if the landlord's own
      // subscription on this property has lapsed.
      if (await blockIfSubscriptionExpired(req, res, landlordId, payment.units?.property_id || null)) return;
    }

    // One open dispute per payment at a time (enforced again by the DB
    // unique index) - re-raising while one's already open would just
    // fork the conversation into two threads about the same charge.
    const { data: existingOpen } = await supabase
      .from('charge_disputes')
      .select('id')
      .eq('payment_id', paymentId)
      .eq('status', 'open')
      .maybeSingle();
    if (existingOpen) {
      return res.status(409).json({ error: 'This payment already has an open dispute.', disputeId: existingOpen.id });
    }

    const senderName = await lookupSenderName(req);
    const roleTag = senderRoleTag(req);
    const contextLine = formatPaymentContext(payment);
    const trimmedReason = (reason || '').trim();
    const messageBody = trimmedReason
      ? `⚠️ ${roleTag} flagged a payment as disputed:\n${contextLine}\n\n"${trimmedReason}"`
      : `⚠️ ${roleTag} flagged a payment as disputed:\n${contextLine}`;

    // The dispute lives in the same landlord_tenant thread as ordinary
    // "Text your landlord"/"Text your tenant" chat - not a separate
    // dispute-only channel - so context and back-and-forth stay in one
    // place either side already knows to check.
    const message = await insertChatMessage({
      threadType: 'landlord_tenant',
      landlordId: payment.landlord_id,
      tenantId: payment.tenant_id,
      role,
      roleLevel: req.user.roleLevel,
      senderId: id,
      senderName,
      body: messageBody,
    });

    const { data: dispute, error: insertError } = await supabase
      .from('charge_disputes')
      .insert({
        payment_id: paymentId,
        landlord_id: payment.landlord_id,
        tenant_id: payment.tenant_id,
        raised_by_role: role,
        raised_by_id: id,
        reason: trimmedReason || null,
        chat_message_id: message.id,
      })
      .select()
      .single();
    if (insertError) throw insertError;

    logActivity({
      actorType: role,
      actorId: id,
      action: 'charge_dispute_raised',
      targetType: 'payment',
      targetId: paymentId,
      metadata: { disputeId: dispute.id },
    });

    return res.status(201).json({ message: 'Dispute raised. Your landlord/tenant has been messaged.', dispute });
  } catch (err) {
    logger.error('[dispute] createDispute error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to raise dispute.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/disputes?paymentId=&status=
// Tenant: their own disputes only.
// Landlord/manager: every dispute on their account (their worklist) -
//   a manager only sees disputes on properties they're assigned to.
// Admin: everything, optionally filtered by landlordId/tenantId/paymentId.
// ---------------------------------------------------------------------
async function listDisputes(req, res) {
  try {
    const { role, id } = req.user;
    const { paymentId, status } = req.query;

    let query = supabase
      .from('charge_disputes')
      .select('*, payments(amount, paid_at, payment_method, status, units(unit_name, property_id)), tenants(full_name), landlords(full_name)')
      .order('created_at', { ascending: false })
      .limit(500);

    if (role === 'tenant') {
      query = query.eq('tenant_id', id);
    } else if (role === 'landlord') {
      query = query.eq('landlord_id', id);
    } else if (role === 'manager') {
      query = query.eq('landlord_id', effectiveLandlordId(req));
    } else if (role === 'admin') {
      if (req.query.landlordId) query = query.eq('landlord_id', req.query.landlordId);
      if (req.query.tenantId) query = query.eq('tenant_id', req.query.tenantId);
    } else {
      return res.status(403).json({ error: 'Unknown role.' });
    }

    if (paymentId) query = query.eq('payment_id', paymentId);
    if (status) query = query.eq('status', status);

    const { data: disputes, error } = await query;
    if (error) throw error;

    // A manager only ever gets to see disputes on properties they're
    // actually assigned to (unassigned = "all") - filtered here
    // rather than in the query since it needs the assigned-property
    // list, same pattern used elsewhere for manager-scoped lists.
    let visible = disputes || [];
    if (role === 'manager') {
      const { getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
      const assignedPropertyIds = await getManagerAssignedPropertyIds(id);
      if (assignedPropertyIds.length > 0) {
        visible = visible.filter((d) => assignedPropertyIds.includes(d.payments?.units?.property_id));
      }
    }

    return res.json({ disputes: visible });
  } catch (err) {
    logger.error('[dispute] listDisputes error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch disputes.' });
  }
}

// ---------------------------------------------------------------------
// PATCH /api/disputes/:disputeId/resolve
// Landlord/manager/admin only - marks a dispute resolved. Doesn't
// touch the chat thread itself (the conversation there stands as the
// record of how it was resolved); this just clears it off the
// landlord's worklist and off the "Disputed" badge on the payment row.
// ---------------------------------------------------------------------
async function resolveDispute(req, res) {
  try {
    const { role, id } = req.user;
    const { disputeId } = req.params;
    const { resolutionNote } = req.body;
    if (!['landlord', 'manager', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Only a landlord, property manager, or admin can resolve a dispute.' });
    }

    const { data: dispute, error: fetchError } = await supabase
      .from('charge_disputes')
      .select('id, landlord_id, status, payments(units(property_id))')
      .eq('id', disputeId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!dispute) return res.status(404).json({ error: 'Dispute not found.' });

    if (role !== 'admin') {
      const landlordId = effectiveLandlordId(req);
      if (dispute.landlord_id !== landlordId) return res.status(403).json({ error: 'This dispute is not on your account.' });
      if (role === 'manager') {
        const propertyAccessError = await checkManagerPropertyAccess(req, dispute.payments?.units?.property_id);
        if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
      }
      if (await blockIfSubscriptionExpired(req, res, landlordId, dispute.payments?.units?.property_id || null)) return;
    }
    if (dispute.status === 'resolved') return res.status(400).json({ error: 'This dispute is already resolved.' });

    const { data: updated, error } = await supabase
      .from('charge_disputes')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_by_role: role,
        resolved_by_id: id,
        resolution_note: resolutionNote || null,
      })
      .eq('id', disputeId)
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: role, actorId: id, action: 'charge_dispute_resolved', targetType: 'charge_dispute', targetId: disputeId });

    return res.json({ message: 'Dispute marked resolved.', dispute: updated });
  } catch (err) {
    logger.error('[dispute] resolveDispute error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to resolve dispute.' });
  }
}

module.exports = { createDispute, listDisputes, resolveDispute };
