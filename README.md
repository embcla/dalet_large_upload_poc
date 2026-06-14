# Media Upload Platform

A resumable media upload platform built around the [tus](https://tus.io/)
protocol. Features: pause/resume across reloads, batch uploads, live SSE
progress, post-upload playback, integrity verification, cancellation, and
background reconciliation against the object store.

## Quick start

Requires Docker and Docker Compose.

```sh
docker compose up --build
```

| Service  | URL                          | Notes                                  |
| -------- | ---------------------------- | --------------------------------------- |
| frontend | http://localhost:4200        | Angular app, served via nginx           |
| backend (via toxiproxy) | http://localhost:3001 | what the frontend talks to — throttled, see below |
| backend (direct) | http://localhost:3000 | `GET /health`, `GET /config`, tus at `/uploads` — unthrottled, used by tests |
| toxiproxy admin API | http://localhost:8474 | inspect/adjust toxics (`GET /proxies`) |
| MinIO API | http://localhost:9000       | S3-compatible storage                   |
| MinIO console | http://localhost:9001   | login with `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from `.env` |

The `minio-init` service runs once on startup to create the `media-uploads`
bucket and a least-privilege service account (scoped via `minio/policy.json`)
that the backend uses instead of the MinIO root credentials.

Open http://localhost:4200 and upload a `.mp4`/`.mkv`/`.webm` file (up to 2GB)
to try the progress bar, batch queue, pause/resume, playback, and cancellation.
Uploaded objects appear in the MinIO console under `media-uploads`; metadata
is recorded in `backend/data/db.sqlite`.

## Running all the tests

```sh
./runtests.sh
```

**This is the one command to run everything** — backend unit, frontend unit,
integration, and e2e — with a consolidated pass/fail summary. It requires the
docker-compose stack to be running (`docker compose up -d --build`) and falls
back to a `node:22` container for the frontend suite if the host Node version
is too old. Full output per suite is captured to a temp log directory (path
printed at the end) for debugging failures. When adding a new test suite, add
it to `runtests.sh` so it folds into this summary.

See [Running individual test suites](#running-individual-test-suites) below
to run one suite at a time, or for more detail on what each one covers.

## Milestones

- **M0** — repo scaffolding: docker-compose stack (frontend, backend, MinIO),
  SQLite metadata store, build scripts.
- **M1** — resumable upload of a single `.mp4`/`.mkv` file via tus, with
  client/server validation (file type, 2GB limit) and a progress UI.
- **M2** — pause/resume/retry, `paused`/`error` statuses, and session-liveness
  tracking (§2.11/§2.12): the client sends a heartbeat
  (`POST /uploads/:id/heartbeat`) every ~20s and an `abandon` beacon
  (`POST /uploads/:id/abandon`) on page unload. A cleanup interval job aborts
  the S3 multipart upload and marks stale sessions `abandoned`.
- **M3** — Toxiproxy sits between frontend and backend for network-degradation
  testing — see [Toxiproxy: throttling & fault injection](#toxiproxy-throttling--fault-injection).
- **M4** — additive SQLite schema migration (§8), no behavioral changes —
  adds columns used by M5/M8.
- **M5** — backend-pushed live progress over SSE (§9): `GET /progress/stream`
  sends a snapshot of in-progress uploads on connect, then per-upload progress
  events (throttled to one per `PROGRESS_THROTTLE_MS`, default 300ms) and a
  final `success` or `abandoned` event.
- **M6** — batch upload (§10): selecting multiple files queues them and
  uploads sequentially via `UploadQueueService`/`UploadQueue`, each with its
  own status (`queued`/`uploading`/`paused`/`error`/`success`/`abandoned`/
  `skipped`) and progress bar, plus an aggregate progress bar. A per-file
  `error`/`abandoned` pauses the queue with Retry/Skip.
- **M7** — uploaded files visualization & playback (§11): a right-hand
  "Uploaded files" panel. On completion, the backend runs `ffprobe` to extract
  duration/resolution/codec and classifies the file as `playable` against a
  browser-compatible codec allowlist (§2.7). `GET /files` lists completed
  uploads with this metadata; `GET /files/:id/stream` proxies the MinIO object
  with HTTP Range support for `<video>` seeking. The panel auto-refreshes via
  the SSE channel.
- **M8** — session continuity (§12), the final core milestone:
  - SSE now also pushes `event: ping` every `PROGRESS_KEEPALIVE_MS` (20s); the
    frontend replies with `POST /batches/:batchKey/pong` to keep the active
    upload's session alive (replacing the M2 heartbeat on the frontend).
  - Every file selection is hashed (SHA-256 of `name|size|lastModified`) into
    a deterministic `batch_key`, persisted on the `uploads` row. Re-selecting
    the same file(s) — even after a full reload — fetches
    `GET /batches/:batchKey`: completed rows show as done, in-progress rows
    resume via `tus-js-client`'s `uploadUrl`, everything else starts fresh.
  - After completion, the client (`SubtleCrypto`) and server each compute a
    SHA-256 of the object; the result (`hashVerified`) is broadcast over SSE.
    A match shows a `✓ verified` badge; a mismatch sets `status: 'error'` and
    a terminal `corrupt` status with a Skip button.
- **M9** — cancellation (§13): a permanent, user-initiated `cancelled` status,
  distinct from the reversible `paused` and the server-detected `abandoned`.
  - Per-file `×` button: `DELETE /uploads/:id` aborts the S3 multipart upload,
    marks the row `cancelled`, and broadcasts over SSE. Idempotent (a repeat
    `DELETE`, or one for an unknown/`success` row, is a no-op `204`).
  - "Cancel remaining" batch action (with an inline confirmation):
    `DELETE /batches/:batchKey` cancels every non-`success` row in the batch
    sequentially.
- **M10** — MinIO object reconciliation (§14): a backend interval job
  (`RECONCILIATION_INTERVAL_MS`, default 5s) lists the bucket and compares it
  against every `success` row's `storage_key`. A `success` row whose object is
  gone is marked `missing` and broadcast over SSE; `POST
  /internal/reconcile/run` runs one pass synchronously (used by tests).
  Non-`success` rows are never touched. Orphaned bucket objects (other than
  `${id}.info`, tus's own metadata objects) are logged as warnings. On a
  `missing` event the frontend drops the file from the "Uploaded files" list
  (showing "File no longer available" if it was open in the player); a
  `missing` batch-manifest entry starts a fresh upload (like
  `abandoned`/`error`), and a `missing` queue item can be dismissed with `×`.

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
  e2e/              Playwright UI tests
  fixtures/         Test video fixtures (compatible.mp4, incompatible.mkv)
  generators/       Test file generator (fallocate-based)
runtests.sh         Runs every test suite with one consolidated summary
docker-compose.yml
.env                Local-dev credentials/config used by docker-compose
```

## Toxiproxy: throttling & fault injection

The `toxiproxy` service sits between the frontend and backend: the frontend's
`apiBaseUrl` points at `http://localhost:3001`, which proxies to the backend's
`:3000` via the `backend_api` proxy. The backend's direct port 3000 — used by
the integration/e2e harness — is unaffected by anything below.

### Upload throttling (dev convenience)

On a local stack, uploads are fast enough (LAN/loopback) that the progress bar
and Pause/Resume controls barely have time to render. A `bandwidth` toxic
(`upload-bandwidth`) caps browser->backend throughput at
`UPLOAD_THROTTLE_RATE_KB` (default `20000`, ~20MB/s — a 1GB upload takes ~50s).

- Change it persistently via `UPLOAD_THROTTLE_RATE_KB` in `.env`, then
  `docker compose up -d` (re-runs `toxiproxy-init`).
- Or adjust it live via the admin API:
  ```sh
  curl -X PATCH http://localhost:8474/proxies/backend_api/toxics/upload-bandwidth \
    -H 'Content-Type: application/json' -d '{"attributes":{"rate":5000}}'
  ```

### Injecting latency and connection failures

The same admin API can add further toxics to `backend_api` to simulate a
flaky network — this is how `m3-network.test.ts` (§7) exercises resume
behavior under network failure.

- **Latency** — delay every request/response, with optional jitter:
  ```sh
  curl -X POST http://localhost:8474/proxies/backend_api/toxics \
    -H 'Content-Type: application/json' \
    -d '{"name":"slow-upload","type":"latency","stream":"upstream","attributes":{"latency":2000,"jitter":500}}'
  ```
- **Connection reset** — simulate a dropped connection mid-upload:
  ```sh
  curl -X POST http://localhost:8474/proxies/backend_api/toxics \
    -H 'Content-Type: application/json' \
    -d '{"name":"drop-connection","type":"reset_peer","stream":"upstream","attributes":{"timeout":0}}'
  ```
- **Remove a toxic** once done:
  ```sh
  curl -X DELETE http://localhost:8474/proxies/backend_api/toxics/slow-upload
  ```

Uploads and the SSE channel are expected to recover from both: the client's
resume logic (M2/M8) picks up at the last acknowledged offset, and a fresh SSE
connection re-syncs via its on-connect snapshot.

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

## Running individual test suites

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

Run against the running docker-compose stack (start it first with
`docker compose up -d --build`):

```sh
cd tests
npm install
npm run test:integration

# also run the large-file matrix (100/200/1000/2000MB, several minutes):
FULL_MATRIX=1 npm run test:integration

# also run the §7.4/§9.10 bandwidth-throttle/heartbeat scenario (~2 minutes):
SLOW_SCENARIOS=1 npm run test:integration
```

| File | Covers |
| --- | --- |
| `m1-upload.test.ts` | Upload matrix (`.mp4`/`.mkv` at several sizes, checksum-verified), the 2GB limit (413), and the file-extension allowlist (4xx). |
| `m2-resume.test.ts` | Resume after a dropped connection (checksum-matching), heartbeat/abandon endpoints, and cleanup of stale sessions. |
| `m3-network.test.ts` (§7) | Toxiproxy `latency` and `reset_peer` toxics on `backend_api`: uploads complete despite latency; a reset fails the in-flight resume but the server-side upload survives and resumes after the toxic is removed. An opt-in (`SLOW_SCENARIOS=1`) test confirms a heavily-throttled upload stays alive past `heartbeatTimeoutSeconds` via heartbeats (§7.4/§9.10). Runs serially (`maxWorkers: 1`) since it mutates shared proxy state. |
| `m5-progress.test.ts` | `GET /progress/stream` snapshot-on-connect, `success`/`abandoned` terminal events, and throttled progress through the proxy. |
| `m5-sse-resilience.test.ts` (§9.9/§9.11) | A fresh SSE connection re-syncs an in-progress upload via its snapshot; across an abort+resume cycle the stream shows `uploading` then a single final `success`. |
| `m7-files.test.ts` (§11) | `GET /files` metadata (`duration`/`resolution`/`codec`/`playable`) for a compatible and an incompatible fixture; `GET /files/:id/stream` Range support (`206`/`Content-Range` vs `200`/`Accept-Ranges`). |
| `m8-batch-manifest.test.ts` (§12.3-12.8, §12.12) | A 2-file batch's `batch_key`/`batch_position` rows and `GET /batches/:batchKey` ordering/status as one file completes and the other resumes. |
| `m8-session-continuity.test.ts` (§12.1/12.2) | `POST /batches/:batchKey/pong` bumps `last_seen`; a row with no pong is still cleaned up to `abandoned`. |
| `m8-integrity.test.ts` (§12.9-12.11) | `POST /uploads/:id/client-hash` with a correct hash yields `hashVerified: true`; a wrong hash yields `hashVerified: false` and `status: 'error'`, both over SSE and in the DB. |
| `m9-cancel.test.ts` (§13) | `DELETE /uploads/:id` and `DELETE /batches/:batchKey`: cancel marks rows `cancelled`, aborts the S3 multipart upload, broadcasts SSE, and is idempotent; batch cancel returns `204` promptly and leaves `success` rows untouched. |
| `m10-reconciliation.test.ts` (§14) | An object deleted out-of-band gets its row marked `missing` (with SSE event) after `POST /internal/reconcile/run`; an untouched object/row is unaffected; a non-`success` row is never touched; a second pass is idempotent. |

### End-to-end UI tests (Playwright)

Also requires the docker-compose stack to be running.

```sh
cd tests
npm install
npx playwright install chromium  # first time only
npm run test:e2e
```

| File | Covers |
| --- | --- |
| `upload.spec.ts` | Basic single-file upload through the UI to a "Upload complete" message. |
| `m2-resume.spec.ts` | Delays a PATCH long enough to click Pause, confirms the `paused` UI and Resume button, then resumes to completion. |
| `m5-progress.spec.ts` (§9.12) | A failing PATCH shows `error`/Retry; `POST /uploads/:id/abandon` during an upload shows `abandoned` via SSE with no user action. |
| `m6-batch.spec.ts` (§10) | Selecting 3 files shows one `uploading` and two `queued`, all reach `success`, the aggregate bar hits 100%, and each resulting object's checksum matches its source file. |
| `m7-playback.spec.ts` (§11) | An uploaded compatible file auto-appears in "Uploaded files" with a `Playable` badge and plays/seeks via `/files/:id/stream`; an incompatible file shows `Not playable` and no `<video>`. |
| `m8-resume.spec.ts` (§12.3-12.11) | Pausing, reloading, and re-selecting the same file resumes via the batch manifest's `uploadUrl` to `success`, with a `✓ verified` badge and a matching checksum. |
| `m9-cancel.spec.ts` (§13) | Per-file `×` (`Cancelling…`/`Cancelled`), dismissing a still-`queued` item, and "Cancel remaining" (with No/Yes confirmation) cancelling in-progress/queued items while leaving completed ones untouched. Runs serially (shares the throttled connection). |
| `m10-reconciliation.spec.ts` (§14.3) | Deleting an uploaded file's object directly from MinIO and running reconciliation removes it from "Uploaded files" and shows "File no longer available" in the player. |
