// src/controllers/community.controller.js
//
// Tenant<->tenant community board + marketplace. Deliberately separate
// from announcements (landlord->tenant broadcast) and help (tenant->
// landlord, private) - this is the first peer-to-peer surface: tenants
// posting to and reading from each other, scoped to "everyone in this
// property". Landlord/manager can moderate but never has to post.

const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { notify } = require('../services/notify.service');

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function authorTypeFor(role) {
  if (role === 'tenant') return 'tenant';
  if (role === 'manager') return 'manager';
  return 'landlord';
}

// Resolves which property a caller is scoped to for community reads/
// writes. Tenants are always pinned to their OWN unit's property -
// never trust a propertyId a tenant sends, same defensive stance the
// rest of the app takes with effectiveLandlordId. Landlord/manager can
// pass ?propertyId= to view one property's board; omitting it falls
// back to "no property filter" (their whole portfolio) for
// landlords, or their assigned properties for managers.
async function resolveCallerProperty(req) {
  if (req.user.role === 'tenant') {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('unit_id, units(property_id)')
      .eq('id', req.user.id)
      .single();
    if (error || !tenant) return { error: { statusCode: 404, error: 'Tenant record not found.' } };
    return { propertyId: tenant.units?.property_id || null, landlordId: null };
  }
  return { propertyId: req.query.propertyId || req.body.propertyId || null };
}

// ---------------------------------------------------------------------
// LIST - board or marketplace posts for the caller's property.
// ---------------------------------------------------------------------
async function listPosts(req, res) {
  try {
    const kind = req.query.kind === 'marketplace' ? 'marketplace' : 'board';
    const landlordId = effectiveLandlordId(req);

    let propertyId = null;
    if (req.user.role === 'tenant') {
      const resolved = await resolveCallerProperty(req);
      if (resolved.error) return res.status(resolved.error.statusCode).json({ error: resolved.error.error });
      propertyId = resolved.propertyId;
    } else {
      propertyId = req.query.propertyId || null;
      if (propertyId && req.user.role === 'manager') {
        const propertyAccessError = await checkManagerPropertyAccess(req, propertyId);
        if (propertyAccessError) return res.status(propertyAccessError.statusCode).json({ error: propertyAccessError.error });
      }
      if (!propertyId && req.user.role === 'manager') {
        // No specific property requested - restrict to whatever
        // properties this manager/caretaker is actually assigned to,
        // same pattern used elsewhere for manager-scoped lists.
        const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
        if (assignedPropertyIds.length === 0) {
          return res.json({ posts: [] });
        }
        const { data, error } = await supabase
          .from('community_posts')
          .select('*, community_post_replies(*)')
          .eq('landlord_id', landlordId)
          .in('property_id', assignedPropertyIds)
          .eq('kind', kind)
          .is('deleted_at', null)
          .order('is_pinned', { ascending: false })
          .order('created_at', { ascending: false });
        if (error) throw error;
        return res.json({ posts: await withAuthorNames(data || []) });
      }
    }

    let query = supabase
      .from('community_posts')
      .select('*, community_post_replies(*)')
      .eq('landlord_id', landlordId)
      .eq('kind', kind)
      .is('deleted_at', null)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });

    if (propertyId) query = query.eq('property_id', propertyId);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ posts: await withAuthorNames(data || []) });
  } catch (err) {
    console.error('[community] listPosts error:', err.message);
    res.status(500).json({ error: 'Could not load the community board.' });
  }
}

// Fills in each post/reply author's display name so the frontend
// never has to make N follow-up requests. Best-effort - a lookup
// failure just falls back to a generic label rather than failing the
// whole list.
async function withAuthorNames(posts) {
  const ids = { tenant: new Set(), landlord: new Set(), manager: new Set() };
  for (const p of posts) {
    ids[p.author_type]?.add(p.author_id);
    for (const r of p.community_post_replies || []) ids[r.author_type]?.add(r.author_id);
  }

  const names = { tenant: {}, landlord: {}, manager: {} };
  try {
    if (ids.tenant.size) {
      const { data } = await supabase.from('tenants').select('id, full_name').in('id', [...ids.tenant]);
      for (const t of data || []) names.tenant[t.id] = t.full_name;
    }
    if (ids.landlord.size) {
      const { data } = await supabase.from('landlords').select('id, full_name').in('id', [...ids.landlord]);
      for (const l of data || []) names.landlord[l.id] = l.full_name;
    }
    if (ids.manager.size) {
      const { data } = await supabase.from('property_managers').select('id, full_name').in('id', [...ids.manager]);
      for (const m of data || []) names.manager[m.id] = m.full_name;
    }
  } catch (err) {
    console.error('[community] withAuthorNames lookup error:', err.message);
  }

  const labelFor = (type, id) => names[type]?.[id] || (type === 'landlord' ? 'Landlord' : type === 'manager' ? 'Property Manager' : 'Neighbor');

  return posts
    .map((p) => ({
      ...p,
      authorName: labelFor(p.author_type, p.author_id),
      community_post_replies: (p.community_post_replies || [])
        .filter((r) => !r.deleted_at)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map((r) => ({ ...r, authorName: labelFor(r.author_type, r.author_id) })),
    }))
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
}

