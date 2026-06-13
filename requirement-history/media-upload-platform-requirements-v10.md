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
| 2.11 | **Abandoned upload cleanup — RESOLVED (layered approach)** | Where does this manifest, and can the frontend detect that a user left the page? | **Yes, to a useful degree** — `beforeunload`/`pagehide` events combined with `navigator.sendBeacon()` let the frontend reliably notify the backend "I'm leaving" even as the page unloads (regular `fetch` calls are often cancelled mid-flight on navigation, but `sendBeacon` is purpose-built to survive it). This covers the common case (tab close, navigation, refresh). It does **not** cover ungraceful exits (browser crash, force-quit, power loss, network drop) — for those, a **timeout-based fallback** is still needed. Recommended layered design: **(1)** each upload session (= tus upload ID) gets a row in the `uploads` table (created at upload-start, in M1) with a `last_seen` timestamp; **(2)** while a session is active or paused, the frontend sends a lightweight heartbeat (e.g., every 20s) to `POST /uploads/:id/heartbeat`, updating `last_seen`; **(3)** on `beforeunload`/`pagehide`, the frontend fires `navigator.sendBeacon()` to `POST /uploads/:id/abandon`, which immediately marks the session for cleanup; **(4)** a backend interval job (e.g., every 60s) finds non-completed sessions where `now - last_seen` exceeds a timeout (e.g., 90s — i.e., ~4 missed heartbeats) and aborts the corresponding MinIO multipart upload + marks the row `abandoned`; **(5)** the M0 MinIO bucket lifecycle rule remains as a final backstop for anything that escapes (1)–(4). **Note:** this is purely about cleaning up *server-side resources for an in-progress upload* — it does **not** introduce cross-reload resume or user/device identification, which remain out of scope per §2.12. |
| 2.12 | **Client-side resume persistence — RESOLVED** | Does resumability need to survive a full browser restart? | **No.** Per stakeholder direction, there is **no session caching, no localStorage persistence, no user/device identification** — full focus stays on the ingestion mechanism itself. Pause/resume/retry/skip continue to work only within the lifetime of the current page/tab. A full page reload mid-upload or mid-batch loses progress and must restart. This is a deliberate, documented limitation of the PoC, not a bug. |
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

**Scope:** M0–M3 are already committed and are **not** retroactively edited by this milestone. This milestone is **schema-only** — a set of additive `uploads` table migrations and a small amount of regression testing, with **no new endpoints, no new UI, and no behavioral changes** to anything in M0–M3 (same "no new application features" framing as M3, but for the database rather than test infra). It exists to (a) fix one small gap in M0's original migration, and (b) lay the schema groundwork that **M5 (SSE)** needs immediately and that a **forthcoming milestone** (cross-reload resume + batch session reconciliation, to be specced separately once that design is finalized) will build on — so that milestone doesn't also need to touch the schema of work that's already shipped.

All migrations here are purely **additive** (new nullable/defaulted columns on the existing `uploads` table) — no existing column is renamed, retyped, or dropped, so M0–M3's existing rows and code paths are unaffected.

### Design Decisions & Challenges

