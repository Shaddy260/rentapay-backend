// src/services/baPayoutQualificationReport.service.js
//
// Builds the snapshot behind Admin > Brand Ambassadors > "BA Regions &
// Payout Report". For every landlord a BA has onboarded
// (landlords.ba_id), determines whether that onboarding currently
// QUALIFIES the BA for a payout, groups the results by region then by
// BA, masks phone numbers, and persists the whole thing as a
// point-in-time snapshot (see
// sql/2026-08-admin-help-settings-and-ba-payout-report.sql) so it
// stays stable once shared even if the underlying qualification
// changes later.
//
// QUALIFICATION RULE: a landlord "qualifies for payment" here means
// their most recent ba_landlord_claims row (matched to this BA) has
// qualification_status 'qualified' or 'paid'. If the real
// qualification job (src/jobs/baQualification.job.js) ever encodes
// something more involved than that (commission tiers, minimum
// tenure, payout_rules overrides, etc.), swap the check below for a
// call into that job's own logic instead of re-deriving it here, so
// the two can never disagree.
//
// REGION: this project has no brand_ambassadors.region column (and no
// landlords.location column), so "region" here is the landlord's own
// county (falling back to 'Unspecified') rather than a per-BA
// assigned territory.
const supabase = require('../config/supabase');
const { maskPhoneMiddle } = require('../utils/maskPhone');

const QUALIFYING_STATUSES = ['qualified', 'paid'];

function regionOf(landlord) {
  return landlord.county || 'Unspecified';
}

