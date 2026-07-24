// src/controllers/dashboard.controller.js
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
//
// Implements blueprint section 11 (Landlord Dashboard overview panel):
// total units, paid this month, overdue, notices, vacancies, expected
// revenue, and the subscription countdown.

const supabase = require('../config/supabase');
const { reconcileLandlordUnitLimits } = require('../utils/unitLimitEnforcement');
const { daysOverdue } = require('../utils/overdue');
const scoutReferralService = require('../services/scoutReferral.service');

async function getLandlordDashboard(req, res) {
  try {
    const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);
    const { propertyId } = req.query; // optional - property switcher scopes the whole dashboard to one property
    const isManager = req.user.role === 'manager';

    // PERFORMANCE FIX (direct request: "dashboards take so long to
    // load"): this self-heal only matters for the rare case of a raw
    // Supabase edit - blocking every single dashboard load on it added
    // real, constant latency for the 99.9% of loads where there's
    // nothing to fix. Firing it in the background means THIS load may
    // occasionally show one-refresh-stale frozen/unfrozen state right
    // after a raw edit, but every load is fast, and the next reload is
    // always fully correct.
    reconcileLandlordUnitLimits(landlordId).catch(() => {});

    // FIX ("giving a manager/caretaker access to just ONE property left
    // them unable to see anything, while 'all properties' worked"): a
    // manager must only ever be scoped to properties they're actually
    // assigned to. Previously nothing here checked assignments at all,
    // so the frontend's own "pick the first property" fallback (see
    // Dashboard.jsx) could land a manager on a property they have no
    // assignment to at all, and an explicit propertyId from the
    // switcher was never validated either.
    let assignedPropertyIds = null; // null = not a manager, no restriction
    if (isManager) {
      assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (propertyId && propertyId !== 'unassigned' && !assignedPropertyIds.includes(propertyId)) {
        return res.status(403).json({
          error: 'You have not been given access to this property. Contact the landlord if you believe this is a mistake.',
          notAssigned: true,
        });
      }
    }

    let unitsQuery = supabase.from('units').select('*').eq('landlord_id', landlordId);
    if (propertyId === 'unassigned') unitsQuery = unitsQuery.is('property_id', null);
    else if (propertyId) unitsQuery = unitsQuery.eq('property_id', propertyId);
    else if (isManager) {
      // No specific property requested - scope to exactly what this
      // manager can access, instead of the landlord's entire portfolio.
      if (assignedPropertyIds.length === 0) unitsQuery = unitsQuery.eq('id', '00000000-0000-0000-0000-000000000000'); // no assignments yet - show nothing rather than everything
      else unitsQuery = unitsQuery.in('property_id', assignedPropertyIds);
    }

    // All of this landlord's properties, so the frontend can render a
    // "switch property" menu. Landlords with a single (or zero) property
    // just won't show the switcher - see Dashboard.jsx. A manager only
    // ever sees the properties they've actually been assigned to here -
    // showing every property in the landlord's portfolio and only
    // blocking access after the fact was what caused the "single
    // property access is broken" bug in the first place.
    let propertiesQuery = supabase
      .from('properties')
      .select('id, name, location, county, manager_name, manager_phone, unit_limit, subscription_period_months, subscription_expires_at, subscription_status')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: true });
    if (isManager) {
      propertiesQuery = assignedPropertyIds.length
        ? propertiesQuery.in('id', assignedPropertyIds)
        : propertiesQuery.eq('id', '00000000-0000-0000-0000-000000000000');
    }

    // PERFORMANCE FIX (direct request: "at most 3 seconds to load
    // dashboards"): units, properties, and the landlord's own record
    // don't depend on each other at all - they used to be fetched one
    // after another regardless, so the response waited on three full
    // network round-trips stacked in a row for no reason. Firing them
    // together cuts that down to however long the SLOWEST of the
    // three takes, not the sum of all three.
    const [unitsResult, propertiesResult, landlordResult] = await Promise.all([
      unitsQuery,
      propertiesQuery,
      supabase
        .from('landlords')
        .select('full_name, photo_url, gender, subscription_plan, subscription_status, subscription_expires_at, unit_limit, onboarding_dismissed_at')
        .eq('id', landlordId)
        .single(),
    ]);

    const { data: units, error: unitsError } = unitsResult;
    if (unitsError) throw unitsError;
    const { data: properties } = propertiesResult;
    const { data: landlord, error: landlordError } = landlordResult;
    if (landlordError) throw landlordError;

    const unitIdsForTenants = units.map((u) => u.id);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Same idea: tenants and this-month's payments both only depend on
    // the unit list just fetched above, not on each other - fired
    // together instead of one after the other.
    const [tenantsResult, paymentsResult] = await Promise.all([
      unitIdsForTenants.length > 0
        ? supabase.from('tenants').select('*').eq('landlord_id', landlordId).eq('is_active', true).in('unit_id', unitIdsForTenants)
        : Promise.resolve({ data: [] }),
      unitIdsForTenants.length > 0
        ? supabase.from('payments').select('amount').eq('landlord_id', landlordId).eq('status', 'completed').in('unit_id', unitIdsForTenants).gte('paid_at', startOfMonth.toISOString())
        : Promise.resolve({ data: [] }),
    ]);
    if (tenantsResult.error) throw tenantsResult.error;
    const tenants = tenantsResult.data || [];
    const paymentsThisMonth = paymentsResult.data || [];

    // THE FIX ("a manager/caretaker's portal showed the LANDLORD's own
    // name and profile picture in the header, never their own"): the
    // dashboard used to only ever return the landlord's identity,
    // which is right for a landlord viewing their own dashboard but
    // wrong for a manager/caretaker viewing it - they should see
    // themselves. `viewerName`/`viewerPhotoUrl` reflect whoever is
    // actually logged in; `landlordName`/`landlordPhotoUrl` are kept
    // as-is (still used elsewhere, e.g. tenant-facing contact info)
    // for backwards compatibility.
    let viewerName = landlord.full_name;
    let viewerPhotoUrl = landlord.photo_url;
    let viewerRoleLevel;
    // Drives the "Landlord/Landlady", "Manager/Manageress"-style label
    // shown under the RentaPay wordmark - the viewer's OWN gender, not
    // the landlord's, once a manager/caretaker is looking at their own
    // dashboard (see viewerName/viewerPhotoUrl above for the same
    // "show the actual logged-in person" reasoning).
    let viewerGender = landlord.gender || null;
    if (isManager) {
      const { data: manager } = await supabase
        .from('property_managers')
        .select('full_name, photo_url, role_level, gender')
        .eq('id', req.user.id)
        .maybeSingle();
      if (manager) {
        viewerName = manager.full_name;
        viewerPhotoUrl = manager.photo_url;
        viewerRoleLevel = manager.role_level;
        viewerGender = manager.gender || null;
      }
    }

    const totalPaidThisMonth = paymentsThisMonth.reduce((sum, p) => sum + Number(p.amount), 0);

    const unitsByStatus = {
      occupied: units.filter((u) => u.status === 'occupied').length,
      notice_given: units.filter((u) => u.status === 'notice_given').length,
      vacant: units.filter((u) => u.status === 'vacant').length,
      maintenance: units.filter((u) => u.status === 'maintenance').length,
    };

    // THE FIX: expected revenue used to sum every unit's rent
    // regardless of status, including vacant and under-maintenance
    // units with no tenant who could possibly pay that rent. Only
    // 'occupied' (and 'notice_given' - still occupied, still owes rent
    // until they actually move out) units have someone paying rent
    // against them.
    const expectedRevenue = units
      .filter((u) => u.status === 'occupied' || u.status === 'notice_given')
      .reduce((sum, u) => sum + Number(u.rent_amount), 0);

    let overdueCount = 0;
    let overdueTotal = 0;
    const today = new Date();

    for (const tenant of tenants) {
      const unit = units.find((u) => u.id === tenant.unit_id);
      if (!unit) continue;
      const dueDay = tenant.due_day_of_month || unit.due_day_of_month;
      const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);

      // tenant.balance_due already includes any accrued interest (the
      // nightly billing job folds it in directly) - no more adding it
      // again here, which used to double-count.
      if (today > dueDate && Number(tenant.balance_due) > 0) {
        overdueCount += 1;
        overdueTotal += Number(tenant.balance_due);
      }
    }

    // FIX (direct request): "each apartment he shifts to should show
    // their own subscription period" - once a property has its own
    // unit_limit/expiry (every property bought after
    // add-per-property-subscriptions.sql), the dashboard shows THAT
    // property's own countdown and unit count instead of the
    // landlord's shared one. A property still on the legacy pooled
    // clock (unit_limit is null - never independently purchased/
    // renewed) keeps falling back to the landlord-wide fields exactly
    // as before, so nothing changes for a landlord with a single
    // original property.
    const activeProperty = (properties || []).find((p) => p.id === propertyId);
    const usesOwnClock = !!(activeProperty && activeProperty.unit_limit != null);
    const effectiveUnitLimit = usesOwnClock ? activeProperty.unit_limit : landlord.unit_limit;
    const effectiveExpiresAt = usesOwnClock ? activeProperty.subscription_expires_at : landlord.subscription_expires_at;
    const effectiveStatus = usesOwnClock ? activeProperty.subscription_status : landlord.subscription_status;

    const effectivePeriodMonths = usesOwnClock ? activeProperty.subscription_period_months : landlord.subscription_period_months;

    let daysLeft = null;
    if (effectiveExpiresAt) {
      const diffMs = new Date(effectiveExpiresAt).getTime() - Date.now();
      daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }

    return res.json({
      landlordName: landlord.full_name,
      landlordPhotoUrl: landlord.photo_url,
      onboardingDismissedAt: landlord.onboarding_dismissed_at,
      viewerName,
      viewerPhotoUrl,
      viewerRoleLevel,
      viewerGender,
      properties: properties || [],
      activePropertyId: propertyId || (isManager && assignedPropertyIds.length ? assignedPropertyIds[0] : null),
      totalUnits: units.length,
      // FIX ("I set unit_limit to 6 but the dashboard still shows 37
      // units"): freezing a unit (see unitLimitEnforcement.js) never
      // deletes the row - it's meant to still exist "in the
      // background" so it can unlock again on renewal - but that made
      // the raw row count misleading once some units are frozen. The
      // frontend now shows `activeUnits` (usable count) as the
      // headline number, with `frozenUnits` available to show
      // alongside it so a landlord can see both "what I can use right
      // now" and "what's locked pending a bigger plan" at a glance.
      activeUnits: units.filter((u) => !u.is_frozen).length,
      frozenUnits: units.filter((u) => u.is_frozen).length,
      unitLimit: effectiveUnitLimit,
      paidThisMonth: { count: (paymentsThisMonth || []).length, total: totalPaidThisMonth },
      overdue: { count: overdueCount, total: Math.round(overdueTotal * 100) / 100 },
      noticeGiven: unitsByStatus.notice_given,
      vacant: unitsByStatus.vacant,
      maintenance: unitsByStatus.maintenance,
      occupied: unitsByStatus.occupied,
      expectedRevenue,
      subscription: {
        plan: landlord.subscription_plan,
        status: effectiveStatus,
        expiresAt: effectiveExpiresAt,
        daysLeft,
        // HARDENING/FIX: the frontend used to always divide daysLeft
        // by 365 to fill the progress bar, so a 1-month plan barely
        // moved the bar even right after paying. periodMonths lets it
        // compute the fraction against the ACTUAL plan length bought
        // (1 month = full bar right after payment, empties out over
        // that same 1 month) instead of pretending every plan is a
        // year long.
        periodMonths: effectivePeriodMonths || 1,
        unitLimit: effectiveUnitLimit,
        // Tells the frontend this is a specific property's OWN
        // subscription (so the renewal popup should call the
        // per-property renew endpoint, not the account-wide one) and
        // which one, so "renew" always targets the right clock even
        // after switching apartments mid-popup.
        scopedToPropertyId: usesOwnClock ? activeProperty.id : null,
      },
    });
  } catch (err) {
    console.error('[dashboard] getLandlordDashboard error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch dashboard data.' });
  }
}

