#!/bin/sh
# Build the frontend Docker image without going through docker-compose.
set -eu
cd "$(dirname "$0")/.."

docker build -f docker-images/frontend/Dockerfile -t media-upload-frontend:latest frontend
