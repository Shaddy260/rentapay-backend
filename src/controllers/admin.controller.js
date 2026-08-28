// src/controllers/admin.controller.js
//
// Implements blueprint section 13 (Super Admin Panel) powers: viewing
// platform-wide data, suspending/activating accounts, revoking notices,
// editing balances, force logout, emergency lockdown.

const supabase = require('../config/supabase');
const { notify } = require('../services/notify.service');
const { logActivity } = require('../services/activityLog.service');
const { comparePassword } = require('../utils/password');
const { confirmAdminOrGmAction, isGmAction } = require('../utils/actionConfirmation');
const { applyUnitLimitChange } = require('../utils/unitLimitEnforcement');
const { KENYA_COUNTIES } = require('../constants/kenyaCounties');
const { captureException } = require('../services/sentry.service');
const { getMRRForMonth, getActiveLandlordsWithGrace } = require('../services/coveragePeriod.service');
const { getPricingProposal } = require('../services/pricingProposal.service');
const logger = require('../utils/logger');

// FIX ("deleting a landlord, or locking down the platform, should
// require the admin password"): both are irreversible/platform-wide
// actions gated behind nothing but a browser confirm() dialog before,
// which is trivial to click through by accident. Both now re-check
// the admin's password (the same hash adminLogin checks) before doing
// anything, exactly like a bank re-asking for your PIN on a transfer.
async function verifyAdminPassword(password) {
  const adminPasswordHash = process.env.SUPER_ADMIN_PASSWORD_HASH;
  if (!adminPasswordHash) return false;
  if (!password) return false;
  return comparePassword(password, adminPasswordHash);
}

// ---------------------------------------------------------------------
// DASHBOARD METRICS (blueprint 13.1)
// ---------------------------------------------------------------------
async function getDashboardMetrics(req, res) {
  try {
    const [{ count: totalLandlords }, { count: activeLandlords }, { count: suspendedLandlords }, { count: totalUnits }, { count: totalTenants }] =
      await Promise.all([
        supabase.from('landlords').select('*', { count: 'exact', head: true }),
        supabase.from('landlords').select('*', { count: 'exact', head: true }).eq('subscription_status', 'active'),
        supabase.from('landlords').select('*', { count: 'exact', head: true }).eq('subscription_status', 'suspended'),
        supabase.from('units').select('*', { count: 'exact', head: true }),
        supabase.from('tenants').select('*', { count: 'exact', head: true }),
      ]);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const startOfYear = new Date(new Date().getFullYear(), 0, 1);

    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    // PERFORMANCE FIX: same pattern as the landlord dashboard - these
    // don't depend on each other, so run them together instead of one
    // after another.
    //
    // THE FIX for "revenue this year is stuck / not counting": this
    // used to sum ONLY subscription_payments (the STK-push path). But
    // landlords also renew via the manual "didn't get the STK popup,
    // pay via Paybill and submit the transaction code" flow, which
    // lands in landlord_manual_subscription_payments once an admin
    // confirms it - that table was never included here. So the moment
    // a landlord (or manager/caretaker) paid manually instead of via
    // STK, that money stopped showing up in platform revenue at all -
    // the figure would just plateau even as real payments kept coming
    // in. Both sources are now summed together.
    const [{ data: monthPayments }, { data: yearPayments }, { data: monthManualPayments }, { data: yearManualPayments }, { data: expiringSoon }] = await Promise.all([
      supabase.from('subscription_payments').select('amount').eq('status', 'completed').gte('paid_at', startOfMonth.toISOString()),
      supabase.from('subscription_payments').select('amount').eq('status', 'completed').gte('paid_at', startOfYear.toISOString()),
      supabase.from('landlord_manual_subscription_payments').select('amount_paid').eq('status', 'confirmed').gte('confirmed_or_rejected_at', startOfMonth.toISOString()),
      supabase.from('landlord_manual_subscription_payments').select('amount_paid').eq('status', 'confirmed').gte('confirmed_or_rejected_at', startOfYear.toISOString()),
      supabase.from('landlords').select('id, full_name, phone, subscription_expires_at').eq('subscription_status', 'active').lte('subscription_expires_at', sevenDaysFromNow.toISOString()),
    ]);

    const revenueThisMonth =
      (monthPayments || []).reduce((sum, p) => sum + Number(p.amount), 0) +
      (monthManualPayments || []).reduce((sum, p) => sum + Number(p.amount_paid || 0), 0);
    const revenueThisYear =
      (yearPayments || []).reduce((sum, p) => sum + Number(p.amount), 0) +
      (yearManualPayments || []).reduce((sum, p) => sum + Number(p.amount_paid || 0), 0);

    const payload = {
      totalLandlords,
      activeLandlords,
      suspendedLandlords,
      totalUnits,
      totalTenants,
      revenueThisMonth,
      revenueThisYear,
      expiringSoon,
    };

    // SECTION 5 (General Manager spec): this single endpoint mixes
    // operational counts with the platform's financial/profit figures
    // (revenueThisMonth/revenueThisYear). A General Manager gets
    // everything else on this dashboard, but those two fields are
    // stripped out here rather than just hidden in the frontend, so
    // the numbers never leave the server for that role.
    if (req.user && req.user.role === 'general_manager') {
      delete payload.revenueThisMonth;
      delete payload.revenueThisYear;
    }

    return res.json(payload);
  } catch (err) {
    logger.error('[admin] getDashboardMetrics error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch dashboard metrics.' });
  }
}

// ---------------------------------------------------------------------
// LIST / VIEW ALL LANDLORDS (blueprint 13.2: "view every landlord")
// ---------------------------------------------------------------------
async function listAllLandlords(req, res) {
  try {
    // PERF: unbounded before - every landlord ever signed up, no
    // .limit(), reloaded in full every time this tab is opened. This
    // is the query behind the admin portal's "Landlords" tab, so it
    // only gets slower as RentaPay grows. Capped; the search box in
    // that tab filters client-side today, so raise this (or move to
    // real server-side search/pagination) if the landlord count ever
    // approaches it.
    const { data: landlords, error } = await supabase
      .from('landlords')
      .select('id, full_name, phone, email, photo_url, estate_name, location, county, subscription_plan, subscription_status, subscription_expires_at, unit_limit, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;
    return res.json({ landlords });
  } catch (err) {
    logger.error('[admin] listAllLandlords error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch landlords.' });
  }
}

