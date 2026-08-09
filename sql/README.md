# sql/ folder

This folder has grown to 80+ individual migration files. That's the
root cause behind at least one real bug already (see
`2026-07-onboarding-loop-and-archive-reuse-fix.sql`'s header): a
column that only existed in one non-reapplicable file, so a database
that hadn't run that *exact* file in that *exact* order was silently
missing it, with no error until the bug surfaced in production.

## For a NEW / empty database

1. Run `schema.sql` (creates the base tables).
2. Run `CONSOLIDATED-2026-07-31.sql` (brings it up to date with every
   migration since).

## For an EXISTING database you're not sure is current

1. Run `_check-what-is-applied.sql` first (read-only) to see what's
   already there.
2. Run `CONSOLIDATED-2026-07-31.sql`. It's a straight, in-order
   concatenation of every individual migration file (full list and
   important caveats are in that file's own header) - safe to run even
   if some of it is already applied, since the individual files
   already follow an `if not exists` / idempotent-update convention.
   Test against a staging copy first if you can.

## Why not just replace all 80+ files with one clean schema.sql?

That's the right eventual goal, but it needs to be done by hand, with
a real database to diff against - a few of these migrations alter or
narrow earlier ones (e.g. `add-scout-role.sql` then later
`2026-07-remove-scout-role.sql`), and collapsing that history
correctly means confirming the *end state* column-by-column, not just
concatenating and hoping. `CONSOLIDATED-2026-07-31.sql` is the safe,
mechanical version of that (same end state, zero manual schema
review); a genuinely clean `schema.sql` rewrite is worth doing
separately, once, against a real staging database, and is intentionally
NOT part of this change.

## Going forward

Every new migration should still be its own dated file (that part of
the convention is fine and worth keeping - it's what makes
`git blame`/PR review on schema changes possible at all). The
suggestion is just to periodically (e.g. every few months, or whenever
`CONSOLIDATED-*.sql` gets unwieldy again) regenerate a fresh
`CONSOLIDATED-<date>.sql` the same way this one was built, rather than
letting a fresh database's setup instructions be "run these 80
files, in this exact order, don't get it wrong."
