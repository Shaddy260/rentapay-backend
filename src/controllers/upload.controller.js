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
const { effectiveLandlordId } = require('../middleware/auth.middleware');
const sharp = require('sharp');

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
// THE FIX: this used to bucket everything that wasn't 'landlord' or
// 'manager' into 'tenants' - meaning a Scout uploading their own
// profile photo updated (or rather, tried to update and silently
// matched zero rows in) the tenants table under their own id, so the
// upload always "succeeded" but the photo never actually saved and
// their portal kept showing no picture at all. Same class of bug the
// property_managers fix above already covers - scouts get their own
// branch now instead of falling through to the tenants default.
function tableForRole(role) {
  if (role === 'landlord') return 'landlords';
  if (role === 'manager') return 'property_managers';
  if (role === 'scout') return 'scouts';
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
      console.error('[upload] image processing failed, rejecting upload:', sharpErr.message);
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
    console.error('[upload] uploadProfilePhoto error:', err.message);
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
    console.error('[upload] removeProfilePhoto error:', err.message);
    return res.status(500).json({ error: 'Failed to remove photo.' });
  }
}

// ---------------------------------------------------------------------
// Unit photos (direct request: "features to improve appearance and
// functionality" -> a vacant-unit listing scouts browse had no photos
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
      .select('id, landlord_id, photo_urls')
      .eq('id', unitId)
      .eq('landlord_id', ownerLandlordId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit) return res.status(404).json({ error: 'Unit not found.' });

    const existing = Array.isArray(unit.photo_urls) ? unit.photo_urls : [];
    const files = req.files || [];
    const newUrls = [];

    for (let i = 0; i < files.length; i += 1) {
      let processedBuffer;
      try {
        processedBuffer = await processUnitPhoto(files[i].buffer);
      } catch (sharpErr) {
        console.error('[upload] unit photo processing failed, skipping one file:', sharpErr.message);
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
        console.error('[upload] uploadUnitPhotos storage error for one file:', uploadError.message);
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
    console.error('[upload] uploadUnitPhotos error:', err.message);
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
      .select('id, photo_urls')
      .eq('id', unitId)
      .eq('landlord_id', ownerLandlordId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit) return res.status(404).json({ error: 'Unit not found.' });

    const remaining = (Array.isArray(unit.photo_urls) ? unit.photo_urls : []).filter((u) => u !== photoUrl);
    const { error: updateError } = await supabase.from('units').update({ photo_urls: remaining }).eq('id', unitId);
    if (updateError) throw updateError;

    return res.json({ photoUrls: remaining });
  } catch (err) {
    console.error('[upload] removeUnitPhoto error:', err.message);
    return res.status(500).json({ error: 'Failed to remove photo.' });
  }
}

module.exports = { uploadProfilePhoto, removeProfilePhoto, uploadUnitPhotos, removeUnitPhoto };
