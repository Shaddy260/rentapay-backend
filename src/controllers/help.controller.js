// src/controllers/help.controller.js
//
// Implements blueprint section 15 (Help System): in-app form that
// emails you instantly with the requester's details.

const supabase = require('../config/supabase');
const { sendEmail, SUPPORT_EMAIL: DEFAULT_SUPPORT_EMAIL } = require('../services/email.service');

// Prefer a dedicated admin inbox if one's configured, but fall back to
// the platform's one shared support address (support@rentapay.co.ke)
// instead of silently sending no notification at all when
// SUPER_ADMIN_EMAIL isn't set.
const SUPPORT_EMAIL = process.env.SUPER_ADMIN_EMAIL || DEFAULT_SUPPORT_EMAIL;

async function submitHelpRequest(req, res) {
  try {
    const { name, phone, message, screenshotUrl } = req.body;
    const requesterType = req.user?.role || 'guest'; // 'landlord' | 'tenant' | 'manager' | 'guest' (not logged in - e.g. Login page)
    const requesterId = req.user?.id || null;
    // Manager and caretaker share backend role 'manager' - roleLevel is
    // what actually distinguishes them, so it's captured separately
    // to let the admin portal categorize help requests by their own
    // real user type instead of lumping caretakers in under "manager".
    const requesterRoleLevel = req.user?.roleLevel || null;

    if (!name || !message) {
      return res.status(400).json({ error: 'name and message are required.' });
    }

    // THE FIX: always capture a phone number, even if the person left
    // the field blank (or the form didn't ask) - we already know their
    // registered number from their account, so there's no reason a
    // help request should ever land with no way to call them back.
    // Guests (not logged in) have no account row to look this up from,
    // so this only applies to logged-in requesters.
    let resolvedPhone = phone || null;
    if (!resolvedPhone && requesterId) {
      const table = requesterType === 'landlord' ? 'landlords' : 'tenants';
      const phoneField = requesterType === 'landlord' ? 'phone' : 'primary_phone';
      const { data: account } = await supabase.from(table).select(phoneField).eq('id', requesterId).maybeSingle();
      resolvedPhone = account?.[phoneField] || null;
    }

    const { data: helpRequest, error } = await supabase
      .from('help_requests')
      .insert({
        requester_type: requesterType,
        requester_id: requesterId,
        requester_role_level: requesterRoleLevel,
        name,
        phone: resolvedPhone,
        message,
        screenshot_url: screenshotUrl || null,
      })
      .select()
      .single();

    if (error) throw error;

    let emailSent = false;
    if (SUPPORT_EMAIL) {
      try {
        await sendEmail(
          SUPPORT_EMAIL,
          `RentaPay Help Request from ${name} (${requesterType})`,
          `<p><strong>From:</strong> ${name} (${requesterType})</p>
           <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
           <p><strong>Message:</strong> ${message}</p>
           ${screenshotUrl ? `<p><a href="${screenshotUrl}">View screenshot</a></p>` : ''}`
        );
        emailSent = true;
      } catch (emailErr) {
        // The help_requests row above already saved successfully, so
        // the person's request is NOT lost - but if email delivery is
        // broken (e.g. unverified Resend domain), the admin would
        // otherwise never know a request came in at all. Log loudly;
        // the row in the database is the fallback way to discover it.
        console.error('[help] CRITICAL: notification email failed - request was saved but admin was NOT notified by email:', emailErr.message);
      }
    }

    return res.status(201).json({
      message: 'Help request submitted. We will respond within 24 hours.',
      helpRequest,
      emailSent,
    });
  } catch (err) {
    console.error('[help] submitHelpRequest error:', err.message);
    return res.status(500).json({ error: 'Failed to submit help request.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN: list + resolve help requests - THE FIX for item F ("help
// requests should land directly and visibly in your admin portal, not
// disappear into email or nowhere"). submitHelpRequest above was
// already saving every request to help_requests - it just had no
// corresponding read side, so the only way to see one was the email
// notification (which fails silently if SUPER_ADMIN_EMAIL/Resend
// isn't configured - the row survives, but nothing else did). This
// gives the admin dashboard something to actually read from.
// ---------------------------------------------------------------------
async function listHelpRequests(req, res) {
  try {
    const { status } = req.query; // optional filter: 'open' | 'resolved'

    // PERF: this had no cap, so the admin dashboard's Help tab pulled
    // every help request ever submitted, on every open - it only got
    // slower as the table grew. Capped to the most recent 500, which
    // is what an admin queue actually needs to act on; add real
    // pagination if a full historical view is needed later.
    let query = supabase.from('help_requests').select('*').order('created_at', { ascending: false }).limit(500);
    if (status === 'open' || status === 'resolved') query = query.eq('status', status);

    const { data: helpRequests, error } = await query;
    if (error) throw error;

    return res.json({ helpRequests });
  } catch (err) {
    console.error('[help] listHelpRequests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch help requests.' });
  }
}

async function resolveHelpRequest(req, res) {
  try {
    const { requestId } = req.params;
    const { resolutionNote } = req.body;

    const { error } = await supabase
      .from('help_requests')
      .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: resolutionNote || null })
      .eq('id', requestId);

    if (error) throw error;

    return res.json({ message: 'Help request marked resolved.' });
  } catch (err) {
    console.error('[help] resolveHelpRequest error:', err.message);
    return res.status(500).json({ error: 'Failed to update help request.' });
  }
}

// A logged-in tenant/landlord viewing their own submitted requests
// (the "Complaints" tab). Deliberately separate from the admin-only
// listHelpRequests above, which returns everyone's requests.
async function listMyHelpRequests(req, res) {
  try {
    const { data: helpRequests, error } = await supabase
      .from('help_requests')
      .select('*')
      .eq('requester_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return res.json({ helpRequests });
  } catch (err) {
    console.error('[help] listMyHelpRequests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch your requests.' });
  }
}

// FIX (direct request): "there should be a way to delete" help
// requests from the admin portal - previously the only lifecycle
// action was marking one resolved, with no way to clear it out
// entirely once it's been dealt with.
async function deleteHelpRequest(req, res) {
  try {
    const { requestId } = req.params;
    const { error } = await supabase.from('help_requests').delete().eq('id', requestId);
    if (error) throw error;
    return res.json({ message: 'Help request deleted.' });
  } catch (err) {
    console.error('[help] deleteHelpRequest error:', err.message);
    return res.status(500).json({ error: 'Failed to delete help request.' });
  }
}

// Powers the admin "Reply" button on a help request (direct request:
// "add a UI to reply directly - when I tap reply it opens the message
// to that specific user"). Reuses the existing admin<->landlord /
// admin<->tenant chat system (chat.controller.js) rather than
// building a separate reply mechanism - this just works out WHICH
// thread that requester's messages belong to.
//
// The tricky case is a manager/caretaker: help_requests.requester_id
// for them is a property_managers.id, not a landlords.id, and there's
// no separate admin<->manager thread type - per chat.controller.js,
// managers/caretakers share their landlord's single admin_landlord
// support inbox, so replying to a manager's help request opens THAT
// landlord's thread (the manager will see the reply the next time
// they open "Chat with an agent" from their own portal).
async function getReplyThread(req, res) {
  try {
    const { requestId } = req.params;
    const { data: request, error } = await supabase
      .from('help_requests')
      .select('id, requester_type, requester_id')
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw error;
    if (!request) return res.status(404).json({ error: 'Help request not found.' });

    if (request.requester_type === 'guest' || !request.requester_id) {
      return res.json({ replyable: false, reason: 'This request was sent before the person had an account, so there\u2019s no in-app chat to reply in. Use the phone number provided instead.' });
    }

    if (request.requester_type === 'tenant') {
      return res.json({ replyable: true, thread: { threadType: 'admin_tenant', tenantId: request.requester_id } });
    }

    if (request.requester_type === 'landlord') {
      return res.json({ replyable: true, thread: { threadType: 'admin_landlord', landlordId: request.requester_id } });
    }

    if (request.requester_type === 'manager') {
      const { data: manager } = await supabase
        .from('property_managers')
        .select('landlord_id')
        .eq('id', request.requester_id)
        .maybeSingle();
      if (!manager) {
        return res.json({ replyable: false, reason: 'This manager/caretaker account no longer exists.' });
      }
      return res.json({ replyable: true, thread: { threadType: 'admin_landlord', landlordId: manager.landlord_id } });
    }

    // Scouts don't have an admin<->scout chat thread type yet (only
    // scout<->landlord chat exists, per chat.controller.js's
    // 'scout_landlord' thread type) - marked explicitly non-replyable
    // rather than falling through to the generic "unrecognized" message
    // below, so this reads as a real, known limitation rather than a
    // data problem. The phone number captured on the request is the
    // fallback contact method until an admin<->scout thread exists.
    if (request.requester_type === 'scout') {
      return res.json({ replyable: false, reason: 'In-app reply to Scouts isn\u2019t available yet. Use the phone number provided instead.' });
    }

    return res.json({ replyable: false, reason: 'Unrecognized requester type.' });
  } catch (err) {
    console.error('[help] getReplyThread error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve reply thread.' });
  }
}

module.exports = { submitHelpRequest, listHelpRequests, listMyHelpRequests, resolveHelpRequest, deleteHelpRequest, getReplyThread };
