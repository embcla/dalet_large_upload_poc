module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '..',
  testMatch: ['<rootDir>/integration/**/*.test.ts'],
  globalSetup: '<rootDir>/integration/global-setup.ts',
  testTimeout: 5 * 60 * 1000,
  // m3-network.test.ts mutates shared Toxiproxy state (toxics on the
  // backend_api proxy used by THROTTLED_TUS_ENDPOINT/THROTTLED_BACKEND_URL).
  // Running test files in parallel lets e.g. its reset_peer toxic reset a
  // concurrent upload from m5-progress.test.ts, so run suites serially.
  maxWorkers: 1,
};
