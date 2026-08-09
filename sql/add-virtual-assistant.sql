-- =====================================================================
-- Virtual Assistant (Guided Walkthrough) - spec section 1.
--
-- Needs exactly one durable, per-account bit of state: "has this
-- account ever seen the walkthrough". Stored server-side (not
-- localStorage) so a first login from a second device/browser doesn't
-- re-trigger it, and so it survives a cleared browser cache.
--
-- One column added to each of the three role tables that get a
-- walkthrough - landlord, property_managers (covers both Manager and
-- Caretaker, distinguished by role_level), and tenants. Admin is not
-- part of this feature.
--
-- Run this in the Supabase SQL Editor after schema.sql and
-- 2026-07-property-managers.sql (role_level).
-- =====================================================================

alter table landlords add column if not exists has_seen_assistant boolean not null default false;
alter table property_managers add column if not exists has_seen_assistant boolean not null default false;
alter table tenants add column if not exists has_seen_assistant boolean not null default false;
