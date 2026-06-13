# Media Upload Platform

A resumable media upload platform built around the [tus](https://tus.io/)
protocol. This repo currently implements:

- **M0** — repo scaffolding, docker-compose stack (frontend, backend, MinIO),
  SQLite metadata store, build scripts.
- **M1** — resumable upload of a single large `.mp4`/`.mkv` file via tus,
  with client-side and server-side validation (file type, 2GB size limit)
  and a progress UI.
- **M2** — pause/resume/retry controls, a `paused`/`error` status UI, and
  session-liveness tracking (§2.11/§2.12): the client sends a heartbeat
  (`POST /uploads/:id/heartbeat`) every ~20s while uploading or paused, and
  an `abandon` beacon (`POST /uploads/:id/abandon`) on page unload for any
  non-success session. A backend interval job aborts the S3 multipart upload
  and marks the session `abandoned` if no heartbeat is seen within
  `heartbeatTimeoutSeconds` (default 90s).

  Known limitation (by design, §2.12): pause/resume only works within the
  same browser session/tab — a full page reload loses the in-memory upload
  handle and cannot resume, even though the server-side upload remains valid
  until the cleanup job (or abandon beacon) removes it.
- **M3** — Toxiproxy sits between the frontend and backend (`browser ↔
  backend`) for network-degradation testing during local dev (see "Upload
  throttling" below). The scenario test suite (§7, `m3-network.test.ts`)
  injects latency and connection resets via the Toxiproxy admin API and
  verifies uploads/resumes survive them; an opt-in test confirms a heavily
  bandwidth-throttled upload is kept alive past `heartbeatTimeoutSeconds` by
  the client's heartbeat (§7.4/§9.10).
- **M4** — additive SQLite schema migration only (§8): no new endpoints, UI,
  or behavioral changes. Adds `bytes_received` (read by M5's SSE snapshot)
  plus forward-looking columns (`batch_key`, `last_modified`,
  `batch_position`, `client_file_hash`, `server_file_hash`,
  `hash_verified`) reserved for later milestones. All M0-M3 rows and code
  paths are unaffected.
- **M5** — backend-pushed live progress over Server-Sent Events (§9):
  `GET /progress/stream` sends a snapshot of all in-progress uploads on
  connect, then pushes an event per upload as its `bytes_received` changes
  (throttled to one update per `PROGRESS_THROTTLE_MS`, default 300ms, via
  `@tus/server`'s `POST_RECEIVE_V2`) and a final event on `success`. The
  `abandon` endpoint and the cleanup job (§2.11) also broadcast an
  `abandoned` event, which the frontend now surfaces as a 6th status
  (`idle | uploading | paused | error | success | abandoned`) alongside the
  existing pause/resume/retry controls.

M6 (batch queue) and M7 (playback/streaming) are not yet implemented.

## Repo layout

```
backend/            Express + tus + S3 (MinIO) + SQLite, TypeScript
frontend/           Angular app (standalone components)
minio/
  bucket-init/      One-shot init: creates bucket + least-privilege service account
  policy.json       IAM policy attached to the backend's MinIO service account
toxiproxy/          Throttles browser -> backend uploads for local dev (see below)
docker-images/      Dockerfiles for backend and frontend images
build/              Thin docker build wrappers (build-backend.sh, build-frontend.sh, build-all.sh)
tests/
  integration/      Jest tests against the running docker-compose stack
  e2e/              Playwright UI test
  generators/       Test file generator (fallocate-based)
docker-compose.yml
.env                Local-dev credentials/config used by docker-compose
```

## Quick start

Requires Docker and Docker Compose.

```sh
docker compose up --build
```

This starts:

| Service  | URL                          | Notes                                  |
| -------- | ---------------------------- | --------------------------------------- |
| frontend | http://localhost:4200        | Angular app, served via nginx           |
| backend (via toxiproxy) | http://localhost:3001 | what the frontend talks to — throttled, see below |
| backend (direct) | http://localhost:3000 | `GET /health`, `GET /config`, tus at `/uploads` — unthrottled, used by tests |
| toxiproxy admin API | http://localhost:8474 | inspect/adjust the throttle (`GET /proxies`) |
| MinIO API | http://localhost:9000       | S3-compatible storage                   |
| MinIO console | http://localhost:9001   | login with `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from `.env` |

The `minio-init` service runs once on startup to create the `media-uploads`
bucket and a least-privilege service account (scoped via `minio/policy.json`)
that the backend uses instead of the MinIO root credentials.

Open http://localhost:4200 and upload a `.mp4` or `.mkv` file (up to 2GB) to
see the progress bar and completion state. Uploaded objects appear in the
MinIO console under the `media-uploads` bucket; upload metadata is recorded
in `backend/data/db.sqlite`.

### Upload throttling (dev convenience)

On a local docker-compose stack, uploads are fast enough (LAN/loopback
speeds) that the progress bar and Pause/Resume controls barely have time to
render. The `toxiproxy` service sits between the frontend and the backend
(the frontend's `apiBaseUrl` points at `http://localhost:3001`, which proxies
to the backend's `:3000`) and applies a `bandwidth` toxic to the
browser->backend direction, capping upload throughput to
`UPLOAD_THROTTLE_RATE_KB` (default `20000`, i.e. ~20MB/s — a 1GB upload takes
~50s).

- Adjust the rate by changing `UPLOAD_THROTTLE_RATE_KB` in `.env` and
  re-running `docker compose up -d` (re-runs `toxiproxy-init`).
- Adjust it live without restarting via the admin API, e.g.:
  ```sh
  curl -X PATCH http://localhost:8474/proxies/backend_api/toxics/upload-bandwidth \
    -H 'Content-Type: application/json' -d '{"attributes":{"rate":5000}}'
  ```
- This only affects the frontend (port 3001). The backend's own port 3000 —
  used by the integration/e2e test harness — is unthrottled.

### Incomplete-upload cleanup (§2.11)

Incomplete multipart uploads (e.g. from an aborted upload) are automatically
cleaned up by MinIO's built-in stale-upload sweep (`api.stale_uploads_expiry`
/ `api.stale_uploads_cleanup_interval`, defaulting to 24h / 6h). A per-bucket
`AbortIncompleteMultipartUpload` lifecycle rule was not used because current
MinIO server releases reject that rule.

## Configuration

`.env` (loaded by docker-compose) holds local-dev defaults: MinIO root
credentials, the bucket name, the backend's service-account credentials, and
the frontend's CORS origin. These are dev-only values, not for production.

## Building images without compose

```sh
build/build-backend.sh
build/build-frontend.sh
# or both:
build/build-all.sh
```

## Running the tests

Run everything (backend/frontend unit, integration, e2e) with a single
consolidated pass/fail summary:

```sh
./runtests.sh
```

It requires the docker-compose stack to be running (for the integration and
e2e suites) and falls back to a `node:22` container for the frontend suite if
the host Node version is too old. Full output per suite is captured to a temp
log directory (path printed at the end) for debugging failures. When adding a
new test suite (e.g. for a future milestone), add it to `runtests.sh` so it
folds into this summary — see the comment above the `run` calls there.

### Backend unit tests

```sh
cd backend
npm install
npm test
```

### Frontend unit tests

The Angular CLI requires Node 22. If your host Node version is older, run via
Docker:

```sh
cd frontend
docker run --rm -v "$(pwd)/..":/workspace -w /workspace/frontend \
  -u "$(id -u):$(id -g)" -e HOME=/tmp node:22 sh -c "npm install && npx ng test"
```

(or `npm install && npx ng test` directly if you have Node 22.)

### Integration tests

Runs against the running docker-compose stack (start it first with
`docker compose up -d --build`). Verifies the upload matrix (`.mp4`/`.mkv` at
several sizes, checksummed against the MinIO object), the 2GB size limit
(413), the file-extension allowlist (4xx), and the M2 resume/heartbeat/
abandon/cleanup flows (`m2-resume.test.ts`): a dropped connection resumes to
a checksum-matching object, `POST /uploads/:id/heartbeat` bumps `last_seen`,
`POST /uploads/:id/abandon` marks a session `abandoned` and aborts its S3
multipart upload, and `POST /internal/cleanup/run` does the same for sessions
with a stale heartbeat.

`m5-progress.test.ts` connects to `GET /progress/stream` and asserts the
snapshot-on-connect for an in-progress upload, the `success`/`abandoned`
terminal events (the latter via both the `abandon` endpoint and the cleanup
job), and that an upload sent through the throttled proxy (port 3001)
produces throttled `uploading` progress events with non-decreasing
`bytesReceived`.

`m3-network.test.ts` (§7) drives the Toxiproxy admin API (port 8474) to add
toxics on top of the baseline `upload-bandwidth` throttle, on the
`backend_api` proxy used by `THROTTLED_TUS_ENDPOINT`: a `latency` toxic
(an upload still completes with a matching checksum), and a `reset_peer`
toxic (a resume attempt through the proxy fails with a connection-level
error, the server-side upload is unaffected, and after the toxic is removed
the upload resumes to completion — also checking via SSE that a fresh
connection re-syncs to the stalled offset and the eventual `success` event,
§9.11). Each test removes the toxics it adds and an `afterEach` confirms only
the baseline toxic remains. An opt-in test (§7.4/§9.10, ~2 minutes) adds a
tight `bandwidth` toxic (50 KB/s) and uploads a 6MB file with heartbeats sent
every 15s; it asserts the upload completes as `success` (not `abandoned`)
even though it takes well over `heartbeatTimeoutSeconds` (90s default), and
that the SSE stream shows `uploading` throughout with non-decreasing
`bytesReceived` and a final `success` event.

Because `m3-network.test.ts` mutates shared Toxiproxy state on the
`backend_api` proxy (e.g. a `reset_peer` toxic would otherwise also reset
other suites' in-flight uploads through `THROTTLED_TUS_ENDPOINT`), the
integration Jest config runs all suites in this directory serially
(`maxWorkers: 1`).

`m5-sse-resilience.test.ts` (§9.9/§9.11) asserts that a fresh
`GET /progress/stream` connection re-syncs an in-progress upload via its
snapshot (independent of any prior connection), and that across an
abort+resume cycle the SSE stream shows the upload as `uploading` (stalled at
the abort offset, no spurious `success`/`error`/`abandoned`), then resumes to
a single final `success` event with `bytesReceived === bytesTotal`.

```sh
cd tests
npm install
npm run test:integration

# also run the large-file matrix (100/200/1000/2000MB, several minutes):
FULL_MATRIX=1 npm run test:integration

# also run the §7.4/§9.10 bandwidth-throttle/heartbeat scenario (~2 minutes):
SLOW_SCENARIOS=1 npm run test:integration
```

### End-to-end UI test (Playwright)

Also requires the docker-compose stack to be running.

```sh
cd tests
npm install
npx playwright install chromium  # first time only
npm run test:e2e
```

`m2-resume.spec.ts` exercises the Pause/Resume controls in the browser: it
delays the upload's PATCH request just long enough to click Pause, confirms
the `paused` status UI and Resume button appear, then resumes to completion.

`m5-progress.spec.ts` covers the SSE-driven `error`/`abandoned` statuses
(§9.12): a PATCH that's made to fail shows the `error` message and a Retry
button, and calling `POST /uploads/:id/abandon` while a session is uploading
causes the page (via the SSE push, with no user action) to show the
`abandoned` message.
