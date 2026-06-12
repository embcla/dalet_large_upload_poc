#!/bin/sh
# One-shot MinIO setup, run by the `minio-init` compose service.
#
# - Creates the media bucket.
# - Creates a least-privilege service account (used by the backend) scoped to
#   that bucket via policy.json, instead of using the MinIO root credentials.
# - §2.11 backstop: incomplete multipart uploads are auto-aborted by MinIO's
#   built-in stale-upload cleanup (api.stale_uploads_expiry /
#   api.stale_uploads_cleanup_interval, default 24h / 6h). A per-bucket
#   AbortIncompleteMultipartUpload lifecycle rule is not used here -- it is
#   rejected by current MinIO server releases ("does not validate against our
#   published schema" / InvalidArgument).
set -eu

mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

mc mb --ignore-existing "local/$MINIO_BUCKET"

mc admin policy create local media-uploader-policy /etc/minio-init/policy.json

if mc admin user info local "$MINIO_SERVICE_ACCESS_KEY" >/dev/null 2>&1; then
  echo "Service account '$MINIO_SERVICE_ACCESS_KEY' already exists, skipping creation."
else
  mc admin user add local "$MINIO_SERVICE_ACCESS_KEY" "$MINIO_SERVICE_SECRET_KEY"
fi

mc admin policy attach local media-uploader-policy --user "$MINIO_SERVICE_ACCESS_KEY"

echo "MinIO bucket '$MINIO_BUCKET' and service account '$MINIO_SERVICE_ACCESS_KEY' are ready."
