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
    .select('id, rating, category, comment, created_at, landlord_id, flag_status, rater_role, landlords(full_name)')
    .eq('tenant_email', normalized)
    // A rating under an active flag, or one an admin has confirmed as
    // bad-faith ('removed'), doesn't count toward the average - same
    // exclusion rule as landlordReputation.service.js, just on the
    // other side of the relationship. 'upheld' (flag reviewed, found
    // legitimate) counts normally again.
    .order('created_at', { ascending: false });

  if (error) throw error;
  if (!ratings || !ratings.length) {
    return { tenantEmail: normalized, totalRatings: 0, averageRating: null, byCategory: {}, byRole: {}, priorLandlordCount: 0, ratings: [] };
  }

  const countedRatings = ratings.filter((r) => !['flagged', 'removed'].includes(r.flag_status));

  const byCategory = {};
  for (const r of countedRatings) {
    if (!byCategory[r.category]) byCategory[r.category] = { count: 0, sum: 0 };
    byCategory[r.category].count += 1;
    byCategory[r.category].sum += r.rating;
  }
  Object.keys(byCategory).forEach((cat) => {
    byCategory[cat].average = Number((byCategory[cat].sum / byCategory[cat].count).toFixed(2));
  });

  // Direct request: tenant details should show "Landlord ratings" /
  // "Manager ratings" / "Caretaker ratings" as separate breakdowns,
  // not just one blended average - rater_role (added in
  // 2026-07-tenant-rating-rater-role.sql) is what makes this possible.
  const byRole = { landlord: { count: 0, sum: 0 }, manager: { count: 0, sum: 0 }, caretaker: { count: 0, sum: 0 } };
  for (const r of countedRatings) {
    const role = byRole[r.rater_role] ? r.rater_role : 'landlord';
    byRole[role].count += 1;
    byRole[role].sum += r.rating;
  }
  Object.keys(byRole).forEach((role) => {
    byRole[role].average = byRole[role].count ? Number((byRole[role].sum / byRole[role].count).toFixed(2)) : null;
  });

  const overallRatings = countedRatings.filter((r) => r.category === 'overall');
  const basisForAverage = overallRatings.length ? overallRatings : countedRatings;
  const averageRating = basisForAverage.length
    ? Number((basisForAverage.reduce((s, r) => s + r.rating, 0) / basisForAverage.length).toFixed(2))
    : null;

  const distinctLandlords = new Set(countedRatings.map((r) => r.landlord_id));

  return {
    tenantEmail: normalized,
    totalRatings: countedRatings.length,
    averageRating,
    byCategory,
    byRole,
    priorLandlordCount: distinctLandlords.size,
    // Comments shown are landlord-authored feedback, not raw private
    // ledger data - deliberately excludes exact amounts/dates from
    // the "distilled score, not raw history" principle in the notes.
    // Unlike landlord_ratings/staff_ratings, tenant_ratings HAS always
    // been fine to show individually attributed - see migration
    // 2026-07-tenant-rating-flag.sql - so `id`/`flagStatus` are
    // included here too, letting the tenant-facing UI flag a specific
    // one rather than only ever seeing the aggregate.
    ratings: ratings.map((r) => ({
      id: r.id,
      rating: r.rating,
      category: r.category,
      comment: r.comment,
      raterRole: r.rater_role,
      createdAt: r.created_at,
      landlordName: r.landlords?.full_name || 'A previous landlord',
      flagStatus: r.flag_status,
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
