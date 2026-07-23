// src/controllers/chat.controller.js
//
// Direct, in-app chat that replaces the old "reach us directly" /
// email-only Help flow with a real two-way conversation, WhatsApp-style:
//
//   - admin_landlord   : a landlord's "Chat with an agent" <-> the admin portal
//   - admin_tenant     : a tenant's "Chat with an agent" <-> the admin portal
//   - landlord_tenant  : a landlord's "Text your tenant" <-> a tenant's
//                        "Text your landlord"
//
// Every row is one bubble. reply_to_id lets either side reply to a
// specific earlier bubble (the client greys it out/quotes it above the
// new message, exactly like WhatsApp's reply-to).

const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { sendPushToRecipient } = require('../services/webpush.service');

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Resolves which landlord_id/tenant_id a request is allowed to act on,
// based on the caller's role - so a landlord can never fetch/post into
// another landlord's thread, and a tenant can never fetch/post into
// another tenant's thread. Admins may act on any thread they specify.
async function resolveScope(req) {
  const { role, id } = req.user;

  if (role === 'admin') {
    return { landlordId: req.body.landlordId || req.query.landlordId || null, tenantId: req.body.tenantId || req.query.tenantId || null };
  }

  if (role === 'landlord') {
    const requestedTenantId = req.body.tenantId || req.query.tenantId || null;
    if (requestedTenantId) {
      // Make sure this tenant actually belongs to this landlord.
      const { data: tenant } = await supabase.from('tenants').select('id, landlord_id').eq('id', requestedTenantId).maybeSingle();
      if (!tenant || tenant.landlord_id !== id) return null; // not permitted
    }
    const requestedScoutId = req.body.scoutId || req.query.scoutId || null;
    return { landlordId: id, tenantId: requestedTenantId, scoutId: requestedScoutId };
  }

  // FIX: a property manager/caretaker texting a tenant on the
  // landlord's behalf ("landlord_tenant" thread) previously had NO
  // branch here at all - resolveScope fell through to `return null`
  // below, which meant every single chat call from a manager/
  // caretaker account failed outright. Scoped via effectiveLandlordId
  // (never req.user.id, which is a property_managers.id, not a
  // landlords.id) exactly like every other manager-facing endpoint.
  //
  // Item 7: a manager/caretaker can also now use the account's
  // admin_landlord thread ("Chat with an agent") - there's one shared
  // support inbox per landlord account, not a separate one per staff
  // member, so this reuses admin_landlord rather than inventing a new
  // thread type.
  if (role === 'manager') {
    const landlordId = effectiveLandlordId(req);
    const requestedTenantId = req.body.tenantId || req.query.tenantId || null;
    if (requestedTenantId) {
      // MEDIUM FIX (isolation audit): also require this tenant's unit to
      // be in a property this manager is actually assigned to - a
      // manager restricted to Property A could otherwise message a
      // tenant in Property B just because they share the same landlord.
      const { data: tenant } = await supabase.from('tenants').select('id, landlord_id, units(property_id)').eq('id', requestedTenantId).maybeSingle();
      if (!tenant || tenant.landlord_id !== landlordId) return null;
      const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
      if (propertyAccessError) return null;
    }
    return { landlordId, tenantId: requestedTenantId };
  }

  if (role === 'tenant') {
    const { data: tenant } = await supabase.from('tenants').select('id, landlord_id').eq('id', id).maybeSingle();
    if (!tenant) return null;
    return { landlordId: tenant.landlord_id, tenantId: id };
  }

  // scout_landlord: a scout messages a landlord whose vacancy they
  // found (masked contact, all inside the app's own audit trail,
  // instead of the phone-call-only path the vacancy browser used
  // before). A scout can only act on threads with THEIR OWN scoutId;
  // a landlord can only act on threads with THEIR OWN landlordId
  // (added below) - each side supplies the counterpart's id from the
  // request, exactly like the tenant/landlord scoping above.
  if (role === 'scout') {
    const requestedLandlordId = req.body.landlordId || req.query.landlordId || null;
    if (!requestedLandlordId) return null;
    const { data: landlord } = await supabase.from('landlords').select('id, scout_visibility_enabled').eq('id', requestedLandlordId).maybeSingle();
    if (!landlord) return null;
    // A brand-new message into a thread with a landlord who has since
    // opted out, or blocked this scout, is refused - but reading an
    // already-existing thread still works, same as blocking someone
    // on WhatsApp doesn't erase message history.
    const { data: block } = await supabase.from('blocked_scouts').select('landlord_id').eq('landlord_id', requestedLandlordId).eq('scout_id', id).maybeSingle();
    return { landlordId: requestedLandlordId, scoutId: id, scoutBlocked: !!block, scoutVisibilityOff: landlord.scout_visibility_enabled === false };
  }

  return null;
}

