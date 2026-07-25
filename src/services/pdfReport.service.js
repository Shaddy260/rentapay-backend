// src/services/pdfReport.service.js
//
// Renders the "monthly collection summary" as a PDF, streamed
// directly to the response (see dashboard.controller.js's
// getLandlordStatisticsPdf). Built with pdfkit rather than converting
// an HTML template, since the data here is a handful of numbers and a
// small table - pdfkit's direct drawing API is simpler than standing
// up an HTML->PDF pipeline for this.

const PDFDocument = require('pdfkit');

const KES = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;

/**
 * @param {import('express').Response} res - PDF is piped directly into this
 * @param {object} params
 * @param {string} params.landlordName
 * @param {string} params.propertyName
 * @param {Date} params.generatedAt
 * @param {object} params.stats - the object returned by computeLandlordStatistics().data
 */
function generateCollectionSummaryPdf(res, { landlordName, propertyName, generatedAt, stats }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  const { units, payments, expenses, monthlyCollected } = stats;

  // --- Header ---------------------------------------------------------
  doc.fontSize(20).fillColor('#1a1a1a').text('RentaPay', { continued: true }).fillColor('#2e7d32').text(' — Monthly Collection Summary');
  doc.moveDown(0.2);
  doc.fontSize(11).fillColor('#555').text(propertyName);
  doc.fontSize(9).fillColor('#888').text(`Prepared for ${landlordName} · Generated ${generatedAt.toLocaleString('en-GB')}`);
  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  // --- Headline figures -------------------------------------------------
  doc.fontSize(13).fillColor('#1a1a1a').text('This Month');
  doc.moveDown(0.4);

  const cardY = doc.y;
  const cards = [
    { label: 'Collected', value: KES(payments.collectedThisMonth) },
    { label: 'Expected', value: KES(payments.expectedThisMonth) },
    { label: 'Collection rate', value: payments.collectionRate != null ? `${payments.collectionRate}%` : '—' },
    { label: 'Expenses', value: KES(expenses.expensesThisMonth) },
    { label: 'Net profit', value: KES(expenses.netProfitThisMonth) },
  ];
  const cardWidth = (545 - 50) / cards.length;
  cards.forEach((card, i) => {
    const x = 50 + i * cardWidth;
    doc.fontSize(8).fillColor('#888').text(card.label.toUpperCase(), x, cardY, { width: cardWidth - 8 });
    doc.fontSize(12).fillColor(card.label === 'Net profit' ? (expenses.netProfitThisMonth >= 0 ? '#2e7d32' : '#b3261e') : '#1a1a1a')
      .text(card.value, x, cardY + 14, { width: cardWidth - 8 });
  });
  doc.y = cardY + 45;
  doc.moveDown(1);

  // --- Occupancy + payment behaviour ------------------------------------
  doc.fontSize(13).fillColor('#1a1a1a').text('Portfolio Snapshot');
  doc.moveDown(0.4);
  const snapshotRows = [
    ['Total units', units.total],
    ['Occupied', units.occupied],
    ['Vacant', units.vacant],
    ['Under maintenance', units.maintenance],
    ['Notice given', units.noticeGiven],
    ['Occupancy rate', `${units.occupancyRate}%`],
    ['On-time payments (6mo)', payments.onTimeCount],
    ['Late payments (6mo)', payments.lateCount],
    ['On-time rate', payments.onTimeRate != null ? `${payments.onTimeRate}%` : '—'],
    ['Overdue tenants right now', payments.overdueNow],
  ];
  doc.fontSize(10).fillColor('#333');
  snapshotRows.forEach(([label, value]) => {
    doc.text(`${label}:`, 50, doc.y, { continued: true, width: 250 });
    doc.text(`  ${value}`, { align: 'left' });
  });
  doc.moveDown(1);

  // --- 6-month trend table -----------------------------------------------
  doc.fontSize(13).fillColor('#1a1a1a').text('6-Month Collections vs Expenses');
  doc.moveDown(0.4);

  const tableTop = doc.y;
  const colWidths = [120, 140, 140, 140];
  const headers = ['Month', 'Collected', 'Expenses', 'Net'];
  let x = 50;
  doc.fontSize(9).fillColor('#888');
  headers.forEach((h, i) => {
    doc.text(h, x, tableTop, { width: colWidths[i] });
    x += colWidths[i];
  });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#e0e0e0').stroke();

  let rowY = tableTop + 20;
  const monthlyExpenses = stats.monthlyExpenses || [];
  monthlyCollected.forEach((m, idx) => {
    const expenseForMonth = monthlyExpenses[idx]?.value || 0;
    const net = m.value - expenseForMonth;
    x = 50;
    doc.fontSize(10).fillColor('#333');
    const cells = [m.label, KES(m.value), KES(expenseForMonth), KES(net)];
    cells.forEach((c, i) => {
      doc.text(c, x, rowY, { width: colWidths[i] });
      x += colWidths[i];
    });
    rowY += 18;
  });

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#aaa').text('Generated automatically by RentaPay. Figures reflect completed rent payments and logged expenses only.', 50, doc.page.height - 70, { width: 495, align: 'center' });

  doc.end();
}

