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

module.exports = {
  handleProfilePhotoUpload,
  handleExpenseReceiptUpload,
  handleDocumentUpload,
};
