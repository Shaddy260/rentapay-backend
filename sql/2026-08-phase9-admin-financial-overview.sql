-- 2026-08-phase9-admin-financial-overview.sql
--
-- Premium Redesign Plan - Phase 9: Admin Financial Overview & Expense
-- Tracking.
--
-- "Amount earned" and "Amount owed to BAs" are both derived from
-- existing tables (subscription_payments, ba_commission_earnings -
-- see Section E) - nothing new needed for those. The only new storage
-- Phase 9 needs is platform-level EXPENSES: custom, free-form entries
-- (no fixed category list), one-time or recurring, viewed per month.
--
-- Deliberately a separate table from the existing landlord-scoped
-- `expenses` (see add-expenses.sql) - that table is a landlord/
-- manager logging their own property costs; this one is RentaPay's
-- own platform-level operating expenses, entered by admin, feeding
-- the platform Profit figure (not any landlord's).

create table if not exists admin_expenses (
  id uuid primary key default gen_random_uuid(),

  -- Free-form custom log entry - no predefined category list, per
  -- spec ("admin freely enters a description/label and amount for
  -- each one").
  label text not null,
  amount numeric(12,2) not null check (amount > 0),

  recurrence text not null default 'one_time' check (recurrence in ('one_time', 'recurring')),

  -- For a one-time expense: the single month it applies to, e.g.
  -- '2026-08-01' (always stored as the 1st of that month for a clean
  -- equality/range check against the month being viewed).
  -- For a recurring expense: the month it STARTS repeating from -
  -- every month from here forward automatically includes it, until
  -- stopped (recurrence_ends_at) or the row is deleted.
  month_key date not null,

  -- Set when a recurring expense is stopped from a given month
  -- onward, without deleting its history from earlier months it
  -- already applied to. NULL = still recurring indefinitely.
  recurrence_ends_at date,

  created_by_admin_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_admin_expenses_month on admin_expenses (month_key);
create index if not exists idx_admin_expenses_recurrence on admin_expenses (recurrence);
