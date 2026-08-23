-- =====================================================================
-- GENERAL MANAGER ROLE - PER-MANAGER FEATURE TOGGLES
--
-- FEATURE (direct request): admin gets a UI to control, per General
-- Manager, whether that GM can:
--   1. Grant/edit loyalty discounts (they can always VIEW the loyalty
--      discount screens - candidates, active grants, history - this
--      only gates the grant/revoke actions).
--   2. See AND confirm/reject landlord manual subscription payments
--      at all (this one gates visibility too, not just the action -
--      a GM without it doesn't get a "Landlord Manual Payments" menu
--      item in the first place).
--
-- Both default false, so running this migration does not silently
-- grant either capability to any existing General Manager account -
-- admin has to explicitly switch each one on per manager.
-- =====================================================================

alter table general_managers add column if not exists can_grant_loyalty_discounts boolean not null default false;
alter table general_managers add column if not exists can_manage_manual_payments boolean not null default false;

-- Done when: GeneralManagersPanel.jsx's roster has a toggle for each
-- of these per manager, the loyalty-discount grant/revoke endpoints
-- and every landlord-manual-subscription-payment endpoint check the
-- matching flag for a general_manager caller (admin is never gated),
-- and the General Manager's own dashboard only renders the
-- corresponding menu item/controls when the flag is on.