| # | Topic | Issue / Challenge | Recommendation |
|---|---|---|---|
| 8.1 | **Gap fix: `last_seen` missing from M0's initial migration** | M1's `onUploadCreate` hook (§5) sets `last_seen = now()` on every row from the very first upload, and M2's heartbeat/cleanup design (§2.11) depends on it — but M0's initial migration list (§4) never included this column. As written, M1 depends on a column M0 never creates. | **Migration**: add `last_seen` (timestamp, nullable) to `uploads`. Since M0–M3 are committed, this is delivered as an additive migration here rather than by editing M0's migration — functionally equivalent (the column exists before M1's code path needs it), just delivered as a follow-up rather than retroactively rewriting M0. |
| 8.2 | **`bytes_received` for M5's SSE snapshot** | M5's snapshot-on-connect (§9.6) needs to read "confirmed bytes received" per upload from `uploads` — tus tracks the offset internally (`@tus/server`/`@tus/s3-store`), not in SQLite. | **Migration**: add `bytes_received` (integer, default 0) to `uploads`. M5 updates it on `POST_RECEIVE` (throttled) and sets it to `bytes_total` on `POST_FINISH`, and reads it directly for the snapshot — see M5's §9.2/§9.6 for the consuming behavior. |
| 8.3 | **`batch_key` — forward-looking, for the cross-reload resume / batch-session milestone** | The forthcoming resume milestone's design (server-held batch manifest, keyed by a deterministic hash of the selected files' `(filename, size, lastModified)` set) needs a place to record which files belong to the same batch. | **Migration**: add `batch_key` (text, nullable) to `uploads`. Not populated or read by anything in M1–M6 — purely reserved for the future milestone, which will populate it at upload-creation time (M2's single-file flow becomes the batch-of-1 case). |
| 8.4 | **`last_modified` / `batch_position` — forward-looking, for fingerprint matching & queue reconstruction** | The same future milestone needs the client-reported file `lastModified` (part of the per-file fingerprint, alongside `filename`+`size`) and the file's position within its batch, to reconstruct queue order on reconnect. | **Migration**: add `last_modified` (integer, nullable — client file mtime) and `batch_position` (integer, nullable) to `uploads`. Unused until the future milestone. |
| 8.5 | **Hash-verification columns — forward-looking, for post-completion integrity checks** | Per the agreed design, file integrity is checked **once, after upload completion** — whole-file hash, not per-chunk: the client reports a hash of the source file, the server independently hashes the completed MinIO object, and the two are compared. | **Migration**: add `client_file_hash` (text, nullable), `server_file_hash` (text, nullable), and `hash_verified` (boolean, nullable) to `uploads`. Unused until the future milestone defines the comparison flow (including what happens to `status` on a mismatch). |

### Backend (Node/Express + SQLite)

- One additive migration against the existing `uploads` table:
  ```sql
  ALTER TABLE uploads ADD COLUMN last_seen TIMESTAMP;
  ALTER TABLE uploads ADD COLUMN bytes_received INTEGER DEFAULT 0;
  ALTER TABLE uploads ADD COLUMN batch_key TEXT;
  ALTER TABLE uploads ADD COLUMN last_modified INTEGER;
  ALTER TABLE uploads ADD COLUMN batch_position INTEGER;
  ALTER TABLE uploads ADD COLUMN client_file_hash TEXT;
  ALTER TABLE uploads ADD COLUMN server_file_hash TEXT;
  ALTER TABLE uploads ADD COLUMN hash_verified BOOLEAN;
  ```
- Migration runs automatically on backend startup (same migration mechanism as M0's initial schema), and is idempotent/safe to run against a database that already has M0–M3 data in it.
- No endpoint, event-emitter, or business-logic changes — `last_seen` and `bytes_received` become available for M1–M3's existing code (heartbeat/cleanup) and M5 (SSE) respectively to use; `batch_key`, `last_modified`, `batch_position`, and the hash columns are unused for now.

### Test Requirements

- **Migration regression test**: start the backend against a database already containing rows created by M0–M3's existing code paths (or run M1–M3's existing test suites first, then apply this migration); assert the migration applies cleanly, all eight new columns exist with the expected types/defaults, and existing rows are unaffected (no data loss, no errors on pre-existing rows where the new columns are `NULL`/default).
- **M1–M3 regression**: re-run M1's size-matrix tests and M2's heartbeat/abandon/cleanup tests (§6) — all continue to pass unchanged, now with `last_seen` populated via the migrated column rather than a column M0 never created.
- **Column smoke test**: insert a row, confirm `bytes_received` defaults to `0` and `last_seen`, `batch_key`, `last_modified`, `batch_position`, `client_file_hash`, `server_file_hash`, `hash_verified` all accept `NULL`.

### Acceptance Criteria

- [ ] `uploads` table has `last_seen`, `bytes_received`, `batch_key`, `last_modified`, `batch_position`, `client_file_hash`, `server_file_hash`, and `hash_verified` columns, added via an additive migration
- [ ] Migration runs automatically on startup and is idempotent against a database already populated by M0–M3
- [ ] `bytes_received` defaults to `0`; the new forward-looking columns (`batch_key`, `last_modified`, `batch_position`, `client_file_hash`, `server_file_hash`, `hash_verified`) accept `NULL` and are otherwise unused by M1–M6
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
- **Known limitation (by design per §2.12):** queue state is in-memory only — a full page reload mid-batch loses the queue and requires restarting the batch selection from scratch

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
- [ ] All successfully completed files have corresponding objects in MinIO with matching checksums
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

## 12. Stretch Goal — Playback/Use During Upload (Scoping Notes)

The idea of using a file "while it's being uploaded" to S3-compatible storage is genuinely advanced and worth scoping carefully **after** M1–M7 are stable:

- **Why it's hard:** S3's multipart upload API does not support reading an object until `CompleteMultipartUpload` is called — there's no native "read the parts uploaded so far" operation. MinIO has the same constraint, as it implements the S3 API.
- **Feasible approach for a proof-of-concept:** write incoming chunks to a local temp file (in addition to, or instead of, streaming to S3) and expose a "read what's written so far" endpoint with `Range` support against that temp file — effectively progressive download of an in-progress upload. Once upload completes, move/copy the file to MinIO as the final step.
- **Recommendation:** treat this explicitly as a **proof-of-concept / spike**, not a production feature, given the architectural complexity it introduces (dual-write paths, consistency between temp storage and final S3 object, cleanup of temp files).

---

## 13. Future Expansion: TLS/HTTPS via Edge Reverse Proxy (Not Required Now)

Not part of any current milestone — captured here for later reference, should the project move beyond a local PoC.

**Approach:** add a single TLS-terminating reverse proxy as the *only* container exposed outside the Docker network. It owns the certificate (self-signed/`mkcert` for local use, or Let's Encrypt if externally reachable) and is responsible for path-based routing to a single external HTTPS origin:
- `/` → `frontend` container (static Angular assets)
- `/api`, `/files`, `/uploads`, tus endpoint, heartbeat/abandon endpoints → `backend` container

This could be the existing `frontend` nginx container extended to also proxy backend routes, or a small dedicated proxy container — either way it's one configuration change plus a cert volume.

**Why this is low-impact when it happens:**
- Everything behind the proxy (`frontend` static server, `backend`, MinIO, SQLite) continues to communicate over plain HTTP on the Docker-internal network — no per-service certs, no internal mTLS. The Docker network boundary already isn't reachable from outside the host, so this isn't a security regression.
- A single external HTTPS origin means the browser sees frontend and backend as same-origin — the CORS configuration from M1 becomes unnecessary, and there's no mixed-content risk (browser blocks HTTPS pages from calling plain-HTTP endpoints, so everything must move together — but that's a one-time switch, not piecemeal).
- tus uploads, `navigator.sendBeacon`, and Range-based video streaming all work unchanged over HTTPS — only the URL scheme changes.
- Performance impact on the 2GB transfers is negligible on modern hardware (TLS/AES-NI overhead), and since M6's queue is sequential (not parallel), there's no concurrent-handshake bottleneck to worry about.

**When to revisit:** if the deployment target becomes externally reachable (beyond local/internal PoC use), or if browser-API requirements emerge that need a "secure context" (HTTPS or `localhost`).

---

## 14. Recommended Tech Stack Summary

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
| Session/abandonment tracking | Heartbeat (`POST /uploads/:id/heartbeat`, ~20s interval) + `navigator.sendBeacon` on unload (`POST /uploads/:id/abandon`) + 60s interval cleanup job with 90s staleness timeout (§2.11) |
| Video probing | `ffprobe` (via `fluent-ffmpeg` or direct CLI calls) — requires `ffmpeg` installed in backend image |
| Backend tests | Jest |
| Frontend/E2E tests | Playwright |
| Network-failure simulation (M2) | Custom mid-stream abort harness (`tests/integration/`) — no external proxy tooling |
| Orchestration | `docker-compose.yml` at repo root, images built from `docker-images/*` (frontend, backend), `minio` and `toxiproxy` off-the-shelf — see §3 for full repo structure |

---

## 15. Remaining Open Questions

All previously open decisions have now been resolved (see §2.5, §2.7, §2.9, §2.11 and the updated M1/M2 sections). Two notes remain for the roadmap, not blocking:

1. **Heartbeat/timeout values are defaults, not fixed:** 20s heartbeat interval, 60s cleanup-job interval, 90s staleness timeout (§2.11) are reasonable starting points but should be exposed as config constants so they can be tuned without code changes once real usage patterns (and large-file upload durations) are observed.
2. **Concurrency for a future milestone (§2.5/2.6):** when parallel batch processing is eventually added, will the per-file pause/resume/skip/retry model from M2/M6 carry over directly, or does it need rethinking for concurrent state management? No action needed now — just flagging for the roadmap.
