// src/services/supportChat.service.js
//
// AI Support Chat feature - see rentapay_ai_support_chat_spec.pdf.
// Implements the full fallback chain (Section 2): rule-based matcher
// (own backend code, no AI) -> Gemini -> Groq -> Cerebras ->
// OpenRouter -> category menu -> "Talk to an agent" call handoff.
//
// Everything here is $0-cost: the rule-based tier is plain keyword
// matching against support_topics, and the four AI tiers are all
// free-tier provider APIs read from environment variables (Section 11).

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const CALL_HANDOFF_TEL = 'tel:+254710888917';

// ---------------------------------------------------------------------
// Session + history (Section 5 - conversation continuity)
// ---------------------------------------------------------------------

// One row per user per calendar day - history sent to every tier is
// scoped to "today", never the user's entire support history.
async function getOrCreateSession(userType, userId, roleLevel) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from('support_sessions')
    .select('*')
    .eq('user_type', userType)
    .eq('user_id', userId)
    .eq('session_day', today)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('support_sessions')
    .insert({ user_type: userType, user_id: userId, role_level: roleLevel || null, session_day: today })
    .select('*')
    .single();
  if (error) throw error;
  return created;
}

async function appendMessage(sessionId, sender, content, answeredBy, category) {
  await supabase.from('support_messages').insert({
    session_id: sessionId,
    sender,
    content,
    answered_by: answeredBy || null,
    category: category || null,
  });
}

