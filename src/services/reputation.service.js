// src/services/reputation.service.js
//
// Portable, email-keyed tenant reputation - built on top of
// tenant_ratings (landlords rating tenants). "Portable" means the
// aggregate is computed from EVERY rating ever left for that email
// address, across every landlord the tenant has ever had, not just
// the current one - this is what makes it follow the tenant wherever
// they go next (see rentapay-notes: email is the durable identity
// thread, not phone, since numbers get recycled).

const supabase = require('../config/supabase');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Aggregate reputation for a single tenant, keyed by email.
 * Returns null if the email has no ratings yet (new to the platform).
 */
async function getReputationByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const { data: ratings, error } = await supabase
    .from('tenant_ratings')
    .select('rating, category, comment, created_at, landlord_id, landlords(full_name)')
    .eq('tenant_email', normalized)
    .order('created_at', { ascending: false });

  if (error) throw error;
  if (!ratings || !ratings.length) {
    return { tenantEmail: normalized, totalRatings: 0, averageRating: null, byCategory: {}, priorLandlordCount: 0, ratings: [] };
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

  const overallRatings = ratings.filter((r) => r.category === 'overall');
  const basisForAverage = overallRatings.length ? overallRatings : ratings;
  const averageRating = Number((basisForAverage.reduce((s, r) => s + r.rating, 0) / basisForAverage.length).toFixed(2));

  const distinctLandlords = new Set(ratings.map((r) => r.landlord_id));

  return {
    tenantEmail: normalized,
    totalRatings: ratings.length,
    averageRating,
    byCategory,
    priorLandlordCount: distinctLandlords.size,
    // Comments shown are landlord-authored feedback, not raw private
    // ledger data - deliberately excludes exact amounts/dates from
    // the "distilled score, not raw history" principle in the notes.
    ratings: ratings.map((r) => ({
      rating: r.rating,
      category: r.category,
      comment: r.comment,
      createdAt: r.created_at,
      landlordName: r.landlords?.full_name || 'A previous landlord',
    })),
  };
}

/**
 * Bulk variant for dashboard tables - one query per unique email
 * batched efficiently instead of N sequential calls.
 */
async function getReputationsByEmails(emails) {
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (!normalized.length) return {};

  const { data: ratings, error } = await supabase
    .from('tenant_ratings')
    .select('tenant_email, rating, category, landlord_id')
    .in('tenant_email', normalized);

  if (error) throw error;

  const grouped = {};
  for (const email of normalized) grouped[email] = { totalRatings: 0, averageRating: null, priorLandlordCount: 0 };

  const buckets = {};
  for (const r of ratings || []) {
    if (!buckets[r.tenant_email]) buckets[r.tenant_email] = { sum: 0, count: 0, overallSum: 0, overallCount: 0, landlords: new Set() };
    const b = buckets[r.tenant_email];
    b.sum += r.rating;
    b.count += 1;
    b.landlords.add(r.landlord_id);
    if (r.category === 'overall') {
      b.overallSum += r.rating;
      b.overallCount += 1;
    }
  }

  Object.entries(buckets).forEach(([email, b]) => {
    const avgBasisSum = b.overallCount ? b.overallSum : b.sum;
    const avgBasisCount = b.overallCount ? b.overallCount : b.count;
    grouped[email] = {
      totalRatings: b.count,
      averageRating: avgBasisCount ? Number((avgBasisSum / avgBasisCount).toFixed(2)) : null,
      priorLandlordCount: b.landlords.size,
    };
  });

  return grouped;
}

module.exports = { normalizeEmail, getReputationByEmail, getReputationsByEmails };