// Drill-down for the landlord dashboard's "Paid this month" card.
async function getPaymentsThisMonth(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId } = req.query;
    const isManager = req.user.role === 'manager';
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    let assignedPropertyIds = null;
    if (isManager) {
      assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (propertyId && propertyId !== 'unassigned' && !assignedPropertyIds.includes(propertyId)) {
        return res.status(403).json({ error: 'You have not been given access to this property.', notAssigned: true });
      }
    }

    // FIX ("who paid this month" list shows tenants from a different
    // apartment too): this used to fetch every payment under the
    // landlord with no regard for which property/unit it belonged to.
    // Now it's scoped to exactly the units in the property currently
    // being viewed, matching the dashboard summary card it's a
    // drill-down of. A manager with no explicit propertyId is further
    // scoped to only the properties they're assigned to.
    let unitIds = null;
    if (propertyId) {
      let unitsQuery = supabase.from('units').select('id').eq('landlord_id', landlordId);
      unitsQuery = propertyId === 'unassigned' ? unitsQuery.is('property_id', null) : unitsQuery.eq('property_id', propertyId);
      const { data: unitsInProperty, error: unitsErr } = await unitsQuery;
      if (unitsErr) throw unitsErr;
      unitIds = (unitsInProperty || []).map((u) => u.id);
      if (unitIds.length === 0) return res.json({ payments: [] });
    } else if (isManager) {
      if (assignedPropertyIds.length === 0) return res.json({ payments: [] });
      const { data: unitsInProperty, error: unitsErr } = await supabase
        .from('units').select('id').eq('landlord_id', landlordId).in('property_id', assignedPropertyIds);
      if (unitsErr) throw unitsErr;
      unitIds = (unitsInProperty || []).map((u) => u.id);
      if (unitIds.length === 0) return res.json({ payments: [] });
    }

    let query = supabase
      .from('payments')
      .select(
        'id, amount, paid_at, payment_method, ' +
          'tenants(id, full_name, primary_phone, secondary_phone, email, photo_url, emergency_contact_name, emergency_contact_phone), ' +
          'units(unit_name)'
      )
      .eq('landlord_id', landlordId)
      .eq('status', 'completed')
      .gte('paid_at', startOfMonth.toISOString())
      .order('paid_at', { ascending: false });

    if (unitIds) query = query.in('unit_id', unitIds);

    const { data: payments, error } = await query;

    if (error) throw error;
    return res.json({ payments });
  } catch (err) {
    console.error('[dashboard] getPaymentsThisMonth error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch payments.' });
  }
}

