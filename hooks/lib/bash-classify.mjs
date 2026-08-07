// Is a Bash call "work", or is it free?
//
// The circuit breaker exists to catch a stuck WORK loop. Read-only exploration, git
// plumbing and the progress-log appends the technical persona requires are not work, and
// counting them means the breaker fires on a healthy agent that explored a lot.
//
// Classification is prefix-tolerant on purpose. A real agent's command rarely starts with
// the verb: it starts with a `cd` into its worktree, an env assignment, a subshell, or a
// loop header. Only stripping `cd <path> &&` counted a read-only `L=x; grep ...` audit as
// work.

// Commands that only read. `sed` is absent deliberately: `sed -i` writes.
const READONLY = new Set([
  "grep",
  "rg",
  "egrep",
  "fgrep",
  "find",
  "ls",
  "cat",
  "wc",
  "head",
  "tail",
  "pwd",
  "tree",
  "stat",
  "file",
  "which",
  "echo",
  "dirname",
  "basename",
  "realpath",
  "awk",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "column",
  "test",
  "true",
  "false",
]);

const GIT_FREE = new Set([
  "add",
  "commit",
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "rev-list",
  "stash",
  "worktree",
  "ls-files",
  "merge-base",
  "for-each-ref",
  "show-ref",
]);

// The technical persona REQUIRES an append per step, so counting those spends the budget
// on the very bookkeeping the harness asked for.
const PROGRESS_APPEND = />>?\s*["']?\S*harness-progress\.log/;

// Peel off everything that can precede the verb, repeatedly, because they combine:
//   cd /wt && FOO=1 grep ...
//   ( cd /wt; L=x; grep ... )
//   for f in *.ts; do grep ...
const PREFIXES = [
  /^\(\s*/, //                       an opening subshell paren
  /^\{\s*/, //                       a brace group
  /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, //   cd, quoted or not
  /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:;|&&)?\s*/, // FOO=bar[; ]
  /^(?:for|while|until)\s+[^;]*;\s*do\s+/, //          a loop header
  /^do\s+/,
  /^then\s+/,
  /^if\s+/,
  /^time\s+/,
  /^exec\s+/,
];

/** Strip shell noise that can sit in front of the actual command. */
export function stripPrefixes(command) {
  let c = String(command || "").trim();
  for (let i = 0; i < 12; i++) {
    const before = c;
    for (const re of PREFIXES) c = c.replace(re, "").trim();
    if (c === before) break;
  }
  return c;
}

// Redirects that say nothing about whether the call did work, stripped before the write
// test reads what is left. `2>/dev/null` is the commonest exploration idiom there is, and
// counting its `>` as a file write charged the budget for `grep ... 2>/dev/null`, which is
// the exact false positive the sliding window exists to avoid. A capture of stderr alone
// does not make a reader a writer either: a stage that really works is still caught by its
// verb, since `node`, `npm` and friends are not in READONLY.
const DISCARDED_OUTPUT = /(?:\d*|&)>>?\s*\/dev\/null/g;
const STDERR_ONLY = /2>>?\s*(?!&)\S+/g;

// A redirect into a file makes a pipeline a writer, whatever its verbs. `2>&1` and `>&2`
// are not file writes, and the progress-log append is handled before this is consulted.
const WRITES_A_FILE = />>?\s*(?!&)/;

/**
 * Blank out the CONTENT of quoted spans, keeping the quotes and the length.
 *
 * Every regex below reads shell punctuation, and none of it means anything inside quotes:
 * `grep "a;b" f` split into two commands whose second one had no known verb, and
 * `echo "a -> b"` read as a redirect into a file. Both were counted as work.
 *
 * @param {string} command
 * @returns {string} the command with quoted content replaced by `x`
 */
export function maskQuoted(command) {
  let out = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        out += "xx";
        i++;
        continue;
      }
      if (ch === quote) {
        quote = "";
        out += ch;
        continue;
      }
      out += "x";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      out += ch + command[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// Pieces that are shell structure, not a command: a loop or conditional header, and the
// keywords that close them. Splitting on `;` turns `for f in *.ts; do grep ...; done` into
// three pieces, and only the middle one is a command to classify.
const STRUCTURE = new Set([
  "done",
  "fi",
  "esac",
  "then",
  "else",
  "elif",
  "do",
  "}",
  ")",
  "{",
  "(",
]);
const HEADER = /^(?:for|while|until|if|case)\b/;

const isStructure = (piece) => {
  const p = piece
    .trim()
    .replace(/[)}\s]+$/, "")
    .trim();
  if (!p) return true;
  if (STRUCTURE.has(p)) return true;
  return HEADER.test(p);
};

const isFreeStage = (stage) => {
  const s = stage.trim().replace(/^[!\s]+/, "");
  if (!s) return true; // an empty stage (trailing pipe) decides nothing
  const first = s.split(/\s+/)[0] || "";
  if (READONLY.has(first)) return true;
  const gm = s.match(/^git\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?(\S+)/);
  return Boolean(gm && GIT_FREE.has(gm[1]));
};

/**
 * True when the call costs nothing against the work budget.
 *
 * EVERY stage of the pipeline has to be free: `grep x | node transform.mjs` is work, and
 * checking only the first stage would have called it exploration.
 *
 * @param {string} raw  The Bash tool's command.
 * @returns {boolean}
 */
export function isFreeCommand(raw) {
  const command = String(raw || "");
  if (!command.trim()) return true;
  // On the RAW text: the progress log is recognised by its path, which masking would blank.
  if (PROGRESS_APPEND.test(command)) return true;

  // Everything past this point reads punctuation, so it reads the masked text with the
  // redirects that decide nothing already removed.
  const stripped = stripPrefixes(
    maskQuoted(command).replace(DISCARDED_OUTPUT, "").replace(STDERR_ONLY, ""),
  );
  if (!stripped) return true;
  // Anything after `&&`, `;` or `||` is a separate command; classify them all, so
  // `grep x && node build.mjs` is work.
  const commands = stripped.split(/&&|\|\||;/);
  return commands.every((cmd) => {
    const c = stripPrefixes(cmd);
    if (!c) return true;
    if (isStructure(c)) return true;
    if (WRITES_A_FILE.test(c)) return false;
    return c.split("|").every(isFreeStage);
  });
}
