// The difficulty tier that sizes a review: trivial | normal | hard | critical.
//
// Two inputs, and the higher wins: the planner's scorecard (its judgement before any code
// exists) and the real diff of the worktree (what actually happened). Anderson's rule and
// thresholds (amj-lang/anderson, docs/tiering.md): CRITICAL and HARD fire on any ONE bad
// dimension, TRIVIAL needs every dimension good, so the bias is toward escalation. The
// cost of over-reviewing is tokens; the cost of under-reviewing is a shipped bug.
//
// Consumed by route-review-model (which picks the reviewer's model from the tier) and read
// by the quality-reviewer through the REVIEW_TIER line the hook writes into its dispatch.

import { exec } from "./process.mjs";

export const TIERS = ["trivial", "normal", "hard", "critical"];

const isScore = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {unknown} sc  {risk, coupling, confidence, testability}, each 1 to 10.
 * @returns {string | null}  null when the scorecard is absent or incomplete.
 */
export function tierFromScorecard(sc) {
  if (!sc || typeof sc !== "object") return null;
  const { risk, coupling, confidence, testability } = sc;
  if (![risk, coupling, confidence, testability].every(isScore)) return null;
  if (risk >= 9 || testability >= 7) return "critical";
  if (risk >= 7 || coupling >= 7 || confidence <= 4) return "hard";
  if (risk <= 2 && coupling <= 3 && confidence >= 8) return "trivial";
  return "normal";
}

/**
 * @param {{files: number, lines: number}} stats
 * @returns {string}
 */
export function tierFromDiff({ files, lines }) {
  if (files >= 8 || lines >= 150) return "hard";
  if (files <= 2 && lines <= 30) return "trivial";
  return "normal";
}

/**
 * The highest of the given tiers; null and unknown values are ignored; "normal" when
 * nothing usable was given.
 * @param {...(string | null | undefined)} tiers
 * @returns {string}
 */
export function maxTier(...tiers) {
  let best = -1;
  for (const t of tiers) {
    const i = TIERS.indexOf(t);
    if (i > best) best = i;
  }
  return best === -1 ? "normal" : TIERS[best];
}

/**
 * Files and changed lines (insertions + deletions) between `baseRef` and HEAD in
 * `worktree`. Two git calls, both read-only.
 * @param {string} worktree
 * @param {string} baseRef
 * @returns {{files: number, lines: number} | null}  null when git cannot answer.
 */
export function diffStats(worktree, baseRef) {
  const names = exec("git", [
    "-C",
    worktree,
    "diff",
    "--name-only",
    `${baseRef}..HEAD`,
  ]);
  if (names.status !== 0) return null;
  const files = names.stdout.split("\n").filter((l) => l.trim()).length;
  const num = exec("git", [
    "-C",
    worktree,
    "diff",
    "--numstat",
    `${baseRef}..HEAD`,
  ]);
  if (num.status !== 0) return null;
  let lines = 0;
  for (const row of num.stdout.split("\n")) {
    const [add, del] = row.split("\t");
    lines += (parseInt(add, 10) || 0) + (parseInt(del, 10) || 0);
  }
  return { files, lines };
}
