// src/services/baRewards.service.js
//
// Premium Redesign Plan - Phase 8: Admin BA Performance & Rewards
// Dashboard.
//
// Two responsibilities:
//   1. getLeaderboard() - per-BA stats ranked by NET REVENUE
//      CONTRIBUTION (total paid by that BA's onboarded landlords minus
//      commission already paid to the BA), not by landlord count.
//   2. rewardBAs() - admin sets a time-bound custom commission rate
//      for one or several BAs at once, which auto-reverts (see
//      baCommission.service.js's resolveApplicableRate) once the
//      period elapses. Notifies the rewarded BAs, broadcasts a
//      motivational nudge to everyone else, and returns enough to
//      build the "what happens next" summary + the downloadable PDF.

const supabase = require('../config/supabase');
const { notify } = require('./notify.service');
const { resolveApplicableRate } = require('./baCommission.service');
const { logActivity } = require('./activityLog.service');
const { captureException } = require('./sentry.service');
const logger = require('../utils/logger');

const ADMIN_ACTOR_ID = 'super-admin';

async function currentGlobalPercentage() {
  const { data, error } = await supabase
    .from('payout_rules')
    .select('percentage, effective_from')
    .eq('scope', 'global')
    .lte('effective_from', new Date().toISOString())
    .order('effective_from', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length ? Number(data[0].percentage) : 0;
}

/**
 * Full leaderboard: every active/suspended BA, ranked by net revenue
 * contribution (descending), with BAs who have never been rewarded
 * surfaced ahead of BAs who have - "so recognition spreads across
 * performers rather than repeatedly favoring the same names."
 */
async function getLeaderboard() {
  const [{ data: bas, error: baErr }, defaultPercentage] = await Promise.all([
    supabase
      .from('brand_ambassadors')
      .select('id, ba_code, full_name, phone, email, status')
      .in('status', ['active', 'suspended']),
    currentGlobalPercentage(),
  ]);
  if (baErr) throw baErr;
  if (!bas || bas.length === 0) return [];

  const baIds = bas.map((b) => b.id);

  const [{ data: landlords, error: landlordErr }, { data: earnings, error: earningsErr }, { data: rewards, error: rewardsErr }] = await Promise.all([
    supabase.from('landlords').select('id, ba_id, subscription_status').in('ba_id', baIds),
    supabase.from('ba_commission_earnings').select('ba_id, payment_amount, commission_amount').in('ba_id', baIds),
    supabase.from('ba_rewards').select('ba_id, created_at').in('ba_id', baIds),
  ]);
  if (landlordErr) throw landlordErr;
  if (earningsErr) throw earningsErr;
  if (rewardsErr) throw rewardsErr;

  const landlordIds = (landlords || []).map((l) => l.id);
  let payments = [];
  if (landlordIds.length > 0) {
    const { data, error } = await supabase
      .from('subscription_payments')
      .select('landlord_id, amount, status')
      .in('landlord_id', landlordIds)
      .eq('status', 'completed');
    if (error) throw error;
    payments = data || [];
  }

  const landlordToBa = new Map((landlords || []).map((l) => [l.id, l.ba_id]));

  const totalPaidByBa = new Map();
  for (const p of payments) {
    const baId = landlordToBa.get(p.landlord_id);
    if (!baId) continue;
    totalPaidByBa.set(baId, (totalPaidByBa.get(baId) || 0) + Number(p.amount || 0));
  }

  const commissionPaidByBa = new Map();
  for (const e of earnings || []) {
    commissionPaidByBa.set(e.ba_id, (commissionPaidByBa.get(e.ba_id) || 0) + Number(e.commission_amount || 0));
  }

  const allTimeCountByBa = new Map();
  const activeCountByBa = new Map();
  for (const l of landlords || []) {
    if (!l.ba_id) continue;
    allTimeCountByBa.set(l.ba_id, (allTimeCountByBa.get(l.ba_id) || 0) + 1);
    if (l.subscription_status === 'active') {
      activeCountByBa.set(l.ba_id, (activeCountByBa.get(l.ba_id) || 0) + 1);
    }
  }

  const rewardCountByBa = new Map();
  const lastRewardedAtByBa = new Map();
  for (const r of rewards || []) {
    rewardCountByBa.set(r.ba_id, (rewardCountByBa.get(r.ba_id) || 0) + 1);
    const prev = lastRewardedAtByBa.get(r.ba_id);
    if (!prev || new Date(r.created_at) > new Date(prev)) lastRewardedAtByBa.set(r.ba_id, r.created_at);
  }

  const now = new Date();
  const rows = await Promise.all(
    bas.map(async (b) => {
      const totalPaid = totalPaidByBa.get(b.id) || 0;
      const commissionPaid = commissionPaidByBa.get(b.id) || 0;
      const netContribution = totalPaid - commissionPaid;
      const rewardCount = rewardCountByBa.get(b.id) || 0;

      const rate = await resolveApplicableRate(b.id, now);
      const commissionRate = rate ? rate.percentage : defaultPercentage;

      return {
        baId: b.id,
        baCode: b.ba_code,
        name: b.full_name,
        phone: b.phone,
        email: b.email,
        status: b.status,
        landlordsOnboardedAllTime: allTimeCountByBa.get(b.id) || 0,
        landlordsOnboardedActive: activeCountByBa.get(b.id) || 0,
        commissionRate,
        totalPaidByLandlords: totalPaid,
        commissionPaidToDate: commissionPaid,
        netContribution,
        rewardCount,
        neverRewarded: rewardCount === 0,
        lastRewardedAt: lastRewardedAtByBa.get(b.id) || null,
      };
    })
  );

  // "Prioritize BAs who have not yet been rewarded, surfacing them
  // ahead of those who've already received a custom-commission
  // reward" - primary sort key is neverRewarded, then net
  // contribution descending within each group.
  rows.sort((a, b) => {
    if (a.neverRewarded !== b.neverRewarded) return a.neverRewarded ? -1 : 1;
    return b.netContribution - a.netContribution;
  });

  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  return rows;
}

/**
 * Rewards one or several BAs at once with the same custom commission
 * rate and time-bound period. Each BA gets its own payout_rules
 * ba_override row (effective_from = startAt, effective_until = endAt)
 * so it auto-reverts, and its own ba_rewards row so its reward
 * counter/history is independently tracked - all grouped under one
 * ba_reward_batches row for the PDF export.
 */
async function rewardBAs({ baIds, newPercentage, startAt, endAt, adminId = ADMIN_ACTOR_ID }) {
  if (!Array.isArray(baIds) || baIds.length === 0) {
    throw Object.assign(new Error('Select at least one Brand Ambassador to reward.'), { status: 400 });
  }
  const percentage = Number(newPercentage);
  if (Number.isNaN(percentage) || percentage < 0 || percentage > 100) {
    throw Object.assign(new Error('A valid commission percentage between 0 and 100 is required.'), { status: 400 });
  }
  const start = startAt ? new Date(startAt) : new Date();
  const end = endAt ? new Date(endAt) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) {
    throw Object.assign(new Error('A valid reward end date after the start date is required.'), { status: 400 });
  }

  const defaultPercentage = await currentGlobalPercentage();

  const { data: batch, error: batchErr } = await supabase
    .from('ba_reward_batches')
    .insert({
      new_percentage: percentage,
      default_percentage_at_time: defaultPercentage,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      ba_count: baIds.length,
      created_by_admin_id: adminId,
    })
    .select()
    .single();
  if (batchErr) throw batchErr;

  const { data: bas, error: baErr } = await supabase.from('brand_ambassadors').select('id, full_name, ba_code, phone, email').in('id', baIds);
  if (baErr) throw baErr;

  const rewardRows = [];
  for (const baId of baIds) {
    const previousRate = await resolveApplicableRate(baId, start);

    const { data: rule, error: ruleErr } = await supabase
      .from('payout_rules')
      .insert({
        scope: 'ba_override',
        ba_id: baId,
        percentage,
        effective_from: start.toISOString(),
        effective_until: end.toISOString(),
        set_by_admin_id: adminId,
      })
      .select()
      .single();
    if (ruleErr) throw ruleErr;

    const { data: reward, error: rewardErr } = await supabase
      .from('ba_rewards')
      .insert({
        batch_id: batch.id,
        ba_id: baId,
        payout_rule_id: rule.id,
        previous_percentage: previousRate ? previousRate.percentage : null,
        new_percentage: percentage,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        created_by_admin_id: adminId,
      })
      .select()
      .single();
    if (rewardErr) throw rewardErr;

    rewardRows.push(reward);

    logActivity({
      actorType: 'admin',
      actorId: adminId,
      action: 'ba_reward_granted',
      targetType: 'brand_ambassador',
      targetId: baId,
      metadata: { batchId: batch.id, previousPercentage: previousRate ? previousRate.percentage : null, newPercentage: percentage, startAt: start, endAt: end },
    });
  }

  // Notify rewarded BAs (in-app + push) - awaited (not fire-and-forget)
  // so the response can report how many actually got through, rather
  // than the caller/UI unconditionally claiming success (see FIX
  // below in the controller - this mirrors the exact bug notify.service.js
  // already documents fixing for tenant-facing sends: "the message
  // does not reach... while the sender's UI claimed success"). The
  // wider "everyone else" motivational nudge stays fire-and-forget -
  // it's a nice-to-have broadcast, not something the confirmation
  // screen makes a specific claim about.
  const notifiedCount = await notifyRewardedBas(bas || [], { percentage, defaultPercentage, start, end });
  broadcastMotivationalNudge(baIds).catch((err) => {
    logger.error('[baRewards] broadcastMotivationalNudge failed:', err.message);
    captureException(err);
  });

  return { batch, rewards: rewardRows, bas: bas || [], notifiedCount };
}

