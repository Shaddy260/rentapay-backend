// src/controllers/landlordLead.controller.js
//
// BUILD SPEC PHASE 9 - Marketing Self-Fill Landlord Link.
//
// Distinct from Phase 4 (a BA logging a claim about a landlord they
// personally onboarded): this is a public, no-login form a landlord
// fills in themselves after seeing it shared by the marketing team.
// It stays an unverified lead (landlord_leads, added in Phase 1)
// until it's separately converted or manually marked contacted - it
// deliberately never touches ba_landlord_claims or the BA
// verification loop.

const supabase = require('../config/supabase');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// PUBLIC - no auth. Basic validation only (required fields, phone
// format) - deliberately NO uniqueness/matching requirement, since
// this is intentionally a lightweight lead, not a verified claim. A
// landlord can submit more than once (e.g. a typo'd resend); each
// becomes its own 'new' row rather than being merged/rejected.
// ---------------------------------------------------------------------
async function submitLandlordLead(req, res) {
  try {
    let { fullName, phone, houseName, location } = req.body;

    if (!fullName || !phone) {
      return res.status(400).json({ error: 'fullName and phone are required.' });
    }
    fullName = String(fullName).trim();
    houseName = houseName ? String(houseName).trim() : null;
    location = location ? String(location).trim() : null;

    try {
      phone = normalizePhoneOrThrow(phone, 'Phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    const { data: lead, error } = await supabase
      .from('landlord_leads')
      .insert({
        full_name: fullName,
        phone,
        house_name: houseName,
        location,
        source: 'marketing_link',
        status: 'new',
      })
      .select('id')
      .single();
    if (error) throw error;

    return res.status(201).json({ message: "Thanks! We'll be in touch shortly.", leadId: lead.id });
  } catch (err) {
    logger.error('[landlordLead] submitLandlordLead error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit. Please try again.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN-ONLY - paginated, filterable by status/date. Same
// page/pageSize/range shape as brandAmbassador.controller.js's
// listPendingBaApplications/listBrandAmbassadors, for consistency.
// ---------------------------------------------------------------------
async function listLandlordLeads(req, res) {
  try {
    const { status, from, to } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const rangeFrom = (page - 1) * pageSize;
    const rangeTo = rangeFrom + pageSize - 1;

    let query = supabase
      .from('landlord_leads')
      .select('id, full_name, phone, house_name, location, source, status, converted_landlord_id, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(rangeFrom, rangeTo);
    if (status) query = query.eq('status', status);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error, count } = await query;
    if (error) throw error;

    return res.json({ leads: data || [], page, pageSize, total: count || 0 });
  } catch (err) {
    logger.error('[landlordLead] listLandlordLeads error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load landlord leads.' });
  }
}

// ADMIN-ONLY - manual "mark contacted" action, alongside the
// automatic conversion below. Only moves a lead forward from 'new' -
// an already-converted lead is left alone (converting is the terminal
// state; there's nothing left to "contact" once a real account
// exists).
async function markLeadContacted(req, res) {
  try {
    const { id } = req.params;

    const { data: lead, error: findErr } = await supabase
      .from('landlord_leads')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    if (lead.status === 'converted') {
      return res.status(400).json({ error: 'This lead has already converted to a real account.' });
    }

    const { error } = await supabase.from('landlord_leads').update({ status: 'contacted' }).eq('id', id);
    if (error) throw error;

    return res.json({ message: 'Marked as contacted.' });
  } catch (err) {
    logger.error('[landlordLead] markLeadContacted error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update lead.' });
  }
}

// ---------------------------------------------------------------------
// INTERNAL - called from auth.controller.js's registerLandlord, right
// after a new landlords row is successfully inserted (the point the
// spec calls "wherever landlord registration already completes
// successfully"). Looks for a landlord_leads row with a matching
// phone that's still 'new' or 'contacted' and, if found, marks it
// 'converted' with no manual step required. Best-effort/non-fatal by
// design, same as the Phase 4 referral-code lookup right next to it
// in registerLandlord - a lead-matching hiccup must never block or
// fail a landlord's own registration.
// ---------------------------------------------------------------------
async function convertMatchingLeadForPhone(phone, landlordId) {
  try {
    const { data: lead } = await supabase
      .from('landlord_leads')
      .select('id')
      .eq('phone', phone)
      .in('status', ['new', 'contacted'])
      .maybeSingle();
    if (!lead) return;

    await supabase
      .from('landlord_leads')
      .update({ status: 'converted', converted_landlord_id: landlordId })
      .eq('id', lead.id);
  } catch (err) {
    logger.warn('[landlordLead] convertMatchingLeadForPhone failed (non-fatal):', err.message);
  }
}

module.exports = {
  submitLandlordLead,
  listLandlordLeads,
  markLeadContacted,
  convertMatchingLeadForPhone,
};
