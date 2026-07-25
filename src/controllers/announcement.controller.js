const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
const { notify } = require('../services/notify.service');

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

// Same shape used for announcement_reads AND announcement_hidden - a
// caretaker is stored as role='manager' (+ roleLevel 'caretaker'), so
// it collapses into the same 'manager' recipient_type as a full
// property manager, exactly like the rest of the app treats them for
// row-ownership purposes.
function recipientTypeFor(role) {
  if (role === 'tenant') return 'tenant';
  if (role === 'manager') return 'manager';
  if (role === 'scout') return 'scout';
  return 'landlord';
}

// What actually SENT this announcement, as a role tag rather than a
// database detail - 'caretaker' is tracked distinctly from 'manager'
// here (unlike recipientTypeFor above) because the whole point of this
// field is showing the tenant/landlord/manager WHO sent it.
function senderRoleFor(req) {
  if (req.user.role === 'landlord') return 'landlord';
  if (req.user.role === 'manager') return req.user.roleLevel === 'caretaker' ? 'caretaker' : 'manager';
  return 'system';
}

// Resolves "who actually did this" as a person's name + role label,
// for system messages that need to read "your landlord Brian updated
// the payment method from X to Y" rather than a bare unattributed
// "The payment method has been updated" - item 10's explicit ask that
// every actor-driven system message name who did it.
async function getActorDisplay(req) {
  const role = senderRoleFor(req);
  const roleLabel = role === 'landlord' ? 'landlord' : role === 'caretaker' ? 'caretaker' : 'property manager';
  try {
    if (req.user.role === 'landlord') {
      const { data } = await supabase.from('landlords').select('full_name').eq('id', req.user.id).single();
      return { name: data?.full_name || 'Your landlord', roleLabel };
    }
    if (req.user.role === 'manager') {
      const { data } = await supabase.from('property_managers').select('full_name').eq('id', req.user.id).single();
      return { name: data?.full_name || `Your ${roleLabel}`, roleLabel };
    }
  } catch (err) {
    console.error('[announcements] getActorDisplay error:', err.message);
  }
  return { name: `Your ${roleLabel}`, roleLabel };
}


// FIX (direct request: "I need the app to be sending notifications
// just like other apps... anything sent in the announcements... and
// all other in-app notifications" should trigger one): announcements
// used to ONLY write a row to the `announcements` table, which is
// purely pull-based - a tenant/landlord only ever saw it if they
// happened to open the Announcements tab. This actually pushes it to
// each recipient via notify() (SMS + inbox + a real OS-level push,
// same mechanism payment confirmations already use), fired AFTER the
// HTTP response so a broadcast to hundreds of tenants never makes the
// admin/landlord wait on hundreds of SMS/push calls to finish.
async function fanOutAnnouncementPush(announcement) {
  try {
    const message = announcement.message;
    const title = senderLabel(announcement.sender_role) + (announcement.sender_role === 'platform' ? ' announcement' : ' update');

    if (announcement.is_platform) {
      const group = announcement.platform_target_group || 'all';
      const jobs = [];
      if (group === 'all' || group === 'tenants') {
        const { data: tenants } = await supabase.from('tenants').select('id, primary_phone');
        for (const t of tenants || []) jobs.push(notify('tenant', t.id, t.primary_phone, message, { title, category: 'announcement', urgent: true }));
      }
      if (group === 'all' || group === 'landlord_team') {
        const { data: landlords } = await supabase.from('landlords').select('id, phone');
        for (const l of landlords || []) jobs.push(notify('landlord', l.id, l.phone, message, { title, category: 'announcement', urgent: true }));
        const { data: managers } = await supabase.from('property_managers').select('id, phone');
        for (const m of managers || []) jobs.push(notify('manager', m.id, m.phone, message, { title, category: 'announcement', urgent: true }));
      }
      if (group === 'all' || group === 'scouts') {
        const { data: scouts } = await supabase.from('scouts').select('id, phone');
        for (const s of scouts || []) jobs.push(notify('scout', s.id, s.phone, message, { title, category: 'announcement', urgent: true }));
      }
      await Promise.allSettled(jobs);
      return;
    }

    // A landlord/manager/caretaker's own announcement - always goes
    // to their tenants (their managers/caretakers already see it live
    // in their own portal, same account, no separate push needed).
    let tenantQuery = supabase.from('tenants').select('id, primary_phone, unit_id, units(property_id)').eq('landlord_id', announcement.landlord_id);
    const { data: tenants } = await tenantQuery;
    const scoped = (tenants || []).filter((t) => {
      if (announcement.audience === 'unit') return t.unit_id === announcement.unit_id;
      if (announcement.audience === 'property') return t.units?.property_id === announcement.property_id;
      return true; // 'all'
    });
    await Promise.allSettled(scoped.map((t) => notify('tenant', t.id, t.primary_phone, message, { title, category: 'announcement', urgent: true })));
  } catch (err) {
    // Never let a notification-delivery problem surface as a failure
    // of the announcement itself - it's already saved and visible in
    // the portal either way.
    console.error('[announcements] fanOutAnnouncementPush error:', err.message);
  }
}