// ---------------------------------------------------------------------
// INCOMPLETE SIGNUPS (spec item 10): landlords who started the
// account-creation flow but never finished the setup wizard, so the
// admin team can see where people are dropping off and follow up.
// Reuses the exact same step logic auth.controller.js's
// computeLandlordResumeStep already uses to decide where to resume a
// landlord who logs back in mid-setup - a signup is "incomplete"
// whenever that function would return a step (i.e.
// setup_wizard_complete is still false), and the label below just
// narrates that same decision instead of re-deriving it differently.
// Suspended accounts are excluded - those are complete accounts an
// admin later suspended, not abandoned signups.
// ---------------------------------------------------------------------
const INCOMPLETE_SIGNUP_STEP_LABELS = {
  email_verification: 'Verifying email',
  payment: 'Paying for subscription',
  property: 'Adding first property',
  payment_method: 'Choosing a payment method',
  units: 'Adding units',
  // BUGFIX (direct report: "landlord completed the signup but data
  // shown says he has not added units yet, he has"): a landlord whose
  // completeSetupWizard call failed after they'd already added units
  // (e.g. the must_change_password/setup_wizard_complete schema-cache
  // bug - see sql/2026-07-fixes.sql) stays stuck with
  // setup_wizard_complete = false forever, even though every real
  // step - property, payment method, AND units - is done. The old
  // logic inferred the "units" step purely from property + payment
  // method existing, without ever checking whether units actually
  // exist, so it kept mislabeling these landlords as "Adding units"
  // when in fact they'd finished and just failed to persist that.
  stuck_after_units: 'Finishing setup (units already added)',
};

async function getIncompleteSignups(req, res) {
  try {
    const { data: landlords, error } = await supabase
      .from('landlords')
      .select('id, full_name, phone, email, subscription_status, email_verified, created_at')
      .eq('setup_wizard_complete', false)
      .neq('subscription_status', 'suspended')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) throw error;

    const landlordIds = (landlords || []).map((l) => l.id);

    // One query for the first property of every incomplete landlord,
    // then one for payment_method, instead of N+1 round trips.
    const { data: properties, error: propErr } = landlordIds.length
      ? await supabase.from('properties').select('landlord_id').in('landlord_id', landlordIds)
      : { data: [], error: null };
    if (propErr) throw propErr;
    const landlordIdsWithProperty = new Set((properties || []).map((p) => p.landlord_id));

    const { data: paymentMethods, error: pmErr } = landlordIds.length
      ? await supabase.from('landlords').select('id, payment_method').in('id', landlordIds)
      : { data: [], error: null };
    if (pmErr) throw pmErr;
    const paymentMethodById = new Map((paymentMethods || []).map((l) => [l.id, l.payment_method]));

    // BUGFIX: also check for actual units, not just a property + a
    // payment method, so a landlord who really did finish adding
    // units (and only got stuck because completeSetupWizard itself
    // failed to save) isn't mislabeled as still needing to add units.
    const { data: unitRows, error: unitErr } = landlordIds.length
      ? await supabase.from('units').select('landlord_id').in('landlord_id', landlordIds)
      : { data: [], error: null };
    if (unitErr) throw unitErr;
    const landlordIdsWithUnits = new Set((unitRows || []).map((u) => u.landlord_id));

    const signups = (landlords || []).map((l) => {
      let step;
      if (!l.email_verified) {
        step = 'email_verification';
      } else if (l.subscription_status === 'pending') {
        step = 'payment';
      } else if (!landlordIdsWithProperty.has(l.id)) {
        step = 'property';
      } else if (!paymentMethodById.get(l.id)) {
        step = 'payment_method';
      } else if (!landlordIdsWithUnits.has(l.id)) {
        step = 'units';
      } else {
        // Property, payment method, AND units all exist, yet
        // setup_wizard_complete is still false - they finished, the
        // completion call just never persisted. Surface this
        // distinctly instead of telling the admin team units are
        // still missing.
        step = 'stuck_after_units';
      }

      return {
        id: l.id,
        fullName: l.full_name,
        phone: l.phone,
        email: l.email,
        createdAt: l.created_at,
        step,
        stepLabel: INCOMPLETE_SIGNUP_STEP_LABELS[step],
      };
    });

    return res.json({ signups });
  } catch (err) {
    logger.error('[admin] getIncompleteSignups error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch incomplete signups.' });
  }
}

// ---------------------------------------------------------------------
// SUSPEND / ACTIVATE ACCOUNT (blueprint 13.2)
// ---------------------------------------------------------------------
async function setLandlordStatus(req, res) {
  try {
    const { landlordId } = req.params;
    const { status } = req.body; // 'active' | 'suspended'

    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'." });
    }

    // FIX (direct request): suspending a landlord and reactivating one
    // both change whether real money can move through their account -
    // same weight as deleting one, which already required the admin
    // password. Neither direction is treated as the "safe" one that
    // gets a pass.
    // SECTION 6 (General Manager spec): a General Manager confirms
    // with their Operations PIN + reason instead of the admin
    // password - already checked at the router level for that role;
    // confirmAdminOrGmAction() does the right check either way.
    const { data: before } = await supabase.from('landlords').select('full_name, subscription_status').eq('id', landlordId).maybeSingle();

    const confirmed = await confirmAdminOrGmAction(req);
    if (!confirmed.ok) {
      return res.status(401).json({ error: `${confirmed.error} Landlord was NOT ${status === 'suspended' ? 'suspended' : 'activated'}.` });
    }

    const { error } = await supabase.from('landlords').update({ subscription_status: status }).eq('id', landlordId);
    if (error) throw error;

    logActivity({
      actorType: isGmAction(req) ? 'general_manager' : 'admin',
      actorId: isGmAction(req) ? req.user.id : 'super-admin',
      action: `landlord_${status}`,
      targetType: 'landlord',
      targetId: landlordId,
      metadata: isGmAction(req)
        ? {
            reason: req.pinConfirmedReason,
            affectedPersonLabel: before?.full_name,
            before: { subscription_status: before?.subscription_status },
            after: { subscription_status: status },
          }
        : undefined,
      ipAddress: req.ip,
    });

    return res.json({ message: `Landlord account ${status}.` });
  } catch (err) {
    logger.error('[admin] setLandlordStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update landlord status.' });
  }
}

// ---------------------------------------------------------------------
// DELETE ACCOUNT PERMANENTLY (blueprint 13.2)
// ---------------------------------------------------------------------
async function deleteLandlordAccount(req, res) {
  try {
    const { landlordId } = req.params;

    // Snapshotted BEFORE confirmAdminOrGmAction/delete so a General
    // Manager's Section 10 revert has a full row to re-insert - "a
    // true, precise undo, not an approximation" - not just the fact
    // that a landlord with this id once existed.
    const { data: fullRowBeforeDelete } = await supabase.from('landlords').select('*').eq('id', landlordId).maybeSingle();

    const confirmed = await confirmAdminOrGmAction(req);
    if (!confirmed.ok) {
      return res.status(401).json({ error: `${confirmed.error} Account was NOT deleted.` });
    }

    const { error } = await supabase.from('landlords').delete().eq('id', landlordId);
    if (error) throw error;

    logActivity({
      actorType: isGmAction(req) ? 'general_manager' : 'admin',
      actorId: isGmAction(req) ? req.user.id : 'super-admin',
      action: 'landlord_deleted',
      targetType: 'landlord',
      targetId: landlordId,
      metadata: isGmAction(req)
        ? { reason: req.pinConfirmedReason, affectedPersonLabel: fullRowBeforeDelete?.full_name, before: fullRowBeforeDelete }
        : undefined,
      ipAddress: req.ip,
    });

    return res.json({ message: 'Landlord account permanently deleted.' });
  } catch (err) {
    logger.error('[admin] deleteLandlordAccount error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete landlord account.' });
  }
}