// Role tag shown next to a sender's name in the chat UI (item 9) -
// "Landlord" / "Property Manager" / "Caretaker" / "Tenant" / "RentaPay
// Support", based on who is ACTUALLY logged in, never a generic
// fallback string.
function senderRoleTag(req) {
  const { role, roleLevel } = req.user;
  if (role === 'admin') return 'RentaPay Support';
  if (role === 'landlord') return 'Landlord';
  if (role === 'manager') return roleLevel === 'caretaker' ? 'Caretaker' : 'Property Manager';
  if (role === 'scout') return 'Scout';
  return 'Tenant';
}

function senderNameFallback(req) {
  return senderRoleTag(req);
}

async function lookupSenderName(req) {
  const { role, id } = req.user;
  if (role === 'admin') return 'RentaPay Support';
  const table = role === 'landlord' ? 'landlords' : role === 'manager' ? 'property_managers' : role === 'scout' ? 'scouts' : 'tenants';
  const { data } = await supabase.from(table).select('full_name').eq('id', id).maybeSingle();
  return data?.full_name || senderNameFallback(req);
}

// ---------------------------------------------------------------------
// POST /api/chat/messages
// Body: { threadType, landlordId?, tenantId?, body, replyToId? }
// ---------------------------------------------------------------------
async function sendMessage(req, res) {
  try {
    const { role, id } = req.user;
    const { threadType, body, replyToId } = req.body;

    if (!threadType || !body || !body.trim()) {
      return res.status(400).json({ error: 'threadType and body are required.' });
    }
    if (!['admin_landlord', 'admin_tenant', 'landlord_tenant', 'scout_landlord'].includes(threadType)) {
      return res.status(400).json({ error: 'Invalid threadType.' });
    }

    const scope = await resolveScope(req);
    if (!scope) return res.status(403).json({ error: 'You do not have permission to message this thread.' });

    // Shape validation per thread type, mirroring the DB check constraint.
    if (threadType === 'admin_landlord' && !scope.landlordId) {
      return res.status(400).json({ error: 'landlordId is required for an admin_landlord thread.' });
    }
    if (threadType === 'admin_tenant' && !scope.tenantId) {
      return res.status(400).json({ error: 'tenantId is required for an admin_tenant thread.' });
    }
    if (threadType === 'landlord_tenant' && (!scope.landlordId || !scope.tenantId)) {
      return res.status(400).json({ error: 'Both landlordId and tenantId are required for a landlord_tenant thread.' });
    }
    if (threadType === 'scout_landlord' && (!scope.landlordId || !scope.scoutId)) {
      return res.status(400).json({ error: 'Both landlordId and scoutId are required for a scout_landlord thread.' });
    }

    // A tenant may only ever write into admin_tenant or landlord_tenant
    // (never admin_landlord); a landlord may only write into
    // admin_landlord or landlord_tenant (never admin_tenant on their own).
    if (role === 'tenant' && threadType === 'admin_landlord') {
      return res.status(403).json({ error: 'Tenants cannot message the admin_landlord thread.' });
    }
    if (role === 'landlord' && threadType === 'admin_tenant') {
      return res.status(403).json({ error: 'Landlords cannot message the admin_tenant thread.' });
    }
    // A scout may only ever write into scout_landlord threads.
    if (role === 'scout' && threadType !== 'scout_landlord') {
      return res.status(403).json({ error: 'Scouts can only message a landlord about a unit.' });
    }
    // Block/opt-out enforcement (Pass 1 fix): a scout who's been
    // blocked by this landlord, or whose target landlord has opted
    // out of scout visibility entirely, cannot send a NEW message
    // into this thread - existing history stays readable via
    // listMessages, this only stops new outbound messages.
    if (role === 'scout' && threadType === 'scout_landlord' && (scope.scoutBlocked || scope.scoutVisibilityOff)) {
      return res.status(403).json({ error: 'This landlord is not available to message right now.' });
    }
    // A property manager/caretaker can text tenants on the landlord's
    // behalf, AND use the account's shared "Chat with an agent"
    // support thread (item 7) - but never the tenant's own admin_tenant
    // thread, which isn't theirs.
    if (role === 'manager' && !['landlord_tenant', 'admin_landlord'].includes(threadType)) {
      return res.status(403).json({ error: 'Property managers and caretakers can only message tenants or RentaPay support.' });
    }

    const senderName = await lookupSenderName(req);

    // Read receipts: whichever side is sending has implicitly "read"
    // their own message; the other side(s) start unread.
    const readFlags = {
      read_by_admin: role === 'admin',
      read_by_landlord: role === 'landlord' || role === 'manager',
      read_by_tenant: role === 'tenant',
      read_by_scout: role === 'scout',
    };

    const { data: message, error } = await supabase
      .from('chat_messages')
      .insert({
        thread_type: threadType,
        landlord_id: scope.landlordId,
        tenant_id: scope.tenantId,
        scout_id: scope.scoutId || null,
        sender_role: role,
        sender_role_level: role === 'manager' ? (req.user.roleLevel === 'caretaker' ? 'caretaker' : 'manager') : null,
        sender_id: role === 'admin' ? null : id,
        sender_name: senderName,
        body: body.trim(),
        reply_to_id: replyToId || null,
        ...readFlags,
      })
      .select('*, reply_to:reply_to_id(id, body, sender_name, sender_role)')
      .single();

    if (error) throw error;

    // "Live push" urgent tier - a chat message should reach the other
    // side even if their portal tab isn't open. Push-only (chat has
    // its own read-receipt columns and unread-count logic already;
    // this doesn't also write to the SMS/inbox `notifications` table,
    // which is for the notify() call sites elsewhere). There's no
    // admin push bucket (push_subscriptions only covers landlord/
    // manager/tenant), so messages into/out of an admin thread simply
    // don't push on the admin side - the admin portal's own polling
    // still picks them up.
    //
    // Not awaited - sending a chat message must return immediately;
    // webpush.service.js already times out any single hung send, but
    // there's no reason to make the sender wait on push delivery at
    // all when it's not part of what they're waiting to see succeed.
    (async () => {
      try {
        if (threadType === 'landlord_tenant') {
          if (role === 'tenant') {
            await sendPushToRecipient('landlord', scope.landlordId, { title: `New message from ${senderName}`, body: body.trim() });
          } else {
            await sendPushToRecipient('tenant', scope.tenantId, { title: `New message from ${senderName}`, body: body.trim() });
          }
        } else if (threadType === 'admin_tenant' && role === 'admin') {
          await sendPushToRecipient('tenant', scope.tenantId, { title: `New message from ${senderName}`, body: body.trim() });
        } else if (threadType === 'admin_landlord' && role === 'admin') {
          await sendPushToRecipient('landlord', scope.landlordId, { title: `New message from ${senderName}`, body: body.trim() });
        } else if (threadType === 'scout_landlord' && role === 'scout') {
          // Scouts don't have a push_subscriptions row type yet (Pass
          // 2 item), so only the landlord side gets a live push here;
          // the scout's own portal still picks new messages up on
          // next poll/open, same as before this thread type existed.
          await sendPushToRecipient('landlord', scope.landlordId, { title: `New message from a Scout`, body: body.trim() });
        }
      } catch (pushErr) {
        console.error('[chat] sendMessage: push failed (non-blocking):', pushErr.message);
      }
    })();

    return res.status(201).json({ message });
  } catch (err) {
    console.error('[chat] sendMessage error:', err.message);
    return res.status(500).json({ error: 'Failed to send message.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/chat/messages?threadType=&landlordId=&tenantId=
// Returns full message history for one thread, oldest first.
// ---------------------------------------------------------------------
async function listMessages(req, res) {
  try {
    const { role } = req.user;
    const { threadType } = req.query;

    if (!threadType) return res.status(400).json({ error: 'threadType is required.' });

    const scope = await resolveScope(req);
    if (!scope) return res.status(403).json({ error: 'You do not have permission to view this thread.' });

    let query = supabase
      .from('chat_messages')
      .select('*, reply_to:reply_to_id(id, body, sender_name, sender_role)')
      .eq('thread_type', threadType)
      .order('created_at', { ascending: true });

    if (threadType === 'admin_landlord') query = query.eq('landlord_id', scope.landlordId);
    if (threadType === 'admin_tenant') query = query.eq('tenant_id', scope.tenantId);
    if (threadType === 'landlord_tenant') query = query.eq('landlord_id', scope.landlordId).eq('tenant_id', scope.tenantId);
    if (threadType === 'scout_landlord') query = query.eq('landlord_id', scope.landlordId).eq('scout_id', scope.scoutId);

    const { data: messages, error } = await query;
    if (error) throw error;

    // Item 5: drop anything this viewer has "deleted for me", and mask
    // the body of anything "deleted for everyone" instead of showing
    // the original text (WhatsApp-style "This message was deleted").
    const { data: hidden } = await supabase
      .from('chat_message_hidden')
      .select('message_id')
      .eq('viewer_role', role)
      .eq('viewer_id', req.user.id);
    const hiddenIds = new Set((hidden || []).map((h) => h.message_id));

    const visibleMessages = (messages || [])
      .filter((m) => !hiddenIds.has(m.id))
      .map((m) => (m.deleted_for_everyone ? { ...m, body: null, deletedForEveryone: true } : m));

    // Mark everything in this thread read for the requesting side.
    // Managers/caretakers share read_by_landlord with the landlord on
    // landlord_tenant threads (see listThreads' comment on why) - they
    // previously fell through to read_by_tenant here, which is wrong
    // and would incorrectly mark a tenant's messages as read by a
    // manager viewing their OWN sent messages back.
    const readField = role === 'admin' ? 'read_by_admin' : role === 'landlord' || role === 'manager' ? 'read_by_landlord' : role === 'scout' ? 'read_by_scout' : 'read_by_tenant';
    const unreadIds = (messages || []).filter((m) => !m[readField]).map((m) => m.id);
    if (unreadIds.length) {
      await supabase.from('chat_messages').update({ [readField]: true }).in('id', unreadIds);
    }

    return res.json({ messages: visibleMessages });
  } catch (err) {
    console.error('[chat] listMessages error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch messages.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/chat/threads
// Admin: every distinct landlord/tenant thread with an unread count and
//        last message preview, so the admin portal can show a WhatsApp-
//        style inbox list ("Chat with an agent" replies live here).
// Landlord: their own admin_landlord thread + one landlord_tenant thread
//        per active tenant (their "text your tenant" list).
// Tenant: their own admin_tenant thread + their one landlord_tenant
//        thread with their landlord.
// ---------------------------------------------------------------------
async function listThreads(req, res) {
  try {
    const { role, id } = req.user;

    if (role === 'admin') {
      const [{ data: landlordThreads }, { data: tenantThreads }] = await Promise.all([
        supabase
          .from('chat_messages')
          .select('landlord_id, body, created_at, read_by_admin, sender_role, landlords(full_name, phone)')
          .eq('thread_type', 'admin_landlord')
          .order('created_at', { ascending: false }),
        supabase
          .from('chat_messages')
          .select('tenant_id, body, created_at, read_by_admin, sender_role, tenants(full_name, primary_phone, landlord_id)')
          .eq('thread_type', 'admin_tenant')
          .order('created_at', { ascending: false }),
      ]);

      const threads = [];
      const seenLandlord = new Set();
      for (const row of landlordThreads || []) {
        if (seenLandlord.has(row.landlord_id)) continue;
        seenLandlord.add(row.landlord_id);
        threads.push({
          threadType: 'admin_landlord',
          landlordId: row.landlord_id,
          name: row.landlords?.full_name || 'Landlord',
          phone: row.landlords?.phone || null,
          lastMessage: row.body,
          lastMessageAt: row.created_at,
        });
      }
      const seenTenant = new Set();
      for (const row of tenantThreads || []) {
        if (seenTenant.has(row.tenant_id)) continue;
        seenTenant.add(row.tenant_id);
        threads.push({
          threadType: 'admin_tenant',
          tenantId: row.tenant_id,
          name: row.tenants?.full_name || 'Tenant',
          phone: row.tenants?.primary_phone || null,
          lastMessage: row.body,
          lastMessageAt: row.created_at,
        });
      }

      // Unread counts (small dataset per RentaPay's scale - fine to do client-side aggregation via a second pass)
      const { data: unread } = await supabase
        .from('chat_messages')
        .select('thread_type, landlord_id, tenant_id')
        .in('thread_type', ['admin_landlord', 'admin_tenant'])
        .eq('read_by_admin', false);

      for (const t of threads) {
        t.unreadCount = (unread || []).filter((u) =>
          t.threadType === 'admin_landlord' ? u.landlord_id === t.landlordId && u.thread_type === 'admin_landlord' : u.tenant_id === t.tenantId && u.thread_type === 'admin_tenant'
        ).length;
      }

      threads.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
      return res.json({ threads });
    }

    if (role === 'landlord') {
      const { data: tenants } = await supabase.from('tenants').select('id, full_name, primary_phone, is_active').eq('landlord_id', id).eq('is_active', true);

      // scout_landlord threads: any scout who has ever messaged this
      // landlord, so blocking them later doesn't erase the existing
      // conversation from the landlord's inbox list.
      const { data: scoutRows } = await supabase
        .from('chat_messages')
        .select('scout_id, scouts(full_name, phone)')
        .eq('thread_type', 'scout_landlord')
        .eq('landlord_id', id)
        .order('created_at', { ascending: false });
      const seenScouts = new Set();
      const scoutThreads = [];
      for (const row of scoutRows || []) {
        if (seenScouts.has(row.scout_id)) continue;
        seenScouts.add(row.scout_id);
        scoutThreads.push({ threadType: 'scout_landlord', landlordId: id, scoutId: row.scout_id, name: row.scouts?.full_name || 'Scout', phone: row.scouts?.phone || null });
      }

      const threads = [
        { threadType: 'admin_landlord', landlordId: id, name: 'RentaPay Support (Chat with an agent)' },
        ...tenants.map((t) => ({ threadType: 'landlord_tenant', landlordId: id, tenantId: t.id, name: t.full_name, phone: t.primary_phone })),
        ...scoutThreads,
      ];

      // Attach last message + unread count per thread.
      for (const t of threads) {
        let q = supabase.from('chat_messages').select('body, created_at, read_by_landlord').eq('thread_type', t.threadType).order('created_at', { ascending: false }).limit(1);
        if (t.threadType === 'admin_landlord') q = q.eq('landlord_id', id);
        if (t.threadType === 'landlord_tenant') q = q.eq('landlord_id', id).eq('tenant_id', t.tenantId);
        if (t.threadType === 'scout_landlord') q = q.eq('landlord_id', id).eq('scout_id', t.scoutId);
        const { data: last } = await q;
        t.lastMessage = last?.[0]?.body || null;
        t.lastMessageAt = last?.[0]?.created_at || null;

        let uq = supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('thread_type', t.threadType).eq('read_by_landlord', false);
        if (t.threadType === 'admin_landlord') uq = uq.eq('landlord_id', id);
        if (t.threadType === 'landlord_tenant') uq = uq.eq('landlord_id', id).eq('tenant_id', t.tenantId);
        if (t.threadType === 'scout_landlord') uq = uq.eq('landlord_id', id).eq('scout_id', t.scoutId);
        const { count } = await uq;
        t.unreadCount = count || 0;
      }

      threads.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
      return res.json({ threads });
    }

    if (role === 'scout') {
      // Every landlord this scout has messaged so far - a scout starts
      // a NEW thread from the vacancy browser ("Message landlord"),
      // which posts the first message directly (sendMessage creates
      // the thread implicitly, same as every other thread type here).
      const { data: rows } = await supabase
        .from('chat_messages')
        .select('landlord_id, body, created_at, read_by_scout, landlords(full_name, phone)')
        .eq('thread_type', 'scout_landlord')
        .eq('scout_id', id)
        .order('created_at', { ascending: false });

      const seen = new Set();
      const threads = [];
      for (const row of rows || []) {
        if (seen.has(row.landlord_id)) continue;
        seen.add(row.landlord_id);
        threads.push({
          threadType: 'scout_landlord',
          landlordId: row.landlord_id,
          scoutId: id,
          name: row.landlords?.full_name || 'Landlord',
          phone: row.landlords?.phone || null,
          lastMessage: row.body,
          lastMessageAt: row.created_at,
        });
      }

      const { data: unread } = await supabase
        .from('chat_messages')
        .select('landlord_id')
        .eq('thread_type', 'scout_landlord')
        .eq('scout_id', id)
        .eq('read_by_scout', false);
      for (const t of threads) {
        t.unreadCount = (unread || []).filter((u) => u.landlord_id === t.landlordId).length;
      }

      return res.json({ threads });
    }

    // FIX: property managers/caretakers previously had no branch here
    // at all (fell straight through to "Unknown role" below) - they
    // text tenants on the landlord's behalf, same landlord_tenant
    // thread the landlord themself uses, just scoped to whichever
    // tenants they're actually assigned to (or every tenant, if this
    // manager has no property assignments restricting them).
    if (role === 'manager') {
      const landlordId = effectiveLandlordId(req);
      const assignedPropertyIds = await getManagerAssignedPropertyIds(id);

      let tenantQuery = supabase
        .from('tenants')
        .select('id, full_name, primary_phone, is_active, units(property_id)')
        .eq('landlord_id', landlordId)
        .eq('is_active', true);
      const { data: allTenants } = await tenantQuery;
      const tenants = assignedPropertyIds.length
        ? (allTenants || []).filter((t) => !t.units?.property_id || assignedPropertyIds.includes(t.units.property_id))
        : (allTenants || []);

      // Item 7: "Chat with an agent" - the account's one shared
      // admin_landlord thread, same one the landlord themself uses.
      const threads = [
        { threadType: 'admin_landlord', landlordId, name: 'RentaPay Support (Chat with an agent)' },
        ...tenants.map((t) => ({ threadType: 'landlord_tenant', landlordId, tenantId: t.id, name: t.full_name, phone: t.primary_phone })),
      ];

      for (const t of threads) {
        let lastQuery = supabase.from('chat_messages').select('body, created_at').eq('thread_type', t.threadType).order('created_at', { ascending: false }).limit(1);
        let unreadQuery = supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('thread_type', t.threadType).eq('read_by_landlord', false);
        if (t.threadType === 'admin_landlord') {
          lastQuery = lastQuery.eq('landlord_id', landlordId);
          unreadQuery = unreadQuery.eq('landlord_id', landlordId);
        } else {
          lastQuery = lastQuery.eq('landlord_id', landlordId).eq('tenant_id', t.tenantId);
          unreadQuery = unreadQuery.eq('landlord_id', landlordId).eq('tenant_id', t.tenantId);
        }
        const { data: last } = await lastQuery;
        t.lastMessage = last?.[0]?.body || null;
        t.lastMessageAt = last?.[0]?.created_at || null;

        // Managers/caretakers share the landlord's read state on these
        // threads - there's no separate read_by_manager column, and
        // treating every manager as having their own independent
        // unread count on the SAME tenant thread as the landlord would
        // make the unread badge meaningless (whoever opens it last
        // "unreads" it for everyone else). read_by_landlord is close
        // enough in practice since a manager acts on the landlord's
        // behalf here.
        const { count } = await unreadQuery;
        t.unreadCount = count || 0;
      }

      threads.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
      return res.json({ threads });
    }

    if (role === 'tenant') {
      const { data: tenant } = await supabase.from('tenants').select('landlord_id').eq('id', id).maybeSingle();
      if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

      const threads = [
        { threadType: 'admin_tenant', tenantId: id, name: 'RentaPay Support (Chat with an agent)' },
        { threadType: 'landlord_tenant', landlordId: tenant.landlord_id, tenantId: id, name: 'Your Landlord' },
      ];

      for (const t of threads) {
        let q = supabase.from('chat_messages').select('body, created_at').eq('thread_type', t.threadType).order('created_at', { ascending: false }).limit(1);
        if (t.threadType === 'admin_tenant') q = q.eq('tenant_id', id);
        if (t.threadType === 'landlord_tenant') q = q.eq('landlord_id', tenant.landlord_id).eq('tenant_id', id);
        const { data: last } = await q;
        t.lastMessage = last?.[0]?.body || null;
        t.lastMessageAt = last?.[0]?.created_at || null;

        let uq = supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('thread_type', t.threadType).eq('read_by_tenant', false);
        if (t.threadType === 'admin_tenant') uq = uq.eq('tenant_id', id);
        if (t.threadType === 'landlord_tenant') uq = uq.eq('landlord_id', tenant.landlord_id).eq('tenant_id', id);
        const { count } = await uq;
        t.unreadCount = count || 0;
      }

      return res.json({ threads });
    }

    return res.status(403).json({ error: 'Unknown role.' });
  } catch (err) {
    console.error('[chat] listThreads error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch threads.' });
  }
}

// ---------------------------------------------------------------------
// DELETE /api/chat/messages/:messageId
// Body: { scope: 'self' | 'everyone' }
//
// 'self'     - always allowed for any participant of the thread; hides
//              the message for that viewer only (chat_message_hidden).
// 'everyone' - actually blanks the message body for the whole thread.
//              Rules (item 5):
//                - a message sent by RentaPay/admin can never be
//                  deleted for everyone, by anyone.
//                - a caretaker's own message can only be deleted for
//                  everyone by a manager or landlord on the SAME
//                  account - not by the caretaker themselves.
//                - any other message (landlord/full manager/tenant) can
//                  be deleted for everyone by whoever sent it, by
//                  admin, or by a landlord/full manager on that
//                  account (day-to-day moderation of a thread they own).
// ---------------------------------------------------------------------
async function deleteMessage(req, res) {
  try {
    const { role, id } = req.user;
    const { messageId } = req.params;
    const scope = req.body?.scope === 'everyone' ? 'everyone' : 'self';

    const { data: message, error: fetchError } = await supabase
      .from('chat_messages')
      .select('id, thread_type, landlord_id, tenant_id, sender_role, sender_role_level, sender_id')
      .eq('id', messageId)
      .single();
    if (fetchError || !message) return res.status(404).json({ error: 'Message not found.' });

    // Confirm this viewer is actually a participant of this message's
    // thread before allowing either delete scope - reuses the same
    // ownership rules as sendMessage/listMessages rather than trusting
    // the messageId alone.
    let authorized = false;
    if (role === 'admin') {
      authorized = true;
    } else if (role === 'landlord') {
      authorized = message.landlord_id === id;
    } else if (role === 'manager') {
      authorized = message.landlord_id === effectiveLandlordId(req);
    } else if (role === 'tenant') {
      authorized = message.tenant_id === id;
    } else if (role === 'scout') {
      authorized = message.scout_id === id;
    }
    if (!authorized) return res.status(403).json({ error: 'You do not have permission to delete this message.' });

    if (scope === 'self') {
      const { error } = await supabase
        .from('chat_message_hidden')
        .upsert({ message_id: messageId, viewer_role: role, viewer_id: id }, { onConflict: 'message_id,viewer_role,viewer_id' });
      if (error) throw error;
      return res.json({ success: true, scope: 'self' });
    }

    // scope === 'everyone'
    if (message.sender_role === 'admin') {
      return res.status(403).json({ error: 'RentaPay support messages cannot be deleted for everyone.' });
    }

    const isOwnMessage = message.sender_id === id && message.sender_role === role;
    const isCaretakerMessage = message.sender_role === 'manager' && message.sender_role_level === 'caretaker';
    const isFullManagerOrLandlord = role === 'landlord' || (role === 'manager' && req.user.roleLevel !== 'caretaker');
    const sameAccount = role === 'admin' || (role === 'landlord' ? message.landlord_id === id : role === 'manager' ? message.landlord_id === effectiveLandlordId(req) : false);

    let allowed = false;
    if (isCaretakerMessage) {
      // Only a manager/landlord on this account (or admin) can erase a
      // caretaker's message for everyone - never the caretaker itself.
      allowed = role === 'admin' || (isFullManagerOrLandlord && sameAccount);
    } else {
      allowed = role === 'admin' || isOwnMessage || (isFullManagerOrLandlord && sameAccount);
    }

    if (!allowed) {
      return res.status(403).json({ error: 'Only a property manager or landlord can delete this message for everyone.' });
    }

    const { error } = await supabase
      .from('chat_messages')
      .update({ deleted_for_everyone: true, deleted_at: new Date().toISOString(), deleted_by_role: role, body: null })
      .eq('id', messageId);
    if (error) throw error;

    return res.json({ success: true, scope: 'everyone' });
  } catch (err) {
    console.error('[chat] deleteMessage error:', err.message);
    return res.status(500).json({ error: 'Failed to delete message.' });
  }
}

module.exports = { sendMessage, listMessages, listThreads, deleteMessage };
