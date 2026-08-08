// src/controllers/community.controller.js
//
// Tenant<->tenant community board + marketplace. Deliberately separate
// from announcements (landlord->tenant broadcast) and help (tenant->
// landlord, private) - this is the first peer-to-peer surface: tenants
// posting to and reading from each other, scoped to "everyone in this
// property". Landlord/manager can moderate but never has to post.

const supabase = require('../config/supabase');
const sharp = require('sharp');
const { effectiveLandlordId, getManagerAssignedPropertyIds, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { notify } = require('../services/notify.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// Same bucket approach as unit photos (ONE-TIME SETUP: create a public
// Storage bucket named "community-photos" in the Supabase dashboard).
const COMMUNITY_PHOTOS_BUCKET = 'community-photos';
const MAX_COMMUNITY_PHOTOS = 5;

async function processCommunityPhoto(buffer) {
  return sharp(buffer).rotate().resize(1200, 900, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}

// Uploads whatever files came through multer (req.files) for a new
// post and returns the public URLs, best-effort (a single bad file
// never fails the whole post - it's just skipped).
async function uploadPostPhotos(files, authorType, authorId) {
  const urls = [];
  const list = (files || []).slice(0, MAX_COMMUNITY_PHOTOS);
  for (let i = 0; i < list.length; i += 1) {
    let processed;
    try {
      processed = await processCommunityPhoto(list[i].buffer);
    } catch (sharpErr) {
      logger.error('[community] photo processing failed, skipping one file:', sharpErr.message);
      captureException(sharpErr);
      continue;
    }
    const path = `${authorType}-${authorId}/${Date.now()}-${i}.webp`;
    const { error: uploadError } = await supabase.storage.from(COMMUNITY_PHOTOS_BUCKET).upload(path, processed, { contentType: 'image/webp' });
    if (uploadError) {
      logger.error('[community] photo storage error for one file:', uploadError.message);
      captureException(uploadError);
      continue;
    }
    const { data: publicUrlData } = supabase.storage.from(COMMUNITY_PHOTOS_BUCKET).getPublicUrl(path);
    urls.push(publicUrlData.publicUrl);
  }
  return urls;
}

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
    // NOTE: effectiveLandlordId() can't be used here - for a tenant,
    // req.user.id is the tenant's own id, not a landlords.id, so it
    // must be looked up via the tenant's own landlord_id column
    // (same pattern as chat.controller.js / announcement.controller.js).
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('unit_id, landlord_id, move_in_date, units(property_id)')
      .eq('id', req.user.id)
      .single();
    if (error || !tenant) return { error: { statusCode: 404, error: 'Tenant record not found.' } };
    return { propertyId: tenant.units?.property_id || null, landlordId: tenant.landlord_id, moveInDate: tenant.move_in_date || null };
  }
  return { propertyId: req.query.propertyId || req.body.propertyId || null };
}

// ---------------------------------------------------------------------
// LIST - board or marketplace posts for the caller's property.
// ---------------------------------------------------------------------
async function listPosts(req, res) {
  try {
    const kind = req.query.kind === 'marketplace' ? 'marketplace' : 'board';
    let landlordId = effectiveLandlordId(req);
    const reader = { type: authorTypeFor(req.user.role), id: req.user.id };

    let propertyId = null;
    let tenantMoveInDate = null;
    if (req.user.role === 'tenant') {
      const resolved = await resolveCallerProperty(req);
      if (resolved.error) return res.status(resolved.error.statusCode).json({ error: resolved.error.error });
      propertyId = resolved.propertyId;
      landlordId = resolved.landlordId;
      tenantMoveInDate = resolved.moveInDate;
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
          return res.json({ posts: [], unreadCount: 0 });
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
        const visiblePosts = await filterHiddenForViewer(data || [], reader);
        const posts = await withAuthorNames(visiblePosts, reader);
        return res.json({ posts, unreadCount: posts.filter((p) => !p.isRead).length });
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
    // DIRECT REQUEST: a tenant should only see community chat from the
    // day they actually joined onward, not the property's full
    // pre-existing history from before they moved in.
    if (req.user.role === 'tenant' && tenantMoveInDate) query = query.gte('created_at', tenantMoveInDate);

    const { data, error } = await query;
    if (error) throw error;

    const visiblePosts = await filterHiddenForViewer(data || [], reader);
    const posts = await withAuthorNames(visiblePosts, reader);
    res.json({ posts, unreadCount: posts.filter((p) => !p.isRead).length });
  } catch (err) {
    logger.error('[community] listPosts error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not load the community board.' });
  }
}

// ---------------------------------------------------------------------
// UNREAD COUNT (sidebar badge) - direct request: "no notification
// counter on community ui... in all portals." Lighter than listPosts:
// no author-name lookups, just enough to size the badge. Combines
// BOTH board and marketplace kinds, since the sidebar has a single
// "Community Board" nav item covering both.
// ---------------------------------------------------------------------
async function getUnreadCount(req, res) {
  try {
    let landlordId = effectiveLandlordId(req);
    const reader = { type: authorTypeFor(req.user.role), id: req.user.id };

    let propertyId = null;
    let assignedPropertyIds = null;
    let tenantMoveInDate = null;
    if (req.user.role === 'tenant') {
      const resolved = await resolveCallerProperty(req);
      if (resolved.error) return res.status(resolved.error.statusCode).json({ error: resolved.error.error });
      propertyId = resolved.propertyId;
      landlordId = resolved.landlordId;
      tenantMoveInDate = resolved.moveInDate;
    } else if (req.user.role === 'manager') {
      assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedPropertyIds.length === 0) return res.json({ unreadCount: 0 });
    }

    let query = supabase
      .from('community_posts')
      .select('*, community_post_replies(*)')
      .eq('landlord_id', landlordId)
      .is('deleted_at', null);
    if (propertyId) query = query.eq('property_id', propertyId);
    if (assignedPropertyIds) query = query.in('property_id', assignedPropertyIds);
    if (req.user.role === 'tenant' && tenantMoveInDate) query = query.gte('created_at', tenantMoveInDate);

    const { data, error } = await query;
    if (error) throw error;

    const posts = await withAuthorNames(data || [], reader);
    res.json({ unreadCount: posts.filter((p) => !p.isRead).length });
  } catch (err) {
    logger.error('[community] getUnreadCount error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not load unread count.' });
  }
}