// ---------------------------------------------------------------------
// GET a landlord's properties, so the admin edit UI can show which
// apartment/estate it's about to edit rather than blindly writing to
// the landlords row (which, once a landlord has any property, no
// longer drives what any portal actually displays - see
// editLandlordSubscription below for the full explanation).
// ---------------------------------------------------------------------
async function getLandlordProperties(req, res) {
  try {
    const { landlordId } = req.params;

    const { data: landlord, error: landlordError } = await supabase
      .from('landlords')
      .select('id, full_name, estate_name, location, county, unit_limit, subscription_plan, subscription_expires_at, ba_id')
      .eq('id', landlordId)
      .maybeSingle();
    if (landlordError) throw landlordError;
    if (!landlord) return res.status(404).json({ error: 'Landlord not found.' });

    // DIRECT REQUEST: BA attribution is per-PROPERTY (see
    // sql/2026-08-per-property-ba-attribution.sql) - each property is
    // its own entity here, shown independently with its own BA (or
    // none), separate from whichever BA (if any) is on the landlord's
    // original signup. Same login/account either way - this is purely
    // about which BA gets credit for which entity.
    const { data: properties, error: propError } = await supabase
      .from('properties')
      .select(
        'id, name, location, county, unit_limit, subscription_period_months, subscription_expires_at, subscription_status, ba_id, ba_qualification_status'
      )
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: true });
    if (propError) throw propError;

    const baIds = [...new Set([landlord.ba_id, ...(properties || []).map((p) => p.ba_id)].filter(Boolean))];
    let baById = {};
    if (baIds.length > 0) {
      const { data: bas, error: baErr } = await supabase.from('brand_ambassadors').select('id, full_name, ba_code').in('id', baIds);
      if (baErr) throw baErr;
      baById = Object.fromEntries((bas || []).map((b) => [b.id, b]));
    }

    return res.json({
      landlord: {
        ...landlord,
        baId: landlord.ba_id,
        baName: landlord.ba_id ? baById[landlord.ba_id]?.full_name || null : null,
        baCode: landlord.ba_id ? baById[landlord.ba_id]?.ba_code || null : null,
      },
      properties: (properties || []).map((p) => ({
        ...p,
        baId: p.ba_id,
        baName: p.ba_id ? baById[p.ba_id]?.full_name || null : null,
        baCode: p.ba_id ? baById[p.ba_id]?.ba_code || null : null,
      })),
    });
  } catch (err) {
    logger.error('[admin] getLandlordProperties error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch landlord properties.' });
  }
}

// ---------------------------------------------------------------------
// MANAGERS/CARETAKERS NESTED UNDER A LANDLORD (admin/GM)
//
// Managers and caretakers don't have their own portal or dashboard -
// they log into the SAME landlord dashboard the landlord uses (see
// propertyManager.controller.js's doc comment), so admin doesn't get a
// standalone "Managers" tab either. Instead they're surfaced nested
// under their landlord, both from the landlords drilldown/table (an
// expandable row) and via global search deep-link, with the same
// suspend/activate actions a landlord row gets.
//
// listManagers (propertyManager.controller.js) can't be reused as-is:
// it resolves the landlord to scope to via effectiveLandlordId(req),
// which for an admin/GM token resolves to the admin's own id, not the
// landlord being looked at. This is a small, admin-specific sibling
// that takes the landlordId explicitly from the URL and - unlike the
// landlord-facing listing - always includes suspended (is_active:
// false) managers too, since seeing/reactivating a suspended one is
// the whole point of this view.
// ---------------------------------------------------------------------
async function getLandlordManagers(req, res) {
  try {
    const { landlordId } = req.params;

    const { data: landlord, error: landlordError } = await supabase
      .from('landlords')
      .select('id, full_name')
      .eq('id', landlordId)
      .maybeSingle();
    if (landlordError) throw landlordError;
    if (!landlord) return res.status(404).json({ error: 'Landlord not found.' });

    const { data: managers, error } = await supabase
      .from('property_managers')
      .select('id, full_name, phone, email, photo_url, is_active, is_verified, role_level, gender, created_at, whatsapp_number')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const managerIds = (managers || []).map((m) => m.id);
    let assignmentsByManager = {};
    if (managerIds.length) {
      const { data: assignments, error: aErr } = await supabase
        .from('property_manager_assignments')
        .select('property_manager_id, property_id, properties(id, name)')
        .in('property_manager_id', managerIds);
      if (aErr) throw aErr;
      assignmentsByManager = (assignments || []).reduce((acc, a) => {
        acc[a.property_manager_id] = acc[a.property_manager_id] || [];
        acc[a.property_manager_id].push({ id: a.property_id, name: a.properties?.name });
        return acc;
      }, {});
    }

    return res.json({
      landlord,
      managers: (managers || []).map((m) => ({ ...m, assignedProperties: assignmentsByManager[m.id] || [] })),
    });
  } catch (err) {
    logger.error('[admin] getLandlordManagers error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch managers/caretakers for this landlord.' });
  }
}

// ---------------------------------------------------------------------
// SUSPEND / ACTIVATE A MANAGER OR CARETAKER (admin/GM)
//
// Mirrors setLandlordStatus above - same password/PIN confirmation
// gate via confirmAdminOrGmAction, same activity-log shape. Managers
// don't have a subscription_status column like landlords; property_managers
// has always modeled "removed" as is_active: false (see
// propertyManager.controller.js's removeManager), so 'suspended' here
// maps to is_active: false and 'active' maps to is_active: true. This
// also, for the first time, gives admin a way to REVERSE that - the
// landlord-facing removeManager route only ever turns is_active off,
// with no matching "restore" endpoint.
// ---------------------------------------------------------------------
async function setManagerStatus(req, res) {
  try {
    const { managerId } = req.params;
    const { status } = req.body; // 'active' | 'suspended'

    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'." });
    }

    const { data: before } = await supabase
      .from('property_managers')
      .select('full_name, is_active, landlord_id, role_level')
      .eq('id', managerId)
      .maybeSingle();
    if (!before) return res.status(404).json({ error: 'Manager/caretaker not found.' });

    const confirmed = await confirmAdminOrGmAction(req);
    if (!confirmed.ok) {
      return res.status(401).json({ error: `${confirmed.error} Account was NOT ${status === 'suspended' ? 'suspended' : 'activated'}.` });
    }

    const { error } = await supabase
      .from('property_managers')
      .update({ is_active: status === 'active' })
      .eq('id', managerId);
    if (error) throw error;

    logActivity({
      actorType: isGmAction(req) ? 'general_manager' : 'admin',
      actorId: isGmAction(req) ? req.user.id : 'super-admin',
      action: `${before.role_level === 'caretaker' ? 'caretaker' : 'manager'}_${status}`,
      targetType: 'property_manager',
      targetId: managerId,
      metadata: isGmAction(req)
        ? {
            reason: req.pinConfirmedReason,
            affectedPersonLabel: before.full_name,
            before: { is_active: before.is_active },
            after: { is_active: status === 'active' },
          }
        : undefined,
      ipAddress: req.ip,
    });

    return res.json({ message: `${before.role_level === 'caretaker' ? 'Caretaker' : 'Manager'} account ${status}.` });
  } catch (err) {
    logger.error('[admin] setManagerStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update manager/caretaker status.' });
  }
}

