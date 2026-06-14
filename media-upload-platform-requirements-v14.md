# Media Upload & Management Platform — Refined Project Definition

## 0. Overall Assessment

The brief is a solid, incrementally-staged spec — the milestone structure (each one a superset of the last) is good practice and keeps the project demoable at every stage. However, there's one architectural decision that needs to be made **before Milestone 1 starts**, several cross-cutting issues that aren't addressed anywhere, and a handful of phrases in M3/M4 that are open to multiple interpretations with very different implementation costs. This document works through all of that and proposes a concrete tech stack, a new "Milestone 0" for infrastructure, and refined per-milestone requirements.

---

## 1. Critical Issue: Resumability Must Be Architected From Milestone 1

**The problem:** M1 asks for "basic simple single large file upload... with S3 storage", and resumability is introduced only in M2. If M1 is built as a naive `multipart/form-data` POST to Express (the "simple" approach), adding resume in M2 means **replacing the entire upload mechanism**, not extending it. That's wasted work and risks destabilizing M1's tests.

**Recommendation:** Build M1 on a resumable-upload protocol from day one, even though the *resume button* doesn't appear until M2. The de-facto standard here is **tus** (open protocol, chunked PATCH-based uploads over HTTP, widely supported):

- Backend: `@tus/server` with `@tus/s3-store` (writes directly to S3-compatible storage via multipart upload)
- Frontend: `tus-js-client` (framework-agnostic; wrap in a small Angular service)

This means M1 *already* has chunked uploads, offset tracking, and resumable transfer under the hood — M2 then just adds UI (pause/resume buttons, status badges) and leverages tus's `getProgress()`/`abort()`/`start()` API that's already there. Nothing built in M1 gets thrown away.

---

## 2. Cross-Cutting Issues & Unclear Objectives

| # | Topic | Issue | Recommendation |
|---|---|---|---|
| 2.1 | **S3-compatible storage choice — CONFIRMED** | "Docker images that replicate S3" is correct but unnamed | Use **MinIO** (`minio/minio` image). It's the industry-standard self-hosted S3-compatible store, has an admin console, and `@tus/s3-store` + AWS SDK work against it natively with just an endpoint override. |
| 2.2 | **Metadata persistence — RESOLVED** | M7 needs to list "uploaded files" and show video metadata (codec, duration). S3/MinIO object listing alone is slow and carries no application-level metadata. | Use **SQLite** (file-based, fits cleanly into the `backend` container/volume, no extra service in docker-compose). `uploads` table row is created **at upload-start (M1)**, not just on completion — columns: id (= tus upload ID), filename, size, mime type, status (`uploading`/`paused`/`success`/`error`/`abandoned`), storage key, `last_seen` (for §2.11 cleanup — added via migration in M4 (§8), which also fixes a gap in M0's initial migration list that omitted it despite M1 populating it from the start), `bytes_received` (added via migration in M4 (§8) for M5's SSE snapshot), and codec/resolution/duration (populated post-upload via `ffprobe`, M7). |
| 2.3 | **Test file strategy — RESOLVED** | A single approach can't cover both "large arbitrary-content files" (M1, M2, M3, M5, M6) and "small files with real, probeable video codecs" (M7). | **M1, M2, M3, M5, M6**: synthetic files generated **on the fly** at test-run time (`fallocate`/`dd`/Node script) for 100MB/200MB/1000MB/2000MB/2100MB — content doesn't matter, only size, since these tests validate transfer/resume/throughput mechanics, not codec handling. Generated into a tmp location, deleted after the run. (**M4** is schema-only — a migration with small regression checks, no large test files of its own.) **M7 onward**: requires a **different approach** — small (few-second) *real* video files with actual codec streams that `ffprobe` can inspect, since random bytes aren't valid video. These are small enough (a few MB) to be **committed as fixtures** in `tests/fixtures/` rather than generated. |
| 2.4 | **"Automated dropped packets test" (M2) — RESOLVED** | Not trivial — you can't easily simulate a dropped TCP connection from a normal HTTP test. | **Simple custom harness** (no Toxiproxy, per stakeholder preference for simplicity): a small Node test utility that starts an upload, destroys the underlying socket/aborts the request mid-stream at a known byte offset, then re-initiates the tus upload against the same upload URL to resume. Lives in `tests/integration/`. |
| 2.5 | **Batch error behavior (M6)** — **RESOLVED** | M6 processes the batch **sequentially, one file at a time**. If a file errors, the batch pauses and offers retry/skip for that file before continuing to the next. | Implement queue as a sequential pipeline (not parallel). Parallel/independent-file processing is explicitly deferred to a future milestone — design the queue manager so it *could* be extended to parallel later (e.g., keep per-file state isolated), but don't build concurrency now. |
| 2.6 | **Upload concurrency (M6)** — **RESOLVED** | Sequential, one file at a time (per 2.5). | No concurrency cap needed for M6. Note for future milestone: introducing parallelism later. |
| 2.7 | **"Codecs mismatch and video file identification" (M7)** — **RESOLVED** | Detect-and-fallback only, **no transcoding**. | Use `ffprobe` to detect codec on upload-complete, compare against a browser-compatible allowlist (e.g., H.264+AAC in MP4, VP8/VP9/AV1 in WebM), and show a "format not supported for preview" placeholder if it doesn't match. Transcoding pipeline is out of scope entirely (not just deferred). |
| 2.8 | **Streaming/seeking support (M7)** | "Retrieve API so uploaded files can be streamed back" — for `<video>` seeking to work, the retrieve endpoint **must** support HTTP `Range` requests (206 Partial Content), proxying ranged `GetObject` calls to MinIO. Not explicitly stated but functionally required. | Add explicitly as a requirement in M7. |
| 2.9 | **File type scope (M7) — RESOLVED** | Platform is **video-only**. | All uploads must be video files, enforced via an **allowlist** of accepted file types — **MKV and MP4 for now** (extensible later). Enforced at upload time in M1 (see M1 Backend/Frontend), not deferred to M7. M7's "uploaded files" list and player can assume every entry is a video. |
| 2.10 | **Auth / multi-user — CONFIRMED** | Not mentioned at all. | **Confirmed: simple PoC, no multi-user, no login, no access control anywhere.** "Uploaded files" list is global/single-tenant; the retrieve/stream API is unauthenticated. Multi-user management was considered and explicitly descoped as unnecessary over-engineering for this exercise. |
| 2.11 | **Abandoned upload cleanup — TWO-PHASE DESIGN** | How does the backend detect that a client has left, and clean up stale server-side resources? | **Currently implemented (M2, committed):** **(1)** each upload session gets a row in `uploads` with a `last_seen` timestamp (present since M0); **(2)** while active or paused, the frontend sends `POST /uploads/:id/heartbeat` every ~20s, updating `last_seen`; **(3)** on `beforeunload`/`pagehide`, `navigator.sendBeacon()` fires `POST /uploads/:id/abandon`, immediately marking the session for cleanup; **(4)** a backend interval job (every 60s) finds non-terminal sessions where `now - last_seen > 90s`, aborts the MinIO multipart upload, and marks the row `abandoned`; **(5)** the M0 MinIO bucket lifecycle rule remains the final backstop. **Superseded in M8 (§12):** the client-initiated heartbeat (2) and `sendBeacon`-abandon (3) are replaced by a **server-initiated SSE ping/pong** — the server pushes a `ping` event over the existing M5 SSE channel every ~20s; the client responds via `POST /batches/:batchKey/pong` (a small HTTP companion endpoint, since SSE is server→client only), which updates `last_seen` for the currently-active upload in that batch. A failed SSE write detects a dead connection immediately rather than waiting up to 90s. The 90s staleness timeout and cleanup job (4) are unchanged; `sendBeacon` is dropped entirely. The MinIO lifecycle backstop (5) remains throughout. |
| 2.12 | **Client-side resume persistence — REVISED: in scope (M8)** | Does resumability need to survive a full page reload? | **Yes — implemented in M8 (§12).** Cross-reload resume is in scope. The M4 schema migration (§8) already reserves the necessary columns (`batch_key`, `last_modified`, `batch_position`, plus the hash columns). **Currently (M0–M5 implemented):** a full page reload loses the in-memory upload reference — this is a temporary limitation pending M8, not a deliberate final design. **M8 design:** `tus-js-client`'s built-in `urlStorage` (localStorage) persists a `fingerprint → uploadId` mapping keyed on `(filename, size, lastModified)`. After a reload the user re-selects the same file(s) — the browser cannot persist a file handle across reloads, so re-selection is required — and `findPreviousUploads()` / `resumeFromPreviousUpload()` continues from the last server-confirmed offset. The **SSE snapshot-on-connect** (§9.6, M5) serves as the reconciliation step: the client cross-references the stored `uploadId` against the snapshot to decide resume (status `uploading`/`paused`, offset present) vs. discard-and-restart (status `abandoned`, absent from snapshot — server cleaned it up during the gap). For batches, a **server-held manifest** keyed by a deterministic `batch_key` (hash of sorted `(filename, size, lastModified)` tuples) covers the completed-file gap that the snapshot alone cannot (the snapshot only carries non-terminal uploads) — re-selecting the same files reconstructs the full batch state including already-`success` rows. |
| 2.13 | **Server-side size enforcement — CONFIRMED** | "Gracefully refuse if file > 2GB" — client-side checks can be bypassed (devtools, curl). | **Confirmed**: enforce in both places. Client-side pre-check (instant UX feedback) **and** `@tus/server`'s `maxSize` option (actual security boundary) — any upload exceeding 2GB is force-failed server-side regardless of client behavior. |
| 2.14 | **Docker image split — CONFIRMED** | "One or more, to be defined" — needs an actual answer to plan Milestone 0. | **Confirmed: docker-compose**, with images per §3 (Repository Structure). |
| 2.15 | **Client-facing network simulation (Toxiproxy) — REPOSITIONED** | Stakeholder wants to test "different scenarios, especially speed" — and on reflection, the connection that a real end-user's network conditions actually affect is **browser↔backend**, not backend↔storage. Backend↔MinIO degradation is an internal-infrastructure concern, not something this PoC needs to simulate. | Add **Toxiproxy** as a TCP proxy sitting **between the browser and `backend`** (e.g., the browser connects to `localhost:3001`, which Toxiproxy forwards to `backend:3000`) — not between `backend` and `minio`. Always present in the default `docker-compose.yml`. The proxy is passthrough for anything beyond the baseline, but a **baseline dev-convenience `bandwidth` toxic** (configurable rate) is applied by default — even for normal dev/demo use — set generously enough to be unnoticeable; additional toxics (latency, `reset_peer`, tighter bandwidth limits) are added/removed at runtime via Toxiproxy's admin API (port 8474) by the scenario test suite in **M3** (§7) for specific tests. **Backend↔MinIO is explicitly out of scope for network-condition simulation** — noted as a deliberate PoC limitation, in the same spirit as §2.12's reload limitation. |

---

## 3. Repository Structure & Build/Docker Pipeline (New)

Per stakeholder direction: each component gets fully separated source, and the Docker build/orchestration layer is kept entirely separate from application source — no Dockerfiles scattered inside component folders.

```
repo-root/
├── frontend/                  # Angular application source only
│   ├── src/
│   └── ...
├── backend/                   # Node/Express + tus server + SQLite source only
│   ├── src/
│   └── ...
├── minio/                     # MinIO-related config (not application code)
│   ├── bucket-init/           # Script(s) to create bucket + lifecycle rule (§2.11) on first startup
│   └── policy.json             # Bucket access policy (single-tenant, PoC)
├── toxiproxy/                  # Toxiproxy config (not application code, §2.15/§7)
│   ├── toxiproxy.json           # Proxy definition: browser-facing port → backend:3000, with baseline bandwidth toxic
│   └── init.sh                  # Idempotent setup script creating the proxy + baseline toxic via the admin API on startup
├── tests/
│   ├── unit/                  # Per-component unit tests (or kept alongside source — see note below)
│   ├── integration/           # Backend integration tests, incl. dropped-connection harness (§2.4) and Toxiproxy scenario helpers (§7), which add/remove additional toxics on the same browser-facing proxy
│   ├── e2e/                   # Playwright E2E specs driving frontend + backend together
│   ├── fixtures/              # Small real video files for M7 (§2.3) — committed, few MB total
│   └── generators/            # Scripts that generate large synthetic test files on the fly (§2.3)
├── docker-images/              # All Dockerfiles live here, one subfolder per image
│   ├── frontend/Dockerfile     # Multi-stage: build Angular, serve via nginx
│   ├── backend/Dockerfile      # Node + ffmpeg/ffprobe installed
│   └── minio-init/Dockerfile   # (if a custom init image is needed beyond mc commands)
├── build/                      # Build orchestration only — no source, no Dockerfiles
│   ├── build-frontend.sh       # Builds the frontend image using docker-images/frontend
│   ├── build-backend.sh        # Builds the backend image using docker-images/backend
│   └── build-all.sh            # Convenience wrapper
├── docker-compose.yml          # References docker-images/*/Dockerfile as build contexts
└── README.md
```

