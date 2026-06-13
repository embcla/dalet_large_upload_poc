export const environment = {
  // Routed through toxiproxy (see docker-compose.yml / toxiproxy/) so upload
  // bandwidth can be throttled, making progress visible in the UI. The
  // backend itself remains directly reachable on :3000 for tests/debugging.
  apiBaseUrl: 'http://localhost:3001',
};