// ---------------------------------------------------------------------
// EDIT ANY SUBSCRIPTION (blueprint 13.2: extend, shorten, change period)
// ---------------------------------------------------------------------
async function editLandlordSubscription(req, res) {
  try {
    const { landlordId } = req.params;
    const { newExpiryDate, newPlan, newUnitLimit, reason, propertyId, name, location, county, constituency } = req.body;

    const updateFields = {};
    if (newExpiryDate) updateFields.subscription_expires_at = newExpiryDate;
    if (newPlan) updateFields.subscription_plan = newPlan;
    if (newUnitLimit != null) updateFields.unit_limit = newUnitLimit;

    // FIX ("I edited a landlord's subscription to 5 days left, but the
    // portal flickered between 1 day and 26 days and never settled"):
    // each property can have its OWN independent subscription clock
    // (subscription_expires_at/unit_limit on the `properties` row, not
    // just the pooled one on `landlords`) - see
    // add-per-property-subscriptions.sql. Editing the landlord row
    // only ever touched the pooled clock, which silently does nothing
    // for a property that already has its own. Pass `propertyId` to
    // edit THAT property's clock directly instead - this is also the
    // building block for "apartments should be fully independent,
    // nothing shared just because it's the same landlord" (item 7):
    // going forward, edit each apartment's subscription individually
    // by its propertyId rather than assuming one shared landlord-level
    // number always applies.
    //
    // FIX ("I edited the unit count / estate name for a landlord and
    // the changes didn't apply anywhere"): the portal always displays
    // properties.name / properties.unit_limit once a landlord has any
    // property row (which is effectively every landlord, since every
    // existing account got one backfilled) - editing landlords.
    // estate_name/unit_limit through the SQL tab was silently a no-op
    // for anyone in that state. `name`/`location`/`county` are
    // property-level (properties.name is the estate name); this same
    // propertyId branch now handles those too, so a single edit call
    // always lands on whichever row the portal is actually reading.
    if (propertyId) {
      if (name !== undefined) updateFields.name = name;
      if (location !== undefined) updateFields.location = location;
      if (county !== undefined) updateFields.county = county;
      if (constituency !== undefined) updateFields.constituency = constituency;

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ error: 'No fields to update.' });
      }

      const { error: propError } = await supabase.from('properties').update(updateFields).eq('id', propertyId).eq('landlord_id', landlordId);
      if (propError) throw propError;

      if (newUnitLimit != null) {
        await applyUnitLimitChange({ propertyId, newLimit: Number(newUnitLimit), actorType: 'admin', actorId: 'super-admin' });
      }

      logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'property_subscription_edited_by_admin', targetType: 'property', targetId: propertyId, reason, metadata: updateFields, ipAddress: req.ip });
      return res.json({ message: 'Property updated.' });
    }

    // No propertyId - this landlord has no property rows at all yet
    // (pre-multi-property account, or a brand-new signup that hasn't
    // finished onboarding), so the landlords row itself is still what
    // every portal reads. name/location/county map to the landlord's
    // own estate_name/location/county columns in that case.
    if (name !== undefined) updateFields.estate_name = name;
    if (location !== undefined) updateFields.location = location;
    if (county !== undefined) updateFields.county = county;
    if (constituency !== undefined) updateFields.constituency = constituency;

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    const { error } = await supabase.from('landlords').update(updateFields).eq('id', landlordId);
    if (error) throw error;

    // "When admin adjusts the units of a landlord to fewer, and the

    // extra units removed had tenants, those tenants should go to
    // Archive - not vanish - and the removed units should be frozen
    // (greyed out), preferring to remove EMPTY units first." Also
    // handles the reverse: raising newUnitLimit back up unfreezes
    // previously-frozen units automatically.
    if (newUnitLimit != null) {
      await applyUnitLimitChange({ landlordId, newLimit: Number(newUnitLimit), actorType: 'admin', actorId: 'super-admin' });
    }

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'subscription_edited_by_admin', targetType: 'landlord', targetId: landlordId, reason, metadata: updateFields, ipAddress: req.ip });

    return res.json({ message: 'Subscription updated.' });
  } catch (err) {
    logger.error('[admin] editLandlordSubscription error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to edit subscription.' });
  }
}

// ---------------------------------------------------------------------
// PLATFORM ACTIVITY LOG (blueprint 13.1, 13.2)
// ---------------------------------------------------------------------
async function getActivityLog(req, res) {
  try {
    const limit = Number(req.query.limit) || 500;
    const { data: logs, error } = await supabase
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return res.json({ logs });
  } catch (err) {
    logger.error('[admin] getActivityLog error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch activity log.' });
  }
}

// Delete a single activity log entry.
async function deleteActivityLogEntry(req, res) {
  try {
    const { logId } = req.params;
    const { error } = await supabase.from('activity_logs').delete().eq('id', logId);
    if (error) throw error;
    return res.json({ message: 'Log entry deleted.' });
  } catch (err) {
    logger.error('[admin] deleteActivityLogEntry error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete log entry.' });
  }
}

// Delete every entry for one calendar day (used by the "delete this
// day's logs" button next to each date group in the admin UI).
// Expects ?date=YYYY-MM-DD (the admin's local calendar day).
async function deleteActivityLogsForDay(req, res) {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date is required, in YYYY-MM-DD format.' });
    }
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    const { error } = await supabase
      .from('activity_logs')
      .delete()
      .gte('created_at', startOfDay.toISOString())
      .lte('created_at', endOfDay.toISOString());

    if (error) throw error;
    return res.json({ message: `Deleted all activity logs for ${date}.` });
  } catch (err) {
    logger.error('[admin] deleteActivityLogsForDay error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete logs for that day.' });
  }
}

// ---------------------------------------------------------------------
// EMERGENCY LOCKDOWN (blueprint 13.2 + 13.3: "freezes all landlord accounts")
// ---------------------------------------------------------------------
/**
 * Blueprint 13.2: "Lock down entire platform in one click (emergency)".
 *
 * Previously this only flipped each landlord's subscription_status to
 * 'suspended' - but login() never checks that field at all (confirmed
 * during an earlier debugging session), and tenants weren't touched
 * in any way. The platform kept working normally throughout a
 * "lockdown." Fixed by writing to a real platform-wide flag that
 * login() actually checks for every account type, landlord and
 * tenant alike.
 *
 * @param {string} [reason] - shown to anyone trying to log in while locked down
 */
async function emergencyLockdown(req, res) {
  try {
    const { reason, password } = req.body;

    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect admin password. Lockdown was NOT activated.' });
    }

    const { error } = await supabase
      .from('platform_settings')
      .update({
        is_locked_down: true,
        lockdown_reason: reason || 'The platform is temporarily paused for technical maintenance.',
        lockdown_started_at: new Date().toISOString(),
      })
      .eq('id', 1);

    if (error) throw error;

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'emergency_lockdown_triggered', ipAddress: req.ip, reason, metadata: { reason } });

    return res.json({ message: 'Emergency lockdown activated. All logins are now blocked platform-wide.' });
  } catch (err) {
    logger.error('[admin] emergencyLockdown error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to trigger lockdown.' });
  }
}

