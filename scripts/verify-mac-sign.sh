#!/usr/bin/env bash
# Check a signed and notarised macOS build the way a user's Mac will.
#
#   bash scripts/verify-mac-sign.sh                      # every build made so far (arm64, Intel)
#   bash scripts/verify-mac-sign.sh <path/ImageIQ Resizer.app> <path/to.dmg> [arm64|x86_64]
#
# Runs every point even after a failure, then prints PASS/FAIL per point and
# exits 1 if any failed. Only reads; changes nothing. The optional third
# argument is the architecture the main binary must contain.
set -uo pipefail

usage() { echo "usage: verify-mac-sign.sh [<app> <dmg> [arm64|x86_64]]" >&2; exit 2; }

if [[ $# -eq 0 ]]; then
  ROOT="$(git rev-parse --show-toplevel)"
  WT="$(cd "$ROOT/.." && pwd -P)/wt-resizer-x64"
  found=0
  status=0
  if [[ -d "$ROOT/release/mac-arm64/ImageIQ Resizer.app" ]]; then
    found=1
    bash "$0" "$ROOT/release/mac-arm64/ImageIQ Resizer.app" "$ROOT/release/ImageIQ-Resizer-mac-arm64.dmg" arm64 || status=1
  fi
  if [[ -d "$WT/release/mac/ImageIQ Resizer.app" ]]; then
    found=1
    bash "$0" "$WT/release/mac/ImageIQ Resizer.app" "$WT/release/ImageIQ-Resizer-mac-x64.dmg" x86_64 || status=1
  fi
  [[ $found -eq 1 ]] || { echo "verify-mac-sign: no build found — run npm run dist:mac first" >&2; exit 2; }
  exit $status
fi

[[ $# -eq 2 || $# -eq 3 ]] || usage
APP="${1%/}"
DMG="$2"
WANT_ARCH="${3:-}"
[[ -d "$APP" ]] || { echo "no app at $APP" >&2; exit 2; }
[[ -f "$DMG" ]] || { echo "no dmg at $DMG" >&2; exit 2; }

SUMMARY=""
FAILED=0
record() { # record PASS|FAIL|SKIP <label>
  SUMMARY+="  $1  $2"$'\n'
  [[ "$1" != FAIL ]] || FAILED=$((FAILED + 1))
  echo "  -> $1"
}
show() { sed 's/^/    /' <<<"$1"; }
# check <label> <command...>: PASS when the command exits 0.
check() {
  local label="$1" out r
  shift
  echo "== $label"
  if out="$("$@" 2>&1)"; then r=PASS; else r=FAIL; fi
  show "$out"
  record "$r" "$label"
}
# check_notarized <label> <command...>: PASS when the command exits 0 and
# names a notarised Developer ID source.
check_notarized() {
  local label="$1" out r=FAIL
  shift
  echo "== $label"
  if out="$("$@" 2>&1)" && grep -q 'source=Notarized Developer ID' <<<"$out"; then r=PASS; fi
  show "$out"
  record "$r" "$label"
}

check "1 app: codesign --verify --deep --strict" codesign --verify --deep --strict --verbose=2 "$APP"

echo "== 2 app: signed with Developer ID Application"
INFO="$(codesign -dvv "$APP" 2>&1)"
show "$(grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|CodeDirectory)' <<<"$INFO")"
if grep -q '^Authority=Developer ID Application: ' <<<"$INFO"; then record PASS "2 app: Authority is Developer ID Application"; else record FAIL "2 app: Authority is Developer ID Application"; fi

echo "== 3 app: hardened runtime"
if grep -qE '^CodeDirectory .*flags=0x[0-9a-f]*\([^)]*runtime' <<<"$INFO"; then record PASS "3 app: hardened runtime"; else record FAIL "3 app: hardened runtime"; fi

echo "== 4 app: team"
TEAM="$(sed -n 's/^TeamIdentifier=//p' <<<"$INFO")"
if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "    APPLE_TEAM_ID not set — not compared"
  record SKIP "4 app: TeamIdentifier = APPLE_TEAM_ID"
elif [[ "$TEAM" == "$APPLE_TEAM_ID" ]]; then
  record PASS "4 app: TeamIdentifier = APPLE_TEAM_ID"
else
  echo "    TeamIdentifier is ${TEAM:-none}"
  record FAIL "4 app: TeamIdentifier = APPLE_TEAM_ID"
fi

check_notarized "5 app: spctl -a -t exec (Gatekeeper)" spctl -a -vv -t exec "$APP"
check "6 app: stapler validate" xcrun stapler validate "$APP"
check_notarized "7 dmg: spctl -a -t open, primary signature" spctl -a -vv -t open --context context:primary-signature "$DMG"
check "8 dmg: stapler validate" xcrun stapler validate "$DMG"

echo "== 9 app: architectures of the main binary"
EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
ARCHS="$(lipo -archs "$APP/Contents/MacOS/$EXE" 2>&1)"
LIPO=$?
show "$ARCHS"
if [[ -z "$EXE" || $LIPO -ne 0 ]]; then
  record FAIL "9 app: lipo -archs"
elif [[ -n "$WANT_ARCH" && " $ARCHS " != *" $WANT_ARCH "* ]]; then
  echo "    expected $WANT_ARCH"
  record FAIL "9 app: lipo -archs contains $WANT_ARCH"
else
  record PASS "9 app: lipo -archs${WANT_ARCH:+ contains $WANT_ARCH}"
fi

echo
echo "verify-mac-sign: $APP"
echo "                 $DMG"
printf '%s' "$SUMMARY"
if [[ $FAILED -eq 0 ]]; then
  echo "PASS"
else
  echo "FAIL ($FAILED)"
  exit 1
fi
