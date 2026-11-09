#!/usr/bin/env bash
# Before a signed macOS build: is everything there that signing and
# notarisation need? Fails early, before minutes of building. Prints names and
# counts only — never a value, a key or the name of an identity.
#
#   bash scripts/check-mac-signing.sh
#
#   - APPLE_API_KEY (a readable .p8 file), APPLE_API_KEY_ID, APPLE_API_ISSUER
#     and APPLE_TEAM_ID are set (from .env.signing: set -a; source .env.signing;
#     set +a). Without them electron-builder would sign but only warn and skip
#     notarisation;
#   - APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD are not set (electron-builder
#     would notarise with them instead of the API key);
#   - the keychain has a valid Developer ID Application identity of team
#     APPLE_TEAM_ID. With more than one (an old certificate next to its
#     replacement) CSC_NAME must name exactly one: electron-builder would
#     silently take the first it lists.
set -euo pipefail

fail() { echo "check-mac-signing: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS only"

missing=()
for v in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_TEAM_ID; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
[[ ${#missing[@]} -eq 0 ]] || fail "not set: ${missing[*]} — fill in .env.signing and load it: set -a; source .env.signing; set +a
  (an unsigned build needs none of this: npm run dist:mac:unsigned / npm run package:mac:x64:unsigned)"
[[ -f "$APPLE_API_KEY" && -r "$APPLE_API_KEY" ]] || fail "APPLE_API_KEY is not a readable file"
[[ -z "${APPLE_ID:-}${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] \
  || fail "APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD are set: electron-builder would notarise with them, not with the API key — unset them"
# The identity must come from the login keychain checked below.
[[ -z "${CSC_LINK:-}" ]] || fail "CSC_LINK is set: electron-builder would sign from that file, not from the keychain — unset it"
[[ "${CSC_IDENTITY_AUTO_DISCOVERY:-}" != "false" ]] || fail "CSC_IDENTITY_AUTO_DISCOVERY=false: electron-builder would not look for the identity — unset it"
[[ "${CSC_NAME:-}" != "Developer ID Application:"* ]] || fail "CSC_NAME must not start with \"Developer ID Application:\" (electron-builder refuses it) — use the SHA-1 hash"

# Valid identities only (-v), as electron-builder looks them up; one line per
# identity even when it is in two keychains ("  1) HASH "name"" → "HASH "name"").
ids="$(security find-identity -v -p codesigning | grep '"Developer ID Application: ' | sed 's/^ *[0-9]*) //' | sort -u || true)"
count="$(grep -c . <<<"$ids" || true)"
[[ "$count" -gt 0 ]] || fail "no valid Developer ID Application identity in the keychain (see: security find-identity -v -p codesigning)"
if [[ -n "${CSC_NAME:-}" ]]; then
  chosen="$(grep -F -- "$CSC_NAME" <<<"$ids" || true)"
  n="$(grep -c . <<<"$chosen" || true)"
  [[ "$n" -eq 1 ]] || fail "CSC_NAME matches $n valid Developer ID Application identities, not 1"
else
  [[ "$count" -eq 1 ]] || fail "$count valid Developer ID Application identities in the keychain — set CSC_NAME to the SHA-1 hash of the one to use (security find-identity -v -p codesigning)"
  chosen="$ids"
fi
grep -qF -- "($APPLE_TEAM_ID)\"" <<<"$chosen" || fail "the identity to be used is not of team APPLE_TEAM_ID"

echo "check-mac-signing: OK — APPLE_API_KEY (file), APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_TEAM_ID set;" \
  "valid Developer ID Application identities: $count${CSC_NAME:+, CSC_NAME picks 1}; team matches"
