// src/controllers/ratingFlag.controller.js
//
// Wires up the schema added in sql/add-rating-flag-for-review.sql - a
// landlord's recourse against a rating they believe is in bad faith
// (a coached 5-star campaign is the inverse problem, but this endpoint
// is specifically the "someone tanked my score in bad faith" side:
// the flip side - inflated ratings - isn't something a landlord would
// ever flag against themselves, so it's left to whatever future
// abuse-pattern detection the admin/growth side wants to build).
//
// Scope, per the migration comment: landlord_ratings, staff_ratings,
// property_ratings only - never tenant_ratings, since those are
// written BY the landlord about a tenant.
//
// Flow:
//   1. Landlord flags a rating with a reason -> flag_status: 'flagged'.
//      The rating is immediately excluded from the aggregate (see
//      landlordReputation/staffReputation/propertyReputation services),
//      but the row is untouched otherwise - a landlord can't unilaterally
//      erase an inconvenient rating.
//   2. Admin reviews and resolves -> 'upheld' (rating was legitimate,
//      goes back into the aggregate) or 'removed' (confirmed bad-faith,
//      stays excluded permanently).

const supabase = require('../config/supabase');
const { effectiveLandlordId } = require('../middleware/auth.middleware');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');

const FLAGGABLE_TABLES = {
  landlord_ratings: { landlordCol: 'landlord_id' },
  staff_ratings: { landlordCol: 'landlord_id' },
  property_ratings: { landlordCol: 'landlord_id' },
};

// tenant_ratings is flagged by the TENANT being rated (see
// tenant.controller.js's flagTenantRating, and migration
// 2026-07-tenant-rating-flag.sql) rather than by a landlord, so it's
// deliberately kept out of FLAGGABLE_TABLES above (that one gates
// landlord-only listMyRatings/flagRating below). It still needs to
// show up in the ADMIN worklist alongside the landlord-flagged types,
// which is what this second set is for.
const ADMIN_ONLY_FLAGGABLE_TABLES = { tenant_ratings: {} };
const ALL_RESOLVABLE_TABLES = { ...FLAGGABLE_TABLES, ...ADMIN_ONLY_FLAGGABLE_TABLES };

function assertTableAllowed(table, res) {
  if (!FLAGGABLE_TABLES[table]) {
    res.status(400).json({ error: 'That rating type cannot be flagged.' });
    return false;
  }
  return true;
}

// Columns safe to hand back to the landlord who owns the row: never
// tenant_id - the whole point of the aggregate-only exposure
// elsewhere is that a still-living-there tenant can't be singled
// out. This is the individual-row equivalent of that same rule:
// everything needed to recognize and flag a specific rating, nothing
// that identifies who left it.
const SAFE_COLUMNS = 'id, rating, category, comment, created_at, updated_at, flag_status, flag_reason, flagged_at, flag_resolved_at, flag_resolution_note';

// ---------------------------------------------------------------------
// GET /api/ratings/:table/mine
// Landlord-only. The individual-row counterpart to the aggregate-only
// reputation endpoints (getMyReputationAsLandlord etc.) - without
// this a landlord has no way to find the id of the rating they want
// to flag. Returns rating content but never who left it.
// ---------------------------------------------------------------------
async function listMyRatings(req, res) {
  try {
    const { table } = req.params;
    if (!assertTableAllowed(table, res)) return;

    const landlordId = effectiveLandlordId(req);
    let query = supabase
      .from(table)
      .select(SAFE_COLUMNS)
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false });

    // A landlord with more than one property needs these narrowed to
    // "this property" - property_ratings is the only one of the three
    // tables where that grouping applies (landlord/staff ratings are
    // one aggregate per person, not per property).
    if (table === 'property_ratings' && req.query.propertyId) {
      query = query.eq('property_id', req.query.propertyId);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ ratings: data || [] });
  } catch (err) {
    logger.error('[ratingFlag] listMyRatings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your ratings.' });
  }
}