// Section 5's truncation rule: full history if short, otherwise the
// most recent 8 messages - keeps token usage sane on every retry
// through the fallback chain without losing the thread.
async function getTodayHistory(sessionId, limit = 8) {
  const { data } = await supabase
    .from('support_messages')
    .select('sender, content, category, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  const all = data || [];
  return all.length > limit ? all.slice(-limit) : all;
}

// ---------------------------------------------------------------------
// Tier 1: rule-based/keyword matcher - own backend code, no AI call,
// attempted first so known questions never touch the free-tier quota.
// ---------------------------------------------------------------------

async function ruleBasedMatch(message, role) {
  const { data: topics } = await supabase
    .from('support_topics')
    .select('*')
    .contains('applicable_roles', [role]);
  if (!topics || topics.length === 0) return null;

  const needle = message.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const topic of topics) {
    const score = (topic.keywords || []).filter((kw) => needle.includes(kw.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }
  if (!best || bestScore === 0) return null;
  return { text: best.response, category: best.category, escalateToHuman: !!best.escalate_to_human };
}

// ---------------------------------------------------------------------
// Tier 0: casual/conversational input - greetings, emojis, single
// affectionate/short words ("Hey", "Love", "😊"). Handled locally, with
// zero dependency on any AI provider or the DB-backed rule matcher, so
// a simple "Good morning" always gets a warm, natural reply even if
// every AI provider key is unset/down - it should never be possible
// for a greeting to fall through to the category-menu dead end.
// ---------------------------------------------------------------------

const EMOJI_RE = /^[\s\p{Extended_Pictographic}\u200d\uFE0F]+$/u;
const GREETING_RE = /^(hi+|hello+|hey+|yo+|sup|good\s?(morning|afternoon|evening|day)|howdy|greetings)[\s!.,]*$/i;
const CASUAL_WORD_RE = /^(love|nice|cool|great|thanks|thank you|thanks a lot|ok|okay|k|lol|haha+|😊|❤️?|👍|😂)[\s!.,]*$/i;

const GREETING_REPLIES = [
  "Hey there! What can I help you with today?",
  "Hello! What's going on - how can I help?",
  "Hi! What can I do for you today?",
];

function detectCasualMessage(message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) return false;
  if (EMOJI_RE.test(trimmed)) return true;
  if (GREETING_RE.test(trimmed)) return true;
  if (trimmed.length <= 20 && CASUAL_WORD_RE.test(trimmed)) return true;
  return false;
}

function casualReply() {
  return GREETING_REPLIES[Math.floor(Math.random() * GREETING_REPLIES.length)];
}

// ---------------------------------------------------------------------
// Section 7.3: always-escalate topics - require checking THIS user's
// real account state, which no AI provider can do. Checked before the
// rule-based matcher and before any AI call is attempted.
// ---------------------------------------------------------------------

const ALWAYS_ESCALATE_PATTERNS = [
  { reason: 'payment_not_reflected', re: /(paid|payment).{0,30}(not|isn'?t|hasn'?t).{0,15}(reflect|show|activat)/i },
  { reason: 'payment_not_reflected', re: /(account|subscription).{0,15}(not|isn'?t).{0,10}activat/i },
  { reason: 'login_issue', re: /(can'?t|cannot|unable to).{0,10}log ?in/i },
  { reason: 'balance_wrong', re: /(balance|amount).{0,15}(wrong|incorrect|not right)/i },
  { reason: 'charge_dispute', re: /(charged|billed).{0,15}(twice|double)/i },
  { reason: 'charge_dispute', re: /(dispute|wrong).{0,10}(charge|amount)/i },
];

function detectAlwaysEscalateTopic(message) {
  const hit = ALWAYS_ESCALATE_PATTERNS.find((p) => p.re.test(message));
  return hit ? hit.reason : null;
}

// Section 7.1 - explicit escalation intent, checked on every incoming
// message before any tier is attempted.
const EXPLICIT_ESCALATION_RE = /(talk to (a |an )?(human|agent|person)|call (someone|support)|speak to (a |an )?(human|agent)|need help now|connect me to support|real (person|human))/i;

function detectExplicitEscalationIntent(message) {
  return EXPLICIT_ESCALATION_RE.test(message);
}

// Section 7.2 - explicit frustration language, same immediate-escalate
// treatment as 7.1.
const FRUSTRATION_RE = /(isn'?t helping|not understanding|useless|this is (pointless|frustrating)|not (helping|working)|you don'?t get it)/i;

function detectFrustration(message) {
  return FRUSTRATION_RE.test(message);
}

// Section 7.2 repetition pattern - same category matched 2-3 times in
// a row in the last few user turns.
function detectRepetition(history, currentCategory) {
  if (!currentCategory) return false;
  const recentUserCategories = history
    .filter((m) => m.sender === 'user' && m.category)
    .slice(-2)
    .map((m) => m.category);
  return recentUserCategories.length >= 2 && recentUserCategories.every((c) => c === currentCategory);
}

// ---------------------------------------------------------------------
// Section 10.3 - role-scoping instruction sent with every AI call.
// ---------------------------------------------------------------------

function roleSystemPrompt(role, roleLevel) {
  const label = role === 'manager' && roleLevel === 'caretaker' ? 'Caretaker' : role.charAt(0).toUpperCase() + role.slice(1);
  return (
    `You are RentaPay's in-app support assistant for a Kenyan property-management app. ` +
    `This user is a ${label} on RentaPay. Only answer questions relevant to what a ${label} can see or do in the app. ` +
    `If the question involves an action or feature outside this role's access (for example, a Caretaker asking how to ` +
    `confirm or reject a payment, which Caretakers cannot do, or asking about subscription billing details reserved for ` +
    `the Landlord), do not explain how to perform that action - instead, politely state that this is outside their ` +
    `account type's access and suggest they contact the Landlord or use the "Talk to an agent" option. ` +
    `Keep answers short, plain, and specific to RentaPay. If you don't know something specific to this user's account ` +
    `(balances, payment status, specific records), say so and suggest "Talk to an agent" rather than guessing.\n\n` +
    // ---------------------------------------------------------------
    // Ground-truth facts, read directly from the backend's actual
    // behavior (not written from memory of what the feature "should"
    // do). Fixed after the assistant was caught confidently inventing
    // wrong behavior for a question outside this list (archiving a
    // tenant) instead of admitting it wasn't sure. This list won't
    // cover every feature - the hard rule below is what matters most.
    // ---------------------------------------------------------------
    `Known facts about how RentaPay actually behaves - answer from these exactly, word for word in meaning, do not ` +
    `paraphrase them into something slightly different:\n` +
    `- ARCHIVING A TENANT ends their tenancy - it is not a reversible "hide" action by itself, though it CAN be undone ` +
    `afterward. It sets the tenant's account to inactive, records a left-at date, and immediately emails that tenant ` +
    `saying their RentaPay tenancy has ended. An archived tenant CANNOT log in afterward - they get an error trying to ` +
    `sign in, not a normal "inactive account" message. Their records (payments, past communications) stay visible to ` +
    `the landlord/manager. A landlord or manager CAN restore an archived tenant later, which reactivates their login.\n` +
    `- SUBSCRIPTION EXPIRY: when an apartment's/property's subscription expires, that specific apartment's features are ` +
    `locked (a "renew to continue" message shows for feature access), but the landlord can still navigate the app and ` +
    `it does NOT affect their other apartments if they have more than one - each apartment's subscription is separate.\n` +
    `- MANUAL SUBSCRIPTION PAYMENTS (Paybill/Till submitted outside the app) start as "pending" and require an admin to ` +
    `review and confirm them before the subscription activates - it is not automatic/instant.\n` +
    `- PENDING PAYMENT CONFIRMATIONS (a tenant's manually-submitted rent proof) also start as "pending" and must be ` +
    `confirmed or rejected by the landlord/manager - confirming updates the tenant's balance and payment history ` +
    `immediately; rejecting does not.\n` +
    `- DISPUTED CHARGES: once a dispute is marked "resolved" by the landlord/manager, it cannot be reopened or resolved ` +
    `again - a new dispute would need to be raised separately.\n` +
    `- VACATING NOTICE reminders are sent automatically in the days counting down to the tenant's stated notice date, ` +
    `not just once.\n\n` +
    `HARD RULE: if a question is about how a specific RentaPay feature behaves and the exact behavior is not stated ` +
    `above, do NOT invent, infer, or guess an answer from the feature's name alone. Say you're not certain about the ` +
    `exact behavior and suggest "Talk to an agent" or contacting RentaPay support to confirm. A wrong confident answer ` +
    `is worse than an honest "I'm not sure."\n\n` +
    `HARD RULE: never reply with a bare refusal like "I cannot help with that" or "I don't have that information" and ` +
    `stop there. Every reply must do at least one of: answer the question, ask one clarifying question, or explicitly ` +
    `offer to escalate to a human agent / log it as a support ticket. If something sounds like a genuine bug report ` +
    `(the user describing something on the platform behaving wrong), acknowledge it specifically, say whether it's ` +
    `expected behavior or not (using the facts above if it's covered), and offer to escalate it if you're not sure - ` +
    `never dismiss it or ignore what they described.`
  );
}

function toProviderMessages(systemPrompt, history, latestMessage) {
  const turns = history.map((m) => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.content }));
  turns.push({ role: 'user', content: latestMessage });
  return { system: systemPrompt, turns };
}

// ---------------------------------------------------------------------
// AI provider adapters - one small function per provider, each either
// resolves with a reply string or throws (caught by getAIResponse to
// fall through to the next tier).
// ---------------------------------------------------------------------

async function callGemini(systemPrompt, turns) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const contents = turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] }));
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemPrompt }] } }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini: empty response');
  return text;
}