// ---------------------------------------------------------------------
// MARK READ - called by the frontend once a post/thread has actually
// been shown to this reader (CommunityPanel, on load and on new
// replies coming in). Upsert rather than insert: reopening an
// already-read post just bumps read_at forward, doesn't error on the
// existing row.
// ---------------------------------------------------------------------
async function markRead(req, res) {
  try {
    const { postIds } = req.body;
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ error: 'postIds must be a non-empty array.' });
    }
    const reader = { type: authorTypeFor(req.user.role), id: req.user.id };
    const rows = postIds.map((postId) => ({ post_id: postId, reader_type: reader.type, reader_id: reader.id, read_at: new Date().toISOString() }));

    const { error } = await supabase.from('community_post_reads').upsert(rows, { onConflict: 'post_id,reader_type,reader_id' });
    if (error) throw error;

    res.json({ message: 'Marked as read.' });
  } catch (err) {
    logger.error('[community] markRead error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Failed to mark as read.' });
  }
}

// Fills in each post/reply author's display name so the frontend
// never has to make N follow-up requests. Best-effort - a lookup
// failure just falls back to a generic label rather than failing the
// whole list.
// "Delete for me" support: strips out posts/replies THIS viewer has
// hidden, without affecting what anyone else sees. Applied after the
// real DB fetch (which already excludes properly deleted_at posts)
// rather than folded into the query itself, since it also needs to
// prune replies nested inside each post.
async function filterHiddenForViewer(posts, reader) {
  const [{ data: hiddenPosts }, { data: hiddenReplies }] = await Promise.all([
    supabase.from('community_post_hidden').select('post_id').eq('viewer_type', reader.type).eq('viewer_id', reader.id),
    supabase.from('community_reply_hidden').select('reply_id').eq('viewer_type', reader.type).eq('viewer_id', reader.id),
  ]);
  const hiddenPostIds = new Set((hiddenPosts || []).map((h) => h.post_id));
  const hiddenReplyIds = new Set((hiddenReplies || []).map((h) => h.reply_id));

  return posts
    .filter((p) => !hiddenPostIds.has(p.id))
    .map((p) => ({
      ...p,
      community_post_replies: (p.community_post_replies || []).filter((r) => !hiddenReplyIds.has(r.id)),
    }));
}

