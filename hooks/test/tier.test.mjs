// Tests for lib/tier.mjs: the difficulty tier that sizes a review. The thresholds are
// anderson's (docs/tiering.md there); what matters here is that every boundary is pinned
// on both sides and that the tier can only escalate.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  TIERS,
  diffStats,
  maxTier,
  tierFromDiff,
  tierFromScorecard,
} from "../lib/tier.mjs";

const sc = (risk, coupling, confidence, testability) => ({
  risk,
  coupling,
  confidence,
  testability,
});

describe("tierFromScorecard", () => {
  test("critical on risk >= 9, or testability >= 7, whatever the rest", () => {
    expect(tierFromScorecard(sc(9, 1, 10, 1))).toBe("critical");
    expect(tierFromScorecard(sc(1, 1, 10, 7))).toBe("critical");
    expect(tierFromScorecard(sc(8, 1, 10, 6))).not.toBe("critical");
  });
  test("hard on risk >= 7, coupling >= 7, or confidence <= 4", () => {
    expect(tierFromScorecard(sc(7, 1, 10, 1))).toBe("hard");
    expect(tierFromScorecard(sc(1, 7, 10, 1))).toBe("hard");
    expect(tierFromScorecard(sc(1, 1, 4, 1))).toBe("hard");
    expect(tierFromScorecard(sc(6, 6, 5, 1))).toBe("normal");
  });
  test("trivial needs all three: risk <= 2, coupling <= 3, confidence >= 8", () => {
    expect(tierFromScorecard(sc(2, 3, 8, 1))).toBe("trivial");
    expect(tierFromScorecard(sc(3, 3, 8, 1))).toBe("normal");
    expect(tierFromScorecard(sc(2, 4, 8, 1))).toBe("normal");
    expect(tierFromScorecard(sc(2, 3, 7, 1))).toBe("normal");
  });
  test("null when the scorecard is missing or incomplete", () => {
    expect(tierFromScorecard(undefined)).toBeNull();
    expect(tierFromScorecard({ risk: 3 })).toBeNull();
    expect(
      tierFromScorecard({
        risk: "3",
        coupling: 1,
        confidence: 9,
        testability: 1,
      }),
    ).toBeNull();
  });
});

describe("tierFromDiff", () => {
  test("hard from 8 files or 150 lines", () => {
    expect(tierFromDiff({ files: 8, lines: 10 })).toBe("hard");
    expect(tierFromDiff({ files: 1, lines: 150 })).toBe("hard");
    expect(tierFromDiff({ files: 7, lines: 149 })).toBe("normal");
  });
  test("trivial up to 2 files and 30 lines", () => {
    expect(tierFromDiff({ files: 2, lines: 30 })).toBe("trivial");
    expect(tierFromDiff({ files: 3, lines: 30 })).toBe("normal");
    expect(tierFromDiff({ files: 2, lines: 31 })).toBe("normal");
  });
});

describe("maxTier", () => {
  test("follows TIERS order and ignores null or unknown values", () => {
    expect(TIERS).toEqual(["trivial", "normal", "hard", "critical"]);
    expect(maxTier("trivial", "hard", "normal")).toBe("hard");
    expect(maxTier(null, "trivial")).toBe("trivial");
    expect(maxTier("bogus", null)).toBe("normal");
    expect(maxTier()).toBe("normal");
  });
});

describe("diffStats", () => {
  let repo;
  const git = (...args) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "tier-git-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("tag", "base");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    git("add", "-A");
    git("commit", "-qm", "work");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("counts files and changed lines between a base ref and HEAD", () => {
    expect(diffStats(repo, "base")).toEqual({ files: 2, lines: 3 });
  });
  test("null when the ref does not exist or the dir is not a repo", () => {
    expect(diffStats(repo, "nope")).toBeNull();
    expect(diffStats(tmpdir(), "base")).toBeNull();
  });
});
