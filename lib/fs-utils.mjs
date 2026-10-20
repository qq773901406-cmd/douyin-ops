import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, isAbsolute, sep } from 'node:path';

// Streaming SHA-256 of a file. Used for tamper checks across the workbench
// (previously re-implemented in automation-service, daily-production and
// bilibili-workflow with the same code). Centralising it removes the drift risk
// and keeps the hashing contract in one place.
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// True when `path` resolves within `root` (no `..` escape, no absolute override).
// Replaces the near-identical `inside`/`contained` helpers that lived in three
// modules.
export function isInside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
