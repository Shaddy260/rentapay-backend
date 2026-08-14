// src/services/baPayoutQualificationReportPdf.service.js
//
// Consolidated Change Instructions - Section F/G groundwork: per-BA
// colored PDF export, plus a combined payout PDF, for the "Payout
// Run" report (see baPayoutQualificationReport.service.js, which
// builds/persists the report this reads from - getReportById()'s
// flat brandAmbassadors -> landlords shape, the same shape
// reportToCsv() flattens).
//
// Qualifying-and-paid-this-cycle rows render GREEN, everything else
// (not yet qualified, or qualified but no payment this cycle) renders
// ORANGE, per the spec's color-coding. Each landlord row now also
// shows the rate applied and the resulting commission, since the
// report carries real KES amounts (Section F) rather than a bare
// qualifies/doesn't-qualify count.
const PDFDocument = require('pdfkit');

const GREEN = '#2e7d32';
const ORANGE = '#e65100';
const INK = '#1a1a1a';
const MUTED = '#888';
const RULE = '#e0e0e0';

const PAGE_LEFT = 50;
const PAGE_RIGHT = 545;
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT;

function fmtKes(amount) {
  return `KES ${Number(amount || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function periodLabelOf(report) {
  return `Cycle ${report.periodKey}`;
}

function drawHeader(doc, { subtitle, periodLabel, generatedAt }) {
  doc.fontSize(20).fillColor(INK).text('RentaPay', { continued: true }).fillColor(GREEN).text(' — BA Payout Run');
  doc.moveDown(0.2);
  doc.fontSize(11).fillColor('#555').text(subtitle);
  doc.fontSize(9).fillColor(MUTED).text(`Period: ${periodLabel} · Generated ${generatedAt.toLocaleString('en-GB')}`);
  doc.moveDown(0.8);
  doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.7);
}

function drawLegend(doc) {
  const y = doc.y;
  doc.rect(PAGE_LEFT, y + 2, 10, 10).fillColor(GREEN).fill();
  doc.fillColor('#333').fontSize(8.5).text('Qualifies + paid this cycle', PAGE_LEFT + 15, y + 2);
  doc.rect(PAGE_LEFT + 190, y + 2, 10, 10).fillColor(ORANGE).fill();
  doc.fillColor('#333').fontSize(8.5).text('Not qualifying, or no payment this cycle', PAGE_LEFT + 205, y + 2);
  doc.y = y + 18;
  doc.moveDown(0.6);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > 780) {
    doc.addPage();
    doc.y = 50;
  }
}

// Renders one BA's block: name/summary line, a small table header,
// then one colored row per landlord (green = qualifies + paid this
// cycle, orange = otherwise). Used by both the single-BA PDF and the
// combined PDF.
function drawBaBlock(doc, ba) {
  ensureSpace(doc, 60);

  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
    .text(`${ba.baName}${ba.baCode ? ` (${ba.baCode})` : ''}`, PAGE_LEFT, doc.y, { width: PAGE_WIDTH });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(
      `${ba.totalLandlordsOnboarded} onboarded  ·  ${ba.qualifyingLandlordsWithPayment} qualifying & paid  ·  ${ba.notQualifyingLandlords} not qualifying  ·  owed ${fmtKes(ba.totalOwed)}`,
      PAGE_LEFT,
      doc.y,
      { width: PAGE_WIDTH }
    );
  doc.moveDown(0.4);

  const colX = { name: PAGE_LEFT, phone: 195, rate: 290, amount: 335, commission: 415, status: 490 };
  const headerY = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#555');
  doc.text('Landlord', colX.name, headerY, { width: 140 });
  doc.text('Phone', colX.phone, headerY, { width: 90 });
  doc.text('Rate', colX.rate, headerY, { width: 40 });
  doc.text('Payment', colX.amount, headerY, { width: 75 });
  doc.text('Commission', colX.commission, headerY, { width: 70 });
  doc.text('Status', colX.status, headerY, { width: 55 });
  doc.moveDown(0.35);
  doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.2);

  if (!ba.landlords.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor('#999').text('No onboarded landlords.', colX.name, doc.y);
    doc.moveDown(0.6);
    return;
  }

  ba.landlords.forEach((l) => {
    ensureSpace(doc, 18);
    const rowY = doc.y;
    const rowColor = l.qualifiesThisCycle ? GREEN : ORANGE;

    doc.fillOpacity(0.12).rect(PAGE_LEFT, rowY - 2, PAGE_WIDTH, 15).fillColor(rowColor).fill();
    doc.fillOpacity(1);

    doc.fillColor('#222').font('Helvetica').fontSize(8);
    doc.text(l.name || '—', colX.name, rowY, { width: 140 });
    doc.text(l.maskedPhone || '—', colX.phone, rowY, { width: 90 });
    doc.text(l.percentageApplied != null ? `${l.percentageApplied}%` : '—', colX.rate, rowY, { width: 40 });
    doc.text(l.paymentAmount ? fmtKes(l.paymentAmount) : '—', colX.amount, rowY, { width: 75 });
    doc.text(l.commissionAmount ? fmtKes(l.commissionAmount) : '—', colX.commission, rowY, { width: 70 });
    doc.fillColor(rowColor).font('Helvetica-Bold').fontSize(7.5).text(l.qualifiesThisCycle ? 'PAID OUT' : 'NOT YET', colX.status, rowY, { width: 55 });
    doc.font('Helvetica').fillColor('#222');
    doc.moveDown(0.85);
  });
  doc.moveDown(0.5);
}

// Finds a single BA's block by id in the report's flat
// brandAmbassadors list.
function findBa(report, baId) {
  return (report.brandAmbassadors || []).find((ba) => ba.baId === baId) || null;
}

/**
 * Per-BA colored PDF: just this one Brand Ambassador's landlords for
 * the run's cycle, qualifying-and-paid rows green, everything else
 * orange.
 * @param {import('express').Response} res
 * @param {object} report - result of baPayoutQualificationReport.service.getReportById()
 * @param {string} baId
 */
function generateSingleBaPayoutQualificationPdf(res, report, baId) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  const ba = findBa(report, baId);

  drawHeader(doc, {
    subtitle: ba ? `${ba.baName}${ba.baCode ? ` · ${ba.baCode}` : ''}` : 'Brand Ambassador',
    periodLabel: periodLabelOf(report),
    generatedAt: new Date(report.generatedAt),
  });
  drawLegend(doc);

  if (!ba) {
    doc.font('Helvetica').fontSize(10).fillColor('#666')
      .text('This Brand Ambassador has no onboarded landlords in this run.', PAGE_LEFT);
  } else {
    drawBaBlock(doc, ba);
    doc.moveDown(0.2);
    doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text(`Total owed this cycle: ${fmtKes(ba.totalOwed)}`, PAGE_LEFT);
  }

  doc.end();
}

/**
 * Combined PDF: every BA's block one after another, ending with the
 * grand total (KES) owed across the whole run.
 * @param {import('express').Response} res
 * @param {object} report - result of baPayoutQualificationReport.service.getReportById()
 */
function generateCombinedPayoutQualificationPdf(res, report) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  drawHeader(doc, {
    subtitle: 'All Brand Ambassadors',
    periodLabel: periodLabelOf(report),
    generatedAt: new Date(report.generatedAt),
  });
  drawLegend(doc);

  doc.font('Helvetica').fontSize(9).fillColor('#333').text(
    `${report.totals.baCount} Brand Ambassadors  ·  ${report.totals.landlordsOnboarded} landlords onboarded  ·  ${report.totals.qualifying} qualifying & paid  ·  ${report.totals.notQualifying} not qualifying`,
    PAGE_LEFT
  );
  doc.moveDown(0.8);

  if (!report.brandAmbassadors || report.brandAmbassadors.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor('#666').text('No onboarded landlords in this run.', PAGE_LEFT);
  }

  for (const ba of report.brandAmbassadors || []) {
    drawBaBlock(doc, ba);
  }

  ensureSpace(doc, 50);
  doc.moveDown(0.3);
  doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(
    `Grand total owed: ${fmtKes(report.totals.amountOwed)}`,
    PAGE_LEFT
  );
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    `(${report.totals.qualifying} qualifying & paid · ${report.totals.notQualifying} not yet qualifying · ${report.totals.landlordsOnboarded} onboarded in total, across ${report.totals.baCount} Brand Ambassadors)`,
    PAGE_LEFT
  );

  doc.end();
}

module.exports = {
  generateSingleBaPayoutQualificationPdf,
  generateCombinedPayoutQualificationPdf,
  generateCompletedPayoutLinkPdf,
};

// =====================================================================
// BA Monthly Payment Details & Payout Workflow - Phase 4.
//
// Reuses this file's header/table look (same RentaPay banner, ink/
// green palette, page-break handling) for the Completed-tab payout
// PDF - fed from ba_payment_submissions ("paid") + the same owed-
// amount computation as Pending/Completed, rather than from the
// ba_payout_qualification_reports snapshot the functions above read.
// All rows here are already paid, so there's no green/orange
// qualifying split - just one clean table plus a paid-date column and
// the M-Pesa number actually sent to.
// =====================================================================

function generateCompletedPayoutLinkPdf(res, { periodKey, generatedAt, cards, totals }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).fillColor(INK).text('RentaPay', { continued: true }).fillColor(GREEN).text(' — BA Payout (Completed)');
  doc.moveDown(0.2);
  doc.fontSize(11).fillColor('#555').text(periodKey ? `Cycle ${periodKey}` : 'All completed cycles');
  doc.fontSize(9).fillColor(MUTED).text(`Generated ${new Date(generatedAt).toLocaleString('en-GB')}`);
  doc.moveDown(0.8);
  doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.7);

  doc.font('Helvetica').fontSize(9).fillColor('#333').text(
    `${totals.count} paid  ·  ${fmtKes(totals.totalAmount)} disbursed`,
    PAGE_LEFT
  );
  doc.moveDown(0.8);

  if (!cards || cards.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor('#666').text('No completed payments for this selection.', PAGE_LEFT);
    doc.end();
    return;
  }

  const colX = { name: PAGE_LEFT, mpesa: 175, month: 275, landlords: 320, rate: 365, amount: 405, paid: 480 };
  function drawTableHeader() {
    const headerY = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555');
    doc.text('Brand Ambassador', colX.name, headerY, { width: 120 });
    doc.text('M-Pesa', colX.mpesa, headerY, { width: 95 });
    doc.text('Month', colX.month, headerY, { width: 40 });
    doc.text('Onbrd', colX.landlords, headerY, { width: 40 });
    doc.text('Rate', colX.rate, headerY, { width: 35 });
    doc.text('Amount', colX.amount, headerY, { width: 70 });
    doc.text('Paid', colX.paid, headerY, { width: 65 });
    doc.moveDown(0.35);
    doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
    doc.moveDown(0.2);
  }

  drawTableHeader();

  cards.forEach((c) => {
    if (doc.y + 18 > 780) {
      doc.addPage();
      doc.y = 50;
      drawTableHeader();
    }
    const rowY = doc.y;
    doc.fillColor('#222').font('Helvetica').fontSize(8);
    doc.text(`${c.baName}${c.baCode ? ` (${c.baCode})` : ''}`, colX.name, rowY, { width: 120 });
    doc.text(c.mpesaNumber || '—', colX.mpesa, rowY, { width: 95 });
    doc.text(c.periodKey || '—', colX.month, rowY, { width: 40 });
    doc.text(String(c.landlordsOnboarded ?? '—'), colX.landlords, rowY, { width: 40 });
    doc.text(c.commissionPercentage != null ? `${c.commissionPercentage}%` : '—', colX.rate, rowY, { width: 35 });
    doc.font('Helvetica-Bold').text(fmtKes(c.amountOwed), colX.amount, rowY, { width: 70 });
    doc.font('Helvetica').text(c.paidAt ? new Date(c.paidAt).toLocaleDateString('en-GB') : '—', colX.paid, rowY, { width: 65 });
    doc.moveDown(0.85);
  });

  ensureSpace(doc, 40);
  doc.moveDown(0.3);
  doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(
    `Total disbursed: ${fmtKes(totals.totalAmount)}`,
    PAGE_LEFT
  );
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`(${totals.count} payment${totals.count === 1 ? '' : 's'})`, PAGE_LEFT);

  doc.end();
}
