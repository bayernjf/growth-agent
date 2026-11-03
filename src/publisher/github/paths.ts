// Publish path safety (review F-09): a draft slug flows from the inbox into
// `files[].path` and lands at PUT /repos/:owner/:repo/contents/:path with the
// bot PAT. An unchecked slug like `../../.github/workflows/x.yml` would let a
// poisoned draft write arbitrary repo paths — including Actions workflows,
// which is privilege escalation. Validate at the write boundary, before any
// network call.

import { GrowthAgentErrors } from '../../errors.js';

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// Characters git itself forbids in ref/path-ish positions; `\` is a Windows
// separator that must never act as one here.
const FORBIDDEN_CHARS = /[~^:?*[\]\\]/;

/**
 * Throws GrowthAgentError(VALIDATION) unless `path` is a safe repository-
 * relative POSIX path: non-empty, relative, no `..` segments, never under
 * `.github/`, no control or git-forbidden characters.
 */
export function assertSafePublishPath(path: string): void {
  const reject = (reason: string): never => {
    throw GrowthAgentErrors.validation(`unsafe publish path: ${reason}`, { path });
  };

  if (path === '') reject('empty');
  if (path.startsWith('/') || path.endsWith('/')) reject('absolute or trailing-slash');
  if (/^[A-Za-z]:/.test(path)) reject('windows drive letter');
  if (CONTROL_CHARS.test(path)) reject('control characters');
  if (FORBIDDEN_CHARS.test(path)) reject('git-forbidden characters');

  const segments = path.split('/');
  if (segments.some(seg => seg === '..' || seg === '.')) reject('dot segments');
  if (segments[0]?.toLowerCase() === '.github') reject('.github/ prefix is privileged');
}
