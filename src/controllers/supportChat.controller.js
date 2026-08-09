// src/controllers/supportChat.controller.js
// AI Support Chat - see rentapay_ai_support_chat_spec.pdf.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const svc = require('../services/supportChat.service');

function currentUser(req) {
  const role = req.user.role; // 'tenant' | 'landlord' | 'manager' | 'admin'
  const roleLevel = req.user.roleLevel || null;
  const userType = role === 'admin' ? 'admin' : role;
  const userId = role === 'admin' ? 'super-admin' : req.user.id;
  return { role, roleLevel, userType, userId };
}

// ---------------------------------------------------------------------
// POST /api/support-chat/message
// The full fallback chain for a single incoming message: 7.1/7.2/7.3
// checks -> rule-based matcher -> Gemini -> Groq -> Cerebras ->
// OpenRouter -> category menu.
// ---------------------------------------------------------------------
async function sendMessage(req, res) {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
    const { role, roleLevel, userType, userId } = currentUser(req);

    const session = await svc.getOrCreateSession(userType, userId, roleLevel);
    const history = await svc.getTodayHistory(session.id);

    // Section 7.1/7.2 - checked on EVERY incoming message, before the
    // rule-based matcher or any AI tier is attempted.
    if (svc.detectExplicitEscalationIntent(message) || svc.detectFrustration(message)) {
      const reason = svc.detectFrustration(message) ? 'dissatisfaction' : 'user_requested';
      await svc.appendMessage(session.id, 'user', message, null, null);
      const escalation = await svc.logEscalation({ sessionId: session.id, userType, userId, roleLevel, reason });
      const reply = "I'll connect you with a support agent right away.";
      await svc.appendMessage(session.id, 'assistant', reply, 'system', null);
      return res.json({ reply, tier: 'escalation', escalate: true, tel: svc.CALL_HANDOFF_TEL, escalationId: escalation.id });
    }

    // Section 7.3 - always-escalate topics require verifying this
    // specific user's real account state, which no AI provider can do.
    const alwaysEscalateReason = svc.detectAlwaysEscalateTopic(message);
    if (alwaysEscalateReason) {
      await svc.appendMessage(session.id, 'user', message, null, null);
      const escalation = await svc.logEscalation({ sessionId: session.id, userType, userId, roleLevel, reason: `always_escalate_topic:${alwaysEscalateReason}` });
      const reply = "This needs a look at your actual account, so I'm connecting you with a support agent rather than guessing.";
      await svc.appendMessage(session.id, 'assistant', reply, 'system', null);
      return res.json({ reply, tier: 'escalation', escalate: true, tel: svc.CALL_HANDOFF_TEL, escalationId: escalation.id });
    }

    await svc.appendMessage(session.id, 'user', message, null, null);

    // Section 7.2 repetition check - same category matched 2-3 times
    // in a row proactively offers the agent, rather than answering again.
    const ruleMatch = await svc.ruleBasedMatch(message, role === 'manager' && roleLevel === 'caretaker' ? 'caretaker' : role);
    if (ruleMatch && svc.detectRepetition(history, ruleMatch.category)) {
      const reply = "It looks like I'm not getting this right - would you like to talk to an agent instead?";
      await svc.appendMessage(session.id, 'assistant', reply, 'system', ruleMatch.category);
      // Tag the offer so the widget can log the real reason ('repetition')
      // if the user taps it, instead of it defaulting to menu_exhausted.
      return res.json({ reply, tier: 'repetition_check', escalate: false, offerAgent: true, offerReason: 'repetition', offerCategory: ruleMatch.category });
    }

    // Tier 1: rule-based matcher (own code, no AI, attempted first).
    if (ruleMatch) {
      if (ruleMatch.escalateToHuman) {
        const escalation = await svc.logEscalation({ sessionId: session.id, userType, userId, roleLevel, reason: 'always_escalate_topic:flagged_topic', category: ruleMatch.category });
        await svc.appendMessage(session.id, 'assistant', ruleMatch.text, 'rule_based', ruleMatch.category);
        return res.json({ reply: ruleMatch.text, tier: 'rule_based', escalate: true, tel: svc.CALL_HANDOFF_TEL, escalationId: escalation.id });
      }
      await svc.appendMessage(session.id, 'assistant', ruleMatch.text, 'rule_based', ruleMatch.category);
      return res.json({ reply: ruleMatch.text, tier: 'rule_based', escalate: false, category: ruleMatch.category });
    }

    // Tiers 2-5: Gemini -> Groq -> Cerebras -> OpenRouter, in order,
    // each carrying the role-scoping instruction (Section 10.3) and
    // today's conversation history (Section 5).
    const systemPrompt = svc.roleSystemPrompt(role, roleLevel);
    const { turns } = svc.toProviderMessages(systemPrompt, history, message);
    const aiResult = await svc.getAIResponse(systemPrompt, turns);
    if (aiResult) {
      await svc.appendMessage(session.id, 'assistant', aiResult.text, aiResult.tier, null);
      return res.json({ reply: aiResult.text, tier: aiResult.tier, escalate: false });
    }

    // Tier 6: every automated tier failed - category menu, filtered by
    // role, always ending in "Talk to an agent".
    const menu = svc.buildCategoryMenu(role, roleLevel, null);
    const reply = "I couldn't find a confident answer for that. Pick whichever fits best, or talk to an agent:";
    await svc.appendMessage(session.id, 'assistant', reply, 'menu', null);
    return res.json({ reply, tier: 'menu', escalate: false, menu });
  } catch (err) {
    logger.error('[supportChat] sendMessage error:', err.message);
    return res.status(500).json({ error: 'Failed to process message.' });
  }
}

