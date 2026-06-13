/**
 * Thin wrapper around the Toxiproxy admin API (M3, §7) for the `backend_api`
 * proxy (browser -> backend, host port 3001 via THROTTLED_TUS_ENDPOINT). Used
 * to add/remove toxics (latency, reset_peer, extra bandwidth) on top of the
 * always-present `upload-bandwidth` baseline toxic from `toxiproxy/init.sh`.
 */

export const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? 'http://localhost:8474';
export const PROXY_NAME = 'backend_api';

/** Name of the baseline toxic created by `toxiproxy/init.sh` on startup. */
export const BASELINE_TOXIC_NAME = 'upload-bandwidth';

export interface Toxic {
  name: string;
  type: string;
  stream: 'upstream' | 'downstream';
  attributes: Record<string, number>;
  toxicity?: number;
}

export async function addToxic(toxic: Toxic): Promise<void> {
  const res = await fetch(`${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toxic),
  });
  if (!res.ok) {
    throw new Error(`addToxic(${toxic.name}) failed: ${res.status} ${await res.text()}`);
  }
}

export async function removeToxic(name: string): Promise<void> {
  const res = await fetch(`${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics/${name}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`removeToxic(${name}) failed: ${res.status} ${await res.text()}`);
  }
}

export async function listToxics(): Promise<Toxic[]> {
  const res = await fetch(`${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics`);
  return (await res.json()) as Toxic[];
}
