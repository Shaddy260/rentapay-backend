// src/services/baPayoutQualificationReport.service.js
//
// Consolidated Change Instructions - Section F ("Payout Run" admin
// view, full rewrite).
//
// Builds the snapshot behind Admin > Brand Ambassadors > "Payout Run".
// A run is generated for ONE billing cycle (periodKey = 'YYYY-MM',
// e.g. '2026-08'), selected by the admin - not a lifetime snapshot.
//
// Lists every BA, and under each, every landlord who made a completed
// payment within the selected cycle. Per BA:
//   - count of qualifying landlords with a payment this cycle
//   - count of non-qualifying landlords on their roster (visibility
//     only, no payout)
//   - the percentage rate that applied per landlord's payment (may
//     differ across landlords within the same BA if a rate changed
//     mid-cycle, or a BA override exists)
//   - per-landlord: payment amount x applicable percentage = commission
//   - BA's total owed for the run = sum of the above
//
// Source of truth: ba_commission_earnings (Section E - one row per
// completed subscription payment a qualified landlord's BA earns
// commission on, already carrying the snapshotted payment_amount /
// percentage_applied / commission_amount / billing_cycle) joined
// against landlords (for name/phone/county and the roster used for
// the non-qualifying count) and brand_ambassadors. The now-dropped
// ba_landlord_claims table is never read here.
//
// Persisted the same way as before (report header + entries), so past
// runs stay stable once generated even if rates or rosters change
// later - see sql/2026-08-section-f-payout-run.sql for the schema.
const supabase = require('../config/supabase');
const { maskPhoneMiddle } = require('../utils/maskPhone');

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function buildAndPersistReport({ periodKey, adminId, adminName }) {
  if (!periodKey || !/^\d{4}-\d{2}$/.test(periodKey)) {
    periodKey = currentMonthKey();
  }
  const periodType = 'month';

  // Every BA who has ever onboarded someone is a candidate for this
  // run's roster, even if nothing qualifies or paid this specific
  // cycle (so the not-qualifying count stays visible) - mirrors the
  // "empty run" handling below.
  const { data: rosterLandlords, error: rosterErr } = await supabase
    .from('landlords')
    .select('id, full_name, phone, county, ba_id, ba_qualification_status')
    .not('ba_id', 'is', null);
  if (rosterErr) throw rosterErr;

  const roster = rosterLandlords || [];

  if (roster.length === 0) {
    return persistEmptyReport({ periodType, periodKey, adminId, adminName });
  }

  const baIds = [...new Set(roster.map((l) => l.ba_id))];
  const landlordIds = roster.map((l) => l.id);

  const [{ data: bas, error: basErr }, { data: earnings, error: earningsErr }] = await Promise.all([
    supabase.from('brand_ambassadors').select('id, full_name, ba_code').in('id', baIds),
    supabase
      .from('ba_commission_earnings')
      .select('ba_id, landlord_id, payment_amount, percentage_applied, commission_amount, paid_at')
      .eq('billing_cycle', periodKey)
      .in('landlord_id', landlordIds),
  ]);
  if (basErr) throw basErr;
  if (earningsErr) throw earningsErr;

  const baById = new Map((bas || []).map((b) => [b.id, b]));
  // A landlord could in theory show more than one earning row in a
  // cycle only if paid twice in the same month; sum them per
  // (ba, landlord) pair rather than assuming exactly one.
  const earningsByLandlord = new Map();
  for (const e of earnings || []) {
    const key = `${e.ba_id}:${e.landlord_id}`;
    const existing = earningsByLandlord.get(key);
    if (existing) {
      existing.paymentAmount += Number(e.payment_amount || 0);
      existing.commissionAmount += Number(e.commission_amount || 0);
      // Keep the latest-paid rate/date as representative when a
      // landlord paid more than once this cycle.
      if (!existing.paidAt || new Date(e.paid_at) > new Date(existing.paidAt)) {
        existing.paidAt = e.paid_at;
        existing.percentageApplied = Number(e.percentage_applied);
      }
    } else {
      earningsByLandlord.set(key, {
        paymentAmount: Number(e.payment_amount || 0),
        percentageApplied: Number(e.percentage_applied),
        commissionAmount: Number(e.commission_amount || 0),
        paidAt: e.paid_at,
      });
    }
  }

  const baMap = new Map();
  for (const l of roster) {
    const ba = baById.get(l.ba_id) || { id: l.ba_id, full_name: 'Unknown BA', ba_code: null };
    if (!baMap.has(ba.id)) {
      baMap.set(ba.id, { baId: ba.id, baName: ba.full_name, baCode: ba.ba_code, landlords: [] });
    }

    const earning = earningsByLandlord.get(`${l.ba_id}:${l.id}`);
    const qualifiesThisCycle = l.ba_qualification_status === 'qualified' && !!earning;

    baMap.get(ba.id).landlords.push({
      landlordId: l.id,
      name: l.full_name,
      phone: l.phone,
      county: l.county,
      qualificationStatus: l.ba_qualification_status,
      qualifiesThisCycle,
      paymentAmount: earning ? earning.paymentAmount : 0,
      percentageApplied: earning ? earning.percentageApplied : null,
      commissionAmount: earning ? earning.commissionAmount : 0,
      paidAt: earning ? earning.paidAt : null,
    });
  }

  const brandAmbassadors = [...baMap.values()].map((ba) => {
    const qualifyingWithPayment = ba.landlords.filter((l) => l.qualifiesThisCycle);
    const notQualifying = ba.landlords.length - qualifyingWithPayment.length;
    const totalOwed = qualifyingWithPayment.reduce((sum, l) => sum + l.commissionAmount, 0);
    return {
      ...ba,
      totalLandlordsOnboarded: ba.landlords.length,
      qualifyingLandlordsWithPayment: qualifyingWithPayment.length,
      notQualifyingLandlords: notQualifying,
      totalOwed,
    };
  });

  const totals = brandAmbassadors.reduce(
    (acc, ba) => ({
      baCount: acc.baCount + 1,
      landlordsOnboarded: acc.landlordsOnboarded + ba.totalLandlordsOnboarded,
      qualifying: acc.qualifying + ba.qualifyingLandlordsWithPayment,
      notQualifying: acc.notQualifying + ba.notQualifyingLandlords,
      amountOwed: acc.amountOwed + ba.totalOwed,
    }),
    { baCount: 0, landlordsOnboarded: 0, qualifying: 0, notQualifying: 0, amountOwed: 0 }
  );

  const { data: reportRow, error: reportErr } = await supabase
    .from('ba_payout_qualification_reports')
    .insert({
      period_type: periodType,
      period_key: periodKey,
      generated_by_admin_id: adminId || null,
      generated_by_admin_name: adminName || null,
      totals_region_count: 0,
      totals_ba_count: totals.baCount,
      totals_landlords: totals.landlordsOnboarded,
      totals_qualifying: totals.qualifying,
      totals_not_qualifying: totals.notQualifying,
      totals_amount_owed: totals.amountOwed,
    })
    .select('id, generated_at')
    .single();
  if (reportErr) throw reportErr;

  const entryRows = [];
  for (const ba of brandAmbassadors) {
    for (const l of ba.landlords) {
      entryRows.push({
        report_id: reportRow.id,
        region: l.county || null,
        ba_id: ba.baId,
        ba_name: ba.baName,
        ba_code: ba.baCode || null,
        landlord_id: l.landlordId,
        landlord_name: l.name,
        landlord_phone_masked: maskPhoneMiddle(l.phone),
        county: l.county || null,
        onboarded_at: null,
        qualifies: l.qualifiesThisCycle,
        reason: l.qualifiesThisCycle
          ? null
          : l.qualificationStatus !== 'qualified'
            ? 'Not yet qualified'
            : 'No completed payment in this cycle',
        payment_amount: l.paymentAmount,
        percentage_applied: l.percentageApplied,
        commission_amount: l.commissionAmount,
        paid_at: l.paidAt,
      });
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
    brandAmbassadors: brandAmbassadors.map((ba) => ({
      baId: ba.baId,
      baName: ba.baName,
      baCode: ba.baCode,
      totalLandlordsOnboarded: ba.totalLandlordsOnboarded,
      qualifyingLandlordsWithPayment: ba.qualifyingLandlordsWithPayment,
      notQualifyingLandlords: ba.notQualifyingLandlords,
      totalOwed: ba.totalOwed,
      landlords: ba.landlords.map((l) => ({ ...l, maskedPhone: maskPhoneMiddle(l.phone), phone: undefined })),
    })),
  };
}

async function persistEmptyReport({ periodType, periodKey, adminId, adminName }) {
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
      totals_amount_owed: 0,
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
    totals: { baCount: 0, landlordsOnboarded: 0, qualifying: 0, notQualifying: 0, amountOwed: 0 },
    brandAmbassadors: [],
  };
}

