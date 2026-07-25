-- =====================================================================
-- Expense tracking. Lets a landlord/manager log property-level costs
-- (repairs, utilities, staff, etc.) so the PDF "monthly collection
-- summary" can show real net profit (collections - expenses) instead
-- of collections alone. Scoped to a property, not a unit - most
-- expenses (e.g. "roof repair", "security guard salary") apply to the
-- whole apartment rather than any one unit.
-- =====================================================================

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,

  category text not null, -- e.g. 'Repairs', 'Utilities', 'Staff', 'Other'
  amount numeric(12,2) not null check (amount > 0),
  date date not null default current_date,
  note text,
  receipt_photo_url text,

  created_by_type text not null, -- 'landlord' | 'manager'
  created_by_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_expenses_landlord on expenses(landlord_id);
create index if not exists idx_expenses_property_date on expenses(property_id, date);
