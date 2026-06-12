// Generates a sparse file of an exact byte size for upload tests, using
// `fallocate` (Linux). The content is zero bytes, which is fine for size and
// checksum comparisons since tus/S3 transfer the actual (zero) bytes.
const { execFileSync } = require('child_process');

/**
 * @param {string} filePath
 * @param {number} sizeBytes
 */
function generateFile(filePath, sizeBytes) {
  execFileSync('fallocate', ['-l', String(sizeBytes), filePath]);
}

module.exports = { generateFile };
