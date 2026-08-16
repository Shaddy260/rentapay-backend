// src/services/csvBranding.service.js
//
// CSV/tabular downloads can't carry a colored logo header the way
// PDFs can (see pdfBranding.service.js) — spreadsheet apps render the
// first row of actual data as a row, not a banner. What they CAN
// carry is a small, unambiguous identification block: a few metadata
// rows above the real header row, plus a consistent "rentapay-"
// filename prefix, so a CSV sitting in a Downloads folder is
// immediately recognizable as RentaPay's even without opening it —
// matching the branding already applied to every PDF.
//
// Usage, wherever a CSV/TSV string is being sent as a download:
//
//   const { brandCsv, brandedFilename } = require('./csvBranding.service');
//   const csv = brandCsv({
//     title: 'BA Payout Qualification Report',
//     meta: [`Period: ${report.periodKey}`, `Generated ${new Date().toLocaleString('en-GB')}`],
//     body: existingCsvString, // or an array of already-built CSV lines
//   });
//   res.setHeader('Content-Type', 'text/csv; charset=utf-8');
//   res.setHeader('Content-Disposition', `attachment; filename="${brandedFilename('ba-payout-qualification-report', report.periodKey, 'csv')}"`);
//   res.send(csv);

const BRAND_NAME = 'RentaPay';
const TAGLINE = 'rentapay.co.ke';

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

/**
 * Prepends a small identification block (RentaPay + report title +
 * any meta lines + generated timestamp + a blank spacer row) above
 * the real CSV content, so the file is self-identifying the moment
 * it's opened — without disturbing the real header/data rows below it.
 *
 * @param {object} opts
 * @param {string} opts.title - report name, e.g. "BA Payout Qualification Report"
 * @param {string[]} [opts.meta] - extra identification lines (period, manager name, etc.)
 * @param {string|string[]} opts.body - the existing CSV content: either the full
 *   CSV as one string (with its own header/data rows already joined by \n or \r\n),
 *   or an array of already-built CSV line strings.
 * @returns {string} the complete, branded CSV text
 */
function brandCsv({ title, meta = [], body }) {
  const idBlock = [
    csvCell(`${BRAND_NAME} — ${title}`),
    csvCell(TAGLINE),
    ...meta.map((line) => csvCell(line)),
    csvCell(`Generated ${new Date().toLocaleString('en-GB')}`),
    '', // spacer row so the real header row below is visually distinct
  ];

  const bodyLines = Array.isArray(body) ? body : String(body || '').split(/\r?\n/);
  return [...idBlock, ...bodyLines].join('\r\n');
}

/**
 * Builds a consistent, always-"rentapay-"-prefixed filename for any
 * downloadable file (CSV, XLSX, ZIP, ...) — same convention the PDFs
 * already follow. Slugs each part (lowercase, spaces/underscores to
 * hyphens, strips anything not alphanumeric/hyphen) and joins with
 * hyphens, so callers don't have to remember to add the prefix
 * themselves or worry about producing an invalid filename.
 *
 * @param {...(string|number)} parts - filename parts in order, e.g.
 *   ('ba-payout-qualification-report', report.periodKey) or
 *   ('statement', ba.ba_code, range.label)
 * @param {string} ext - file extension without the dot, e.g. 'csv', 'xlsx', 'zip'
 */
function brandedFilename(...args) {
  const ext = args.pop();
  const slug = (v) => String(v).trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
  const parts = args.map(slug).filter(Boolean);
  const joined = parts.join('-');
  const withPrefix = joined.startsWith('rentapay-') ? joined : `rentapay-${joined}`;
  return `${withPrefix}.${ext}`;
}

module.exports = { brandCsv, brandedFilename };
