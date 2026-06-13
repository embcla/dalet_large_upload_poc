#!/bin/sh
# One-shot toxic setup, run by the `toxiproxy-init` compose service.
#
# Throttles the browser -> backend direction of the `backend_api` proxy so
# uploads take long enough to be visible in the UI (progress bar,
# pause/resume). The host-side test harness and integration tests talk to the
# backend directly on its own port (bypassing toxiproxy), so this does not
# affect test speed.
set -eu

PROXY=backend_api
TOXIC=upload-bandwidth

# Idempotent: drop any existing toxic with this name before (re-)creating it
# with the current rate from .env.
curl -sf -X DELETE "http://toxiproxy:8474/proxies/${PROXY}/toxics/${TOXIC}" >/dev/null 2>&1 || true

curl -sf -X POST "http://toxiproxy:8474/proxies/${PROXY}/toxics" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"${TOXIC}\",\"type\":\"bandwidth\",\"stream\":\"upstream\",\"attributes\":{\"rate\":${UPLOAD_THROTTLE_RATE_KB}}}" \
  >/dev/null

echo "Throttled browser -> backend uploads to ${UPLOAD_THROTTLE_RATE_KB} KB/s."
