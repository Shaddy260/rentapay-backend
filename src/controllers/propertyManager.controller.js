// src/controllers/propertyManager.controller.js
//
// Property managers are second-party accounts a landlord adds - like
// adding a tenant, but the account logs into the SAME portal as the
// landlord (not a separate tenant portal) and sees the same data,
// except for a handful of actions locked to the landlord themself
// (see auth.middleware.js requireLandlordOnly / requirePropertyAccess).
//
// A manager can be assigned to one, several, or all of a landlord's
// properties. They still see every property in listings; opening one
// they're not assigned to is blocked with a clear message rather than
// hidden, per the landlord's explicit request.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { hashPassword } = require('../utils/password');
const { generateOTP, getOTPExpiry } = require('../utils/otp');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');

function generateTempPassword() {
  return `Rp${crypto.randomBytes(3).toString('hex')}!`;
}

// ---------------------------------------------------------------------
// FIX (direct request): "in settings, if a given property shows the
// caretaker is not assigned, and the landlord allows access of a
// caretaker or manager to more than one property including that one,
// the system should automatically write the details of that allowed
// caretaker or manager to that apartment." Never overwrites a
// contact that's already set - only fills in a genuinely empty slot,
// so this can't silently clobber a landlord's own manual entry.
// ---------------------------------------------------------------------
async function autoFillPropertyContact(manager, propertyIds) {
  if (!propertyIds.length) return;

  if (manager.role_level === 'caretaker') {
    const { data: props } = await supabase
      .from('properties')
      .select('id, caretaker_name, caretaker_phone')
      .in('id', propertyIds);
    for (const p of props || []) {
      if (!p.caretaker_name && !p.caretaker_phone) {
        await supabase.from('properties').update({ caretaker_name: manager.full_name, caretaker_phone: manager.phone }).eq('id', p.id);
      }
    }
  } else {
    const { data: props } = await supabase
      .from('properties')
      .select('id, primary_contact_manager_id')
      .in('id', propertyIds);
    for (const p of props || []) {
      if (!p.primary_contact_manager_id) {
        await supabase.from('properties').update({ primary_contact_manager_id: manager.id }).eq('id', p.id);
      }
    }
  }
}

