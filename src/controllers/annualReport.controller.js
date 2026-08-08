// src/controllers/annualReport.controller.js
//
// The existing "collection summary" PDF (see dashboard.controller.js /
// pdfReport.service.js) is a single month, optionally scoped to one
// property. Once a landlord has a full year of data, the natural next
// ask is a full-year, all-properties report - shaped either as a
// general annual summary, or KRA-filing-shaped (gross rental income
// per property, per month, for the tax year). Both reuse the same
// aggregation below so the two PDFs can never show different numbers
// for the same underlying data.
//
// NOTE ON TAX FIGURES: this deliberately reports gross rent collected
// and logged expenses only - it does NOT compute a tax owed, apply a
// tax rate, or reference a specific KRA rate/threshold, since those
// change and this app has no way to know which regime applies to a
// given landlord. The PDF says as much and points the landlord to
// confirm the actual filing figure with KRA/an accountant.

const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function computeAnnualPortfolioStatistics(req) {
  const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);
  const { propertyId } = req.query;
  const year = Number(req.query.year) || new Date().getFullYear();
  const isManager = req.user.role === 'manager';

  let assignedPropertyIds = null;
  if (isManager) {
    assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
    if (propertyId && !assignedPropertyIds.includes(propertyId)) {
      return { error: { statusCode: 403, error: 'You have not been given access to this property.' } };
    }
  }

  let propertiesQuery = supabase.from('properties').select('id, name').eq('landlord_id', landlordId);
  if (propertyId) propertiesQuery = propertiesQuery.eq('id', propertyId);
  else if (isManager) {
    if (assignedPropertyIds.length === 0) return { error: { statusCode: 200, error: null, empty: true } };
    propertiesQuery = propertiesQuery.in('id', assignedPropertyIds);
  }
  const { data: properties, error: propertiesError } = await propertiesQuery;
  if (propertiesError) throw propertiesError;

  const propertyIds = (properties || []).map((p) => p.id);
  if (propertyIds.length === 0) {
    return { data: { year, properties: [], portfolioMonthly: emptyMonthly(), portfolioTotals: { collected: 0, expected: 0, expenses: 0, net: 0 } } };
  }

  const { data: units, error: unitsError } = await supabase.from('units').select('id, property_id, rent_amount').eq('landlord_id', landlordId).in('property_id', propertyIds);
  if (unitsError) throw unitsError;
  const unitToProperty = new Map((units || []).map((u) => [u.id, u.property_id]));
  const unitById = new Map((units || []).map((u) => [u.id, u]));
  const unitIds = (units || []).map((u) => u.id);

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31T23:59:59.999Z`;

  // "Expected" rent (for the collected-vs-expected view): sum of
  // rent_override||unit.rent_amount for every month a tenant was on
  // record as occupying the unit, from move_in_date through either
  // left_at (if they've since vacated) or the end of the reporting
  // window. Includes vacated tenants whose left_at falls in/after this
  // year so a unit that turned over mid-year correctly stops counting
  // "expected" once they left, rather than either dropping them
  // entirely or counting them for the full year.
  let tenants = [];
  if (unitIds.length > 0) {
    const { data: tenantRows, error: tenantsError } = await supabase
      .from('tenants')
      .select('id, unit_id, move_in_date, left_at, rent_override, is_active')
      .in('unit_id', unitIds)
      .or(`is_active.eq.true,left_at.gte.${yearStart}`);
    if (tenantsError) throw tenantsError;
    tenants = tenantRows || [];
  }

  let payments = [];
  if (unitIds.length > 0) {
    const { data: paymentRows, error: paymentsError } = await supabase
      .from('payments')
      .select('amount, paid_at, unit_id')
      .eq('landlord_id', landlordId)
      .eq('status', 'completed')
      .in('unit_id', unitIds)
      .gte('paid_at', yearStart)
      .lte('paid_at', yearEnd);
    if (paymentsError) throw paymentsError;
    payments = paymentRows || [];
  }

  const { data: expenseRows, error: expensesError } = await supabase
    .from('expenses')
    .select('amount, date, property_id, category')
    .eq('landlord_id', landlordId)
    .in('property_id', propertyIds)
    .gte('date', yearStart)
    .lte('date', `${year}-12-31`);
  if (expensesError) throw expensesError;

  const byProperty = new Map(propertyIds.map((id) => [id, { collected: emptyMonthly(), expected: emptyMonthly(), expenses: emptyMonthly(), expensesByCategory: {} }]));

  for (const p of payments) {
    const propId = unitToProperty.get(p.unit_id);
    if (!propId || !byProperty.has(propId)) continue;
    const month = new Date(p.paid_at).getMonth();
    byProperty.get(propId).collected[month].value += Number(p.amount);
  }
  for (const e of expenseRows || []) {
    if (!byProperty.has(e.property_id)) continue;
    const month = new Date(e.date).getMonth();
    const bucket = byProperty.get(e.property_id);
    bucket.expenses[month].value += Number(e.amount);
    bucket.expensesByCategory[e.category] = (bucket.expensesByCategory[e.category] || 0) + Number(e.amount);
  }

  const now = new Date();
  const lastRelevantMonth = year === now.getFullYear() ? now.getMonth() : 11;
  for (const t of tenants) {
    const unit = unitById.get(t.unit_id);
    const propId = unit ? unit.property_id : null;
    if (!propId || !byProperty.has(propId)) continue;
    const monthlyRent = Number(t.rent_override || (unit && unit.rent_amount) || 0);
    if (!monthlyRent) continue;
    const moveIn = t.move_in_date ? new Date(t.move_in_date) : null;
    const startMonth = moveIn && moveIn.getFullYear() === year ? moveIn.getMonth() : (moveIn && moveIn < new Date(yearStart) ? 0 : null);
    if (startMonth === null) continue;
    // Cap the end month at whichever is earliest: the tenant's actual
    // move-out (left_at), the current month (for the current year, so
    // we don't project "expected" into the future), or December.
    let endMonth = lastRelevantMonth;
    if (t.left_at) {
      const leftAt = new Date(t.left_at);
      if (leftAt.getFullYear() < year) continue; // left before this year - nothing to count
      if (leftAt.getFullYear() === year) endMonth = Math.min(endMonth, leftAt.getMonth());
    }
    if (endMonth < startMonth) continue;
    const bucket = byProperty.get(propId);
    for (let m = startMonth; m <= endMonth; m++) {
      bucket.expected[m].value += monthlyRent;
    }
  }

  const portfolioMonthly = emptyMonthly();
  const result = (properties || []).map((prop) => {
    const bucket = byProperty.get(prop.id);
    const monthly = MONTH_LABELS.map((label, i) => {
      const collected = bucket.collected[i].value;
      const expected = bucket.expected[i].value;
      const expenses = bucket.expenses[i].value;
      portfolioMonthly[i].value += collected;
      portfolioMonthly[i].expected = (portfolioMonthly[i].expected || 0) + expected;
      portfolioMonthly[i].expenses = (portfolioMonthly[i].expenses || 0) + expenses;
      return { label, collected, expected, expenses, net: collected - expenses };
    });
    const totalCollected = monthly.reduce((s, m) => s + m.collected, 0);
    const totalExpected = monthly.reduce((s, m) => s + m.expected, 0);
    const totalExpenses = monthly.reduce((s, m) => s + m.expenses, 0);
    return {
      id: prop.id,
      name: prop.name,
      monthly,
      totalCollected,
      totalExpected,
      totalExpenses,
      totalNet: totalCollected - totalExpenses,
      expensesByCategory: bucket.expensesByCategory,
    };
  });

  const portfolioTotals = result.reduce(
    (acc, p) => ({
      collected: acc.collected + p.totalCollected,
      expected: acc.expected + p.totalExpected,
      expenses: acc.expenses + p.totalExpenses,
      net: acc.net + p.totalNet,
    }),
    { collected: 0, expected: 0, expenses: 0, net: 0 }
  );

  return {
    data: {
      year,
      properties: result,
      portfolioMonthly: portfolioMonthly.map((m, i) => ({
        label: MONTH_LABELS[i],
        collected: m.value,
        expected: m.expected || 0,
        expenses: m.expenses || 0,
        net: m.value - (m.expenses || 0),
      })),
      portfolioTotals,
    },
  };
}

function emptyMonthly() {
  return MONTH_LABELS.map((label) => ({ label, value: 0, expenses: 0 }));
}

async function getAnnualPortfolioPdf(req, res) {
  try {
    const result = await computeAnnualPortfolioStatistics(req);
    if (result.error) return res.status(result.error.statusCode || 500).json(result.error);

    const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);
    const { data: landlord } = await supabase.from('landlords').select('full_name').eq('id', landlordId).maybeSingle();

    const { generateAnnualPortfolioPdf } = require('../services/annualReport.service');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-annual-report-${result.data.year}.pdf"`);
    generateAnnualPortfolioPdf(res, { landlordName: landlord?.full_name || 'Landlord', generatedAt: new Date(), report: result.data });
  } catch (err) {
    logger.error('[annualReport] getAnnualPortfolioPdf error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate annual report.' });
  }
}

