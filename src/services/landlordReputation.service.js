// src/services/landlordReputation.service.js
//
// Mirror of reputation.service.js, but for tenants rating landlords.
// Deliberately exposes ONLY aggregates - never a single rating tied
// back to an identifiable tenant - so a still-living-there tenant
// can't be singled out/retaliated against for a low rating (see
// reputation notes: "aggregated so it's not a single visible review
// that exposes" them).

const supabase = require('../config/supabase');

async function getLandlordReputation(landlordId) {
  const { data: ratings, error } = await supabase
    .from('landlord_ratings')
    .select('rating, category')
    .eq('landlord_id', landlordId);
  if (error) throw error;

  if (!ratings || !ratings.length) {
    return { landlordId, totalRatings: 0, averageRating: null, byCategory: {} };
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

  return { landlordId, totalRatings: ratings.length, averageRating, byCategory };
}

module.exports = { getLandlordReputation };
