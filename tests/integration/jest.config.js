module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '..',
  testMatch: ['<rootDir>/integration/**/*.test.ts'],
  globalSetup: '<rootDir>/integration/global-setup.ts',
  testTimeout: 5 * 60 * 1000,
};