// ---------------------------------------------------------------------
// POST /api/support-chat/menu-select
// { category } - 'payment' | 'tenant_unit' | 'account_subscription' |
// 'maintenance' | 'other' | 'agent'
// ---------------------------------------------------------------------
async function selectMenuOption(req, res) {
  try {
    const { category } = req.body;
    if (!category) return res.status(400).json({ error: 'category is required' });
    const { role, roleLevel, userType, userId } = currentUser(req);
    const session = await svc.getOrCreateSession(userType, userId, roleLevel);

    if (category === 'agent') {
      const escalation = await svc.logEscalation({ sessionId: session.id, userType, userId, roleLevel, reason: 'menu_exhausted' });
      const reply = "Connecting you with a support agent.";
      await svc.appendMessage(session.id, 'assistant', reply, 'system', null);
      return res.json({ reply, escalate: true, tel: svc.CALL_HANDOFF_TEL, escalationId: escalation.id });
    }

    // Narrow to the next menu level for that category, informed by
    // what's already been discussed (still always ending in "agent").
    const submenu = svc.buildCategoryMenu(role, roleLevel, category);
    const reply = `Got it - here's a bit more detail on ${category.replace('_', ' ')}, or talk to an agent if this doesn't cover it:`;
    await svc.appendMessage(session.id, 'assistant', reply, 'menu', category);
    return res.json({ reply, escalate: false, menu: submenu, category });
  } catch (err) {
    logger.error('[supportChat] selectMenuOption error:', err.message);
    return res.status(500).json({ error: 'Failed to process selection.' });
  }
}

// ---------------------------------------------------------------------
// POST /api/support-chat/escalate
// Direct "Talk to an agent" tap (Section 4) - also schedules the
// Section 9.2 backup rating-reminder push for ~12 minutes later.
// ---------------------------------------------------------------------
async function escalateToAgent(req, res) {
  try {
    const { category, reason } = req.body;
    const { userType, userId, roleLevel } = currentUser(req);
    const session = await svc.getOrCreateSession(userType, userId, roleLevel);
    const escalation = await svc.logEscalation({
      sessionId: session.id,
      userType,
      userId,
      roleLevel,
      reason: reason || 'user_requested',
      category: category || null,
    });
    return res.json({ tel: svc.CALL_HANDOFF_TEL, escalationId: escalation.id });
  } catch (err) {
    logger.error('[supportChat] escalateToAgent error:', err.message);
    return res.status(500).json({ error: 'Failed to log escalation.' });
  }
}

