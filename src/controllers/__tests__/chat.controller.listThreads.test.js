// src/controllers/__tests__/chat.controller.listThreads.test.js
//
// Covers the landlord branch of listThreads after the N+1 fix
// (attachChatThreadSummaries) - makes sure last message + unread
// count still land on the RIGHT thread when resolved via one batched
// query instead of one pair of queries per thread.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/webpush.service', () => ({ sendPushToRecipient: jest.fn() }));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));
jest.mock('../../middleware/auth.middleware', () => ({
  effectiveLandlordId: jest.fn((req) => req.user?.id),
  getManagerAssignedPropertyIds: jest.fn().mockResolvedValue([]),
  checkManagerPropertyAccess: jest.fn().mockResolvedValue(null),
}));

const supabase = require('../../config/supabase');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { listThreads } = require('../chat.controller');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

test("landlord's thread list: each thread gets ITS OWN last message and unread count, not a mixed-up one", async () => {
  const builders = setupSupabaseMock(supabase, {
    tenants: {
      data: [
        { id: 'T1', full_name: 'Alice', primary_phone: '2547...1', is_active: true },
        { id: 'T2', full_name: 'Bob', primary_phone: '2547...2', is_active: true },
      ],
      error: null,
    },
    chat_messages: {
      data: [
        // Newest first (as the real ordered query would return).
        { thread_type: 'landlord_tenant', tenant_id: 'T2', body: 'Bob newest', created_at: '2026-08-05T00:00:00Z', read_by_landlord: false },
        { thread_type: 'admin_landlord', tenant_id: null, body: 'Support newest', created_at: '2026-08-04T00:00:00Z', read_by_landlord: true },
        { thread_type: 'landlord_tenant', tenant_id: 'T1', body: 'Alice newest', created_at: '2026-08-03T00:00:00Z', read_by_landlord: false },
        { thread_type: 'landlord_tenant', tenant_id: 'T1', body: 'Alice older (should be shadowed)', created_at: '2026-08-01T00:00:00Z', read_by_landlord: false },
        { thread_type: 'landlord_tenant', tenant_id: 'T2', body: 'Bob older', created_at: '2026-07-30T00:00:00Z', read_by_landlord: true },
      ],
      error: null,
    },
  });

  const req = { user: { role: 'landlord', id: 'L1' } };
  const res = mockRes();
  await listThreads(req, res);

  expect(res.status).not.toHaveBeenCalledWith(500);
  const { threads } = res.json.mock.calls[0][0];

  const alice = threads.find((t) => t.tenantId === 'T1');
  const bob = threads.find((t) => t.tenantId === 'T2');
  const support = threads.find((t) => t.threadType === 'admin_landlord');

  expect(alice.lastMessage).toBe('Alice newest');
  expect(alice.unreadCount).toBe(2); // both Alice rows are unread

  expect(bob.lastMessage).toBe('Bob newest');
  expect(bob.unreadCount).toBe(1); // only the newer Bob row is unread

  expect(support.lastMessage).toBe('Support newest');
  expect(support.unreadCount).toBe(0);
});