/**
 * Reverses emergencyLockdown - blueprint 13.2 doesn't explicitly list
 * a "resume" power, but a one-way lockdown with no way back would
 * permanently brick the platform, so this is the necessary
 * counterpart, added by direct request.
 */
async function resumeFromLockdown(req, res) {
  try {
    const { password } = req.body;

    // FIX (direct request): locking down the platform requires the
    // admin password, so lifting that lockdown - putting every
    // landlord's and tenant's login access back - must require it too.
    // A lockdown that anyone with just an active admin session could
    // undo with one click wasn't actually protected by anything.
    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect admin password. Lockdown was NOT lifted.' });
    }

    const { error } = await supabase
      .from('platform_settings')
      .update({ is_locked_down: false, lockdown_reason: null, lockdown_started_at: null })
      .eq('id', 1);

    if (error) throw error;

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'lockdown_resumed', ipAddress: req.ip });

    return res.json({ message: 'Platform lockdown lifted. All accounts can log in normally again.' });
  } catch (err) {
    logger.error('[admin] resumeFromLockdown error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to resume from lockdown.' });
  }
}

/**
 * Lets the admin panel check current lockdown state without needing
 * to log in as anyone else to find out.
 */
async function getLockdownStatus(req, res) {
  try {
    const { data, error } = await supabase.from('platform_settings').select('*').eq('id', 1).single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    logger.error('[admin] getLockdownStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch lockdown status.' });
  }
}

// ---------------------------------------------------------------------
// DRILL-DOWNS for the clickable dashboard summary cards (item B) -
// getDashboardMetrics above only ever returned counts; these give the
// admin dashboard something to actually open when a card is clicked.
// ---------------------------------------------------------------------

async function listAllTenants(req, res) {
  try {
    // PERF: this is the admin portal's "all tenants" drill-down - it
    // joined every tenant on the platform to their landlord AND their
    // unit/property with no .limit(), so response time (and the
    // amount of data shipped to the browser) grows with every tenant
    // RentaPay ever signs up, forever. Capped to bound both.
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select(
        'id, full_name, primary_phone, secondary_phone, email, photo_url, emergency_contact_name, emergency_contact_phone, ' +
          'is_active, balance_due, landlord_id, unit_id, ' +
          'landlords(full_name, phone, location, county), units(unit_name, properties(name, location, county))'
      )
      .order('full_name')
      .limit(1000);

    if (error) throw error;
    return res.json({ tenants });
  } catch (err) {
    logger.error('[admin] listAllTenants error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch tenants.' });
  }
}

async function listAllUnits(req, res) {
  try {
    // PERF: same issue as listAllTenants above, one section up - every
    // unit on the platform, joined to landlord + property, no
    // .limit(). This is the admin portal's "all units" drill-down.
    const { data: units, error } = await supabase
      .from('units')
      .select('id, unit_name, unit_type, rent_amount, status, landlord_id, landlords(full_name, location, county), properties(name, location, county)')
      .order('unit_name')
      .limit(1000);

    if (error) throw error;
    return res.json({ units });
  } catch (err) {
    logger.error('[admin] listAllUnits error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch units.' });
  }
}

async function getRevenueBreakdown(req, res) {
  try {
    const period = req.query.period === 'year' ? 'year' : 'month';
    const startDate = new Date();
    if (period === 'year') {
      startDate.setMonth(0, 1);
    } else {
      startDate.setDate(1);
    }
    startDate.setHours(0, 0, 0, 0);

    const [{ data: payments, error }, { data: manualPayments, error: manualError }] = await Promise.all([
      supabase
        .from('subscription_payments')
        .select('id, amount, paid_at, landlord_id, landlords(full_name)')
        .eq('status', 'completed')
        .gte('paid_at', startDate.toISOString())
        .order('paid_at', { ascending: false }),
      // Same fix as getDashboardMetrics: manually-confirmed Paybill
      // subscription payments were missing from this breakdown, so it
      // undercounted (and looked "stuck") the moment any landlord used
      // the manual-payment fallback instead of the STK popup.
      // FIX: landlord_manual_subscription_payments has TWO foreign
      // keys into landlords (landlord_id AND submitted_by_landlord_id
      // - see add-landlord-manual-subscription-payments.sql), so the
      // bare `landlords(full_name)` embed below was ambiguous and
      // PostgREST rejected the whole query outright ("more than one
      // relationship was found"). That rejection was only ever logged
      // server-side; the admin just saw the generic "Failed to fetch
      // revenue breakdown." Same explicit-FK-name fix already used in
      // landlordManualSubscriptionPayment.controller.js.
      supabase
        .from('landlord_manual_subscription_payments')
        .select('id, amount_paid, confirmed_or_rejected_at, landlord_id, landlords!landlord_manual_subscription_payments_landlord_id_fkey(full_name)')
        .eq('status', 'confirmed')
        .gte('confirmed_or_rejected_at', startDate.toISOString())
        .order('confirmed_or_rejected_at', { ascending: false }),
    ]);

    if (error) throw error;
    if (manualError) throw manualError;

    const normalizedManual = (manualPayments || []).map((p) => ({
      id: p.id,
      amount: p.amount_paid,
      paid_at: p.confirmed_or_rejected_at,
      landlord_id: p.landlord_id,
      landlords: p.landlords,
      source: 'manual',
    }));
    const allPayments = [...(payments || []), ...normalizedManual].sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));

    const total = allPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    return res.json({ total, payments: allPayments, period });
  } catch (err) {
    logger.error('[admin] getRevenueBreakdown error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch revenue breakdown.' });
  }
}

// Expiring-soon landlords with full contact + property location, plus
// a drafted renewal reminder message per landlord - the rest of item
// B. sendRenewalReminders below actually sends it over SMS.
async function getExpiringLandlords(req, res) {
  try {
    const days = Number(req.query.days) || 7;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const { data: landlords, error } = await supabase
      .from('landlords')
      .select('id, full_name, phone, email, estate_name, location, county, subscription_plan, subscription_expires_at, unit_limit')
      .eq('subscription_status', 'active')
      .lte('subscription_expires_at', cutoff.toISOString())
      .order('subscription_expires_at', { ascending: true });

    if (error) throw error;

    const withDrafts = (landlords || []).map((l) => {
      const daysLeft = Math.max(0, Math.ceil((new Date(l.subscription_expires_at) - new Date()) / (1000 * 60 * 60 * 24)));
      return {
        ...l,
        daysLeft,
        draftMessage:
          `Hi ${l.full_name}, your RentaPay subscription for ${l.estate_name || 'your property'} ` +
          `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${new Date(l.subscription_expires_at).toLocaleDateString()}). ` +
          `Log in to renew and avoid any interruption to your tenants' payment access.`,
      };
    });

    return res.json({ landlords: withDrafts });
  } catch (err) {
    logger.error('[admin] getExpiringLandlords error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch expiring landlords.' });
  }
}