// ---------------------------------------------------------------------
// ADD A PROPERTY MANAGER (landlord only)
// roleLevel: 'manager' (full access, scoped to assigned properties) or
// 'caretaker' (same login, but blocked from a handful of destructive/
// financial actions - see auth.middleware.requireNotCaretaker).
// ---------------------------------------------------------------------
async function addManager(req, res) {
  try {
    const landlordId = req.user.id; // landlord-only route - never a manager themself
    const { fullName, email, propertyIds, gender } = req.body;
    let { phone } = req.body;
    let { roleLevel } = req.body;

    const required = { fullName, phone, email };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (gender !== undefined && gender !== null && !['male', 'female'].includes(gender)) {
      return res.status(400).json({ error: "gender must be 'male' or 'female'." });
    }

    roleLevel = roleLevel === 'caretaker' ? 'caretaker' : 'manager';

    try {
      phone = normalizePhoneOrThrow(phone, 'Property manager phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    // "No number should open more than one user account."
    const conflict = await findPhoneConflict(phone, 'manager');
    if (conflict) return res.status(409).json({ error: conflict });

    // Every property in propertyIds must actually belong to this landlord.
    const ids = Array.isArray(propertyIds) ? propertyIds : [];
    if (ids.length) {
      const { data: owned, error: ownedErr } = await supabase
        .from('properties')
        .select('id')
        .eq('landlord_id', landlordId)
        .in('id', ids);
      if (ownedErr) throw ownedErr;
      if ((owned || []).length !== ids.length) {
        return res.status(400).json({ error: 'One or more selected properties do not belong to you.' });
      }
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const otp = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    const { data: landlord } = await supabase.from('landlords').select('full_name').eq('id', landlordId).single();

    const { data: manager, error } = await supabase
      .from('property_managers')
      .insert({
        landlord_id: landlordId,
        full_name: fullName,
        phone,
        email,
        password_hash: passwordHash,
        otp_code: otp,
        otp_expires_at: otpExpiresAt.toISOString(),
        must_change_password: true,
        role_level: roleLevel,
        gender: gender || null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A property manager with this phone number already exists.' });
      throw error;
    }

    if (ids.length) {
      const rows = ids.map((propertyId) => ({ property_manager_id: manager.id, property_id: propertyId }));
      const { error: assignErr } = await supabase.from('property_manager_assignments').insert(rows);
      if (assignErr) throw assignErr;
      await autoFillPropertyContact(manager, ids);
    }

    const emailBody = templates.managerLoginCredentials(fullName, landlord?.full_name || 'Your landlord', tempPassword, otp);
    try {
      await sendEmail(
        email,
        `You've been added to RentaPay${roleLevel === 'caretaker' ? ' as a caretaker' : ' as a property manager'}`,
        wrapEmailHtml(emailBody)
      );
    } catch (emailErr) {
      console.error('[propertyManager] addManager: CRITICAL - login credentials email failed to send:', emailErr.message);
    }

    logActivity({
      actorType: 'landlord',
      actorId: landlordId,
      action: 'property_manager_added',
      targetType: 'property_manager',
      targetId: manager.id,
      metadata: { propertyIds: ids, roleLevel },
    });

    // FIX (direct request): "the details might not be sent - so there
    // should be a table that stores those first-time accounts... the
    // otp and temp password... during creation only." Written once,
    // right here, at the exact moment these specific values are
    // generated - never regenerated or updated afterwards, so this is
    // always what was actually sent (or meant to be sent) at signup,
    // not whatever the current live password happens to be.
    const propertyNames = ids.length
      ? (await supabase.from('properties').select('name').in('id', ids)).data?.map((p) => p.name).join(', ') || null
      : null;
    await supabase.from('first_time_credentials').insert({
      landlord_id: landlordId,
      role: roleLevel, // 'manager' or 'caretaker'
      account_id: manager.id,
      full_name: fullName,
      phone,
      property_name: propertyNames,
      temp_password: tempPassword,
      otp,
      created_by_role: 'landlord',
      // Matches the account's own otp_expires_at (getOTPExpiry(), 24h) -
      // set explicitly rather than relying on the DB column default so
      // the two never drift apart.
      expires_at: otpExpiresAt.toISOString(),
    });

    return res.status(201).json({
      message: 'Property manager added. Login details were sent via email.',
      manager: { ...manager, password_hash: undefined, otp_code: undefined },
      // Shown once, right after creation, as a fallback in case the email
      // doesn't arrive (e.g. no RESEND_API_KEY set, unverified domain) -
      // the landlord can then share it manually instead of assuming it failed.
      tempCredentials: { phone, tempPassword, otp },
    });
  } catch (err) {
    console.error('[propertyManager] addManager error:', err.message);
    return res.status(500).json({ error: 'Failed to add property manager.' });
  }
}

// ---------------------------------------------------------------------
// LIST MANAGERS for the logged-in landlord (or a manager viewing peers -
// allowed read-only so a manager can see who else has access)
// ---------------------------------------------------------------------
async function listManagers(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);

    // FIX ("deleting a manager doesn't delete them"): removeManager
    // only ever soft-deletes (is_active = false) so the record isn't
    // orphaned mid-request, but this listing used to return inactive
    // rows too - so a removed manager kept showing up in the landlord's
    // list exactly as before, looking like the delete silently failed.
    // Only surface active managers here; pass ?includeRemoved=true if
    // a future "removed managers" archive view is ever needed.
    const includeRemoved = req.query.includeRemoved === 'true';
    let query = supabase
      .from('property_managers')
      .select('id, full_name, phone, email, photo_url, is_active, is_verified, role_level, gender, created_at')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false });
    if (!includeRemoved) query = query.eq('is_active', true);

    const { data: managers, error } = await query;
    if (error) throw error;

    const managerIds = (managers || []).map((m) => m.id);
    let assignmentsByManager = {};
    if (managerIds.length) {
      const { data: assignments, error: aErr } = await supabase
        .from('property_manager_assignments')
        .select('property_manager_id, property_id, properties(id, name)')
        .in('property_manager_id', managerIds);
      if (aErr) throw aErr;
      assignmentsByManager = (assignments || []).reduce((acc, a) => {
        acc[a.property_manager_id] = acc[a.property_manager_id] || [];
        acc[a.property_manager_id].push({ id: a.property_id, name: a.properties?.name });
        return acc;
      }, {});
    }

    let result = (managers || []).map((m) => ({ ...m, assignedProperties: assignmentsByManager[m.id] || [] }));

    // FIX (direct request): this applies in both directions - "when a
    // manager is assigned to a property, in settings, he should only
    // see the contact of the caretaker of that property, and the
    // caretaker should only see the contact of the manager of the
    // assigned property only." A manager viewer only ever sees
    // caretakers on properties they share; a caretaker viewer only
    // ever sees managers on properties they share. Neither sees peers
    // of their OWN role level, and neither sees anyone on a property
    // they aren't assigned to. The landlord viewing this page is
    // unaffected - sees everyone, exactly as before.
    if (req.user.role === 'manager') {
      const myAssignedPropertyIds = new Set((assignmentsByManager[req.user.id] || []).map((p) => p.id));
      const wantRoleLevel = req.user.roleLevel === 'caretaker' ? 'manager' : 'caretaker';
      result = result.filter((m) => m.role_level === wantRoleLevel && m.assignedProperties.some((p) => myAssignedPropertyIds.has(p.id)));
    }

    return res.json({ managers: result });
  } catch (err) {
    console.error('[propertyManager] listManagers error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch property managers.' });
  }
}