module.exports = { getLandlordDashboard, getPaymentsThisMonth, getLandlordStatistics, getLandlordStatisticsPdf, getAttentionFeed, getDueDatesCalendar, globalSearch };

// Direct request: "no global search - with units, tenants, payments,
// and managers all as separate pages, there's no 'type a name/phone
// and jump straight to that tenant.'" Scoped exactly like every other
// endpoint here (assignedPropertyIds for a manager). Searches tenants
// by name/phone and units by name - the two things someone actually
// types into a search box looking for a specific person or place, not
// a full-text index of every field in the app.
async function globalSearch(req, res) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ tenants: [], units: [] });
    }
    const term = q.trim();

    const landlordId = effectiveLandlordId(req);
    const isManager = req.user.role === 'manager';
    const assignedPropertyIds = isManager ? await getManagerAssignedPropertyIds(req.user.id) : [];
    if (isManager && assignedPropertyIds.length === 0) {
      return res.json({ tenants: [], units: [] });
    }

    let tenantsQuery = supabase
      .from('tenants')
      .select('id, full_name, primary_phone, balance_due, units!inner(id, unit_name, property_id)')
      .eq('landlord_id', landlordId)
      .eq('is_active', true)
      .or(`full_name.ilike.%${term}%,primary_phone.ilike.%${term}%`)
      .limit(8);
    if (isManager) tenantsQuery = tenantsQuery.in('units.property_id', assignedPropertyIds);

    let unitsQuery = supabase
      .from('units')
      .select('id, unit_name, property_id, status')
      .eq('landlord_id', landlordId)
      .ilike('unit_name', `%${term}%`)
      .limit(8);
    if (isManager) unitsQuery = unitsQuery.in('property_id', assignedPropertyIds);

    const [tenantsRes, unitsRes] = await Promise.all([tenantsQuery, unitsQuery]);

    return res.json({
      tenants: (tenantsRes.data || []).map((t) => ({ id: t.id, name: t.full_name, phone: t.primary_phone, balanceDue: Number(t.balance_due), unitId: t.units.id, unitName: t.units.unit_name })),
      units: (unitsRes.data || []).map((u) => ({ id: u.id, name: u.unit_name, status: u.status })),
    });
  } catch (err) {
    console.error('[dashboard] globalSearch error:', err.message);
    return res.status(500).json({ error: 'Search failed.' });
  }
}

