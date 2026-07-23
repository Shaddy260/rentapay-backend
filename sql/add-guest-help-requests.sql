-- Migration: allow pre-login ("guest") help requests
-- Run this if your database was created before this change.
-- Lets the Login page's Help button submit a request before the
-- person has an account/token (blueprint 15: "help before logging in").

alter table help_requests drop constraint if exists help_requests_requester_type_check;
alter table help_requests add constraint help_requests_requester_type_check
  check (requester_type in ('landlord', 'tenant', 'guest'));

alter table help_requests alter column requester_id drop not null;