// ---------------------------------------------------------------------
// EDIT A MANAGER'S OWN CONTACT DETAILS (name/email/phone) - landlord
// editing on the manager's behalf, or the manager editing themself.
// ---------------------------------------------------------------------
async function updateManager(req, res) {
  try {
    const { managerId } = req.params;
    const { fullName, email, gender } = req.body;
    let { phone } = req.body;

    const { data: manager, error: fetchErr } = await supabase.from('property_managers').select('*').eq('id', managerId).single();
    if (fetchErr || !manager) return res.status(404).json({ error: 'Property manager not found.' });

    const isSelf = req.user.role === 'manager' && req.user.id === managerId;
    const isTheirLandlord = req.user.role === 'landlord' && req.user.id === manager.landlord_id;

    // A full manager (not a caretaker themselves) editing someone
    // ELSE's record: only allowed for a caretaker who shares at least
    // one assigned property with them (an unassigned side - no rows in
    // property_manager_assignments - is treated as "all properties",
    // matching how assignment scoping already works everywhere else in
    // this file). A full manager can never edit another full manager,
    // and a caretaker can never edit anyone but themselves.
    let isPermittedPeerEdit = false;
    if (!isSelf && !isTheirLandlord && req.user.role === 'manager' && req.user.roleLevel !== 'caretaker' && manager.role_level === 'caretaker') {
      const [actingManagerProps, targetCaretakerProps] = await Promise.all([
        getManagerAssignedPropertyIds(req.user.id),
        getManagerAssignedPropertyIds(managerId),
      ]);
      const sharesAssignment =
        !actingManagerProps.length ||
        !targetCaretakerProps.length ||
        actingManagerProps.some((p) => targetCaretakerProps.includes(p));
      isPermittedPeerEdit = sharesAssignment;
    }

    if (!isSelf && !isTheirLandlord && !isPermittedPeerEdit && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only edit caretakers assigned to the same apartment(s) as you.' });
    }

    const updateFields = {};
    if (fullName) updateFields.full_name = fullName;
    if (email !== undefined) updateFields.email = email || null;
    if (gender !== undefined) {
      if (gender !== null && !['male', 'female'].includes(gender)) {
        return res.status(400).json({ error: "gender must be 'male', 'female', or null." });
      }
      updateFields.gender = gender;
    }
    if (phone) {
      try {
        phone = normalizePhoneOrThrow(phone, 'Property manager phone number');
        updateFields.phone = phone;
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }

    if (!Object.keys(updateFields).length) return res.status(400).json({ error: 'No fields to update.' });

    const { data: updated, error } = await supabase.from('property_managers').update(updateFields).eq('id', managerId).select().single();
    if (error) throw error;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'property_manager_edited',
      targetType: 'property_manager',
      targetId: managerId,
      metadata: updateFields,
    });

    return res.json({ manager: { ...updated, password_hash: undefined, otp_code: undefined } });
  } catch (err) {
    console.error('[propertyManager] updateManager error:', err.message);
    return res.status(500).json({ error: 'Failed to update property manager.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE WHICH PROPERTIES A MANAGER IS ASSIGNED TO (landlord only)
// ---------------------------------------------------------------------
async function updateAssignments(req, res) {
  try {
    const landlordId = req.user.id;
    const { managerId } = req.params;
    const { propertyIds } = req.body;

    if (!Array.isArray(propertyIds)) return res.status(400).json({ error: 'propertyIds must be an array (can be empty).' });

    const { data: manager, error: fetchErr } = await supabase.from('property_managers').select('*').eq('id', managerId).single();
    if (fetchErr || !manager) return res.status(404).json({ error: 'Property manager not found.' });
    if (manager.landlord_id !== landlordId) return res.status(403).json({ error: 'This property manager does not belong to you.' });

    if (propertyIds.length) {
      const { data: owned, error: ownedErr } = await supabase
        .from('properties')
        .select('id')
        .eq('landlord_id', landlordId)
        .in('id', propertyIds);
      if (ownedErr) throw ownedErr;
      if ((owned || []).length !== propertyIds.length) {
        return res.status(400).json({ error: 'One or more selected properties do not belong to you.' });
      }
    }

    // Replace the assignment set wholesale - simplest correct model for
    // "tap the properties this manager has access to" in the UI.
    await supabase.from('property_manager_assignments').delete().eq('property_manager_id', managerId);
    if (propertyIds.length) {
      const rows = propertyIds.map((propertyId) => ({ property_manager_id: managerId, property_id: propertyId }));
      const { error: insertErr } = await supabase.from('property_manager_assignments').insert(rows);
      if (insertErr) throw insertErr;
      await autoFillPropertyContact(manager, propertyIds);
    }

    if (manager.email) {
      await sendEmail(manager.email, 'Your RentaPay property access was updated', wrapEmailHtml(templates.managerAssignmentsUpdated(manager.full_name))).catch((e) =>
        console.warn('[propertyManager] updateAssignments: email failed (non-fatal):', e.message)
      );
    }

    logActivity({
      actorType: 'landlord',
      actorId: landlordId,
      action: 'property_manager_assignments_updated',
      targetType: 'property_manager',
      targetId: managerId,
      metadata: { propertyIds },
    });

    return res.json({ message: 'Property access updated.', propertyIds });
  } catch (err) {
    console.error('[propertyManager] updateAssignments error:', err.message);
    return res.status(500).json({ error: 'Failed to update property access.' });
  }
}

// ---------------------------------------------------------------------
// REMOVE / DEACTIVATE A MANAGER (landlord only) - deactivate rather
// than hard-delete so activity logs and past actions keep meaning.
// ---------------------------------------------------------------------
async function removeManager(req, res) {
  try {
    const landlordId = req.user.id;
    const { managerId } = req.params;

    const { data: manager, error: fetchErr } = await supabase.from('property_managers').select('*').eq('id', managerId).single();
    if (fetchErr || !manager) return res.status(404).json({ error: 'Property manager not found.' });
    if (manager.landlord_id !== landlordId) return res.status(403).json({ error: 'This property manager does not belong to you.' });

    await supabase.from('property_managers').update({ is_active: false }).eq('id', managerId);
    if (manager.email) {
      await sendEmail(manager.email, 'Your RentaPay access was removed', wrapEmailHtml(templates.managerRemoved(manager.full_name))).catch((e) =>
        console.warn('[propertyManager] removeManager: email failed (non-fatal):', e.message)
      );
    }

    logActivity({
      actorType: 'landlord',
      actorId: landlordId,
      action: 'property_manager_removed',
      targetType: 'property_manager',
      targetId: managerId,
    });

    return res.json({ message: 'Property manager access removed.' });
  } catch (err) {
    console.error('[propertyManager] removeManager error:', err.message);
    return res.status(500).json({ error: 'Failed to remove property manager.' });
  }
}

// ---------------------------------------------------------------------
// "WHOAMI" for a logged-in manager - own profile + which properties
// they can actually manage vs. just see in the list.
// ---------------------------------------------------------------------
async function getMyAccess(req, res) {
  try {
    if (req.user.role !== 'manager') return res.status(403).json({ error: 'This endpoint is for property manager accounts only.' });

    const { data: manager, error } = await supabase
      .from('property_managers')
      .select('id, full_name, phone, email, photo_url, landlord_id, role_level, gender')
      .eq('id', req.user.id)
      .single();
    if (error || !manager) return res.status(404).json({ error: 'Property manager account not found.' });

    const { data: assignments } = await supabase
      .from('property_manager_assignments')
      .select('property_id, properties(name, caretaker_name, caretaker_phone, primary_contact_manager_id, contact_manager:primary_contact_manager_id(full_name, phone))')
      .eq('property_manager_id', manager.id);

    // FIX (direct request): "a manager should only see the contact of
    // the caretaker of that given property, and the caretaker should
    // only see the contact of the manager of the assigned property
    // only." Built per-property (not one merged contact for the whole
    // account) so a manager covering three buildings sees three
    // separate caretaker contacts, not one that might be wrong for
    // two of them.
    const peerContacts = (assignments || []).map((a) => ({
      propertyId: a.property_id,
      propertyName: a.properties?.name,
      peerName: manager.role_level === 'caretaker' ? a.properties?.contact_manager?.full_name : a.properties?.caretaker_name,
      peerPhone: manager.role_level === 'caretaker' ? a.properties?.contact_manager?.phone : a.properties?.caretaker_phone,
      peerRoleLevel: manager.role_level === 'caretaker' ? 'manager' : 'caretaker',
    }));

    return res.json({ manager, assignedPropertyIds: (assignments || []).map((a) => a.property_id), peerContacts });
  } catch (err) {
    console.error('[propertyManager] getMyAccess error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch access details.' });
  }
}

module.exports = {
  addManager,
  listManagers,
  updateManager,
  updateAssignments,
  removeManager,
  getMyAccess,
};
