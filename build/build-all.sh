#!/bin/sh
# Build all Docker images for the stack.
set -eu
cd "$(dirname "$0")"

./build-backend.sh
./build-frontend.sh