/**
 * Renders a single payment as a formal receipt PDF, streamed directly
 * to the response - for the tenant portal's "Receipt" button, which
 * used to just call window.print() on the on-screen table row (no
 * real downloadable document a tenant could keep for their own
 * records). Kept deliberately simple/one-page: this is a receipt, not
 * a report - a tenant just needs proof of what was paid, when, and
 * against which unit.
 *
 * @param {import('express').Response} res
 * @param {object} params
 * @param {object} params.payment - a row from `payments`
 * @param {string} params.tenantName
 * @param {string} params.unitName
 * @param {string} params.propertyName
 * @param {string} params.landlordName
 * @param {Date} params.generatedAt
 */
// Short, human-friendly receipt number derived from the payment's own
// id (stable and unique without needing a separate sequence column) -
// e.g. "RP-4F91A2C8" instead of the raw UUID, so it reads like a real
// receipt number while still being traceable back to payment.id.
const receiptNumber = (paymentId) => `RP-${String(paymentId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/**
 * REWORKED (direct request: "the receipt should be advanced, should
 * look like a real receipt"): the previous version was just a plain
 * label/value list. This lays it out like an actual paid receipt -
 * a bordered card, a short receipt number instead of the raw UUID, a
 * green PAID stamp, the amount in words-adjacent large type, an
 * itemized details block, a perforated-look divider, and a signed-off
 * footer - while keeping the exact same function signature so nothing
 * calling it needs to change.
 */
function generatePaymentReceiptPdf(res, { payment, tenantName, unitName, propertyName, landlordName, generatedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  const left = 50;
  const right = 545;
  const cardTop = 50;

  // --- Outer receipt card ---------------------------------------------
  doc.roundedRect(left, cardTop, right - left, 620, 10).lineWidth(1).strokeColor('#d8d8d8').stroke();

  // --- Header bar -------------------------------------------------------
  doc.fontSize(20).fillColor('#1a1a1a').text('RentaPay', left + 24, cardTop + 24, { continued: true }).fillColor('#2e7d32').text(' — Official Payment Receipt');
  doc.fontSize(9).fillColor('#888').text(`Receipt No. ${receiptNumber(payment.id)}`, left + 24, doc.y + 2);
  doc.fontSize(9).fillColor('#888').text(`Generated ${generatedAt.toLocaleString('en-GB')}`);

  // --- PAID stamp, top-right corner --------------------------------------
  const stampX = right - 130;
  const stampY = cardTop + 24;
  doc.save();
  doc.lineWidth(2).strokeColor('#2e7d32').roundedRect(stampX, stampY, 100, 34, 6).stroke();
  doc.fontSize(16).fillColor('#2e7d32').font('Helvetica-Bold').text('PAID', stampX, stampY + 9, { width: 100, align: 'center' });
  doc.restore();

  doc.moveDown(1.4);
  doc.strokeColor('#e0e0e0').moveTo(left + 24, doc.y).lineTo(right - 24, doc.y).stroke();
  doc.moveDown(1.2);

  // --- Amount, front and center -----------------------------------------
  doc.fontSize(10).fillColor('#888').font('Helvetica').text('AMOUNT PAID', left + 24, doc.y);
  doc.fontSize(30).fillColor('#2e7d32').font('Helvetica-Bold').text(KES(payment.amount), left + 24, doc.y + 2);
  doc.moveDown(1.1);
  doc.strokeColor('#e0e0e0').moveTo(left + 24, doc.y).lineTo(right - 24, doc.y).stroke();
  doc.moveDown(1);

  // --- Itemized details ---------------------------------------------
  const rows = [
    ['Tenant', tenantName || '—'],
    ['Unit', unitName || '—'],
    ['Property', propertyName || '—'],
    ['Landlord / Payee', landlordName || '—'],
    ['Date paid', payment.paid_at ? new Date(payment.paid_at).toLocaleString('en-GB') : '—'],
    ['Payment method', (payment.payment_method || '—').replace('_', ' ')],
  ];
  if (payment.mpesa_transaction_id) rows.push(['M-Pesa transaction code', payment.mpesa_transaction_id]);
  if (payment.is_partial) rows.push(['Note', 'Partial payment - balance remains on account']);

  doc.fontSize(10).fillColor('#333');
  rows.forEach(([label, value], i) => {
    const rowY = doc.y;
    if (i % 2 === 0) doc.rect(left + 16, rowY - 3, right - left - 32, 20).fillColor('#f7f9f7').fill();
    doc.fillColor('#333');
    doc.font('Helvetica-Bold').text(label, left + 24, rowY, { continued: true, width: 190 });
    doc.font('Helvetica').fillColor('#1a1a1a').text(`  ${value}`, { align: 'left' });
    doc.moveDown(0.35);
  });

  // --- Perforated-look divider, like a tear-off stub line -----------
  doc.moveDown(1.2);
  const dashY = doc.y;
  doc.dash(3, { space: 3 }).strokeColor('#c9c9c9').moveTo(left + 24, dashY).lineTo(right - 24, dashY).stroke();
  doc.undash();
  doc.moveDown(1);

  doc.fontSize(10).fillColor('#2e7d32').font('Helvetica-Bold').text('Thank you for your payment.', left + 24, doc.y, { width: right - left - 48 });
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor('#aaa').font('Helvetica').text(
    'This is a system-generated receipt from RentaPay and reflects a completed rent payment on record. It is valid without a signature or stamp.',
    left + 24,
    doc.y,
    { width: right - left - 48 }
  );

  doc.end();
}

module.exports = { generateCollectionSummaryPdf, generatePaymentReceiptPdf };