// ---------------------------------------------------------------------
// CREATE - a tenant, landlord, manager, or caretaker posts to their
// own property's board/marketplace.
// ---------------------------------------------------------------------
async function createPost(req, res) {
  try {
    const { kind, title, body, price, photoUrl } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Post text is required.' });
    }
    if (kind !== 'board' && kind !== 'marketplace') {
      return res.status(400).json({ error: 'kind must be "board" or "marketplace".' });
    }

    const landlordId = effectiveLandlordId(req);
    let propertyId;

    if (req.user.role === 'tenant') {
      const resolved = await resolveCallerProperty(req);
      if (resolved.error) return res.status(resolved.error.statusCode).json({ error: resolved.error.error });
      propertyId = resolved.propertyId;
    } else {
      propertyId = req.body.propertyId || null;
      if (propertyId && req.user.role === 'manager') {
        const propertyAccessError = await checkManagerPropertyAccess(req, propertyId);
        if (propertyAccessError) return res.status(propertyAccessError.statusCode).json({ error: propertyAccessError.error });
      }
    }

    const { data: post, error } = await supabase
      .from('community_posts')
      .insert({
        landlord_id: landlordId,
        property_id: propertyId,
        author_type: authorTypeFor(req.user.role),
        author_id: req.user.id,
        kind,
        title: title?.trim() || null,
        body: body.trim(),
        price: kind === 'marketplace' && price ? Number(price) : null,
        photo_url: photoUrl || null,
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ post });
  } catch (err) {
    console.error('[community] createPost error:', err.message);
    res.status(500).json({ error: 'Could not create the post. Please try again.' });
  }
}