async function sendRenewalReminders(req, res) {
  try {
    const { landlordIds, message } = req.body; // message optional per-landlord override; falls back to the draft
    if (!Array.isArray(landlordIds) || landlordIds.length === 0) {
      return res.status(400).json({ error: 'landlordIds (non-empty array) is required.' });
    }

    const { data: landlords, error } = await supabase
      .from('landlords')
      .select('id, full_name, phone, estate_name, subscription_expires_at')
      .in('id', landlordIds);

    if (error) throw error;

    // FIX: this used to `await` one landlord's SMS+push at a time in
    // a for-loop - a reminder blast to a few hundred landlords meant
    // the admin's browser sat waiting for a few hundred round-trips
    // stacked in a row, potentially minutes. Promise.allSettled fires
    // them all at once and waits for the slowest one, not the sum -
    // same pattern the announcement broadcaster already used
    // correctly (see broadcastAnnouncement below/elsewhere).
    const settled = await Promise.allSettled(
      (landlords || []).map(async (l) => {
        const daysLeft = Math.max(0, Math.ceil((new Date(l.subscription_expires_at) - new Date()) / (1000 * 60 * 60 * 24)));
        const text =
          message ||
          `Hi ${l.full_name}, your RentaPay subscription for ${l.estate_name || 'your property'} ` +
            `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Log in to renew and avoid any interruption to your tenants' payment access.`;
        await notify('landlord', l.id, l.phone, text, { category: 'announcement', title: 'Subscription Renewal Reminder' });
        return l.id;
      })
    );

    const results = settled.map((r, i) => {
      const landlordId = landlords[i].id;
      if (r.status === 'fulfilled') return { landlordId, sent: true };
      logger.error(`[admin] sendRenewalReminders: failed to notify landlord ${landlordId}:`, r.reason?.message);
      return { landlordId, sent: false, error: r.reason?.message };
    });

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'renewal_reminders_sent', metadata: { landlordIds }, ipAddress: req.ip });

    return res.json({ results });
  } catch (err) {
    logger.error('[admin] sendRenewalReminders error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send renewal reminders.' });
  }
}

// ---------------------------------------------------------------------
// PLATFORM FINANCIAL STATISTICS (new: admin "Financial Statistics" menu
// item) - a 6-month subscription-revenue trend plus active/suspended
// landlord counts, built on top of the same tables getDashboardMetrics
// already reads. "Profit margin" wasn't computable (the platform has no
// cost-basis data anywhere in the schema - hosting, SMS, staff, etc
// aren't tracked), so this surfaces revenue-per-active-landlord instead
// as a clearly-labeled, honest proxy rather than fabricating a margin
// figure.
// ---------------------------------------------------------------------
async function getRevenueTrend(req, res) {
  try {
    const today = new Date();
    const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 5, 1);

    const [{ data: payments, error }, { data: manualPayments, error: manualError }] = await Promise.all([
      supabase.from('subscription_payments').select('amount, paid_at').eq('status', 'completed').gte('paid_at', sixMonthsAgo.toISOString()),
      // Same fix as getDashboardMetrics/getRevenueBreakdown: without
      // this, the trend line (and revenueThisMonth derived from it)
      // ignored every manually-confirmed Paybill subscription payment.
      supabase
        .from('landlord_manual_subscription_payments')
        .select('amount_paid, confirmed_or_rejected_at')
        .eq('status', 'confirmed')
        .gte('confirmed_or_rejected_at', sixMonthsAgo.toISOString()),
    ]);
    if (error) throw error;
    if (manualError) throw manualError;

    const monthly = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      monthly.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-GB', { month: 'short' }), value: 0 });
    }
    for (const p of payments || []) {
      if (!p.paid_at) continue;
      const d = new Date(p.paid_at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const bucket = monthly.find((m) => m.key === key);
      if (bucket) bucket.value += Number(p.amount);
    }
    for (const p of manualPayments || []) {
      if (!p.confirmed_or_rejected_at) continue;
      const d = new Date(p.confirmed_or_rejected_at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const bucket = monthly.find((m) => m.key === key);
      if (bucket) bucket.value += Number(p.amount_paid || 0);
    }

    const [{ count: totalLandlords }, { count: activeLandlords }, { count: suspendedLandlords }, { count: totalTenants }, { count: totalUnits }] =
      await Promise.all([
        supabase.from('landlords').select('*', { count: 'exact', head: true }),
        supabase.from('landlords').select('*', { count: 'exact', head: true }).eq('subscription_status', 'active'),
        supabase.from('landlords').select('*', { count: 'exact', head: true }).eq('subscription_status', 'suspended'),
        supabase.from('tenants').select('*', { count: 'exact', head: true }),
        supabase.from('units').select('*', { count: 'exact', head: true }),
      ]);

    const revenueThisMonth = monthly[monthly.length - 1].value;
    const revenuePerActiveLandlord = activeLandlords > 0 ? Math.round((revenueThisMonth / activeLandlords) * 100) / 100 : 0;

    return res.json({
      monthlyRevenue: monthly,
      landlords: { total: totalLandlords, active: activeLandlords, suspended: suspendedLandlords },
      totalTenants,
      totalUnits,
      revenueThisMonth,
      revenuePerActiveLandlord,
    });
  } catch (err) {
    logger.error('[admin] getRevenueTrend error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch revenue trend.' });
  }
}