function senderLabel(senderRole) {
  switch (senderRole) {
    case 'landlord': return 'Landlord';
    case 'manager': return 'Property Manager';
    case 'caretaker': return 'Caretaker';
    case 'platform': return 'RentaPay';
    case 'system':
    default: return 'System';
  }
}

// ---------------------------------------------------------------------
// CREATE - a landlord, full property manager, OR caretaker (item 3
// clarification: caretakers are explicitly included this time)
// broadcasts a message to their tenants, and it's also visible to
// every other manager/caretaker on the same account.
// ---------------------------------------------------------------------
async function createAnnouncement(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { message, audience, propertyId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Announcement message is required.' });
    }
    if (audience === 'property' && !propertyId) {
      return res.status(400).json({ error: 'Pick a property to announce to, or choose "All tenants".' });
    }

    const senderRole = senderRoleFor(req);

    const { data: announcement, error } = await supabase
      .from('announcements')
      .insert({
        landlord_id: landlordId,
        message: message.trim(),
        audience: audience === 'property' ? 'property' : 'all',
        property_id: audience === 'property' ? propertyId : null,
        sender_role: senderRole,
        sender_id: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    fanOutAnnouncementPush(announcement); // fire-and-forget, see comment above the function

    return res.status(201).json({ announcement: { ...announcement, senderLabel: senderLabel(senderRole) } });
  } catch (err) {
    console.error('[announcements] createAnnouncement error:', err.message);
    return res.status(500).json({ error: 'Failed to send announcement.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN: platform-wide broadcast (item 5) - goes out to every user on
// the entire platform, not scoped to one landlord's account at all.
// Always tagged "RentaPay" (item 3 clarification: NOT "System" - that
// tag is reserved for auto-generated per-account updates, see
// postSystemAnnouncement below).
// ---------------------------------------------------------------------
async function createPlatformAnnouncement(req, res) {
  try {
    const { message, targetGroup } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Announcement message is required.' });
    }
    const group = ['all', 'tenants', 'landlord_team', 'scouts'].includes(targetGroup) ? targetGroup : 'all';

    const { data: announcement, error } = await supabase
      .from('announcements')
      .insert({
        landlord_id: null,
        message: message.trim(),
        audience: 'all',
        is_platform: true,
        platform_target_group: group,
        sender_role: 'platform',
        sender_id: null,
      })
      .select()
      .single();
    if (error) throw error;

    fanOutAnnouncementPush(announcement); // fire-and-forget, see comment above the function

    return res.status(201).json({ announcement: { ...announcement, senderLabel: senderLabel('platform') } });
  } catch (err) {
    console.error('[announcements] createPlatformAnnouncement error:', err.message);
    return res.status(500).json({ error: 'Failed to send platform announcement.' });
  }
}

// Used internally by other controllers (e.g. updatePaymentMethod, rent
// changes, due date changes, extra charges) to post a system
// announcement without going through the HTTP route. `options.propertyId`
// scopes it to one property (e.g. a single unit's rent change) the
// same way a manual "announce to one property" send would - omit it
// (or pass null) for anything landlord-account-wide. `options.unitId`
// (item 9) scopes it further to just the one tenant living in that
// unit - use this instead of propertyId whenever the change only
// actually affects a single unit (rent, due date, extra charges,
// per-unit payment overrides), so it doesn't leak into every other
// tenant in the same building's feed.
async function postSystemAnnouncement(landlordId, message, options = {}) {
  try {
    const { propertyId = null, unitId = null } = options;
    const { data: announcement, error } = await supabase
      .from('announcements')
      .insert({
        landlord_id: landlordId,
        message,
        audience: unitId ? 'unit' : propertyId ? 'property' : 'all',
        property_id: propertyId,
        unit_id: unitId,
        is_system: true,
        sender_role: 'system',
      })
      .select()
      .single();
    if (error) throw error;
    if (announcement) fanOutAnnouncementPush(announcement); // fire-and-forget, see comment above the function
  } catch (err) {
    console.error('[announcements] postSystemAnnouncement error:', err.message);
    // Never let a failed announcement block the action that triggered it.
  }
}

// ---------------------------------------------------------------------
// LIST - scoped to what this viewer should see:
//   - landlord/manager/caretaker: everything sent under their landlord_id,
//     plus any platform-wide broadcast.
//   - tenant: 'all' announcements, plus 'property' ones for their own
//     unit's property, plus any platform-wide broadcast.
// Announcements this viewer has "deleted for me" are excluded entirely.
// Each remaining item comes back with `isRead` and `senderLabel`.
// ---------------------------------------------------------------------
async function listAnnouncements(req, res) {
  try {
    const { role, id } = req.user;
    let landlordId;
    let tenantPropertyId = null;
    let tenantUnitId = null;

    let tenantCreatedAt = null;
    let viewerCreatedAt = null;

    // A Scout isn't attached to any landlord's account at all, so
    // there's no landlord_id to scope by - they only ever see
    // platform-wide (is_platform) announcements, same "nothing sent
    // before my own account existed" rule as every other role gets.
    if (role === 'scout') {
      const { data: scout } = await supabase.from('scouts').select('created_at').eq('id', id).maybeSingle();
      const scoutCreatedAt = scout?.created_at || null;

      const { data: platformAnnouncements, error: platformErr } = await supabase
        .from('announcements')
        .select('*, units(property_id)')
        .eq('is_platform', true)
        .order('created_at', { ascending: false })
        .limit(50);
      if (platformErr) throw platformErr;

      const visibleToScout = (platformAnnouncements || []).filter((a) => {
        if (scoutCreatedAt && new Date(a.created_at) < new Date(scoutCreatedAt)) return false;
        const group = a.platform_target_group || 'all';
        return group === 'all' || group === 'scouts';
      });

      const [{ data: scoutReads }, { data: scoutHidden }] = await Promise.all([
        supabase.from('announcement_reads').select('announcement_id').eq('recipient_type', 'scout').eq('recipient_id', id),
        supabase.from('announcement_hidden').select('announcement_id').eq('recipient_type', 'scout').eq('recipient_id', id),
      ]);
      const scoutReadIds = new Set((scoutReads || []).map((r) => r.announcement_id));
      const scoutHiddenIds = new Set((scoutHidden || []).map((h) => h.announcement_id));

      const scoutResult = visibleToScout
        .filter((a) => !scoutHiddenIds.has(a.id))
        .map((a) => ({ ...a, isRead: scoutReadIds.has(a.id), senderLabel: senderLabel(a.sender_role) }));

      return res.json({ announcements: scoutResult, unreadCount: scoutResult.filter((a) => !a.isRead).length });
    }

    if (role === 'tenant') {
      const { data: tenant, error: tErr } = await supabase
        .from('tenants')
        .select('landlord_id, unit_id, created_at, units(property_id)')
        .eq('id', id)
        .single();
      if (tErr || !tenant) return res.status(404).json({ error: 'Tenant not found.' });
      landlordId = tenant.landlord_id;
      tenantPropertyId = tenant.units?.property_id || null;
      tenantUnitId = tenant.unit_id || null;
      tenantCreatedAt = tenant.created_at;
    } else {
      landlordId = effectiveLandlordId(req);

      // FIX (direct request: "when a new user logs in or signs up he
      // should not be able to see the previous messages and
      // notifications" - this used to only be fixed for tenants (see
      // tenantCreatedAt below). A brand-new landlord account, or a
      // manager/caretaker just added to an existing one, inherited
      // every announcement ever posted for that landlord_id going
      // back to the very first one - including system notices about
      // units, tenants, and payments from long before this particular
      // login even existed. Scoped the same way as the tenant fix:
      // nothing posted before THIS account existed is shown to it.
      // A manager/caretaker uses their own account's created_at (when
      // THEY were added), not the landlord's - two managers added
      // months apart on the same account should not see identical
      // history.
      const { table } = role === 'manager' ? { table: 'property_managers' } : { table: 'landlords' };
      const { data: viewer } = await supabase.from(table).select('created_at').eq('id', id).maybeSingle();
      viewerCreatedAt = viewer?.created_at || null;
    }

    const { data: announcements, error } = await supabase
      .from('announcements')
      .select('*, units(property_id)')
      .or(`landlord_id.eq.${landlordId},is_platform.eq.true`)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const assignedPropertyIds = role === 'manager' ? await getManagerAssignedPropertyIds(id) : null;
    // A manager with no explicit property assignments is scoped the
    // same way everywhere else in the app (see dashboard/unit/tenant
    // controllers) - unrestricted, since "no assignment rows" already
    // means "not limited to a subset" in that model, not "sees
    // nothing". Only a manager WITH assignments gets narrowed here.
    const inManagerScope = (a) => {
      if (!assignedPropertyIds || assignedPropertyIds.length === 0) return true;
      if (a.audience === 'property') return assignedPropertyIds.includes(a.property_id);
      if (a.audience === 'unit') return assignedPropertyIds.includes(a.units?.property_id);
      return true; // audience 'all' and platform-wide notices still reach every manager
    };

    // FIX (direct request: "every apartment be solely independent...
    // nothing should leak, not even... announcements"): an
    // announcement aimed at ONE specific property/unit used to still
    // show up in a landlord's inbox no matter which apartment they
    // currently had open in the property switcher - a notice about
    // Shanix Hostels was mixed in right alongside KimCom Apartments'
    // own. When the caller tells us which property is active, narrow
    // property/unit-targeted announcements down to that property;
    // audience='all' and platform-wide notices are genuinely
    // account-wide (like the shared profile/phone number) and still
    // reach every property.
    const activePropertyId = role !== 'tenant' && role !== 'scout' ? req.query.propertyId : null;
    const inActivePropertyScope = (a) => {
      if (!activePropertyId) return true;
      if (a.audience === 'property') return a.property_id === activePropertyId;
      if (a.audience === 'unit') return a.units?.property_id === activePropertyId;
      return true;
    };

    // FIX (direct request): a platform-wide announcement can now be
    // aimed at everyone, tenants only, or the landlord/manager/
    // caretaker group only - a null platform_target_group (every
    // platform announcement sent before this existed) is treated as
    // 'all', so nothing already sent stops reaching who it used to.
    const isInTargetGroup = (a) => {
      const group = a.platform_target_group || 'all';
      if (group === 'all') return true;
      if (group === 'tenants') return role === 'tenant';
      if (group === 'landlord_team') return role === 'landlord' || role === 'manager';
      return true;
    };

    // BUG FIX (direct request): "landlord/manager/caretaker only"
    // broadcasts were still reaching tenants. Cause: every platform
    // announcement is stored with audience='all' regardless of its
    // target group (that field is about a LANDLORD's own announcement
    // reaching all THEIR tenants, unrelated to admin's platform-wide
    // targeting) - so the tenant filter's separate `audience === 'all'`
    // clause matched every platform message unconditionally, completely
    // bypassing isInTargetGroup. A platform announcement must now be
    // decided by isInTargetGroup ALONE; only a non-platform
    // (landlord-sent) announcement falls through to the audience checks.
    // FIX (direct request): "when a tenant logs in today he should not
    // see the announcements of before" - a newly added tenant used to
    // see every announcement ever sent to the property/all-tenants
    // audience, including ones sent months before they ever moved in
    // and had nothing to do with them. Anything sent before this
    // tenant's own account was created is filtered out for them -
    // platform-wide notices and everything sent since they joined
    // still shows normally.
    const visible = role === 'tenant'
      ? (announcements || []).filter((a) => (!tenantCreatedAt || new Date(a.created_at) >= new Date(tenantCreatedAt)) && (a.is_platform ? isInTargetGroup(a) : (a.audience === 'all' || (a.audience === 'property' && a.property_id === tenantPropertyId) || (a.audience === 'unit' && a.unit_id === tenantUnitId))))
      : (announcements || []).filter((a) => (!viewerCreatedAt || new Date(a.created_at) >= new Date(viewerCreatedAt)) && (!a.is_platform || isInTargetGroup(a)) && inManagerScope(a) && inActivePropertyScope(a));

    const recipientType = recipientTypeFor(role);

    const [{ data: reads }, { data: hidden }] = await Promise.all([
      supabase.from('announcement_reads').select('announcement_id').eq('recipient_type', recipientType).eq('recipient_id', id),
      supabase.from('announcement_hidden').select('announcement_id').eq('recipient_type', recipientType).eq('recipient_id', id),
    ]);
    const readIds = new Set((reads || []).map((r) => r.announcement_id));
    const hiddenIds = new Set((hidden || []).map((h) => h.announcement_id));

    const result = visible
      .filter((a) => !hiddenIds.has(a.id))
      .map((a) => ({ ...a, isRead: readIds.has(a.id), senderLabel: senderLabel(a.sender_role) }));
    const unreadCount = result.filter((a) => !a.isRead).length;

    return res.json({ announcements: result, unreadCount });
  } catch (err) {
    console.error('[announcements] listAnnouncements error:', err.message);
    return res.status(500).json({ error: 'Failed to load announcements.' });
  }
}

// ---------------------------------------------------------------------
// MARK READ
// ---------------------------------------------------------------------
async function markAnnouncementRead(req, res) {
  try {
    const { role, id } = req.user;
    const { announcementId } = req.params;
    const recipientType = recipientTypeFor(role);

    const { error } = await supabase
      .from('announcement_reads')
      .upsert({ announcement_id: announcementId, recipient_type: recipientType, recipient_id: id }, { onConflict: 'announcement_id,recipient_type,recipient_id' });
    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error('[announcements] markAnnouncementRead error:', err.message);
    return res.status(500).json({ error: 'Failed to mark announcement as read.' });
  }
}

// ---------------------------------------------------------------------
// DELETE - item 3 clarification: NOT automatic delete-for-everyone.
// Every role picks a scope:
//   'self' - hides the announcement from this one viewer only. This is
//            the ONLY option a tenant ever gets (they can't erase a
//            landlord's broadcast for everyone else).
//   'all'  - actually deletes the announcement record for everyone.
//            Only landlord/manager/caretaker (on an announcement that
//            belongs to their own account) or admin (any announcement,
//            including platform-wide ones) may do this.
// ---------------------------------------------------------------------
async function deleteAnnouncement(req, res) {
  try {
    const { role, id } = req.user;
    const { announcementId } = req.params;
    const requestedScope = req.body?.scope === 'all' ? 'all' : 'self';

    const { data: announcement, error: fetchError } = await supabase
      .from('announcements')
      .select('id, landlord_id, is_platform')
      .eq('id', announcementId)
      .single();
    if (fetchError || !announcement) return res.status(404).json({ error: 'Announcement not found.' });

    // A tenant or Scout can only ever delete for themselves - a Scout
    // never owns an announcement (only admin's platform broadcasts are
    // visible to them), so "delete for everyone" makes no sense here.
    const scope = (role === 'tenant' || role === 'scout') ? 'self' : requestedScope;

    if (scope === 'all') {
      if (role !== 'admin') {
        const landlordId = effectiveLandlordId(req);
        if (announcement.is_platform || announcement.landlord_id !== landlordId) {
          return res.status(403).json({ error: 'You can only delete announcements sent under your own account.' });
        }
      }
      const { error } = await supabase.from('announcements').delete().eq('id', announcementId);
      if (error) throw error;
      return res.json({ success: true, scope: 'all' });
    }

    // scope === 'self': hide it just for this viewer.
    const recipientType = recipientTypeFor(role);
    const { error } = await supabase
      .from('announcement_hidden')
      .upsert({ announcement_id: announcementId, recipient_type: recipientType, recipient_id: id }, { onConflict: 'announcement_id,recipient_type,recipient_id' });
    if (error) throw error;

    return res.json({ success: true, scope: 'self' });
  } catch (err) {
    console.error('[announcements] deleteAnnouncement error:', err.message);
    return res.status(500).json({ error: 'Failed to delete announcement.' });
  }
}

module.exports = {
  createAnnouncement,
  createPlatformAnnouncement,
  listAnnouncements,
  markAnnouncementRead,
  deleteAnnouncement,
  postSystemAnnouncement,
  getActorDisplay,
};