async function listReports() {
  const { data, error } = await supabase
    .from('ba_payout_qualification_reports')
    .select(
      'id, period_type, period_key, generated_at, generated_by_admin_name, totals_ba_count, totals_landlords, totals_qualifying, totals_not_qualifying, totals_amount_owed'
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
      baCount: r.totals_ba_count,
      landlordsOnboarded: r.totals_landlords,
      qualifying: r.totals_qualifying,
      notQualifying: r.totals_not_qualifying,
      amountOwed: Number(r.totals_amount_owed || 0),
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
    .order('ba_name', { ascending: true })
    .order('landlord_name', { ascending: true });
  if (entriesErr) throw entriesErr;

  const baMap = new Map();
  for (const e of entries || []) {
    if (!baMap.has(e.ba_id)) baMap.set(e.ba_id, { baId: e.ba_id, baName: e.ba_name, baCode: e.ba_code, landlords: [] });
    baMap.get(e.ba_id).landlords.push({
      landlordId: e.landlord_id,
      name: e.landlord_name,
      maskedPhone: e.landlord_phone_masked,
      county: e.county,
      qualifiesThisCycle: e.qualifies,
      reason: e.reason,
      paymentAmount: Number(e.payment_amount || 0),
      percentageApplied: e.percentage_applied != null ? Number(e.percentage_applied) : null,
      commissionAmount: Number(e.commission_amount || 0),
      paidAt: e.paid_at,
    });
  }

  const brandAmbassadors = [...baMap.values()].map((ba) => {
    const qualifyingWithPayment = ba.landlords.filter((l) => l.qualifiesThisCycle);
    return {
      ...ba,
      totalLandlordsOnboarded: ba.landlords.length,
      qualifyingLandlordsWithPayment: qualifyingWithPayment.length,
      notQualifyingLandlords: ba.landlords.length - qualifyingWithPayment.length,
      totalOwed: qualifyingWithPayment.reduce((sum, l) => sum + l.commissionAmount, 0),
    };
  });

  return {
    id: r.id,
    periodType: r.period_type,
    periodKey: r.period_key,
    generatedAt: r.generated_at,
    generatedByAdminName: r.generated_by_admin_name,
    totals: {
      baCount: r.totals_ba_count,
      landlordsOnboarded: r.totals_landlords,
      qualifying: r.totals_qualifying,
      notQualifying: r.totals_not_qualifying,
      amountOwed: Number(r.totals_amount_owed || 0),
    },
    brandAmbassadors,
  };
}

function reportToCsv(report) {
  const lines = ['Brand Ambassador,BA Code,Landlord,Phone (masked),County,Rate Applied,Payment Amount (KES),Commission (KES),Status,Reason'];
  for (const ba of report.brandAmbassadors) {
    for (const l of ba.landlords) {
      const cells = [
        ba.baName,
        ba.baCode || '',
        l.name,
        l.maskedPhone,
        l.county || '',
        l.percentageApplied != null ? `${l.percentageApplied}%` : '',
        l.paymentAmount.toFixed(2),
        l.commissionAmount.toFixed(2),
        l.qualifiesThisCycle ? 'PAID OUT' : 'NOT QUALIFYING',
        l.reason || '',
      ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`);
      lines.push(cells.join(','));
    }
  }
  lines.push('');
  lines.push(`"Grand total",,,,,,${report.totals.amountOwed.toFixed(2)},,`);
  return lines.join('\n');
}

module.exports = { buildAndPersistReport, listReports, getReportById, reportToCsv };