// ---------------------------------------------------------------------
// POST /api/support/rating  (Section 9 - post-call satisfaction rating)
// { escalationId, stars, label, comment }
// ---------------------------------------------------------------------
async function submitRating(req, res) {
  try {
    const { escalationId, stars, label, comment } = req.body;
    if (!escalationId) return res.status(400).json({ error: 'escalationId is required' });
    const { userType, userId } = currentUser(req);

    const { data: escalation } = await supabase
      .from('support_escalations')
      .select('id, user_type, user_id, rated_at')
      .eq('id', escalationId)
      .maybeSingle();
    if (!escalation || escalation.user_type !== userType || escalation.user_id !== userId) {
      return res.status(404).json({ error: 'Escalation not found.' });
    }
    if (escalation.rated_at) return res.json({ ok: true, alreadyRated: true });

    const { error } = await supabase
      .from('support_escalations')
      .update({
        rating_stars: stars ?? null,
        rating_label: label || null,
        rating_comment: comment || null,
        rated_at: new Date().toISOString(),
      })
      .eq('id', escalationId);
    if (error) throw error;

    return res.json({ ok: true });
  } catch (err) {
    logger.error('[supportChat] submitRating error:', err.message);
    return res.status(500).json({ error: 'Failed to save rating.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/support-chat/analytics  (admin only, Section 8)
// ---------------------------------------------------------------------
async function getAnalytics(req, res) {
  try {
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const { data: escalations, error } = await supabase
      .from('support_escalations')
      .select('id, created_at, user_type, role_level, reason, category, rating_stars, rating_label')
      .gte('created_at', startOfMonth.toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;

    const list = escalations || [];
    const inRange = (row, from) => new Date(row.created_at) >= from;

    const byRole = {};
    const byReason = {};
    let ratedCount = 0;
    let starSum = 0;
    list.forEach((e) => {
      const roleLabel = e.user_type === 'manager' && e.role_level === 'caretaker' ? 'caretaker' : e.user_type;
      byRole[roleLabel] = (byRole[roleLabel] || 0) + 1;
      byReason[e.reason] = (byReason[e.reason] || 0) + 1;
      if (e.rating_stars) { ratedCount += 1; starSum += e.rating_stars; }
    });

    return res.json({
      dailyCount: list.filter((e) => inRange(e, startOfDay)).length,
      weeklyCount: list.filter((e) => inRange(e, startOfWeek)).length,
      monthlyCount: list.length,
      byRole,
      byReason,
      averageRating: ratedCount > 0 ? Number((starSum / ratedCount).toFixed(2)) : null,
      recent: list.slice(0, 50),
    });
  } catch (err) {
    logger.error('[supportChat] getAnalytics error:', err.message);
    return res.status(500).json({ error: 'Failed to load analytics.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/support-chat/pending-rating
// Used by the frontend on app resume (Section 9.1) to check whether
// this user has an unrated escalation from within the last hour worth
// prompting for.
// ---------------------------------------------------------------------
async function getPendingRating(req, res) {
  try {
    const { userType, userId } = currentUser(req);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('support_escalations')
      .select('id, created_at')
      .eq('user_type', userType)
      .eq('user_id', userId)
      .is('rated_at', null)
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return res.json({ escalation: data || null });
  } catch (err) {
    logger.error('[supportChat] getPendingRating error:', err.message);
    return res.json({ escalation: null });
  }
}

// ---------------------------------------------------------------------
// GET /api/support-chat/history
// Full persistent chat history for this user, across every day/session
// - NOT the "today only" window used internally as AI context. Lets
// the widget rehydrate the conversation on open/reload/re-login
// instead of starting blank every time, since support_messages rows
// are never deleted (see add-support-chat.sql).
// ---------------------------------------------------------------------
async function getHistory(req, res) {
  try {
    const { userType, userId } = currentUser(req);
    const { data: sessions, error: sessionsError } = await supabase
      .from('support_sessions')
      .select('id')
      .eq('user_type', userType)
      .eq('user_id', userId)
      .order('session_day', { ascending: true });
    if (sessionsError) throw sessionsError;

    const sessionIds = (sessions || []).map((s) => s.id);
    if (sessionIds.length === 0) return res.json({ messages: [] });

    // Capped so a very long-lived account never sends an unbounded
    // payload to the client - most recent 200 messages is plenty of
    // scrollback for a support chat.
    const { data: rows, error: messagesError } = await supabase
      .from('support_messages')
      .select('sender, content, created_at')
      .in('session_id', sessionIds)
      .order('created_at', { ascending: true })
      .limit(200);
    if (messagesError) throw messagesError;

    const messages = (rows || []).map((r) => ({
      from: r.sender,
      text: r.content,
      at: r.created_at,
    }));
    return res.json({ messages });
  } catch (err) {
    logger.error('[supportChat] getHistory error:', err.message);
    return res.status(500).json({ error: 'Failed to load chat history.' });
  }
}

module.exports = {
  sendMessage,
  selectMenuOption,
  escalateToAgent,
  submitRating,
  getAnalytics,
  getPendingRating,
  getHistory,
};
