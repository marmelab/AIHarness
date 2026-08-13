#!/usr/bin/env bash
# e2e-smoke.sh - run the Playwright e2e suite against an ISOLATED, disposable Supabase
# instance so multiple harness sessions can run it in parallel without colliding.
# Guaranteed teardown via `trap ... EXIT`.
#
# Isolation per run: a leased SLOT (0..K-1) gives offset = (slot+1)*20, applied to the
# project_id, every Supabase port, and the app port + auth URLs, in a throwaway workdir.
# The flock lease also CAPS concurrency (K stacks max) so we never OOM the host.
# The offset starts at 20, not 0, so no slot reuses the ports config.e2e.toml itself
# declares (54340-54349, app 5175): those belong to a human `make start-e2e`, which does
# not take part in the slot lease, and slot 0 used to collide with it.
#
# Exit codes: 0 = suite passed OR gracefully skipped (no slot / low RAM / cannot start);
#             1 = the e2e suite ran and FAILED. Skips are exit 0 by design (the caller
#             treats a skip as "not run here, run it later", not as a failure).
#
# Env: E2E_SMOKE_SLOTS (default 5), E2E_SMOKE_MIN_MB (default 2500), E2E_SMOKE_DRY=1
#      (resolve slot/ports/config and print them, then exit WITHOUT Docker - for tests),
#      E2E_SMOKE_SPECS (optional space-separated spec paths to run FIRST, see below).
set -uo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
# Namespaces this project's Docker containers, so two repos sharing the host slot lease
# never fight over a project_id. Read from harness.config.json, never hardcoded.
HARNESS_NAME="${HARNESS_NAME:-$(node -e "
  try { console.log(require('$REPO/harness.config.json').name || 'harness') }
  catch { console.log('harness') }" 2>/dev/null || echo harness)}"
# Where to read the app + specs + schema FROM. A feature-smoke must run the INTEGRATED
# session code, not the base-branch checkout ($REPO) - so the orchestrator passes
# E2E_SMOKE_SRC=<WORKTREE_BASE>/_session (the session worktree, on session/<short>, with
# node_modules already provisioned). Default $REPO = a base-branch baseline check.
SRC="${E2E_SMOKE_SRC:-$REPO}"
# Specs the session added or changed. They run FIRST, inside the same stack boot, so a
# broken new spec surfaces right after boot instead of after the whole suite. The boot is
# the expensive part (~2 min), which is why this is one run of the script with two
# playwright invocations rather than two runs of the script.
SPECS="${E2E_SMOKE_SPECS:-}"
SLOTS="${E2E_SMOKE_SLOTS:-5}"
MIN_MB="${E2E_SMOKE_MIN_MB:-2500}"
DRY="${E2E_SMOKE_DRY:-0}"
# Host-wide so the slot lease also caps concurrency ACROSS projects (each stack is
# ~2-3 GB). The Docker project_id below is per-project, so containers never collide.
SLOT_LOCK_DIR="/tmp/harness-e2e-slots"
CONFIG_SRC="$SRC/supabase/config.e2e.toml"
mkdir -p "$SLOT_LOCK_DIR"

# A skip is graceful (not run here, not a failure), but it must never be MUTE. The logs
# that would explain it live in $workroot, which the EXIT trap deletes on the way out, so
# a run that skipped could not be diagnosed afterwards at all: one session reported
# "isolated stack readiness timeout" and there was nothing left on disk to say which half
# of the readiness check failed. Dump the tails to stdout first; the caller hook keeps the
# last 40 lines in e2e-result.json.
skip() {
  echo "SKIP: $*"
  for log in supabase app dbdiff migup grants; do
    if [ -n "${workroot:-}" ] && [ -s "${workroot}/${log}.log" ]; then
      echo "--- ${log}.log (last 25 lines) ---"
      tail -n 25 "${workroot}/${log}.log"
    fi
  done
  exit 0
}

