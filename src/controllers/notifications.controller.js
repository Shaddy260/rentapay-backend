// src/controllers/notifications.controller.js
//
// The in-portal inbox side of the "SMS + portal inbox" requirement.
// Works the same for all three roles - each account only ever sees
// its own notifications, scoped by (recipient_type, recipient_id).
// Managers see their landlord's notifications too (shared access,
// per the "managers share common access with landlords" rule), in
// addition to any sent directly to the manager account itself.

const supabase = require('../config/supabase');
const { effectiveLandlordId } = require('../middleware/auth.middleware');

function recipientFor(req) {
  if (req.user.role === 'tenant') return { type: 'tenant', id: req.user.id };
  if (req.user.role === 'manager') return { type: 'landlord', id: effectiveLandlordId(req) };
  // FIX: scout and admin used to fall through to the landlord default
  // below - a scout's own uuid queried as recipient_type='landlord'
  // never matches the recipient_type='scout' rows notify() actually
  // inserts for them, and 'super-admin' isn't even a valid landlord
  // uuid. Both silently saw an empty inbox forever.
  if (req.user.role === 'scout') return { type: 'scout', id: req.user.id };
  if (req.user.role === 'admin') return { type: 'admin', id: 'super-admin' };
  return { type: 'landlord', id: req.user.id };
}

// FIX ("New-user cutoff"): a freshly created account (or a tenant
// added to an existing landlord's portfolio) should never see the
// backlog of notifications that predate them - e.g. a brand-new
// manager account seeing months of the landlord's old rent-reminder
// history on first login. Every notification is already timestamped
// (created_at); this just looks up when the recipient's own account
// was created and filters the inbox query to that cutoff onward.
async function recipientCreatedAt(type, id) {
  if (type === 'admin') return null; // no "account creation" concept for the single super-admin account - never filter its inbox
  const table = type === 'landlord' ? 'landlords' : type === 'manager' ? 'property_managers' : type === 'scout' ? 'scouts' : 'tenants';
  const { data } = await supabase.from(table).select('created_at').eq('id', id).maybeSingle();
  return data?.created_at || null;
}

async function listNotifications(req, res) {
  try {
    const { type, id } = recipientFor(req);
    const { propertyId } = req.query;

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('recipient_type', type)
      .eq('recipient_id', id)
      .order('created_at', { ascending: false })
      .limit(100);

    // FIX (direct request: "every apartment be solely independent...
    // nothing should leak, not even notifications"): a landlord/
    // manager's inbox used to always show everything tied to their
    // account, no matter which property was actually selected. When
    // the caller tells us which property is active, only show
    // notifications tagged for THAT property, plus ones with no
    // property_id at all (genuinely account-wide notices - a password
    // change, subscription renewal on the account's own original
    // property, etc. - which are shared right alongside the profile
    // and phone number, same as everything else that's meant to stay
    // account-wide rather than per-apartment).
    if (propertyId && (type === 'landlord' || type === 'manager')) {
      query = query.or(`property_id.eq.${propertyId},property_id.is.null`);
    }

    // Managers share the landlord's recipient bucket, so the cutoff
    // here is deliberately the LANDLORD's own created_at (via
    // recipientFor's `type`/`id`), not the manager's - a manager added
    // later to an existing landlord account is meant to see that
    // landlord's ongoing notifications, just never anything from
    // before the shared bucket itself existed.
    const cutoff = await recipientCreatedAt(type, id);
    if (cutoff) query = query.gte('created_at', cutoff);

    const { data, error } = await query;
    if (error) throw error;

    const unreadCount = (data || []).filter((n) => !n.read_at).length;
    return res.json({ notifications: data || [], unreadCount });
  } catch (err) {
    console.error('[notifications] listNotifications error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
}

async function markRead(req, res) {
  try {
    const { notificationId } = req.params;
    const { type, id } = recipientFor(req);

    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('recipient_type', type)
      .eq('recipient_id', id);
    if (error) throw error;

    return res.json({ message: 'Marked as read.' });
  } catch (err) {
    console.error('[notifications] markRead error:', err.message);
    return res.status(500).json({ error: 'Failed to update notification.' });
  }
}

async function markAllRead(req, res) {
  try {
    const { type, id } = recipientFor(req);
    const { propertyId } = req.query;

    let query = supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_type', type)
      .eq('recipient_id', id)
      .is('read_at', null);

    if (propertyId && (type === 'landlord' || type === 'manager')) {
      query = query.or(`property_id.eq.${propertyId},property_id.is.null`);
    }

    const { error } = await query;
    if (error) throw error;

    return res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('[notifications] markAllRead error:', err.message);
    return res.status(500).json({ error: 'Failed to update notifications.' });
  }
}

// FIX (direct request: "remove delete for me/delete for all, add a
// read-all that deletes messages for that specific user only, and
// tapping a single message deletes it too"): notification rows are
// already per-recipient (unlike announcements, which fan one message
// out to many people), so there's no "delete for everyone" concept
// to offer here in the first place - deleting a row scoped to
// (recipient_type, recipient_id) can never affect any other user's
// inbox. These two endpoints replace the old read/read-all ones:
// instead of flagging a notification as read, we just delete it -
// once seen (single tap) or cleared (read-all), it's gone for that
// user and never reappears.
async function deleteNotification(req, res) {
  try {
    const { notificationId } = req.params;
    const { type, id } = recipientFor(req);

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', notificationId)
      .eq('recipient_type', type)
      .eq('recipient_id', id);
    if (error) throw error;

    return res.json({ message: 'Notification deleted.' });
  } catch (err) {
    console.error('[notifications] deleteNotification error:', err.message);
    return res.status(500).json({ error: 'Failed to delete notification.' });
  }
}

async function deleteAllNotifications(req, res) {
  try {
    const { type, id } = recipientFor(req);
    const { propertyId } = req.query;

    let query = supabase
      .from('notifications')
      .delete()
      .eq('recipient_type', type)
      .eq('recipient_id', id);

    // Mirrors listNotifications' property scoping: only clear what
    // this view actually shows (the active property's notifications
    // plus account-wide ones), never a property the caller can't see.
    if (propertyId && (type === 'landlord' || type === 'manager')) {
      query = query.or(`property_id.eq.${propertyId},property_id.is.null`);
    }

    const { error } = await query;
    if (error) throw error;

    return res.json({ message: 'All notifications deleted.' });
  } catch (err) {
    console.error('[notifications] deleteAllNotifications error:', err.message);
    return res.status(500).json({ error: 'Failed to delete notifications.' });
  }
}

module.exports = { listNotifications, markRead, markAllRead, deleteNotification, deleteAllNotifications };
