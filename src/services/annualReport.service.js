// src/services/annualReport.service.js
//
// Two PDFs built on the same annual, all-properties aggregation (see
// annualReport.controller.js's computeAnnualPortfolioStatistics):
//   - generateAnnualPortfolioPdf: general year-in-review, per property
//   - generateTaxSummaryPdf: KRA-filing-shaped - gross rent per
//     property per month, expenses by category, net figure. No tax
//     rate is applied or implied; see the note in the controller.

const PDFDocument = require('pdfkit');

const KES = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;

function drawHeader(doc, { title, subtitle, landlordName, generatedAt }) {
  doc.fontSize(20).fillColor('#1a1a1a').text('RentaPay', { continued: true }).fillColor('#2e7d32').text(` — ${title}`);
  if (subtitle) {
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor('#555').text(subtitle);
  }
  doc.fontSize(9).fillColor('#888').text(`Prepared for ${landlordName} · Generated ${generatedAt.toLocaleString('en-GB')}`);
  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);
}

function drawMonthlyTable(doc, monthly, { includeNet = true } = {}) {
  const tableTop = doc.y;
  const colWidths = includeNet ? [90, 145, 145, 145] : [90, 220, 220];
  const headers = includeNet ? ['Month', 'Collected', 'Expenses', 'Net'] : ['Month', 'Collected', 'Expenses'];
  let x = 50;
  doc.fontSize(9).fillColor('#888');
  headers.forEach((h, i) => {
    doc.text(h, x, tableTop, { width: colWidths[i] });
    x += colWidths[i];
  });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#e0e0e0').stroke();

  let rowY = tableTop + 20;
  monthly.forEach((m) => {
    x = 50;
    const cells = includeNet
      ? [m.label, KES(m.collected), KES(m.expenses), KES(m.net)]
      : [m.label, KES(m.collected), KES(m.expenses)];
    doc.fontSize(10).fillColor('#333');
    cells.forEach((c, i) => {
      doc.text(c, x, rowY, { width: colWidths[i] });
      x += colWidths[i];
    });
    rowY += 16;
  });
  doc.y = rowY + 6;
}

function generateAnnualPortfolioPdf(res, { landlordName, generatedAt, report }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  drawHeader(doc, { title: `Annual Report — ${report.year}`, subtitle: 'All properties', landlordName, generatedAt });

  doc.fontSize(13).fillColor('#1a1a1a').text('Portfolio Totals');
  doc.moveDown(0.4);
  const cardY = doc.y;
  const cards = [
    { label: 'Collected', value: KES(report.portfolioTotals.collected) },
    { label: 'Expenses', value: KES(report.portfolioTotals.expenses) },
    { label: 'Net', value: KES(report.portfolioTotals.net) },
  ];
  const cardWidth = (545 - 50) / cards.length;
  cards.forEach((card, i) => {
    const x = 50 + i * cardWidth;
    doc.fontSize(8).fillColor('#888').text(card.label.toUpperCase(), x, cardY, { width: cardWidth - 8 });
    doc.fontSize(14).fillColor(card.label === 'Net' ? (report.portfolioTotals.net >= 0 ? '#2e7d32' : '#b3261e') : '#1a1a1a').text(card.value, x, cardY + 14, { width: cardWidth - 8 });
  });
  doc.y = cardY + 45;
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#1a1a1a').text('Month by Month — All Properties');
  doc.moveDown(0.4);
  drawMonthlyTable(doc, report.portfolioMonthly);
  doc.moveDown(1);

  if (report.properties.length === 0) {
    doc.fontSize(10).fillColor('#888').text('No properties on record.');
  }

  report.properties.forEach((prop, idx) => {
    if (doc.y > 650) doc.addPage();
    else if (idx > 0) doc.moveDown(1);

    doc.fontSize(13).fillColor('#1a1a1a').text(prop.name);
    doc.fontSize(9).fillColor('#888').text(`Collected ${KES(prop.totalCollected)} · Expenses ${KES(prop.totalExpenses)} · Net ${KES(prop.totalNet)}`);
    doc.moveDown(0.4);
    drawMonthlyTable(doc, prop.monthly);
  });

  doc.moveDown(1);
  doc.fontSize(8).fillColor('#aaa').text('Generated automatically by RentaPay. Figures reflect completed rent payments and logged expenses only.', 50, doc.y, { width: 495 });

  doc.end();
}

