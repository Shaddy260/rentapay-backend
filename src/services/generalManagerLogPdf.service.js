// src/services/generalManagerLogPdf.service.js
//
// RentaPay — General Manager Sectioned Build Spec, Section 9.
//
// "From a General Manager's log page, logs can be exported as a
// styled PDF report - branded, with clean typographic hierarchy, not
// a bare table dump - and downloaded directly. This export supports a
// date-range selection, so admin can pull a complete, presentable
// record of 'everything this General Manager did within this specific
// window' as a shareable document."
//
// Built with pdfkit, matching the same header/rule/pagination
// conventions already used platform-wide for branded PDFs (see
// pdfReport.service.js, baPayoutQualificationReportPdf.service.js,
// annualReport.service.js) rather than introducing a new PDF pattern.
// Reads generalManagerActivityLog.service.js's listManagerLogsBetween()
// - the exact same rows the log page (Section 8) already renders, so
// the PDF is never out of sync with what admin sees on screen.

const PDFDocument = require('pdfkit');
const { drawBrandedHeader, drawBrandedFooter } = require('./pdfBranding.service');

const INK = '#1a1a1a';
const GREEN = '#2e7d32';
const MUTED = '#888';
const RULE = '#e0e0e0';
const REVERTED_RED = '#c62828';

const PAGE_LEFT = 50;
const PAGE_RIGHT = 545;
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT;
const PAGE_BOTTOM = 780;

function humanize(action) {
  return String(action || '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB');
}

function fmtValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > PAGE_BOTTOM) {
    doc.addPage();
    doc.y = 50;
  }
}

function drawHeader(doc, { managerName, rangeLabel, generatedAt, totalCount }) {
  drawBrandedHeader(doc, {
    title: 'General Manager Activity Log',
    subtitle: managerName || 'General Manager',
    meta: `Range: ${rangeLabel} · Generated ${generatedAt.toLocaleString('en-GB')} · ${totalCount} action${totalCount === 1 ? '' : 's'} in this range`,
  });
}

// One log entry, rendered as a self-contained block: title/timestamp
// header, mandatory reason, a compact before/after/context section
// (only the pieces that are actually present), and a subtle divider.
// Mirrors what GmActivityLogView.jsx's GmLogEntry card shows on
// screen (Section 8), just laid out for print instead of a
// collapsible <details>-style toggle.
function drawLogEntry(doc, log) {
  ensureSpace(doc, 70);

  const headerY = doc.y;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
    .text(log.data_type || humanize(log.action), PAGE_LEFT, headerY, { width: PAGE_WIDTH - 90 });

  if (log.reverted_at) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(REVERTED_RED)
      .text('REVERTED', PAGE_RIGHT - 80, headerY, { width: 80, align: 'right' });
  }

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
    [fmtDateTime(log.created_at), log.affected_role, log.affected_person_label].filter(Boolean).join('  ·  '),
    PAGE_LEFT,
    doc.y,
    { width: PAGE_WIDTH }
  );
  doc.moveDown(0.25);

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444').text('Reason: ', PAGE_LEFT, doc.y, { continued: true });
  doc.font('Helvetica').fillColor('#333').text(log.reason || '(no reason recorded)');
  doc.moveDown(0.15);

  if (log.initial_data != null || log.corrected_data != null) {
    ensureSpace(doc, 30);
    const colWidth = (PAGE_WIDTH - 20) / 2;
    const rowY = doc.y;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#666').text('BEFORE', PAGE_LEFT, rowY, { width: colWidth });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#666').text('AFTER', PAGE_LEFT + colWidth + 20, rowY, { width: colWidth });
    doc.moveDown(0.2);
    const valuesY = doc.y;
    doc.font('Helvetica').fontSize(7.5).fillColor('#333')
      .text(fmtValue(log.initial_data), PAGE_LEFT, valuesY, { width: colWidth });
    const afterHeight = doc.heightOfString(fmtValue(log.corrected_data), { width: colWidth, fontSize: 7.5 });
    doc.font('Helvetica').fontSize(7.5).fillColor('#333')
      .text(fmtValue(log.corrected_data), PAGE_LEFT + colWidth + 20, valuesY, { width: colWidth });
    const beforeHeight = doc.heightOfString(fmtValue(log.initial_data), { width: colWidth, fontSize: 7.5 });
    doc.y = valuesY + Math.max(beforeHeight, afterHeight, 10);
    doc.moveDown(0.15);
  }

  if (log.context) {
    ensureSpace(doc, 20);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#666').text('OTHER CONTEXT', PAGE_LEFT, doc.y);
    doc.font('Helvetica').fontSize(7.5).fillColor('#333').text(fmtValue(log.context), PAGE_LEFT, doc.y, { width: PAGE_WIDTH });
    doc.moveDown(0.15);
  }

  if (log.reverted_at) {
    doc.font('Helvetica').fontSize(7.5).fillColor(REVERTED_RED)
      .text(`Reverted ${fmtDateTime(log.reverted_at)} by ${log.reverted_by || 'admin'}`, PAGE_LEFT, doc.y);
    doc.moveDown(0.15);
  }

  doc.moveDown(0.15);
  doc.strokeColor(RULE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
  doc.moveDown(0.4);
}

/**
 * Streams a styled, branded PDF of one General Manager's activity log
 * for a given date range directly to the response.
 * @param {import('express').Response} res
 * @param {{ managerName: string, rangeLabel: string, logs: object[] }} data
 */
function generateGmActivityLogPdf(res, { managerName, rangeLabel, logs }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  const generatedAt = new Date();
  drawHeader(doc, { managerName, rangeLabel, generatedAt, totalCount: (logs || []).length });

  if (!logs || logs.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor('#666').text('No activity recorded in this date range.', PAGE_LEFT);
  } else {
    logs.forEach((log) => drawLogEntry(doc, log));
  }

  drawBrandedFooter(doc);
  doc.end();
}

module.exports = { generateGmActivityLogPdf };
