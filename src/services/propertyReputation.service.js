// src/services/propertyReputation.service.js
//
// Aggregate-only reputation for a PROPERTY, rated by its own current
// tenants. Mirrors landlordReputation.service.js's shape/reasoning:
// never expose a single rating tied back to an identifiable tenant -
// only the aggregate - since this can be shown on the public,
// no-login vacant-units listing page (see public.controller.js),
// while the tenant who left it may still be living there.

const supabase = require('../config/supabase');

async function getPropertyReputation(propertyId) {
  const { data: ratings, error } = await supabase
    .from('property_ratings')
    .select('rating, category')
    .eq('property_id', propertyId)
    // See sql/add-rating-flag-for-review.sql - a rating under an
    // active flag, or confirmed bad-faith ('removed'), is excluded
    // from the aggregate.
    .not('flag_status', 'in', '(flagged,removed)');
  if (error) throw error;

  if (!ratings || !ratings.length) {
    return { propertyId, totalRatings: 0, averageRating: null, byCategory: {} };
  }

  const byCategory = {};
  for (const r of ratings) {
    if (!byCategory[r.category]) byCategory[r.category] = { count: 0, sum: 0 };
    byCategory[r.category].count += 1;
    byCategory[r.category].sum += r.rating;
  }
  Object.keys(byCategory).forEach((cat) => {
    byCategory[cat].average = Number((byCategory[cat].sum / byCategory[cat].count).toFixed(2));
  });

  const overall = ratings.filter((r) => r.category === 'overall');
  const basis = overall.length ? overall : ratings;
  const averageRating = Number((basis.reduce((s, r) => s + r.rating, 0) / basis.length).toFixed(2));

  return { propertyId, totalRatings: ratings.length, averageRating, byCategory };
}

/** Bulk variant - one query for a whole listings page full of properties. */
async function getPropertyReputationsByIds(propertyIds) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (!ids.length) return {};

  const { data: ratings, error } = await supabase
    .from('property_ratings')
    .select('property_id, rating, category')
    .in('property_id', ids)
    .not('flag_status', 'in', '(flagged,removed)');
  if (error) throw error;

  const buckets = {};
  for (const id of ids) buckets[id] = { sum: 0, count: 0, overallSum: 0, overallCount: 0 };
  for (const r of ratings || []) {
    const b = buckets[r.property_id];
    if (!b) continue;
    b.sum += r.rating;
    b.count += 1;
    if (r.category === 'overall') {
      b.overallSum += r.rating;
      b.overallCount += 1;
    }
  }

  const result = {};
  for (const id of ids) {
    const b = buckets[id];
    const basisSum = b.overallCount ? b.overallSum : b.sum;
    const basisCount = b.overallCount ? b.overallCount : b.count;
    result[id] = {
      totalRatings: b.count,
      averageRating: basisCount ? Number((basisSum / basisCount).toFixed(2)) : null,
    };
  }
  return result;
}

module.exports = { getPropertyReputation, getPropertyReputationsByIds };
