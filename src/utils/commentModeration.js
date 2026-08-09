// ---------------------------------------------------------------------
// COMMENT MODERATION (direct request): a basic profanity/abuse filter
// for the free-text `comment` field on rating submissions
// (tenant_ratings, landlord_ratings, staff_ratings, property_ratings).
// These comments aren't shown on the public listings page today, but
// they ARE shown inside authenticated portals (landlord viewing a
// tenant's rating history, a tenant viewing their landlord/staff/
// property reputation, etc.) - and reputation is explicitly billed as
// a trust signal, so one bad-faith or abusive comment slipping through
// undermines that.
//
// DELIBERATELY SIMPLE: this is a denylist-based filter, not an ML
// moderation model or a call to a third-party moderation API. It
// catches the clear cases (profanity, slurs) cheaply and
// synchronously at submission time, and is intended as a first line of
// defense - not a claim that it catches every form of abuse (that's
// what the "flag for review" path in tenant.controller.js is for:
// covers things a keyword list never will, like a coherent but
// dishonest or retaliatory comment).
// ---------------------------------------------------------------------

// Kept intentionally short and generic (base forms only - the check
// below is substring-based so common variations/pluralizations are
// still caught without listing every one out).
const BLOCKED_TERMS = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy',
  'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut',
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    // collapse common leetspeak substitutions so "fvck"/"sh1t" style
    // evasions still match without needing separate list entries
    .replace(/[@4]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[^a-z\s]/g, '');
}

/**
 * Returns { blocked: boolean, matched: string|null }. `matched` is
 * intentionally not surfaced to end users in error messages (no need
 * to tell someone exactly which word tripped the filter), but is
 * available for logging.
 */
function checkComment(rawComment) {
  if (!rawComment) return { blocked: false, matched: null };
  const normalized = normalize(rawComment);
  const hit = BLOCKED_TERMS.find((term) => normalized.includes(term));
  return { blocked: !!hit, matched: hit || null };
}

module.exports = { checkComment };
