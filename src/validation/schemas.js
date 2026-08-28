// src/validation/schemas.js
//
// Phase 2 - runtime validation with Zod. One schema per high-risk write
// payload (registration, login/reset, tenant add/edit, money inputs).
// Controllers keep their existing business checks (duplicates,
// ownership, ledger math); these schemas guarantee the SHAPE of every
// payload so hand-rolled `if (!field)` checks stop being the only line
// of defense. Every schema is passthrough-friendly: unknown extra
// fields are ignored, not rejected, so nothing that used to reach the
// controller is blocked.

const { z } = require('zod');
const { validatePasswordStrength } = require('../utils/password');

const phoneDigits = (v) => {
  const digits = String(v == null ? '' : v).replace(/[\s\-()]/g, '');
  return /^\d{9,13}$/.test(digits);
};

const phoneSchema = z.string().refine(phoneDigits, 'Enter a valid Kenyan phone number (e.g. 07XXXXXXXX or 2547XXXXXXXX).');

const optionalPhone = z
  .union([z.string().refine(phoneDigits, 'Enter a valid Kenyan phone number.'), z.literal('')])
  .optional();

const optionalEmail = z
  .union([z.string().trim().email('Enter a valid email address.'), z.literal('')])
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const nonEmptyOrUndefined = (message) => z.union([z.string().min(1, message), z.undefined()]).optional();

const passwordField = z
  .string()
  .refine((v) => {
    const { isValid } = validatePasswordStrength(v);
    return isValid;
  }, 'Password must be at least 6 characters.');

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
const landlordRegisterSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is required.'),
  phone: phoneSchema,
  email: z.string().trim().email('Enter a valid email address.'),
  password: passwordField,
  gender: z.union([z.string(), z.undefined()]).optional(),
  unitsCount: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/), z.literal(''), z.undefined()])
    .optional(),
  periodMonths: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/), z.literal(''), z.undefined()])
    .optional(),
  whatsappNumber: z.union([z.string(), z.undefined()]).optional(),
  emailVerification: z.union([z.string(), z.undefined()]).optional(),
  refCode: z.union([z.string(), z.undefined()]).optional(),
});

const loginSchema = z
  .object({
    email: z.union([z.string().trim().min(1), z.undefined()]).optional(),
    phone: optionalPhone,
    password: z.string().min(1, 'Password is required.'),
  })
  .refine((d) => d.email || d.phone, 'Enter your email or phone.');

const forgotPasswordRequestSchema = z
  .object({
    email: z.union([z.string().trim().min(1), z.undefined()]).optional(),
    phone: optionalPhone,
  })
  .refine((d) => d.email || d.phone, 'Enter your email or phone.');

const resetPasswordSchema = z.object({
  email: z.string().trim().min(1, 'Email is required.'),
  otp: z.string().min(1, 'Verification code is required.'),
  newPassword: passwordField,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: passwordField,
});

// ---------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------
const addTenantSchema = z.object({
  unitId: z.string().min(1, 'unitId is required.'),
  fullName: z.string().trim().min(2, 'Full name is required.'),
  primaryPhone: phoneSchema,
  secondaryPhone: optionalPhone,
  email: optionalEmail,
  idNumber: nonEmptyOrUndefined('ID number cannot be empty.'),
  moveInDate: nonEmptyOrUndefined('Move-in date cannot be empty.'),
  rentOverride: z.union([z.number().positive('Rent override must be a positive number.'), z.undefined()]).optional(),
  dueDayOfMonth: z
    .union([z.number().int('Due day must be a whole number.').min(1, 'Due day must be between 1 and 31.').max(31, 'Due day must be between 1 and 31.'), z.undefined()])
    .optional(),
  emergencyContactName: nonEmptyOrUndefined('Emergency contact name cannot be empty.'),
  emergencyContactPhone: optionalPhone,
  depositAmount: z.union([z.number().positive('Deposit amount must be a positive number.'), z.undefined()]).optional(),
  depositPaidAt: nonEmptyOrUndefined('Deposit date cannot be empty.'),
  confirmDuplicate: z.union([z.boolean(), z.undefined()]).optional(),
});

const editTenantSchema = z.object({
  fullName: z.union([z.string().trim().min(2, 'Full name is too short.'), z.undefined()]).optional(),
  secondaryPhone: optionalPhone,
  email: optionalEmail,
  emergencyContactName: nonEmptyOrUndefined('Emergency contact name cannot be empty.'),
  emergencyContactPhone: optionalPhone,
  rentOverride: z.union([z.number().positive('Rent override must be a positive number.'), z.undefined()]).optional(),
  dueDayOfMonth: z
    .union([z.number().int().min(1, 'Due day must be between 1 and 31.').max(31, 'Due day must be between 1 and 31.'), z.undefined()])
    .optional(),
});

// ---------------------------------------------------------------------
// Payments (money inputs)
// ---------------------------------------------------------------------
const paybillSubmitSchema = z.object({
  transactionCode: z.string().trim().min(1, 'Transaction code is required.'),
  amountPaid: z.number().positive('Amount must be a valid positive number.'),
  mpesaPayerName: z.string().trim().min(1, 'Payer name is required.'),
  mpesaPayerPhone: phoneSchema,
  mpesaSmsTimestamp: z.string().trim().min(1, 'Payment SMS timestamp is required.'),
  targetInvoiceId: nonEmptyOrUndefined('Invoice cannot be empty.'),
});

const manualPaymentSchema = z.object({
  tenantId: z.string().min(1, 'tenantId is required.'),
  amount: z.number().positive('Amount must be a valid positive number.'),
  paymentDate: z.string().min(1, 'Payment date is required.'),
  mpesaReference: z.union([z.string(), z.undefined()]).optional(),
  paidBy: z.union([z.string(), z.undefined()]).optional(),
  note: z.union([z.string(), z.undefined()]).optional(),
});

const manualUtilityPaymentSchema = z.object({
  invoiceId: nonEmptyOrUndefined('Invoice cannot be empty.'),
  propertyId: nonEmptyOrUndefined('Property cannot be empty.'),
  utilityType: nonEmptyOrUndefined('Utility type cannot be empty.'),
  amount: z.union([z.number().positive('Amount must be a valid positive number.'), z.undefined()]).optional(),
  paymentDate: z.string().min(1, 'Payment date is required.'),
  mpesaReference: z.union([z.string(), z.undefined()]).optional(),
  note: z.union([z.string(), z.undefined()]).optional(),
});

module.exports = {
  landlordRegisterSchema,
  loginSchema,
  forgotPasswordRequestSchema,
  resetPasswordSchema,
  changePasswordSchema,
  addTenantSchema,
  editTenantSchema,
  paybillSubmitSchema,
  manualPaymentSchema,
  manualUtilityPaymentSchema,
};
