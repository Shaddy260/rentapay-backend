// src/controllers/dataExport.controller.js
//
// Direct request: a GDPR-style "export my data" for a landlord who's
// leaving (or just wants a local backup). Pulls together everything
// RentaPay holds under that landlord's account - properties, units,
// tenants, payments, expenses, maintenance requests, documents
// (metadata only, not the files themselves), announcements, and
// property managers - into a single JSON file the landlord can keep.
//
// Deliberately left OUT of the export: password hashes, OTP codes,
// OTP expiry, failed-login/lockout counters, and reset tokens for any
// account included (landlord, tenants, managers) - none of that is
// "the landlord's data" in the sense this feature is for, and shipping
// it back to the browser as a downloadable file would be a needless
// credential-leak surface for zero benefit to the landlord.
//
// Phase 2: the payload builders moved to
// services/dataExportPayload.service.js so the synchronous download
// here and the async export worker produce byte-identical JSON.

const { effectiveLandlordId } = require('../middleware/auth.middleware');
const { captureException } = require('../services/sentry.service');
const { buildLandlordExportPayload, buildTenantExportPayload } = require('../services/dataExportPayload.service');
const logger = require('../utils/logger');

async function exportMyData(req, res) {
  try {
    if (req.user.role === 'tenant') return exportTenantData(req, res);

    const landlordId = effectiveLandlordId(req);
    if (req.user.role === 'manager') {
      return res.status(403).json({ error: 'Only the landlord account owner can export account data.' });
    }

    const exportPayload = await buildLandlordExportPayload(landlordId);

    const filename = `rentapay-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportPayload, null, 2));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.error || err.message });
    logger.error('[dataExport] exportMyData error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate data export.' });
  }
}

// The same self-service export, scoped to a single tenant's own data -
// their profile, payments, maintenance requests, document records, and
// reputation ratings. See services/dataExportPayload.service.js.
async function exportTenantData(req, res) {
  try {
    const exportPayload = await buildTenantExportPayload(req.user.id);

    const filename = `rentapay-my-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportPayload, null, 2));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.error || err.message });
    logger.error('[dataExport] exportTenantData error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate data export.' });
  }
}

module.exports = { exportMyData, exportTenantData };