// ---------------------------------------------------------------------
// REVENUE DASHBOARD (MRR, churn, renewals due this week, most-active
// landlords) - the admin tools were otherwise mostly
// moderation/support-focused (credentials, suspensions, SQL viewer);
// getRevenueBreakdown/getRevenueTrend already cover CASH COLLECTED per
// month, but that's a different number from MRR (a landlord who
// prepays 12 months at a discount shows up as one lump sum the month
// they pay, not spread out) - this adds the actual recurring-revenue
// metrics a subscription business tracks.
// ---------------------------------------------------------------------
async function getRevenueDashboard(req, res) {
  try {
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      { data: renewalsDue, error: renewalsErr },
      { data: recentlyLapsed, error: lapsedErr },
      { count: activeBaselineCount, error: pastActiveErr },
      { data: recentPayments, error: paymentsErr },
    ] = await Promise.all([
      // Renewals due this week - same underlying query as
      // getExpiringLandlords(days=7), duplicated here (rather than
      // calling that handler internally) so this single dashboard
      // endpoint returns everything in one round trip.
      supabase
        .from('landlords')
        .select('id, full_name, phone, subscription_expires_at')
        .eq('subscription_status', 'active')
        .lte('subscription_expires_at', sevenDaysFromNow.toISOString())
        .order('subscription_expires_at', { ascending: true }),

      // Churn numerator: landlords who lapsed (suspended/expired) in
      // the last 30 days - i.e. their subscription ran out and they
      // have NOT renewed since. updated_at is used as a proxy for
      // "when the status last changed" since there's no dedicated
      // status-history table; this is an approximation, labeled as
      // such in the response.
      supabase
        .from('landlords')
        .select('id, full_name, subscription_expires_at, updated_at')
        .in('subscription_status', ['suspended', 'expired'])
        .gte('updated_at', thirtyDaysAgo.toISOString()),

      // Churn denominator: landlords who were active-or-lapsed as of
      // 30 days ago, i.e. anyone who had already started their
      // subscription clock by then. subscription_started_at is the
      // real signup/activation date, unaffected by later status
      // changes.
      supabase
        .from('landlords')
        .select('id', { count: 'exact', head: true })
        .not('subscription_started_at', 'is', null)
        .lte('subscription_started_at', thirtyDaysAgo.toISOString()),

      // Most-active landlords: ranked by rent payments their tenants
      // actually processed through the platform in the last 30 days -
      // a landlord using RentaPay to collect real rent is a much
      // better "active" signal than a login count would be.
      supabase
        .from('payments')
        .select('landlord_id, amount, landlords(full_name)')
        .eq('status', 'completed')
        .gte('paid_at', thirtyDaysAgo.toISOString()),
    ]);

    if (renewalsErr) throw renewalsErr;
    if (lapsedErr) throw lapsedErr;
    if (pastActiveErr) throw pastActiveErr;
    if (paymentsErr) throw paymentsErr;

    // FIX (Phase 13 - "Phase 12's MRR input now comes from this
    // coverage-period model instead of raw monthly cash collected...
    // keeping active landlords, MRR, and the Phase 12 proposals all
    // consistent with one shared data model rather than drifting
    // apart"): this used to estimate MRR as "every currently-active
    // landlord's CURRENT rate x their unit count" - which is today's
    // price applied to today's landlords, not actual recognized
    // revenue for the month (a landlord who prepaid 6 months at last
    // quarter's price, or added units mid-term, was invisible to this
    // calculation). Now sourced from subscription_coverage_periods,
    // the same true-MRR figure Phase 12's pricing proposal uses -
    // this dashboard and that proposal can never drift apart into two
    // different "MRR" numbers again. Active landlord count/list is
    // now the same coverage-period-plus-grace-window definition too
    // (see getActiveLandlordsWithGrace's own scope note - this never
    // touches the landlord's actual subscription_status/paywall,
    // purely a read-model for these analytics).
    const [mrr, activeLandlordsWithGrace] = await Promise.all([
      getMRRForMonth(new Date()),
      getActiveLandlordsWithGrace(),
    ]);

    // --- Churn rate: lapsed-in-last-30-days / active-30-days-ago ----
    const churnedCount = (recentlyLapsed || []).length;
    const baseCount = activeBaselineCount || 0;

    // --- Most-active landlords: group payments by landlord ---------
    const byLandlord = new Map();
    for (const p of recentPayments || []) {
      const key = p.landlord_id;
      const entry = byLandlord.get(key) || { landlordId: key, name: p.landlords?.full_name || 'Unknown', totalCollected: 0, paymentCount: 0 };
      entry.totalCollected += Number(p.amount || 0);
      entry.paymentCount += 1;
      byLandlord.set(key, entry);
    }
    const mostActiveLandlords = [...byLandlord.values()]
      .sort((a, b) => b.totalCollected - a.totalCollected)
      .slice(0, 10);

    return res.json({
      mrr,
      activeLandlordCount: activeLandlordsWithGrace.length,
      renewalsDueThisWeek: renewalsDue || [],
      churn: {
        lapsedLast30Days: churnedCount,
        activeBaseline30DaysAgo: baseCount,
        rate: baseCount > 0 ? Math.round((churnedCount / baseCount) * 10000) / 100 : null, // percent, or null if no baseline to compare against
        note: 'Approximate: based on when a lapsed landlord\u2019s status last changed, not a dedicated status-history log.',
      },
      mostActiveLandlords,
    });
  } catch (err) {
    logger.error('[admin] getRevenueDashboard error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch revenue dashboard.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 12 - Admin Revenue Statistics & Pricing Proposal.
//
// Looks at real MRR (Phase 13's coverage-period model), real BA
// commission payouts, and real operating expenses, and proposes a
// price-per-unit and BA commission % that would hit an admin-chosen
// target profit margin - side by side with whatever's currently live.
// This endpoint is read-only: it never writes to
// subscription_pricing_settings or payout_rules - applying a proposal
// is a separate, deliberate step using the existing pricing/payout-
// rules admin screens.
// ---------------------------------------------------------------------
async function getPricingProposalHandler(req, res) {
  try {
    const targetMarginPct = req.query.targetMarginPct != null ? Number(req.query.targetMarginPct) : undefined;
    const monthKeyStr = req.query.monthKey || undefined;
    const proposal = await getPricingProposal({ targetMarginPct, monthKeyStr });
    return res.json(proposal);
  } catch (err) {
    logger.error('[admin] getPricingProposal error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to calculate pricing proposal.' });
  }
}


// (direct request: "group landlords based on counties... statistics
// of all landlords... line graphs of landlords and tenants... based
// on the 47 counties of Kenya"). Two parts:
//  1. countyBreakdown: landlord count (and their tenant count) per
//     county, for all 47 counties - including ones with zero
//     landlords, so the admin sees full Kenya coverage, not just
//     whichever counties happen to have data.
//  2. growth: how many landlords and tenants existed at the end of
//     each of the last 6 months, cumulative - what a "line graph
//     of landlords/tenants" means (running total over time), as
//     opposed to monthlyRevenue in getRevenueTrend which is a
//     per-month amount, not a running total.
async function getGrowthStatistics(req, res) {
  try {
    const [{ data: landlords, error: landlordsErr }, { data: tenants, error: tenantsErr }] = await Promise.all([
      supabase.from('landlords').select('id, county, created_at'),
      supabase.from('tenants').select('id, created_at, landlords(county), units(properties(county))'),
    ]);
    if (landlordsErr) throw landlordsErr;
    if (tenantsErr) throw tenantsErr;

    // --- County breakdown ---------------------------------------
    const countyCounts = Object.fromEntries(KENYA_COUNTIES.map((c) => [c, { landlords: 0, tenants: 0 }]));
    const UNKNOWN = 'Unknown / not set';
    countyCounts[UNKNOWN] = { landlords: 0, tenants: 0 };

    for (const l of landlords || []) {
      const county = l.county && countyCounts[l.county] ? l.county : UNKNOWN;
      countyCounts[county].landlords += 1;
    }
    for (const t of tenants || []) {
      // A tenant's county comes from their unit's property first
      // (most specific), falling back to the landlord's county for
      // tenants on units without their own property record.
      const county = t.units?.properties?.county || t.landlords?.county;
      const key = county && countyCounts[county] ? county : UNKNOWN;
      countyCounts[key].tenants += 1;
    }

    const countyBreakdown = Object.entries(countyCounts)
      .map(([county, counts]) => ({ county, landlords: counts.landlords, tenants: counts.tenants }))
      .sort((a, b) => b.landlords - a.landlords);

    // --- 6-month growth (cumulative, for the line graphs) --------
    const today = new Date();
    const months = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const endOfMonth = new Date(today.getFullYear(), today.getMonth() - i + 1, 1);
      months.push({ label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), cutoff: endOfMonth });
    }

    const landlordGrowth = months.map(({ label, cutoff }) => ({
      label,
      value: (landlords || []).filter((l) => l.created_at && new Date(l.created_at) < cutoff).length,
    }));
    const tenantGrowth = months.map(({ label, cutoff }) => ({
      label,
      value: (tenants || []).filter((t) => t.created_at && new Date(t.created_at) < cutoff).length,
    }));

    return res.json({ countyBreakdown, landlordGrowth, tenantGrowth });
  } catch (err) {
    logger.error('[admin] getGrowthStatistics error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch growth statistics.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 8 - Admin: Today's Onboarded Landlords (System Panel).
//
// Pure system-of-record data: REAL landlord signups (landlords.
// created_at) and not marketing leads (landlord_leads, Phase 9 -
// those never become a landlords row until someone actually
// registers). Defaults to today
// (server's UTC "today", same convention as the rest of the admin
// dashboard's date-scoped panels) when no range is given.
//
// ba_id (added to landlords in Phase 1) tells us, at a glance, which
// signups came in through a Brand Ambassador's referral link (Phase
// 4 - tagged automatically at registration, not asserted later) vs
// organic self-signup - so this joins in the BA's name/code rather
// than making the frontend do a second lookup per row.
// ---------------------------------------------------------------------
function todayRangeUtc() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

async function listLandlordsOnboarded(req, res) {
  try {
    let { from, to } = req.query;
    if (!from && !to) {
      const today = todayRangeUtc();
      from = today.from;
      to = today.to;
    }

    let query = supabase
      .from('landlords')
      .select('id, full_name, phone, location, county, ba_id, created_at, subscription_expires_at, subscription_status')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data: landlords, error } = await query;
    if (error) throw error;

    const baIds = [...new Set((landlords || []).map((l) => l.ba_id).filter(Boolean))];
    let baById = {};
    if (baIds.length > 0) {
      const { data: bas, error: baErr } = await supabase
        .from('brand_ambassadors')
        .select('id, full_name, ba_code')
        .in('id', baIds);
      if (baErr) throw baErr;
      baById = Object.fromEntries((bas || []).map((b) => [b.id, b]));
    }

    const rows = (landlords || []).map((l) => ({
      id: l.id,
      fullName: l.full_name,
      phone: l.phone,
      location: l.location,
      county: l.county,
      createdAt: l.created_at,
      subscriptionExpiresAt: l.subscription_expires_at,
      subscriptionStatus: l.subscription_status,
      baId: l.ba_id,
      baName: l.ba_id ? baById[l.ba_id]?.full_name || null : null,
      baCode: l.ba_id ? baById[l.ba_id]?.ba_code || null : null,
    }));

    return res.json({ landlords: rows });
  } catch (err) {
    logger.error('[admin] listLandlordsOnboarded error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch onboarded landlords.' });
  }
}

