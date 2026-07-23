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
function generatePaymentReceiptPdf(res, { payment, tenantName, unitName, propertyName, landlordName, generatedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  // --- Header ---------------------------------------------------------
  doc.fontSize(20).fillColor('#1a1a1a').text('RentaPay', { continued: true }).fillColor('#2e7d32').text(' — Payment Receipt');
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor('#888').text(`Generated ${generatedAt.toLocaleString('en-GB')}`);
  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1.2);

  // --- Amount, front and center -----------------------------------------
  doc.fontSize(11).fillColor('#888').text('AMOUNT PAID');
  doc.fontSize(28).fillColor('#2e7d32').text(KES(payment.amount));
  doc.moveDown(1);

  // --- Details table -------------------------------------------------
  const rows = [
    ['Receipt No.', payment.id],
    ['Tenant', tenantName || '—'],
    ['Unit', unitName || '—'],
    ['Property', propertyName || '—'],
    ['Landlord', landlordName || '—'],
    ['Date paid', payment.paid_at ? new Date(payment.paid_at).toLocaleString('en-GB') : '—'],
    ['Payment method', (payment.payment_method || '—').replace('_', ' ')],
  ];
  if (payment.mpesa_transaction_id) rows.push(['M-Pesa transaction code', payment.mpesa_transaction_id]);
  if (payment.is_partial) rows.push(['Note', 'Partial payment']);

  doc.fontSize(10).fillColor('#333');
  rows.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').text(`${label}:`, 50, doc.y, { continued: true, width: 180 });
    doc.font('Helvetica').text(`  ${value}`, { align: 'left' });
    doc.moveDown(0.3);
  });

  doc.moveDown(1.5);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);
  doc.fontSize(9).fillColor('#aaa').text('This receipt was generated automatically by RentaPay and reflects a completed rent payment on record.', 50, doc.y, { width: 495 });

  doc.end();
}

module.exports = { generateCollectionSummaryPdf, generatePaymentReceiptPdf };