async function withAuthorNames(posts, reader) {
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
    logger.error('[community] withAuthorNames lookup error:', err.message);
    captureException(err);
  }

  const labelFor = (type, id) => names[type]?.[id] || (type === 'landlord' ? 'Landlord' : type === 'manager' ? 'Property Manager' : 'Neighbor');

  // NOTIFICATION COUNTER (direct request): a post/thread reads as
  // "unread" for this caller if its most recent activity (the post
  // itself, or its newest reply) came from someone else AND happened
  // after this caller last read it (or they've never read it at all).
  // Your own posts/replies never mark themselves unread for you - the
  // badge is about "someone else did something you haven't seen yet",
  // not a log of your own actions.
  let readMap = new Map();
  if (reader) {
    const { data: reads } = await supabase
      .from('community_post_reads')
      .select('post_id, read_at')
      .eq('reader_type', reader.type)
      .eq('reader_id', reader.id)
      .in('post_id', posts.map((p) => p.id));
    readMap = new Map((reads || []).map((r) => [r.post_id, r.read_at]));
  }

  return posts
    .map((p) => {
      const replies = (p.community_post_replies || [])
        .filter((r) => !r.deleted_at)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      let isRead = true;
      if (reader) {
        const latest = replies.length ? replies[replies.length - 1] : p;
        const latestAuthorIsReader = latest.author_type === reader.type && latest.author_id === reader.id;
        const readAt = readMap.get(p.id);
        isRead = latestAuthorIsReader || (!!readAt && new Date(readAt) >= new Date(latest.created_at));
      }

      return {
        ...p,
        authorName: labelFor(p.author_type, p.author_id),
        isRead,
        community_post_replies: replies.map((r) => ({ ...r, authorName: labelFor(r.author_type, r.author_id) })),
      };
    })
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

    let landlordId = effectiveLandlordId(req);
    let propertyId;

    if (req.user.role === 'tenant') {
      const resolved = await resolveCallerProperty(req);
      if (resolved.error) return res.status(resolved.error.statusCode).json({ error: resolved.error.error });
      propertyId = resolved.propertyId;
      landlordId = resolved.landlordId;
    } else {
      propertyId = req.body.propertyId || null;
      if (propertyId && req.user.role === 'manager') {
        const propertyAccessError = await checkManagerPropertyAccess(req, propertyId);
        if (propertyAccessError) return res.status(propertyAccessError.statusCode).json({ error: propertyAccessError.error });
      }
    }

    // FEATURE (direct request): posts can now carry photos, not just
    // text. Files arrive via multer (handleCommunityPhotosUpload) as
    // req.files when the request is multipart/form-data; a plain JSON
    // request (no photos) still works exactly as before.
    const authorType = authorTypeFor(req.user.role);
    let photoUrls = [];
    if (req.files && req.files.length > 0) {
      photoUrls = await uploadPostPhotos(req.files, authorType, req.user.id);
    }

    const { data: post, error } = await supabase
      .from('community_posts')
      .insert({
        landlord_id: landlordId,
        property_id: propertyId,
        author_type: authorType,
        author_id: req.user.id,
        kind,
        title: title?.trim() || null,
        body: body.trim(),
        price: kind === 'marketplace' && price ? Number(price) : null,
        photo_url: photoUrl || (photoUrls[0] || null),
        photo_urls: photoUrls.length ? photoUrls : null,
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ post });
  } catch (err) {
    logger.error('[community] createPost error:', err.message);
    captureException(err);
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
    logger.error('[community] pinPost error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not update the post.' });
  }
}

// ---------------------------------------------------------------------
// DELETE - the post's own author, or a landlord/manager moderating
// their own property (never another landlord's). Soft delete, same
// shape as chat_messages, so a deleted post can still be told apart
// from one that never existed if it's ever referenced elsewhere.
// ---------------------------------------------------------------------
// DIRECT REQUEST: "each user should be able to delete the messages in
// their own inbox - when one deletes, it should delete for himself
// only, except for landlord/manager/caretaker who can choose to
// delete for all or for themselves." This function is now the
// "delete for everyone" action - moderator-only, even for a tenant's
// own post (they use hidePost below instead, same as everyone else's
// default). Real, permanent removal from the whole property's view.
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
    const isModerator = isOwnAccount && (req.user.role === 'landlord' || req.user.role === 'manager');

    if (!isModerator) {
      return res.status(403).json({ error: 'Only a landlord, manager, or caretaker can delete a post for everyone. Use "Delete for me" to remove it from just your own view.' });
    }
    if (req.user.role === 'manager' && post.property_id) {
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
    logger.error('[community] deletePost error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not delete the post.' });
  }
}

