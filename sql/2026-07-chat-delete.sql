-- =====================================================================
-- Item 5: chat "delete for me" / "delete for everyone".
--
-- Mirrors the announcements pattern (announcement_hidden +
-- delete-scope logic in announcement.controller.js) rather than
-- inventing a new shape:
--
--   'self'     - hides the message for the requesting viewer only.
--                Always allowed, for any participant, on any message.
--   'everyone' - actually deletes the message body for the whole
--                thread. Gated by role, per the rules you gave:
--                  - a RentaPay/admin-authored message can NEVER be
--                    deleted for everyone, by anyone (including admin).
--                  - a caretaker's own message can only be deleted for
--                    everyone by a manager or landlord on that same
--                    account - the caretaker who sent it cannot do
--                    this themselves (they can still delete it for
--                    themselves only).
--                  - everyone else (landlord/manager/tenant) can have
--                    their own message deleted for everyone by
--                    themselves, or by a landlord/full manager on that
--                    same account (day-to-day moderation), or by
--                    admin.
--                See chat.controller.js `deleteMessage` for the exact
--                enforcement - this migration only adds the storage.
--
-- BONUS FIX (found while wiring this up, not on the original punch
-- list): chat_messages.sender_role's check constraint only allowed
-- ('admin','landlord','tenant') - it never included 'manager'. Since
-- the item 6/7 fix added a manager branch to resolveScope/sendMessage
-- that inserts sender_role = 'manager' for a property
-- manager/caretaker texting a tenant, every one of those sends would
-- have failed the DB check constraint outright. Widening the
-- constraint here and adding sender_role_level so a caretaker's
-- messages can be told apart from a full manager's (needed for the
-- "caretaker's own message" rule above).
-- =====================================================================

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_sender_role_check') then
    alter table chat_messages drop constraint chat_messages_sender_role_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_sender_role_check
  check (sender_role in ('admin', 'landlord', 'manager', 'tenant'));

alter table chat_messages add column if not exists sender_role_level text
  check (sender_role_level in ('manager', 'caretaker'));

-- Delete-for-everyone: soft delete. We keep the row (so reply_to
-- quoting of a deleted message can still render "This message was
-- deleted" instead of a dangling reference) but blank the body and
-- flag it.
alter table chat_messages add column if not exists deleted_for_everyone boolean not null default false;
alter table chat_messages add column if not exists deleted_at timestamptz;
alter table chat_messages add column if not exists deleted_by_role text
  check (deleted_by_role in ('admin', 'landlord', 'manager', 'tenant'));

-- Delete-for-me: same shape as announcement_hidden.
create table if not exists chat_message_hidden (
  message_id uuid not null references chat_messages(id) on delete cascade,
  viewer_role text not null check (viewer_role in ('admin', 'landlord', 'manager', 'tenant')),
  viewer_id uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (message_id, viewer_role, viewer_id)
);

create index if not exists idx_chat_message_hidden_viewer on chat_message_hidden(viewer_role, viewer_id);