// Returns how many of `bas` actually received at least one delivery
// channel (in-app inbox row or push - see notify()'s own all-channels-
// failed check), instead of assuming every attempt succeeded.
async function notifyRewardedBas(bas, { percentage, defaultPercentage, start, end }) {
  const periodLabel = `${start.toLocaleDateString('en-GB')} – ${end.toLocaleDateString('en-GB')}`;
  const message = `You've been rewarded a custom commission rate of ${percentage}% (default is ${defaultPercentage}%) from ${periodLabel}. Keep up the great work!`;
  const results = await Promise.allSettled(
    bas.map((b) =>
      notify('brand_ambassador', b.id, null, message, {
        category: 'ba_reward_granted',
        title: 'You\u2019ve been rewarded!',
      })
    )
  );
  let notifiedCount = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      notifiedCount += 1;
    } else {
      logger.error(`[baRewards] reward notify failed for BA ${bas[i].id}:`, r.reason?.message || r.reason);
      captureException(r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
    }
  });
  return notifiedCount;
}

/**
 * "Top performers get rewarded generously, keep pushing" nudge to
 * every active/suspended BA who was NOT part of this reward round.
 */
async function broadcastMotivationalNudge(rewardedBaIds) {
  const { data: allBas, error } = await supabase.from('brand_ambassadors').select('id').in('status', ['active', 'suspended']);
  if (error) throw error;
  const rewardedSet = new Set(rewardedBaIds);
  const targets = (allBas || []).filter((b) => !rewardedSet.has(b.id));
  const message = 'Top performers just got rewarded with a generous commission boost. Keep onboarding and stay active on the leaderboard for the next reward round!';
  await Promise.all(
    targets.map((b) =>
      notify('brand_ambassador', b.id, null, message, {
        category: 'ba_reward_motivational_broadcast',
        title: 'Rewards are live \u2014 keep pushing',
      }).catch((err) => {
        logger.error(`[baRewards] motivational broadcast failed for BA ${b.id}:`, err.message);
        captureException(err);
      })
    )
  );
}