async function buildAndPersistReport({ periodType = 'month', periodKey, adminId, adminName }) {
  if (!periodKey) {
    const now = new Date();
    periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const { data: landlords, error: landlordsErr } = await supabase
    .from('landlords')
    .select('id, full_name, phone, county, created_at, ba_id')
    .not('ba_id', 'is', null);
  if (landlordsErr) throw landlordsErr;

  const totals = { regionCount: 0, baCount: 0, landlordsOnboarded: 0, qualifying: 0, notQualifying: 0 };

  if (!landlords || landlords.length === 0) {
    return persistEmptyReport({ periodType, periodKey, adminId, adminName, totals });
  }

  const baIds = [...new Set(landlords.map((l) => l.ba_id))];
  const landlordIds = landlords.map((l) => l.id);

  const [{ data: bas, error: basErr }, { data: claims, error: claimsErr }] = await Promise.all([
    supabase.from('brand_ambassadors').select('id, full_name, ba_code').in('id', baIds),
    supabase
      .from('ba_landlord_claims')
      .select('ba_id, matched_landlord_id, qualification_status, created_at')
      .in('matched_landlord_id', landlordIds)
      .order('created_at', { ascending: false }),
  ]);
  if (basErr) throw basErr;
  if (claimsErr) throw claimsErr;

  const baById = new Map((bas || []).map((b) => [b.id, b]));

  // Claims are ordered newest-first above, so the first one seen per
  // (ba_id, matched_landlord_id) pair is the most recent one.
  const latestClaimByPair = new Map();
  for (const c of claims || []) {
    const key = `${c.ba_id}:${c.matched_landlord_id}`;
    if (!latestClaimByPair.has(key)) latestClaimByPair.set(key, c);
  }

  const regionsMap = new Map();
  let totalQualifying = 0;
  let totalNotQualifying = 0;

  for (const l of landlords) {
    const ba = baById.get(l.ba_id) || { id: l.ba_id, full_name: 'Unknown BA', ba_code: null };
    const claim = latestClaimByPair.get(`${l.ba_id}:${l.id}`);
    const status = claim?.qualification_status;
    const qualifies = QUALIFYING_STATUSES.includes(status);
    const reason = qualifies
      ? null
      : status
        ? `Claim status: ${status}`
        : 'No matched claim on record for this onboarding yet';

    if (qualifies) totalQualifying += 1;
    else totalNotQualifying += 1;

    const region = regionOf(l);
    if (!regionsMap.has(region)) regionsMap.set(region, new Map());
    const baMap = regionsMap.get(region);
    if (!baMap.has(ba.id)) {
      baMap.set(ba.id, { baId: ba.id, baName: ba.full_name, baCode: ba.ba_code, landlords: [] });
    }
    baMap.get(ba.id).landlords.push({
      landlordId: l.id,
      name: l.full_name,
      phone: l.phone,
      county: l.county,
      onboardedAt: l.created_at,
      qualifies,
      reason,
    });
  }

  const regions = [...regionsMap.entries()].map(([region, baMap]) => {
    const brandAmbassadors = [...baMap.values()].map((ba) => ({
      ...ba,
      landlordsOnboarded: ba.landlords.length,
      qualifying: ba.landlords.filter((l) => l.qualifies).length,
      notQualifying: ba.landlords.filter((l) => !l.qualifies).length,
    }));
    const landlordsOnboarded = brandAmbassadors.reduce((sum, b) => sum + b.landlordsOnboarded, 0);
    const qualifying = brandAmbassadors.reduce((sum, b) => sum + b.qualifying, 0);
    const notQualifying = brandAmbassadors.reduce((sum, b) => sum + b.notQualifying, 0);
    return { region, baCount: brandAmbassadors.length, landlordsOnboarded, qualifying, notQualifying, brandAmbassadors };
  });

  totals.regionCount = regions.length;
  totals.baCount = new Set(landlords.map((l) => l.ba_id)).size;
  totals.landlordsOnboarded = landlords.length;
  totals.qualifying = totalQualifying;
  totals.notQualifying = totalNotQualifying;

  // Supabase's REST API has no client-side multi-statement transaction,
  // so this is a best-effort two-step write: insert the report header,
  // then its entries, cleaning up the header if the entries insert
  // fails so a report row is never left with zero entries.
  const { data: reportRow, error: reportErr } = await supabase
    .from('ba_payout_qualification_reports')
    .insert({
      period_type: periodType,
      period_key: periodKey,
      generated_by_admin_id: adminId || null,
      generated_by_admin_name: adminName || null,
      totals_region_count: totals.regionCount,
      totals_ba_count: totals.baCount,
      totals_landlords: totals.landlordsOnboarded,
      totals_qualifying: totals.qualifying,
      totals_not_qualifying: totals.notQualifying,
    })
    .select('id, generated_at')
    .single();
  if (reportErr) throw reportErr;

  const entryRows = [];
  for (const region of regions) {
    for (const ba of region.brandAmbassadors) {
      for (const l of ba.landlords) {
        entryRows.push({
          report_id: reportRow.id,
          region: region.region,
          ba_id: ba.baId,
          ba_name: ba.baName,
          ba_code: ba.baCode || null,
          landlord_id: l.landlordId,
          landlord_name: l.name,
          landlord_phone_masked: maskPhoneMiddle(l.phone),
          county: l.county || null,
          onboarded_at: l.onboardedAt,
          qualifies: l.qualifies,
          reason: l.reason,
        });
      }
    }
  }

  const { error: entriesErr } = await supabase.from('ba_payout_qualification_report_entries').insert(entryRows);
  if (entriesErr) {
    await supabase.from('ba_payout_qualification_reports').delete().eq('id', reportRow.id);
    throw entriesErr;
  }

  return {
    id: reportRow.id,
    periodType,
    periodKey,
    generatedAt: reportRow.generated_at,
    generatedByAdminName: adminName || null,
    totals,
    regions: regions.map((r) => ({
      ...r,
      brandAmbassadors: r.brandAmbassadors.map((b) => ({
        ...b,
        landlords: b.landlords.map((l) => ({ ...l, maskedPhone: maskPhoneMiddle(l.phone), phone: undefined })),
      })),
    })),
  };
}

async function persistEmptyReport({ periodType, periodKey, adminId, adminName, totals }) {
  const { data: reportRow, error } = await supabase
    .from('ba_payout_qualification_reports')
    .insert({
      period_type: periodType,
      period_key: periodKey,
      generated_by_admin_id: adminId || null,
      generated_by_admin_name: adminName || null,
      totals_region_count: 0,
      totals_ba_count: 0,
      totals_landlords: 0,
      totals_qualifying: 0,
      totals_not_qualifying: 0,
    })
    .select('id, generated_at')
    .single();
  if (error) throw error;
  return {
    id: reportRow.id,
    periodType,
    periodKey,
    generatedAt: reportRow.generated_at,
    generatedByAdminName: adminName || null,
    totals,
    regions: [],
  };
}

async function listReports() {
  const { data, error } = await supabase
    .from('ba_payout_qualification_reports')
    .select(
      'id, period_type, period_key, generated_at, generated_by_admin_name, totals_region_count, totals_ba_count, totals_landlords, totals_qualifying, totals_not_qualifying'
    )
    .order('generated_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  return (data || []).map((r) => ({
    id: r.id,
    periodType: r.period_type,
    periodKey: r.period_key,
    generatedAt: r.generated_at,
    generatedByAdminName: r.generated_by_admin_name,
    totals: {
      regionCount: r.totals_region_count,
      baCount: r.totals_ba_count,
      landlordsOnboarded: r.totals_landlords,
      qualifying: r.totals_qualifying,
      notQualifying: r.totals_not_qualifying,
    },
  }));
}

