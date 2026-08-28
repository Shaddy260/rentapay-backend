// src/services/exportJob.service.js
//
// Phase 2 - app-level metadata + storage handling for async exports.
// The number crunching itself happens in the worker
// (src/workers/export.worker.js); this service owns:
//   - the export_jobs table row (who asked, what, status)
//   - uploading finished files to the private `generated-exports` bucket
//   - handing back short-lived signed download URLs

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const BUCKET = 'generated-exports';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

const JOB_TYPES = [
  'annual_report_pdf',
  'tax_summary_pdf',
  'financial_report_csv',
  'receipts_zip',
  'data_export_json',
];

function assertJobType(jobType) {
  if (!JOB_TYPES.includes(jobType)) {
    const err = new Error(`Unknown export job type: ${jobType}`);
    err.statusCode = 400;
    throw err;
  }
}

async function createExportJob({ jobType, user, landlordId = null, propertyId = null, payload = {} }) {
  assertJobType(jobType);
  const { data, error } = await supabase
    .from('export_jobs')
    .insert({
      job_type: jobType,
      requested_by_user_id: user.id,
      requested_by_role: user.role,
      landlord_id: landlordId,
      property_id: propertyId,
      payload,
      status: 'queued',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getExportJob(id) {
  const { data, error } = await supabase.from('export_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

function canViewJob(job, user) {
  if (user.role === 'admin') return true;
  return Boolean(job && job.requested_by_user_id === user.id);
}

async function markExportStatus(id, { status, startedAt = null, completedAt = null, filePath = null, fileName = null, fileSize = null, errorMessage = null }) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (startedAt) patch.started_at = startedAt;
  if (completedAt) patch.completed_at = completedAt;
  if (filePath) patch.file_path = filePath;
  if (fileName) patch.file_name = fileName;
  if (fileSize != null) patch.file_size = fileSize;
  if (errorMessage) patch.error_message = errorMessage;
  const { error } = await supabase.from('export_jobs').update(patch).eq('id', id);
  if (error) logger.error('[exportJob] markExportStatus failed', error);
}

async function uploadExportFile(job, buffer, fileName, contentType) {
  const filePath = `exports/${job.job_type}/${job.id}-${fileName}`;
  const { error } = await supabase.storage.from(BUCKET).upload(filePath, buffer, {
    contentType,
    upsert: true,
  });
  if (error) {
    const err = new Error(`Failed to upload generated file: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }
  return filePath;
}

async function signedDownloadUrl(filePath) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

module.exports = {
  JOB_TYPES,
  BUCKET,
  createExportJob,
  getExportJob,
  canViewJob,
  markExportStatus,
  uploadExportFile,
  signedDownloadUrl,
};
