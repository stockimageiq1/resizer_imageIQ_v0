#!/usr/bin/env bash
# Sign, notarise and staple a macOS .dmg made by electron-builder.
#
#   bash scripts/notarize-mac-dmg.sh <path/ImageIQ Resizer.app> <path/ImageIQ-Resizer-mac-<arch>.dmg>
#
# electron-builder signs, notarises and staples the .app and then makes the
# dmg from it, but it does not notarise the dmg. This script, after it:
#   1. checks the environment (scripts/check-mac-signing.sh);
#   2. checks the .app is signed with a Developer ID Application certificate
#      and stapled — if not, electron-builder skipped notarisation;
#   3. signs the dmg with the very certificate that signed the .app (its SHA-1
#      is read from the app's signature, so no identity is named anywhere),
#      with a secure timestamp;
#   4. submits the dmg to Apple with the API key and waits; anything but
#      "Accepted" prints Apple's log and fails;
#   5. staples the ticket to the dmg and validates it.
set -euo pipefail

fail() { echo "notarize-mac-dmg: $*" >&2; exit 1; }

[[ $# -eq 2 ]] || fail "usage: notarize-mac-dmg.sh <app> <dmg>"
APP="${1%/}"
DMG="$2"
[[ -d "$APP" ]] || fail "no app at $APP"
[[ -f "$DMG" ]] || fail "no dmg at $DMG"

bash "$(dirname "$0")/check-mac-signing.sh"

echo "== the app: Developer ID signature and stapled ticket"
codesign --verify --deep --strict "$APP" || fail "the app's signature does not verify"
# Output read whole first: grep -q in a pipe could stop codesign with SIGPIPE.
INFO="$(codesign -dvv "$APP" 2>&1 || true)"
grep -q '^Authority=Developer ID Application: ' <<<"$INFO" \
  || fail "the app is not signed with a Developer ID Application certificate"
xcrun stapler validate "$APP" >/dev/null || fail "the app has no stapled ticket — electron-builder did not notarise it"

WORK="$(mktemp -d -t iq-notarize)"
trap 'rm -rf "$WORK"' EXIT
codesign -d --extract-certificates="$WORK/cert" "$APP" 2>/dev/null || true
[[ -s "$WORK/cert0" ]] || fail "could not read the certificate from the app's signature"
SHA1="$(shasum -a 1 "$WORK/cert0" | cut -d' ' -f1 | tr a-f A-F)"

echo "== sign the dmg (the app's certificate, secure timestamp)"
codesign --force --sign "$SHA1" --timestamp "$DMG"
codesign --verify --strict "$DMG"

echo "== notarise the dmg (waits for Apple; usually a few minutes)"
KEY_ARGS=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
set +e
xcrun notarytool submit "$DMG" "${KEY_ARGS[@]}" --wait --output-format json >"$WORK/submit.json"
CODE=$?
set -e
ID="$(plutil -extract id raw -o - "$WORK/submit.json" 2>/dev/null || true)"
STATUS="$(plutil -extract status raw -o - "$WORK/submit.json" 2>/dev/null || true)"
echo "  submission ${ID:-?}: ${STATUS:-?} (notarytool exit code $CODE)"
if [[ "$STATUS" != "Accepted" ]]; then
  [[ -z "$ID" ]] || xcrun notarytool log "$ID" "${KEY_ARGS[@]}" || true
  fail "Apple did not accept the dmg"
fi

echo "== staple the dmg"
# Right after "Accepted" the ticket is not always available yet (stapler error
# 65); @electron/notarize retries the app's staple the same way. A rerun of the
# whole script would re-sign the dmg and need a new submission.
for attempt in 1 2 3 4; do
  xcrun stapler staple "$DMG" && break
  [[ $attempt -lt 4 ]] || fail "stapling failed 4 times; the dmg is notarised (submission $ID) — try later: xcrun stapler staple \"$DMG\""
  echo "  staple attempt $attempt failed, retrying in 20 s"
  sleep 20
done
xcrun stapler validate "$DMG"

echo "notarize-mac-dmg: OK — $DMG"
