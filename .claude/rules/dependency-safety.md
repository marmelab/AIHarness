# Dependency safety

## Principle

- The agent never installs a new package without explicit user validation for THIS
  specific package. `npm install`/`pnpm install`/`yarn install` (with no argument, to
  install dependencies already declared in the lockfile) remain allowed; `npm install <pkg>`
  or equivalent with a package name as argument must be blocked by default (see
  `settings.json.example`, `permissions.deny` section) and triggers a validation request.
- Before approving a new dependency, check: minimum age (at least 21 days since publication),
 download/maintainer count, presence of known
  security advisories (npm audit, Snyk).
- A restrictive project-level `.npmrc` is a first filter, not a guarantee: blocking via
  permissions remains the most reliable safeguard (~100% respected vs ~70% for a
  CLAUDE.md rule and ~30% for a simple post-action warning).

## Vigilance on third-party skills and MCP servers

- Treat a downloaded third-party skill or plugin (public marketplace, external GitHub
  repo) with the same caution as an npm dependency: security analyses published on
  these ecosystems have found significant vulnerability rates on third-party skills,
  sometimes including hardcoded secrets or malicious payloads.
- Pin an MCP server's version once validated rather than letting it auto-update: a
  server approved once could, in theory, change behavior on a later update without
  new explicit user validation.

## What remains the team's responsibility

- Automatic blocking and security monitoring reduce the risk but don't eliminate it:
  a dedicated periodic security review remains necessary, particularly for any code
  touching authentication, payments or sensitive data.
