// src/middleware/upload.middleware.js
//
// Handles multipart/form-data file uploads for profile photos. Uses
// memory storage (not disk) since the file is immediately re-uploaded
// to Supabase Storage and never needs to touch the local filesystem -
// simpler, and works the same whether the backend runs on Railway,
// locally, or anywhere else with an ephemeral filesystem.

const multer = require('multer');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error('Only JPEG, PNG, or WEBP images are allowed.'));
  }
  cb(null, true);
}

const uploadProfilePhotoMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
}).single('photo'); // frontend must send the file under the field name "photo"

// Wraps multer's callback-style middleware so its errors (file too
// big, wrong type) come back as a clean JSON 400 instead of crashing
// the request or leaking a stack trace.
function handleProfilePhotoUpload(req, res, next) {
  uploadProfilePhotoMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image must be smaller than 5MB.' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No photo was uploaded. Attach a file under the field name "photo".' });
    }
    next();
  });
}

// ---------------------------------------------------------------------
// Expense receipt photo - optional, attached to an expense record.
// Same memory-storage approach as profile photos (immediately
// re-uploaded to Supabase Storage, never touches local disk).
// ---------------------------------------------------------------------
const uploadExpenseReceiptMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WEBP images or a PDF are allowed.'));
    }
    cb(null, true);
  },
}).single('receipt'); // frontend sends the file under field name "receipt"

function handleExpenseReceiptUpload(req, res, next) {
  uploadExpenseReceiptMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Receipt must be smaller than 5MB.' });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    // Unlike profile photos, a receipt is optional - no file is fine.
    next();
  });
}

// ---------------------------------------------------------------------
// Lease/document uploads - PDFs, images, or Word docs, up to 15MB
// (lease agreements and scanned ID copies run larger than a profile
// photo).
// ---------------------------------------------------------------------
const MAX_DOCUMENT_SIZE = 15 * 1024 * 1024; // 15MB
const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const uploadDocumentMiddleware = multer({
  storage,
  limits: { fileSize: MAX_DOCUMENT_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('Only PDF, JPEG, PNG, WEBP, or Word documents are allowed.'));
    }
    cb(null, true);
  },
}).single('file'); // frontend sends the file under field name "file"

function handleDocumentUpload(req, res, next) {
  uploadDocumentMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File must be smaller than 15MB.' });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded. Attach a file under the field name "file".' });
    next();
  });
}

// ---------------------------------------------------------------------
// Unit/vacancy photos (direct request: browsing vacancies had
// no way to see what a unit actually looks like - text-only listings
// on a rental marketplace are a real trust/click-through gap). Up to
// 5 photos per unit, same memory-storage + re-upload-to-Supabase
// approach as everything else here.
// ---------------------------------------------------------------------
const MAX_UNIT_PHOTOS = 5;

const uploadUnitPhotosMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_UNIT_PHOTOS },
  fileFilter,
}).array('photos', MAX_UNIT_PHOTOS); // frontend sends files under field name "photos"

function handleUnitPhotosUpload(req, res, next) {
  uploadUnitPhotosMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each photo must be smaller than 5MB.' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `You can upload up to ${MAX_UNIT_PHOTOS} photos at once.` });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No photos were uploaded. Attach files under the field name "photos".' });
    next();
  });
}

// ---------------------------------------------------------------------
// Community board / marketplace post photos (direct request: posts
// were text-only, with no way to attach a photo). Same memory-storage
// + re-upload-to-Supabase approach and per-file size cap as unit
// photos; capped at 5 photos per post.
// ---------------------------------------------------------------------
const MAX_COMMUNITY_PHOTOS = 5;

const uploadCommunityPhotosMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_COMMUNITY_PHOTOS },
  fileFilter,
}).array('photos', MAX_COMMUNITY_PHOTOS); // frontend sends files under field name "photos"

function handleCommunityPhotosUpload(req, res, next) {
  uploadCommunityPhotosMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each photo must be smaller than 5MB.' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `You can attach up to ${MAX_COMMUNITY_PHOTOS} photos per post.` });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    // Photos are optional on a community post (text-only posts still
    // work exactly as before) - only reject if a request explicitly
    // tries to hit this route with zero files AND no body text, which
    // the controller itself already validates.
    next();
  });
}

// ---------------------------------------------------------------------
// Utility sub-metering: photo of the physical meter attached as proof
// to a reading (Section 1). Single image, same size/type limits as a
// profile photo. Optional at the middleware level - submitReading
// itself enforces "required unless this is a baseline" (see
// utilitySubmetering.controller.js), since a baseline reading is
// allowed to skip the photo.
// ---------------------------------------------------------------------
const uploadMeterReadingPhotoMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
}).single('photo'); // frontend sends the file under field name "photo"

function handleMeterReadingPhotoUpload(req, res, next) {
  uploadMeterReadingPhotoMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Photo must be smaller than 5MB.' });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No photo was uploaded. Attach a file under the field name "photo".' });
    next();
  });
}

module.exports = {
  handleProfilePhotoUpload,
  handleExpenseReceiptUpload,
  handleDocumentUpload,
  handleUnitPhotosUpload,
  handleCommunityPhotosUpload,
  handleMeterReadingPhotoUpload,
};
