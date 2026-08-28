// src/routes/exportJobs.routes.js
//
// Phase 2 - async export endpoints. Each POST creates an export_jobs
// row, enqueues the work on pg-boss, and returns the id immediately:
//
//   { exportJobId: '...', status: 'queued' }
//
// The worker (src/worker.js) builds the file and uploads it to the
// private generated-exports bucket; the frontend polls
// GET /status/:id, then GET /download/:id when it flips to completed.
//
// The original synchronous endpoints (/api/annual-report/...,
// /api/payments/receipts/bulk-download, /api/data-export/me) are left
// untouched as a fallback for deployments that haven't configured the
// worker yet (these routes return 503 when the queue is disabled).

const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { verifyToken, requireRole, effectiveLandlordId } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const {
  createExportJob,
  getExportJob,
  canViewJob,
  markExportStatus,
  signedDownloadUrl,
} = require('../services/exportJob.service');
const { enqueueExport, isQueueEnabled } = require('../services/jobQueue.service');
const logger = require('../utils/logger');

router.use(verifyToken);

const yearParamsSchema = z.object({
  year: z
    .union([z.number().int().positive(), z.string().regex(/^\d{4}$/), z.undefined()])
    .optional(),
  propertyId: z.union([z.string().min(1), z.undefined()]).optional(),
  landlordId: z.union([z.string().min(1), z.undefined()]).optional(),
  kraPin: z.union([z.string(), z.undefined()]).optional(),
});

const receiptsParamsSchema = z.object({
  propertyId: z.union([z.string().min(1), z.undefined()]).optional(),
  from: z.union([z.string().min(1), z.undefined()]).optional(),
  to: z.union([z.string().min(1), z.undefined()]).optional(),
  landlordId: z.union([z.string().min(1), z.undefined()]).optional(),
});

const dataExportParamsSchema = z.object({
  landlordId: z.union([z.string().min(1), z.undefined()]).optional(),
});

function requireQueueEnabled(req, res, next) {
  if (!isQueueEnabled()) {
    return res.status(503).json({
      error: 'Background export worker is not configured on this deployment (missing DATABASE_URL / SUPABASE_DB_URL). Use the direct download buttons instead.',
    });
  }
  next();
}

// Resolves who the export belongs to: admins can pass ?landlordId= for
// any landlord (mirroring the sync admin routes); everyone else is
// scoped to their effective landlord id.
function scopeFor(req) {
  if (req.user.role === 'tenant') {
    // Tenant exports are scoped to the tenant's own data; there is no
    // landlord id to record (the worker uses userId for tenant jobs).
    return { landlordId: null, propertyId: undefined };
  }
  const isAdmin = req.user.role === 'admin';
  if (isAdmin && !req.body.landlordId) {
    return { error: 'landlordId is required for admin exports.' };
  }
  return {
    landlordId: isAdmin ? req.body.landlordId : effectiveLandlordId(req),
    propertyId: req.body.propertyId || undefined,
  };
}

async function enqueue(req, res, jobType, extra = {}) {
  try {
    const scope = scopeFor(req);
    if (scope.error) return res.status(400).json({ error: scope.error });

    const payload = {
      role: req.user.role,
      userId: req.user.id,
      landlordId: scope.landlordId,
      propertyId: scope.propertyId,
      ...extra,
    };

    const job = await createExportJob({
      jobType,
      user: req.user,
      landlordId: scope.landlordId,
      propertyId: scope.propertyId,
      payload,
    });

    const queued = await enqueueExport(jobType, { ...payload, exportJobId: job.id });
    if (!queued) {
      await markExportStatus(job.id, {
        status: 'failed',
        errorMessage: 'Queue unavailable. Check DATABASE_URL configuration.',
        completedAt: new Date().toISOString(),
      });
      return res.status(503).json({ error: 'The export queue is unavailable right now. Please try again shortly.' });
    }

    return res.status(202).json({ exportJobId: job.id, status: job.status });
  } catch (err) {
    logger.error('[exportJobs] enqueue error:', err.message);
    return res.status(500).json({ error: 'Failed to start the export. Please try again.' });
  }
}

// ----- create jobs ----------------------------------------------------
router.post(
  '/annual-report/pdf',
  requireQueueEnabled,
  requireRole('landlord', 'manager', 'admin'),
  validate(yearParamsSchema),
  (req, res) => enqueue(req, res, 'annual_report_pdf', { year: req.body.year || undefined })
);

router.post(
  '/tax-summary/pdf',
  requireQueueEnabled,
  requireRole('landlord', 'manager', 'admin'),
  validate(yearParamsSchema),
  (req, res) => enqueue(req, res, 'tax_summary_pdf', { year: req.body.year || undefined, kraPin: req.body.kraPin || undefined })
);

router.post(
  '/financial-report/csv',
  requireQueueEnabled,
  requireRole('landlord', 'manager', 'admin'),
  validate(yearParamsSchema),
  (req, res) => enqueue(req, res, 'financial_report_csv', { year: req.body.year || undefined })
);

router.post(
  '/receipts-zip',
  requireQueueEnabled,
  requireRole('landlord', 'manager', 'admin'),
  validate(receiptsParamsSchema),
  (req, res) => enqueue(req, res, 'receipts_zip', { from: req.body.from || undefined, to: req.body.to || undefined })
);

router.post(
  '/data-export',
  requireQueueEnabled,
  requireRole('landlord', 'tenant', 'admin'),
  validate(dataExportParamsSchema),
  (req, res) => enqueue(req, res, 'data_export_json')
);

// ----- status + download ----------------------------------------------
router.get('/status/:id', async (req, res) => {
  try {
    const job = await getExportJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Export job not found.' });
    if (!canViewJob(job, req.user)) return res.status(403).json({ error: 'You do not have access to this export.' });
    return res.json({
      exportJobId: job.id,
      status: job.status,
      jobType: job.job_type,
      file_name: job.file_name,
      file_size: job.file_size,
      error_message: job.error_message,
      created_at: job.created_at,
      completed_at: job.completed_at,
    });
  } catch (err) {
    logger.error('[exportJobs] status error:', err.message);
    return res.status(500).json({ error: 'Failed to check the export status.' });
  }
});

router.get('/download/:id', async (req, res) => {
  try {
    const job = await getExportJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Export job not found.' });
    if (!canViewJob(job, req.user)) return res.status(403).json({ error: 'You do not have access to this export.' });
    if (job.status !== 'completed' || !job.file_path) {
      return res.status(409).json({
        error: job.status === 'failed' ? 'This export failed. Please try again.' : 'This export is not ready yet.',
      });
    }
    const downloadUrl = await signedDownloadUrl(job.file_path);
    return res.json({ downloadUrl, file_name: job.file_name });
  } catch (err) {
    logger.error('[exportJobs] download error:', err.message);
    return res.status(500).json({ error: 'Failed to prepare the download.' });
  }
});

module.exports = router;