/**
 * "Delete for me" - hides a post from just the caller's own view,
 * regardless of who authored it or their role. Available to everyone
 * (tenant, landlord, manager, caretaker) for any post they can
 * currently see - this is what a tenant's "Delete" button does, and
 * what a landlord/manager/caretaker's "Delete for me" option does.
 */
async function hidePost(req, res) {
  try {
    const { postId } = req.params;
    const viewerType = authorTypeFor(req.user.role);
    const { error } = await supabase
      .from('community_post_hidden')
      .upsert({ post_id: postId, viewer_type: viewerType, viewer_id: req.user.id }, { onConflict: 'post_id,viewer_type,viewer_id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('[community] hidePost error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not remove this post from your view.' });
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
        logger.error('[community] notifyPostAuthorOfReply error:', err.message);
        captureException(err);
      });
    }
  } catch (err) {
    logger.error('[community] createReply error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not post the reply.' });
  }
}

// ---------------------------------------------------------------------
// DELETE REPLY - same author-or-moderator rule as posts.
// ---------------------------------------------------------------------
// "Delete for everyone" - moderator-only, same reasoning as deletePost above.
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
    const isModerator = isOwnAccount && (req.user.role === 'landlord' || req.user.role === 'manager');

    if (!isModerator) {
      return res.status(403).json({ error: 'Only a landlord, manager, or caretaker can delete a reply for everyone. Use "Delete for me" to remove it from just your own view.' });
    }

    const { error } = await supabase
      .from('community_post_replies')
      .update({ deleted_at: new Date().toISOString(), deleted_by_role: req.user.role === 'manager' ? 'manager' : req.user.role })
      .eq('id', replyId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    logger.error('[community] deleteReply error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not delete the reply.' });
  }
}

