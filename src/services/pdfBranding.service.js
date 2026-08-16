// src/services/pdfBranding.service.js
//
// Single shared header/footer for every PDF the platform generates -
// receipts, statements, activity logs, annual reports, payout
// reports, everything. Before this, each PDF service
// (pdfReport.service.js, annualReport.service.js,
// baPayoutQualificationReportPdf.service.js,
// generalManagerLogPdf.service.js) drew its own plain black/green
// text-only header ("RentaPay — <report name>", no color, no mark).
// This gives every one of them the same colored banner with the real
// RentaPay app icon (src/assets/branding/rentapay-logo.png, the exact
// PNG the frontend/PWA/Android app already use) plus the report's own
// title/subtitle/meta - so every downloaded file is instantly
// recognizable as RentaPay's, on the first page and consistently
// across every report type.
//
// Usage, at the very top of any generate*Pdf(res, ...) function,
// right after `doc.pipe(res)`:
//
//   const { drawBrandedHeader, drawBrandedFooter, BRAND } = require('./pdfBranding.service');
//   drawBrandedHeader(doc, {
//     title: 'Monthly Collection Summary',
//     subtitle: propertyName,
//     meta: `Prepared for ${landlordName} · Generated ${generatedAt.toLocaleString('en-GB')}`,
//   });
//   ... draw the rest of the report, doc.y already positioned below the banner ...
//   drawBrandedFooter(doc); // right before doc.end()
//   doc.end();

const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'branding', 'rentapay-logo.png');

// Single source of truth for the palette every branded PDF now shares -
// the same emerald green already used across the web/PWA UI, so a
// downloaded file looks like it came from the same product.
const BRAND = {
  green: '#2e7d32',
  greenDark: '#1b5e20',
  greenPale: '#eaf4ea',
  ink: '#1a1a1a',
  muted: '#888',
  mutedLight: '#c7d9c9',
  rule: '#e0e0e0',
  white: '#ffffff',
};

const PAGE_LEFT = 50;
const PAGE_RIGHT = 545;
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT;
const BANNER_HEIGHT = 72;

/**
 * Draws the full-width colored brand banner (RentaPay green, the real
 * app icon in a white badge, "RentaPay" wordmark + this report's
 * title in white) at the very top of the CURRENT page, then the
 * report's subtitle/meta lines and a rule beneath it. Always starts
 * at y=0 of whatever page doc.y is currently on, so call this first,
 * before drawing anything else.
 *
 * @param {PDFKit.PDFDocument} doc
 * @param {object} opts
 * @param {string} opts.title - right-hand side of the banner, e.g. "Monthly Collection Summary"
 * @param {string} [opts.subtitle] - one line under the banner, e.g. a property/manager/BA name
 * @param {string} [opts.meta] - a second, smaller/greyer line under the subtitle (who it's for, when generated)
 */
function drawBrandedHeader(doc, { title, subtitle, meta } = {}) {
  const pageWidth = doc.page.width;

  // --- Colored banner -------------------------------------------------
  doc.rect(0, 0, pageWidth, BANNER_HEIGHT).fillColor(BRAND.green).fill();
  // A slightly darker strip along the very bottom edge of the banner
  // gives it a touch of depth rather than a flat block of color.
  doc.rect(0, BANNER_HEIGHT - 4, pageWidth, 4).fillColor(BRAND.greenDark).fill();

  // App icon, in a white rounded badge so its own cream backdrop reads
  // cleanly against the green banner.
  const badgeSize = 48;
  const badgeX = PAGE_LEFT;
  const badgeY = (BANNER_HEIGHT - 4 - badgeSize) / 2;
  try {
    doc.roundedRect(badgeX, badgeY, badgeSize, badgeSize, 10).fillColor(BRAND.white).fill();
    doc.image(LOGO_PATH, badgeX + 4, badgeY + 4, { width: badgeSize - 8, height: badgeSize - 8 });
  } catch {
    // If the logo asset is ever missing, don't take the whole PDF down
    // with it - fall back to a plain white badge with no icon.
    doc.roundedRect(badgeX, badgeY, badgeSize, badgeSize, 10).fillColor(BRAND.white).fill();
  }

  // Wordmark + this report's title, both in white, to the right of the badge.
  const textX = badgeX + badgeSize + 14;
  const textWidth = pageWidth - PAGE_LEFT - (pageWidth - PAGE_RIGHT) - badgeSize - 14;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(BRAND.white).text('RentaPay', textX, badgeY + 2, { width: textWidth });
  if (title) {
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.mutedLight).text(title, textX, doc.y + 1, { width: textWidth });
  }

  // --- Below the banner: subtitle + meta -------------------------------
  doc.y = BANNER_HEIGHT + 14;
  doc.x = PAGE_LEFT;
  if (subtitle) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.ink).text(subtitle, PAGE_LEFT, doc.y, { width: PAGE_WIDTH });
  }
  if (meta) {
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.muted).text(meta, PAGE_LEFT, doc.y + 2, { width: PAGE_WIDTH });
  }

  doc.moveDown(0.8);
  doc.strokeColor(BRAND.rule).lineWidth(1).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.8);
  doc.font('Helvetica').fillColor(BRAND.ink);
}

/**
 * A thin colored brand rule + "RentaPay · rentapay.co.ke" line at the
 * bottom of whatever page doc is currently on. Call once, right
 * before doc.end() (i.e. on the last page only) - every branded PDF
 * already carries the header on every page it needs identifying, so
 * the footer just needs to close the document out consistently.
 */
function drawBrandedFooter(doc) {
  // Uses an explicit y comfortably inside the default 50pt bottom
  // margin's printable area (A4 height ~842, margin bottom 50 -> usable
  // area ends ~792) - too close to that edge makes pdfkit think the
  // text overflows and silently starts a fresh blank page for it.
  const bottomY = doc.page.height - 70;
  doc.strokeColor(BRAND.rule).lineWidth(1).moveTo(PAGE_LEFT, bottomY).lineTo(PAGE_RIGHT, bottomY).stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.muted)
    .text('RentaPay · rentapay.co.ke · support@rentapay.co.ke', PAGE_LEFT, bottomY + 6, { width: PAGE_WIDTH, lineBreak: false });
}

module.exports = { drawBrandedHeader, drawBrandedFooter, BRAND, LOGO_PATH, PAGE_LEFT, PAGE_RIGHT, PAGE_WIDTH };