// Direct request: "a calendar/timeline view of rent due dates - what's
// due this week across all my units, instead of unit-hopping to check
// each one." No new schema needed - every unit/tenant already has a
// due_day_of_month and a balance_due; this just projects that onto
// the current calendar month for every active tenant in one response,
// including tenants who've already paid (so the landlord can see the
// whole month's shape, not just who's currently owing).
async function getDueDatesCalendar(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const isManager = req.user.role === 'manager';
    const assignedPropertyIds = isManager ? await getManagerAssignedPropertyIds(req.user.id) : [];
    if (isManager && assignedPropertyIds.length === 0) {
      return res.json({ dueDates: [] });
    }

    let query = supabase
      .from('tenants')
      .select('id, full_name, balance_due, due_day_of_month, units!inner(id, unit_name, property_id, due_day_of_month, rent_amount)')
      .eq('landlord_id', landlordId)
      .eq('is_active', true);
    if (isManager) query = query.in('units.property_id', assignedPropertyIds);

    const { data: tenants, error } = await query;
    if (error) throw error;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueDates = (tenants || [])
      .map((t) => {
        const dueDay = t.due_day_of_month || t.units.due_day_of_month;
        if (!dueDay) return null;
        const dueDate = new Date(today.getFullYear(), today.getMonth(), Math.min(dueDay, 28));
        return {
          tenantId: t.id,
          tenantName: t.full_name,
          unitId: t.units.id,
          unitName: t.units.unit_name,
          dueDate: dueDate.toISOString().slice(0, 10),
          dueDay,
          amountDue: Number(t.balance_due),
          isPaid: Number(t.balance_due) <= 0,
          isPast: dueDate < today,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.dueDay - b.dueDay);

    return res.json({ dueDates, month: today.toISOString().slice(0, 7) });
  } catch (err) {
    console.error('[dashboard] getDueDatesCalendar error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch due dates.' });
  }
}

