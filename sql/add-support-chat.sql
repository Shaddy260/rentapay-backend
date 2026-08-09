-- AI Support Chat feature (full spec: rule-based -> Gemini -> Groq ->
-- Cerebras -> OpenRouter -> category menu -> "Talk to an agent" call
-- handoff). See rentapay_ai_support_chat_spec.pdf.

create extension if not exists pgcrypto;

-- Tier 1: rule-based/keyword matcher, checked before any AI call so
-- known/common questions never touch the free-tier AI quota.
create table if not exists support_topics (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('payment', 'tenant_unit', 'account_subscription', 'maintenance', 'other')),
  keywords text[] not null,
  response text not null,
  -- Section 10.2: only topics tagged for the requesting user's role
  -- are ever matched against.
  applicable_roles text[] not null default array['tenant', 'landlord', 'manager', 'caretaker'],
  -- Section 7.3: topics that must always go straight to a human (e.g.
  -- "how do I report a bug") rather than attempt a canned/AI answer.
  escalate_to_human boolean not null default false,
  created_at timestamptz not null default now()
);

-- One row per calendar day per user - conversation history is scoped
-- to "today" per Section 5, never the user's entire support history.
create table if not exists support_sessions (
  id uuid primary key default gen_random_uuid(),
  user_type text not null check (user_type in ('tenant', 'landlord', 'manager', 'admin')),
  user_id text not null,
  role_level text, -- 'caretaker' when user_type='manager' and this account is a caretaker
  session_day date not null default current_date,
  created_at timestamptz not null default now(),
  unique (user_type, user_id, session_day)
);

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references support_sessions(id) on delete cascade,
  sender text not null check (sender in ('user', 'assistant')),
  content text not null,
  -- Section 6 logging: which tier actually produced this reply.
  answered_by text check (answered_by in ('rule_based', 'gemini', 'groq', 'cerebras', 'openrouter', 'menu', 'system')),
  category text,
  created_at timestamptz not null default now()
);
create index if not exists idx_support_messages_session on support_messages(session_id, created_at);

-- Section 8/9: every "Talk to an agent" handoff, plus the post-call
-- satisfaction rating tied to the same record.
create table if not exists support_escalations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references support_sessions(id) on delete set null,
  user_type text not null check (user_type in ('tenant', 'landlord', 'manager', 'admin')),
  user_id text not null,
  role_level text,
  reason text not null, -- 'user_requested' | 'dissatisfaction' | 'repetition' | 'always_escalate_topic' | 'menu_exhausted'
  category text,
  created_at timestamptz not null default now(),
  rating_stars smallint check (rating_stars between 1 and 5),
  rating_label text check (rating_label in ('great', 'ok', 'not_resolved')),
  rating_comment text,
  rated_at timestamptz,
  -- Section 9.2: backup push reminder, cancelled once rated via 9.1.
  reminder_push_sent_at timestamptz
);
create index if not exists idx_support_escalations_created on support_escalations(created_at);
create index if not exists idx_support_escalations_pending_reminder on support_escalations(created_at) where rated_at is null and reminder_push_sent_at is null;

-- Starter set of common topics so the rule-based tier has real coverage
-- from day one. Landlord/manager/caretaker share most of these;
-- caretaker-inapplicable ones (payment confirmation, subscription
-- billing) are scoped accordingly per the Sidebar/Roles spec.
insert into support_topics (category, keywords, response, applicable_roles, escalate_to_human) values
  ('payment', array['mpesa','m-pesa','stk','paybill','pay rent','how do i pay'], 'You can pay rent via M-Pesa STK push right from your unit''s Payments tab - enter the amount and tap "Pay now", then approve the prompt on your phone.', array['tenant'], false),
  ('payment', array['confirm payment','pending payment','approve payment'], 'Pending manual payments show under Payments > Pending confirmations. Open the entry and tap Confirm once you''ve verified it against your M-Pesa statement.', array['landlord','manager'], false),
  ('tenant_unit', array['add tenant','new tenant','onboard tenant'], 'Add a tenant from a unit''s detail page - tap "Add tenant", fill in their details, and they''ll get first-time login credentials automatically.', array['landlord','manager'], false),
  ('tenant_unit', array['add unit','new unit','create unit'], 'Add a unit from the Dashboard by tapping "Add unit" and filling in the unit name, type, and rent amount.', array['landlord','manager'], false),
  ('account_subscription', array['reset password','forgot password','change password'], 'Use "Forgot password" on the login screen, or Settings > Change password if you''re already logged in.', array['tenant','landlord','manager','caretaker'], false),
  ('account_subscription', array['renew subscription','manage subscription','subscription expired'], 'You can renew or manage your subscription from Settings > Manage subscription.', array['landlord','manager','caretaker'], false),
  ('maintenance', array['maintenance request','report issue','fix something','broken'], 'Report a maintenance issue from the Maintenance tab - describe the problem and it''ll be visible to your landlord/caretaker right away.', array['tenant'], false),
  ('other', array['bug','report a bug','app is broken','crashing'], 'Thanks for flagging this - bug reports go straight to a human so we can look into it properly.', array['tenant','landlord','manager','caretaker'], true)
on conflict do nothing;
