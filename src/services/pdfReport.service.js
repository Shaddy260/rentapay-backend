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
const { drawBrandedHeader, drawBrandedFooter, LOGO_PATH } = require('./pdfBranding.service');

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
  drawBrandedHeader(doc, {
    title: 'Monthly Collection Summary',
    subtitle: propertyName,
    meta: `Prepared for ${landlordName} · Generated ${generatedAt.toLocaleString('en-GB')}`,
  });

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
  doc.fontSize(8).fillColor('#aaa').text('Generated automatically by RentaPay. Figures reflect completed rent payments and logged expenses only.', 50, doc.page.height - 95, { width: 495, align: 'center' });

  drawBrandedFooter(doc);
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
  try {
    doc.roundedRect(left + 24, cardTop + 20, 40, 40, 9).fillColor('#ffffff').lineWidth(1).strokeColor('#d8d8d8').fillAndStroke('#ffffff', '#d8d8d8');
    doc.image(LOGO_PATH, left + 28, cardTop + 24, { width: 32, height: 32 });
  } catch {
    // Missing logo asset should never block a receipt from generating.
  }
  doc.fontSize(22).fillColor('#2e7d32').font('Helvetica-Bold').text('RentaPay', left + 74, cardTop + 24);
  doc.fontSize(11).fillColor('#1a1a1a').font('Helvetica').text('Official Payment Receipt', left + 74, doc.y + 1);
  doc.fontSize(9).fillColor('#888').text(`Receipt No. ${receiptNumber(payment.id)}`, left + 74, doc.y + 6);
  doc.fontSize(9).fillColor('#888').text(`Generated ${generatedAt.toLocaleString('en-GB')}`, left + 74, doc.y);
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

  // FIX (spec item 2.2): balance_after can be negative, meaning the
  // tenant is now ahead/in credit (an advance/extra-month payment) -
  // this used to collapse straight to "KES 0 (fully settled)" for any
  // non-positive value, which silently hid a prepayment instead of
  // showing it. Three real states now: owing (arrears), exactly
  // settled, or ahead (credit carried toward future rent).
  let balanceAfterLabel = '—';
  if (payment.balance_after != null) {
    const balanceAfterNum = Number(payment.balance_after);
    if (balanceAfterNum > 0) balanceAfterLabel = `${KES(balanceAfterNum)} (arrears)`;
    else if (balanceAfterNum < 0) balanceAfterLabel = `${KES(Math.abs(balanceAfterNum))} credit (paid in advance)`;
    else balanceAfterLabel = 'KES 0 (fully settled)';
  }
  summaryRows.push(['Balance after this payment', balanceAfterLabel]);

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

  drawBrandedFooter(doc);
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

  drawBrandedHeader(doc, {
    title: 'Payment History',
    subtitle: `${tenantName}${unitName ? ` · ${unitName}` : ''}${propertyName ? ` · ${propertyName}` : ''}`,
    meta: `Generated ${generatedAt.toLocaleString('en-GB')}`,
  });

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

  drawBrandedFooter(doc);
  doc.end();
}

