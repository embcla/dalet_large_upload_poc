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

  Known limitation at the time (addressed in M8, §12.3-12.8): pause/resume
  only worked within the same browser session/tab — a full page reload lost
  the in-memory upload handle and could not resume, even though the
  server-side upload remained valid until the cleanup job (or abandon beacon)
  removed it.
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
- **M6** — batch upload (§10): selecting multiple files queues them and
  uploads them sequentially, one `tus.Upload` at a time, via a new
  `UploadQueueService`/`UploadQueue` component (replacing the single-file
  `UploadForm`). Each file gets its own status badge — the existing
  `UploadStatus` set is extended with `queued` (not yet started) and
  `skipped` (user-dismissed after an error/abandon, excluded from the
  aggregate) — plus a per-file progress bar. An aggregate progress bar sums
  `bytesReceived`/`bytesTotal` across all non-`skipped` files, driven by the
  same M5 SSE channel. On a per-file `error` or `abandoned` status, the queue
  pauses and offers Retry (resumes the same `tus.Upload` from its last
  offset, §2/M2) or Skip (marks the file `skipped` and advances to the next
  queued file). The §2.11 heartbeat and abandon-beacon mechanisms are now
  per-file, generalizing the single-upload versions from M2.

  Known limitation at the time (addressed in M8, §12): queue state was
  in-memory only — a full page reload mid-batch lost the queue and required
  restarting the batch selection from scratch. M8 removes this limitation via
  the server-held batch manifest and cross-reload resume (§12.3-12.8).
- **M7** — uploaded files visualization & playback (§11): a two-column
  layout adds a right-hand "Uploaded files" panel (`app-files-list`) next to
  the M6 upload queue. On `onUploadFinish`, the backend runs `ffprobe`
  against the completed object (via a short-lived presigned MinIO URL) to
  extract duration/resolution/codec, and classifies the file as `playable`
  against a browser-compatible codec allowlist (§2.7): `.mp4` requires
  `h264`(+`aac`/no audio), `.webm` requires `vp8`/`vp9`/`av1`; `.mkv` is
  accepted for upload (§2.9) but never `playable` regardless of inner codec,
  since browsers don't render `video/x-matroska`. `GET /files` lists
  completed uploads with this metadata; `GET /files/:id/stream` proxies the
  MinIO object with HTTP Range support (`206`/`Content-Range`/
  `Accept-Ranges`) for `<video>` seeking. The files panel auto-refreshes via
  the existing M5 SSE channel (on each new `success` event) and shows a
  `<video>` player for `playable` files or a "Preview not available" message
  otherwise.

- **M8** — session continuity (§12), the final core milestone:
  - **Ping/pong (§12.1/12.2)**: the M5 SSE channel now also pushes a named
    `event: ping` every `PROGRESS_KEEPALIVE_MS` (default 20s, alongside the
    existing `: keepalive` comment). On each ping, the frontend `POST`s
    `/batches/:batchKey/pong` for the active queue item, which bumps
    `last_seen` for its in-progress row — replacing the M2 per-upload
    client heartbeat on the frontend (the backend's heartbeat/abandon
    endpoints remain functional for the M2 test suite).
  - **Batch manifest & cross-reload resume (§12.3-12.8)**: every file
    selection is sorted by `name|size|lastModified` and hashed (SHA-256) into
    a deterministic `batch_key`, sent as upload metadata
    (`batchKey`/`lastModified`/`batchPosition`, §12.12) and persisted on the
    `uploads` row by `onUploadCreate`. Re-selecting the same file(s) — even
    after a full page reload — fetches `GET /batches/:batchKey`: completed
    rows (`success`) are shown done immediately with no new `tus.Upload`;
    in-progress rows (`uploading`/`paused`) resume via `tus-js-client`'s
    `uploadUrl` option (HEAD + resume-PATCH from the reported offset, no
    creation POST); everything else starts fresh. This removes M6's
    "queue state is in-memory only" limitation.
  - **Post-completion integrity check (§12.9-12.11)**: after a file finishes
    uploading, the client computes its SHA-256 (via `SubtleCrypto`) and posts
    it to `POST /uploads/:id/client-hash`; independently, the server streams
    the object from MinIO and computes its own SHA-256
    (`computeServerHash`). Once both hashes are known, the server sets
    `hash_verified` (and, on a server hash, `status: 'error'` if mismatched)
    and broadcasts the result over SSE as `hashVerified` on the upload's
    `ProgressEvent`. The frontend shows a `✓ verified` badge next to
    `success` items when `hashVerified === true`, or a new terminal
    `corrupt` status ("Integrity check failed", with a Skip button) when
    `hashVerified === false`. Both hash computations are fire-and-forget and
    don't block queue progression.

