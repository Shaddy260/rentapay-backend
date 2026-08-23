-- FEATURE (direct request): General Manager accounts get a profile
-- picture, same as every other portal (landlord, manager, tenant,
-- brand_ambassador) - see ProfilePhotoUpload.jsx / uploadController's
-- tableForRole().
alter table general_managers add column if not exists photo_url text;