/** "Delete for me" for a reply - same as hidePost above. */
async function hideReply(req, res) {
  try {
    const { replyId } = req.params;
    const viewerType = authorTypeFor(req.user.role);
    const { error } = await supabase
      .from('community_reply_hidden')
      .upsert({ reply_id: replyId, viewer_type: viewerType, viewer_id: req.user.id }, { onConflict: 'reply_id,viewer_type,viewer_id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('[community] hideReply error:', err.message);
    captureException(err);
    res.status(500).json({ error: 'Could not remove this reply from your view.' });
  }
}

const AUTHOR_TABLE = {
  tenant: { table: 'tenants', phoneField: 'primary_phone' },
  landlord: { table: 'landlords', phoneField: 'phone' },
  manager: { table: 'property_managers', phoneField: 'phone' },
};

/**
 * REPORT (direct request): flag a post or reply as violating RentaPay's
 * terms - hate speech, nudity/sexual content, etc. Notifies every
 * landlord/manager/caretaker on this property EXCEPT the reporter (if
 * the reporter happens to be one of the three), plus a background copy
 * to admin that includes the reported content itself. Doesn't touch
 * the post/reply at all - purely a flag for a human to review; the
 * reporter can still separately use "delete for me" if they don't want
 * to see it themselves while waiting.
 */
async function reportContent(req, res) {
  try {
    const { postId, replyId, reason } = req.body;
    if (!postId && !replyId) return res.status(400).json({ error: 'postId or replyId is required.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Please explain why you are reporting this.' });

    let post = null;
    let reply = null;
    if (replyId) {
      const { data, error } = await supabase
        .from('community_post_replies')
        .select('id, body, author_type, author_id, post_id, community_posts(landlord_id, property_id)')
        .eq('id', replyId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Reply not found.' });
      reply = data;
      post = { landlord_id: data.community_posts?.landlord_id, property_id: data.community_posts?.property_id };
    } else {
      const { data, error } = await supabase
        .from('community_posts')
        .select('id, body, photo_urls, author_type, author_id, landlord_id, property_id')
        .eq('id', postId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Post not found.' });
      post = data;
    }

    const reportedType = reply ? reply.author_type : post.author_type;
    const reportedId = reply ? reply.author_id : post.author_id;
    const reporterType = authorTypeFor(req.user.role);
    const reporterId = req.user.id;

    if (reportedType === reporterType && reportedId === reporterId) {
      return res.status(400).json({ error: "You can't report your own message." });
    }

    const { data: created, error: insertErr } = await supabase
      .from('community_reports')
      .insert({
        landlord_id: post.landlord_id,
        property_id: post.property_id,
        post_id: postId || reply?.post_id || null,
        reply_id: replyId || null,
        reported_type: reportedType,
        reported_id: reportedId,
        reporter_type: reporterType,
        reporter_id: reporterId,
        reason: reason.trim(),
        content_snapshot: reply ? reply.body : post.body,
        photo_urls: reply ? null : post.photo_urls || null,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    // Bump the reported account's running report_count (admin dashboard
    // "show how many times they have been reported").
    const reportedTable = AUTHOR_TABLE[reportedType]?.table;
    if (reportedTable) {
      const { data: reportedAccount } = await supabase.from(reportedTable).select('report_count').eq('id', reportedId).maybeSingle();
      await supabase.from(reportedTable).update({ report_count: (reportedAccount?.report_count || 0) + 1 }).eq('id', reportedId);
    }

    await notifyReportRecipients(post.landlord_id, post.property_id, created, reporterType, reporterId);

    return res.status(201).json({ message: 'Report submitted. The landlord, manager, or caretaker will review it.' });
  } catch (err) {
    logger.error('[community] reportContent error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit report.' });
  }
}

// Notifies every landlord/manager/caretaker on this property EXCEPT
// the reporter (direct request: "if it's one of them reporting, don't
// notify the one who reported"), plus a background admin copy that
// includes the reported content. Mirrors
// tenantOnboarding.controller.js's getPropertyStakeholders pattern.
async function notifyReportRecipients(landlordId, propertyId, report, reporterType, reporterId) {
  const [{ data: landlord }, { data: assignments }] = await Promise.all([
    supabase.from('landlords').select('id, full_name').eq('id', landlordId).maybeSingle(),
    propertyId
      ? supabase.from('property_manager_assignments').select('property_managers(id, is_active, role_level)').eq('property_id', propertyId)
      : Promise.resolve({ data: [] }),
  ]);
  const staff = (assignments || []).map((a) => a.property_managers).filter((m) => m && m.is_active !== false);

  const message = `A community post/reply was reported (reason: "${report.reason}"). Please review it in Community.`;
  const jobs = [];
  if (landlord && !(reporterType === 'landlord' && reporterId === landlordId)) {
    jobs.push(notify('landlord', landlord.id, null, message, { category: 'account', propertyId }));
  }
  for (const m of staff) {
    if (reporterType === 'manager' && reporterId === m.id) continue; // don't notify the reporter
    jobs.push(notify('manager', m.id, null, message, { category: 'account', propertyId }));
  }

  const results = await Promise.allSettled(jobs);
  results.forEach((r) => { if (r.status === 'rejected') logger.error('[community] notifyReportRecipients delivery failed:', r.reason?.message || r.reason); });

  // Background admin copy - always sent regardless of who reported,
  // includes the reported message/photo itself so admin doesn't have
  // to go look it up separately.
  try {
    const { sendEmail, wrapEmailHtml } = require('../services/email.service');
    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    if (adminEmail) {
      const photosBlock = report.photo_urls?.length ? `\n\nPhotos: ${report.photo_urls.join(', ')}` : '';
      await sendEmail(
        adminEmail,
        'RentaPay: Community content reported',
        wrapEmailHtml(
          `A ${report.reported_type} was reported on RentaPay's community board.\n\nReason: ${report.reason}\n\nReported content: "${report.content_snapshot}"${photosBlock}\n\nReview it in the admin portal under Reported Accounts.`
        )
      );
    }
  } catch (adminEmailErr) {
    logger.error('[community] notifyReportRecipients: admin copy failed:', adminEmailErr.message);
    captureException(adminEmailErr);
  }
}

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
  getUnreadCount,
  markRead,
  createPost,
  pinPost,
  deletePost,
  hidePost,
  createReply,
  deleteReply,
  hideReply,
  reportContent,
};
