// Tests for the LSP initialize probe.
//
// The probe exists because `--version` reported OK through three different ways of the
// tool being dead. Each of those ways is a case here, played by a stand-in server, so the
// probe is pinned against the shapes it was written for rather than against a live
// typescript-language-server, which would make the suite need a network and a toolchain.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { initializeProbe } from "../lib/lsp-probe.mjs";

let TMP = null;

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

/** Write a stand-in server and return [command, args] for it. */
const server = (source) => {
  TMP = mkdtempSync(join(tmpdir(), "lsp-probe-"));
  const file = join(TMP, "server.mjs");
  writeFileSync(file, source);
  return ["node", [file, "--stdio"]];
};

/**
 * Answers initialize, and quits on EOF the way typescript-language-server does.
 *
 * The delay before answering and the exit on `end` together reproduce the behaviour that
 * broke the first version of the probe: a client that writes and immediately closes stdin
 * gets a silent exit 1, not an answer. Without both, the test passes against a probe that
 * closes the pipe too early, which is the bug.
 */
const GOOD = `
import { stdin, stdout } from "node:process";
let buf = "";
stdin.on("data", (d) => {
  buf += d;
  if (!buf.includes('"initialize"')) return;
  buf = "";
  setTimeout(() => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: {}, serverInfo: { name: "stand-in", version: "1.2.3" } },
    });
    stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
  }, 200);
});
stdin.on("end", () => process.exit(1));
setInterval(() => {}, 1000);
`;

/** The TypeScript 7 and the no-typescript shapes: dies at initialize, says why. */
const DIES = `
import { stderr } from "node:process";
stderr.write("Request initialize failed with message: provides no tsserver.js. Exiting.\\n");
process.exit(1);
`;

/** Answers, but with a protocol error rather than a result. */
const REFUSES = `
import { stdin, stdout } from "node:process";
stdin.on("data", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "workspace not supported" },
  });
  stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
});
setInterval(() => {}, 1000);
`;

/** Starts, says nothing, never answers. The timeout is the only way out. */
const MUTE = `setInterval(() => {}, 1000);`;

describe("initializeProbe", () => {
  test("a server that answers initialize is reported with its own name", async () => {
    const [cmd, args] = server(GOOD);
    const r = await initializeProbe(cmd, args, TMP, 20000);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("stand-in 1.2.3");
  });

  test("a server that dies at initialize is reported with what it said", async () => {
    // This is the whole point: `--version` would have passed here, and the message the
    // server prints is the diagnosis. TypeScript 7 produces exactly this shape.
    const [cmd, args] = server(DIES);
    const r = await initializeProbe(cmd, args, TMP, 20000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no tsserver.js");
  });

  test("a protocol error is not mistaken for an answer", async () => {
    const [cmd, args] = server(REFUSES);
    const r = await initializeProbe(cmd, args, TMP, 20000);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("workspace not supported");
  });

  test("a missing binary is named, not reported as a protocol failure", async () => {
    TMP = mkdtempSync(join(tmpdir(), "lsp-probe-"));
    const r = await initializeProbe(
      "no-such-language-server",
      ["--stdio"],
      TMP,
      20000,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not on PATH");
  });

  test("a server that never answers times out instead of hanging the check", async () => {
    const [cmd, args] = server(MUTE);
    const started = Date.now();
    const r = await initializeProbe(cmd, args, TMP, 1500);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no answer within");
    expect(Date.now() - started).toBeLessThan(10000);
  });

  test("stdin stays open long enough for the answer", async () => {
    // The first version used spawnSync with `input`, which closes stdin as soon as it has
    // written. typescript-language-server read that EOF as a disconnect and exited 1
    // having printed nothing, so the probe failed against a workspace that worked. The
    // stand-in only answers on a `data` event, so a premature close fails this test.
    const [cmd, args] = server(GOOD);
    const r = await initializeProbe(cmd, args, TMP, 20000);
    expect(r.ok).toBe(true);
  });
});