function generateTaxSummaryPdf(res, { landlordName, kraPin, generatedAt, report }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  drawHeader(doc, { title: `Rental Income Summary — ${report.year}`, subtitle: 'For tax filing reference', landlordName, generatedAt });

  if (kraPin) {
    doc.fontSize(10).fillColor('#333').text(`KRA PIN: ${kraPin}`);
    doc.moveDown(0.6);
  }

  doc.fontSize(9).fillColor('#b3261e').text(
    'This is a summary of gross rent collected and logged expenses recorded in RentaPay. It does not calculate tax owed or apply any tax rate - confirm the correct filing figures and applicable rate with KRA or your accountant before filing.',
    50, doc.y, { width: 495 }
  );
  doc.moveDown(1);
  doc.strokeColor('#e0e0e0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#1a1a1a').text('Gross Rental Income Received — By Property');
  doc.moveDown(0.4);

  const tableTop = doc.y;
  const colWidths = [245, 150, 150];
  const headers = ['Property', 'Gross rent collected', 'Logged expenses'];
  let x = 50;
  doc.fontSize(9).fillColor('#888');
  headers.forEach((h, i) => { doc.text(h, x, tableTop, { width: colWidths[i] }); x += colWidths[i]; });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#e0e0e0').stroke();

  let rowY = tableTop + 20;
  report.properties.forEach((prop) => {
    x = 50;
    doc.fontSize(10).fillColor('#333');
    [prop.name, KES(prop.totalCollected), KES(prop.totalExpenses)].forEach((c, i) => {
      doc.text(c, x, rowY, { width: colWidths[i] });
      x += colWidths[i];
    });
    rowY += 16;
  });
  doc.moveTo(50, rowY + 2).lineTo(545, rowY + 2).strokeColor('#e0e0e0').stroke();
  rowY += 10;
  x = 50;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a');
  ['Total', KES(report.portfolioTotals.collected), KES(report.portfolioTotals.expenses)].forEach((c, i) => {
    doc.text(c, x, rowY, { width: colWidths[i] });
    x += colWidths[i];
  });
  doc.font('Helvetica');
  doc.y = rowY + 30;

  doc.fontSize(13).fillColor('#1a1a1a').text('Expenses by Category — All Properties');
  doc.moveDown(0.4);
  const categoryTotals = {};
  report.properties.forEach((prop) => {
    Object.entries(prop.expensesByCategory || {}).forEach(([cat, amt]) => {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amt;
    });
  });
  const categoryEntries = Object.entries(categoryTotals);
  if (categoryEntries.length === 0) {
    doc.fontSize(10).fillColor('#888').text('No expenses logged for this year.');
  } else {
    doc.fontSize(10).fillColor('#333');
    categoryEntries.forEach(([cat, amt]) => {
      doc.text(`${cat}:`, 50, doc.y, { continued: true, width: 200 });
      doc.text(`  ${KES(amt)}`, { align: 'left' });
      doc.moveDown(0.3);
    });
  }

  doc.moveDown(1.5);
  doc.fontSize(9).fillColor('#1a1a1a').text(`Net rental income (collected − logged expenses): ${KES(report.portfolioTotals.net)}`, 50, doc.y, { width: 495 });

  doc.moveDown(1);
  doc.fontSize(8).fillColor('#aaa').text('Generated automatically by RentaPay from records of completed rent payments and logged expenses. Verify against your own records before filing.', 50, doc.y, { width: 495 });

  doc.end();
}

module.exports = { generateAnnualPortfolioPdf, generateTaxSummaryPdf };