// Direct request: "a single 'attention needed' feed on the dashboard
// - overdue rent, unconfirmed payment submissions, expiring
// subscriptions, unresolved help tickets - one list instead of
// making the landlord check 4 separate tabs." Each of these was
// already computed somewhere in the app on its own (overdue count in
// this file, pending confirmations in pendingPaymentConfirmation.
// controller.js, expiry in subscription.controller.js, tickets in
// help.controller.js) - this endpoint doesn't invent any new
// business logic, it just asks the same four questions in parallel
// and hands back one merged, ready-to-render list.
async function getAttentionFeed(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const isManager = req.user.role === 'manager';
    const assignedPropertyIds = isManager ? await getManagerAssignedPropertyIds(req.user.id) : [];
    const scopedToNoProperties = isManager && assignedPropertyIds.length === 0;

    const [tenantsRes, pendingRes, landlordRes, helpRes, maintenanceRes, referralsRes] = await Promise.all([
      scopedToNoProperties
        ? Promise.resolve({ data: [] })
        : (() => {
            let q = supabase
              .from('tenants')
              .select('id, full_name, balance_due, units!inner(id, unit_name, property_id, due_day_of_month)')
              .eq('landlord_id', landlordId)
              .eq('is_active', true)
              .gt('balance_due', 0);
            if (isManager) q = q.in('units.property_id', assignedPropertyIds);
            return q;
          })(),
      scopedToNoProperties
        ? Promise.resolve({ data: [] })
        : (() => {
            let q = supabase
              .from('pending_payment_confirmations')
              .select('id, amount_paid, mpesa_payer_name, submitted_at, property_id')
              .eq('landlord_id', landlordId)
              .eq('status', 'pending')
              .is('duplicate_of', null);
            if (isManager) q = q.in('property_id', assignedPropertyIds);
            return q;
          })(),
      supabase.from('landlords').select('subscription_status, subscription_expires_at').eq('id', landlordId).single(),
      supabase.from('help_requests').select('id, subject, created_at').eq('requester_id', req.user.id).is('resolved_at', null),
      scopedToNoProperties
        ? Promise.resolve({ data: [] })
        : (() => {
            let q = supabase
              .from('maintenance_requests')
              .select('id, title, status, units(unit_name)')
              .eq('landlord_id', landlordId)
              .in('status', ['open', 'in_progress']);
            if (isManager) q = q.in('property_id', assignedPropertyIds);
            return q;
          })(),
      // Scout referrals (spec §4): last 7 days, not yet placed - a
      // referral that's already been credited as a placement is
      // "done," not something that still needs the landlord's
      // attention. Joins unit_id -> property_id in JS below (same
      // reason as the manager-scoping comment on maintenanceRes: this
      // table has no property_id column of its own to filter on
      // directly in the query).
      scopedToNoProperties
        ? Promise.resolve({ data: [] })
        : supabase
            .from('scout_referrals')
            .select('id, status, shared_at, units(id, unit_name, property_id), scouts(full_name)')
            .eq('landlord_id', landlordId)
            .neq('status', 'placed')
            .gt('shared_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const overdueTenants = (tenantsRes.data || [])
      .filter((t) => t.units?.due_day_of_month != null)
      .map((t) => {
        const dueDate = new Date(today.getFullYear(), today.getMonth(), t.units.due_day_of_month);
        if (dueDate > today) dueDate.setMonth(dueDate.getMonth() - 1);
        return { tenantId: t.id, tenantName: t.full_name, unitId: t.units.id, unitName: t.units.unit_name, amountDue: Number(t.balance_due), daysOverdue: daysOverdue(dueDate, today) };
      })
      .filter((t) => t.daysOverdue > 0)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    let subscriptionExpiring = null;
    const landlord = landlordRes.data;
    if (landlord?.subscription_expires_at) {
      const diffDays = Math.ceil((new Date(landlord.subscription_expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (landlord.subscription_status === 'expired' || diffDays <= 7) {
        subscriptionExpiring = { status: landlord.subscription_status, daysLeft: diffDays };
      }
    }

    // Same visual/data shape as overdueTenants above: a short human
    // line, a timestamp to derive "2 hours ago" from client-side, and
    // a unitId to make the item clickable. Scoped to this manager's
    // assigned properties same as maintenanceRes/pendingRes (units
    // with no property_id, i.e. ungrouped, are left visible to every
    // manager on the account, same convention as the rest of this file).
    const scoutReferrals = (referralsRes.data || [])
      .filter((r) => !isManager || !r.units?.property_id || assignedPropertyIds.includes(r.units.property_id))
      .map((r) => ({
        id: r.id,
        unitId: r.units?.id || null,
        unitName: r.units?.unit_name || null,
        scoutName: r.scouts?.full_name || 'A scout',
        status: r.status,
        sharedAt: r.shared_at,
        text: `Scout ${r.scouts?.full_name || ''} referred a tenant for Unit ${r.units?.unit_name || '?'}`.trim(),
      }))
      .sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));

    return res.json({
      overdueTenants,
      pendingConfirmations: pendingRes.data || [],
      subscriptionExpiring,
      unresolvedHelpTickets: helpRes.data || [],
      openMaintenanceRequests: maintenanceRes.data || [],
      scoutReferrals,
    });
  } catch (err) {
    console.error('[dashboard] getAttentionFeed error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch attention feed.' });
  }
}

// ---------------------------------------------------------------------
// LANDLORD STATISTICS (new: "Financial Statistics" menu item requested
// for the landlord/manager portal) - late vs on-time payment counts and
// rate, occupancy breakdown, and a 6-month collected-rent trend. Built
// from data already in the units/tenants/payments tables, so no schema
// change was needed.
//
// "On time" vs "late" is derived per completed payment by comparing the
// day-of-month it was paid against the unit's (or tenant override's)
// due_day_of_month - there's no stored due-date snapshot per payment,
// so this is the best available approximation, consistent with how
// "overdue" is calculated everywhere else in the app.
// ---------------------------------------------------------------------
// Shared aggregation behind both GET /dashboard/statistics (JSON, for
// the in-app Financial Statistics tab) and GET /dashboard/statistics/pdf
// (same numbers, rendered as a downloadable PDF) - see
// pdfReport.service.js and getLandlordStatisticsPdf below. Pulled out
// on its own so the PDF endpoint can't drift from what the dashboard
// actually shows.
//
// Returns either { error: { statusCode, error, notAssigned? } } or
// { data } where data is exactly the shape getLandlordStatistics used
// to return directly as JSON, now also carrying expense/profit figures
// (added alongside the expense-tracking feature: a PDF titled
// "collection summary" showing collections with no expenses isn't a
// profit report, so the same trend window used for collections is
// reused here for expenses too).
async function computeLandlordStatistics(req) {
  const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);
  const { propertyId } = req.query;
  const isManager = req.user.role === 'manager';

  let assignedPropertyIds = null;
  if (isManager) {
    assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
    if (propertyId && propertyId !== 'unassigned' && !assignedPropertyIds.includes(propertyId)) {
      return { error: { statusCode: 403, error: 'You have not been given access to this property.', notAssigned: true } };
    }
  }

  let unitsQuery = supabase.from('units').select('*').eq('landlord_id', landlordId);
  if (propertyId === 'unassigned') unitsQuery = unitsQuery.is('property_id', null);
  else if (propertyId) unitsQuery = unitsQuery.eq('property_id', propertyId);
  else if (isManager) {
    unitsQuery = assignedPropertyIds.length
      ? unitsQuery.in('property_id', assignedPropertyIds)
      : unitsQuery.eq('id', '00000000-0000-0000-0000-000000000000');
  }
  const { data: units, error: unitsError } = await unitsQuery;
  if (unitsError) throw unitsError;

  const unitIds = units.map((u) => u.id);
  const dueDayByUnit = new Map(units.map((u) => [u.id, u.due_day_of_month]));

  const totalUnits = units.length;
  const occupied = units.filter((u) => u.status === 'occupied').length;
  const vacant = units.filter((u) => u.status === 'vacant').length;
  const maintenance = units.filter((u) => u.status === 'maintenance').length;
  const noticeGiven = units.filter((u) => u.status === 'notice_given').length;
  const occupancyRate = totalUnits > 0 ? Math.round(((occupied + noticeGiven) / totalUnits) * 1000) / 10 : 0;

  let tenants = [];
  if (unitIds.length > 0) {
    const { data: tenantRows } = await supabase
      .from('tenants')
      .select('id, unit_id, balance_due, due_day_of_month')
      .eq('landlord_id', landlordId)
      .eq('is_active', true)
      .in('unit_id', unitIds);
    tenants = tenantRows || [];
  }

  const today = new Date();
  let overdueCount = 0;
  for (const tenant of tenants) {
    const dueDay = tenant.due_day_of_month || dueDayByUnit.get(tenant.unit_id);
    if (!dueDay) continue;
    const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
    if (today > dueDate && Number(tenant.balance_due) > 0) overdueCount += 1;
  }

  // Last 6 months of completed payments, for the trend chart and the
  // on-time/late split.
  const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 5, 1);
  let payments = [];
  if (unitIds.length > 0) {
    const { data: paymentRows } = await supabase
      .from('payments')
      .select('amount, paid_at, unit_id, status')
      .eq('landlord_id', landlordId)
      .eq('status', 'completed')
      .in('unit_id', unitIds)
      .gte('paid_at', sixMonthsAgo.toISOString());
    payments = paymentRows || [];
  }

  const monthly = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    monthly.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-GB', { month: 'short' }), value: 0 });
  }

  let onTimeCount = 0;
  let lateCount = 0;
  for (const p of payments) {
    if (!p.paid_at) continue;
    const paidDate = new Date(p.paid_at);
    const key = `${paidDate.getFullYear()}-${paidDate.getMonth()}`;
    const bucket = monthly.find((m) => m.key === key);
    if (bucket) bucket.value += Number(p.amount);

    const dueDay = dueDayByUnit.get(p.unit_id);
    if (dueDay) {
      if (paidDate.getDate() <= dueDay) onTimeCount += 1;
      else lateCount += 1;
    }
  }
  const totalTrackedPayments = onTimeCount + lateCount;
  const onTimeRate = totalTrackedPayments > 0 ? Math.round((onTimeCount / totalTrackedPayments) * 1000) / 10 : null;

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const collectedThisMonth = payments
    .filter((p) => new Date(p.paid_at) >= startOfMonth)
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const expectedThisMonth = units
    .filter((u) => u.status === 'occupied' || u.status === 'notice_given')
    .reduce((sum, u) => sum + Number(u.rent_amount || 0), 0);
  const collectionRate = expectedThisMonth > 0 ? Math.round((collectedThisMonth / expectedThisMonth) * 1000) / 10 : null;

  // Expenses covering the same 6-month window, scoped the same way as
  // units/payments above (by property, or by every property a manager
  // is assigned to).
  let expensePropertyIds = null; // null = don't filter by property list at all
  if (propertyId && propertyId !== 'unassigned') expensePropertyIds = [propertyId];
  else if (isManager) expensePropertyIds = assignedPropertyIds.length ? assignedPropertyIds : [];

  let expenseRows = [];
  if (!expensePropertyIds || expensePropertyIds.length > 0) {
    let expensesQuery = supabase
      .from('expenses')
      .select('amount, date, property_id')
      .eq('landlord_id', landlordId)
      .gte('date', sixMonthsAgo.toISOString().slice(0, 10));
    if (expensePropertyIds) expensesQuery = expensesQuery.in('property_id', expensePropertyIds);
    const { data: expenseData } = await expensesQuery;
    expenseRows = expenseData || [];
  }

  const monthlyExpenses = monthly.map((m) => ({ key: m.key, label: m.label, value: 0 }));
  for (const e of expenseRows) {
    const d = new Date(e.date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = monthlyExpenses.find((m) => m.key === key);
    if (bucket) bucket.value += Number(e.amount);
  }
  const expensesThisMonth = expenseRows
    .filter((e) => new Date(e.date) >= startOfMonth)
    .reduce((sum, e) => sum + Number(e.amount), 0);
  const netProfitThisMonth = collectedThisMonth - expensesThisMonth;

  return {
    data: {
      units: { total: totalUnits, occupied, vacant, maintenance, noticeGiven, occupancyRate },
      payments: {
        onTimeCount,
        lateCount,
        onTimeRate, // percentage, or null if not enough data yet
        overdueNow: overdueCount,
        collectedThisMonth,
        expectedThisMonth,
        collectionRate,
      },
      expenses: {
        expensesThisMonth,
        netProfitThisMonth,
      },
      monthlyCollected: monthly,
      monthlyExpenses,
    },
  };
}

