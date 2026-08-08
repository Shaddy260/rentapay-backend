// src/controllers/platformReview.controller.js
//
// DIRECT REQUEST: a way for RentaPay (the platform itself) to be
// rated and reviewed - by users with an account AND by anonymous
// visitors with no account at all. Reviews show on our own site
// (with schema.org markup so Google search results can surface a
// star rating), and submitters are pointed to also leave a review on
// our real Google Business Profile / Facebook page.
const supabase = require('../config/supabase');
const { captureException } = require('../services/sentry.service');
const { checkComment } = require('../utils/commentModeration');
const logger = require('../utils/logger');

const MAX_NAME_LENGTH = 80;
const MAX_COMMENT_LENGTH = 1000;

async function resolveSubmitterName(req) {
  if (!req.user) return null;
  try {
    if (req.user.role === 'landlord') {
      const { data } = await supabase.from('landlords').select('full_name').eq('id', req.user.id).single();
      return { name: data?.full_name, userType: 'landlord' };
    }
    if (req.user.role === 'manager') {
      const { data } = await supabase.from('property_managers').select('full_name').eq('id', req.user.id).single();
      return { name: data?.full_name, userType: 'property_manager' };
    }
    if (req.user.role === 'tenant') {
      const { data } = await supabase.from('tenants').select('full_name').eq('id', req.user.id).single();
      return { name: data?.full_name, userType: 'tenant' };
    }
  } catch (err) {
    logger.error('[platformReview] resolveSubmitterName error:', err.message);
  }
  return null;
}

/** POST /api/reviews - open to anyone, logged in or not. */
async function submitReview(req, res) {
  try {
    const ratingNum = Number(req.body.rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5 || !Number.isInteger(ratingNum)) {
      return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5.' });
    }
    const comment = (req.body.comment || '').trim().slice(0, MAX_COMMENT_LENGTH);
    if (comment && checkComment(comment).blocked) {
      return res.status(400).json({ error: 'Please remove abusive or profane language from your review.' });
    }

    let displayName = (req.body.displayName || '').trim().slice(0, MAX_NAME_LENGTH);
    let isAuthenticated = false;
    let userType = null;
    let userId = null;

    if (req.user) {
      const resolved = await resolveSubmitterName(req);
      if (resolved) {
        isAuthenticated = true;
        userType = resolved.userType;
        userId = req.user.id;
        // Logged-in users can still choose to show a different display
        // name (e.g. "A landlord in Nairobi") - only fall back to
        // their real name if they left the field blank.
        if (!displayName) displayName = resolved.name || 'RentaPay user';
      }
    }
    if (!displayName) displayName = 'Anonymous';

    const { data: review, error } = await supabase
      .from('platform_reviews')
      .insert({
        display_name: displayName,
        is_authenticated: isAuthenticated,
        user_type: userType,
        user_id: userId,
        rating: ratingNum,
        comment: comment || null,
      })
      .select()
      .single();
    if (error) throw error;

    return res.status(201).json({
      message: 'Thanks for the review!',
      review,
      // DIRECT REQUEST: nudge them to also leave it on our real
      // external listings, since that's what actually shows up when
      // someone searches for us on Google.
      externalLinks: {
        google: process.env.GOOGLE_REVIEW_URL || null,
        facebook: process.env.FACEBOOK_REVIEW_URL || null,
      },
    });
  } catch (err) {
    logger.error('[platformReview] submitReview error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to save your review. Please try again.' });
  }
}

/** GET /api/reviews - public list + aggregate, for the on-site reviews section. */
async function listReviews(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    const { data: reviews, error } = await supabase
      .from('platform_reviews')
      .select('id, display_name, is_authenticated, user_type, rating, comment, created_at')
      .eq('is_visible', true)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    // Aggregate is computed over ALL visible reviews, not just the
    // page returned above (the schema.org AggregateRating needs the
    // true total, not just what's rendered on screen).
    const { data: allRatings, error: aggError } = await supabase
      .from('platform_reviews')
      .select('rating')
      .eq('is_visible', true);
    if (aggError) throw aggError;

    const total = allRatings?.length || 0;
    const average = total ? Math.round((allRatings.reduce((sum, r) => sum + r.rating, 0) / total) * 10) / 10 : null;

    return res.json({
      reviews: reviews || [],
      aggregate: { average, total },
      externalLinks: {
        google: process.env.GOOGLE_REVIEW_URL || null,
        facebook: process.env.FACEBOOK_REVIEW_URL || null,
      },
    });
  } catch (err) {
    logger.error('[platformReview] listReviews error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load reviews.' });
  }
}

module.exports = { submitReview, listReviews };
