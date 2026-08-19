-- =====================================================================
-- UTILITY SUB-METERING - Full Build Spec (Sections 1-7)
--
-- Core entities:
--   utility_meters      - one row per physical meter. is_shared=false ->
--                          tied to exactly one unit (via
--                          utility_meter_units). is_shared=true -> tied
--                          to multiple units, split proportionally by
--                          occupied-days each month (Section 5).
--   utility_meter_units  - join table: which unit(s) a meter covers.
--                          Exactly one row for an individual meter,
--                          many rows for a shared meter.
--   utility_readings     - one row per submitted reading (a meter +
--                          month). Includes the baseline/"previous"
--                          reading as a regular row with
--                          is_baseline=true and no usage/amount yet.
--   utility_reading_corrections - Section 2's mandatory-reason
--                          correction log - who/when/reason/old/new,
--                          one row per correction, readings themselves
--                          are updated in place.
--   utility_billing_runs / utility_billing_run_units - Section 6/7's
--                          draft review state -> finalized submission.
--                          A run is the proposed-or-finalized outcome
--                          for one reading (individual: 1 run-unit row;
--                          shared: many run-unit rows, one per occupied
--                          unit). Overrides + their mandatory reasons
--                          live per run-unit row.
-- =====================================================================

create table if not exists utility_meters (
  id uuid primary key default gen_random_uuid(),
  landlord_id text not null,
  property_id uuid references properties(id) on delete cascade,
  label text not null,                 -- e.g. "Main water meter - Block A"
  utility_type text not null check (utility_type in ('water', 'electricity')),
  is_shared boolean not null default false,
  rate_per_unit numeric not null,      -- landlord-set KES per unit of consumption
  created_by_role text,
  created_by_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_utility_meters_landlord on utility_meters (landlord_id);
create index if not exists idx_utility_meters_property on utility_meters (property_id);

-- Section 1 (individual) + Section 4 (shared): which unit(s) a meter
-- covers. An individual meter has exactly one row here; a shared
-- meter has one row per unit it serves.
create table if not exists utility_meter_units (
  id uuid primary key default gen_random_uuid(),
  meter_id uuid not null references utility_meters(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (meter_id, unit_id)
);

create index if not exists idx_utility_meter_units_meter on utility_meter_units (meter_id);
create index if not exists idx_utility_meter_units_unit on utility_meter_units (unit_id);

-- Section 1/2: one row per (meter, month) reading, including the
-- baseline row (is_baseline=true, no usage/amount computed against it
-- since there's nothing before it).
create table if not exists utility_readings (
  id uuid primary key default gen_random_uuid(),
  meter_id uuid not null references utility_meters(id) on delete cascade,
  month_key text not null,            -- 'YYYY-MM', explicitly selected (Section 1)
  reading_value numeric not null,
  photo_url text,                     -- optional proof photo (any reading, including non-baseline)
  is_baseline boolean not null default false,
  submitted_by_role text not null,
  submitted_by_id text not null,
  usage_amount numeric,               -- this reading minus the previous one (individual meters only - shared meters' usage lives on the billing run instead, since it's split per unit)
  anomaly_flag boolean not null default false,
  anomaly_reason text,
  status text not null default 'submitted' check (status in ('submitted', 'in_review', 'finalized')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Section 1's duplicate protection: one reading per meter per month,
  -- full stop (the baseline counts as the "reading" for its month too).
  unique (meter_id, month_key)
);

create index if not exists idx_utility_readings_meter on utility_readings (meter_id, month_key desc);

-- Section 2: mandatory-reason correction log for any past reading,
-- baseline included. The reading row itself is updated in place;
-- this table is the append-only audit trail.
create table if not exists utility_reading_corrections (
  id uuid primary key default gen_random_uuid(),
  reading_id uuid not null references utility_readings(id) on delete cascade,
  changed_by_role text not null,
  changed_by_id text not null,
  reason text not null,
  old_value numeric not null,
  new_value numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_utility_reading_corrections_reading on utility_reading_corrections (reading_id);

-- Section 6/7: the review-then-finalize draft. One run per submitted
-- (non-baseline) reading. Stays a pure draft (billing_run_units only)
-- until finalized_at is stamped - nothing tenant-facing happens before
-- that (Section 6's "nothing sent to any tenant during review").
create table if not exists utility_billing_runs (
  id uuid primary key default gen_random_uuid(),
  reading_id uuid not null unique references utility_readings(id) on delete cascade,
  meter_id uuid not null references utility_meters(id) on delete cascade,
  month_key text not null,
  total_usage numeric not null,
  status text not null default 'draft' check (status in ('draft', 'finalized')),
  finalized_at timestamptz,
  finalized_by_role text,
  finalized_by_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_utility_billing_runs_reading on utility_billing_runs (reading_id);

-- One row per occupied unit in the run (individual meter -> exactly
-- one row; shared meter -> one row per occupied unit in that month's
-- split). occupied_days/amount here are the CURRENT proposed/finalized
-- values - overriding either recalculates the whole run's rows live
-- (Section 6), and whatever's here at finalize time is what gets
-- locked in and appended to the tenant's invoice (Section 7).
create table if not exists utility_billing_run_units (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references utility_billing_runs(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  occupied_days numeric not null,
  occupied_days_overridden boolean not null default false,
  occupied_days_override_reason text,
  computed_amount numeric not null,   -- what the formula produced, before any amount override
  final_amount numeric not null,      -- what actually gets billed - equals computed_amount unless overridden
  amount_overridden boolean not null default false,
  amount_override_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, unit_id)
);

create index if not exists idx_utility_billing_run_units_run on utility_billing_run_units (run_id);

create or replace function set_utility_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_utility_meters_updated_at on utility_meters;
create trigger trg_utility_meters_updated_at before update on utility_meters for each row execute function set_utility_updated_at();

drop trigger if exists trg_utility_readings_updated_at on utility_readings;
create trigger trg_utility_readings_updated_at before update on utility_readings for each row execute function set_utility_updated_at();

drop trigger if exists trg_utility_billing_runs_updated_at on utility_billing_runs;
create trigger trg_utility_billing_runs_updated_at before update on utility_billing_runs for each row execute function set_utility_updated_at();

drop trigger if exists trg_utility_billing_run_units_updated_at on utility_billing_run_units;
create trigger trg_utility_billing_run_units_updated_at before update on utility_billing_run_units for each row execute function set_utility_updated_at();
