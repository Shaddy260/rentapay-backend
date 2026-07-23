// src/controllers/admin.controller.js
//
// Implements blueprint section 13 (Super Admin Panel) powers: viewing
// platform-wide data, suspending/activating accounts, revoking notices,
// editing balances, force logout, emergency lockdown.

const supabase = require('../config/supabase');
const { notify } = require('../services/notify.service');
const { logActivity } = require('../services/activityLog.service');
const { comparePassword } = require('../utils/password');
const { applyUnitLimitChange } = require('../utils/unitLimitEnforcement');
const { KENYA_COUNTIES } = require('../constants/kenyaCounties');

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
    const [{ count: totalLandlords }, { count: activeLandlords }, { count: suspendedLandlords }, { count: totalUnits }, { count: totalTenants }, { count: totalScouts }] =
      await Promise.all([
        supabase.from('landlords').select('*', { count: 'exact', head: true }),
        supabase.from('landlords').select('*', { count: 'exact', head: true }).eq('subscription_status', 'active'),
        supabase.from('landlords').select('*', { count: 'exact', head: true }).eq('subscription_status', 'suspended'),
        supabase.from('units').select('*', { count: 'exact', head: true }),
        supabase.from('tenants').select('*', { count: 'exact', head: true }),
        supabase.from('scouts').select('*', { count: 'exact', head: true }),
      ]);

    // Scouts don't have a single account-level "active" flag like
    // landlords - a scout is "active" if at least one of their
    // per-county subscriptions hasn't expired yet (mirrors the same
    // live-recompute getMySubscriptions already does, rather than
    // trusting the stored 'status' column which the reminder cron may
    // not have updated yet today).
    const nowIso = new Date().toISOString();
    const { data: activeSubRows } = await supabase.from('scout_county_subscriptions').select('scout_id, county').gt('expires_at', nowIso);
    const activeScouts = new Set((activeSubRows || []).map((r) => r.scout_id)).size;
    const activeCountySubscriptions = (activeSubRows || []).length;

    const startOfMonthScout = new Date();
    startOfMonthScout.setDate(1);
    startOfMonthScout.setHours(0, 0, 0, 0);
    const [{ data: scoutSTKPayments }, { data: scoutManualPayments }] = await Promise.all([
      supabase.from('scout_county_payments').select('amount').eq('status', 'completed').gte('created_at', startOfMonthScout.toISOString()),
      supabase.from('scout_manual_county_payments').select('amount_paid').eq('status', 'confirmed').gte('confirmed_or_rejected_at', startOfMonthScout.toISOString()),
    ]);
    const scoutRevenueThisMonth =
      (scoutSTKPayments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0) +
      (scoutManualPayments || []).reduce((sum, p) => sum + Number(p.amount_paid || 0), 0);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const startOfYear = new Date(new Date().getFullYear(), 0, 1);

    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    // PERFORMANCE FIX: same pattern as the landlord dashboard - these
    // three don't depend on each other, so run them together instead
    // of one after another.
    const [{ data: monthPayments }, { data: yearPayments }, { data: expiringSoon }] = await Promise.all([
      supabase.from('subscription_payments').select('amount').eq('status', 'completed').gte('paid_at', startOfMonth.toISOString()),
      supabase.from('subscription_payments').select('amount').eq('status', 'completed').gte('paid_at', startOfYear.toISOString()),
      supabase.from('landlords').select('id, full_name, phone, subscription_expires_at').eq('subscription_status', 'active').lte('subscription_expires_at', sevenDaysFromNow.toISOString()),
    ]);

    const revenueThisMonth = (monthPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);
    const revenueThisYear = (yearPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);

    return res.json({
      totalLandlords,
      activeLandlords,
      suspendedLandlords,
      totalUnits,
      totalTenants,
      revenueThisMonth,
      revenueThisYear,
      expiringSoon,
      scouts: {
        totalScouts,
        activeScouts,
        expiredOnlyScouts: totalScouts - activeScouts,
        activeCountySubscriptions,
        revenueThisMonth: scoutRevenueThisMonth,
      },
    });
  } catch (err) {
    console.error('[admin] getDashboardMetrics error:', err.message);
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
    console.error('[admin] listAllLandlords error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch landlords.' });
  }
}

