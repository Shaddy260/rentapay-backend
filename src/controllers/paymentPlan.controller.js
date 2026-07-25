// src/controllers/paymentPlan.controller.js
//
// FEATURE (direct request: "in-app rent negotiation / payment plan
// requests - tenant splits a payment, landlord approves/declines
// in-app"). See sql/2026-07-payment-plan-requests.sql for the full
// rationale. Mirrors dispute.controller.js's shape: a proposal row,
// a context message dropped into the existing landlord_tenant chat
// thread, and a decide/resolve step - reusing that same pattern
// deliberately so the two "worklist" features feel consistent.
const supabase = require('../config/supabase');
const { effectiveLandlordId, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { insertChatMessage, lookupSenderName, senderRoleTag } = require('./chat.controller');
const { logActivity } = require('../services/activityLog.service');

function formatInstallments(installments) {
  return installments
    .map((i, idx) => `  ${idx + 1}. KES ${Number(i.amount).toLocaleString()} by ${new Date(i.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`)
    .join('\n');
}

// ---------------------------------------------------------------------
// POST /api/payment-plans
// Body: { totalAmount, installments: [{ amount, dueDate }], reason? }
// Tenant only - proposes splitting their current balance.
// ---------------------------------------------------------------------
async function createRequest(req, res) {
  try {
    const { role, id: tenantId } = req.user;
    if (role !== 'tenant') return res.status(403).json({ error: 'Only a tenant can propose a payment plan.' });

    const { totalAmount, installments, reason } = req.body;
    if (!totalAmount || !Array.isArray(installments) || installments.length < 2) {
      return res.status(400).json({ error: 'A payment plan needs a total amount and at least 2 installments.' });
    }
    for (const inst of installments) {
      if (!inst.amount || !inst.dueDate) return res.status(400).json({ error: 'Every installment needs an amount and a due date.' });
    }
    const sum = installments.reduce((s, i) => s + Number(i.amount), 0);
    if (Math.abs(sum - Number(totalAmount)) > 1) {
      return res.status(400).json({ error: `Installments (KES ${sum.toLocaleString()}) must add up to the total (KES ${Number(totalAmount).toLocaleString()}).` });
    }

    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('id, landlord_id, unit_id, full_name')
      .eq('id', tenantId)
      .single();
    if (tenantErr) throw tenantErr;

    const { data: existingPending } = await supabase
      .from('payment_plan_requests')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingPending) {
      return res.status(409).json({ error: 'You already have a payment plan request awaiting a decision.', requestId: existingPending.id });
    }

    const senderName = await lookupSenderName(req);
    const roleTag = senderRoleTag(req);
    const trimmedReason = (reason || '').trim();
    const messageBody = `📋 ${roleTag} proposed a payment plan for KES ${Number(totalAmount).toLocaleString()}:\n${formatInstallments(installments)}${trimmedReason ? `\n\n"${trimmedReason}"` : ''}`;

    const message = await insertChatMessage({
      threadType: 'landlord_tenant',
      landlordId: tenant.landlord_id,
      tenantId,
      role,
      roleLevel: req.user.roleLevel,
      senderId: tenantId,
      senderName,
      body: messageBody,
    });

    const { data: request, error: insertError } = await supabase
      .from('payment_plan_requests')
      .insert({
        tenant_id: tenantId,
        unit_id: tenant.unit_id,
        landlord_id: tenant.landlord_id,
        total_amount: totalAmount,
        installments,
        reason: trimmedReason || null,
        chat_message_id: message.id,
      })
      .select()
      .single();
    if (insertError) throw insertError;

    logActivity({ actorType: role, actorId: tenantId, action: 'payment_plan_requested', targetType: 'payment_plan_request', targetId: request.id });

    return res.status(201).json({ message: 'Payment plan proposed. Your landlord has been messaged.', request });
  } catch (err) {
    console.error('[paymentPlan] createRequest error:', err.message);
    return res.status(500).json({ error: 'Failed to submit payment plan request.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/payment-plans?status=
// Tenant: their own requests. Landlord: every request on their
// account (their worklist). Manager: same, scoped to assigned
// properties via the tenant's unit.
// ---------------------------------------------------------------------
async function listRequests(req, res) {
  try {
    const { role, id } = req.user;
    const { status } = req.query;

    let query = supabase
      .from('payment_plan_requests')
      .select('*, tenants(full_name), units(unit_name, property_id)')
      .order('created_at', { ascending: false })
      .limit(500);

    if (role === 'tenant') {
      query = query.eq('tenant_id', id);
    } else if (role === 'landlord') {
      query = query.eq('landlord_id', id);
    } else if (role === 'manager') {
      query = query.eq('landlord_id', effectiveLandlordId(req));
    } else {
      return res.status(403).json({ error: 'Unknown role.' });
    }
    if (status) query = query.eq('status', status);

    const { data: requests, error } = await query;
    if (error) throw error;

    let visible = requests || [];
    if (role === 'manager') {
      const { getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
      const assignedPropertyIds = await getManagerAssignedPropertyIds(id);
      if (assignedPropertyIds.length > 0) {
        visible = visible.filter((r) => assignedPropertyIds.includes(r.units?.property_id));
      }
    }

    return res.json({ requests: visible });
  } catch (err) {
    console.error('[paymentPlan] listRequests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch payment plan requests.' });
  }
}

// ---------------------------------------------------------------------
// PATCH /api/payment-plans/:requestId/decide
// Body: { decision: 'approved' | 'declined', note? }
// Landlord/manager only.
// ---------------------------------------------------------------------
async function decideRequest(req, res) {
  try {
    const { role, id } = req.user;
    const { requestId } = req.params;
    const { decision, note } = req.body;
    if (!['landlord', 'manager'].includes(role)) {
      return res.status(403).json({ error: 'Only a landlord or property manager can decide on a payment plan.' });
    }
    if (!['approved', 'declined'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approved' or 'declined'." });
    }

    const { data: request, error: fetchError } = await supabase
      .from('payment_plan_requests')
      .select('id, landlord_id, tenant_id, status, total_amount, installments, units(property_id)')
      .eq('id', requestId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!request) return res.status(404).json({ error: 'Payment plan request not found.' });

    const landlordId = effectiveLandlordId(req);
    if (request.landlord_id !== landlordId) return res.status(403).json({ error: 'This request is not on your account.' });
    if (role === 'manager') {
      const propertyAccessError = await checkManagerPropertyAccess(req, request.units?.property_id);
      if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    }
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided.' });

    const senderName = await lookupSenderName(req);
    const roleTag = senderRoleTag(req);
    const trimmedNote = (note || '').trim();
    const verb = decision === 'approved' ? 'approved' : 'declined';
    const messageBody = `${decision === 'approved' ? '✅' : '❌'} ${roleTag} ${verb} the proposed payment plan (KES ${Number(request.total_amount).toLocaleString()}).${trimmedNote ? `\n\n"${trimmedNote}"` : ''}`;

    await insertChatMessage({
      threadType: 'landlord_tenant',
      landlordId: request.landlord_id,
      tenantId: request.tenant_id,
      role,
      roleLevel: req.user.roleLevel,
      senderId: id,
      senderName,
      body: messageBody,
    });

    const { data: updated, error } = await supabase
      .from('payment_plan_requests')
      .update({
        status: decision,
        decision_note: trimmedNote || null,
        decided_at: new Date().toISOString(),
        decided_by_role: role,
        decided_by_id: id,
      })
      .eq('id', requestId)
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: role, actorId: id, action: `payment_plan_${decision}`, targetType: 'payment_plan_request', targetId: requestId });

    return res.json({ message: `Payment plan ${decision}.`, request: updated });
  } catch (err) {
    console.error('[paymentPlan] decideRequest error:', err.message);
    return res.status(500).json({ error: 'Failed to record decision.' });
  }
}

// ---------------------------------------------------------------------
// PATCH /api/payment-plans/:requestId/cancel
// Tenant only - withdraws their own still-pending request.
// ---------------------------------------------------------------------
async function cancelRequest(req, res) {
  try {
    const { role, id: tenantId } = req.user;
    const { requestId } = req.params;
    if (role !== 'tenant') return res.status(403).json({ error: 'Only the tenant who made this request can cancel it.' });

    const { data: request, error: fetchError } = await supabase
      .from('payment_plan_requests')
      .select('id, tenant_id, status')
      .eq('id', requestId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!request) return res.status(404).json({ error: 'Payment plan request not found.' });
    if (request.tenant_id !== tenantId) return res.status(403).json({ error: 'This is not your request.' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided.' });

    const { data: updated, error } = await supabase
      .from('payment_plan_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .select()
      .single();
    if (error) throw error;

    return res.json({ message: 'Payment plan request cancelled.', request: updated });
  } catch (err) {
    console.error('[paymentPlan] cancelRequest error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel request.' });
  }
}

module.exports = { createRequest, listRequests, decideRequest, cancelRequest };
