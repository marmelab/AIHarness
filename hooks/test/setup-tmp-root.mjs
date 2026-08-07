import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const throwawayTmpRoot = mkdtempSync(join(tmpdir(), "harness-test-tmp-"));
process.env.HARNESS_TMP_ROOT = throwawayTmpRoot;

// The suite spawns hooks with `{ ...process.env, ... }`, so anything the developer's own
// shell exports leaks into every test. Claude Code exports CLAUDE_CODE_SESSION_ID, which
// is one of the sources a hook resolves its session id from: a test that never sets
// session_id then silently borrows the id of the session RUNNING the tests, passes there,
// and fails in CI and in any plain shell. Clear it here so the suite tests the payload it
// was given and nothing else. A test that wants the variable sets it on its own child.
delete process.env.CLAUDE_CODE_SESSION_ID;
// Same class: a managed launcher's session dir would redirect verdict flags and results
// away from where the tests look for them.
delete process.env.CHAT_SESSION_DIR;

afterAll(() => {
  rmSync(throwawayTmpRoot, { recursive: true, force: true });
});
