-- =====================================================================
-- Lease / document storage. Files themselves live in a Supabase
-- Storage bucket (see document.controller.js) - this table just
-- records the metadata + a pointer to the stored object.
--
-- ONE-TIME SETUP REQUIRED (not something SQL can do): create a
-- Storage bucket named exactly "lease-documents" in the Supabase
-- dashboard under Storage -> New bucket. Leave "Public bucket" OFF -
-- leases are sensitive, so files are served through short-lived
-- signed URLs (see document.controller.js) rather than a public URL.
--
-- Design decision (flagged, built as follows unless told otherwise):
-- landlord/manager can upload a lease to a tenant; the tenant can
-- view/download their own lease but cannot delete it - only the
-- landlord/manager who uploaded it (or another manager on the same
-- property) can remove it.
-- =====================================================================

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete cascade,
  unit_id uuid references units(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,

  file_path text not null,   -- path inside the "lease-documents" bucket
  file_url text,             -- last-generated signed URL (short-lived; regenerated on read, kept only for reference)
  label text not null,       -- e.g. "Lease agreement 2026", "ID copy"
  mime_type text,
  file_size int,

  uploaded_by_type text not null, -- 'landlord' | 'manager'
  uploaded_by_id uuid not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_documents_landlord on documents(landlord_id);
create index if not exists idx_documents_tenant on documents(tenant_id);
create index if not exists idx_documents_unit on documents(unit_id);
