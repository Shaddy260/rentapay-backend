// src/controllers/property.controller.js
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
//
// Multi-property support: a landlord who runs more than one rental
// property (different estates in different locations) can group their
// units under named Properties instead of everything being flattened
// onto the single estate_name/location/county on their landlords row.
// See sql/2026-07-fixes.sql for the migration and PROPERTIES_AND_MULTI_LOCATION.md
// for the fuller design notes.

const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { initiateSTKPush, querySTKPushStatus } = require('../services/daraja.service');
const { calculateAddUnitsCost, calculateSubscriptionCost } = require('../utils/pricing');
const { KENYA_CONSTITUENCIES } = require('../constants/kenyaConstituencies');

// Shared by createProperty/updateProperty: if both county and
// constituency are supplied, make sure the constituency actually
// belongs to that county (same reasoning as the landlord-level check
// in auth.controller.js's updatePropertyDetails). constituency without
// county, or county without constituency, is left alone here - this
// only guards against a MISMATCHED pair being saved.
function constituencyMismatch(county, constituency) {
  if (!county || !constituency) return false;
  return !(KENYA_CONSTITUENCIES[county] || []).includes(constituency);
}

async function listProperties(req, res) {
  try {
    const landlordId = req.user.role === 'admin' && req.query.landlordId ? req.query.landlordId : effectiveLandlordId(req);

    let query = supabase
      .from('properties')
      .select('*, units(count)')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: true });

    // FIX: a manager/caretaker used to see EVERY property belonging to
    // their landlord here (used to drive the Settings page's property
    // pickers), including ones they were never assigned to - part of
    // the same "single-property access is broken" family of bugs.
    // Scope this to exactly what they can access, same as the
    // dashboard/units endpoints.
    if (req.user.role === 'manager') {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      query = assignedPropertyIds.length
        ? query.in('id', assignedPropertyIds)
        : query.eq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { data: properties, error } = await query;

    if (error) throw error;

    // FIX (direct request): "immediately a landlord or manager adds a
    // caretaker, it should automatically reflect... rather than
    // editing manually." caretaker_name/caretaker_phone are static
    // free-text fields (a fallback for a caretaker with no real
    // system login) - they only ever reflected whatever was typed in
    // manually and drifted out of sync the moment a REAL caretaker
    // account got assigned to the property instead. Attach the live
    // assignment here so the frontend can prefer a real account's
    // current details over the static fallback text automatically,
    // with no manual edit step at all.
    const propertyIds = (properties || []).map((p) => p.id);
    let liveAssignmentsByProperty = {};
    if (propertyIds.length) {
      const { data: assignments } = await supabase
        .from('property_manager_assignments')
        .select('property_id, property_managers(id, full_name, phone, role_level, is_active)')
        .in('property_id', propertyIds);
      for (const a of assignments || []) {
        if (!a.property_managers || !a.property_managers.is_active) continue;
        if (!liveAssignmentsByProperty[a.property_id]) liveAssignmentsByProperty[a.property_id] = { caretaker: null, manager: null };
        if (a.property_managers.role_level === 'caretaker') {
          liveAssignmentsByProperty[a.property_id].caretaker = { name: a.property_managers.full_name, phone: a.property_managers.phone };
        } else {
          liveAssignmentsByProperty[a.property_id].manager = { name: a.property_managers.full_name, phone: a.property_managers.phone };
        }
      }
    }

    const propertiesWithLiveContacts = (properties || []).map((p) => ({
      ...p,
      liveCaretaker: liveAssignmentsByProperty[p.id]?.caretaker || null,
      liveManager: liveAssignmentsByProperty[p.id]?.manager || null,
    }));

    return res.json({ properties: propertiesWithLiveContacts });
  } catch (err) {
    console.error('[property] listProperties error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch properties.' });
  }
}

