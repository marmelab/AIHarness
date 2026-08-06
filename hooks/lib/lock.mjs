// Best-effort advisory lock: atomic mkdir, bounded spin, stale steal.
//
// Two hooks serialise a critical region with it and must not drift, so the pattern
// lives here once (rules/hook-authoring.md: two hooks that must agree share the
// predicate):
//
//   setup-worktree   a wave dispatches N developers in ONE orchestrator message, so
//                    N PreToolUse hooks fire nearly together and race on
//                    session-branch / _session creation and git's own worktree locks.
//                    It WAITS for the lock, because every dispatch must be provisioned.
//   validate-on-stop two stops 7 seconds apart raced on the git index through the
//                    formatter's auto-commit step. It does NOT wait: a concurrent
//                    chain on the same worktree is redundant work, so the second one
//                    skips.
//
// Advisory on purpose. If the lock cannot be taken for any reason other than "someone
// holds it", the caller proceeds unlocked: a lock that can wedge a pipeline is worse
// than the race it prevents. The stale steal is what keeps a crashed holder from
// disabling the region forever.

import { mkdirSync, rmSync, rmdirSync, statSync } from "node:fs";

export const LOCK_ACQUIRE_TIMEOUT_MS = 20_000;
export const LOCK_STALE_MS = 60_000;
export const LOCK_SPIN_MS = 100;

const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Try to take `lockDir`.
 *
 * @param {string} lockDir  Directory to create as the lock. Its parent must exist.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  How long to keep retrying. 0 (the default) is a
 *   single attempt: use it when a concurrent holder means "skip", not "wait".
 * @param {number} [options.staleMs]  A lock older than this is stolen.
 * @param {number} [options.spinMs]  Pause between attempts.
 * @returns {{ locked: boolean, held: boolean, release: () => void }}
 *   `locked` is true when this process owns it. `held` distinguishes the two reasons a
 *   caller may not own it: someone else holds it (`held`), versus the lock could not be
 *   created at all (`!held`, proceed unlocked). `release` is idempotent, so it is safe
 *   to call at the end of the region AND again from an exit handler.
 */
export function acquireLock(
  lockDir,
  { timeoutMs = 0, staleMs = LOCK_STALE_MS, spinMs = LOCK_SPIN_MS } = {},
) {
  let locked = false;
  let held = false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      locked = true;
      held = false;
      break;
    } catch (e) {
      if (e.code !== "EEXIST") break; // cannot lock at all: proceed unlocked
      held = true;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue; // steal it
        }
      } catch {
        continue; // vanished between the two calls: retry immediately
      }
      if (Date.now() >= deadline) break;
      sleepSync(spinMs);
    }
  }

  const release = () => {
    if (!locked) return;
    try {
      rmdirSync(lockDir);
    } catch {
      // best-effort
    }
    locked = false;
  };

  return {
    get locked() {
      return locked;
    },
    held,
    release,
  };
}
