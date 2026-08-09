// src/controllers/public.controller.js
//
// FEATURE (direct request): a fully open, free, no-login public
// listings page. Anyone can browse vacant units by county,
// constituency, or location with zero auth. Uses the same "only ever
// show status = 'vacant'" hard-lock pattern used elsewhere, for the
// same reason: this is a public, unauthenticated surface, so the
// occupancy status filter has to be enforced server-side, not left to
// the frontend to apply correctly.
//
// Contact is WhatsApp-only and resolved server-side per unit:
// property manager first, then caretaker, then the landlord
// themself - the raw number is never included in the bulk listings
// payload, only handed out (as a ready-to-open wa.me link) via the
// dedicated /contact endpoint when someone actually taps "Contact on
// WhatsApp" on a specific unit.
const supabase = require('../config/supabase');
const jwt = require('jsonwebtoken');
const { getPropertyReputationsByIds } = require('../services/propertyReputation.service');
const reputationService = require('../services/reputation.service');
const { receiptNumber } = require('../services/pdfReport.service');
const { getPublicKey } = require('../services/webpush.service');
const {
  saveVacancyAlertSubscription,
  removeVacancyAlertSubscription,
} = require('../services/vacancyAlertPush.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

function toWhatsAppLink(number, unitName) {
  if (!number) return null;
  const digits = number.replace(/[^\d]/g, '');
  const text = encodeURIComponent(`Hi, I'm interested in the vacant unit "${unitName}" I saw on RentaPay.`);
  return `https://wa.me/${digits}?text=${text}`;
}

// ---------------------------------------------------------------------
// GET /api/public/listings?county=&constituency=&location=&type=
// No auth. Vacant units only, hard-filtered server-side.
// ---------------------------------------------------------------------
async function listVacantUnits(req, res) {
  try {
    const { county, constituency, location, type, q } = req.query;

    let query = supabase
      .from('units')
      .select(
        'id, unit_name, unit_type, rent_amount, photo_urls, property_id, landlord_id, ' +
          'listing_status, requires_deposit, deposit_amount_expected, ' +
          'properties(name, county, constituency, location, maps_link, description)'
      )
      .eq('status', 'vacant')
      // DIRECT REQUEST: landlords/managers can opt a unit out of the
      // public listings page (see add-unit-public-listing-toggle.sql).
      // Enforced here, server-side, same "never trust the frontend to
      // apply it" reasoning as the status='vacant' filter above - this
      // is a public, unauthenticated endpoint.
      .eq('is_publicly_listed', true)
      .order('created_at', { ascending: false })
      .limit(300);

    if (type) query = query.eq('unit_type', type);

    const { data, error } = await query;
    if (error) throw error;

    let units = data || [];
    // county/constituency/location live on `properties`, not `units`
    // directly (units with no property_id are ungrouped and have no
    // location at all - excluded from a location-filtered search,
    // since there's nothing to match against).
    if (county) units = units.filter((u) => u.properties?.county?.toLowerCase() === county.toLowerCase());
    if (constituency) units = units.filter((u) => u.properties?.constituency?.toLowerCase() === constituency.toLowerCase());
    if (location) units = units.filter((u) => u.properties?.location?.toLowerCase().includes(location.toLowerCase()));

    // FEATURE (direct request): a single search box that narrows the
    // moment the tenant types anything - matches partial text against
    // county, constituency, location/estate name, or unit name/type,
    // whichever field it happens to match. Replaces having to fill in
    // county -> constituency -> location and press "Search" before
    // anything narrows down.
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      units = units.filter((u) => {
        const haystacks = [
          u.properties?.county,
          u.properties?.constituency,
          u.properties?.location,
          u.properties?.name,
          u.unit_name,
          u.unit_type,
          u.properties?.description,
        ];
        return haystacks.some((h) => h && h.toLowerCase().includes(needle));
      });
    }

    // FEATURE (direct request): property reputation - rated by CURRENT
    // TENANTS of a property - is the only reputation ever shown on this
    // public, no-login page. Landlord/manager/caretaker reputations
    // stay portal-only and are never queried or returned here.
    const propertyIds = [...new Set(units.map((u) => u.property_id).filter(Boolean))];
    const propertyReputations = await getPropertyReputationsByIds(propertyIds);

    const listings = units.map((u) => ({
      unitId: u.id,
      unitName: u.unit_name,
      unitType: u.unit_type,
      rentAmount: u.rent_amount,
      photoUrls: u.photo_urls || [],
      propertyId: u.property_id || null,
      estateName: u.properties?.name || null,
      county: u.properties?.county || null,
      constituency: u.properties?.constituency || null,
      location: u.properties?.location || null,
      // FEATURE (direct request): a Google Maps link the landlord
      // pasted in when setting up the property (via Maps' own Share
      // option) - lets a prospective tenant open the exact location
      // directly, rather than just reading a text address. Null for
      // ungrouped units (no property_id) or properties where it was
      // never filled in - the public card falls back to plain text
      // location in that case.
      mapsLink: u.properties?.maps_link || null,
      // DIRECT REQUEST: landlord's own confirmation of whether this
      // vacancy is still open ('active'), already spoken for
      // ('booked'), or earmarked ('planned'). Purely informational -
      // the unit still only appears here at all while status='vacant'.
      listingStatus: u.listing_status || 'active',
      // DIRECT REQUEST: show whether this unit requires a deposit,
      // depending on how the landlord set it, so a prospective tenant
      // knows before reaching out.
      requiresDeposit: !!u.requires_deposit,
      depositAmountExpected: u.requires_deposit ? (u.deposit_amount_expected ?? null) : null,
      // DIRECT REQUEST: per-unit listing descriptions were removed -
      // every unit under a property now shows that property's single
      // general description (set once, in Settings) instead of each
      // unit needing its own separately-written text. Fed into the
      // public card and the schema.org Product description below.
      listingDescription: u.properties?.description || null,
      // DIRECT REQUEST: property reputation, reviewed by tenants who
      // already live in this property - aggregate only, never a
      // single review tied to an identifiable tenant.
      propertyReputation: u.property_id ? propertyReputations[u.property_id] || { totalRatings: 0, averageRating: null } : null,
    }));

    return res.json({ listings });
  } catch (err) {
    logger.error('[public] listVacantUnits error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load listings.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/listings/counties
// Distinct county/constituency values actually in use right now, so
// the search page's dropdowns only ever show places with real
// vacancies instead of a static list of all 47 counties.
// ---------------------------------------------------------------------
async function listSearchableAreas(req, res) {
  try {
    const { data, error } = await supabase
      .from('units')
      .select('properties(county, constituency)')
      .eq('status', 'vacant')
      .eq('is_publicly_listed', true);
    if (error) throw error;

    const counties = new Map(); // county -> Set(constituencies)
    for (const u of data || []) {
      const county = u.properties?.county;
      if (!county) continue;
      if (!counties.has(county)) counties.set(county, new Set());
      if (u.properties?.constituency) counties.get(county).add(u.properties.constituency);
    }

    const areas = Array.from(counties.entries())
      .map(([county, constituencies]) => ({ county, constituencies: Array.from(constituencies).sort() }))
      .sort((a, b) => a.county.localeCompare(b.county));

    return res.json({ areas });
  } catch (err) {
    logger.error('[public] listSearchableAreas error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load areas.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/listings/:unitId/contact
//
// DIRECT REQUEST FIX ("it only sends to the landlord... there should
// be a way such that when one taps contact on WhatsApp, they can
// choose to contact either manager or caretaker or landlord"): this
// used to silently pick ONE number (manager, else caretaker, else
// landlord) and hand back a single link with no way to choose. Now
// returns every distinct number that's actually available, each
// labeled by role, so the frontend can offer a picker - a unit with
// only a landlord number still just gets the one option, same as
// before, but nothing is ever hidden when more than one contact
// exists. Never returns a raw number, only ready-to-open wa.me links.
// ---------------------------------------------------------------------
async function getUnitContact(req, res) {
  try {
    const { unitId } = req.params;

    const { data: unit, error: unitErr } = await supabase
      .from('units')
      .select('id, unit_name, status, is_publicly_listed, property_id, landlord_id, properties(caretaker_phone)')
      .eq('id', unitId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    // Same opt-out respected here as in listVacantUnits/listSearchableAreas
    // above - someone guessing/bookmarking a unitId directly shouldn't be
    // able to reach the contact link for a unit its owner took private.
    if (!unit || unit.status !== 'vacant' || !unit.is_publicly_listed) {
      return res.status(404).json({ error: 'This unit is no longer available.' });
    }

    const options = [];
    const seenDigits = new Set();

    function addOption(role, label, number) {
      if (!number) return;
      const link = toWhatsAppLink(number, unit.unit_name);
      if (!link) return;
      const digits = number.replace(/[^\d]/g, '');
      if (seenDigits.has(digits)) return; // same number already offered under another role
      seenDigits.add(digits);
      options.push({ role, label, whatsappLink: link });
    }

    if (unit.property_id) {
      const { data: managers, error: mErr } = await supabase
        .from('property_managers')
        .select('id, whatsapp_number, role_level, created_at, property_manager_assignments(property_id)')
        .eq('landlord_id', unit.landlord_id)
        .eq('is_active', true);
      if (mErr) throw mErr;

      // A manager/caretaker with no assignment rows covers every
      // property for that landlord (same convention already used in
      // propertyManager.controller.js's updateManager peer-edit check).
      const coversThisProperty = (m) =>
        !m.property_manager_assignments?.length || m.property_manager_assignments.some((a) => a.property_id === unit.property_id);

      const pickBest = (roleLevel) =>
        (managers || [])
          .filter((m) => m.role_level === roleLevel && m.whatsapp_number && coversThisProperty(m))
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];

      addOption('manager', 'Property Manager', pickBest('manager')?.whatsapp_number);
      addOption('caretaker', 'Caretaker', pickBest('caretaker')?.whatsapp_number || unit.properties?.caretaker_phone);
    } else {
      addOption('caretaker', 'Caretaker', unit.properties?.caretaker_phone);
    }

    const { data: landlord } = await supabase.from('landlords').select('whatsapp_number').eq('id', unit.landlord_id).maybeSingle();
    addOption('landlord', 'Landlord', landlord?.whatsapp_number);

    if (options.length === 0) return res.status(404).json({ error: 'No contact number is available for this unit yet.' });

    return res.json({ options });
  } catch (err) {
    logger.error('[public] getUnitContact error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to resolve contact details.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/receipts/:paymentId/verify
//
// FIX (spec item 2.1): the QR code printed on every payment receipt
// (see pdfReport.service.js) already pointed at FRONTEND_URL +
// "/verify/:paymentId" - the frontend just never had a route or a
// backing endpoint for it, so scanning it fell through the app's
// catch-all route straight to the login page. No auth here (that's
// the whole point of a QR someone can scan off a printed receipt) -
// deliberately returns only what's needed to confirm the receipt is
// real: no tenant contact info, no landlord contact info, nothing an
// unrelated person scanning a lost/photographed receipt could misuse.
// ---------------------------------------------------------------------
async function verifyReceipt(req, res) {
  try {
    const { paymentId } = req.params;

    const { data: payment, error } = await supabase
      .from('payments')
      .select('id, amount, paid_at, rent_period, payment_method, status, tenants(full_name), units(unit_name, properties(name))')
      .eq('id', paymentId)
      .maybeSingle();
    if (error) throw error;

    if (!payment || payment.status !== 'completed') {
      return res.status(404).json({ error: 'No verified receipt matches this code.' });
    }

    return res.json({
      valid: true,
      receiptNumber: receiptNumber(payment.id),
      amount: payment.amount,
      paidAt: payment.paid_at,
      rentPeriod: payment.rent_period || null,
      paymentMethod: payment.payment_method,
      tenantName: payment.tenants?.full_name || null,
      unitName: payment.units?.unit_name || null,
      propertyName: payment.units?.properties?.name || null,
    });
  } catch (err) {
    logger.error('[public] verifyReceipt error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify receipt.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/reputation/:token
//
// FEATURE (direct request #4): resolves a tenant's opt-in shareable
// reputation link (see tenant.controller.js's getMyReputationShareLink)
// into a compact, comment-free summary - score + landlord/manager/
// caretaker breakdown only. No auth required, since the whole point is
// a landlord who hasn't logged in as anything can open it from a
// WhatsApp message. Never returns raw ratings/comments or which
// landlords left them - only the tenant themselves sees that level of
// detail, in their own portal.
// ---------------------------------------------------------------------
async function getSharedReputation(req, res) {
  try {
    const { token } = req.params;
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(410).json({ error: 'This reputation link is invalid or has expired.' });
    }
    if (decoded.purpose !== 'reputation_share' || !decoded.tenantEmail) {
      return res.status(400).json({ error: 'This link is not a valid reputation share link.' });
    }

    const reputation = await reputationService.getReputationByEmail(decoded.tenantEmail);

    return res.json({
      tenantName: decoded.tenantName || 'This tenant',
      reputation: {
        totalRatings: reputation?.totalRatings || 0,
        averageRating: reputation?.averageRating ?? null,
        byCategory: reputation?.byCategory || {},
        byRole: reputation?.byRole || {},
        priorLandlordCount: reputation?.priorLandlordCount || 0,
      },
    });
  } catch (err) {
    logger.error('[public] getSharedReputation error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load reputation.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/reputation-by-email?email=
//
// FIX (spec item 9.2): backs the new optional email field on the
// vacant-listing "message the landlord" form, replacing the old
// copy/paste share-link box. Given an email, tells the frontend
// whether it belongs to a registered tenant and, if so, hands back a
// ready-to-use reputation share link (the exact same token shape
// tenant.controller.js's getMyReputationShareLink issues) - never the
// tenant's raw email itself, so the frontend only ever has a link to
// attach to the WhatsApp message, matching the "never send the raw
// email address" requirement in the spec. No auth - this runs from
// the public listings page, before the visitor is a logged-in anyone.
// ---------------------------------------------------------------------
async function getReputationShareLinkByEmail(req, res) {
  try {
    const { email } = req.query;
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.json({ found: false });
    }

    const normalizedEmail = reputationService.normalizeEmail(email.trim());

    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('id, full_name, email')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (error) throw error;

    if (!tenant) return res.json({ found: false });

    const token = jwt.sign(
      { purpose: 'reputation_share', tenantEmail: normalizedEmail, tenantName: tenant.full_name },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );
    const frontendUrl = process.env.FRONTEND_URL || 'https://rentapay.co.ke';

    return res.json({ found: true, shareUrl: `${frontendUrl}/reputation/${token}` });
  } catch (err) {
    logger.error('[public] getReputationShareLinkByEmail error:', err.message);
    captureException(err);
    // Fails soft - a lookup problem shouldn't block the tenant's message.
    return res.json({ found: false });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/vacancy-alerts/toast?county=
//
// DIRECT REQUEST: powers the in-page "a unit just went vacant near
// you" toast shown to anonymous visitors. Deliberately tiny and
// read-only - one recent, publicly-listed vacant unit, matching the
// visitor's (auto-detected or manually picked) county if we have one,
// otherwise just the single most recent vacancy platform-wide. The
// frontend falls back to a generic promotional message on its own
// when this returns nothing (e.g. no vacancies at all yet, or none
// in that county) - that fallback needs no backend round-trip.
// ---------------------------------------------------------------------
async function getToastVacancy(req, res) {
  try {
    const { county } = req.query;

    const query = supabase
      .from('units')
      .select('id, unit_name, properties(county)')
      .eq('status', 'vacant')
      .eq('is_publicly_listed', true)
      .order('created_at', { ascending: false })
      .limit(25);

    const { data, error } = await query;
    if (error) throw error;

    let units = data || [];
    const matched = county ? units.filter((u) => u.properties?.county?.toLowerCase() === county.toLowerCase()) : [];
    // No match in-county (or no county known yet) - fall back to any
    // recent vacancy so the toast still has something real to show
    // rather than defaulting straight to generic promo copy.
    const pool = matched.length ? matched : units;
    if (pool.length === 0) return res.json({ vacancy: null });

    const pick = pool[Math.floor(Math.random() * Math.min(pool.length, 5))];
    return res.json({
      vacancy: {
        unitId: pick.id,
        unitName: pick.unit_name,
        county: pick.properties?.county || null,
      },
    });
  } catch (err) {
    logger.error('[public] getToastVacancy error:', err.message);
    captureException(err);
    // Non-critical decorative feature - fail quiet, not loud.
    return res.json({ vacancy: null });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/vacancy-alerts/vapid-public-key
// POST /api/public/vacancy-alerts/subscribe
// POST /api/public/vacancy-alerts/unsubscribe
//
// DIRECT REQUEST: real browser push notifications for vacancies,
// available to ANY visitor - logged in or not. No auth on any of
// these, unlike push.controller.js's /push/subscribe which requires a
// logged-in landlord/manager/tenant. See vacancyAlertPush.service.js
// for the sending side and vacancy_alert_subscriptions for the table.
// ---------------------------------------------------------------------
function getVacancyAlertVapidPublicKey(req, res) {
  const publicKey = getPublicKey();
  if (!publicKey) return res.status(503).json({ error: 'Push notifications are temporarily unavailable.' });
  return res.json({ publicKey });
}

async function subscribeVacancyAlerts(req, res) {
  try {
    const { subscription, county } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription is required.' });

    await saveVacancyAlertSubscription(subscription, county);
    return res.status(201).json({ message: 'Subscribed to vacancy alerts.' });
  } catch (err) {
    logger.error('[public] subscribeVacancyAlerts error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to save subscription.' });
  }
}

async function unsubscribeVacancyAlerts(req, res) {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required.' });

    await removeVacancyAlertSubscription(endpoint);
    return res.json({ message: 'Unsubscribed.' });
  } catch (err) {
    logger.error('[public] unsubscribeVacancyAlerts error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to remove subscription.' });
  }
}

module.exports = {
  listVacantUnits,
  listSearchableAreas,
  getUnitContact,
  verifyReceipt,
  getSharedReputation,
  getReputationShareLinkByEmail,
  getToastVacancy,
  getVacancyAlertVapidPublicKey,
  subscribeVacancyAlerts,
  unsubscribeVacancyAlerts,
};