// ---------------------------------------------------------------------
// PIN / UNPIN - landlord or manager only.
// ---------------------------------------------------------------------
async function pinPost(req, res) {
  try {
    const { postId } = req.params;
    const { pinned } = req.body;
    const landlordId = effectiveLandlordId(req);

    const { data: post, error: fetchError } = await supabase
      .from('community_posts')
      .select('id, landlord_id, property_id')
      .eq('id', postId)
      .single();
    if (fetchError || !post) return res.status(404).json({ error: 'Post not found.' });
    if (post.landlord_id !== landlordId) return res.status(403).json({ error: 'You can only manage posts on your own properties.' });

    if (req.user.role === 'manager' && post.property_id) {
      const propertyAccessError = await checkManagerPropertyAccess(req, post.property_id);
      if (propertyAccessError) return res.status(propertyAccessError.statusCode).json({ error: propertyAccessError.error });
    }

    const { error } = await supabase.from('community_posts').update({ is_pinned: !!pinned }).eq('id', postId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('[community] pinPost error:', err.message);
    res.status(500).json({ error: 'Could not update the post.' });
  }
}

// ---------------------------------------------------------------------
// DELETE - the post's own author, or a landlord/manager moderating
// their own property (never another landlord's). Soft delete, same
// shape as chat_messages, so a deleted post can still be told apart
// from one that never existed if it's ever referenced elsewhere.
// ---------------------------------------------------------------------
async function deletePost(req, res) {
  try {
    const { postId } = req.params;
    const landlordId = effectiveLandlordId(req);

    const { data: post, error: fetchError } = await supabase
      .from('community_posts')
      .select('id, landlord_id, property_id, author_type, author_id')
      .eq('id', postId)
      .single();
    if (fetchError || !post) return res.status(404).json({ error: 'Post not found.' });

    const isOwnAccount = post.landlord_id === landlordId;
    const isAuthor = post.author_type === authorTypeFor(req.user.role) && post.author_id === req.user.id;
    const isModerator = isOwnAccount && (req.user.role === 'landlord' || req.user.role === 'manager');

    if (!isAuthor && !isModerator) {
      return res.status(403).json({ error: 'You can only delete your own posts.' });
    }
    if (isModerator && req.user.role === 'manager' && post.property_id) {
      const propertyAccessError = await checkManagerPropertyAccess(req, post.property_id);
      if (propertyAccessError) return res.status(propertyAccessError.statusCode).json({ error: propertyAccessError.error });
    }

    const { error } = await supabase
      .from('community_posts')
      .update({ deleted_at: new Date().toISOString(), deleted_by_role: req.user.role === 'manager' ? 'manager' : req.user.role })
      .eq('id', postId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('[community] deletePost error:', err.message);
    res.status(500).json({ error: 'Could not delete the post.' });
  }
}

// ---------------------------------------------------------------------
// REPLY - anyone who can see the board can reply to a post.
// ---------------------------------------------------------------------
async function createReply(req, res) {
  try {
    const { postId } = req.params;
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Reply text is required.' });

    const landlordId = effectiveLandlordId(req);
    const { data: post, error: fetchError } = await supabase
      .from('community_posts')
      .select('id, landlord_id, property_id, author_type, author_id, title, body')
      .eq('id', postId)
      .is('deleted_at', null)
      .single();
    if (fetchError || !post) return res.status(404).json({ error: 'Post not found.' });
    if (post.landlord_id !== landlordId) return res.status(403).json({ error: 'You cannot reply to this post.' });

    const replierType = authorTypeFor(req.user.role);
    const { data: reply, error } = await supabase
      .from('community_post_replies')
      .insert({
        post_id: postId,
        author_type: replierType,
        author_id: req.user.id,
        body: body.trim(),
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ reply });

    // Fire-and-forget, after the response - a targeted "someone
    // replied to your post" ping to the ORIGINAL POST'S author only
    // (not a broadcast to the whole property). Deliberately non-urgent
    // (in-app inbox + email, no OS push) so replies stay a pull thing
    // you notice next time you open the app, not another push
    // notification competing for attention - same reasoning as why
    // this feature has no push fan-out anywhere else. Skipped entirely
    // if you're replying to your own post.
    if (!(post.author_type === replierType && post.author_id === req.user.id)) {
      notifyPostAuthorOfReply(post, body.trim()).catch((err) => {
        console.error('[community] notifyPostAuthorOfReply error:', err.message);
      });
    }
  } catch (err) {
    console.error('[community] createReply error:', err.message);
    res.status(500).json({ error: 'Could not post the reply.' });
  }
}

// ---------------------------------------------------------------------
// DELETE REPLY - same author-or-moderator rule as posts.
// ---------------------------------------------------------------------
async function deleteReply(req, res) {
  try {
    const { replyId } = req.params;
    const landlordId = effectiveLandlordId(req);

    const { data: reply, error: fetchError } = await supabase
      .from('community_post_replies')
      .select('id, author_type, author_id, post_id, community_posts(landlord_id, property_id)')
      .eq('id', replyId)
      .single();
    if (fetchError || !reply) return res.status(404).json({ error: 'Reply not found.' });

    const isOwnAccount = reply.community_posts?.landlord_id === landlordId;
    const isAuthor = reply.author_type === authorTypeFor(req.user.role) && reply.author_id === req.user.id;
    const isModerator = isOwnAccount && (req.user.role === 'landlord' || req.user.role === 'manager');

    if (!isAuthor && !isModerator) {
      return res.status(403).json({ error: 'You can only delete your own replies.' });
    }

    const { error } = await supabase
      .from('community_post_replies')
      .update({ deleted_at: new Date().toISOString(), deleted_by_role: req.user.role === 'manager' ? 'manager' : req.user.role })
      .eq('id', replyId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('[community] deleteReply error:', err.message);
    res.status(500).json({ error: 'Could not delete the reply.' });
  }
}

const AUTHOR_TABLE = {
  tenant: { table: 'tenants', phoneField: 'primary_phone' },
  landlord: { table: 'landlords', phoneField: 'phone' },
  manager: { table: 'property_managers', phoneField: 'phone' },
};

async function notifyPostAuthorOfReply(post, replyBody) {
  const lookup = AUTHOR_TABLE[post.author_type];
  if (!lookup) return;
  const { data: author } = await supabase.from(lookup.table).select(`id, ${lookup.phoneField}`).eq('id', post.author_id).maybeSingle();
  if (!author) return; // author's account no longer exists - nothing to notify

  const preview = replyBody.length > 140 ? `${replyBody.slice(0, 140)}…` : replyBody;
  const postLabel = post.title ? `"${post.title}"` : 'your post';

  await notify(post.author_type, post.author_id, author[lookup.phoneField], `New reply on ${postLabel}: ${preview}`, {
    title: 'New reply on the community board',
    category: 'community',
    urgent: false,
    propertyId: post.property_id || null,
  });
}

module.exports = {
  listPosts,
  createPost,
  pinPost,
  deletePost,
  createReply,
  deleteReply,
};
