#!/usr/bin/env bash
# Run TLA+ TLC formal verification on formal/MeetingLifecycle.tla
# and prove the negative bug-replay model still catches both historical concurrency bugs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAVA_BIN="${JAVA:-$(command -v java || true)}"
if [ -z "$JAVA_BIN" ]; then
  echo "ERROR: Java 11+ is required to run TLC formal verification." >&2
  exit 2
fi

JAR="${TLA2TOOLS:-}"
if [ -z "$JAR" ]; then
  for cand in \
    "$HOME/.cache/tla2tools-1.7.4/tla2tools.jar" \
    "$ROOT/.cache/tla2tools-1.7.4/tla2tools.jar"; do
    if [ -f "$cand" ]; then
      JAR="$cand"
      break
    fi
  done
fi
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"

verify_sha256() {
  local file="$1" expected="$2" actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    return 0
  fi
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: SHA-256 mismatch for $file (expected $expected, got $actual)" >&2
    rm -f "$file"
    exit 1
  fi
}

if [ -z "$JAR" ]; then
  mkdir -p "$ROOT/.cache/tla2tools-1.7.4"
  JAR="$ROOT/.cache/tla2tools-1.7.4/tla2tools.jar"
  curl -fsSL "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar" -o "$JAR"
  verify_sha256 "$JAR" "$TLA_SHA256"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/mn-tlc-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "==> Checking formal/MeetingLifecycle.tla (must pass all invariants)"
"$JAVA_BIN" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
  -metadir "$TMP/ok" \
  -workers 1 \
  -config "$ROOT/formal/MeetingLifecycle.cfg" \
  "$ROOT/formal/MeetingLifecycle.tla"

check_bug_replay() {
  local inv="$1" cfg="$2"
  echo "==> Replaying historical bug against ${inv} (must fail)"
  set +e
  local out rc
  out="$("$JAVA_BIN" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
    -metadir "$TMP/bug-${inv}" \
    -workers 1 \
    -config "$cfg" \
    "$ROOT/formal/MeetingLifecycleBugReplay.tla" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "ERROR: Bug-replay model unexpectedly passed for ${inv}!" >&2
    exit 1
  fi
  if ! printf '%s\n' "$out" | grep -q "Invariant ${inv} is violated"; then
    echo "ERROR: Bug-replay for ${inv} failed for an unexpected reason:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

check_bug_replay "NoDoubleTranscribe" "$ROOT/formal/BugReplayNoDoubleTranscribe.cfg"
check_bug_replay "AmbientStateMatchesEnabled" "$ROOT/formal/BugReplayAmbientStale.cfg"
echo "OK: Fixed model passed all 8 properties and both historical bugs were caught independently."
