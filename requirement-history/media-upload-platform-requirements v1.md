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
| 2.1 | **S3-compatible storage choice** | "Docker images that replicate S3" is correct but unnamed | Use **MinIO** (`minio/minio` image). It's the industry-standard self-hosted S3-compatible store, has an admin console, and `@tus/s3-store` + AWS SDK work against it natively with just an endpoint override. |
| 2.2 | **Metadata persistence** | M4 needs to list "uploaded files" and show video metadata (codec, duration). S3/MinIO object listing alone is slow and carries no application-level metadata (status, original filename mapping, codec info). No DB is mentioned anywhere. | Add a lightweight metadata store — **SQLite** (simplest, file-based, fits "everything in Docker" easily) or Postgres if you want headroom. Each upload gets a DB row: id, filename, size, mime type, status, storage key, codec/resolution/duration (populated post-upload via `ffprobe`). |
| 2.3 | **Test file generation for 1–2.1GB files** | Committing multi-GB binary files to a repo is impractical (repo size, CI runtime, git LFS costs). | Generate test files **at test-run time** with `fallocate`/`dd` (or a small Node script) into a tmp volume, run the test, then delete. Document expected disk headroom (~6–7GB free for the largest test cases run sequentially). |
| 2.4 | **"Automated dropped packets test" (M2)** | Not trivial — you can't easily simulate a dropped TCP connection from a normal HTTP test. | Recommend **Toxiproxy** (Shopify) as a docker-compose service sitting between client and server in the test environment — it can inject latency, bandwidth limits, and connection resets. Alternatively, a custom test harness that aborts the HTTP request mid-stream at a known byte offset and then resumes — simpler, but less realistic. Either is acceptable; pick one. |
| 2.5 | **Batch error behavior (M3)** — **RESOLVED** | M3 processes the batch **sequentially, one file at a time**. If a file errors, the batch pauses and offers retry/skip for that file before continuing to the next. | Implement queue as a sequential pipeline (not parallel). Parallel/independent-file processing is explicitly deferred to a future milestone — design the queue manager so it *could* be extended to parallel later (e.g., keep per-file state isolated), but don't build concurrency now. |
| 2.6 | **Upload concurrency (M3)** — **RESOLVED** | Sequential, one file at a time (per 2.5). | No concurrency cap needed for M3. Note for future milestone: introducing parallelism later. |
| 2.7 | **"Codecs mismatch and video file identification" (M4)** — **RESOLVED** | Detect-and-fallback only, **no transcoding**. | Use `ffprobe` to detect codec on upload-complete, compare against a browser-compatible allowlist (e.g., H.264+AAC in MP4, VP8/VP9/AV1 in WebM), and show a "format not supported for preview" placeholder if it doesn't match. Transcoding pipeline is out of scope entirely (not just deferred). |
| 2.8 | **Streaming/seeking support (M4)** | "Retrieve API so uploaded files can be streamed back" — for `<video>` seeking to work, the retrieve endpoint **must** support HTTP `Range` requests (206 Partial Content), proxying ranged `GetObject` calls to MinIO. Not explicitly stated but functionally required. | Add explicitly as a requirement in M4. |
| 2.9 | **File type scope (M4)** — **RESOLVED** | Platform is **video-only**. | All uploads (M1–M3) are expected to be video files. M4's "uploaded files" list and player can assume video throughout — simplifies §2.7's allowlist check (every uploaded file gets probed and classified as playable/not), and removes the need for a generic "non-video file" list-item type. Consider adding a video-MIME-type check at upload time (M1) — see open question below. |
| 2.10 | **Auth / multi-user** | Not mentioned at all. Affects whether "uploaded files" list is global, per-user, and whether the retrieve/stream API needs access control. | Assume **single-user / no auth** (internal tool) unless told otherwise — but flagging since it's a one-line decision now and a much bigger one later. |
| 2.11 | **Abandoned upload cleanup** | If a user starts an upload and never returns, tus leaves partial multipart uploads / incomplete objects in MinIO indefinitely. | Add a retention policy: tus server `expirationPeriodInSeconds` + a periodic cleanup job (cron or on-startup) that aborts/deletes expired incomplete multipart uploads. Worth a line item in M2. |
| 2.12 | **Client-side resume persistence** | Does "resumability" need to survive a full browser restart / different device, or just a flaky connection while the tab stays open? | tus-js-client can persist upload URLs/fingerprints in `localStorage`, enabling resume after page reload on the *same browser*. Cross-device resume would require server-side session lookup by file hash — bigger scope. Assume same-browser persistence is sufficient unless specified otherwise. |
| 2.13 | **Server-side size enforcement** | "Gracefully refuse if file > 2GB" — client-side checks can be bypassed (devtools, curl). | Enforce in both places: client-side pre-check (instant UX feedback) **and** `@tus/server`'s `maxSize` option (actual security boundary). |
| 2.14 | **Docker image split** | "One or more, to be defined" — needs an actual answer to plan Milestone 0. | Recommend: (1) `frontend` image — Angular build served via nginx, (2) `backend` image — Node/Express + tus server, (3) `minio` — off-the-shelf image, (4) optional `toxiproxy` for M2 testing. Orchestrated via `docker-compose.yml`. This is the natural decomposition and keeps build times reasonable. |