// ---------------------------------------------------------------------
// LIST ALL SCOUTS (admin item 4 - there was previously no plain "list
// all scouts" screen at all, only the manual-payment-confirmation
// queue). Mirrors listAllLandlords: a flat table the admin portal can
// render straight away. Includes each scout's active county count so
// the admin can see engagement at a glance without a second request
// per row.
// ---------------------------------------------------------------------
async function listAllScouts(req, res) {
  try {
    const { data: scouts, error } = await supabase
      .from('scouts')
      .select('id, full_name, phone, email, is_active, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const nowIso = new Date().toISOString();
    const { data: activeSubRows } = await supabase
      .from('scout_county_subscriptions')
      .select('scout_id, county')
      .gt('expires_at', nowIso);

    const activeCountyCountByScout = new Map();
    for (const row of activeSubRows || []) {
      activeCountyCountByScout.set(row.scout_id, (activeCountyCountByScout.get(row.scout_id) || 0) + 1);
    }

    const enriched = (scouts || []).map((s) => ({
      ...s,
      activeCounties: activeCountyCountByScout.get(s.id) || 0,
    }));

    return res.json({ scouts: enriched });
  } catch (err) {
    console.error('[admin] listAllScouts error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch scouts.' });
  }
}

// ---------------------------------------------------------------------
// SUSPEND / ACTIVATE A SCOUT ACCOUNT (admin item 4)
// ---------------------------------------------------------------------
// scouts.is_active already existed in the schema (add-scout-role.sql,
// same meaning/column name as property_managers.is_active) but nothing
// read or wrote it until now, and isAccountStillValid() already has a
// role === 'scout' branch that checks it - so a suspended scout's
// existing JWT is rejected on their very next request, not just on
// their next login, exactly like a suspended manager/tenant.
//
// Deliberately NOT password-gated like setLandlordStatus: suspending a
// scout doesn't touch money movement the way suspending a landlord
// does (no subscription/billing state changes), it only blocks portal
// access - same weight as a manager's is_active toggle, which also
// isn't password-gated.
async function setScoutStatus(req, res) {
  try {
    const { scoutId } = req.params;
    const { status } = req.body; // 'active' | 'suspended'

    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'." });
    }

    const { data: scout, error: fetchErr } = await supabase.from('scouts').select('id').eq('id', scoutId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!scout) return res.status(404).json({ error: 'Scout not found.' });

    const { error } = await supabase.from('scouts').update({ is_active: status === 'active' }).eq('id', scoutId);
    if (error) throw error;

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: `scout_${status}`, targetType: 'scout', targetId: scoutId, ipAddress: req.ip });

    return res.json({ message: `Scout account ${status}.` });
  } catch (err) {
    console.error('[admin] setScoutStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to update scout status.' });
  }
}

// ---------------------------------------------------------------------
// SUSPEND / ACTIVATE ACCOUNT (blueprint 13.2)
// ---------------------------------------------------------------------
async function setLandlordStatus(req, res) {
  try {
    const { landlordId } = req.params;
    const { status, password } = req.body; // 'active' | 'suspended'

    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'." });
    }

    // FIX (direct request): suspending a landlord and reactivating one
    // both change whether real money can move through their account -
    // same weight as deleting one, which already required the admin
    // password. Neither direction is treated as the "safe" one that
    // gets a pass.
    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: `Incorrect admin password. Landlord was NOT ${status === 'suspended' ? 'suspended' : 'activated'}.` });
    }

    const { error } = await supabase.from('landlords').update({ subscription_status: status }).eq('id', landlordId);
    if (error) throw error;

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: `landlord_${status}`, targetType: 'landlord', targetId: landlordId, ipAddress: req.ip });

    return res.json({ message: `Landlord account ${status}.` });
  } catch (err) {
    console.error('[admin] setLandlordStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to update landlord status.' });
  }
}

