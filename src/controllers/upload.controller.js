// src/controllers/upload.controller.js
//
// Profile photo upload for landlords and tenants - the "actual upload
// mechanism built separately" the schema comments on photo_url were
// pointing at. Storage lives in a Supabase Storage bucket rather than
// the local filesystem or the database itself, since Railway's
// filesystem is ephemeral (anything written to disk disappears on
// every redeploy) and a base64 blob in Postgres would bloat every
// query that touches the tenants/landlords tables.
//
// ONE-TIME SETUP REQUIRED (not something SQL can do): create a public
// Storage bucket named "profile-photos" in the Supabase dashboard
// under Storage -> New bucket -> name it exactly "profile-photos",
// toggle "Public bucket" on. Without this, uploads will fail with a
// "Bucket not found" error.

const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { effectiveLandlordId, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const sharp = require('sharp');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const BUCKET_NAME = 'profile-photos';

// FIX: the raw uploaded buffer (up to 5MB, full camera resolution)
// used to go straight to storage with no resizing at all, even
// though these photos only ever render as small avatars (32-44px) -
// AccountMenu.jsx, PortalSidebar, tenant lists, etc. Every portal
// load was paying for a multi-MB download to show a badge-sized
// circle. Fixed by resizing + re-encoding server-side before it ever
// reaches Storage:
//   - resize to 512x512 (generous for retina avatars at any size
//     actually used in the UI, cropped to a square via 'cover' so
//     non-square source photos don't get squashed)
//   - .rotate() with no args auto-orients using the image's EXIF
//     orientation tag (phone cameras rely on this), then sharp's
//     default output strips EXIF entirely - also fixes a separate
//     "photo looks sideways" class of bug for free
//   - re-encoded as WebP at quality 82 - small, broadly supported,
//     and normalizes every upload (jpg/png/webp/heic-via-multer) to
//     one predictable format/extension
// Typical result: a 3-4MB phone photo becomes roughly 15-40KB.
async function processProfilePhoto(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(512, 512, { fit: 'cover' })
    .webp({ quality: 82 })
    .toBuffer();
}

// Maps an auth role to the table storing its own photo_url column.
function tableForRole(role) {
  if (role === 'landlord') return 'landlords';
  if (role === 'manager') return 'property_managers';
  // PHASE 6 (BA portal Settings & Profile): brand_ambassadors gets the
  // same photo_url column (see add-brand-ambassador-profile-photo.sql)
  // as every other portal, per ProfilePhotoUpload.jsx's shared
  // upload/remove flow.
  if (role === 'brand_ambassador') return 'brand_ambassadors';
  // FEATURE (direct request): General Manager accounts get a profile
  // picture too, same upload/remove flow as every other portal.
  if (role === 'general_manager') return 'general_managers';
  return 'tenants';
}

async function uploadProfilePhoto(req, res) {
  try {
    const { id, role } = req.user; // set by verifyToken - 'landlord', 'manager', or 'tenant'
    const table = tableForRole(role);

    const file = req.file; // set by upload.middleware.js
    // Always .webp now - every upload gets normalized to this format
    // by processProfilePhoto() below, regardless of what was
    // originally uploaded (jpg/png/webp all converge here).
    const path = `${role}/${id}.webp`;

    let processedBuffer;
    try {
      processedBuffer = await processProfilePhoto(file.buffer);
    } catch (sharpErr) {
      logger.error('[upload] image processing failed, rejecting upload:', sharpErr.message);
      captureException(sharpErr);
      return res.status(400).json({ error: 'That file doesn\'t look like a valid image. Please try a different photo.' });
    }

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(path, processedBuffer, { contentType: 'image/webp', upsert: true });

    if (uploadError) {
      // Most common cause during setup: the bucket doesn't exist yet.
      if (/bucket not found/i.test(uploadError.message)) {
        return res.status(500).json({
          error: 'Photo storage isn\'t set up yet. In Supabase: Storage -> New bucket -> name it "profile-photos" -> make it public.',
        });
      }
      throw uploadError;
    }

    // Best-effort: remove any leftover file from before every upload
    // was normalized to .webp (e.g. an old role/id.jpg sitting next
    // to the new role/id.webp). Not awaited/blocking and failure here
    // is silently ignored - it's just storage tidiness, never
    // user-visible either way.
    supabase.storage.from(BUCKET_NAME).remove([`${role}/${id}.jpg`, `${role}/${id}.png`]).catch(() => {});

    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
    // Cache-bust so the browser doesn't keep showing a stale cached
    // image after someone re-uploads a new photo to the same path.
    const photoUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

    const { error: updateError } = await supabase.from(table).update({ photo_url: photoUrl }).eq('id', id);
    if (updateError) throw updateError;

    logActivity({ actorType: role, actorId: id, action: 'profile_photo_updated', targetType: role, targetId: id });

    return res.json({ photoUrl });
  } catch (err) {
    logger.error('[upload] uploadProfilePhoto error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to upload photo.' });
  }
}

