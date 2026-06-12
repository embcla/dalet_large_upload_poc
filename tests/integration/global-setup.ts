// Verifies the docker-compose stack is up before running the integration
// suite. We don't start/stop the stack ourselves -- run
// `docker compose up -d --build` from the repo root first (see README).

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const RETRY_INTERVAL_MS = 1000;
const MAX_WAIT_MS = 30_000;

export default async function globalSetup(): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_URL}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // backend not reachable yet, retry
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }

  throw new Error(
    `Backend at ${BACKEND_URL}/health is not reachable. Start the stack first with ` +
      '`docker compose up -d --build` from the repo root.',
  );
}