/**
 * Standing "challenge" style prompt - reusable for a scheduled/manual
 * reminder that top-ranked BAs receive better commission rates, not
 * just tied to a one-off reward announcement.
 */
async function sendStandingChallengeBroadcast() {
  const { data: allBas, error } = await supabase.from('brand_ambassadors').select('id').in('status', ['active', 'suspended']);
  if (error) throw error;
  const message = 'Reminder: top-ranked Brand Ambassadors on the leaderboard earn better commission rates. Keep onboarding landlords and stay active to climb the ranks.';
  await Promise.all(
    (allBas || []).map((b) =>
      notify('brand_ambassador', b.id, null, message, {
        category: 'ba_reward_challenge_reminder',
        title: 'Climb the leaderboard',
      }).catch((err) => {
        logger.error(`[baRewards] challenge broadcast failed for BA ${b.id}:`, err.message);
        captureException(err);
      })
    )
  );
  return { notified: (allBas || []).length };
}

/**
 * Reward history - a running log of every reward ever issued, newest
 * first, each row carrying enough BA identity to render without a
 * further lookup.
 */
async function listRewardHistory() {
  const { data: rewards, error } = await supabase
    .from('ba_rewards')
    .select('id, batch_id, ba_id, previous_percentage, new_percentage, start_at, end_at, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!rewards || rewards.length === 0) return [];

  const baIds = [...new Set(rewards.map((r) => r.ba_id))];
  const { data: bas, error: baErr } = await supabase.from('brand_ambassadors').select('id, full_name, ba_code, phone, email').in('id', baIds);
  if (baErr) throw baErr;
  const baById = new Map((bas || []).map((b) => [b.id, b]));

  const now = new Date();
  return rewards.map((r) => ({
    ...r,
    baName: baById.get(r.ba_id)?.full_name || 'Unknown BA',
    baCode: baById.get(r.ba_id)?.ba_code || null,
    status: new Date(r.end_at) > now ? 'active' : 'completed',
  }));
}

async function getRewardBatch(batchId) {
  const { data: batch, error: batchErr } = await supabase.from('ba_reward_batches').select('*').eq('id', batchId).maybeSingle();
  if (batchErr) throw batchErr;
  if (!batch) return null;

  const { data: rewards, error: rewardsErr } = await supabase.from('ba_rewards').select('*').eq('batch_id', batchId);
  if (rewardsErr) throw rewardsErr;

  const baIds = (rewards || []).map((r) => r.ba_id);
  const { data: bas, error: baErr } = await supabase.from('brand_ambassadors').select('id, full_name, ba_code, phone, email').in('id', baIds.length ? baIds : ['00000000-0000-0000-0000-000000000000']);
  if (baErr) throw baErr;
  const baById = new Map((bas || []).map((b) => [b.id, b]));

  return {
    batch,
    rewards: (rewards || []).map((r) => ({
      ...r,
      baName: baById.get(r.ba_id)?.full_name || 'Unknown BA',
      baCode: baById.get(r.ba_id)?.ba_code || null,
      baPhone: baById.get(r.ba_id)?.phone || null,
      baEmail: baById.get(r.ba_id)?.email || null,
    })),
  };
}

module.exports = {
  getLeaderboard,
  rewardBAs,
  listRewardHistory,
  getRewardBatch,
  sendStandingChallengeBroadcast,
};