async function createProperty(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { name, location, county, constituency, description } = req.body;
    let { caretakerName, caretakerPhone } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required.' });

    if (constituencyMismatch(county, constituency)) {
      return res.status(400).json({ error: 'Please select a constituency that belongs to the chosen county.' });
    }

    if (caretakerPhone) {
      try {
        caretakerPhone = normalizePhoneOrThrow(caretakerPhone, 'Caretaker phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }

    const { data: property, error } = await supabase
      .from('properties')
      .insert({
        landlord_id: landlordId,
        name,
        location: location || null,
        county: county || null,
        constituency: constituency || null,
        description: description || null,
        caretaker_name: caretakerName || null,
        caretaker_phone: caretakerPhone || null,
      })
      .select()
      .single();

    if (error) throw error;

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'property_created', targetType: 'property', targetId: property.id });

    return res.status(201).json({ property });
  } catch (err) {
    console.error('[property] createProperty error:', err.message);
    return res.status(500).json({ error: 'Failed to create property.' });
  }
}

// Caretaker and property-manager details are now edited independently
// and at any time (blueprint change: these people rotate periodically).
// Caretaker is a plain contact record on the property row; the
// property MANAGER is a real login account managed via
// propertyManager.controller.js / /api/property-managers - not edited
// here.
async function updateProperty(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId } = req.params;
    const { name, location, county, constituency, description, primaryContactManagerId } = req.body;
    let { caretakerName, caretakerPhone } = req.body;

    const { data: existing, error: fetchError } = await supabase.from('properties').select('landlord_id, county, constituency').eq('id', propertyId).single();
    if (fetchError || !existing) return res.status(404).json({ error: 'Property not found.' });
    if (existing.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this property.' });

    // Validate against whichever county/constituency the row will end
    // up with after this update (a request may change just one of the
    // pair, so fall back to the existing saved value for the other).
    const effectiveCounty = county !== undefined ? county : existing.county;
    const effectiveConstituency = constituency !== undefined ? constituency : existing.constituency;
    if (constituencyMismatch(effectiveCounty, effectiveConstituency)) {
      return res.status(400).json({ error: 'Please select a constituency that belongs to the chosen county.' });
    }

    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (location !== undefined) updateFields.location = location;
    if (county !== undefined) updateFields.county = county;
    if (constituency !== undefined) updateFields.constituency = constituency;
    if (description !== undefined) updateFields.description = description;
    if (caretakerName !== undefined) updateFields.caretaker_name = caretakerName || null;
    if (caretakerPhone !== undefined) {
      try {
        updateFields.caretaker_phone = caretakerPhone ? normalizePhoneOrThrow(caretakerPhone, 'Caretaker phone number') : null;
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }

    // Who tenants see as "the contact" for this property: null falls
    // back to the landlord themself; otherwise must be one of THIS
    // landlord's own property managers (never an arbitrary id).
    if (primaryContactManagerId !== undefined) {
      if (primaryContactManagerId) {
        const { data: mgr, error: mgrErr } = await supabase
          .from('property_managers')
          .select('id, landlord_id')
          .eq('id', primaryContactManagerId)
          .maybeSingle();
        if (mgrErr) throw mgrErr;
        if (!mgr || mgr.landlord_id !== landlordId) {
          return res.status(400).json({ error: 'That property manager does not belong to you.' });
        }
      }
      updateFields.primary_contact_manager_id = primaryContactManagerId || null;
    }

    const { error } = await supabase.from('properties').update(updateFields).eq('id', propertyId);
    if (error) throw error;

    return res.json({ message: 'Property updated.' });
  } catch (err) {
    console.error('[property] updateProperty error:', err.message);
    return res.status(500).json({ error: 'Failed to update property.' });
  }
}