async function callGroq(systemPrompt, turns) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: systemPrompt }, ...turns],
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Groq: empty response');
  return text;
}

async function callCerebras(systemPrompt, turns) {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error('CEREBRAS_API_KEY not set');
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama3.1-8b',
      messages: [{ role: 'system', content: systemPrompt }, ...turns],
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`Cerebras ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Cerebras: empty response');
  return text;
}

async function callOpenRouter(systemPrompt, turns) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://rentapay.app',
      'X-Title': 'RentaPay Support Chat',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'system', content: systemPrompt }, ...turns],
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenRouter: empty response');
  return text;
}

// Tries each provider in the exact spec order, catching failures/rate
// limits and moving to the next. Returns { text, tier } or null if
// every provider failed (falls through to the category menu).
async function getAIResponse(systemPrompt, turns) {
  const providers = [
    ['gemini', callGemini],
    ['groq', callGroq],
    ['cerebras', callCerebras],
    ['openrouter', callOpenRouter],
  ];
  for (const [tier, fn] of providers) {
    try {
      const text = await fn(systemPrompt, turns);
      return { text, tier };
    } catch (err) {
      logger.error(`[supportChat] ${tier} failed, falling through:`, err.message);
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Section 3 - role-scoped category menu, shown once every automated
// tier has failed to produce a confident answer.
// ---------------------------------------------------------------------

function buildCategoryMenu(role, roleLevel, alreadyCoveredCategory) {
  const isCaretaker = role === 'manager' && roleLevel === 'caretaker';
  const all = [
    { key: 'payment', label: 'Payment issue', roles: ['tenant', 'landlord', 'manager'] },
    { key: 'tenant_unit', label: 'Tenant or unit issue', roles: ['landlord', 'manager', 'caretaker'] },
    { key: 'account_subscription', label: 'Account & subscription', roles: ['tenant', 'landlord', 'manager', 'caretaker'] },
    { key: 'maintenance', label: 'Maintenance request', roles: ['tenant', 'landlord', 'manager', 'caretaker'] },
    { key: 'other', label: 'Something else', roles: ['tenant', 'landlord', 'manager', 'caretaker'] },
  ];
  const effectiveRole = isCaretaker ? 'caretaker' : role;
  let options = all
    .filter((o) => o.roles.includes(effectiveRole))
    // Caretakers can't confirm/dispute payments - only Manage Subscription
    // access was explicitly retained for them (per the Sidebar/Roles spec).
    .filter((o) => !(isCaretaker && o.key === 'payment'));

  // Skip straight to sub-options already implied by the conversation
  // instead of re-showing a top-level category already covered.
  if (alreadyCoveredCategory) {
    options = options.filter((o) => o.key !== alreadyCoveredCategory);
  }

  return [...options.map((o) => ({ key: o.key, label: o.label })), { key: 'agent', label: 'Talk to an agent' }];
}

// ---------------------------------------------------------------------
// Section 8 - escalation logging
// ---------------------------------------------------------------------

async function logEscalation({ sessionId, userType, userId, roleLevel, reason, category }) {
  const { data, error } = await supabase
    .from('support_escalations')
    .insert({ session_id: sessionId, user_type: userType, user_id: userId, role_level: roleLevel || null, reason, category: category || null })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  CALL_HANDOFF_TEL,
  getOrCreateSession,
  appendMessage,
  getTodayHistory,
  detectCasualMessage,
  casualReply,
  ruleBasedMatch,
  detectAlwaysEscalateTopic,
  detectExplicitEscalationIntent,
  detectFrustration,
  detectRepetition,
  roleSystemPrompt,
  toProviderMessages,
  getAIResponse,
  buildCategoryMenu,
  logEscalation,
};