// ---------------------------------------------------------------------
// DELETE ACCOUNT PERMANENTLY (blueprint 13.2)
// ---------------------------------------------------------------------
async function deleteLandlordAccount(req, res) {
  try {
    const { landlordId } = req.params;
    const { password } = req.body;

    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect admin password. Account was NOT deleted.' });
    }

    const { error } = await supabase.from('landlords').delete().eq('id', landlordId);
    if (error) throw error;

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'landlord_deleted', targetType: 'landlord', targetId: landlordId, ipAddress: req.ip });

    return res.json({ message: 'Landlord account permanently deleted.' });
  } catch (err) {
    console.error('[admin] deleteLandlordAccount error:', err.message);
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
      .select('id, full_name, estate_name, location, county, unit_limit, subscription_plan, subscription_expires_at')
      .eq('id', landlordId)
      .maybeSingle();
    if (landlordError) throw landlordError;
    if (!landlord) return res.status(404).json({ error: 'Landlord not found.' });

    const { data: properties, error: propError } = await supabase
      .from('properties')
      .select('id, name, location, county, unit_limit, subscription_period_months, subscription_expires_at, subscription_status')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: true });
    if (propError) throw propError;

    return res.json({ landlord, properties: properties || [] });
  } catch (err) {
    console.error('[admin] getLandlordProperties error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch landlord properties.' });
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
    console.error('[admin] editLandlordSubscription error:', err.message);
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
    console.error('[admin] getActivityLog error:', err.message);
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
    console.error('[admin] deleteActivityLogEntry error:', err.message);
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
    console.error('[admin] deleteActivityLogsForDay error:', err.message);
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
    console.error('[admin] emergencyLockdown error:', err.message);
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
    console.error('[admin] resumeFromLockdown error:', err.message);
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
    console.error('[admin] getLockdownStatus error:', err.message);
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
    console.error('[admin] listAllTenants error:', err.message);
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
    console.error('[admin] listAllUnits error:', err.message);
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

    const { data: payments, error } = await supabase
      .from('subscription_payments')
      .select('id, amount, paid_at, landlord_id, landlords(full_name)')
      .eq('status', 'completed')
      .gte('paid_at', startDate.toISOString())
      .order('paid_at', { ascending: false });

    if (error) throw error;

    const total = (payments || []).reduce((sum, p) => sum + Number(p.amount), 0);
    return res.json({ total, payments, period });
  } catch (err) {
    console.error('[admin] getRevenueBreakdown error:', err.message);
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
    console.error('[admin] getExpiringLandlords error:', err.message);
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
      console.error(`[admin] sendRenewalReminders: failed to notify landlord ${landlordId}:`, r.reason?.message);
      return { landlordId, sent: false, error: r.reason?.message };
    });

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'renewal_reminders_sent', metadata: { landlordIds }, ipAddress: req.ip });

    return res.json({ results });
  } catch (err) {
    console.error('[admin] sendRenewalReminders error:', err.message);
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

    const { data: payments, error } = await supabase
      .from('subscription_payments')
      .select('amount, paid_at')
      .eq('status', 'completed')
      .gte('paid_at', sixMonthsAgo.toISOString());
    if (error) throw error;

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
    console.error('[admin] getRevenueTrend error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch revenue trend.' });
  }
}

// Powers the admin "Statistics" county breakdown + growth line charts
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
    console.error('[admin] getGrowthStatistics error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch growth statistics.' });
  }
}

module.exports = {
  getDashboardMetrics,
  listAllLandlords,
  listAllScouts,
  setScoutStatus,
  listAllTenants,
  listAllUnits,
  getRevenueBreakdown,
  getRevenueTrend,
  getGrowthStatistics,
  getExpiringLandlords,
  sendRenewalReminders,
  setLandlordStatus,
  deleteLandlordAccount,
  editLandlordSubscription,
  getLandlordProperties,
  getActivityLog,
  deleteActivityLogEntry,
  deleteActivityLogsForDay,
  emergencyLockdown,
  resumeFromLockdown,
  getLockdownStatus,
};
