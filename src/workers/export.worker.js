// src/workers/export.worker.js
//
// Phase 2 - consumes the 'rentapay-exports' pg-boss queue. Runs ONLY in
// the worker process (src/worker.js). Each handler rebuilds the request
// context the original controller used (role/user/params/query), runs
// the SAME compute functions the sync routes use, captures the output
// to a buffer, uploads it to the private generated-exports bucket, and
// records the finished file on the export_jobs row.

const supabase = require('../config/supabase');
const { getBoss, QUEUE_NAME } = require('../services/jobQueue.service');
const exportJobService = require('../services/exportJob.service');
const { buildReceiptsZipBuffer } = require('../services/receiptsExport.service');
const { buildLandlordExportPayload, buildTenantExportPayload } = require('../services/dataExportPayload.service');
const { computeAnnualPortfolioStatistics, buildFinancialReportCsv } = require('../controllers/annualReport.controller');
const { generateAnnualPortfolioPdf, generateTaxSummaryPdf } = require('../services/annualReport.service');
const { brandCsv, brandedFilename } = require('../services/csvBranding.service');
const logger = require('../utils/logger');
const { PassThrough } = require('stream');

function pdfToBuffer(generateFn, params) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    generateFn(stream, params);
  });
}

// Rebuilds what the controllers read off `req` so the existing compute
// functions run unchanged in the worker.
function buildReqContext(payload) {
  return {
    user: { role: payload.role, id: payload.userId, landlordId: payload.landlordId },
    params: { landlordId: payload.landlordId || undefined },
    query: {
      propertyId: payload.propertyId || undefined,
      year: payload.year || undefined,
      kraPin: payload.kraPin || undefined,
      from: payload.from || undefined,
      to: payload.to || undefined,
    },
  };
}

async function handleJob(job) {
  const { type, payload } = job.data;
  const jobRow = await exportJobService.getExportJob(payload.exportJobId);
  if (!jobRow) {
    logger.warn('[exportWorker] export_jobs row missing for job', { jobId: job.id });
    return;
  }

  await exportJobService.markExportStatus(jobRow.id, { status: 'processing', startedAt: new Date().toISOString() });

  try {
    let buffer;
    let fileName;
    let contentType;

    if (type === 'annual_report_pdf' || type === 'tax_summary_pdf') {
      const req = buildReqContext(payload);
      const result = await computeAnnualPortfolioStatistics(req);
      if (result.error) throw new Error(result.error.error || 'Nothing to export for the selected year.');
      const { data: landlord } = await supabase.from('landlords').select('full_name').eq('id', payload.landlordId).maybeSingle();
      const params = {
        landlordName: landlord?.full_name || 'Landlord',
        generatedAt: new Date(),
        report: result.data,
      };
      if (type === 'annual_report_pdf') {
        buffer = await pdfToBuffer(generateAnnualPortfolioPdf, params);
        fileName = `rentapay-annual-report-${result.data.year}.pdf`;
      } else {
        params.kraPin = payload.kraPin || null;
        buffer = await pdfToBuffer(generateTaxSummaryPdf, params);
        fileName = `rentapay-tax-summary-${result.data.year}.pdf`;
      }
      contentType = 'application/pdf';
    } else if (type === 'financial_report_csv') {
      const req = buildReqContext(payload);
      const result = await computeAnnualPortfolioStatistics(req);
      if (result.error) throw new Error(result.error.error || 'Nothing to export for the selected year.');
      const csv = brandCsv({
        title: 'Annual Financial Report',
        meta: [`Tax year: ${result.data.year}`],
        body: buildFinancialReportCsv(result.data),
      });
      buffer = Buffer.from(csv, 'utf8');
      fileName = brandedFilename('financial-report', result.data.year, 'csv');
      contentType = 'text/csv; charset=utf-8';
    } else if (type === 'receipts_zip') {
      buffer = await buildReceiptsZipBuffer({
        landlordId: payload.landlordId,
        propertyId: payload.propertyId || null,
        from: payload.from || null,
        to: payload.to || null,
      });
      fileName = `rentapay-receipts-${new Date().toISOString().slice(0, 10)}.zip`;
      contentType = 'application/zip';
    } else if (type === 'data_export_json') {
      const exportPayload = payload.role === 'tenant'
        ? await buildTenantExportPayload(payload.userId)
        : await buildLandlordExportPayload(payload.landlordId);
      buffer = Buffer.from(JSON.stringify(exportPayload, null, 2), 'utf8');
      fileName = payload.role === 'tenant'
        ? `rentapay-my-data-export-${new Date().toISOString().slice(0, 10)}.json`
        : `rentapay-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      contentType = 'application/json';
    } else {
      throw new Error(`Unknown job type: ${type}`);
    }

    const filePath = await exportJobService.uploadExportFile(jobRow, buffer, fileName, contentType);
    await exportJobService.markExportStatus(jobRow.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      filePath,
      fileName,
      fileSize: buffer.length,
    });
    logger.info('[exportWorker] export completed', { id: jobRow.id, type, file: fileName, bytes: buffer.length });
  } catch (err) {
    logger.error('[exportWorker] export failed', err);
    await exportJobService.markExportStatus(jobRow.id, {
      status: 'failed',
      errorMessage: err.message,
      completedAt: new Date().toISOString(),
    });
  }
}

async function startExportWorker() {
  const boss = await getBoss();
  if (!boss) throw new Error('DATABASE_URL / SUPABASE_DB_URL missing - cannot start the export worker.');
  await boss.work(QUEUE_NAME, { teamSize: 2 }, handleJob);
  logger.info('[exportWorker] listening for export jobs', { queue: QUEUE_NAME });
}

module.exports = { startExportWorker };