**Notes:**
- `docker-compose.yml` services point `build.context` at the relevant component folder (`./frontend`, `./backend`) and `build.dockerfile` at the corresponding file under `docker-images/` — this keeps Dockerfiles out of source trees while still using the source as build context.
- Unit tests can either live under `tests/unit/<component>/` or colocated with source (`frontend/src/**/*.spec.ts` is idiomatic Angular) — recommend colocating unit tests with source per framework convention, and reserving the top-level `tests/` folder for integration, E2E, fixtures, and generators (cross-component concerns that don't belong to a single source tree).
- `minio/` holds only configuration/init scripts (bucket creation, lifecycle policy per §2.11), not the MinIO binary/image itself (that's the off-the-shelf `minio/minio` image referenced directly in `docker-compose.yml`).

---

## 4. Proposed Milestone 0: Infrastructure & Scaffolding (New)

Not in the original brief, but recommended as a short pre-step so M1 isn't blocked on environment setup.

**Deliverables:**
- Repository scaffolded per §3 structure: `frontend/`, `backend/`, `minio/`, `toxiproxy/`, `tests/`, `docker-images/`, `build/`, root `docker-compose.yml`
- `docker-compose.yml` defining: `frontend` (Angular, nginx), `backend` (Node/Express + SQLite), `minio` (S3-compatible storage + console on a separate port), `toxiproxy` (always present, §2.15), with a shared Docker network
- MinIO bucket auto-created on startup via `minio/bucket-init/` script (sidecar `mc` container or init container), including the **lifecycle rule to auto-abort incomplete multipart uploads** (§2.11)
- **Toxiproxy proxy + baseline bandwidth toxic created on startup** (§2.15) via `toxiproxy/init.sh` (idempotent, using `toxiproxy/toxiproxy.json`): a proxy listening on a host-exposed port (e.g. `3001`) forwarding to `backend:3000`, with a generous baseline `bandwidth` toxic already applied
- Backend skeleton: Express app, health-check endpoint, environment-based config (bucket name, `MINIO_ENDPOINT` pointing **directly at `minio:9000`** — Toxiproxy is not involved in backend↔MinIO traffic, per §2.15 — credentials, max file size constant)
- Frontend skeleton: Angular app shell, basic routing, environment config pointing the backend API base URL at **the Toxiproxy-exposed port** (not directly at `backend`'s port)
- SQLite wired up in the backend container/volume, with a minimal migration for an `uploads` table (id, filename, size, mime_type, status, storage_key, created_at, updated_at)
- Test runner setup: Jest for backend, Karma/Jasmine (default Angular) or Jest for frontend unit tests, Playwright for E2E
- `build/` scripts that build each image from `docker-images/*/Dockerfile` using the matching component folder as context
- `README.md` documenting repo layout, `docker-compose up`, ports, and how to run each test suite

### Acceptance Criteria
- [ ] Repository matches the §3 structure (`frontend/`, `backend/`, `minio/`, `toxiproxy/`, `tests/`, `docker-images/`, `build/`, `docker-compose.yml`)
- [ ] `docker-compose up` builds (via `docker-images/*` Dockerfiles) and starts `frontend`, `backend`, `minio`, and `toxiproxy` successfully
- [ ] Frontend is reachable in a browser and renders the Angular app shell
- [ ] Backend health-check endpoint returns `200`
- [ ] Backend writes/reads a test object to/from MinIO **directly** (`MINIO_ENDPOINT` → `minio:9000`, no Toxiproxy involved, per §2.15)
- [ ] Frontend's API calls reach the backend **via the Toxiproxy proxy** (browser → Toxiproxy-exposed port → `backend:3000`); with the baseline bandwidth toxic at its default generous rate, this is functionally unnoticeable in normal dev/demo use
- [ ] SQLite `uploads` table exists after first startup (migration applied)
- [ ] MinIO bucket lifecycle rule for aborting incomplete multipart uploads is configured and visible in the MinIO console (§2.11)
- [ ] One placeholder passing test exists in each of: backend unit tests, frontend unit tests, E2E tests

---

## 5. Milestone 1 — Single Large File Upload (Refined)

**Scope:** everything in original M1, built on tus + S3 store per §1.

**Accepted file types (allowlist, §2.9):** `.mp4` (video/mp4), `.mkv` (video/x-matroska). Defined once on the backend as the source of truth; the frontend fetches this list at startup rather than duplicating it.

### Backend (Node/Express)
- `GET /config`: returns `{ maxFileSizeBytes: 2147483648, acceptedExtensions: ['.mp4', '.mkv'], acceptedMimeTypes: ['video/mp4', 'video/x-matroska'] }` — single source of truth consumed by the frontend for client-side checks
- Mount `@tus/server` with `@tus/s3-store`, pointed at MinIO
- Configure `maxSize` = 2GB (server-side enforcement; tus responds with `413` if exceeded)
- `onUploadCreate` hook: validate the incoming filename's extension (from `Upload-Metadata`) against `acceptedExtensions` (extension-based check is more reliable than MIME type, since browsers often report `''` or `application/octet-stream` for `.mkv`); reject with `4xx` and a clear error if not allowed — **this is the real enforcement boundary**
- On upload creation (same hook), insert a row into the `uploads` table (§2.2): `id` = tus upload ID, `filename`, `size`, `status = 'uploading'`, `storage_key`, `last_seen = now()`
- On upload completion, update the row: `status = 'success'`
- CORS configured to allow the Angular dev server origin

### Frontend (Angular)
- On app init, fetch `GET /config` and cache the result (extensions, MIME types, max size)
- File selection input (single file)
- Client-side validation, run **before** starting the upload:
  - if `file.size > maxFileSizeBytes`, show inline error and **do not** start upload
  - if the file's extension is not in `acceptedExtensions`, show inline error (e.g., "Only .mp4 and .mkv files are accepted") and **do not** start upload
- On valid selection, start tus upload via `tus-js-client`
- Progress bar bound to tus `onProgress(bytesUploaded, bytesTotal)`
- On `onSuccess`: show success state with checkmark icon/animation
- On `onError`: show error message, halt (no auto-retry yet — that's M2); if the error is a `4xx` from the `onUploadCreate` validation (e.g., a `.mkv`-disguised-as-`.mp4` edge case, or a bypassed client check), surface the server's rejection reason

### Test Requirements
- Generate test files at 100MB, 200MB, 1000MB, 2000MB, 2100MB on the fly via `tests/generators/` scripts (not committed to repo, per §2.3)
- Automated test matrix:
  - 100MB / 200MB / 1000MB / 2000MB, `.mp4` and `.mkv` extensions → upload succeeds, object exists in MinIO with correct size, UI shows checkmark, `uploads` row has `status = 'success'`
  - 2100MB → rejected client-side (no upload attempt) **and** rejected server-side if client check is bypassed (test by sending the request directly, bypassing the UI check)
  - Disallowed extension (e.g., `.avi` or `.txt`) → rejected client-side **and** rejected server-side (`onUploadCreate` returns `4xx`) if the client check is bypassed
- Cleanup step removes generated test files and uploaded MinIO objects after each run

### Acceptance Criteria
- [ ] `GET /config` returns max file size and accepted extensions/MIME types, and the frontend uses this response for its validation (no hardcoded duplication)
- [ ] User can select a single file via a file picker
- [ ] Files ≤ 2GB **and** with an accepted extension (`.mp4`/`.mkv`) upload successfully; the resulting object in MinIO has the correct size and matches the source file's checksum
- [ ] A file > 2GB (2.1GB test case) is rejected **client-side** before any upload request is sent
- [ ] A file with a disallowed extension is rejected **client-side** before any upload request is sent
- [ ] If the client-side checks are bypassed, the server rejects oversized files via `@tus/server`'s `maxSize`, and rejects disallowed extensions via the `onUploadCreate` hook (no object or completed multipart upload is created in either case)
- [ ] Progress bar updates live during upload, reflecting bytes uploaded vs. total bytes
- [ ] On successful completion, the UI shows a checkmark/success indicator, and the corresponding `uploads` row has `status = 'success'`
- [ ] On upload error, the UI shows an error message and halts (no auto-retry)
- [ ] Automated tests pass for 100MB / 200MB / 1000MB / 2000MB (success, both `.mp4` and `.mkv`), 2100MB (rejection at both layers), and a disallowed extension (rejection at both layers)
- [ ] `docker-compose up` brings up frontend + backend + MinIO, and the full M1 flow works end-to-end in a browser

---

## 6. Milestone 2 — Resume, Pause, and Status Visibility (Refined)

**Scope:** everything in M1, plus:

### Frontend
- Status model per file: `idle | uploading | paused | error | success`, each with a distinct visual indicator (icon + color, no aesthetic polish needed). (M5 — §9.12 — later amends this to surface `abandoned` as a user-visible state too, via the SSE channel.)
- Pause button → `tus.abort()` (keeps upload URL for resume, in-memory for the current page session — no persistence, per §2.12)
- Resume button → `tus.start()` against the existing upload URL (continues from last acknowledged offset)
- On error: show "Retry" action that calls resume logic
- **Heartbeat (§2.11):** while an upload session is `uploading` or `paused`, send `POST /uploads/:id/heartbeat` every ~20s
- **Abandon-on-unload (§2.11):** on `beforeunload`/`pagehide`, call `navigator.sendBeacon('/uploads/:id/abandon')` for any session not yet `success`
- **Known limitation (documented, by design per §2.12):** a full page reload mid-upload loses the in-memory upload reference and cannot resume — pause/resume/retry only work within the current page session. (The heartbeat/abandon mechanism above is independent of this — it cleans up *server-side* resources and does not enable resume-after-reload.)

### Backend
- `POST /uploads/:id/heartbeat`: updates `last_seen = now()` for the given upload row; no-op if the upload doesn't exist or is already `success`
- `POST /uploads/:id/abandon`: immediately marks the upload row `status = 'abandoned'` and triggers cleanup (abort the MinIO multipart upload for that session)
- **Cleanup interval job** (e.g., every 60s): finds rows where `status IN ('uploading', 'paused')` and `now() - last_seen > 90s`; for each, aborts the corresponding MinIO multipart upload and sets `status = 'abandoned'`
- M0's MinIO bucket lifecycle rule remains as the final backstop (§2.11)

### Test Requirements
- Existing M1 size-matrix tests still pass
- **Dropped-connection test** (§2.4): using the simple custom abort harness in `tests/integration/`, interrupt an in-progress upload of a large test file (e.g., 1000MB) at a known byte offset, then trigger resume against the same upload URL, and assert: (a) upload completes successfully, (b) final object size matches source file size, (c) checksum (e.g., SHA-256) of uploaded object matches source file
- Pause/resume cycle test: pause mid-upload, wait, resume, assert completion and checksum match
- **Heartbeat test**: start an upload, send heartbeats, assert `last_seen` updates in the `uploads` table
- **Abandon test**: start an upload, call `POST /uploads/:id/abandon`, assert the row becomes `status = 'abandoned'` and the MinIO multipart upload for that session is aborted (no longer listed via `ListMultipartUploads`)
- **Cleanup-job test**: start an upload, do not send heartbeats, advance time (or use a short test-only timeout configuration), run the cleanup job, and assert the stale `uploading` row transitions to `abandoned` and its multipart upload is aborted

### Acceptance Criteria
- [ ] Each file shows one of `idle | uploading | paused | error | success`, each visually distinguishable
- [ ] Pause stops the active upload without losing server-side progress (server retains bytes received so far)
- [ ] Resume continues from the last acknowledged byte offset, not from zero
- [ ] On error, the UI offers Retry, which resumes from the last offset
- [ ] Automated dropped-connection test (simulated mid-stream abort + resume) results in a complete object whose checksum matches the source file
- [ ] Pause/resume cycle test passes with matching checksums
- [ ] Heartbeat requests update `last_seen` on the corresponding `uploads` row
- [ ] `sendBeacon`-triggered `/abandon` call marks the session `abandoned` and aborts its MinIO multipart upload
- [ ] Cleanup job marks stale sessions (no heartbeat within the timeout) as `abandoned` and aborts their MinIO multipart uploads
- [ ] All M1 acceptance criteria continue to pass
- [ ] MinIO lifecycle rule from M0 remains configured as a backstop (no new dependency on it for the common cases, which are now handled by (1)-(4) above)

---

## 7. Milestone 3 — Client Network Resilience & Performance Testing (New)

**Scope:** no new application features. This milestone adds the Toxiproxy-based test infrastructure and a battery of scenario tests that exercise M1 (single upload) and M2 (resume/pause/heartbeat) under degraded **browser↔backend** network conditions — particularly speed/throughput, since that's the connection a real end-user's network actually affects. Subsequent milestones (M5 onward) continue to build on M2's feature set unaffected (§2.15).

### Design Decisions & Challenges

| # | Topic | Issue/Challenge | Recommendation |
|---|---|---|---|
| 7.1 | **Relationship to §2.4** | §2.4's custom harness and this milestone's Toxiproxy toxics now both operate on the **same connection** (browser↔backend) — is one redundant? | No — they're **complementary techniques for different failure modes on the same hop**. §2.4's custom harness does an **abrupt** socket abort mid-stream (simulating a sudden disconnect) and then resumes — a discrete event. Toxiproxy's toxics simulate **gradual degradation** — sustained low bandwidth, added latency, or a clean `reset_peer` — conditions that persist over the life of a request rather than a single abrupt cut. Both remain; both are valuable and test different things. |
| 7.2 | **Always-on Toxiproxy, with a baseline toxic** | Per stakeholder decision, Toxiproxy is always in the default `docker-compose.yml`, sitting between browser and backend. | A **baseline `bandwidth` toxic** (configurable, generous default rate) is present even during normal dev/demo use — this is a deliberate dev-convenience (e.g., to casually observe progress bars behaving realistically rather than instantaneously) and is harmless at its default rate. **Additional toxics** (tighter bandwidth limits, latency, `reset_peer`) are added/removed at runtime via Toxiproxy's admin API (port 8474) by this milestone's test suite, on top of the baseline, and removed again after each test (cleanup in `afterEach`). |
| 7.3 | **Test harness location** | Needs a home consistent with §3. | `tests/integration/toxiproxy/` — a small helper module wrapping the Toxiproxy admin API (add/remove/update toxics on the browser-facing proxy defined in `toxiproxy/toxiproxy.json`), used by the scenario tests below. |
| 7.4 | **Heartbeat/timeout interaction (the key "speed" scenario)** | The most valuable scenario: does §2.11's heartbeat/staleness mechanism (90s timeout) correctly distinguish "slow but progressing" from "abandoned"? | This now works exactly as intended, with no caveats: a `bandwidth` toxic on the browser↔backend connection genuinely slows the client's upload — the browser keeps streaming the same request, just at a lower rate, while continuing to send heartbeats normally and showing real (slow) progress on the progress bar. (Unlike the earlier backend↔MinIO positioning, there's no `@tus/s3-store` multipart-upload concurrency/buffering behavior to account for — the slow connection *is* the upload.) Assert the upload is **not** marked `abandoned` and completes successfully — this is the core validation this milestone exists to provide. |

### Test Requirements (all using `tests/generators/` synthetic files per §2.3, and the Toxiproxy admin API per 7.3)
- **Bandwidth throttle**: apply a `bandwidth` toxic (e.g., limit to 1MB/s) on the browser↔backend connection; upload a 1GB file; assert (a) the upload takes >90s and completes successfully, (b) the progress bar reflects real (slow) progress throughout, (c) the `uploads` row is **not** marked `abandoned` (validates 7.4)
- **Latency injection**: apply a `latency` toxic (e.g., +500ms, with jitter) on the browser↔backend connection; re-run the M1 size-matrix tests (100MB/200MB) and confirm they still pass, just slower — no premature timeouts anywhere in the stack
- **Connection reset mid-upload**: apply a `reset_peer` (or `timeout`) toxic on the browser↔backend connection partway through a large upload; assert the backend/frontend surfaces a clear error (M1's "stop on error"); then remove the toxic and confirm M2's resume completes the upload successfully
- **Toxic cleanup verification**: confirm each test removes its added toxics afterward (leaving only the baseline bandwidth toxic from 7.2), and that a subsequent run of the M1 size-matrix tests still passes (regression guard against leaked toxics affecting later test runs)

### Acceptance Criteria
- [ ] `toxiproxy` service is present in the default `docker-compose.yml`, sitting between the **browser and `backend`**; with only the baseline bandwidth toxic active, all M0–M2 functionality is unaffected
- [ ] `tests/integration/toxiproxy/` helper can add, update, and remove toxics on the browser-facing proxy via the Toxiproxy admin API
- [ ] Bandwidth-throttled upload (>90s duration) over the **browser↔backend** connection completes successfully and is **not** marked `abandoned` — heartbeat/staleness mechanism validated under realistic slow conditions
- [ ] Latency-injected M1 size-matrix tests (100MB/200MB) pass over the **browser↔backend** connection
- [ ] Connection-reset mid-upload (browser↔backend) produces a clear error, and M2 resume succeeds once the toxic is removed
- [ ] All test-added toxics are cleaned up after each test (baseline toxic remains); a subsequent run of M1's size-matrix tests passes afterward (no leakage between tests)

---

## 8. Milestone 4 — Schema & Session-State Foundations (New)

**Scope:** M0–M3 are already committed and are **not** retroactively edited by this milestone. This milestone is **schema-only** — a set of additive `uploads` table migrations and a small amount of regression testing, with **no new endpoints, no new UI, and no behavioral changes** to anything in M0–M3 (same "no new application features" framing as M3, but for the database rather than test infra). It exists to (a) correct a documentation gap in M0's migration list (`last_seen` was already present since M0), and (b) lay the schema groundwork that **M5 (SSE)** needs immediately and that **M8 (§12)** (cross-reload resume, batch manifest, ping/pong, integrity verification) builds on — so M8 doesn't also need to touch the schema of work that's already shipped.

All migrations here are purely **additive** (new nullable/defaulted columns on the existing `uploads` table) — no existing column is renamed, retyped, or dropped, so M0–M3's existing rows and code paths are unaffected.

### Design Decisions & Challenges

| # | Topic | Issue / Challenge | Recommendation |
|---|---|---|---|
| 8.1 | **Gap fix: `last_seen` missing from M0's initial migration** | M1's `onUploadCreate` hook (§5) sets `last_seen = now()` on every row from the very first upload, and M2's heartbeat/cleanup design (§2.11) depends on it — but M0's initial migration list (§4) never included this column. As written, M1 depends on a column M0 never creates. | **Resolved by M0's actual implementation:** the M4 git commit confirms `last_seen` was already present since M0 — the spec had a documentation gap, not an implementation gap. M4's migration correctly skips it (idempotent: add missing columns only). The SQL block below reflects this. |
| 8.2 | **`bytes_received` for M5's SSE snapshot** | M5's snapshot-on-connect (§9.6) needs to read "confirmed bytes received" per upload from `uploads` — tus tracks the offset internally (`@tus/server`/`@tus/s3-store`), not in SQLite. | **Migration**: add `bytes_received` (integer, default 0) to `uploads`. M5 updates it on `POST_RECEIVE` (throttled) and sets it to `bytes_total` on `POST_FINISH`, and reads it directly for the snapshot — see M5's §9.2/§9.6 for the consuming behavior. |
| 8.3 | **`batch_key` — for the cross-reload resume / batch-session milestone** | The resume milestone's design (server-held batch manifest, keyed by a deterministic hash of the selected files' `(filename, size, lastModified)` set) needs a place to record which files belong to the same batch. | **Migration**: add `batch_key` (text, nullable) to `uploads`. Populated and consumed by M8 (§12) at upload-creation time via tus metadata — M2's single-file flow becomes the batch-of-1 case. Not populated by M1–M6. |
| 8.4 | **`last_modified` / `batch_position` — for fingerprint matching & queue reconstruction** | M8 (§12) needs the client-reported file `lastModified` (part of the per-file fingerprint, alongside `filename`+`size`) and the file's position within its batch, to reconstruct queue order on reconnect. | **Migration**: add `last_modified` (integer, nullable — client file mtime) and `batch_position` (integer, nullable) to `uploads`. Populated and consumed by M8 (§12). Not populated by M1–M6. |
| 8.5 | **Hash-verification columns — for post-completion integrity checks** | File integrity is checked once after upload completion — whole-file hash, not per-chunk. The client reports a hash of the source file, the server independently hashes the completed MinIO object, and the two are compared. On mismatch the row is marked `corrupt`. | **Migration**: add `client_file_hash` (text, nullable), `server_file_hash` (text, nullable), and `hash_verified` (boolean, nullable) to `uploads`. Populated and consumed by M8 (§12): `hash_verified = false` sets `status = 'corrupt'`. Not populated by M1–M6. |

### Backend (Node/Express + SQLite)

- One additive migration against the existing `uploads` table (idempotent — skips columns that already exist, so safe to run against any M0–M3 database):
  ```sql
  ALTER TABLE uploads ADD COLUMN bytes_received INTEGER DEFAULT 0;
  ALTER TABLE uploads ADD COLUMN batch_key TEXT;
  ALTER TABLE uploads ADD COLUMN last_modified INTEGER;
  ALTER TABLE uploads ADD COLUMN batch_position INTEGER;
  ALTER TABLE uploads ADD COLUMN client_file_hash TEXT;
  ALTER TABLE uploads ADD COLUMN server_file_hash TEXT;
  ALTER TABLE uploads ADD COLUMN hash_verified BOOLEAN;
  ```
  (`last_seen` is intentionally absent — it was already present since M0's initial migration and is left as-is.)
- Migration runs automatically on backend startup and is idempotent/safe to run against a database already populated by M0–M3.
- No endpoint, event-emitter, or business-logic changes — `bytes_received` becomes available for M5 (SSE); `batch_key`, `last_modified`, `batch_position`, and the hash columns are consumed by M8 (§12).

### Test Requirements

- **Migration regression test**: start the backend against a database already containing rows created by M0–M3's existing code paths; assert the migration applies cleanly, all seven new columns exist with the expected types/defaults, and existing rows are unaffected (no data loss, no errors on pre-existing rows where the new columns are `NULL`/default). Assert `last_seen` is unchanged (already existed).
- **M1–M3 regression**: re-run M1's size-matrix tests and M2's heartbeat/abandon/cleanup tests (§6) — all continue to pass unchanged.
- **Column smoke test**: insert a row; confirm `bytes_received` defaults to `0`; confirm `batch_key`, `last_modified`, `batch_position`, `client_file_hash`, `server_file_hash`, `hash_verified` all accept `NULL`.

### Acceptance Criteria

- [ ] `uploads` table gains `bytes_received`, `batch_key`, `last_modified`, `batch_position`, `client_file_hash`, `server_file_hash`, and `hash_verified` columns via an additive migration; `last_seen` (already present since M0) is untouched
- [ ] Migration runs automatically on startup and is idempotent against a database already populated by M0–M3
- [ ] `bytes_received` defaults to `0`; the forward-looking columns (`batch_key`, `last_modified`, `batch_position`, `client_file_hash`, `server_file_hash`, `hash_verified`) accept `NULL` and are not populated by M1–M6 (consumed by M8, §12)
- [ ] All M1–M3 acceptance criteria continue to pass unchanged
- [ ] No endpoints, UI, or behavior change — this milestone is schema-only

---

## 9. Milestone 5 — Backend-Pushed Live Progress (SSE) (New)

**Scope:** everything in M2 (M3 — §7 — is a testing-only milestone and adds no application features, so feature dependencies build on M2 — same convention used for M6/Batch), plus a **server → client push channel** that reports *server-confirmed* upload progress and status. This is purely additive — it does **not** change the tus upload transport, the resume logic, or anything built in M1–M3. It exists to satisfy the requirement that progress be "updated automatically from the backend, with no manual refresh," and to make the **local-progress vs. server-confirmed-state** distinction explicit. M6 (Batch) builds its per-file and aggregate progress UI on this channel from the start, rather than wiring it client-side and reworking it later.

The channel is **read-only**: it carries progress and status events only. Control actions (pause / resume / cancel) stay as ordinary REST / tus-client calls — they do **not** go over this channel.

### Design Decisions & Challenges

| # | Topic | Issue / Challenge | Recommendation |
|---|---|---|---|
| 9.1 | **Transport: SSE vs WebSocket vs polling** | Progress is one-directional (server → client). WebSockets add full-duplex capability we don't need, plus manual reconnection and more infra sensitivity. | **Server-Sent Events (SSE)** via the browser-native `EventSource`. Plain HTTP, auto-reconnect built in, and a `Last-Event-ID` resume mechanism. WebSockets were considered and rejected as over-powered for a one-way feed; plain polling is the trivial fallback but loses the "pushed, no manual refresh" property. |
| 9.2 | **One stream vs one-per-upload** | M6 (Batch) means several uploads in flight at once. A stream per upload would mean many open connections (and bumps into the browser's ~6-connection HTTP/1.1 limit). | **One shared SSE stream per page session** (`GET /progress/stream`). Every event carries an `uploadId` so the frontend can route it to the right file. This scales cleanly to M6's batch with a single connection. |
| 9.3 | **How the backend learns of progress** | The backend must know how many bytes have actually landed, without polling storage. | tus already tracks the confirmed offset. `@tus/server` emits a **`POST_RECEIVE`** event as chunks arrive (with the current offset) — subscribe to it and push an event onto the SSE stream. Also push terminal events on **`POST_FINISH`** (success), on abandon/cleanup (abandoned, §2.11), and on error. |
| 9.4 | **Event flooding** | `POST_RECEIVE` can fire very frequently on a fast upload, flooding the stream. | **Throttle** emissions per upload — at most ~2–4 events/second (or every N bytes/percent). The client's smooth bar comes from local progress (9.5); the SSE channel only needs to be "live enough." |
| 9.5 | **Local vs. server-confirmed progress** | tus's client-side `onProgress` reports bytes *sent*; the SSE channel reports bytes the *server has confirmed*. They can diverge (in-flight bytes not yet acknowledged). | Keep showing the **optimistic local bar** from `onProgress` (instant, smooth), but treat the **SSE channel as the source of truth for status** — `success`, `error`, `paused`, `abandoned` come from the server, never inferred locally. |
| 9.6 | **Reconnect / page refresh** | On a dropped connection or refresh, the client must re-sync without gaps. | `EventSource` auto-reconnects. On every (re)connect, the server immediately sends a **snapshot** of current state for all non-terminal uploads (read from the `uploads` table, including the `bytes_received` column added in M4 (§8)), then resumes streaming. This makes reconnect and refresh self-healing with no special client code. |
| 9.7 | **Relationship to the §2.11 client heartbeat** | A "heartbeat" already exists — but that one is *client → server* (liveness, for abandoned-upload cleanup). | Different direction, different purpose. The §2.11 heartbeat is client → server liveness; **this** is server → client progress. They coexist and don't interact. |
| 9.8 | **Proxy / infrastructure gotchas** | Reverse proxies may buffer the stream (events arrive in bursts) or close idle connections. | Set `Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no` (forward-compatible with the §13 future nginx reverse proxy; Toxiproxy itself is a TCP proxy and doesn't buffer at the HTTP level). Send a keepalive comment line (`: keepalive\n\n`) every ~20s so intermediaries don't drop an idle connection. |
| 9.9 | **Relationship to M3 Toxiproxy (browser↔backend)** | Toxiproxy sits between **browser ↔ backend** (§2.15, §7) — the *same* hop the SSE stream runs over. So Toxiproxy **does** pass through (and can degrade) the SSE connection. | This *simplifies* testing: the SSE channel's resilience (latency, throttling, `reset_peer`) can be exercised with Toxiproxy directly, complemented by §2.4's abrupt-abort harness for the discrete sudden-disconnect case — the same complementary split §7.1 already draws. No separate-layer caveat needed. |
| 9.10 | **SSE as the observability layer for M3's scenarios** | M3's key test (7.4) must prove an upload is "slow but progressing," not "abandoned" — but progress was previously only visible client-side. | The SSE channel carries **server-confirmed** offsets, so it's the natural way to *verify* 7.4: under the browser↔backend `bandwidth` toxic, assert via SSE that confirmed progress keeps advancing and status stays `uploading`. SSE events are tiny, so they still get through under the throttle (and under §2.15's always-on baseline toxic). **Back-fill:** since this milestone lands after M3, extend M3's existing scenario suite to assert against the SSE channel. |
| 9.11 | **SSE during dropped-upload + resume, and connection reset** | When the upload is interrupted and resumed (M2 / §2.4 abort, or M3's `reset_peer` toxic), the feed must not report a false `success`/`error`; and a reset that also kills the SSE stream must recover. | The server-confirmed offset should **stall** during the interruption then **resume advancing** on reconnect — no spurious terminal event. If a `reset_peer` toxic resets the shared browser↔backend connection (killing both the upload and the SSE stream), assert the SSE stream auto-reconnects and re-syncs via the snapshot (9.6) alongside M2's resume. |
| 9.12 | **Status model amendment: `abandoned` becomes user-visible — NEW** | M2's frontend status model (`idle \| uploading \| paused \| error \| success`) never surfaced `abandoned` to the UI — it was a backend-only cleanup status for sessions the user had already left. The SSE channel now pushes `abandoned` events to **any** connected client (e.g., a second tab watching the same upload). | **Amend M2's status model** to add `abandoned` as a fifth user-visible state (small addition — one more icon/color). In the common case (the user who abandoned the upload has left), no one sees it; but if another tab/session is watching the same `uploadId`, it now correctly reflects that the session was cleaned up server-side rather than silently going stale. |

### Backend (Node/Express + tus)

- New endpoint **`GET /progress/stream`** with `Content-Type: text/event-stream`:
  - On connect, register the response in an in-memory set of subscribers, and **immediately send a snapshot** of every non-terminal `uploads` row (`uploadId`, `bytesReceived` = `bytes_received` column (added in M4 (§8)), `bytesTotal` = size, `status`).
  - Then stream subsequent events as they occur.
  - Send a `: keepalive` comment every ~20s.
  - On client disconnect (`req.on('close')`), remove the response from the subscriber set.
- The `bytes_received` column (added via migration in M4 (§8)) is updated on every `POST_RECEIVE` (same throttling as 9.4, so the column and the SSE emission stay in lockstep) and set to `bytes_total` on `POST_FINISH`.
- **In-process event emitter** wired to the tus server:
  - On `POST_RECEIVE` → throttled (per 9.4) `progress` event: `{ uploadId, bytesReceived, bytesTotal, status: 'uploading' }`, and the `bytes_received` column update.
  - On `POST_FINISH` → terminal event `{ uploadId, status: 'success', bytesReceived = bytesTotal }`.
  - On the cleanup/abandon path (from M2) → `{ uploadId, status: 'abandoned' }` (now user-visible per 9.12).
  - On error → `{ uploadId, status: 'error', message }`.
- Each SSE message uses an incrementing `id:` field so `Last-Event-ID` works on reconnect (the snapshot-on-connect in 9.6 is the primary resync mechanism; the id is a backstop).
- No auth on this endpoint for the PoC (multi-user is out of scope, §2.10).

### Frontend (Angular)

- On app init, open a single `EventSource('/progress/stream')` and keep it for the app's lifetime; close it on teardown.
- Maintain a map `uploadId → { bytesReceived, bytesTotal, status }` fed by SSE events — this is the **authoritative server state**.
- The per-file progress bar may display the optimistic local value from tus `onProgress`, but the **status badge** — now `idle | uploading | paused | error | success | abandoned` (per 9.12's amendment to M2's model) — is driven by the SSE map, not inferred locally.
- The success state (checkmark) fires when the **server** reports `success`, not when the local upload reports 100%.
- On `EventSource` error, rely on its built-in auto-reconnect; optionally show a subtle "reconnecting…" indicator. The on-connect snapshot re-syncs state automatically.

### Test Requirements

- **Progress emission (integration):** drive a tus upload; assert the SSE client receives `progress` events for the right `uploadId` with monotonically increasing `bytesReceived`, that emission rate is bounded (throttling per 9.4), and that the `uploads.bytes_received` column (added in M4 (§8)) tracks the same value.
- **Terminal events:** assert `success`, `error`, and `abandoned` events are each emitted on the corresponding backend path; assert `abandoned` is now visible in the frontend's status badge (9.12).
- **Snapshot-on-connect (the refresh/reconnect path):** start an upload, then open a *new* `EventSource` mid-upload and assert it immediately receives current state (including `bytesReceived` from the `bytes_received` column) for the in-flight upload — this is what makes refresh self-healing.
- **Reconnect resync:** kill the SSE connection mid-upload, allow auto-reconnect, and assert state is re-synced via the snapshot.
- **Local-vs-confirmed (E2E):** upload a large file; stub or spy on the local `onProgress` so the test proves the **backend-driven** channel is what advances status and triggers the success state.
- **SSE channel resilience (9.9):** drop the SSE request mid-upload (close the `EventSource`, or use the §2.4 abort harness against that request); assert the *upload* request — which is independent — is unaffected, and the SSE stream auto-reconnects and re-syncs via the snapshot.
- **Dropped-upload visibility (9.11):** during an M2 dropped-upload + resume (§2.4 harness on the upload request), assert the SSE-reported confirmed offset stalls during the interruption and resumes advancing on reconnect, with **no** false `success`/`error` event.
- **Connection-reset recovery (9.11):** when M3's `reset_peer` toxic resets the shared browser↔backend connection, assert the SSE stream auto-reconnects and re-syncs (snapshot) once the toxic is removed, alongside M2's resume.
- **M3 corroboration (9.10):** extend the existing browser↔backend bandwidth-throttle scenario (7.4) to assert via the SSE channel that confirmed progress keeps advancing and status stays `uploading` (not `abandoned`) under the slow connection.
- All M1–M3 acceptance criteria continue to pass (channel is additive).

### Acceptance Criteria

- [ ] `GET /progress/stream` serves a `text/event-stream` and stays open, sending a keepalive comment periodically
- [ ] On connect, the stream immediately sends a snapshot of all non-terminal uploads (id, bytesReceived, bytesTotal, status)
- [ ] During an upload, the backend pushes throttled `progress` events derived from tus `POST_RECEIVE` (no client polling involved)
- [ ] Terminal `success` / `error` / `abandoned` events are pushed on the corresponding backend paths
- [ ] The frontend updates per-file progress and status **automatically from these events, with no manual refresh**
- [ ] File status (`success`/`error`/`paused`/`abandoned`) is driven by the server channel, not inferred from local upload progress
- [ ] After a dropped SSE connection or a page refresh, the client auto-reconnects and re-syncs current upload state from the snapshot
- [ ] The §2.11 client→server liveness heartbeat and this server→client progress channel coexist without interfering
- [ ] Dropping the SSE request mid-upload does not affect the (independent) upload request, and the stream auto-reconnects and re-syncs (9.9)
- [ ] During an M2 dropped-upload + resume, the SSE-reported confirmed offset stalls then resumes, with no false terminal event (9.11)
- [ ] A `reset_peer` toxic that kills the shared browser↔backend connection is recovered: the SSE stream auto-reconnects and re-syncs once the toxic clears (9.11)
- [ ] The M3 browser↔backend bandwidth-throttle scenario (7.4) is verified via the SSE channel: confirmed progress keeps advancing and status stays `uploading`, not `abandoned` (9.10)
- [ ] The `bytes_received` column (added in M4 (§8)) is updated on `POST_RECEIVE` (throttled) and set to `bytes_total` on `POST_FINISH`; the snapshot-on-connect reads it directly
- [ ] M2's status model is amended to include `abandoned` as a user-visible state, surfaced via this SSE channel (9.12)
- [ ] All M1–M3 acceptance criteria continue to pass

---

## 10. Milestone 6 — Batch Upload (Refined)

**Scope:** everything in M2 and M5 (the SSE progress channel — §9 — which this milestone's progress UI builds on from the start), plus (M3 — §7 — is a testing-only milestone and adds no application features, so it doesn't change feature dependencies):

**Processing model:** sequential, one file at a time. The queue processes files in order; only one tus upload session is active at a time. If a file errors, the whole queue pauses on that file and offers **retry** (re-attempt the same file) or **skip** (move to the next file in the queue, leaving the failed file marked as skipped/error). Parallel/concurrent uploads are explicitly **out of scope** for this milestone — design the queue manager with per-file state isolated so it could be extended to parallel processing in a future milestone, but do not implement concurrency now.

### Frontend
- File input with `multiple` attribute (multi-select)
- Queue list UI: one row per file showing filename, size, per-file progress bar, and status badge (per M5/§9.12's amended model: `idle | uploading | paused | error | success | abandoned | skipped | queued`)
- **Per-file status badges and the aggregate progress bar are driven by the M5 SSE channel** (§9): aggregate progress = sum of `bytesReceived` / sum of `bytesTotal` across all `uploadId`s in the queue, including completed and pending ones. The per-file progress *bar* may still show the optimistic local `onProgress` value (per 9.5) for smoothness, but **status** is always SSE-driven.
- Only the currently-active file shows live progress; queued files show "waiting"
- On error for the active file: queue pauses, and the UI offers **Retry** (resume/restart that file) and **Skip** (mark as skipped, advance to next file)
- Pause/resume controls (from M2) apply to the currently-active file
- **Known limitation (temporary — addressed in M8, §12):** queue state is in-memory only — a full page reload mid-batch loses the queue and requires restarting the batch selection from scratch. M8 will remove this limitation via the server-held batch manifest and cross-reload resume (§2.12).

### Backend
- No new endpoints required — each file uses its own tus upload session sequentially; the existing M1/M2 tus endpoint handles this naturally since only one session is active at a time

### Test Requirements
- **Unit/integration tests for queue logic with mocked uploads**: replace the actual `tus-js-client` upload calls with a mock/stub that can simulate success, failure, and slow progress on a per-file basis, without performing real network I/O. For these mocked tests, also mock the SSE map (M5) so queue-orchestration logic can be tested independent of the real channel. Test scenarios:
  - All files succeed sequentially → aggregate progress reaches 100%, all statuses = success, files processed in order
  - One file fails mid-queue → queue pauses on that file, aggregate progress stalls, other files remain in "queued" state
  - Retry-after-failure resumes the failed file and continues to the next on success
  - Skip marks the failed file as skipped and advances the queue to the next file
- **E2E test** with a small batch of real small files (e.g., 3× 10MB) to validate the full sequential pipeline end-to-end (not mocked) — including verifying that per-file status badges and the aggregate progress bar are driven by the real M5 SSE channel, not just local `onProgress`

### Acceptance Criteria
- [ ] Multi-file selection works via the file picker (multi-select)
- [ ] Queue list shows one row per selected file with filename, size, status, and per-file progress
- [ ] Files are processed strictly sequentially — only one upload active at a time; queued files show "waiting"
- [ ] Aggregate progress bar reflects combined `bytesReceived`/`bytesTotal` from the M5 SSE channel across the whole batch
- [ ] On error for the active file, the queue pauses and the UI offers Retry and Skip
- [ ] Retry re-attempts the failed file (resuming from last offset per M2); on success the queue continues
- [ ] Skip marks the failed file as skipped and advances to the next file without uploading it
- [ ] All successfully completed files have corresponding objects in MinIO with matching size and content (integrity verification via hash is added in M8)
- [ ] Automated mocked-queue tests cover: full success, mid-queue failure + retry, mid-queue failure + skip
- [ ] E2E test with 3 small real files completes the full sequential pipeline successfully, with status/progress driven by the SSE channel
- [ ] All M2 and M5 acceptance criteria continue to pass for individual files within a batch

---

## 11. Milestone 7 — Uploaded Files Visualization & Playback (Refined)

**Scope:** everything in M6, plus:

**Platform scope confirmed: video-only.** All uploads are expected to be video files. Codec/format handling is **detection + fallback message only** — no transcoding.

### Frontend Layout
- Two-column layout: left = upload selection/queue (from M6), right = uploaded files list
- Both columns independently vertically scrollable (fixed-height container with `overflow-y: auto`)
- Video player element docked above the right-column list, initially empty/placeholder
- Clicking a file in the right-column list loads it into the player
- Empty state: if no files uploaded yet, right column shows a placeholder message (no player shown, or player disabled)
- **Auto-refresh on upload completion (new):** on receiving an SSE `success` event (M5, §9) for any `uploadId`, automatically refetch `GET /files` so the newly-completed file appears in the right-column list without manual refresh — this removes the previous "on refresh" caveat entirely, since the SSE channel now provides the trigger

### Backend
- **List endpoint** `GET /files`: returns metadata for all completed uploads from the DB (§2.2) — id, filename, size, status, duration, resolution, codec, and a `playable: boolean` flag
- **Post-upload processing hook**: on tus upload completion, run `ffprobe` against the object (stream from MinIO or probe before/while uploading to MinIO, depending on tus-store internals) to extract codec/duration/resolution, store in DB; classify `playable` against a browser-compatible codec allowlist (e.g., H.264+AAC in MP4, VP8/VP9/AV1 in WebM)
- **Retrieve/stream endpoint** `GET /files/:id/stream`: proxies a ranged `GetObject` request to MinIO, forwarding `Range` headers and returning `206 Partial Content` with appropriate `Content-Range`/`Accept-Ranges` headers — required for `<video>` seeking to work

### Player Behavior
- If selected file's `playable` flag is true → set `<video src>` to the stream endpoint, enable native play/pause controls
- If `playable` is false → show "preview not available for this format" message instead of attempting playback (file still appears in the list with its metadata)

### Test Requirements
- **Test fixtures (§2.3 — different approach from M1–M3/M5/M6):** small (few-second) *real* video files with actual codec streams, **committed** to `tests/fixtures/` — at least one browser-compatible (H.264/AAC MP4) and one non-compatible (e.g., MPEG-2 or ProRes) sample. These cannot be generated on the fly like the M1–M3/M5/M6 size-test files, since `ffprobe` needs genuine codec data.
- Tests cover: upload → SSE `success` event triggers auto-refresh → file appears in right-column list → metadata correctly probed and stored → compatible file loads into player and `src` resolves to a working stream URL → incompatible file shows "preview unavailable" → empty-list state renders correctly when no files exist
- Streaming endpoint test: request with `Range: bytes=0-1023` returns `206` with correct `Content-Range` and exactly 1024 bytes

### Acceptance Criteria
- [ ] Page renders two independently-scrollable columns: left = upload/queue (M6 UI), right = uploaded files list
- [ ] `GET /files` returns metadata (id, filename, size, status, duration, resolution, codec, `playable`) for all completed uploads
- [ ] After a successful upload, the file appears in the right-column list **automatically** (triggered by the M5 SSE `success` event — no manual refresh needed)
- [ ] For the browser-compatible fixture (H.264/AAC MP4), clicking it loads it into the player and play/pause works
- [ ] For the non-compatible fixture, clicking it shows "preview not available" instead of attempting playback
- [ ] `GET /files/:id/stream` supports `Range` requests, returning `206 Partial Content` with correct `Content-Range`/`Accept-Ranges` headers, and seeking works in the player for the compatible fixture
- [ ] Empty state: with no uploaded files, the right column shows a placeholder and the player is empty/disabled
- [ ] Automated tests validate probed metadata (codec/duration/resolution) against known values for both fixtures
- [ ] Streaming endpoint test confirms `Range: bytes=0-1023` returns exactly 1024 bytes with `206` status
- [ ] All M5 and M6 acceptance criteria continue to pass

---

## 12. Milestone 8 — Session Continuity: Cross-Reload Resume, Batch Manifest, Ping/Pong & Integrity (New)

**Scope:** everything in M7, plus four tightly-coupled features that together deliver the agreed session-continuity design. All four share the same M4 schema columns (already in production since M4's additive migration), use the M5 SSE channel (already in production), and build on M6's batch queue model. Splitting them across milestones would mean touching the same code paths twice; delivering them together closes the loop.

This milestone **supersedes** M2's client-initiated heartbeat (`POST /uploads/:id/heartbeat`) and `sendBeacon`-abandon — those mechanisms remain in place and are not removed until this milestone's tests pass and the new ping/pong is confirmed working.

### Design Decisions & Challenges

| # | Topic | Issue / Challenge | Recommendation |
|---|---|---|---|
| 12.1 | **SSE ping/pong — directionality** | The M5 SSE channel is server→client only. Liveness requires the server to detect a dead client, but the client can't write back over SSE. | Server pushes a `ping` SSE event every ~20s over the existing `GET /progress/stream` channel. Client responds via `POST /batches/:batchKey/pong` — a small plain-HTTP companion endpoint. Since M6's batch queue is sequential (one active upload at a time), the pong only needs to refresh `last_seen` for the currently-active row in that batch — no per-file fan-out. Single-file flow (batch-of-1) uses the same endpoint. |
| 12.2 | **Ping/pong vs. client-initiated heartbeat** | M2 implemented `POST /uploads/:id/heartbeat` (client drives cadence). Ping/pong inverts control: the server drives cadence. | Key advantage: a failed SSE write (e.g., broken connection) is detected by the server **immediately** at the push attempt, rather than waiting up to 90s for a missing heartbeat. The 90s staleness timeout and cleanup job (§2.11) are unchanged — they now apply to missing pongs instead of missing heartbeats. `sendBeacon`-abandon is removed from the frontend; the staleness timeout handles the "tab closed" case instead. |
| 12.3 | **Cross-reload resume — single file** | After a reload, the in-memory tus upload reference is lost. The browser cannot persist a file handle. | `tus-js-client`'s built-in `urlStorage` (localStorage) already persists `fingerprint → uploadUrl` keyed on `(filename, size, lastModified)`. On file re-selection after a reload, `findPreviousUploads()` matches the fingerprint; `resumeFromPreviousUpload()` continues from the last server-confirmed offset. Re-selection is required — this is a browser constraint, not a design choice. |
| 12.4 | **SSE snapshot as reconciliation** | localStorage may have a stale entry (the server cleaned up the session during the reload gap). The client needs to know whether to resume or restart before issuing any PATCH. | The M5 SSE snapshot-on-connect (§9.6) is the authoritative check: `uploadId` present with status `uploading`/`paused` → safe to `resumeFromPreviousUpload()`, and `bytesReceived` pre-populates the progress UI immediately. `uploadId` absent or status `abandoned` → server cleaned it up; discard the localStorage entry and start fresh. Status `error` → surface and offer retry rather than silently resuming. |
| 12.5 | **Batch manifest — why snapshot alone isn't enough** | The M5 snapshot only covers non-terminal uploads. A completed (`success`) file from earlier in the batch has no entry — the client can't tell "already done" from "never started." | **Server-held batch manifest**: each upload row already carries `batch_key` (M4). At batch-creation time, populate `batch_key` (deterministic SHA-256 of sorted `(filename, size, lastModified)` tuples — same files always produce the same key, no token to persist), `last_modified`, and `batch_position` for every file in the batch. A new `GET /batches/:batchKey` endpoint returns **all** rows for that key including `success` rows, giving the client the complete batch state in one shot. |
| 12.6 | **Batch manifest supersedes localStorage for batch flow** | With the manifest, the server tells the client directly which `uploadId` to resume for each file — `tus-js-client`'s localStorage matching becomes redundant for the batch case. | The manifest is authoritative for batch: client recomputes `batch_key` from the re-selected files, fetches the manifest, cross-references each file's fingerprint against manifest rows by `(filename, size, last_modified)` + `batch_position`, and calls `resumeFromPreviousUpload()` with the server-provided `uploadUrl`. For single-file (batch-of-1), both paths work; manifest is preferred if the batch endpoint is available. |
| 12.7 | **Queue reconstruction from manifest** | After a reload, the client needs to know which files are done, which to resume, and what order to process them in. | The manifest's `batch_position` column gives queue order. `status = 'success'` rows are shown as completed immediately (no re-upload). `status = 'uploading'/'paused'` rows are resumed. `status = 'abandoned'/'error'` rows are flagged for user decision (retry/skip). Rows absent from the manifest (files newly added after reload that weren't in the original batch) are queued as new uploads. |
| 12.8 | **Completed-file re-upload risk** | Without the manifest, a re-selected file whose tus localStorage entry was cleared on completion (tus-js-client clears on `POST_FINISH`) would be treated as a new upload. | Manifest eliminates this: `status = 'success'` row for that fingerprint → skip, show as done. No re-upload. |
| 12.9 | **Post-completion integrity — scope and timing** | Integrity check should be whole-file, not per-chunk. When should it run? | After `POST_FINISH` (tus signals upload complete and the object is fully written to MinIO). Client computes SHA-256 of the source file using Web Crypto `SubtleCrypto` (streaming `digest`, async, does not block the UI). Server independently reads the completed MinIO object stream and computes SHA-256 via Node `crypto`. Both hashes are stored in `client_file_hash` and `server_file_hash`; `hash_verified` records the comparison result. |
| 12.10 | **Hash mismatch handling** | If client and server hashes differ, what happens to the upload? | Set `status = 'corrupt'` and push an SSE `integrity` event with `hash_verified: false`. The file remains in MinIO (don't auto-delete — the mismatch itself is diagnostic data) but is not listed in `GET /files` as playable. The frontend shows the `corrupt` badge (distinct from `error`, which covers upload-transport failures). |
| 12.11 | **Timing: client hash computation** | `SubtleCrypto.digest()` on a 2GB file is non-trivial — can take several seconds even streaming. It should not block the queue from moving to the next file. | Compute the client hash **in parallel** with the server's hash computation (both triggered by `POST_FINISH`). The queue advances to the next file immediately; the hash result arrives asynchronously via an SSE event (`hash_verified` field on the terminal `success` event, or a follow-up `integrity` event). The success badge updates in place when the verification completes. |
| 12.12 | **`batch_key` population timing** | `batch_key` must be set at upload-creation time (M1's `onUploadCreate` hook), but M1–M6 don't populate it. | Extend the `onUploadCreate` hook: when a `batchKey` is provided in the upload metadata (tus allows arbitrary metadata in the `POST` request), write it plus `last_modified` and `batch_position` to the row. Uploads without a `batchKey` (single-file, no batch context) leave those columns `NULL` — backward compatible with all M1–M6 behavior. |

### Backend (Node/Express + tus)

- **SSE ping/pong:**
  - Extend `GET /progress/stream`: emit a `ping` SSE event every ~20s (alongside the existing keepalive comment) carrying `{ timestamp }`.
  - New endpoint `POST /batches/:batchKey/pong`: finds the currently-`uploading` row for that `batch_key`, updates `last_seen = now()`. Returns `204`. No-op if no active row found (idempotent).
  - Remove `POST /uploads/:id/heartbeat` endpoint (or deprecate — keep returning `200` but stop using it, to avoid breaking any M2 tests that call it directly).
- **`sendBeacon`-abandon:** remove `POST /uploads/:id/abandon` endpoint from active use (or deprecate alongside heartbeat). The frontend stops calling it; the 90s staleness cleanup job handles the "tab closed" case.
- **Batch manifest:**
  - Extend `onUploadCreate` (tus hook): if `batchKey` is present in upload metadata, write `batch_key`, `last_modified`, and `batch_position` to the `uploads` row. Since the frontend always computes and passes a `batch_key` (single-file uploads use a batch-of-1 key), this is populated for every upload from M8 onward.
  - New endpoint `GET /batches/:batchKey`: returns all `uploads` rows with that `batch_key` (all statuses, including `success`), ordered by `batch_position`. Fields: `id` (= uploadId), `filename`, `size`, `last_modified`, `batch_position`, `status`, `bytes_received`, `storage_key`.
- **Post-completion integrity:**
  - On `POST_FINISH` (tus hook): spawn async task to stream the completed MinIO object and compute SHA-256 via Node `crypto`. Store result in `server_file_hash`.
  - New endpoint `POST /uploads/:id/client-hash`: receives `{ hash: string }` from the frontend after client-side computation completes. Stores in `client_file_hash`. If `server_file_hash` is already present, compare immediately: set `hash_verified = (client === server)`, update `status = 'corrupt'` on mismatch, push SSE `integrity` event `{ uploadId, hash_verified, status }`.
  - If the server hash finishes first (fast MinIO read), wait for the client hash to arrive before resolving `hash_verified` — store `server_file_hash`, set `hash_verified = null` until both are present.

### Frontend (Angular)

- **Ping/pong:**
  - Remove `setInterval` heartbeat and `sendBeacon` on `beforeunload`/`pagehide`.
  - On receiving a `ping` SSE event: call `POST /batches/:batchKey/pong`. **For both batch and single-file uploads**, the frontend always computes and passes a `batch_key` in the tus upload metadata — single-file uploads use a batch-of-1 key (SHA-256 of the single-file `(filename, size, lastModified)` tuple), so the pong endpoint works identically regardless of batch size. Fire-and-forget; no UI change.
- **Cross-reload resume — single file:**
  - Before opening the file picker, call `tus.Upload.findPreviousUploads()`. On file selection, check for a fingerprint match. If found, cross-reference the upload ID against the SSE snapshot (in-memory map from `ProgressService`): resume if `uploading`/`paused`, discard and start fresh if `abandoned` or absent, offer retry if `error`.
- **Batch flow — manifest-driven:**
  - On batch file selection: compute `batch_key` (SHA-256 of sorted `(filename, size, lastModified)` tuples, using `SubtleCrypto`).
  - Fetch `GET /batches/:batchKey`. If manifest exists (non-empty): reconstruct queue from manifest rows (success → show as done, uploading/paused → queue for resume, abandoned/error → flag for user decision). If manifest is empty/404: all files are new, queue normally.
  - Pass `batchKey`, `last_modified`, and `batch_position` as tus upload metadata on each `POST` (so the server populates those columns at upload-creation time).
- **Post-completion integrity:**
  - After a file's `POST_FINISH` is signalled (local tus event or SSE `success` event): compute SHA-256 of the source `File` object via `SubtleCrypto.digest('SHA-256', ...)` (stream the file as `ArrayBuffer` chunks). Send result to `POST /uploads/:id/client-hash`.
  - On receiving SSE `integrity` event: update the file's status badge — `hash_verified: true` → add a "✓ verified" indicator to the success badge; `hash_verified: false` → show "integrity check failed" badge (distinct from plain `error`).
- **Status model:** add `corrupt` as a distinct terminal display state (alongside `idle | uploading | paused | error | success | abandoned`) — set when `hash_verified = false`. Visually distinct from `error` (which covers upload-transport failures) since `corrupt` means the transfer completed but the content didn't match.

### Test Requirements

- **Ping/pong (integration):** assert server emits `ping` events at ~20s intervals; assert `POST /batches/:batchKey/pong` updates `last_seen`; stop sending pongs and assert the cleanup job marks the session `abandoned` within ~90s (same staleness timeout, different trigger).
- **Heartbeat/sendBeacon removal:** assert the frontend no longer calls `POST /uploads/:id/heartbeat` or `sendBeacon` after this milestone; assert the deprecated endpoints still return `200`/`204` without side effects (backward compat for any tooling that hits them).
- **Single-file resume (integration):** start an upload, pause it, simulate a reload (close and reopen the `EventSource`; create a new tus client with the same fingerprint), re-select the same file, assert `findPreviousUploads()` returns a match, assert the SSE snapshot cross-reference resolves to `resume`, assert `resumeFromPreviousUpload()` continues from the last `bytes_received` offset — not from zero.
- **Stale entry discard:** start an upload, let the staleness timeout mark it `abandoned`, then simulate a reload with the same fingerprint; assert the SSE snapshot cross-reference resolves to `discard`, assert a fresh upload starts from zero, assert the old localStorage entry is cleared.
- **Batch manifest — reconstruction (integration):** start a 3-file batch, complete the first file, interrupt the second mid-upload, simulate a reload; re-select the same 3 files, fetch the manifest, assert: file 1 → `success` (not re-uploaded), file 2 → resumes from its offset, file 3 → queued as new. Assert `batch_key`, `last_modified`, and `batch_position` are populated on all three `uploads` rows.
- **Completed-file re-upload prevention:** reload after file 1 completes; assert `GET /batches/:batchKey` returns a `success` row for file 1; assert the frontend does not initiate a new tus upload for it.
- **Integrity — match (integration):** upload a small known file; compute its expected SHA-256 independently; assert `client_file_hash` and `server_file_hash` match the expected value; assert `hash_verified = true`; assert the SSE `integrity` event carries `hash_verified: true`.
- **Integrity — mismatch:** stub the server hash to return a wrong value; assert `hash_verified = false`, `status = 'corrupt'`, and the SSE `integrity` event carries `hash_verified: false`; assert the frontend shows the `corrupt` badge (distinct from plain `error`).
- **Hash non-blocking (E2E):** upload a batch of 2 files; assert the queue advances to file 2 immediately after file 1's `POST_FINISH`, without waiting for hash verification to complete; assert the `integrity` event for file 1 arrives asynchronously and updates the badge in place.
- All M1–M7 acceptance criteria continue to pass.

### Acceptance Criteria

- [ ] Server emits `ping` SSE events every ~20s; `POST /batches/:batchKey/pong` updates `last_seen` for the active upload in that batch
- [ ] Frontend no longer calls `POST /uploads/:id/heartbeat` or `navigator.sendBeacon` after this milestone
- [ ] A session with no pong responses within 90s is marked `abandoned` and its MinIO multipart upload aborted (same cleanup job, new trigger)
- [ ] Re-selecting the same file after a reload resumes from the last server-confirmed offset (not from zero), confirmed by the SSE snapshot cross-reference
- [ ] A stale localStorage entry (session `abandoned` during the reload gap) is detected via the SSE snapshot and discarded; a fresh upload starts
- [ ] `GET /batches/:batchKey` returns all rows (including `success`) for that batch, ordered by `batch_position`
- [ ] Re-selecting the same files after a reload reconstructs the batch queue from the manifest: `success` files shown as done, in-progress files resumed, unstarted files queued — with no re-upload of already-completed files
- [ ] `batch_key`, `last_modified`, and `batch_position` are populated on every `uploads` row created within a batch context
- [ ] After upload completion, both `client_file_hash` and `server_file_hash` are computed independently and stored; `hash_verified` reflects their comparison
- [ ] On hash match: `hash_verified = true`, SSE `integrity` event carries `hash_verified: true`, frontend shows "verified" indicator
- [ ] On hash mismatch: `hash_verified = false`, `status = 'corrupt'`, SSE `integrity` event carries `hash_verified: false`, frontend shows `corrupt` badge (visually distinct from `error`)
- [ ] Hash computation does not block queue progression: the next file's upload begins immediately after `POST_FINISH`, hash result updates the badge asynchronously
- [ ] All M1–M7 acceptance criteria continue to pass

---

## 13. Milestone 9 — Cancellation: Single File & Full Batch (New)

**Scope:** everything in M8, plus explicit user-initiated cancellation at two granularities — individual file (X button on each row) and the entire batch (Cancel button above the queue). This is distinct from pause (which is reversible and preserves server-side state) and from `abandoned` (which is server-detected after a liveness timeout). A cancelled upload is **user-initiated and permanent**: the partial MinIO upload is aborted, the `uploads` row is marked `cancelled`, and the user is not offered resume for it on subsequent reloads.

### Design Decisions & Challenges

| # | Topic | Issue / Challenge | Recommendation |
|---|---|---|---|
| 13.1 | **Cancel vs Pause vs Abandoned** | Three ways a session ends early — need clear semantics. | `paused` = user-initiated stop, reversible, tus URL preserved, server state intact. `abandoned` = server-detected after liveness timeout, not user-initiated. `cancelled` = user-initiated, permanent — tus session terminated (DELETE), partial MinIO multipart aborted, row marked `cancelled`. The user is never offered resume for a cancelled file; the batch manifest reflects this. |
| 13.2 | **tus termination extension** | `tus.abort()` stops sending but preserves the upload URL for resume. True cancellation requires a `DELETE` to the tus upload URL (the tus termination extension). | `@tus/server` supports the termination extension — enable it explicitly. On cancel, call `tus.terminate()` (tus-js-client), which sends the `DELETE`. Backend hook on termination: mark row `cancelled`, abort the MinIO multipart upload, push SSE `cancelled` terminal event. |
| 13.3 | **Single file — active upload** | Cancelling the currently-uploading file must stop the in-flight request cleanly and advance the queue. | Call `tus.terminate()` on the active upload instance. On server-side termination confirmation: mark row `cancelled`, push SSE event, advance queue to the next file (same queue-manager logic as skip-after-error in M6). |
| 13.4 | **Single file — queued (not yet started)** | A file waiting in the queue has no server-side state (no `uploads` row — rows are created at `onUploadCreate`, i.e., when the upload actually starts). | Client-only operation: remove from the in-memory queue and the UI row. No HTTP call needed. |
| 13.5 | **Single file — paused** | A paused file has a server-side row and a live tus upload URL, but no active in-flight request. | Call `DELETE /uploads/:id` (which triggers tus termination server-side). No client-side tus instance to abort. Row → `cancelled`, MinIO partial → aborted, SSE event pushed. |
| 13.6 | **Single file — error or abandoned** | A file in `error` or `abandoned` state has a row but the MinIO partial may already be aborted (by the cleanup job). | Attempt `DELETE /uploads/:id`. If the MinIO partial is already gone, that's fine — mark the row `cancelled` regardless. Remove from UI. |
| 13.7 | **Batch cancel scope** | "Cancel the entire batch" — does that include already-`success` files? | **No.** Already-completed files are in MinIO and their rows are `success` — they represent delivered data and must not be silently deleted. Batch cancel targets only **non-terminal** files: the active upload (if any) plus all queued/paused/error rows for that `batch_key`. Success rows remain visible in the queue UI as completed. The Cancel button label should reflect this: "Cancel remaining" is clearer than "Cancel all" if any files have already succeeded. |
| 13.8 | **Batch cancel endpoint** | Cancelling N queued files in a batch requires either N individual DELETE calls or one batch endpoint. | New `DELETE /batches/:batchKey` endpoint: finds all non-terminal rows for that `batch_key`, terminates any active MinIO multipart uploads, marks them `cancelled`, pushes one SSE `cancelled` event per row. **Ordering:** client must call `tus.terminate()` on the active in-flight upload *before* calling `DELETE /batches/:batchKey`, so the in-flight tus PATCH is stopped cleanly client-side before the server processes the batch. The batch endpoint then handles all remaining non-active rows. Returns `204` once processing is **initiated** — not once all rows are confirmed (see 13.13). |
| 13.9 | **Confirmation UX** | Batch cancel is destructive (all remaining progress lost). Single file cancel is lower stakes. | Single file X: **no confirmation** — immediate, reversible conceptually by re-adding the file (though not by resume). Batch cancel button: **confirmation step** (e.g., "Cancel remaining uploads? This cannot be undone." with Cancel/Confirm). |
| 13.10 | **Cancelled files in the batch manifest** | After a cancel + reload, the manifest (M8, §12.5) will include `cancelled` rows for those files. The client must not offer resume for them. | On manifest reconstruction, treat `cancelled` rows as terminal — do not call `findPreviousUploads()` for those fingerprints, do not queue them. Show them with a `cancelled` badge and an option to re-add manually (which would start a fresh upload, not a resume). |
| 13.11 | **X button visibility** | Which states show the X? | Show X for: `uploading`, `paused`, `queued`, `error`, `abandoned`, `cancelled`, `missing` (to allow dismissing ghost entries). Hide X for: `success` (the file is done and should remain visible). |
| 13.12 | **SSE `cancelled` event** | The SSE channel (M5/§9) already pushes terminal events for `success`, `error`, `abandoned`. | Add `cancelled` as a fourth terminal event type: `{ uploadId, status: 'cancelled' }`. Frontend's status badge map gains a `cancelled` state (distinct colour/icon from `abandoned`). |
| 13.13 | **SSE as the authoritative cancel confirmation — HTTP DELETE = initiate, SSE = confirm** | The existing pattern throughout M5+ is that SSE is the source of truth for status, not HTTP responses. Cancel must follow the same pattern — but the first draft of this section let the `204` and the SSE event race to update the UI ("whichever arrives first"), which breaks that contract. | **Single file:** on X click (or confirm), immediately set the row's visual state to `cancelling…` (a transient intermediate badge — not `cancelled` yet). Dispatch the DELETE (either `tus.terminate()` or `DELETE /uploads/:id`). The `204` confirms the server received the request; do not update the badge further on it. When the SSE `cancelled` event arrives, transition the badge from `cancelling…` to `cancelled`. **Batch cancel:** on confirmation, set all non-terminal rows to `cancelling…` at once. Dispatch `tus.terminate()` then `DELETE /batches/:batchKey`. SSE `cancelled` events arrive **per file** as the server works through the batch — each row transitions from `cancelling…` to `cancelled` individually, giving visible progressive confirmation. **Queued (not-started) files** are the only exception: they have no server-side state and no SSE event will come, so they transition directly to removed from the queue on the client side (no intermediate state needed). |

### Backend (Node/Express + tus)

- **Enable tus termination extension** on `@tus/server` (if not already active): allows `DELETE` requests to the tus upload URL, triggering `onUploadTerminate` hook.
- **`onUploadTerminate` hook**: marks the `uploads` row `status = 'cancelled'`, aborts the corresponding MinIO multipart upload (via `AbortMultipartUpload`), then pushes SSE `{ uploadId, status: 'cancelled' }` terminal event. The SSE push is the last step — it is the client's signal that cancellation is complete, not the `204` HTTP response.
- **`DELETE /uploads/:id`** endpoint (for paused/error/abandoned cancellation where there is no active tus PATCH in flight): triggers the same `onUploadTerminate` logic server-side (terminate the tus session via the stored upload URL, abort MinIO partial, push SSE). Returns `204` **once the cancellation is initiated** — the SSE `cancelled` event confirms completion. If the MinIO partial is already gone (e.g., prior cleanup job), proceed anyway — mark the row `cancelled` and push the SSE event regardless.
- **`DELETE /batches/:batchKey`** endpoint: queries all non-terminal `uploads` rows for that `batch_key`; processes each sequentially (terminate tus session, abort MinIO partial, mark `cancelled`, push SSE `cancelled` event) **one at a time**; returns `204` once processing has **started** (not after all rows are confirmed). SSE `cancelled` events arrive per-file as each row is processed, giving the client progressive per-file confirmation (13.13). Idempotent — already-`cancelled` or `success` rows are skipped silently.
- No schema migration required — `cancelled` is a new string value for the existing `status` text column (same pattern as `abandoned`).

### Frontend (Angular)

- **X button:** rendered on each queue row for all non-`success` states (13.11). On click:
  - If `queued` (not started): remove row from in-memory queue immediately — no HTTP call, no intermediate state (no server-side state exists for this file).
  - If `uploading`: set row to `cancelling…`; call `tus.terminate()` on the active upload instance (this sends the tus-protocol `DELETE` to the server, triggering `onUploadTerminate` — it is the server call, not a separate REST call). Wait for SSE `cancelled` event to transition badge from `cancelling…` to `cancelled`.
  - If `paused`, `error`, `abandoned`: set row to `cancelling…`; call `DELETE /uploads/:id`. Wait for SSE `cancelled` event to transition badge.
  - If `cancelled`: no HTTP call; remove from UI immediately (already a terminal state, just cleaning up the visible list).
- **"Cancel remaining" button:** positioned prominently above the queue list. Visible when the batch has at least one non-terminal file. On click: show confirmation dialog. On confirm:
  1. Set all non-terminal rows to `cancelling…` simultaneously (immediate visual feedback that the request is in flight).
  2. Call `tus.terminate()` on the active upload instance (if any) — stops the in-flight PATCH cleanly before the batch endpoint runs.
  3. Call `DELETE /batches/:batchKey`.
  4. As SSE `cancelled` events arrive per-file, transition each row from `cancelling…` to `cancelled` individually. `success` rows are untouched throughout.
- **`cancelling…` intermediate state:** a transient visual state (e.g., spinner or muted label) shown between cancel dispatch and SSE confirmation. It makes clear the request is being processed server-side without prematurely showing `cancelled`. The `204` HTTP response does **not** trigger any badge change — only the SSE event does.
- **Status badge:** add `cancelling…` (transient) and `cancelled` (terminal) states. `cancelled` is distinct from `abandoned` (e.g., `abandoned` = grey/clock icon, `cancelled` = red/cross icon).
- **SSE handling:** on receiving `{ status: 'cancelled' }` for an `uploadId`, transition that row from `cancelling…` to `cancelled`. This also handles cancellation triggered from another tab — any connected `EventSource` reflects the state change.
- **Manifest reconstruction (M8 interaction):** on reload + re-selection, treat manifest rows with `status = 'cancelled'` as terminal — do not resume, do not re-queue automatically. Show with `cancelled` badge; offer an explicit "re-add as new upload" affordance if the user wants to retry.

### Test Requirements

- **Cancel active upload — SSE-authoritative (integration):** start a large upload, click X; assert the row immediately shows `cancelling…` (not `cancelled`) after the DELETE is dispatched; assert `tus.terminate()` sends the DELETE to the server; assert the `uploads` row becomes `cancelled`, the MinIO partial is gone, and an SSE `cancelled` event is received; assert the badge transitions from `cancelling…` to `cancelled` **on SSE event receipt, not on `204`** — verify by introducing a small artificial delay between the `204` and the SSE push and asserting the badge stays `cancelling…` during the gap. Assert the queue advances to the next file.
- **`204` does not update badge:** unit test the cancel flow with a stub that returns `204` but suppresses the SSE event; assert the badge remains `cancelling…` indefinitely (does not flip to `cancelled`).
- **Cancel queued file:** add 3 files to the batch, cancel the second (queued, not started); assert it is removed from the UI immediately with no HTTP call and no `cancelling…` state; the first and third files are unaffected.
- **Cancel paused file:** start an upload, pause it, click X; assert row → `cancelling…` on dispatch, `DELETE /uploads/:id` called, row → `cancelled` on SSE event, MinIO partial aborted.
- **Cancel error file:** simulate an error, click X; assert row → `cancelling…`, `DELETE /uploads/:id` called, row → `cancelled` on SSE event (MinIO partial absent is handled gracefully).
- **Batch cancel — progressive SSE confirmation (integration):** start a 3-file batch, complete the first, interrupt the second mid-upload, third still queued; confirm "Cancel remaining"; assert: all non-terminal rows immediately show `cancelling…`; file 3 is removed from the queue at once (no server state); SSE `cancelled` event arrives for file 2 → badge transitions to `cancelled`; file 1 row stays `success` throughout; `DELETE /batches/:batchKey` called exactly once. Assert the SSE events arrive sequentially (not all at once), reflecting per-file server processing.
- **Batch cancel — `204` does not clear rows:** assert that receiving the `204` from `DELETE /batches/:batchKey` alone does not transition any `cancelling…` row to `cancelled`; only SSE events do.
- **Batch cancel confirmation:** assert clicking "Cancel remaining" without confirming leaves all rows unchanged; assert confirming triggers the flow.
- **Manifest post-cancel (M8 interaction):** after cancelling file 2 in a batch, reload and re-select the same 3 files; fetch the manifest; assert file 1 → `success`, file 2 → `cancelled` (not offered for resume), file 3 → no row (queued as fresh).
- **X button visibility:** assert X is rendered for `uploading`, `paused`, `queued`, `error`, `abandoned`, `cancelled` rows; assert X is **not** rendered for `success` rows.
- **SSE `cancelled` from second tab:** assert the event is received and badge updated by a second connected `EventSource` when a cancel is triggered in the first.
- **Idempotency:** call `DELETE /uploads/:id` twice on the same already-`cancelled` row; assert `204` both times, no SSE event re-emitted, no error.
- All M1–M8 acceptance criteria continue to pass.

### Acceptance Criteria

- [ ] Each queue row shows an X button for all non-`success` states; no X is shown for `success` rows
- [ ] Clicking X on a queued (not-started) file removes it from the queue immediately, with no HTTP call and no intermediate state
- [ ] Clicking X on an active, paused, or error file immediately sets the row to `cancelling…`; the badge transitions to `cancelled` only on receipt of the SSE `cancelled` event — not on the `204` HTTP response
- [ ] `tus.terminate()` is the sole server call for cancelling an active upload (no additional belt-and-suspenders REST call)
- [ ] Clicking "Cancel remaining" sets all non-terminal rows to `cancelling…` simultaneously; queued (not-started) files are removed from the queue immediately without an intermediate state
- [ ] "Cancel remaining" shows a confirmation step before executing
- [ ] After confirmation, `DELETE /batches/:batchKey` is called once; SSE `cancelled` events arrive per-file and transition each row from `cancelling…` to `cancelled` individually (progressive, not all-at-once)
- [ ] Already-`success` files are unaffected by batch cancel throughout
- [ ] `cancelled` rows in the batch manifest are shown with a `cancelled` badge and are not automatically resumed or re-queued on reload
- [ ] `DELETE /uploads/:id` and `DELETE /batches/:batchKey` are idempotent — repeated calls on already-terminal rows return `204` without re-emitting SSE events or erroring
- [ ] The `cancelling…` intermediate badge is visually distinct from both `cancelled` and `paused`
- [ ] The `cancelled` terminal badge is visually distinct from `abandoned`
- [ ] All M1–M8 acceptance criteria continue to pass

---

## 14. Milestone 10 — MinIO Object Reconciliation (New)

**Scope:** backend-only. A periodic background job that reconciles the `uploads` table against the actual objects present in the MinIO bucket, ensuring the right-column files list (M7) stays accurate even when objects are deleted outside the application (e.g., directly via the MinIO console). No new endpoints, no new UI, no schema migration. The existing SSE channel (M5) delivers the real-time update to connected frontends.

**Why this matters:** `GET /files` is a pure SQLite query — it has no knowledge of whether the underlying MinIO object still exists. Deleting an object via the MinIO console leaves a ghost `success` row that the frontend will keep listing indefinitely. This milestone closes that gap.

**Why poll over MinIO events:** MinIO's bucket notification / webhook mechanism would give push semantics but requires configuring a notification target, an inbound webhook endpoint, and MinIO event subscription — a meaningful integration surface for marginal benefit at PoC scale. A `ListObjectsV2` sweep on a 5-second interval is self-contained, requires no MinIO config changes, and delivers the same result within a predictable time bound.

### Design Decisions & Challenges

| # | Topic | Issue / Challenge | Recommendation |
|---|---|---|---|
| 14.1 | **Poll interval** | How frequently should the reconciliation job run? | **5 seconds** (`RECONCILIATION_INTERVAL_MS = 5000`), exposed as a config constant alongside `CLEANUP_INTERVAL_MS`. This gives a worst-case detection latency of ~5s (job just ran when the object was deleted) and a guaranteed visibility window of ≤6s including SSE delivery and frontend update. |
| 14.2 | **Matching strategy** | How does the job know which MinIO objects correspond to which `uploads` rows? | Each `uploads` row has a `storage_key` column (set at upload-creation time, M1) that holds the MinIO object key. The job lists all object keys in the bucket, builds a `Set`, then queries all `success` rows and checks each row's `storage_key` against that set. O(n) over the number of completed uploads — fine for PoC scale. |
| 14.3 | **What to do with missing objects** | When a `success` row's object is no longer in MinIO, what should happen? | Mark `status = 'missing'` on the row and push an SSE terminal event `{ uploadId, status: 'missing' }`. The frontend removes the file from the right-column list immediately on receipt (no manual refresh). `GET /files` already filters `WHERE status = 'success'` so `missing` rows are automatically excluded from the listing — no query change needed. |
| 14.4 | **Orphaned objects** | Objects present in MinIO with no corresponding `success` row (e.g., created outside the application, or from a partial/failed upload that was already cleaned up). | Log at `warn` level and ignore. Orphan cleanup is out of scope — the MinIO bucket lifecycle rule (M0) already handles incomplete multipart uploads; fully committed orphans are not the application's concern at PoC stage. |
| 14.5 | **No false positives** | The job must not mark a row `missing` if the object exists. | Build the full object-key `Set` from `ListObjectsV2` *before* querying the DB. Only mark `missing` if the key is absent from the complete listing. `ListObjectsV2` returns up to 1000 objects per page — for PoC scale this is a single call; note that pagination would be required beyond ~1000 completed uploads. |
| 14.6 | **Interaction with M9 cancellation** | A cancelled upload's MinIO partial is aborted in M9 — could the reconciliation job race with the cancel flow and mark a row `missing` before the cancel marks it `cancelled`? | No race: only `success` rows are checked. A file being cancelled transitions through `cancelling…` → `cancelled` without passing through `success`, so the reconciliation job never touches in-flight cancellations. |
| 14.7 | **`missing` in M8 batch manifest** | `GET /batches/:batchKey` (M8) returns all rows including `success`. After a row is marked `missing`, it would appear in the manifest as `missing`. | The manifest reconstruction (M8) should treat `missing` the same as `error`/`abandoned` — flag for user decision (the object is gone; offer re-upload, not resume). No spec change to M8 required — the manifest already handles non-terminal and terminal-failure states; `missing` is another terminal-failure case. |
| 14.8 | **X button (M9) on `missing` rows** | M9's 13.11 lists states that show the X button. `missing` is not listed. | `missing` rows should show the X button to allow the user to dismiss them from the list. Add `missing` to the visible-X state list in M9's 13.11 (the only cross-milestone change this milestone requires). |

### Backend (Node/Express + MinIO)

- New `startReconciliationJob()` function, started on backend startup alongside the existing `startCleanupJob()`:
  - Runs on a `setInterval` of `RECONCILIATION_INTERVAL_MS` (default `5000`).
  - On each tick:
    1. Call `ListObjectsV2` on the MinIO bucket → collect all returned `Key` values into a `Set<string>`.
    2. Query `SELECT id, storage_key FROM uploads WHERE status = 'success'`.
    3. For each row where `storage_key` is **not** in the key set: run `UPDATE uploads SET status = 'missing' WHERE id = ?` and push SSE terminal event `{ uploadId: id, status: 'missing' }` over the existing `GET /progress/stream` channel.
    4. Log any objects returned by `ListObjectsV2` that have no matching `uploads` row at `warn` level (orphan notice).
  - Errors (MinIO unavailable, network timeout): log at `error` level, skip the tick, retry on the next interval — do not crash the job.
- No new HTTP endpoints.
- No schema migration — `missing` is a new string value for the existing `status` text column.

### Frontend (Angular)

- No new endpoints or polling. The existing `ProgressService` SSE subscription (M5) already receives all terminal events.
- Extend SSE event handling: on receiving `{ status: 'missing' }` for an `uploadId`, remove the corresponding entry from the right-column file list (M7). If the file is currently loaded in the player, show a "file no longer available" message and clear the player `src`.
- `GET /files` requires no change — `missing` rows are already excluded by the `WHERE status = 'success'` filter.
- Add `missing` to M9's X-button visibility list (13.11) so users can dismiss ghost entries that were marked `missing` before the reconciliation event arrived on their session.

### Test Requirements

- **Reconciliation detects deletion within 6s (integration):** upload a file to completion (`status = 'success'`, object confirmed in MinIO). Delete the MinIO object directly via the S3 SDK in the test harness (not the MinIO console — test must be automatable). Assert: within **6 seconds**, the `uploads` row `status` changes to `'missing'` AND an SSE `missing` event is received for that `uploadId`. Use a polling assertion with a 6s timeout and ~100ms check interval.
- **GET /files excludes missing rows:** immediately after the row is marked `missing`, call `GET /files`; assert the file is not present in the response.
- **Frontend removes file within 6s (E2E):** upload a file, assert it appears in the right-column list, delete the MinIO object via SDK, assert the file **disappears from the right-column list within 6 seconds** (Playwright `waitForFunction` / `waitFor` with 6000ms timeout).
- **Player cleared on missing:** if the deleted file is the currently-loaded player source, assert the player shows "file no longer available" within 6s and the `src` is cleared.
- **No false positives:** run the reconciliation job with all `success` rows having valid MinIO objects; assert no rows are marked `missing`.
- **Orphan handling:** create an object directly in MinIO (no uploads row); run one reconciliation tick; assert no error is thrown, the object is logged at `warn` level, and no uploads rows are affected.
- **Error resilience:** simulate MinIO unavailability (stop the MinIO container or use Toxiproxy to cut the backend↔MinIO connection); assert the reconciliation job logs an error and continues running (does not crash); assert no rows are incorrectly marked `missing` during the outage.
- **Interval is configurable:** assert `RECONCILIATION_INTERVAL_MS` is used by the job (unit test with a short override interval).

### Acceptance Criteria

- [ ] Reconciliation job starts on backend startup and runs every 5 seconds (`RECONCILIATION_INTERVAL_MS = 5000`)
- [ ] Each tick calls `ListObjectsV2` and compares all `success` rows' `storage_key` values against the returned object key set
- [ ] For each `success` row where the MinIO object no longer exists: `status → 'missing'`, SSE `{ uploadId, status: 'missing' }` event pushed
- [ ] `GET /files` continues to return only `success` rows — `missing` rows are automatically excluded by the existing query with no change required
- [ ] A MinIO object deleted outside the application is **no longer visible in the frontend right-column list within 6 seconds** of deletion
- [ ] If the deleted file is loaded in the player, the player shows "file no longer available" and clears within 6 seconds
- [ ] Orphaned MinIO objects (no uploads row) are logged at `warn` level and otherwise ignored
- [ ] A MinIO outage causes the job to log errors and skip affected ticks without crashing; no rows are incorrectly marked `missing`
- [ ] `missing` rows show the X dismiss button in the queue UI (per updated M9 §13.11)
- [ ] All M1–M9 acceptance criteria continue to pass

---

## 15. Stretch Goal — Playback/Use During Upload (Scoping Notes)

The idea of using a file "while it's being uploaded" to S3-compatible storage is genuinely advanced and worth scoping carefully **after** M1–M10 are stable:

- **Why it's hard:** S3's multipart upload API does not support reading an object until `CompleteMultipartUpload` is called — there's no native "read the parts uploaded so far" operation. MinIO has the same constraint, as it implements the S3 API.
- **Feasible approach for a proof-of-concept:** write incoming chunks to a local temp file (in addition to, or instead of, streaming to S3) and expose a "read what's written so far" endpoint with `Range` support against that temp file — effectively progressive download of an in-progress upload. Once upload completes, move/copy the file to MinIO as the final step.
- **Recommendation:** treat this explicitly as a **proof-of-concept / spike**, not a production feature, given the architectural complexity it introduces (dual-write paths, consistency between temp storage and final S3 object, cleanup of temp files).

---

## 16. Future Expansion: TLS/HTTPS via Edge Reverse Proxy (Not Required Now)

Not part of any current milestone — captured here for later reference, should the project move beyond a local PoC.

**Approach:** add a single TLS-terminating reverse proxy as the *only* container exposed outside the Docker network. It owns the certificate (self-signed/`mkcert` for local use, or Let's Encrypt if externally reachable) and is responsible for path-based routing to a single external HTTPS origin:
- `/` → `frontend` container (static Angular assets)
- `/api`, `/files`, `/uploads`, tus endpoint, ping/pong endpoint, batch manifest endpoint → `backend` container

This could be the existing `frontend` nginx container extended to also proxy backend routes, or a small dedicated proxy container — either way it's one configuration change plus a cert volume.

**Why this is low-impact when it happens:**
- Everything behind the proxy (`frontend` static server, `backend`, MinIO, SQLite) continues to communicate over plain HTTP on the Docker-internal network — no per-service certs, no internal mTLS. The Docker network boundary already isn't reachable from outside the host, so this isn't a security regression.
- A single external HTTPS origin means the browser sees frontend and backend as same-origin — the CORS configuration from M1 becomes unnecessary, and there's no mixed-content risk (browser blocks HTTPS pages from calling plain-HTTP endpoints, so everything must move together — but that's a one-time switch, not piecemeal).
- tus uploads and Range-based video streaming all work unchanged over HTTPS — only the URL scheme changes.
- Performance impact on the 2GB transfers is negligible on modern hardware (TLS/AES-NI overhead), and since M6's queue is sequential (not parallel), there's no concurrent-handshake bottleneck to worry about.

**When to revisit:** if the deployment target becomes externally reachable (beyond local/internal PoC use), or if browser-API requirements emerge that need a "secure context" (HTTPS or `localhost`).

---

## 17. Recommended Tech Stack Summary

| Layer | Recommendation |
|---|---|
| Frontend framework | Angular (as specified) |
| Resumable upload client | `tus-js-client` |
| Backend framework | Node.js + Express |
| Resumable upload server | `@tus/server` + `@tus/s3-store` |
| Object storage | MinIO (`minio/minio` Docker image), bucket lifecycle rule for incomplete multipart uploads (§2.11, backstop) |
| Client-facing network proxy | Toxiproxy (`ghcr.io/shopify/toxiproxy`), always present **between the browser and `backend`**; baseline `bandwidth` toxic active by default (dev-convenience), additional toxics (latency, `reset_peer`, tighter bandwidth) added/removed via its admin API during M3's test suite (§2.15, §7). Backend↔MinIO traffic is direct/unproxied. |
| Live progress channel | **Server-Sent Events** (`GET /progress/stream`, browser-native `EventSource`) — one shared stream per page session, fed by `@tus/server`'s `POST_RECEIVE`/`POST_FINISH` events; snapshot-on-connect from the `uploads` table (§9, M5) |
| Metadata DB | SQLite — **embedded in-process within the `backend`**, a single file on its volume; not a separate container/service (unlike MinIO and Toxiproxy, which are their own services) |
| Session/abandonment tracking | **M2 (implemented):** client-initiated `POST /uploads/:id/heartbeat` (~20s interval) + `navigator.sendBeacon` on unload (`POST /uploads/:id/abandon`) + 60s interval cleanup job with 90s staleness timeout. **M8 (supersedes M2):** server-initiated SSE `ping` (~20s, over `GET /progress/stream`) + client HTTP `POST /batches/:batchKey/pong` response; `sendBeacon`/heartbeat removed; 90s staleness cleanup job unchanged; MinIO lifecycle rule remains backstop throughout (§2.11) |
| Video probing | `ffprobe` (via `fluent-ffmpeg` or direct CLI calls) — requires `ffmpeg` installed in backend image |
| Backend tests | Jest |
| Frontend/E2E tests | Playwright |
| Network-failure simulation (M2) | Custom mid-stream abort harness (`tests/integration/`) — no external proxy tooling |
| Orchestration | `docker-compose.yml` at repo root, images built from `docker-images/*` (frontend, backend), `minio` and `toxiproxy` off-the-shelf — see §3 for full repo structure |

---

## 18. Remaining Open Questions

All previously open decisions have now been resolved (see §2.5, §2.7, §2.9, §2.11 and the updated M1/M2 sections). Two notes remain for the roadmap, not blocking:

1. **Heartbeat/timeout values are defaults, not fixed:** 20s heartbeat interval, 60s cleanup-job interval, 90s staleness timeout (§2.11) are reasonable starting points but should be exposed as config constants so they can be tuned without code changes once real usage patterns (and large-file upload durations) are observed.
2. **Concurrency for a future milestone (§2.5/2.6):** when parallel batch processing is eventually added, will the per-file pause/resume/skip/retry model from M2/M6 and M8's batch-manifest reconstruction carry over directly, or does it need rethinking for concurrent state management? No action needed now — just flagging for the roadmap.