async function removeProfilePhoto(req, res) {
  try {
    const { id, role } = req.user;
    const table = tableForRole(role);

    const { error } = await supabase.from(table).update({ photo_url: null }).eq('id', id);
    if (error) throw error;

    return res.json({ message: 'Profile photo removed.' });
  } catch (err) {
    logger.error('[upload] removeProfilePhoto error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to remove photo.' });
  }
}

// ---------------------------------------------------------------------
// Unit photos (direct request: "features to improve appearance and
// functionality" -> a vacant-unit listing had no photos
// at all, text-only). Same resize/re-upload approach as profile
// photos, just a wider crop (4:3, landscape) since these are room/
// property shots, not avatars, and a separate public bucket
// ("unit-photos") so permissions/lifecycle can differ from profile
// photos if needed later.
//
// ONE-TIME SETUP REQUIRED: create a public Storage bucket named
// "unit-photos" in the Supabase dashboard, same as "profile-photos"
// above.
// ---------------------------------------------------------------------
const UNIT_PHOTOS_BUCKET = 'unit-photos';

async function processUnitPhoto(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(1024, 768, { fit: 'cover' })
    .webp({ quality: 80 })
    .toBuffer();
}

async function uploadUnitPhotos(req, res) {
  try {
    const { unitId } = req.params;
    const { id: landlordId, role } = req.user; // landlord, manager (with edit rights), or caretaker

    // Ownership check: only confirm the unit belongs to this landlord
    // account (effectiveLandlordId handles manager/caretaker accounts
    // resolving to the landlord account they act on behalf of) before
    // letting anyone attach photos to it - otherwise any authenticated
    // landlord could upload photos onto someone else's unit by
    // guessing its id.
    const ownerLandlordId = effectiveLandlordId(req);
    const { data: unit, error: unitErr } = await supabase
      .from('units')
      .select('id, landlord_id, property_id, photo_urls')
      .eq('id', unitId)
      .eq('landlord_id', ownerLandlordId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit) return res.status(404).json({ error: 'Unit not found.' });
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (await blockIfSubscriptionExpired(req, res, ownerLandlordId, unit.property_id || null)) return;

    const existing = Array.isArray(unit.photo_urls) ? unit.photo_urls : [];
    const files = req.files || [];
    const newUrls = [];

    for (let i = 0; i < files.length; i += 1) {
      let processedBuffer;
      try {
        processedBuffer = await processUnitPhoto(files[i].buffer);
      } catch (sharpErr) {
        logger.error('[upload] unit photo processing failed, skipping one file:', sharpErr.message);
        captureException(sharpErr);
        continue; // skip just this file rather than failing the whole batch
      }

      const path = `${unitId}/${Date.now()}-${i}.webp`;
      const { error: uploadError } = await supabase.storage
        .from(UNIT_PHOTOS_BUCKET)
        .upload(path, processedBuffer, { contentType: 'image/webp' });

      if (uploadError) {
        if (/bucket not found/i.test(uploadError.message)) {
          return res.status(500).json({
            error: 'Photo storage isn\'t set up yet. In Supabase: Storage -> New bucket -> name it "unit-photos" -> make it public.',
          });
        }
        logger.error('[upload] uploadUnitPhotos storage error for one file:', uploadError.message);
        captureException(uploadError);
        continue;
      }

      const { data: publicUrlData } = supabase.storage.from(UNIT_PHOTOS_BUCKET).getPublicUrl(path);
      newUrls.push(publicUrlData.publicUrl);
    }

    if (newUrls.length === 0) {
      return res.status(500).json({ error: 'None of the photos could be processed. Please try different files.' });
    }

    // Cap at 5 total, keeping the newest if a landlord re-uploads past
    // the limit rather than silently growing the array forever.
    const combined = [...existing, ...newUrls].slice(-5);

    const { error: updateError } = await supabase.from('units').update({ photo_urls: combined }).eq('id', unitId);
    if (updateError) throw updateError;

    logActivity({ actorType: role, actorId: landlordId, action: 'unit_photos_updated', targetType: 'unit', targetId: unitId });

    return res.json({ photoUrls: combined });
  } catch (err) {
    logger.error('[upload] uploadUnitPhotos error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to upload unit photos.' });
  }
}