async function getTaxSummaryPdf(req, res) {
  try {
    const result = await computeAnnualPortfolioStatistics(req);
    if (result.error) return res.status(result.error.statusCode || 500).json(result.error);

    const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);
    const { data: landlord } = await supabase.from('landlords').select('full_name').eq('id', landlordId).maybeSingle();
    const kraPin = (req.query.kraPin || '').trim() || null;

    const { generateTaxSummaryPdf } = require('../services/annualReport.service');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-tax-summary-${result.data.year}.pdf"`);
    generateTaxSummaryPdf(res, { landlordName: landlord?.full_name || 'Landlord', kraPin, generatedAt: new Date(), report: result.data });
  } catch (err) {
    logger.error('[annualReport] getTaxSummaryPdf error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate tax summary.' });
  }
}

// CSV export ("Excel") of the same figures behind the PDF reports -
// one row per property per month, so it opens straight into Excel /
// Google Sheets / Numbers and can be dropped into a spreadsheet for a
// bank loan application or handed to an accountant at tax time.
function csvEscape(value) {
  const str = String(value === undefined || value === null ? '' : value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function buildFinancialReportCsv(report) {
  const rows = [['Property', 'Month', 'Rent Expected', 'Rent Collected', 'Expenses', 'Net Income']];
  for (const prop of report.properties) {
    for (const m of prop.monthly) {
      rows.push([prop.name, `${m.label} ${report.year}`, m.expected, m.collected, m.expenses, m.net]);
    }
    rows.push([prop.name, 'TOTAL', prop.totalExpected, prop.totalCollected, prop.totalExpenses, prop.totalNet]);
    rows.push([]);
  }
  rows.push(['All Properties (Portfolio)', 'TOTAL', report.portfolioTotals.expected, report.portfolioTotals.collected, report.portfolioTotals.expenses, report.portfolioTotals.net]);
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

async function getFinancialReportCsv(req, res) {
  try {
    const result = await computeAnnualPortfolioStatistics(req);
    if (result.error) return res.status(result.error.statusCode || 500).json(result.error);

    const csv = buildFinancialReportCsv(result.data);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-financial-report-${result.data.year}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('[annualReport] getFinancialReportCsv error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate financial report CSV.' });
  }
}

module.exports = { computeAnnualPortfolioStatistics, getAnnualPortfolioPdf, getTaxSummaryPdf, getFinancialReportCsv };
