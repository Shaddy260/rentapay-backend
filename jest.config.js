// jest.config.js
//
// Deliberately narrow testEnvironment/roots - this project has no
// browser code on the backend, and we don't want Jest crawling into
// node_modules or the sql/ folder looking for test files.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.js'],
  clearMocks: true,
  verbose: true,
};
