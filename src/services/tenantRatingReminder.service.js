const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * DIRECT REQUEST: popups nudging landlords/managers/caretakers to
 * rate a tenant - either at random (any tenant they haven't rated
 * yet) or right after that tenant's payment is confirmed. This
 * service owns the bookkeeping in tenant_rating_reminders; the
 * rating panel itself still lives in tenant.controller.js and clears
 * a row here as soon as that rater actually submits a rating.
 */

function raterUserType(role) {
  return role === 'landlord' ? 'landlord' : 'property_manager';
}

/**
 * Called right after a tenant's payment is confirmed. Fans a
 * "payment" reminder out to the landlord plus whichever manager/
 * caretaker cover that property, clearing any previous snooze so the
 * nudge reliably resurfaces even if they'd dismissed an older one.
 */
async function queuePaymentReminder({ landlordId, tenantId, propertyId }) {
  try {
    const raters = [{ userType: 'landlord', userId: landlordId, role: 'landlord' }];

    const { data: staff } = await supabase
      .from('property_managers')
      .select('id, role_level, is_active, property_manager_assignments(property_id)')
      .eq('landlord_id', landlordId)
      .eq('is_active', true);

    (staff || []).forEach((m) => {
      const covers = !propertyId || !m.property_manager_assignments?.length
        || m.property_manager_assignments.some((a) => a.property_id === propertyId);
      if (!covers) return;
      raters.push({ userType: 'property_manager', userId: m.id, role: m.role_level === 'caretaker' ? 'caretaker' : 'manager' });
    });

    const rows = raters.map((r) => ({
      landlord_id: landlordId,
      tenant_id: tenantId,
      property_id: propertyId || null,
      rater_user_type: r.userType,
      rater_user_id: r.userId,
      rater_role: r.role,
      trigger_reason: 'payment',
      snoozed_until: null,
      dismissed_today_date: null,
      updated_at: new Date().toISOString(),
    }));

    if (rows.length) {
      await supabase
        .from('tenant_rating_reminders')
        .upsert(rows, { onConflict: 'tenant_id,rater_user_type,rater_user_id' });
    }
  } catch (err) {
    // Never let reminder bookkeeping block a payment confirmation.
    logger.error('[tenantRatingReminder] queuePaymentReminder error:', err.message);
  }
}

/**
 * Picks one tenant this rater still needs to rate, for the random /
 * on-load popup. Priority: an existing (non-snoozed) "payment"
 * reminder row first, otherwise a random tenant of theirs that has
 * no rating at all yet from this rater+role.
 */
async function getNextReminder({ role, roleLevel, userId, landlordId }) {
  const rRole = role === 'landlord' ? 'landlord' : (roleLevel === 'caretaker' ? 'caretaker' : 'manager');
  const userType = raterUserType(role);
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  // NOTE: filtering "dismissed_today_date != today" at the DB level
  // with .neq() is a trap - in Postgres, NULL != today evaluates to
  // unknown, so PostgREST drops those rows instead of including them.
  // Since every freshly-seeded reminder starts with
  // dismissed_today_date = null, that .neq() was silently excluding
  // every reminder that hadn't already been dismissed on some earlier
  // day - which is exactly the popups that should be showing up. The
  // JS-side filter below already does this comparison correctly
  // (null !== today is true), so the DB-side exclusion is left out
  // entirely here.
  const { data: pending } = await supabase
    .from('tenant_rating_reminders')
    .select('id, tenant_id, trigger_reason, dismissed_today_date, tenants(full_name, unit_id, units(unit_label))')
    .eq('rater_user_type', userType)
    .eq('rater_user_id', userId)
    .or(`snoozed_until.is.null,snoozed_until.lt.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(20);

  const eligible = (pending || []).filter((r) => r.dismissed_today_date !== today);
  if (eligible.length) {
    const pick = eligible.find((r) => r.trigger_reason === 'payment') || eligible[0];
    return {
      reminderId: pick.id,
      tenantId: pick.tenant_id,
      unitId: pick.tenants?.unit_id || null,
      tenantName: pick.tenants?.full_name || 'A tenant',
      unitLabel: pick.tenants?.units?.unit_label || null,
      reason: pick.trigger_reason,
    };
  }

  // No queued row - fall back to a random tenant this rater hasn't
  // rated yet at all, and seed a reminder row for it ("unrated").
  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, full_name, unit_id, units(unit_label, property_id)')
    .eq('landlord_id', landlordId)
    .eq('status', 'active');
  if (!tenants || !tenants.length) return null;

  const { data: already } = await supabase
    .from('tenant_ratings')
    .select('tenant_id')
    .eq('landlord_id', landlordId)
    .eq('rater_role', rRole);
  const ratedIds = new Set((already || []).map((r) => r.tenant_id));
  const unrated = tenants.filter((t) => !ratedIds.has(t.id));
  if (!unrated.length) return null;

  const chosen = unrated[Math.floor(Math.random() * unrated.length)];
  const { data: seeded } = await supabase
    .from('tenant_rating_reminders')
    .upsert(
      {
        landlord_id: landlordId,
        tenant_id: chosen.id,
        property_id: chosen.units?.property_id || null,
        rater_user_type: userType,
        rater_user_id: userId,
        rater_role: rRole,
        trigger_reason: 'unrated',
        updated_at: nowIso,
      },
      { onConflict: 'tenant_id,rater_user_type,rater_user_id' }
    )
    .select()
    .single();

  return {
    reminderId: seeded?.id,
    tenantId: chosen.id,
    unitId: chosen.unit_id || null,
    tenantName: chosen.full_name,
    unitLabel: chosen.units?.unit_label || null,
    reason: 'unrated',
  };
}

/** "Remind me later" (~1 hour) or "Not today" (rest of the calendar day). */
async function snoozeReminder({ reminderId, userId, userType, mode }) {
  const patch = { updated_at: new Date().toISOString() };
  if (mode === 'not_today') {
    patch.dismissed_today_date = new Date().toISOString().slice(0, 10);
  } else {
    patch.snoozed_until = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  }
  await supabase
    .from('tenant_rating_reminders')
    .update(patch)
    .eq('id', reminderId)
    .eq('rater_user_id', userId)
    .eq('rater_user_type', userType);
}

module.exports = { queuePaymentReminder, getNextReminder, snoozeReminder, raterUserType };
