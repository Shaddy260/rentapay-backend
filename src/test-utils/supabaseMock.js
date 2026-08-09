// src/test-utils/supabaseMock.js
//
// A minimal stand-in for the supabase-js query builder, for unit tests
// that need `supabase.from(table)...` to resolve to a controlled
// { data, error } result without hitting a real database.
//
// Every chain method (select/insert/update/.../eq/ilike/...) returns
// the same builder object so any call shape the real code uses will
// chain correctly. The builder itself is "thenable" (has a `.then`),
// so both `await query` (no terminal call) and `await query.single()`
// / `await query.maybeSingle()` resolve to the same configured result -
// good enough for unit tests, since we're not testing supabase-js
// itself, just how our own code reacts to what it returns.
//
// Usage:
//   const { supabase, builders } = createSupabaseMock({
//     landlords: { data: { id: 'L1', ... }, error: null },
//     platform_settings: { data: { is_locked_down: false }, error: null },
//   });
//   jest.mock('../../config/supabase', () => require('../../test-utils/supabaseMock').sharedMockClient);
//
// Because jest.mock factories can't close over per-test variables
// easily, the recommended pattern (see the test files) is instead:
//   jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
//   const supabase = require('../../config/supabase');
//   const { builders } = setupSupabaseMock(supabase, { ...tableResults });

function makeBuilder(initialResult) {
  const result = initialResult ?? { data: null, error: null };
  // Two independent results: `__result` backs .single()/.maybeSingle()
  // calls (typically a row-fetch), and `__thenResult` backs awaiting
  // the builder directly with no terminal call (typically a plain
  // .update()/.eq() write, or a multi-row .select() with no single()).
  // They default to the same value, but real code frequently issues a
  // fetch via .maybeSingle() and later a write via a bare await
  // against the SAME table - without this split, configuring the
  // write's result would silently corrupt the earlier fetch's result
  // too, since both would otherwise share one field.
  const builder = { __result: result, __thenResult: result };
  const chainMethods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is',
    'order', 'limit', 'range', 'contains',
  ];
  chainMethods.forEach((method) => {
    builder[method] = jest.fn(() => builder);
  });
  builder.maybeSingle = jest.fn(() => Promise.resolve(builder.__result));
  builder.single = jest.fn(() => Promise.resolve(builder.__result));
  // Allows `await supabase.from(x).update(y).eq('id', z)` with no
  // terminal call at all, same as the real query builder (it's a
  // PromiseLike itself).
  builder.then = (onResolve, onReject) => Promise.resolve(builder.__thenResult).then(onResolve, onReject);
  builder.catch = (onReject) => Promise.resolve(builder.__thenResult).catch(onReject);
  // Lets a test change what a given table returns partway through
  // (e.g. "first call: not found, second call: found") if needed.
  // Sets BOTH results unless a test opts into __setThenResult
  // separately, so simple single-purpose tests don't need to know
  // about the split at all.
  builder.__setResult = (r) => { builder.__result = r; builder.__thenResult = r; };
  builder.__setThenResult = (r) => { builder.__thenResult = r; };
  return builder;
}

/**
 * Wires a jest.fn()-based `supabase.from` mock so that querying a given
 * table resolves to a fixed { data, error } result, memoizing one
 * builder per table so assertions on e.g. `.update` calls are easy to
 * reach from the test.
 *
 * @param {{ from: jest.Mock }} supabase - the mocked supabase client
 * @param {Record<string, {data: any, error: any}>} tableResults
 * @returns {Record<string, ReturnType<typeof makeBuilder>>} builders keyed by table name
 */
function setupSupabaseMock(supabase, tableResults = {}) {
  const builders = {};
  // BUG FIX: builders used to be created lazily, only once
  // `supabase.from(table)` was actually invoked by the code under
  // test. That breaks any test that needs to configure a builder
  // (e.g. via __setThenResult) BEFORE calling the function under
  // test - `builders.payments` would still be undefined at that
  // point even though 'payments' was passed into tableResults, since
  // nothing had queried it yet. Eagerly creating a builder for every
  // table named in tableResults means callers can always reach
  // `builders.<table>` right after this call returns, regardless of
  // call order.
  Object.keys(tableResults).forEach((table) => {
    builders[table] = makeBuilder(tableResults[table]);
  });
  supabase.from.mockImplementation((table) => {
    if (!builders[table]) {
      builders[table] = makeBuilder({ data: null, error: null });
    }
    return builders[table];
  });
  return builders;
}

module.exports = { makeBuilder, setupSupabaseMock };