---

## 3. Proposed Milestone 0: Infrastructure & Scaffolding (New)

Not in the original brief, but recommended as a short pre-step so M1 isn't blocked on environment setup.

**Deliverables:**
- `docker-compose.yml` defining: `frontend` (Angular, nginx), `backend` (Node/Express), `minio` (S3-compatible storage + console on a separate port), with a shared Docker network
- MinIO bucket auto-created on startup (via init script or `mc` sidecar container)
- Backend skeleton: Express app, health-check endpoint, environment-based config (bucket name, MinIO endpoint/credentials, max file size constant)
- Frontend skeleton: Angular app shell, basic routing, environment config pointing to backend API
- SQLite (or Postgres) container/volume wired up, with a minimal migration for an `uploads` table (id, filename, size, mime_type, status, storage_key, created_at, updated_at)
- Test runner setup: Jest (or similar) for backend, Karma/Jasmine or Jest for Angular unit tests, Playwright (recommended) for E2E upload tests
- `README.md` documenting `docker-compose up`, ports, and how to run tests

**Acceptance criteria:** `docker-compose up` brings up all services; frontend reachable in browser; backend health endpoint returns 200; backend can write/read a test object to/from MinIO; one trivial passing test exists in each test suite (placeholder, proves the pipeline works).

---

## 4. Milestone 1 — Single Large File Upload (Refined)

**Scope:** everything in original M1, built on tus + S3 store per §1.

