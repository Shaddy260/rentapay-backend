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

  tenantLoginCredentials: (tenantName, unitCode, tempPassword, otpCode) =>
    `Welcome ${tenantName}! Your RentaPay login - Unit code: ${unitCode}, Temp password: ${tempPassword}, OTP: ${otpCode} (expires in 24 hours). ` +
    `Log in here: ${process.env.FRONTEND_URL || 'https://rentapay.co.ke'}/login - you'll be asked to set a permanent password on first login.`,
  passwordChanged: (name) =>
    `Hi ${name}, your RentaPay password was just changed. If this wasn't you, contact support immediately.`,

  // --- Property manager onboarding ---
  managerLoginCredentials: (managerName, landlordName, tempPassword, otpCode) =>
    `Welcome ${managerName}! ${landlordName} has added you as a property manager on RentaPay. ` +
    `Temp password: ${tempPassword}, OTP: ${otpCode} (expires in 24 hours). ` +
    `Log in here: ${process.env.FRONTEND_URL || 'https://rentapay.co.ke'}/login - you'll be asked to set a permanent password on first login.`,

  managerAssignmentsUpdated: (managerName) =>
    `Hi ${managerName}, the properties you have access to on RentaPay have been updated.`,

  managerRemoved: (managerName) =>
    `Hi ${managerName}, your property manager access on RentaPay has been removed.`,
};

module.exports = templates;