async function removeUnitPhoto(req, res) {
  try {
    const { unitId } = req.params;
    const { photoUrl } = req.body;
    const ownerLandlordId = effectiveLandlordId(req);

    const { data: unit, error: unitErr } = await supabase
      .from('units')
      .select('id, property_id, photo_urls')
      .eq('id', unitId)
      .eq('landlord_id', ownerLandlordId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit) return res.status(404).json({ error: 'Unit not found.' });
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const remaining = (Array.isArray(unit.photo_urls) ? unit.photo_urls : []).filter((u) => u !== photoUrl);
    const { error: updateError } = await supabase.from('units').update({ photo_urls: remaining }).eq('id', unitId);
    if (updateError) throw updateError;

    return res.json({ photoUrls: remaining });
  } catch (err) {
    logger.error('[upload] removeUnitPhoto error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to remove photo.' });
  }
}

// FEATURE (direct request: "most units for landlords look similar,
// during addition of photos they have to enter details manually one
// by one... a way to choose whether it should be similar to other
// units... choose either all or one by one"): copies an already-
// uploaded unit's photo_urls onto other units in one request, instead
// of re-uploading the same images unit-by-unit. Deliberately scoped
// to units in the SAME property only - siblings in a different
// property are a different owner's data as far as this feature is
// concerned, per the per-property isolation work (a photo shortcut
// is not worth reopening that boundary for).
async function applyUnitPhotosToOthers(req, res) {
  try {
    const { unitId } = req.params;
    const { targetUnitIds, applyToAll } = req.body;
    const ownerLandlordId = effectiveLandlordId(req);

    const { data: sourceUnit, error: sourceErr } = await supabase
      .from('units')
      .select('id, landlord_id, property_id, photo_urls')
      .eq('id', unitId)
      .eq('landlord_id', ownerLandlordId)
      .maybeSingle();
    if (sourceErr) throw sourceErr;
    if (!sourceUnit) return res.status(404).json({ error: 'Unit not found.' });

    const photoUrls = Array.isArray(sourceUnit.photo_urls) ? sourceUnit.photo_urls : [];
    if (photoUrls.length === 0) {
      return res.status(400).json({ error: 'This unit has no photos yet - add photos here first, then apply them to others.' });
    }

    const propertyAccessError = await checkManagerPropertyAccess(req, sourceUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (await blockIfSubscriptionExpired(req, res, ownerLandlordId, sourceUnit.property_id || null)) return;

    // Same-property only - see the feature comment above for why.
    let query = supabase
      .from('units')
      .select('id, property_id')
      .eq('landlord_id', ownerLandlordId)
      .eq('property_id', sourceUnit.property_id)
      .neq('id', unitId);

    if (!applyToAll) {
      const ids = Array.isArray(targetUnitIds) ? targetUnitIds.filter(Boolean) : [];
      if (ids.length === 0) {
        return res.status(400).json({ error: 'Choose at least one unit, or pick "All units in this property".' });
      }
      query = query.in('id', ids);
    }

    const { data: targets, error: targetsErr } = await query;
    if (targetsErr) throw targetsErr;
    if (!targets || targets.length === 0) {
      return res.status(400).json({ error: 'No matching units found in this property to apply photos to.' });
    }

    // Every target unit is confirmed to be in the SAME property as the
    // source above, so one subscription check for that property covers
    // the whole batch - no need to repeat it per unit.

    const { error: updateError } = await supabase
      .from('units')
      .update({ photo_urls: photoUrls })
      .in('id', targets.map((t) => t.id));
    if (updateError) throw updateError;

    logActivity({
      actorType: req.user.role,
      actorId: ownerLandlordId,
      action: 'unit_photos_applied_to_others',
      targetType: 'unit',
      targetId: unitId,
      metadata: { appliedToUnitIds: targets.map((t) => t.id) },
    });

    return res.json({ appliedCount: targets.length, photoUrls });
  } catch (err) {
    logger.error('[upload] applyUnitPhotosToOthers error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to apply photos to the other units.' });
  }
}