// ---------------------------------------------------------------------
// POST /api/ratings/:table/:id/flag
// Body: { reason }  (required - an unexplained flag gives admin nothing
// to review against)
// Landlord-only; the rating must belong to the caller's own account.
// ---------------------------------------------------------------------
async function flagRating(req, res) {
  try {
    const { table, id } = req.params;
    if (!assertTableAllowed(table, res)) return;

    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please explain why you believe this rating is in bad faith.' });

    const landlordId = effectiveLandlordId(req);
    const { data: rating, error: fetchError } = await supabase
      .from(table)
      .select(table === 'property_ratings' ? 'id, landlord_id, property_id, flag_status' : 'id, landlord_id, flag_status')
      .eq('id', id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!rating) return res.status(404).json({ error: 'Rating not found.' });
    if (rating.landlord_id !== landlordId) return res.status(403).json({ error: 'This rating is not on your account.' });
    // Only property_ratings is scoped to a single apartment - landlord/
    // staff ratings are one aggregate per person across the whole
    // portfolio, so they're not gated by any one property's subscription.
    if (table === 'property_ratings') {
      if (await blockIfSubscriptionExpired(req, res, landlordId, rating.property_id)) return;
    }

    if (rating.flag_status === 'flagged') {
      return res.status(409).json({ error: 'This rating already has a pending flag.' });
    }
    if (rating.flag_status === 'removed') {
      return res.status(409).json({ error: 'This rating was already removed from your aggregate.' });
    }

    const { error: updateError } = await supabase
      .from(table)
      .update({
        flag_status: 'flagged',
        flagged_by_landlord_id: landlordId,
        flag_reason: reason,
        flagged_at: new Date().toISOString(),
        flag_resolved_at: null,
        flag_resolution_note: null,
      })
      .eq('id', id);
    if (updateError) throw updateError;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'rating_flagged', targetType: table, targetId: id, metadata: { reason } });

    return res.json({ message: 'Rating flagged for review. It is excluded from your reputation average while pending.' });
  } catch (err) {
    logger.error('[ratingFlag] flagRating error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to flag rating.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/admin/rating-flags?status=flagged
// Admin-only. Lists flags across all three tables (default: pending
// ones) so there's a single worklist instead of three.
// ---------------------------------------------------------------------
async function listFlaggedRatings(req, res) {
  try {
    const status = req.query.status || 'flagged';
    const results = [];
    for (const table of Object.keys(ALL_RESOLVABLE_TABLES)) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq('flag_status', status)
        .order('flagged_at', { ascending: true });
      if (error) throw error;
      (data || []).forEach((row) => results.push({ table, ...row }));
    }
    return res.json({ flags: results });
  } catch (err) {
    logger.error('[ratingFlag] listFlaggedRatings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load flagged ratings.' });
  }
}

// ---------------------------------------------------------------------
// PATCH /api/admin/rating-flags/:table/:id/resolve
// Body: { resolution: 'upheld' | 'removed', note? }
// Admin-only.
// ---------------------------------------------------------------------
async function resolveRatingFlag(req, res) {
  try {
    const { table, id } = req.params;
    if (!ALL_RESOLVABLE_TABLES[table]) {
      return res.status(400).json({ error: 'That rating type cannot be flagged.' });
    }

    const { resolution, note } = req.body;
    if (!['upheld', 'removed'].includes(resolution)) {
      return res.status(400).json({ error: "resolution must be 'upheld' or 'removed'." });
    }

    const { data: rating, error: fetchError } = await supabase.from(table).select('id, flag_status').eq('id', id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!rating) return res.status(404).json({ error: 'Rating not found.' });
    if (rating.flag_status !== 'flagged') {
      return res.status(409).json({ error: 'This rating does not have a pending flag.' });
    }

    const { error: updateError } = await supabase
      .from(table)
      .update({
        flag_status: resolution,
        flag_resolved_at: new Date().toISOString(),
        flag_resolution_note: (note || '').trim() || null,
      })
      .eq('id', id);
    if (updateError) throw updateError;

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'rating_flag_resolved', targetType: table, targetId: id, metadata: { resolution } });

    return res.json({ message: `Flag resolved as ${resolution}.` });
  } catch (err) {
    logger.error('[ratingFlag] resolveRatingFlag error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to resolve flag.' });
  }
}

module.exports = { listMyRatings, flagRating, listFlaggedRatings, resolveRatingFlag };
