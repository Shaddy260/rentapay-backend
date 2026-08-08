// src/services/pdfReport.service.js
//
// Renders the "monthly collection summary" as a PDF, streamed
// directly to the response (see dashboard.controller.js's
// getLandlordStatisticsPdf). Built with pdfkit rather than converting
// an HTML template, since the data here is a handful of numbers and a
// small table - pdfkit's direct drawing API is simpler than standing
// up an HTML->PDF pipeline for this.

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

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
 * Section 6 upgrade ("upgrade the receipt document itself"): a green
 * accent strip across the top, a logo header, a solid filled-green
 * "PAID" pill (was an outline badge), content grouped into clearly
 * separated sections (Payment Summary -> Parties -> Notes/Footer),
 * the rent period the payment covers, the landlord's KRA PIN/business
 * reg. number when on file, a QR code linking to a receipt
 * verification URL, and the tenant's running balance after this
 * payment. Async now (QR code generation is async) - callers must
 * `await` it.
 *
 * @param {import('stream').Writable} target - PDF is piped into this
 * @param {object} params
 * @param {object} params.payment - a row from `payments`
 * @param {string} params.tenantName
 * @param {string} params.unitName
 * @param {string} params.propertyName
 * @param {string} params.landlordName
 * @param {string} [params.landlordKraPin] - landlord's KRA PIN / business reg. number, if on file
 * @param {Date} params.generatedAt
 */
