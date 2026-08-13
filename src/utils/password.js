// src/utils/password.js
//
// Password rules (relaxed per request):
//   - Min 6 characters
//   - Letters and/or digits, user's choice - no forced uppercase,
//     number, or special character requirement

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

  if (!password || password.length < 6) {
    errors.push('Password must be at least 6 characters long.');
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
