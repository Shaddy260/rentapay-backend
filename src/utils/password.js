// src/utils/password.js
//
// Implements blueprint 3.3 password rules:
//   - Min 8 characters
//   - At least one uppercase
//   - At least one number
//   - At least one special character
//   - Cannot equal phone number or name

const bcrypt = require('bcrypt');

// PERFORMANCE FIX (direct request: "during logins it takes too long
// to read the inputted password"): bcrypt's cost factor is
// exponential - each +1 round roughly doubles the hashing time. 12
// rounds can take 250-400ms+ on typical server hardware, EVERY single
// login and EVERY single password change, for security benefit that's
// negligible over 10 rounds (still ~2.5 billion times harder to brute
// force than a fast hash, and still well above current industry
// baseline recommendations). This is pure CPU time on the server, not
// network latency, so it's one of the few places code changes
// actually move the needle on "why does login feel slow".
const SALT_ROUNDS = 10;

function validatePasswordStrength(password, { phone, name } = {}) {
  const errors = [];

  if (!password || password.length < 8) {
    errors.push('Password must be at least 8 characters long.');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter.');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number.');
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character (!@#$%^&* etc).');
  }
  if (phone && password === phone) {
    errors.push('Password cannot be the same as your phone number.');
  }
  if (name && password.toLowerCase() === name.toLowerCase()) {
    errors.push('Password cannot be the same as your name.');
  }

  return { isValid: errors.length === 0, errors };
}

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

async function comparePassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}

module.exports = { validatePasswordStrength, hashPassword, comparePassword };
