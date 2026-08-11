// src/services/notificationTemplates.js
//
// Centralizes the actual wording sent to users, matching blueprint
// section 10 (Notifications & Communications) event-by-event.
// Keeping templates here means controllers never hand-write SMS text.

const templates = {
  // --- Tenant-facing (blueprint 10.1) ---
  rentDueSoon: (tenantName, amount, dueDate) =>
    `Hi ${tenantName}, your rent of KES ${amount} is due on ${dueDate}. Pay now via the RentaPay portal.`,

  rentDueToday: (tenantName, amount) =>
    `Hi ${tenantName}, your rent of KES ${amount} is due today. Pay now via the RentaPay portal.`,

  rentOverdue: (tenantName, amount) =>
    `Hi ${tenantName}, your rent of KES ${amount} is overdue. Please pay as soon as you can via the RentaPay portal.`,

  overdueUpdate: (tenantName, totalDue, daysLate) =>
    `Hi ${tenantName}, your outstanding balance is now KES ${totalDue} (${daysLate} days late). Pay via the RentaPay portal.`,

  paymentReceipt: (tenantName, amount, transId, date) =>
    `Receipt: Hi ${tenantName}, we received your payment of KES ${amount} on ${date}. Ref: ${transId}. Thank you!`,

  rentAltered: (tenantName, newAmount, effectiveDate) =>
    `Hi ${tenantName}, your rent has been updated to KES ${newAmount}, effective ${effectiveDate}.`,

  vacatingNoticeConfirmed: (tenantName, vacateDate) =>
    `Hi ${tenantName}, your vacating notice for ${vacateDate} has been received and confirmed.`,

  vacatingNoticeRevoked: (tenantName) =>
    `Hi ${tenantName}, your vacating notice has been revoked. Your tenancy continues as normal.`,

  // DIRECT REQUEST: "before that vacating date arrives, also remind
  // the tenant several times... and tell them to revoke/call if they
  // think it was a mistake, as when that same day arrives, after
  // that their account should be deactivated." daysLeft distinguishes
  // the two reminder points (see vacatingNoticeReminders.job.js).
  vacatingNoticeReminder: (tenantName, vacateDate, daysLeft) =>
    `Hi ${tenantName}, a reminder: you're set to vacate on ${vacateDate} (${daysLeft} day${daysLeft === 1 ? '' : 's'} from now). ` +
    `Once that date arrives, your account will be deactivated and you won't be able to log in again. ` +
    `If this was a mistake, cancel your notice in the portal, or call your landlord/manager/caretaker right away.`,

  vacatingDateArrivedAccountDeactivated: (tenantName, vacateDate) =>
    `Hi ${tenantName}, your vacating date (${vacateDate}) has arrived. Your RentaPay account has now been deactivated - thank you for being a tenant.`,

  accountSuspendedTenantView: () =>
    `Service temporarily unavailable. Please contact your landlord directly.`,

  // --- Landlord-facing (blueprint 10.2) ---
  unpaidTenantsListIntro: (count) => `You have ${count} tenant(s) with unpaid rent as of today. Check your dashboard for details.`,

  overdueAlert: (tenantName, unitName, daysLate, totalDue) =>
    `Alert: ${tenantName} (Unit ${unitName}) is ${daysLate} days overdue. Outstanding: KES ${totalDue}.`,

  tenantPaid: (tenantName, unitName, amount) =>
    `${tenantName} (Unit ${unitName}) just paid KES ${amount}. Dashboard updated.`,

  partialPaymentReceived: (tenantName, unitName, amountPaid, balanceRemaining) =>
    `${tenantName} (Unit ${unitName}) made a partial payment of KES ${amountPaid}. Remaining balance: KES ${balanceRemaining}.`,

  vacatingNoticeSubmitted: (tenantName, unitName, vacateDate) =>
    `${tenantName} (Unit ${unitName}) has given notice to vacate on ${vacateDate}. Start planning for re-letting.`,

  unitBecameVacant: (unitName) => `Unit ${unitName} is now vacant. Add a new tenant whenever you're ready.`,

  subscriptionExpiring: (daysLeft) => `Your RentaPay subscription expires in ${daysLeft} days. Renew now to avoid losing access.`,

  subscriptionRenewed: (newExpiryDate) => `Your RentaPay subscription has been renewed. New expiry date: ${newExpiryDate}.`,

  newTenantAddedConfirmation: (tenantName, unitName) => `${tenantName} has been added to Unit ${unitName} and sent their login details.`,

  // --- Onboarding (blueprint 3.1, 4 onboarding flows) ---
  // Covers first-time account verification (registration/resend-otp) -
  // matches getOTPExpiry()'s 24-hour window in utils/otp.js.
  otpMessage: (otpCode) => `Your RentaPay verification code is ${otpCode}. It expires in 24 hours. Do not share this code.`,

  // Separate from otpMessage above - a "forgot password" code is
  // meant to be used right away, so it gets a much shorter window:
  // matches getPasswordResetOTPExpiry()'s 5-minute window in
  // utils/otp.js. Kept as its own template (rather than reusing
  // otpMessage) precisely so the two expiry windows can never drift
  // out of sync with what the email actually says.
  passwordResetOtpMessage: (otpCode) => `Your RentaPay password reset code is ${otpCode}. It expires in 5 minutes. Do not share this code.`,

  // Separate from otpMessage above - the admin 2FA OTP (blueprint
  // 13.3) expires in 5 minutes, not 24 hours. Using otpMessage for
  // both previously sent the wrong expiry text to the admin even
  // though the actual expiry logic (adminLogin's 5-minute window) was
  // already correct - this was a copy text bug, not a security bug.
  adminOtpMessage: (otpCode) => `Your RentaPay admin verification code is ${otpCode}. It expires in 5 minutes. Do not share this code.`,

  // DIRECT REQUEST ("verification of email should be once"): a tenant
  // who self-onboarded via the shared link already proved they
  // control this email (the OTP box on the public form) - otpCode is
  // null for them, and the message skips straight to "log in and set
  // a password" instead of asking for a SECOND OTP they'd have no
  // reason to expect. A manually-added tenant (landlord/manager/
  // caretaker typed the email in on their behalf) still gets the OTP,
  // since nobody has confirmed THEY control that inbox yet.
  tenantLoginCredentials: (tenantName, unitCode, tempPassword, otpCode) =>
    otpCode
      ? `Welcome ${tenantName}! Your RentaPay login - Unit code: ${unitCode}, Temp password: ${tempPassword}, OTP: ${otpCode} (expires in 24 hours). ` +
        `Log in here: ${process.env.FRONTEND_URL || 'https://rentapay.co.ke'}/login - you'll be asked to set a permanent password on first login. ` +
        `For the easiest experience, download the RentaPay app on your phone. ` +
        `Also, follow our WhatsApp channel for updates: https://whatsapp.com/channel/0029VbDSNw1ATRSwVwZ6NC0U`
      : `Welcome ${tenantName}! Your RentaPay login - Unit code: ${unitCode}, Temp password: ${tempPassword}. ` +
        `Log in here: ${process.env.FRONTEND_URL || 'https://rentapay.co.ke'}/login - you'll be asked to set a permanent password on first login. ` +
        `For the easiest experience, download the RentaPay app on your phone. ` +
        `Also, follow our WhatsApp channel for updates: https://whatsapp.com/channel/0029VbDSNw1ATRSwVwZ6NC0U`,
  passwordChanged: (name) =>
    `Hi ${name}, your RentaPay password was just changed. If this wasn't you, contact support immediately.`,

  // Sent whenever a tenant is added to a unit (any landlord), showing
  // their current portable tenancy reputation - a distilled score
  // (not raw history from any one landlord), so the tenant always
  // knows what follows them via their email before a new landlord
  // sees it too. See rentapay-notes for the "consent and visibility"
  // principle this is built around.
  tenancyReputationSummary: (tenantName, reputation) => {
    if (!reputation || !reputation.totalRatings) {
      return (
        `Hi ${tenantName}, welcome to RentaPay. Your tenancy reputation profile has been created and will follow you (by this email address) to any future landlord who adds you on RentaPay. ` +
        `It's currently empty since you have no ratings yet - it fills in as landlords rate your tenancy over time.`
      );
    }
    return (
      `Hi ${tenantName}, here is your current RentaPay tenancy reputation: ${reputation.averageRating} out of 5 stars, from ${reputation.totalRatings} rating(s) across ${reputation.priorLandlordCount} landlord(s). ` +
      `This score is portable - it follows your account by email to any future landlord who adds you on RentaPay, and it's visible to you first. ` +
      `You can view the full breakdown any time from your tenant portal.`
    );
  },

  // Sent when a tenant is archived (deleteTenant) - mirrors
  // managerRemoved below: lets them know the tenancy is over and the
  // login they had stops working immediately, rather than them
  // discovering it only when a later login attempt is rejected.
  tenancyEnded: (tenantName) =>
    `Hi ${tenantName}, your tenancy has been marked as ended on RentaPay and your login for that account no longer works. ` +
    `Your payment history is preserved for your records. If you believe this was done in error, contact your landlord directly.`,

  // --- Property manager onboarding ---
  managerLoginCredentials: (managerName, landlordName, tempPassword) =>
    `Welcome ${managerName}! ${landlordName} has added you as a property manager on RentaPay. ` +
    `Temp password: ${tempPassword}. ` +
    `Log in here: ${process.env.FRONTEND_URL || 'https://rentapay.co.ke'}/login - you'll be asked to set a permanent password on first login. ` +
    `For the easiest experience, download the RentaPay app on your phone. ` +
    `Also, follow our WhatsApp channel for updates: https://whatsapp.com/channel/0029VbDSNw1ATRSwVwZ6NC0U`,

  managerAssignmentsUpdated: (managerName) =>
    `Hi ${managerName}, the properties you have access to on RentaPay have been updated.`,

  managerRemoved: (managerName) =>
    `Hi ${managerName}, your property manager access on RentaPay has been removed.`,

  // --- Portfolio health digest (direct request #5) ---
  // Returns { subject, body } - body is plain text/newlines. Used to
  // be wrapped into HTML by wrapEmailHtml() for an email; per
  // requirements spec item #14 ("monthly cadence, in-app only, no
  // email") this now feeds the in-app notifications inbox instead
  // (see portfolioDigest.job.js), so `body` is rendered as plain
  // text there. `period` is always 'monthly' now (the weekly cadence
  // was removed) - the parameter is kept so the call site doesn't
  // need to change and in case a lighter cadence is reintroduced later.
  portfolioDigestEmail: (landlordName, stats, period) => {
    const periodLabel = period === 'monthly' ? 'Monthly' : 'Weekly';
    const lines = [];
    lines.push(`Hi ${landlordName}, here's your ${periodLabel.toLowerCase()} RentaPay portfolio summary.`);
    lines.push('');
    lines.push(`Occupancy: ${stats.occupancyRate}% (${stats.totalUnits} unit(s) total)`);
    lines.push(
      stats.collectionRate === null
        ? 'Collection rate this period: no rent expected yet this month.'
        : `Collection rate this period: ${stats.collectionRate}% (KES ${stats.collectedThisMonth.toLocaleString()} of KES ${stats.expectedThisMonth.toLocaleString()} expected)`
    );

    if (stats.topLatePayers.length) {
      lines.push('');
      lines.push('Top late payers this period:');
      stats.topLatePayers.forEach((p, i) => {
        lines.push(`  ${i + 1}. ${p.tenantName} (${p.unitName}) - KES ${p.balanceDue.toLocaleString()} outstanding`);
      });
    } else {
      lines.push('');
      lines.push('No tenants currently owe a balance - nice work.');
    }

    if (stats.vacantNoPhotoCount > 0) {
      lines.push('');
      lines.push(
        `${stats.vacantNoPhotoCount} of your vacant unit(s) have no photos yet${
          stats.vacantNoPhotoUnitNames.length ? ` (${stats.vacantNoPhotoUnitNames.join(', ')}${stats.vacantNoPhotoCount > stats.vacantNoPhotoUnitNames.length ? ', ...' : ''})` : ''
        }. Units with photos get more inquiries - add some from your dashboard.`
      );
    }

    lines.push('');
    lines.push('View the full breakdown any time from your RentaPay dashboard.');

    return {
      subject: `Your ${periodLabel} Portfolio Summary`,
      body: lines.join('\n'),
    };
  },
};

module.exports = templates;