// Move a unit (and its tenant, implicitly) into a different property -
// used by the property switcher's "assign units" step.
async function assignUnitToProperty(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { unitId } = req.params;
    const { propertyId } = req.body; // null is allowed - "ungroup" the unit

    const { data: unit, error: fetchError } = await supabase.from('units').select('landlord_id').eq('id', unitId).single();
    if (fetchError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    if (unit.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this unit.' });

    if (propertyId) {
      const { data: property, error: propError } = await supabase.from('properties').select('landlord_id').eq('id', propertyId).single();
      if (propError || !property) return res.status(404).json({ error: 'Property not found.' });
      if (property.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage that property.' });
    }

    const { error } = await supabase.from('units').update({ property_id: propertyId || null }).eq('id', unitId);
    if (error) throw error;

    return res.json({ message: 'Unit reassigned.' });
  } catch (err) {
    console.error('[property] assignUnitToProperty error:', err.message);
    return res.status(500).json({ error: 'Failed to reassign unit.' });
  }
}

// ---------------------------------------------------------------------
// PAID "ADD A PROPERTY" FLOW - triggered from the dashboard's property
// switcher ("+ Add a property"). A landlord managing more than one
// property in their name registers the new property's details plus
// how many units it has, pays for those units via M-Pesa STK push
// (same per-unit pricing as adding units to an existing subscription -
// prorated against however many months are left on the current
// period), and only once that payment completes does the property
// actually get created and become switchable - mirrors the
// subscription_payments pattern in subscription.controller.js /
// payment.controller.js exactly, including the self-heal status poll.
// ---------------------------------------------------------------------
async function initiatePropertyPurchase(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { name, location, county, constituency, description, unitsCount, periodMonths } = req.body;
    let { caretakerName, caretakerPhone } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Property name is required.' });
    if (!unitsCount || Number(unitsCount) < 1) return res.status(400).json({ error: 'unitsCount must be at least 1.' });
    if (constituencyMismatch(county, constituency)) {
      return res.status(400).json({ error: 'Please select a constituency that belongs to the chosen county.' });
    }
    // FIX (direct request: "don't fix the subscription period, let the
    // landlord enter their own subscription time they wish"): this
    // used to silently prorate against whatever was left on the
    // LANDLORD's shared clock, so a new property never had a
    // subscription length of its own - it just inherited however many
    // months happened to be left elsewhere. Now it's a real, separate
    // period the landlord picks for this specific property, any whole
    // number of months, defaulting to 1 if not given.
    const chosenPeriodMonths = Math.max(1, Math.round(Number(periodMonths) || 1));

    if (caretakerPhone) {
      try {
        caretakerPhone = normalizePhoneOrThrow(caretakerPhone, 'Caretaker phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }

    const { data: landlord, error: fetchError } = await supabase.from('landlords').select('*').eq('id', landlordId).single();
    if (fetchError || !landlord) return res.status(404).json({ error: 'Landlord not found.' });

    // Priced as its own real subscription (units x chosen months), not
    // prorated against a different property's remaining time - this
    // property's clock and unit count are now entirely its own.
    const { totalCost } = calculateSubscriptionCost(Number(unitsCount), chosenPeriodMonths);

    const stkResponse = await initiateSTKPush({
      phoneNumber: landlord.phone,
      amount: totalCost,
      accountReference: `RENTAPAY-NEWPROP-${landlordId.slice(0, 8)}`,
      transactionDesc: 'RentaPay new property + units',
    });

    const { data: propPayment, error } = await supabase
      .from('property_payments')
      .insert({
        landlord_id: landlordId,
        name: name.trim(),
        location: location || null,
        county: county || null,
        constituency: constituency || null,
        description: description || null,
        caretaker_name: caretakerName || null,
        caretaker_phone: caretakerPhone || null,
        units_count: Number(unitsCount),
        period_months: chosenPeriodMonths,
        amount: totalCost,
        mpesa_checkout_request_id: stkResponse.CheckoutRequestID,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      message: 'M-Pesa prompt sent. Enter your PIN to add this property.',
      checkoutRequestId: stkResponse.CheckoutRequestID,
      amountDue: totalCost,
      periodMonths: chosenPeriodMonths,
      propertyPaymentId: propPayment.id,
    });
  } catch (err) {
    console.error('[property] initiatePropertyPurchase error:', err.message);
    return res.status(500).json({ error: 'Failed to start property purchase.' });
  }
}

/**
 * Shared completion logic - called from either the Daraja callback
 * (payment.controller.js's handleSTKCallback) or the self-heal status
 * poll below. Idempotent: does nothing if already completed.
 */
async function completePropertyPurchase(propPayment) {
  if (propPayment.status === 'completed') return propPayment.created_property_id;

  const periodMonths = propPayment.period_months || 1;

  // RENEWAL of an existing additional property (direct request: "if
  // one expires and he logs in he should subscribe to it differently"
  // - this is that path). Extends the expiry from whichever is later -
  // the property's current expiry if it hasn't lapsed yet, or now if
  // it has - and sets the unit count to whatever was just paid for
  // (see the unit_limit fix below - it does NOT add to what was
  // already there).
  if (propPayment.renews_property_id) {
    const { data: existingProperty, error: existingErr } = await supabase
      .from('properties')
      .select('unit_limit, subscription_expires_at')
      .eq('id', propPayment.renews_property_id)
      .single();
    if (existingErr || !existingProperty) throw new Error('Property being renewed was not found.');

    const currentExpiry = existingProperty.subscription_expires_at ? new Date(existingProperty.subscription_expires_at) : new Date();
    const base = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
    const newExpiry = new Date(base);
    newExpiry.setMonth(newExpiry.getMonth() + periodMonths);

    // FIX (direct request: "if they first subscribe for 10 units and
    // when subscription ends and subscribe again for 10, instead of
    // just maintaining the existing 10 it adds more 10 to make 20"):
    // the landlord is charged calculateSubscriptionCost(unitsCount,
    // periodMonths) in full for whatever unitsCount they choose on
    // renewal - that is the real, complete cost of THAT MANY units,
    // not a delta/top-up price. Adding it on top of whatever unit
    // count was already there therefore double-counted: paying in
    // full for 10 units silently became a 20-unit limit. Renewing
    // for the same number of units now correctly leaves the limit
    // unchanged, and renewing with a bigger number sets the limit to
    // that new total (still one full, correctly-priced number, never
    // stacked on the old one) - exactly matching how the manual bank-
    // transfer renewal path (landlordManualSubscriptionPayment.
    // controller.js) already does this correctly.
    await supabase
      .from('properties')
      .update({
        unit_limit: propPayment.units_count,
        subscription_period_months: periodMonths,
        subscription_expires_at: newExpiry.toISOString(),
        subscription_status: 'active',
      })
      .eq('id', propPayment.renews_property_id);

    await supabase
      .from('property_payments')
      .update({ status: 'completed', created_property_id: propPayment.renews_property_id, paid_at: new Date().toISOString() })
      .eq('id', propPayment.id);

    logActivity({
      actorType: 'system',
      action: 'property_subscription_renewed',
      targetType: 'property',
      targetId: propPayment.renews_property_id,
      metadata: { landlordId: propPayment.landlord_id, newUnitLimit: propPayment.units_count, periodMonths },
    });

    return propPayment.renews_property_id;
  }

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + periodMonths);

  // FIX (direct request): each property gets its OWN unit_limit and
  // its OWN subscription_expires_at from the moment it's created,
  // instead of adding its units onto the landlord's single pooled
  // unit_limit and riding the landlord's shared clock. This is the
  // actual fix for "each apartment should show their own subscription
  // period" and "under no circumstance should they show the same
  // number [of units]".
  const { data: property, error: propError } = await supabase
    .from('properties')
    .insert({
      landlord_id: propPayment.landlord_id,
      name: propPayment.name,
      location: propPayment.location,
      county: propPayment.county,
      constituency: propPayment.constituency,
      description: propPayment.description,
      caretaker_name: propPayment.caretaker_name,
      caretaker_phone: propPayment.caretaker_phone,
      unit_limit: propPayment.units_count,
      subscription_period_months: periodMonths,
      subscription_started_at: now.toISOString(),
      subscription_expires_at: expiresAt.toISOString(),
      subscription_status: 'active',
    })
    .select()
    .single();
  if (propError) throw propError;

  await supabase
    .from('property_payments')
    .update({ status: 'completed', created_property_id: property.id, paid_at: new Date().toISOString() })
    .eq('id', propPayment.id);

  logActivity({
    actorType: 'system',
    action: 'property_purchase_completed',
    targetType: 'property',
    targetId: property.id,
    metadata: { landlordId: propPayment.landlord_id, unitsCount: propPayment.units_count, periodMonths },
  });

  return property.id;
}

// ---------------------------------------------------------------------
// RENEW (or add units to) AN EXISTING additional property's OWN
// subscription - separate from the landlord's account-wide renewal in
// subscription.controller.js, and separate from buying a brand new
// property above. This is what a landlord uses once one specific
// apartment's own clock runs out.
// ---------------------------------------------------------------------
async function renewPropertySubscription(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId } = req.params;
    const { unitsCount, periodMonths } = req.body;

    if (!unitsCount || Number(unitsCount) < 1) return res.status(400).json({ error: 'unitsCount must be at least 1.' });
    const chosenPeriodMonths = Math.max(1, Math.round(Number(periodMonths) || 1));

    const { data: property, error: propErr } = await supabase.from('properties').select('id, landlord_id').eq('id', propertyId).single();
    if (propErr || !property || property.landlord_id !== landlordId) {
      return res.status(404).json({ error: 'Property not found on your account.' });
    }

    const { data: landlord, error: fetchError } = await supabase.from('landlords').select('phone').eq('id', landlordId).single();
    if (fetchError || !landlord) return res.status(404).json({ error: 'Landlord not found.' });

    const { totalCost } = calculateSubscriptionCost(Number(unitsCount), chosenPeriodMonths);

    const stkResponse = await initiateSTKPush({
      phoneNumber: landlord.phone,
      amount: totalCost,
      accountReference: `RENTAPAY-PROPRENEW-${propertyId.slice(0, 8)}`,
      transactionDesc: 'RentaPay property subscription renewal',
    });

    const { data: propPayment, error } = await supabase
      .from('property_payments')
      .insert({
        landlord_id: landlordId,
        renews_property_id: propertyId,
        units_count: Number(unitsCount),
        period_months: chosenPeriodMonths,
        amount: totalCost,
        mpesa_checkout_request_id: stkResponse.CheckoutRequestID,
        status: 'pending',
      })
      .select()
      .single();
    if (error) throw error;

    return res.json({
      message: 'M-Pesa prompt sent. Enter your PIN to renew this property.',
      checkoutRequestId: stkResponse.CheckoutRequestID,
      amountDue: totalCost,
      periodMonths: chosenPeriodMonths,
      propertyPaymentId: propPayment.id,
    });
  } catch (err) {
    console.error('[property] renewPropertySubscription error:', err.message);
    return res.status(500).json({ error: 'Failed to start property renewal.' });
  }
}

// Called from payment.controller.js's Daraja callback handler.
async function processPropertyPaymentCallback(propPayment, resultCode) {
  if (resultCode !== 0) {
    await supabase.from('property_payments').update({ status: 'failed' }).eq('id', propPayment.id);
    return;
  }
  await completePropertyPurchase(propPayment);
}

// Same self-heal pattern as checkSubscriptionPaymentStatus /
// checkRentPaymentStatus - the frontend polls this instead of trusting
// the webhook alone.
async function checkPropertyPaymentStatus(req, res) {
  try {
    const { checkoutRequestId } = req.params;
    if (!checkoutRequestId) return res.status(400).json({ error: 'checkoutRequestId is required.' });

    const { data: propPayment, error } = await supabase
      .from('property_payments')
      .select('*')
      .eq('mpesa_checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (error || !propPayment) return res.status(404).json({ error: 'No payment found for that checkout request.' });
    if (propPayment.landlord_id !== effectiveLandlordId(req)) return res.status(403).json({ error: 'Not your payment.' });

    if (propPayment.status === 'completed') {
      return res.json({ status: 'completed', propertyId: propPayment.created_property_id });
    }
    if (propPayment.status === 'failed') {
      return res.json({ status: 'failed' });
    }

    let queryResult;
    try {
      queryResult = await querySTKPushStatus(checkoutRequestId);
    } catch (queryErr) {
      console.warn('[property] checkPropertyPaymentStatus: querySTKPushStatus failed, still pending:', queryErr.message);
      return res.json({ status: 'pending' });
    }

    const resultCode = Number(queryResult.ResultCode);
    if (resultCode === 0) {
      const propertyId = await completePropertyPurchase(propPayment);
      return res.json({ status: 'completed', propertyId });
    }
    if (!Number.isNaN(resultCode) && resultCode !== 1037) {
      await supabase.from('property_payments').update({ status: 'failed' }).eq('id', propPayment.id);
      return res.json({ status: 'failed', reason: queryResult.ResultDesc });
    }

    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('[property] checkPropertyPaymentStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to check payment status.' });
  }
}

module.exports = {
  listProperties,
  createProperty,
  updateProperty,
  assignUnitToProperty,
  initiatePropertyPurchase,
  renewPropertySubscription,
  checkPropertyPaymentStatus,
  processPropertyPaymentCallback,
};
