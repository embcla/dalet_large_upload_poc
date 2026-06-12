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
| 2.2 | **Metadata persistence — RESOLVED** | M4 needs to list "uploaded files" and show video metadata (codec, duration). S3/MinIO object listing alone is slow and carries no application-level metadata. | Use **SQLite** (file-based, fits cleanly into the `backend` container/volume, no extra service in docker-compose). `uploads` table row is created **at upload-start (M1)**, not just on completion — columns: id (= tus upload ID), filename, size, mime type, status (`uploading`/`paused`/`success`/`error`/`abandoned`), storage key, `last_seen` (for §2.11 cleanup), and codec/resolution/duration (populated post-upload via `ffprobe`, M4). |
| 2.3 | **Test file strategy — RESOLVED** | A single approach can't cover both "large arbitrary-content files" (M1–M3) and "small files with real, probeable video codecs" (M4). | **M1–M3**: synthetic files generated **on the fly** at test-run time (`fallocate`/`dd`/Node script) for 100MB/200MB/1000MB/2000MB/2100MB — content doesn't matter, only size, since these tests validate transfer/resume mechanics, not codec handling. Generated into a tmp location, deleted after the run. **M4 onward**: requires a **different approach** — small (few-second) *real* video files with actual codec streams that `ffprobe` can inspect, since random bytes aren't valid video. These are small enough (a few MB) to be **committed as fixtures** in `tests/fixtures/` rather than generated. |
| 2.4 | **"Automated dropped packets test" (M2) — RESOLVED** | Not trivial — you can't easily simulate a dropped TCP connection from a normal HTTP test. | **Simple custom harness** (no Toxiproxy, per stakeholder preference for simplicity): a small Node test utility that starts an upload, destroys the underlying socket/aborts the request mid-stream at a known byte offset, then re-initiates the tus upload against the same upload URL to resume. Lives in `tests/integration/`. |
| 2.5 | **Batch error behavior (M3)** — **RESOLVED** | M3 processes the batch **sequentially, one file at a time**. If a file errors, the batch pauses and offers retry/skip for that file before continuing to the next. | Implement queue as a sequential pipeline (not parallel). Parallel/independent-file processing is explicitly deferred to a future milestone — design the queue manager so it *could* be extended to parallel later (e.g., keep per-file state isolated), but don't build concurrency now. |
| 2.6 | **Upload concurrency (M3)** — **RESOLVED** | Sequential, one file at a time (per 2.5). | No concurrency cap needed for M3. Note for future milestone: introducing parallelism later. |
| 2.7 | **"Codecs mismatch and video file identification" (M4)** — **RESOLVED** | Detect-and-fallback only, **no transcoding**. | Use `ffprobe` to detect codec on upload-complete, compare against a browser-compatible allowlist (e.g., H.264+AAC in MP4, VP8/VP9/AV1 in WebM), and show a "format not supported for preview" placeholder if it doesn't match. Transcoding pipeline is out of scope entirely (not just deferred). |
| 2.8 | **Streaming/seeking support (M4)** | "Retrieve API so uploaded files can be streamed back" — for `<video>` seeking to work, the retrieve endpoint **must** support HTTP `Range` requests (206 Partial Content), proxying ranged `GetObject` calls to MinIO. Not explicitly stated but functionally required. | Add explicitly as a requirement in M4. |
| 2.9 | **File type scope (M4) — RESOLVED** | Platform is **video-only**. | All uploads must be video files, enforced via an **allowlist** of accepted file types — **MKV and MP4 for now** (extensible later). Enforced at upload time in M1 (see M1 Backend/Frontend), not deferred to M4. M4's "uploaded files" list and player can assume every entry is a video. |
| 2.10 | **Auth / multi-user — CONFIRMED** | Not mentioned at all. | **Confirmed: simple PoC, no multi-user, no login, no access control anywhere.** "Uploaded files" list is global/single-tenant; the retrieve/stream API is unauthenticated. |
| 2.11 | **Abandoned upload cleanup — RESOLVED (layered approach)** | Where does this manifest, and can the frontend detect that a user left the page? | **Yes, to a useful degree** — `beforeunload`/`pagehide` events combined with `navigator.sendBeacon()` let the frontend reliably notify the backend "I'm leaving" even as the page unloads (regular `fetch` calls are often cancelled mid-flight on navigation, but `sendBeacon` is purpose-built to survive it). This covers the common case (tab close, navigation, refresh). It does **not** cover ungraceful exits (browser crash, force-quit, power loss, network drop) — for those, a **timeout-based fallback** is still needed. Recommended layered design: **(1)** each upload session (= tus upload ID) gets a row in the `uploads` table (created at upload-start, in M1) with a `last_seen` timestamp; **(2)** while a session is active or paused, the frontend sends a lightweight heartbeat (e.g., every 20s) to `POST /uploads/:id/heartbeat`, updating `last_seen`; **(3)** on `beforeunload`/`pagehide`, the frontend fires `navigator.sendBeacon()` to `POST /uploads/:id/abandon`, which immediately marks the session for cleanup; **(4)** a backend interval job (e.g., every 60s) finds non-completed sessions where `now - last_seen` exceeds a timeout (e.g., 90s — i.e., ~4 missed heartbeats) and aborts the corresponding MinIO multipart upload + marks the row `abandoned`; **(5)** the M0 MinIO bucket lifecycle rule remains as a final backstop for anything that escapes (1)–(4). **Note:** this is purely about cleaning up *server-side resources for an in-progress upload* — it does **not** reintroduce cross-reload resume or user/device identification, which remain out of scope per §2.12. |
| 2.12 | **Client-side resume persistence — RESOLVED** | Does resumability need to survive a full browser restart? | **No.** Per stakeholder direction, there is **no session caching, no localStorage persistence, no user/device identification** — full focus stays on the ingestion mechanism itself. Pause/resume/retry/skip work only within the lifetime of the current page/tab (i.e., the in-memory tus client state). A full page reload mid-upload or mid-batch loses progress and must restart. This is a deliberate, documented limitation of the PoC, not a bug. |
| 2.13 | **Server-side size enforcement — CONFIRMED** | "Gracefully refuse if file > 2GB" — client-side checks can be bypassed (devtools, curl). | **Confirmed**: enforce in both places. Client-side pre-check (instant UX feedback) **and** `@tus/server`'s `maxSize` option (actual security boundary) — any upload exceeding 2GB is force-failed server-side regardless of client behavior. |
| 2.14 | **Docker image split — CONFIRMED** | "One or more, to be defined" — needs an actual answer to plan Milestone 0. | **Confirmed: docker-compose**, with images per §3 (Repository Structure). |

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
├── tests/
│   ├── unit/                  # Per-component unit tests (or kept alongside source — see note below)
│   ├── integration/           # Backend integration tests, incl. dropped-connection harness (§2.4)
│   ├── e2e/                   # Playwright E2E specs driving frontend + backend together
│   ├── fixtures/              # Small real video files for M4 (§2.3) — committed, few MB total
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
- Repository scaffolded per §3 structure: `frontend/`, `backend/`, `minio/`, `tests/`, `docker-images/`, `build/`, root `docker-compose.yml`
- `docker-compose.yml` defining: `frontend` (Angular, nginx), `backend` (Node/Express + SQLite), `minio` (S3-compatible storage + console on a separate port), with a shared Docker network
- MinIO bucket auto-created on startup via `minio/bucket-init/` script (sidecar `mc` container or init container), including the **lifecycle rule to auto-abort incomplete multipart uploads** (§2.11)
- Backend skeleton: Express app, health-check endpoint, environment-based config (bucket name, MinIO endpoint/credentials, max file size constant)
- Frontend skeleton: Angular app shell, basic routing, environment config pointing to backend API
- SQLite wired up in the backend container/volume, with a minimal migration for an `uploads` table (id, filename, size, mime_type, status, storage_key, created_at, updated_at)
- Test runner setup: Jest for backend, Karma/Jasmine (default Angular) or Jest for frontend unit tests, Playwright for E2E
- `build/` scripts that build each image from `docker-images/*/Dockerfile` using the matching component folder as context
- `README.md` documenting repo layout, `docker-compose up`, ports, and how to run each test suite

