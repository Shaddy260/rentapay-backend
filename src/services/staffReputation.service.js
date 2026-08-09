// src/services/staffReputation.service.js
//
// Aggregate reputation for a property manager or caretaker, keyed by
// their property_managers.id - see 2026-07-staff-ratings.sql for why
// that id (not email/phone) is already the right portable identity
// here. Mirrors landlordReputation.service.js's shape.

const supabase = require('../config/supabase');

async function getStaffReputation(managerId) {
  const { data: ratings, error } = await supabase
    .from('staff_ratings')
    .select('rating')
    .eq('manager_id', managerId)
    // See sql/add-rating-flag-for-review.sql.
    .not('flag_status', 'in', '(flagged,removed)');
  if (error) throw error;

  if (!ratings || !ratings.length) {
    return { managerId, totalRatings: 0, averageRating: null };
  }

  const averageRating = Number((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(2));
  return { managerId, totalRatings: ratings.length, averageRating };
}

/** Bulk variant - one query for a whole dashboard table of staff. */
async function getStaffReputationsByIds(managerIds) {
  const ids = [...new Set((managerIds || []).filter(Boolean))];
  if (!ids.length) return {};

  const { data: ratings, error } = await supabase
    .from('staff_ratings')
    .select('manager_id, rating')
    .in('manager_id', ids)
    .not('flag_status', 'in', '(flagged,removed)');
  if (error) throw error;

  const buckets = {};
  for (const id of ids) buckets[id] = { sum: 0, count: 0 };
  for (const r of ratings || []) {
    buckets[r.manager_id].sum += r.rating;
    buckets[r.manager_id].count += 1;
  }

  const result = {};
  for (const id of ids) {
    const b = buckets[id];
    result[id] = { totalRatings: b.count, averageRating: b.count ? Number((b.sum / b.count).toFixed(2)) : null };
  }
  return result;
}

module.exports = { getStaffReputation, getStaffReputationsByIds };