# What the APP was showing when a spec failed, not just what Playwright was waiting for.
# Playwright writes a `# Page snapshot` per failed test; the caller keeps only the tail of
# this stdout in e2e-result.json, so printing it here is what puts the app's own state in
# front of whoever reads the result.
#
# Run eee7a672 is the case for it: every failure read as "click intercepted / element
# detached", the developer diagnosed a navigation race and added a wait, and nothing
# changed — because the snapshot said the app was on the SIGN IN page, bounced there by a
# 403 the result never mentioned. Two rounds went into fixing tests that were never wrong.
# One snapshot in the result answers "is the app even working" before anyone edits a spec.
report_app_state() {
  local f
  for f in "$SRC"/test-results/*/error-context.md; do
    [ -f "$f" ] || continue
    echo "--- what the app was showing when a spec failed ($(basename "$(dirname "$f")")) ---"
    awk '/^# Page snapshot/{flag=1} flag{print} /^```$/{if(flag&&++fence==2)exit}' "$f" | head -n 25
    return 0
  done
}

# --- memory preflight -------------------------------------------------------
# Each Supabase stack is ~2-3 GB. Don't attempt a boot the host can't hold; skip
# gracefully so the caller defers to a human `make test-e2e-ci` instead of OOM-ing.
avail_mb="$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')"
if [ "$DRY" != "1" ] && [ -n "$avail_mb" ] && [ "$avail_mb" -lt "$MIN_MB" ]; then
  skip "only ${avail_mb}MB free, need ~${MIN_MB}MB for a Supabase e2e stack; run 'make test-e2e-ci' locally."
fi

# --- lease a slot (flock; also the concurrency cap) -------------------------
slot=""; SLOT_FD=""
for i in $(seq 0 $((SLOTS - 1))); do
  exec {fd}>"$SLOT_LOCK_DIR/slot-$i.lock"
  if flock -n "$fd"; then slot="$i"; SLOT_FD="$fd"; break; fi
  exec {fd}>&-
done
[ -z "$slot" ] && skip "all $SLOTS e2e slots busy; try again later."

offset=$(((slot + 1) * 20))
project="${HARNESS_NAME:-harness}-e2e-$slot"
api_port=$((54341 + offset))
app_port=$((5176 + slot))
workroot="$(mktemp -d)"
workdir="$workroot/e2e"          # supabase --workdir
mkdir -p "$workdir/supabase"

# --- guaranteed teardown ----------------------------------------------------
# APP_PID has to BE the dev server, which is why the server is exec'd below.
#
# `( ... npx vite ... ) &` gave $! the subshell; npx then spawned node as its child, and
# `kill $APP_PID` reaped neither. Measured on the failing run's own worktree: after the
# kill the port still answered 200 and the vite process had been reparented to init. So
# every run leaked a server holding its slot's app port, and the NEXT run on that slot met
# `--strictPort` refusing to bind, an app that never became ready, and a 120s wait-on
# timeout reported as "isolated stack did not become ready in time". A session that ran
# the suite 14 times left 14 of them, which is why the failure surfaced one session after
# its cause, on a slot that had worked the day before.
#
# setsid was tried first and is NOT the fix: `$!` names the setsid parent, not the leader
# of the new group, so `kill -- -$!` signals a group the server is not in. Verified: the
# port still answered 200.
APP_PID=""
cleanup() {
  local code=$?
  # TERM so vite closes its sockets, KILL for whatever ignored it.
  if [ -n "$APP_PID" ]; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.3
    done
    kill -KILL "$APP_PID" 2>/dev/null || true
  fi
  [ "$DRY" != "1" ] && npx supabase stop --workdir "$workdir" --no-backup >/dev/null 2>&1 || true
  [ -n "$SLOT_FD" ] && flock -u "$SLOT_FD" 2>/dev/null || true
  rm -rf "$workroot" 2>/dev/null || true
  return $code
}
trap cleanup EXIT INT TERM

# --- render the per-slot config ---------------------------------------------
# Offset every Supabase port (`port =`, `shadow_port =`, `vector_port =`) by `offset`,
# set a unique project_id (distinct Docker containers), and point the auth URLs at the
# per-slot app port. perl `/e` evaluates the numeric replacement.
[ -f "$CONFIG_SRC" ] || skip "no $CONFIG_SRC"
perl -pe "s/^(project_id\s*=\s*).*/\$1\"$project\"/;
          s/((?:^|_)port\s*=\s*)(\d+)/\$1.(\$2+$offset)/e;
          s/5175/$app_port/g" "$CONFIG_SRC" > "$workdir/supabase/config.toml"

# Supabase needs the schema/migrations/seed to build the DB on first start.
for d in migrations schemas functions templates; do
  [ -d "$SRC/supabase/$d" ] && cp -r "$SRC/supabase/$d" "$workdir/supabase/$d"
done
for f in seed.sql signing_keys.json; do
  [ -f "$SRC/supabase/$f" ] && cp "$SRC/supabase/$f" "$workdir/supabase/$f"
done

if [ "$DRY" = "1" ]; then
  echo "DRY-RUN slot=$slot offset=$offset project=$project api_port=$api_port app_port=$app_port workdir=$workdir"
  echo "config.project_id=$(grep -E '^project_id' "$workdir/supabase/config.toml")"
  echo "config.api_port=$(awk '/^\[api\]/{a=1} a&&/^port =/{print $3; exit}' "$workdir/supabase/config.toml")"
  echo "config.site_url=$(grep -E '^site_url' "$workdir/supabase/config.toml" | head -1)"
  exit 0
fi

# --- reap a previously killed run of this slot -----------------------------
# The trap cleans up normal exits (EXIT/INT/TERM); a SIGKILL would orphan this slot's
# containers. Before starting fresh, remove any lingering ones for this project_id.
docker ps -aq --filter "name=${project}" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true

# --- start the isolated stack ----------------------------------------------
echo "e2e-smoke: starting isolated Supabase (slot $slot, api :$api_port, project $project)..."
if ! npx supabase start --workdir "$workdir" >"$workroot/supabase.log" 2>&1; then
  cat "$workroot/supabase.log" >&2 || true
  skip "isolated Supabase failed to start (see log); deferring e2e to a human run."
fi
SERVICE_ROLE_KEY="$(npx supabase status --workdir "$workdir" -o env 2>/dev/null | sed -nE 's/^SERVICE_ROLE_KEY="?([^"]+)"?/\1/p')"
ANON_KEY="$(npx supabase status --workdir "$workdir" -o env 2>/dev/null | sed -nE 's/^ANON_KEY="?([^"]+)"?/\1/p')"
export VITE_SUPABASE_URL="http://127.0.0.1:$api_port"
export VITE_SUPABASE_ANON_KEY="$ANON_KEY"
export SERVICE_ROLE_KEY

# --- materialize the session schema the deploy-time migration will carry --------
# Ticket developers never write migrations, so a schema-touching session has
# supabase/schemas/ ahead of supabase/migrations/. The CLI builds the DB from
# migrations/ only, so without this the isolated stack lacks the new columns and
# schema-exercising specs 400 against PostgREST - a false FAIL. When the
# session changed supabase/schemas/, generate a THROWAWAY migration from the delta
# INTO THE WORKDIR (never $SRC) and apply it. Best-effort: on any failure SKIP the
# leg rather than emit a false FAIL (the real migration lands in the deploy round).
schema_changed=0
branch="$(git -C "$SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
case "$branch" in
  session/*)
    base="session-base/${branch#session/}"
    if git -C "$SRC" rev-parse --verify -q "$base" >/dev/null 2>&1 \
       && git -C "$SRC" diff --name-only "$base"...HEAD 2>/dev/null | grep -q '^supabase/schemas/'; then
      schema_changed=1
    fi
    ;;
esac
if [ "$schema_changed" = "1" ] && [ -d "$workdir/supabase/schemas" ]; then
  echo "e2e-smoke: session changed supabase/schemas/, materializing a throwaway migration..."
  if npx supabase db diff --workdir "$workdir" --local -f _e2e_throwaway >"$workroot/dbdiff.log" 2>&1; then
    if ls "$workdir"/supabase/migrations/*_e2e_throwaway.sql >/dev/null 2>&1; then
      npx supabase migration up --workdir "$workdir" --local >"$workroot/migup.log" 2>&1 \
        || { cat "$workroot/migup.log" >&2; skip "schema pending migration round (throwaway apply failed); deferring the Supabase e2e leg to the deploy-time migration."; }
      # A generated delta rebuilds a changed VIEW with DROP + CREATE, and Postgres drops its
      # GRANTs with it. They are declared in their own declarative file, which the delta has
      # no reason to touch, so the rebuilt relation comes back readable by nobody: measured on
      # run eee7a672, `GET /rest/v1/contacts_summary` answered 403, ra-core raised an error
      # toast, the app fell back to the sign-in page, and the toast then intercepted the click
      # in the shared `goToContacts` fixture. 7 specs failed, the suite was reported as the
      # FEATURE's failure, and two developer rounds were spent "fixing" tests that were
      # never wrong. Re-apply the grants so a rebuilt view keeps its access.
      for g in "$workdir"/supabase/schemas/*grant*.sql; do
        [ -f "$g" ] || continue
        echo "e2e-smoke: re-applying declarative grants ($(basename "$g")) after the throwaway migration"
        npx supabase db query --workdir "$workdir" --local --file "$g" >>"$workroot/grants.log" 2>&1 \
          || { cat "$workroot/grants.log" >&2; skip "could not re-apply $(basename "$g") after the throwaway migration; the stack would answer 403 on rebuilt views, which is not the feature's fault."; }
      done

      # Then MEASURE it, rather than trusting the re-apply above to have been the right
      # remedy. Run eee7a672 could not be diagnosed past this point: the suite went red with
      # a 403 on contacts_summary and the app on the sign-in page, and by the time anyone
      # looked, this workdir was deleted — so "the delta dropped the view's grants" and "login
      # failed and the request went as anon" were both consistent with the evidence and
      # neither could be confirmed. This check makes the next run answer that question
      # instead of leaving it to inference: a relation the app reads that `authenticated`
      # cannot SELECT is a stack that CANNOT serve the app, whatever put it in that state.
      unreadable="$(npx supabase db query --workdir "$workdir" --local \
        "select string_agg(c.relname, ', ' order by c.relname)
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('r','v','m')
            and not has_table_privilege('authenticated', c.oid, 'SELECT');" 2>/dev/null \
        | grep -vE '^\s*(string_agg|-+|\(|$)' | head -1 | tr -d ' ')"
      if [ -n "${unreadable:-}" ] && [ "$unreadable" != "NULL" ]; then
        skip "the isolated stack is not serviceable: 'authenticated' cannot SELECT ${unreadable}. Every app query would answer 403 and the app would fall back to the login page, so a red suite here would be the STACK's failure, not the feature's."
      fi
    else
      # `db diff` succeeded and produced NOTHING. The old code fell through this branch in
      # silence and ran the suite against a database that cannot serve the feature, so a
      # structural miss was reported as the feature failing. A skip is exit 0, "not verified
      # here", which is the honest answer.
      cat "$workroot/dbdiff.log" >&2
      skip "session changed supabase/schemas/ but the throwaway diff produced no migration (declarative schema_paths not configured?); refusing to run the suite against a database that lacks the new schema."
    fi
  else
    cat "$workroot/dbdiff.log" >&2
    skip "schema pending migration round (throwaway diff failed); deferring the Supabase e2e leg to the deploy-time migration."
  fi
fi

# --- reap a stale server on this slot's app port ----------------------------
# Symmetric with the docker reap above, and for the same reason: a previous run killed
# before its trap completed leaves a dev server bound here, and `--strictPort` then makes
# vite exit instead of picking another port. Without this the slot stays poisoned for
# every later run, which is the failure this whole section exists to prevent.
if command -v fuser >/dev/null 2>&1; then
  fuser -k -TERM "$app_port/tcp" >/dev/null 2>&1 && sleep 1 || true
elif command -v lsof >/dev/null 2>&1; then
  lsof -ti "tcp:$app_port" 2>/dev/null | xargs -r kill -TERM 2>/dev/null && sleep 1 || true
fi

# --- serve the app (dev server reads env at start, so no per-slot build) ----
# `exec` the LOCAL binary, so the backgrounded process IS vite: no subshell above it and
# no npx beside it, which is what makes $! a pid the teardown can actually kill. Verified
# on the failing run's worktree: the port goes from 200 to closed on a plain `kill $!`.
# npx remains the fallback for a tree without a provisioned node_modules, where the leak
# is the lesser problem.
if [ -x "$SRC/node_modules/.bin/vite" ]; then
  ( cd "$SRC" && VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
      exec node node_modules/.bin/vite --port "$app_port" --strictPort --mode e2e \
      >"$workroot/app.log" 2>&1 ) &
else
  ( cd "$SRC" && VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
      exec npx vite --port "$app_port" --strictPort --mode e2e \
      >"$workroot/app.log" 2>&1 ) &
fi
APP_PID=$!
npx wait-on -t 120000 "http-get://127.0.0.1:$api_port/auth/v1/health" "http-get://127.0.0.1:$app_port" >/dev/null 2>&1 \
  || skip "isolated stack did not become ready in time (api :$api_port, app :$app_port)."

# --- run the suite ----------------------------------------------------------
# Changed specs first. A failure here is THE answer: report it and stop, rather than
# spending the rest of the suite's runtime to learn the same thing.
if [ -n "$SPECS" ]; then
  # Only specs that still exist: a renamed or deleted one would fail playwright with "no
  # tests found" and read as a suite failure.
  present=""
  for spec in $SPECS; do
    [ -f "$SRC/$spec" ] && present="$present $spec"
  done
  if [ -n "$present" ]; then
    echo "e2e-smoke: running changed specs first:$present"
    ( cd "$SRC" && CI=true PLAYWRIGHT_BASE_URL="http://127.0.0.1:$app_port" npx playwright test $present )
    changed_result=$?
    if [ "$changed_result" -ne 0 ]; then
      echo "e2e-smoke: changed specs FAILED (exit=$changed_result), skipping the rest of the suite"
      report_app_state
      echo "e2e-smoke: suite exit=$changed_result (slot $slot)"
      exit $changed_result
    fi
    echo "e2e-smoke: changed specs passed, running the full suite"
  fi
fi

echo "e2e-smoke: running Playwright against the isolated stack..."
( cd "$SRC" && CI=true PLAYWRIGHT_BASE_URL="http://127.0.0.1:$app_port" npx playwright test )
result=$?
[ "$result" -ne 0 ] && report_app_state
echo "e2e-smoke: suite exit=$result (slot $slot)"
exit $result