- **M9** — cancellation (§13): a new `cancelled` status — permanent and
  user-initiated, distinct from the reversible `paused` and the
  server-detected `abandoned`.
  - **Per-file cancel (§13.1-13.6, 13.11, 13.12)**: every queue row gets an
    `×` cancel button (for any non-`success` status, including already
    `cancelled` rows reconstructed from the batch manifest). For a
    `queued`/already-`cancelled` row, it's removed from the queue locally
    with no network call. For `uploading`/`paused`/`error`/`abandoned`, the
    item's status flips immediately to a local-only `cancelling…` and
    `item.tusUpload.abort(true)` both aborts any in-flight request and sends
    the tus-protocol `DELETE /uploads/:id`. A new `router.delete
    ('/uploads/:id', ...)` (mounted ahead of the tus catch-all, so it
    intercepts this `DELETE` before `@tus/server`'s own `DeleteHandler`)
    aborts the S3 multipart upload (reusing M2's `abortUpload`, which now
    also tolerates `@tus/s3-store`'s mis-detected raw-AWS-SDK
    `NoSuchKey`/`NoSuchUpload`/`NotFound` errors — see `cleanup.ts`), marks
    the row `cancelled`, and broadcasts a `cancelled` event over the M5 SSE
    channel, which flips the frontend's `cancelling…` to a terminal
    `Cancelled` (styled distinctly from `Abandoned`). The endpoint is
    idempotent: a second `DELETE` (or one for an unknown id, or a
    `success` row) is a no-op `204`. To prevent a late in-flight chunk's
    `uploading` progress event from reverting `Cancelled` back to
    `cancelling…`, `tus.ts`'s `POST_RECEIVE`/`POST_RECEIVE_V2` handlers now
    suppress further progress for any upload already marked `cancelled`.
  - **Batch cancel (§13.7-13.10)**: a "Cancel remaining" button (shown
    whenever any item is `queued`/`uploading`/`paused`/`error`/`abandoned`)
    reveals an inline "Cancel remaining uploads? This cannot be undone."
    confirmation with `Yes, cancel`/`No`. Confirming drops all `queued`
    items immediately, aborts the active item's in-flight `tusUpload`, sets
    every remaining non-terminal item to `cancelling…`, and issues one
    `DELETE /batches/:batchKey` per distinct `batchKey` among them. That new
    `router.delete('/batches/:batchKey', ...)` route returns `204`
    immediately, then processes each non-`success`/non-`cancelled` row in
    the batch sequentially (`abortUpload` + `markUploadStatus('cancelled')`
    + SSE `cancelled` broadcast) — already-`success` rows are left untouched.
  - A `process.on('unhandledRejection'/'uncaughtException')` guard was added
    in `backend/src/index.ts`: a `DELETE` racing a concurrent in-flight
    `PATCH`'s S3 part upload on the same MinIO multipart upload can surface
    as a detached promise rejection deep in `@tus/s3-store`'s AWS-SDK
    streaming internals; this keeps the process alive (the affected request
    simply surfaces as an upload error to that one client) instead of
    crashing every other upload in flight.

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
  fixtures/         M7 test video fixtures (compatible.mp4, incompatible.mkv)
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

`upload-queue.service.spec.ts` covers the M6 batch-queue state machine and
the M8 (§12) additions: a `success` row in the batch manifest reconstructs an
item as already-done with no new `tus.Upload`; an `uploading`/`paused` row
resumes via `uploadUrl`, seeding `bytesUploaded` from the manifest's
`bytesReceived`; fresh uploads carry `batchKey`/`lastModified`/
`batchPosition` metadata; an SSE `ping` triggers a `pong` POST for the active
item's batch; `onSuccess` posts a client SHA-256 hash without delaying
`processNext()`; and `displayStatus`/`isVerified` reflect `hashVerified`
(`corrupt` / `✓ verified`).

Sequential processing of all files to `success` (aggregate progress reaches
100%), a mid-queue `error` pausing the queue (remaining files stay `queued`,
aggregate stalls), Retry resuming the same `tus.Upload` instance, and Skip
marking a file `skipped` and advancing the queue (excluded from the aggregate
denominator), plus the ported validation/pause/resume/heartbeat/abandon-beacon/
`displayStatus` coverage from the old `upload-form.spec.ts`, now per-file.

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

`m7-files.test.ts` (§11) uploads the `tests/fixtures/compatible.mp4` and
`incompatible.mkv` fixtures and asserts the post-upload `ffprobe` metadata
exposed via `GET /files`: the compatible file reports `duration≈2`,
`resolution: "320x240"`, a `codec` containing `h264`/`aac`, and
`playable: true`; the incompatible file reports a `codec` containing
`mpeg2video` and `playable: false`. It also checks `GET /files/:id/stream`:
a `Range: bytes=0-1023` request returns `206` with
`Content-Range: bytes 0-1023/<size>` and a 1024-byte body, while a plain
request returns `200` with `Accept-Ranges: bytes` and the full
`Content-Length`.

`m8-batch-manifest.test.ts` (§12.3-12.8, §12.12) uploads a 2-file batch
sharing a `batch_key`: one file to completion (`batch_position: 0`), the
other aborted partway (`batch_position: 1`). Asserts both DB rows have
`batch_key`/`last_modified`/`batch_position` populated, and that
`GET /batches/:batchKey` returns both entries ordered by `batchPosition` —
the first `success`, the second `uploading` with `bytesReceived` matching the
abort offset. Resuming the second file to completion then shows it `success`
with `bytesReceived === size` in the manifest. A third position (never
created) is absent from the manifest, and an unknown `batchKey` returns `[]`.

`m8-session-continuity.test.ts` (§12.1/12.2) covers the pong endpoint:
`POST /batches/:batchKey/pong` bumps `last_seen` for the batch's active
`uploading`/`paused` row (and is a no-op for an unknown batch key), and a row
with a stale `last_seen` and no pong is still cleaned up to `abandoned` by the
existing `POST /internal/cleanup/run` job (same mechanism as M2, new trigger
path).

`m8-integrity.test.ts` (§12.9-12.11) uploads a fixture, waits for its SSE
`success` event, then `POST /uploads/:id/client-hash`es the file's real
SHA-256 — asserting an SSE event with `hashVerified: true` arrives and the DB
row has matching `client_file_hash`/`server_file_hash`. A second upload posts
a deliberately wrong hash and asserts `hashVerified: false`, `status: 'error'`
over SSE and in the DB.

`m9-cancel.test.ts` (§13) covers `DELETE /uploads/:id` and `DELETE
/batches/:batchKey`: cancelling an in-progress upload marks its row
`cancelled`, aborts its S3 multipart upload, and broadcasts a `cancelled` SSE
event; cancelling an already-`abandoned` upload whose object is already gone
is a no-op `204` with no throw; a second `DELETE` on an already-`cancelled`
row is idempotent (`204`, no extra SSE event); `DELETE` on an unknown id is
also a no-op `204`. The batch endpoint returns `204` promptly (asserted via
wall-clock time) and then cancels each non-`success` row in the batch one at
a time (SSE `cancelled` event observed for the in-progress row), leaving an
already-`success` row in the same batch untouched; an unknown/empty batch key
is a no-op `204`.

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

`m6-batch.spec.ts` (§10) selects 3×10MB files at once: asserts 3
`.queue-item` rows render, the first is `uploading` while the other two show
`queued` ("Waiting…"), all three reach `success` ("Upload complete"), and the
aggregate progress bar reaches 100%. It then captures each upload's id from
the `Location` header of its `POST /uploads` response and confirms the
resulting MinIO objects' checksums match the source files.

`m7-playback.spec.ts` (§11) uploads `compatible.mp4` via the M6 queue UI and,
without reloading the page, confirms it auto-appears in the right-hand
"Uploaded files" list (SSE-driven `GET /files` refresh) with a `Playable`
badge; clicking the row shows a `<video>` element whose `src` points at
`/files/:id/stream`, and exercises `play()` and seeking (`currentTime`) to
validate Range support end-to-end. It then uploads `incompatible.mkv` and
confirms its row shows a `Not playable` badge and, once selected, a "preview
not available" message with no `<video>` element rendered.

`m8-resume.spec.ts` (§12.3-12.11) selects a large file, waits for visible
upload progress, clicks Pause, then reloads the page and re-selects the same
file. The frontend computes the same `batch_key`, fetches the manifest, and
resumes the item via `uploadUrl` — the progress bar starts at/above the
byte count captured before reload, then reaches `success` ("Upload
complete"). A `✓ verified` badge then appears once the client/server
integrity hashes reconcile, and the final object checksum matches the source
file.

`m9-cancel.spec.ts` (§13) covers the cancel UI end-to-end (run serially: all
three tests share the toxiproxy-throttled connection). It selects a file,
waits for visible progress, clicks the row's `×`, and confirms the
`Cancelling…`/`Cancelled` transition. It then selects 3 files and clicks `×`
on the still-`queued` third one, confirming it's dropped from the list
immediately with the other two unaffected. Finally it selects 3 files
(one small enough to complete immediately), clicks "Cancel remaining",
confirms "No" dismisses the confirmation with no effect, then "Yes, cancel"
drops the queued item, cancels the in-progress item
(`Cancelling…`/`Cancelled`), and leaves the already-completed item's "Upload
complete" untouched.