async function getReportById(reportId) {
  const { data: r, error: reportErr } = await supabase
    .from('ba_payout_qualification_reports')
    .select('*')
    .eq('id', reportId)
    .maybeSingle();
  if (reportErr) throw reportErr;
  if (!r) return null;

  const { data: entries, error: entriesErr } = await supabase
    .from('ba_payout_qualification_report_entries')
    .select('*')
    .eq('report_id', reportId)
    .order('region', { ascending: true })
    .order('ba_name', { ascending: true })
    .order('landlord_name', { ascending: true });
  if (entriesErr) throw entriesErr;

  const regionsMap = new Map();
  for (const e of entries || []) {
    if (!regionsMap.has(e.region)) regionsMap.set(e.region, new Map());
    const baMap = regionsMap.get(e.region);
    if (!baMap.has(e.ba_id)) baMap.set(e.ba_id, { baId: e.ba_id, baName: e.ba_name, baCode: e.ba_code, landlords: [] });
    baMap.get(e.ba_id).landlords.push({
      landlordId: e.landlord_id,
      name: e.landlord_name,
      maskedPhone: e.landlord_phone_masked,
      county: e.county,
      onboardedAt: e.onboarded_at,
      qualifies: e.qualifies,
      reason: e.reason,
    });
  }

  const regions = [...regionsMap.entries()].map(([region, baMap]) => {
    const brandAmbassadors = [...baMap.values()].map((ba) => ({
      ...ba,
      landlordsOnboarded: ba.landlords.length,
      qualifying: ba.landlords.filter((l) => l.qualifies).length,
      notQualifying: ba.landlords.filter((l) => !l.qualifies).length,
    }));
    const landlordsOnboarded = brandAmbassadors.reduce((sum, b) => sum + b.landlordsOnboarded, 0);
    const qualifying = brandAmbassadors.reduce((sum, b) => sum + b.qualifying, 0);
    const notQualifying = brandAmbassadors.reduce((sum, b) => sum + b.notQualifying, 0);
    return { region, baCount: brandAmbassadors.length, landlordsOnboarded, qualifying, notQualifying, brandAmbassadors };
  });

  return {
    id: r.id,
    periodType: r.period_type,
    periodKey: r.period_key,
    generatedAt: r.generated_at,
    generatedByAdminName: r.generated_by_admin_name,
    totals: {
      regionCount: r.totals_region_count,
      baCount: r.totals_ba_count,
      landlordsOnboarded: r.totals_landlords,
      qualifying: r.totals_qualifying,
      notQualifying: r.totals_not_qualifying,
    },
    regions,
  };
}

function reportToCsv(report) {
  const lines = ['Region,Brand Ambassador,BA Code,Landlord,Phone (masked),County,Onboarded,Status,Reason'];
  for (const region of report.regions) {
    for (const ba of region.brandAmbassadors) {
      for (const l of ba.landlords) {
        const cells = [
          region.region,
          ba.baName,
          ba.baCode || '',
          l.name,
          l.maskedPhone,
          l.county || '',
          l.onboardedAt ? new Date(l.onboardedAt).toISOString() : '',
          l.qualifies ? 'QUALIFIES' : 'NOT QUALIFYING',
          l.reason || '',
        ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`);
        lines.push(cells.join(','));
      }
    }
  }
  return lines.join('\n');
}

module.exports = { buildAndPersistReport, listReports, getReportById, reportToCsv };