// ---------------------------------------------------------------------
// Utility sub-metering: physical meter photo attached as proof to a
// reading (Section 1 - "the photo exists purely as evidence"). Not
// tied to any existing table row the way profile/unit photos are -
// this just uploads the file and hands back a public URL, which the
// caller then includes as photoUrl in the actual
// POST /api/utility-submetering/meters/:meterId/readings call. Same
// resize approach as unit photos (landscape, since it's a photo of a
// meter dial, not an avatar).
//
// ONE-TIME SETUP REQUIRED: create a public Storage bucket named
// "meter-reading-photos" in the Supabase dashboard, same as the
// other buckets above.
// ---------------------------------------------------------------------
const METER_READING_PHOTOS_BUCKET = 'meter-reading-photos';

async function processMeterReadingPhoto(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(1024, 768, { fit: 'cover' })
    .webp({ quality: 82 })
    .toBuffer();
}

async function uploadMeterReadingPhoto(req, res) {
  try {
    const { id, role } = req.user;
    const file = req.file;

    let processedBuffer;
    try {
      processedBuffer = await processMeterReadingPhoto(file.buffer);
    } catch (sharpErr) {
      logger.error('[upload] meter reading photo processing failed:', sharpErr.message);
      captureException(sharpErr);
      return res.status(400).json({ error: 'That file doesn\'t look like a valid image. Please try a different photo.' });
    }

    const path = `${role}/${id}/${Date.now()}.webp`;
    const { error: uploadError } = await supabase.storage
      .from(METER_READING_PHOTOS_BUCKET)
      .upload(path, processedBuffer, { contentType: 'image/webp', upsert: false });

    if (uploadError) {
      if (/bucket not found/i.test(uploadError.message)) {
        return res.status(500).json({
          error: 'Photo storage isn\'t set up yet. In Supabase: Storage -> New bucket -> name it "meter-reading-photos" -> make it public.',
        });
      }
      throw uploadError;
    }

    const { data: publicUrlData } = supabase.storage.from(METER_READING_PHOTOS_BUCKET).getPublicUrl(path);
    return res.json({ photoUrl: publicUrlData.publicUrl });
  } catch (err) {
    logger.error('[upload] uploadMeterReadingPhoto error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to upload photo.' });
  }
}

module.exports = { uploadProfilePhoto, removeProfilePhoto, uploadUnitPhotos, removeUnitPhoto, applyUnitPhotosToOthers, uploadMeterReadingPhoto };
