-- Phase 13 - Subscription Coverage Periods & True Monthly Recurring
-- Revenue, and Phase 12 - Admin Revenue Statistics & Pricing Proposal.
--
-- See src/services/coveragePeriod.service.js for the read/write logic
-- that uses this table, and src/services/pricingProposal.service.js
-- for how Phase 12's proposal is calculated from it.

create table if not exists subscription_coverage_periods (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  -- What triggered this record - purely for admin traceability (Phase
  -- 13: "auditable - admin can trace exactly which payment contributed
  -- how much to any given month's MRR"). Not used in any calculation.
  kind text not null check (kind in ('first', 'renewal', 'addon', 'backfill')),
  start_date timestamptz not null,
  end_date timestamptz not null,
  units_covered integer not null check (units_covered > 0),
  amount_paid numeric not null check (amount_paid >= 0),
  -- amount_paid / number of months this period actually covers. This
  -- is the number MRR is summed from - see getMRRForMonth() in
  -- coveragePeriod.service.js.
  normalized_monthly_value numeric not null check (normalized_monthly_value >= 0),
  -- Traceable back to the specific payment that created this period,
  -- where one exists (a landlord-level subscription_payments row, or
  -- the equivalent landlord_manual_subscription_payments row). Null
  -- for the one-time backfill rows below, which have no single payment
  -- to point to.
  subscription_payment_id uuid references subscription_payments(id) on delete set null,
  manual_subscription_payment_id uuid references landlord_manual_subscription_payments(id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists idx_coverage_periods_landlord on subscription_coverage_periods(landlord_id, start_date desc);
-- Powers the MRR range query (WHERE start_date <= :monthEnd AND
-- end_date >= :monthStart) - a plain btree on each bound lets Postgres
-- use both sides of the range check instead of scanning every row.
create index if not exists idx_coverage_periods_range on subscription_coverage_periods(start_date, end_date);

-- ---------------------------------------------------------------------
-- BACKFILL: without this, subscription_coverage_periods starts
-- completely empty, and every currently-paying landlord's real,
-- already-covered months would be invisible to Phase 12/13's MRR and
-- active-landlord calculations on day one - showing MRR of 0 despite a
-- platform full of active subscribers. This creates exactly one
-- 'backfill' coverage period per landlord who currently has a
-- subscription window on record (started_at/expires_at both set),
-- covering their CURRENT period only (not full payment history, which
-- isn't reliably reconstructable landlord-by-landlord from
-- subscription_payments alone once early renewals/mid-cycle add-ons
-- are involved) - amount_paid is approximated from
-- subscription_period_months x unit_limit x the platform's live
-- current price/unit, since the exact amount actually paid for this
-- specific window isn't separately recorded on the landlords row
-- itself. Every real payment from this point forward creates its own
-- properly-sourced coverage period via coveragePeriod.service.js, so
-- this approximation only ever affects the current window for
-- landlords who were already subscribed before this migration ran.
-- ---------------------------------------------------------------------
do $$
declare
  live_price numeric;
begin
  select base_rate_per_unit_per_month into live_price
  from subscription_pricing_settings
  where effective_from <= now()
  order by effective_from desc
  limit 1;

  if live_price is null then
    live_price := 50; -- documented fallback (see subscriptionPricing.service.js's FALLBACK_SETTINGS)
  end if;

  insert into subscription_coverage_periods (landlord_id, kind, start_date, end_date, units_covered, amount_paid, normalized_monthly_value)
  select
    l.id,
    'backfill',
    coalesce(l.subscription_started_at, l.subscription_expires_at - interval '1 month'),
    l.subscription_expires_at,
    greatest(l.unit_limit, 1),
    greatest(l.unit_limit, 1) * live_price * greatest(coalesce(l.subscription_period_months, 1), 1),
    greatest(l.unit_limit, 1) * live_price
  from landlords l
  where l.subscription_expires_at is not null
    and l.subscription_status in ('active', 'suspended')
    and not exists (
      select 1 from subscription_coverage_periods scp where scp.landlord_id = l.id
    );
end $$;