// BUILD SPEC PHASE 17 - Downloadable Earnings Statement (Per BA, Per
// Period). Built entirely from the stored read-only snapshot fields
// (payout_amount/commission_bonus_amount) already on ba_landlord_claims
// - see baAdminPayout.controller.js's fetchEarningsStatementData, which
// is the only place this data is assembled. Layout mirrors
// generatePaymentHistoryPdf above (same header block, same alternating
// row table), just with BA/landlord columns and a paid-vs-qualified
// totals breakdown instead of a single total.
function generateEarningsStatementPdf(res, { ba, claims, totals, periodLabel, generatedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  drawBrandedHeader(doc, {
    title: 'Brand Ambassador Earnings Statement',
    subtitle: `${ba.full_name}${ba.ba_code ? ` · ${ba.ba_code}` : ''}`,
    meta: `Period: ${periodLabel} · Generated ${generatedAt.toLocaleString('en-GB')}`,
  });

  const colX = { landlord: 50, date: 230, base: 310, commission: 390, status: 470 };
  const headerY = doc.y;
  doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#1a1a1a');
  doc.text('Landlord', colX.landlord, headerY, { width: 175 });
  doc.text('Qualified', colX.date, headerY, { width: 75 });
  doc.text('Base', colX.base, headerY, { width: 75 });
  doc.text('Commission', colX.commission, headerY, { width: 75 });
  doc.text('Status', colX.status, headerY);
  doc.moveDown(0.5);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica').fontSize(9).fillColor('#333');
  if (!claims.length) {
    doc.moveDown(0.5).text('No qualified or paid claims in this period.', colX.landlord);
  }
  claims.forEach((c, i) => {
    if (doc.y > 750) {
      doc.addPage();
      doc.y = 50;
    }
    const rowY = doc.y;
    if (i % 2 === 0) doc.rect(50, rowY - 2, 495, 16).fillColor('#f7f9f7').fill();
    doc.fillColor('#333');
    doc.text(c.landlordName, colX.landlord, rowY, { width: 175 });
    doc.text(c.qualifiedAt ? new Date(c.qualifiedAt).toLocaleDateString('en-GB') : '—', colX.date, rowY, { width: 75 });
    doc.text(KES(c.payoutAmount), colX.base, rowY, { width: 75 });
    doc.text(KES(c.commissionBonusAmount), colX.commission, rowY, { width: 75 });
    doc.text(c.status === 'paid' ? 'Paid' : 'Qualified', colX.status, rowY);
    doc.moveDown(0.9);

    // Item 10 / ITEM 13 - transparency: a small grey line under the row
    // naming which unit bracket / percentage basis / commission tier
    // (if any) produced the amounts above, so this isn't just a final
    // number.
    const bracket = c.breakdown?.unitBracket;
    const percentage = c.breakdown?.percentage;
    const tier = c.breakdown?.commissionTier;
    if (bracket || percentage || tier) {
      const parts = [];
      if (percentage) parts.push(`Base: ${percentage.rate}% of KES ${Number(percentage.basisAmount).toLocaleString()} qualifying payment`);
      else if (bracket) parts.push(`Base: ${bracket.minUnits}-${bracket.maxUnits ?? '+'} units bracket (KES ${Number(bracket.amount).toLocaleString()})`);
      if (tier) parts.push(`Commission: ${tier.commissionPercent}% tier (crossed at ${tier.targetQualifiedLandlords} qualified)`);
      doc.fontSize(7.5).fillColor('#999').text(parts.join('  ·  '), colX.landlord, doc.y, { width: 495 });
      doc.fontSize(9).fillColor('#333');
      doc.moveDown(0.4);
    }
  });

  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a1a').text(`Grand total: ${KES(totals.grandTotal)}  (base ${KES(totals.baseTotal)} + commission ${KES(totals.commissionTotal)})`, 50);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#333').text(`Already paid: ${KES(totals.paidTotal)}`, 50);
  doc.text(`Qualified, not yet paid: ${KES(totals.qualifiedNotYetPaidTotal)}`, 50);

  drawBrandedFooter(doc);
  doc.end();
}

