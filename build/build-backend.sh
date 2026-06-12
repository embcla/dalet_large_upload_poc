#!/bin/sh
# Build the backend Docker image without going through docker-compose.
set -eu
cd "$(dirname "$0")/.."

docker build -f docker-images/backend/Dockerfile -t media-upload-backend:latest backend