// ---------------------------------------------------------------------
// GLOBAL SEARCH
// ---------------------------------------------------------------------
async function globalSearch(req, res) {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q}%`;

    const [landlordsRes, tenantsRes, managersRes, gmsRes, basRes] = await Promise.all([
      supabase
        .from('landlords')
        .select('id, full_name, email, phone, estate_name')
        .ilike('email', like)
        .limit(10),
      supabase
        .from('tenants')
        .select('id, full_name, email, primary_phone, landlord_id, unit_id, landlords(full_name), units(unit_name)')
        .ilike('email', like)
        .limit(10),
      supabase
        .from('property_managers')
        .select('id, full_name, email, phone, landlord_id, role_level, is_active, landlords(full_name)')
        .ilike('email', like)
        .limit(10),
      supabase
        .from('general_managers')
        .select('id, full_name, email, phone')
        .ilike('email', like)
        .limit(10),
      supabase
        .from('brand_ambassadors')
        .select('id, full_name, email, phone, ba_code, status')
        .ilike('email', like)
        .limit(10),
    ]);

    for (const r of [landlordsRes, tenantsRes, managersRes, gmsRes, basRes]) {
      if (r.error) throw r.error;
    }

    const results = [
      ...(landlordsRes.data || []).map((l) => ({
        role: 'landlord',
        roleLabel: 'Landlord',
        id: l.id,
        name: l.full_name,
        email: l.email,
        phone: l.phone,
        context: l.estate_name || null,
      })),
      ...(tenantsRes.data || []).map((t) => ({
        role: 'tenant',
        roleLabel: 'Tenant',
        id: t.id,
        name: t.full_name,
        email: t.email,
        phone: t.primary_phone,
        context: [t.landlords?.full_name, t.units?.unit_name].filter(Boolean).join(' · ') || null,
        landlordId: t.landlord_id,
        landlordName: t.landlords?.full_name || null,
        unitId: t.unit_id || null,
        unitName: t.units?.unit_name || null,
      })),
      ...(managersRes.data || []).map((m) => ({
        role: 'manager',
        roleLabel: m.role_level === 'caretaker' ? 'Caretaker' : 'Manager',
        id: m.id,
        name: m.full_name,
        email: m.email,
        phone: m.phone,
        context: [m.landlords?.full_name ? `Works for ${m.landlords.full_name}` : null, m.is_active ? null : 'Suspended'].filter(Boolean).join(' · ') || null,
        landlordId: m.landlord_id,
        landlordName: m.landlords?.full_name || null,
        roleLevel: m.role_level || 'manager',
        isActive: m.is_active,
      })),
      ...(gmsRes.data || []).map((g) => ({
        role: 'general_manager',
        roleLabel: 'General Manager',
        id: g.id,
        name: g.full_name,
        email: g.email,
        phone: g.phone,
        context: null,
      })),
      ...(basRes.data || []).map((b) => ({
        role: 'brand_ambassador',
        roleLabel: 'Brand Ambassador',
        id: b.id,
        name: b.full_name,
        email: b.email,
        phone: b.phone,
        context: b.ba_code ? `${b.ba_code} · ${b.status}` : b.status,
        status: b.status,
        baCode: b.ba_code || null,
      })),
    ];

    return res.json({ results, query: q });
  } catch (err) {
    logger.error('[admin] globalSearch error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Search failed.' });
  }
}

module.exports = {
  getDashboardMetrics,
  listAllLandlords,
  getIncompleteSignups,
  listAllTenants,
  listAllUnits,
  globalSearch,
  getRevenueBreakdown,
  getRevenueTrend,
  getRevenueDashboard,
  getPricingProposal: getPricingProposalHandler,
  getGrowthStatistics,
  getExpiringLandlords,
  sendRenewalReminders,
  setLandlordStatus,
  deleteLandlordAccount,
  editLandlordSubscription,
  getLandlordProperties,
  getLandlordManagers,
  setManagerStatus,
  getActivityLog,
  deleteActivityLogEntry,
  deleteActivityLogsForDay,
  emergencyLockdown,
  resumeFromLockdown,
  getLockdownStatus,
  listLandlordsOnboarded,
};
