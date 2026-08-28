// src/services/receiptsExport.service.js
//
// Phase 2 - builds the "all receipts" ZIP as an in-memory buffer so the
// export worker can run it off the request path. The synchronous
// streaming version in payment.controller.js stays untouched as the
// fallback; this is the same query and the same per-receipt PDFs, just
// collected into a Buffer for Supabase Storage.

const supabase = require('../config/supabase');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const { generatePaymentReceiptPdfBuffer } = require('./pdfReport.service');

async function buildReceiptsZipBuffer({ landlordId, propertyId = null, from = null, to = null }) {
  let query = supabase
    .from('payments')
    .select('*, tenants(full_name), units(unit_name, property_id, properties(name)), landlords(full_name), utility_invoices:target_invoice_id(utility_type, month_key, amount, amount_paid, status)')
    .eq('landlord_id', landlordId)
    .eq('status', 'completed')
    .order('paid_at', { ascending: false });

  if (from) query = query.gte('paid_at', from);
  if (to) query = query.lte('paid_at', to);

  const { data: payments, error } = await query;
  if (error) throw error;

  // Filtered in JS (not a query-level join filter, which behaves
  // inconsistently across Supabase client versions) so a property scope
  // is never silently ignored - same as the sync controller.
  const scoped = propertyId ? (payments || []).filter((p) => p.units?.property_id === propertyId) : (payments || []);

  if (!scoped.length) {
    const err = new Error('No completed payments found for the selected filter.');
    err.statusCode = 404;
    throw err;
  }

  const { data: landlordForReceipts } = await supabase.from('landlords').select('kra_pin').eq('id', landlordId).single();

  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  archive.pipe(stream);

  const generatedAt = new Date();
  for (const payment of scoped) {
    const buffer = await generatePaymentReceiptPdfBuffer({
      payment,
      tenantName: payment.tenants?.full_name,
      unitName: payment.units?.unit_name,
      propertyName: payment.units?.properties?.name,
      landlordName: payment.landlords?.full_name,
      landlordKraPin: landlordForReceipts?.kra_pin || null,
      generatedAt,
    });
    const tenantSlug = (payment.tenants?.full_name || 'tenant').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const dateSlug = payment.paid_at ? new Date(payment.paid_at).toISOString().slice(0, 10) : 'undated';
    archive.append(buffer, { name: `${tenantSlug}-${dateSlug}-${payment.id.slice(0, 8)}.pdf` });
  }

  await archive.finalize();
  return finished;
}

module.exports = { buildReceiptsZipBuffer };
