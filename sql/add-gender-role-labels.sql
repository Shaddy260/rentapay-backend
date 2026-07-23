-- =====================================================================
-- Adds "gender" to landlords and property_managers (direct request:
-- "some landlords are landladies - avoid biasness, ask their gender
-- at setup and display the correct wording"). Nullable, not required
-- retroactively - existing accounts fall back to the neutral label
-- ("Landlord" / "Manager"/"Caretaker") until they set it once in
-- Settings. Tenants aren't included: blueprint never referred to a
-- tenant's role by a gendered noun, so there's nothing to disambiguate
-- there.
-- =====================================================================

alter table landlords add column if not exists gender text
  check (gender in ('male', 'female'));

alter table property_managers add column if not exists gender text
  check (gender in ('male', 'female'));