async function getLandlordStatistics(req, res) {
  try {
    const result = await computeLandlordStatistics(req);
    if (result.error) return res.status(result.error.statusCode).json(result.error);
    return res.json(result.data);
  } catch (err) {
    console.error('[dashboard] getLandlordStatistics error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
}

// PDF version of the same statistics - the "monthly collection
// summary" report. Reuses computeLandlordStatistics so the numbers in
// the PDF can never drift from what the Financial Statistics tab
// shows on screen.
async function getLandlordStatisticsPdf(req, res) {
  try {
    const result = await computeLandlordStatistics(req);
    if (result.error) return res.status(result.error.statusCode).json(result.error);

    const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);
    const { propertyId } = req.query;

    const [{ data: landlord }, propertyResult] = await Promise.all([
      supabase.from('landlords').select('full_name').eq('id', landlordId).maybeSingle(),
      propertyId && propertyId !== 'unassigned'
        ? supabase.from('properties').select('name').eq('id', propertyId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const { generateCollectionSummaryPdf } = require('../services/pdfReport.service');
    const propertyName = propertyResult.data?.name || (propertyId === 'unassigned' ? 'Ungrouped units' : 'All properties');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-collection-summary-${new Date().toISOString().slice(0, 10)}.pdf"`);

    generateCollectionSummaryPdf(res, {
      landlordName: landlord?.full_name || 'Landlord',
      propertyName,
      generatedAt: new Date(),
      stats: result.data,
    });
  } catch (err) {
    console.error('[dashboard] getLandlordStatisticsPdf error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF report.' });
  }
}