async function generatePaymentReceiptPdf(target, { payment, tenantName, unitName, propertyName, landlordName, landlordKraPin, generatedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.pipe(target);

  const pageWidth = doc.page.width;
  const left = 50;
  const right = pageWidth - 50;
  const contentWidth = right - left;

  // --- Thin green accent bar across the very top of the page --------
  doc.rect(0, 0, pageWidth, 8).fillColor('#2e7d32').fill();

  const cardTop = 40;
  doc.roundedRect(left, cardTop, contentWidth, 700, 10).lineWidth(1).strokeColor('#d8d8d8').stroke();

  // --- Header: logo + document title -------------------------------
  doc.fontSize(22).fillColor('#2e7d32').font('Helvetica-Bold').text('RentaPay', left + 24, cardTop + 24);
  doc.fontSize(11).fillColor('#1a1a1a').font('Helvetica').text('Official Payment Receipt', left + 24, doc.y + 1);
  doc.fontSize(9).fillColor('#888').text(`Receipt No. ${receiptNumber(payment.id)}`, left + 24, doc.y + 6);
  doc.fontSize(9).fillColor('#888').text(`Generated ${generatedAt.toLocaleString('en-GB')}`);
  // Text positioned with explicit x/y (the PAID pill below) resets
  // doc.y to wherever THAT text sits - capture the header block's real
  // bottom now so the divider/section below isn't drawn using the
  // pill's (higher up the page) y instead.
  const headerBottomY = doc.y;

  // --- PAID pill, top-right corner - solid fill, white text ---------
  const pillWidth = 100;
  const pillHeight = 30;
  const pillX = right - 24 - pillWidth;
  const pillY = cardTop + 24;
  doc.roundedRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2).fillColor('#2e7d32').fill();
  doc.fontSize(14).fillColor('#ffffff').font('Helvetica-Bold').text('PAID', pillX, pillY + 8, { width: pillWidth, align: 'center' });

  doc.y = Math.max(headerBottomY, pillY + pillHeight);
  doc.moveDown(1.6);
  doc.strokeColor('#e0e0e0').moveTo(left + 24, doc.y).lineTo(right - 24, doc.y).stroke();
  doc.moveDown(1);

  // --- Section: Payment Summary --------------------------------------
  doc.fontSize(11).fillColor('#2e7d32').font('Helvetica-Bold').text('PAYMENT SUMMARY', left + 24, doc.y);
  doc.moveDown(0.5);

  doc.fontSize(10).fillColor('#888').font('Helvetica').text('AMOUNT PAID', left + 24, doc.y);
  doc.fontSize(28).fillColor('#2e7d32').font('Helvetica-Bold').text(KES(payment.amount), left + 24, doc.y + 2);
  doc.moveDown(0.8);

  const summaryRows = [
    ['Rent period', payment.rent_period || '—'],
    ['Date paid', payment.paid_at ? new Date(payment.paid_at).toLocaleString('en-GB') : '—'],
    ['Payment method', (payment.payment_method || '—').replace('_', ' ')],
  ];
  if (payment.mpesa_transaction_id) summaryRows.push(['M-Pesa transaction code', payment.mpesa_transaction_id]);
  if (payment.is_partial) summaryRows.push(['Note', 'Partial payment - balance remains on account']);
  summaryRows.push(['Balance after this payment', payment.balance_after != null ? (Number(payment.balance_after) > 0 ? `${KES(payment.balance_after)} (arrears)` : 'KES 0 (fully settled)') : '—']);

  writeRows(doc, summaryRows, left, right);

  doc.moveDown(0.6);
  doc.strokeColor('#e0e0e0').moveTo(left + 24, doc.y).lineTo(right - 24, doc.y).stroke();
  doc.moveDown(1);

  // --- Section: Parties -------------------------------------------------
  doc.fontSize(11).fillColor('#2e7d32').font('Helvetica-Bold').text('PARTIES', left + 24, doc.y);
  doc.moveDown(0.5);

  const partyRows = [
    ['Tenant', tenantName || '—'],
    ['Property', propertyName || '—'],
    ['Unit', unitName || '—'],
    ['Landlord / Payee', landlordName || '—'],
  ];
  if (landlordKraPin) partyRows.push(['Landlord KRA PIN', landlordKraPin]);

  writeRows(doc, partyRows, left, right);

  // --- QR code, verification link ------------------------------------
  const verifyBaseUrl = process.env.FRONTEND_URL || 'https://rentapay.co.ke';
  const verifyUrl = `${verifyBaseUrl}/verify/${payment.id}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 0, width: 240 });
  const qrSize = 70;
  const qrX = right - 24 - qrSize;
  const qrY = doc.y + 4;
  doc.image(qrDataUrl, qrX, qrY, { width: qrSize, height: qrSize });
  doc.fontSize(7).fillColor('#aaa').font('Helvetica').text('Scan to verify', qrX, qrY + qrSize + 4, { width: qrSize, align: 'center' });

  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(left + 24, doc.y).lineTo(right - 24, doc.y).stroke();
  doc.moveDown(1);

  // --- Section: Notes / Footer -----------------------------------------
  doc.fontSize(11).fillColor('#2e7d32').font('Helvetica-Bold').text('NOTES', left + 24, doc.y);
  doc.moveDown(0.4);
  doc.fontSize(10).fillColor('#2e7d32').font('Helvetica-Bold').text('Thank you for your payment.', left + 24, doc.y, { width: contentWidth - 48 });
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#aaa').font('Helvetica').text(
    `This is a system-generated receipt from RentaPay and reflects a completed rent payment on record. It is valid without a signature or stamp. Verify this receipt at ${verifyUrl}`,
    left + 24,
    doc.y,
    { width: contentWidth - 48 }
  );

  doc.end();
}

// Shared label/value row renderer used by both the Payment Summary and
// Parties sections above, so the two sections stay visually
// consistent (alternating row shading, same column widths).
function writeRows(doc, rows, left, right) {
  doc.fontSize(10).fillColor('#333');
  rows.forEach(([label, value], i) => {
    const rowY = doc.y;
    if (i % 2 === 0) doc.rect(left + 16, rowY - 3, right - left - 32, 20).fillColor('#f7f9f7').fill();
    doc.fillColor('#333');
    doc.font('Helvetica-Bold').text(label, left + 24, rowY, { continued: true, width: 190 });
    doc.font('Helvetica').fillColor('#1a1a1a').text(`  ${value}`, { align: 'left' });
    doc.moveDown(0.35);
  });
}

// DIRECT REQUEST: bulk "download all receipts" export needs each
// receipt as an in-memory PDF to add into a zip, rather than streamed
// straight to the HTTP response the way the single-receipt download
// works. Reuses the exact same layout via generatePaymentReceiptPdf
// above, just pointed at a small in-memory Writable instead of `res`.
const { PassThrough } = require('stream');

function generatePaymentReceiptPdfBuffer(params) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    generatePaymentReceiptPdf(stream, params).catch(reject);
  });
}

// FEATURE (Section 8: rent history export) - lets a tenant download
// their own payment history as a PDF from their portal (a CSV export
// already existed client-side via downloadCsv.js; this is the PDF
// counterpart, generated server-side since pdfkit only runs there).
function generatePaymentHistoryPdf(res, { tenantName, unitName, propertyName, payments, generatedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).fillColor('#1a1a1a').text('RentaPay', { continued: true }).fillColor('#2e7d32').text(' — Payment History');
  doc.moveDown(0.2);
  doc.fontSize(11).fillColor('#555').text(`${tenantName}${unitName ? ` · ${unitName}` : ''}${propertyName ? ` · ${propertyName}` : ''}`);
  doc.fontSize(9).fillColor('#888').text(`Generated ${generatedAt.toLocaleString('en-GB')}`);
  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  const colX = { date: 50, amount: 180, method: 300, status: 430 };
  const headerY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a1a1a');
  doc.text('Date', colX.date, headerY);
  doc.text('Amount', colX.amount, headerY);
  doc.text('Method', colX.method, headerY);
  doc.text('Status', colX.status, headerY);
  doc.moveDown(0.5);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica').fontSize(9.5).fillColor('#333');
  if (!payments.length) {
    doc.moveDown(0.5).text('No payments recorded.', colX.date);
  }
  payments.forEach((p, i) => {
    if (doc.y > 760) {
      doc.addPage();
      doc.y = 50;
    }
    const rowY = doc.y;
    if (i % 2 === 0) doc.rect(50, rowY - 2, 495, 16).fillColor('#f7f9f7').fill();
    doc.fillColor('#333');
    doc.text(p.paid_at ? new Date(p.paid_at).toLocaleDateString('en-GB') : '—', colX.date, rowY);
    doc.text(KES(p.amount), colX.amount, rowY);
    doc.text((p.payment_method || '—').replace(/_/g, ' '), colX.method, rowY);
    doc.text(p.status || '—', colX.status, rowY);
    doc.moveDown(0.9);
  });

  doc.moveDown(1);
  const total = payments.filter((p) => p.status === 'completed').reduce((sum, p) => sum + Number(p.amount), 0);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a1a').text(`Total paid (completed): ${KES(total)}`, 50);

  doc.end();
}

module.exports = { generateCollectionSummaryPdf, generatePaymentReceiptPdf, generatePaymentReceiptPdfBuffer, generatePaymentHistoryPdf };