// PREMIUM REDESIGN PLAN - PHASE 8: after admin confirms a BA reward
// (single or bulk), a downloadable, branded PDF lists the rewarded
// BAs - name, new commission rate, reward period, contact details.
// Net contribution is deliberately NOT included in this export (per
// spec). Same branded-header convention as the statements above
// (RentaPay wordmark + report title, generated-at metadata) so it
// reads as an official RentaPay document rather than a bare table.
function generateBaRewardReportPdf(res, { batch, rewards, generatedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  // --- Branded header band ---------------------------------------
  // Same layout rhythm as pdfBranding.service.js's shared header
  // (wordmark, then title, then meta, stacked - not run together on
  // one line) so a long title never wraps and collides with the meta
  // line beneath it. Kept as its own dark-teal/gold banner rather than
  // switching to the shared green one, since this report intentionally
  // reads as a distinct "reward" document.
  const bandHeight = 100;
  doc.rect(0, 0, doc.page.width, bandHeight).fillColor('#0F3D3E').fill();
  try {
    doc.roundedRect(50, 26, 46, 46, 10).fillColor('#ffffff').fill();
    doc.image(LOGO_PATH, 54, 30, { width: 38, height: 38 });
  } catch {
    // Missing logo asset should never block the report from generating.
  }
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#FFFFFF').text('RentaPay', 108, 30, { width: doc.page.width - 158 });
  doc.font('Helvetica').fontSize(11).fillColor('#C9A24B').text('Brand Ambassador Reward Report', 108, doc.y + 1, { width: doc.page.width - 158 });
  doc.font('Helvetica').fontSize(8).fillColor('#E8CE8B').text(
    `Reward period ${new Date(batch.start_at).toLocaleDateString('en-GB')} – ${new Date(batch.end_at).toLocaleDateString('en-GB')}  ·  Generated ${generatedAt.toLocaleString('en-GB')}  ·  Report ID ${batch.id.slice(0, 8).toUpperCase()}`,
    108,
    doc.y + 3,
    { width: doc.page.width - 158 }
  );

  doc.y = bandHeight + 25;
  doc.fontSize(11).fillColor('#1a1a1a').text(
    `New commission rate: ${Number(batch.new_percentage)}% (default was ${Number(batch.default_percentage_at_time)}%)  ·  ${rewards.length} Brand Ambassador${rewards.length === 1 ? '' : 's'} rewarded`,
    50
  );
  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.6);

  const colX = { name: 50, rate: 220, period: 300, phone: 400, email: 480 };
  const headerY = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#1a1a1a');
  doc.text('Brand Ambassador', colX.name, headerY, { width: 165 });
  doc.text('New Rate', colX.rate, headerY, { width: 75 });
  doc.text('Reward Period', colX.period, headerY, { width: 95 });
  doc.text('Phone', colX.phone, headerY, { width: 75 });
  doc.moveDown(0.5);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica').fontSize(9).fillColor('#333');
  rewards.forEach((r, i) => {
    if (doc.y > 720) {
      doc.addPage();
      doc.y = 50;
    }
    const rowY = doc.y;
    if (i % 2 === 0) doc.rect(50, rowY - 2, 495, 30).fillColor('#f7f9f7').fill();
    doc.fillColor('#333');
    doc.text(`${r.baName}${r.baCode ? ` (${r.baCode})` : ''}`, colX.name, rowY, { width: 165 });
    doc.fillColor('#0F3D3E').font('Helvetica-Bold').text(`${Number(r.new_percentage)}%`, colX.rate, rowY, { width: 75 });
    doc.font('Helvetica').fillColor('#333');
    doc.text(`${new Date(r.start_at).toLocaleDateString('en-GB')} – ${new Date(r.end_at).toLocaleDateString('en-GB')}`, colX.period, rowY, { width: 95 });
    doc.text(r.baPhone || '—', colX.phone, rowY, { width: 75 });
    doc.text(r.baEmail || '—', colX.email, rowY + 12, { width: 460 });
    doc.moveDown(1.6);
  });

  doc.moveDown(1);
  doc.fontSize(8).fillColor('#aaa').text(
    'RentaPay · This report lists rewarded Brand Ambassadors only. Commission rates revert automatically to the default rate at the end of the reward period.',
    50,
    doc.y,
    { width: 495 }
  );

  drawBrandedFooter(doc);
  doc.end();
}

module.exports = {
  generateCollectionSummaryPdf,
  generatePaymentReceiptPdf,
  generatePaymentReceiptPdfBuffer,
  generatePaymentHistoryPdf,
  generateEarningsStatementPdf,
  generateBaRewardReportPdf,
  receiptNumber,
};