### Acceptance Criteria
- [ ] Repository matches the §3 structure (`frontend/`, `backend/`, `minio/`, `tests/`, `docker-images/`, `build/`, `docker-compose.yml`)
- [ ] `docker-compose up` builds (via `docker-images/*` Dockerfiles) and starts `frontend`, `backend`, and `minio` successfully
- [ ] Frontend is reachable in a browser and renders the Angular app shell
- [ ] Backend health-check endpoint returns `200`
- [ ] Backend can write and read a test object to/from the MinIO bucket (verifiable via a script or test)
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
- Status model per file: `idle | uploading | paused | error | success`, each with a distinct visual indicator (icon + color, no aesthetic polish needed)
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

## 7. Milestone 3 — Batch Upload (Refined)

**Scope:** everything in M2, plus:

**Processing model:** sequential, one file at a time. The queue processes files in order; only one tus upload session is active at a time. If a file errors, the whole queue pauses on that file and offers **retry** (re-attempt the same file) or **skip** (move to the next file in the queue, leaving the failed file marked as skipped/error). Parallel/concurrent uploads are explicitly **out of scope** for M3 — design the queue manager with per-file state isolated so it could be extended to parallel processing in a future milestone, but do not implement concurrency now.

### Frontend
- File input with `multiple` attribute (multi-select)
- Queue list UI: one row per file showing filename, size, per-file progress bar, and status badge (from M2's status model: `idle | uploading | paused | error | success | skipped | queued`)
- Overall/aggregate progress bar across the whole batch (sum of bytes uploaded / sum of total bytes across all files, including completed and pending ones)
- Only the currently-active file shows live progress; queued files show "waiting"
- On error for the active file: queue pauses, and the UI offers **Retry** (resume/restart that file) and **Skip** (mark as skipped, advance to next file)
- Pause/resume controls (from M2) apply to the currently-active file
- **Known limitation (by design per §2.12):** queue state is in-memory only — a full page reload mid-batch loses the queue and requires restarting the batch selection from scratch

### Backend
- No new endpoints required — each file uses its own tus upload session sequentially; the existing M1/M2 tus endpoint handles this naturally since only one session is active at a time

### Test Requirements
- **Unit/integration tests for queue logic with mocked uploads**: replace the actual `tus-js-client` upload calls with a mock/stub that can simulate success, failure, and slow progress on a per-file basis, without performing real network I/O. Test scenarios:
  - All files succeed sequentially → aggregate progress reaches 100%, all statuses = success, files processed in order
  - One file fails mid-queue → queue pauses on that file, aggregate progress stalls, other files remain in "queued" state
  - Retry-after-failure resumes the failed file and continues to the next on success
  - Skip marks the failed file as skipped and advances the queue to the next file
- E2E test with a small batch of real small files (e.g., 3× 10MB) to validate the full sequential pipeline end-to-end (not just mocked)

### Acceptance Criteria
- [ ] Multi-file selection works via the file picker (multi-select)
- [ ] Queue list shows one row per selected file with filename, size, status, and per-file progress
- [ ] Files are processed strictly sequentially — only one upload active at a time; queued files show "waiting"
- [ ] Aggregate progress bar reflects combined bytes uploaded across the whole batch
- [ ] On error for the active file, the queue pauses and the UI offers Retry and Skip
- [ ] Retry re-attempts the failed file (resuming from last offset per M2); on success the queue continues
- [ ] Skip marks the failed file as skipped and advances to the next file without uploading it
- [ ] All successfully completed files have corresponding objects in MinIO with matching checksums
- [ ] Automated mocked-queue tests cover: full success, mid-queue failure + retry, mid-queue failure + skip
- [ ] E2E test with 3 small real files completes the full sequential pipeline successfully
- [ ] All M2 acceptance criteria continue to pass for individual files within a batch

---

## 8. Milestone 4 — Uploaded Files Visualization & Playback (Refined)

**Scope:** everything in M3, plus:

**Platform scope confirmed: video-only.** All uploads are expected to be video files. Codec/format handling is **detection + fallback message only** — no transcoding.

### Frontend Layout
- Two-column layout: left = upload selection/queue (from M3), right = uploaded files list
- Both columns independently vertically scrollable (fixed-height container with `overflow-y: auto`)
- Video player element docked above the right-column list, initially empty/placeholder
- Clicking a file in the right-column list loads it into the player
- Empty state: if no files uploaded yet, right column shows a placeholder message (no player shown, or player disabled)

### Backend
- **List endpoint** `GET /files`: returns metadata for all completed uploads from the DB (§2.2) — id, filename, size, status, duration, resolution, codec, and a `playable: boolean` flag
- **Post-upload processing hook**: on tus upload completion, run `ffprobe` against the object (stream from MinIO or probe before/while uploading to MinIO, depending on tus-store internals) to extract codec/duration/resolution, store in DB; classify `playable` against a browser-compatible codec allowlist (e.g., H.264+AAC in MP4, VP8/VP9/AV1 in WebM)
- **Retrieve/stream endpoint** `GET /files/:id/stream`: proxies a ranged `GetObject` request to MinIO, forwarding `Range` headers and returning `206 Partial Content` with appropriate `Content-Range`/`Accept-Ranges` headers — required for `<video>` seeking to work

### Player Behavior
- If selected file's `playable` flag is true → set `<video src>` to the stream endpoint, enable native play/pause controls
- If `playable` is false → show "preview not available for this format" message instead of attempting playback (file still appears in the list with its metadata)

### Test Requirements
- **Test fixtures (§2.3 — different approach from M1–M3):** small (few-second) *real* video files with actual codec streams, **committed** to `tests/fixtures/` — at least one browser-compatible (H.264/AAC MP4) and one non-compatible (e.g., MPEG-2 or ProRes) sample. These cannot be generated on the fly like the M1–M3 size-test files, since `ffprobe` needs genuine codec data.
- Tests cover: upload → appears in right-column list → metadata correctly probed and stored → compatible file loads into player and `src` resolves to a working stream URL → incompatible file shows "preview unavailable" → empty-list state renders correctly when no files exist
- Streaming endpoint test: request with `Range: bytes=0-1023` returns `206` with correct `Content-Range` and exactly 1024 bytes

### Acceptance Criteria
- [ ] Page renders two independently-scrollable columns: left = upload/queue (M3 UI), right = uploaded files list
- [ ] `GET /files` returns metadata (id, filename, size, status, duration, resolution, codec, `playable`) for all completed uploads
- [ ] After a successful upload, the file appears in the right-column list (on refresh, given §2.12's no-persistence constraint)
- [ ] For the browser-compatible fixture (H.264/AAC MP4), clicking it loads it into the player and play/pause works
- [ ] For the non-compatible fixture, clicking it shows "preview not available" instead of attempting playback
- [ ] `GET /files/:id/stream` supports `Range` requests, returning `206 Partial Content` with correct `Content-Range`/`Accept-Ranges` headers, and seeking works in the player for the compatible fixture
- [ ] Empty state: with no uploaded files, the right column shows a placeholder and the player is empty/disabled
- [ ] Automated tests validate probed metadata (codec/duration/resolution) against known values for both fixtures
- [ ] Streaming endpoint test confirms `Range: bytes=0-1023` returns exactly 1024 bytes with `206` status
- [ ] All M3 acceptance criteria continue to pass

---

## 9. Stretch Goal — Playback/Use During Upload (Scoping Notes)

The idea of using a file "while it's being uploaded" to S3-compatible storage is genuinely advanced and worth scoping carefully **after** M1–M4 are stable:

- **Why it's hard:** S3's multipart upload API does not support reading an object until `CompleteMultipartUpload` is called — there's no native "read the parts uploaded so far" operation. MinIO has the same constraint, as it implements the S3 API.
- **Feasible approach for a proof-of-concept:** write incoming chunks to a local temp file (in addition to, or instead of, streaming to S3) and expose a "read what's written so far" endpoint with `Range` support against that temp file — effectively progressive download of an in-progress upload. Once upload completes, move/copy the file to MinIO as the final step.
- **Recommendation:** treat this explicitly as a **proof-of-concept / spike**, not a production feature, given the architectural complexity it introduces (dual-write paths, consistency between temp storage and final S3 object, cleanup of temp files).

---

## 10. Recommended Tech Stack Summary

| Layer | Recommendation |
|---|---|
| Frontend framework | Angular (as specified) |
| Resumable upload client | `tus-js-client` |
| Backend framework | Node.js + Express |
| Resumable upload server | `@tus/server` + `@tus/s3-store` |
| Object storage | MinIO (`minio/minio` Docker image), bucket lifecycle rule for incomplete multipart uploads (§2.11, backstop) |
| Metadata DB | SQLite (file-based, in backend container/volume) |
| Session/abandonment tracking | Heartbeat (`POST /uploads/:id/heartbeat`, ~20s interval) + `navigator.sendBeacon` on unload (`POST /uploads/:id/abandon`) + 60s interval cleanup job with 90s staleness timeout (§2.11) |
| Video probing | `ffprobe` (via `fluent-ffmpeg` or direct CLI calls) — requires `ffmpeg` installed in backend image |
| Backend tests | Jest |
| Frontend/E2E tests | Playwright |
| Network-failure simulation (M2) | Custom mid-stream abort harness (`tests/integration/`) — no external proxy tooling |
| Orchestration | `docker-compose.yml` at repo root, images built from `docker-images/*` (frontend, backend), `minio` off-the-shelf — see §3 for full repo structure |

---

## 11. Remaining Open Questions

All previously open decisions have now been resolved (see §2.5, §2.7, §2.9, §2.11 and the updated M1/M2 sections). Two notes remain for the roadmap, not blocking:

1. **Heartbeat/timeout values are defaults, not fixed:** 20s heartbeat interval, 60s cleanup-job interval, 90s staleness timeout (§2.11) are reasonable starting points but should be exposed as config constants so they can be tuned without code changes once real usage patterns (and large-file upload durations) are observed.
2. **Concurrency for a future milestone (§2.5/2.6):** when parallel batch processing is eventually added, will the per-file pause/resume/skip/retry model from M2/M3 carry over directly, or does it need rethinking for concurrent state management? No action needed now — just flagging for the roadmap.
