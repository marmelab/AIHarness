// Does the LSP server answer for THIS workspace?
//
// `--version` proves the binary resolves and nothing else. Three ways the tool was dead
// while that probe reported OK, all three observed on a real machine:
//
//   1. the binary was not installed at all             -> --version catches this one
//   2. the workspace had no `typescript` to drive      -> "Could not find a valid
//                                                         TypeScript installation"
//   3. the workspace was on TypeScript 7, the native rewrite, which ships no
//      `tsserver.js`                                   -> "provides no tsserver.js"
//
// Cases 2 and 3 appear only at `initialize`, which is where the server picks up the
// workspace, so that is what this probes. The client is written by hand because the repo
// takes no runtime dependencies.
//
// It has to be asynchronous: `spawnSync` with `input` closes stdin as soon as it has
// written, and the server treats that EOF as a disconnect and exits 1 having printed
// nothing at all. The pipe must stay open until the answer comes back.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** One LSP message, in the `Content-Length` framing the protocol requires. */
const frame = (msg) => {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
};

/**
 * Run an `initialize` handshake against a server and say whether it answered.
 *
 * @param {string} command
 * @param {string[]} args  as declared, `--stdio` included: unlike the version probe this
 *   one IS a client, so the server must speak the protocol.
 * @param {string} root  the workspace the server is asked to serve
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export function initializeProbe(command, args, root, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, detail: String(e.message).slice(0, 200) });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(res);
    };

    const timer = setTimeout(
      () =>
        done({
          ok: false,
          detail:
            firstLine(err) ||
            `no answer within ${Math.round(timeoutMs / 1000)}s`,
        }),
      timeoutMs,
    );

    child.stdout.on("data", (d) => {
      out += d;
      // The reply to id 1 is the only thing that settles it.
      if (/"id"\s*:\s*1\b/.test(out)) {
        if (/"result"\s*:/.test(out))
          done({ ok: true, detail: serverName(out) });
        else if (/"error"\s*:/.test(out))
          done({ ok: false, detail: errorMessage(out) });
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
    });

    child.on("error", (e) =>
      done({
        ok: false,
        detail:
          e.code === "ENOENT"
            ? `\`${command}\` is not on PATH`
            : String(e.message).slice(0, 200),
      }),
    );

    // A server that dies during initialize never writes a reply, and says why on stderr.
    child.on("close", (code) =>
      done({
        ok: false,
        detail:
          firstLine(err) ||
          firstLine(out) ||
          `server exited (${code}) without answering`,
      }),
    );

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            processId: null,
            rootUri: pathToFileURL(root).href,
            capabilities: {},
            workspaceFolders: null,
          },
        }),
      );
      // stdin stays open on purpose: closing it here is the EOF the server quits on.
    } catch (e) {
      done({ ok: false, detail: String(e.message).slice(0, 200) });
    }
  });
}

/** The server's own name and version, when it volunteers them in the initialize result. */
function serverName(out) {
  const name = out.match(/"serverInfo"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/);
  const version = out.match(
    /"serverInfo"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]+)"/,
  );
  if (!name) return "initialize answered";
  return version ? `${name[1]} ${version[1]}` : name[1];
}

function errorMessage(out) {
  const m = out.match(/"error"\s*:\s*\{[^}]*?"message"\s*:\s*"([^"]+)"/);
  return m ? clip(m[1]) : "initialize returned an error";
}

function firstLine(s) {
  const line = String(s || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return line === undefined ? undefined : clip(line);
}

/**
 * Trim to one readable line. The cut lands wherever it lands, and a server message that
 * ends mid-escape reads as a corrupted check rather than a diagnosis, so the dangling
 * backslash goes with it.
 */
function clip(text) {
  return text.slice(0, 220).replace(/\\+$/, "").trimEnd();
}