### Frontend (Angular)
- File selection input (single file)
- Client-side validation: if `file.size > 2 * 1024^3` bytes, show inline error and **do not** start upload
- On valid selection, start tus upload via `tus-js-client`
- Progress bar bound to tus `onProgress(bytesUploaded, bytesTotal)`
- On `onSuccess`: show success state with checkmark icon/animation
- On `onError`: show error message, halt (no auto-retry yet — that's M2)

### Backend (Node/Express)
- Mount `@tus/server` with `@tus/s3-store`, pointed at MinIO
- Configure `maxSize` = 2GB (server-side enforcement; tus responds with `413` if exceeded)
- CORS configured to allow the Angular dev server origin

### Test Requirements
- Generate test files at 100MB, 200MB, 1000MB, 2000MB, 2100MB via script (not committed to repo)
- Automated test matrix:
  - 100MB / 200MB / 1000MB / 2000MB → upload succeeds, object exists in MinIO with correct size, UI shows checkmark
  - 2100MB → rejected client-side (no upload attempt) **and** rejected server-side if client check is bypassed (test by sending the request directly, bypassing the UI check)
- Cleanup step removes generated test files and uploaded MinIO objects after each run

---

## 5. Milestone 2 — Resume, Pause, and Status Visibility (Refined)

**Scope:** everything in M1, plus:

### Frontend
- Status model per file: `idle | uploading | paused | error | success`, each with a distinct visual indicator (icon + color, no aesthetic polish needed)
- Pause button → `tus.abort()` (keeps upload URL for resume)
- Resume button → `tus.start()` against the existing upload URL (continues from last acknowledged offset)
- On error: show "Retry" action that calls resume logic
- Persist tus upload URL + file fingerprint in `localStorage` so a page refresh doesn't lose resumability

### Backend
- Configure tus `expirationPeriodInSeconds` for incomplete uploads
- Add a cleanup job (run on backend startup, and optionally on an interval) that removes expired incomplete multipart uploads from MinIO

### Test Requirements
- Existing M1 size-matrix tests still pass
- **Dropped-connection test**: using Toxiproxy (or custom mid-stream abort harness — pick one and document the choice), interrupt an in-progress upload of a large test file (e.g., 1000MB) at a random byte offset, then trigger resume, and assert: (a) upload completes successfully, (b) final object size matches source file size, (c) checksum (e.g., SHA-256) of uploaded object matches source file
- Pause/resume cycle test: pause mid-upload, wait, resume, assert completion and checksum match

---

## 6. Milestone 3 — Batch Upload (Refined)

**Scope:** everything in M2, plus:

**Processing model:** sequential, one file at a time. The queue processes files in order; only one tus upload session is active at a time. If a file errors, the whole queue pauses on that file and offers **retry** (re-attempt the same file) or **skip** (move to the next file in the queue, leaving the failed file marked as skipped/error). Parallel/concurrent uploads are explicitly **out of scope** for M3 — design the queue manager with per-file state isolated so it could be extended to parallel processing in a future milestone, but do not implement concurrency now.

### Frontend
- File input with `multiple` attribute (multi-select)
- Queue list UI: one row per file showing filename, size, per-file progress bar, and status badge (from M2's status model: `idle | uploading | paused | error | success | skipped | queued`)
- Overall/aggregate progress bar across the whole batch (sum of bytes uploaded / sum of total bytes across all files, including completed and pending ones)
- Only the currently-active file shows live progress; queued files show "waiting"
- On error for the active file: queue pauses, and the UI offers **Retry** (resume/restart that file) and **Skip** (mark as skipped, advance to next file)
- Pause/resume controls (from M2) apply to the currently-active file
- Queue state persisted (e.g., `localStorage`) so a page refresh can recover in-progress batch state and resume from the correct file

### Backend
- No new endpoints required — each file uses its own tus upload session sequentially; the existing M1/M2 tus endpoint handles this naturally since only one session is active at a time

### Test Requirements
- **Unit/integration tests for queue logic with mocked uploads**: replace the actual `tus-js-client` upload calls with a mock/stub that can simulate success, failure, and slow progress on a per-file basis, without performing real network I/O. Test scenarios:
  - All files succeed sequentially → aggregate progress reaches 100%, all statuses = success, files processed in order
  - One file fails mid-queue → queue pauses on that file, aggregate progress stalls, other files remain in "queued" state
  - Retry-after-failure resumes the failed file and continues to the next on success
  - Skip marks the failed file as skipped and advances the queue to the next file
  - Queue persists and correctly resumes from the right file after a simulated page reload
- E2E test with a small batch of real small files (e.g., 3× 10MB) to validate the full sequential pipeline end-to-end (not just mocked)

---

## 7. Milestone 4 — Uploaded Files Visualization & Playback (Refined, pending §7 decisions)

**Scope:** everything in M3, plus:

### Frontend Layout
- Two-column layout: left = upload selection/queue (from M3), right = uploaded files list
- Both columns independently vertically scrollable (fixed-height container with `overflow-y: auto`)
- Video player element docked above the right-column list, initially empty/placeholder
- Clicking a file in the right-column list loads it into the player
- Empty state: if no files uploaded yet, right column shows a placeholder message (no player shown, or player disabled)

### Backend
- **List endpoint** `GET /files`: returns metadata for all completed uploads from the DB (§2.2) — id, filename, size, status, and (if video + probed) duration/resolution/codec
- **Post-upload processing hook**: on tus upload completion, run `ffprobe` against the object (stream from MinIO or probe before/while uploading to MinIO, depending on tus-store internals) to extract codec/duration/resolution, store in DB; classify as "playable" or "preview unavailable" per the codec allowlist (§2.7)
- **Retrieve/stream endpoint** `GET /files/:id/stream`: proxies a ranged `GetObject` request to MinIO, forwarding `Range` headers and returning `206 Partial Content` with appropriate `Content-Range`/`Accept-Ranges` headers — required for `<video>` seeking to work

### Player Behavior
- If selected file's codec is in the playable allowlist → set `<video src>` to the stream endpoint, enable native play/pause controls
- If not playable → show "preview not available for this format" message instead of attempting playback
- Handle the case of selecting a non-video file (if file types are general — see §2.9): show a generic "no preview available" state rather than attempting to load it in the player

### Test Requirements
- Small (few-second) test video fixtures in multiple codecs, packaged in a dedicated test-fixtures location (or small docker test image): at least one browser-compatible (H.264/AAC MP4) and one non-compatible (e.g., MPEG-2 or ProRes) sample
- Tests cover: upload → appears in right-column list → metadata correctly probed and stored → compatible file loads into player and `src` resolves to a working stream URL → incompatible file shows "preview unavailable" → empty-list state renders correctly when no files exist
- Streaming endpoint test: request with `Range: bytes=0-1023` returns `206` with correct `Content-Range` and exactly 1024 bytes

---

## 8. Stretch Goal — Playback/Use During Upload (Scoping Notes)

The idea of using a file "while it's being uploaded" to S3-compatible storage is genuinely advanced and worth scoping carefully **after** M1–M4 are stable:

- **Why it's hard:** S3's multipart upload API does not support reading an object until `CompleteMultipartUpload` is called — there's no native "read the parts uploaded so far" operation. MinIO has the same constraint, as it implements the S3 API.
- **Feasible approach for a proof-of-concept:** write incoming chunks to a local temp file (in addition to, or instead of, streaming to S3) and expose a "read what's written so far" endpoint with `Range` support against that temp file — effectively progressive download of an in-progress upload. Once upload completes, move/copy the file to MinIO as the final step.
- **Recommendation:** treat this explicitly as a **proof-of-concept / spike**, not a production feature, given the architectural complexity it introduces (dual-write paths, consistency between temp storage and final S3 object, cleanup of temp files).

---

## 9. Recommended Tech Stack Summary

| Layer | Recommendation |
|---|---|
| Frontend framework | Angular (as specified) |
| Resumable upload client | `tus-js-client` |
| Backend framework | Node.js + Express |
| Resumable upload server | `@tus/server` + `@tus/s3-store` |
| Object storage | MinIO (`minio/minio` Docker image) |
| Metadata DB | SQLite (simplest) or Postgres |
| Video probing | `ffprobe` (via `fluent-ffmpeg` or direct CLI calls) — requires `ffmpeg` installed in backend image |
| Backend tests | Jest |
| Frontend/E2E tests | Playwright |
| Network-failure simulation (M2) | Toxiproxy (docker-compose service) |
| Orchestration | `docker-compose.yml`, 3–4 services (frontend, backend, minio, optional toxiproxy) |

---

## 10. Open Questions Requiring a Decision

1. **Batch error handling (§2.5/2.6):** When one file in a batch errors, should the *entire batch* pause (sequential model, matches the literal brief), or should that file show an error/retry-skip state while *other files continue uploading* (parallel model, generally better UX/throughput)?
2. **Codec handling (§2.7):** Is "codec mismatch handling" satisfied by *detection + friendly fallback message* for unplayable formats, or does it require actual **transcoding** to a browser-compatible format (significant additional scope: ffmpeg pipeline, transcode job queue, storage for derivatives)?
3. **File type scope (§2.9):** Is the platform **video-only**, or general-purpose file upload where video is just the one type that gets a player (other types appear in the list without preview)?
4. **Auth (§2.10):** Confirm single-user/no-auth is acceptable for all milestones, or should basic auth be added to the scope (and if so, at which milestone)?
5. **Concurrency model (§2.6):** For batch uploads, sequential one-at-a-time, or parallel with a concurrency cap (e.g., 3)? This interacts directly with question 1.
