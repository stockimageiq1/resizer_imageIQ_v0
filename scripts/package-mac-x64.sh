#!/usr/bin/env bash
# Intel Mac (x64) build, on an Apple silicon Mac, without touching this
# repository's own node_modules (which stays arm64 for development and tests).
#
#   npm run package:mac:x64            # signed, notarised, stapled
#   npm run package:mac:x64:unsigned   # (--unsigned) for quick tries
#
# Works in a separate git worktree, ../wt-resizer-x64, on the current commit:
# created when missing, moved to the current commit otherwise. There the
# dependencies are installed for darwin/x64 from the same lockfile (it is not
# changed), the app is built and packaged as an x64 .dmg and .zip, and checked:
#   - every Mach-O file in the .app contains x86_64 (none is arm64 only);
#   - LSMinimumSystemVersion is printed;
#   - the packaged app passes --smoke-test under Rosetta (exit 0, sharp and
#     ffmpeg BINARY-ASSERT OK, electron-updater loads, the window renders);
#   - the bundled ffmpeg encodes 2 s of a generated clip under Rosetta with
#     libx264, and tries h264_videotoolbox (reported, not required).
# Then this repository's node_modules is checked to be unchanged.
# Signed: the same environment as npm run dist:mac (.env.signing loaded into
# the shell). It is checked before anything is built and again inside the
# worktree right before electron-builder runs there, so it is the environment
# the build gets. electron-builder signs and notarises the .app with the
# settings of electron-builder.yml as committed (the worktree is on the
# commit), then scripts/notarize-mac-dmg.sh does the dmg. Unsigned: the same
# command-line overrides as npm run dist:mac:unsigned.
# Needs Rosetta (softwareupdate --install-rosetta); never installs it.
set -euo pipefail

fail() { echo "package-mac-x64: $*" >&2; exit 1; }

SIGNED=1
case "${1:-}" in
  "") ;;
  --unsigned) SIGNED=0 ;;
  *) fail "usage: package-mac-x64.sh [--unsigned]" ;;
esac
UNSIGNED_FLAGS=(-c.mac.identity=null -c.mac.forceCodeSigning=false -c.mac.notarize=false -c.electronFuses.resetAdHocDarwinSignature=true)

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS only"
arch -x86_64 /usr/bin/true 2>/dev/null || fail "Rosetta is not installed — run: softwareupdate --install-rosetta --agree-to-license"
if [[ $SIGNED -eq 1 ]]; then
  bash "$(dirname "$0")/check-mac-signing.sh" || fail "not ready to sign (see above)"
fi

# Must be started from the main checkout (npm run package:mac:x64 does), never
# from inside a linked worktree: the main checkout is what we protect.
MAIN="$(git rev-parse --show-toplevel)"
[[ "$(cd "$(git rev-parse --git-dir)" && pwd -P)" == "$(cd "$(git rev-parse --git-common-dir)" && pwd -P)" ]] \
  || fail "run this from the main checkout, not from a worktree"
[[ -f "$MAIN/package.json" && -f "$MAIN/package-lock.json" ]] || fail "not the resizer repository"
MAIN="$(cd "$MAIN" && pwd -P)"
WT="$(cd "$MAIN/.." && pwd -P)/wt-resizer-x64"
[[ "$WT" != "$MAIN" && "$WT" != "$MAIN"/* ]] || fail "worktree path would be inside the main checkout"
COMMIT="$(git -C "$MAIN" rev-parse HEAD)"

# Fingerprint of the main node_modules' native parts, to prove they did not change.
main_fingerprint() {
  {
    shasum -a 256 "$MAIN/package-lock.json"
    [[ -f "$MAIN/node_modules/.package-lock.json" ]] && shasum -a 256 "$MAIN/node_modules/.package-lock.json"
    find "$MAIN/node_modules/ffmpeg-static" "$MAIN/node_modules/@img" -type f \( -name ffmpeg -o -name '*.node' -o -name '*.dylib' \) -print0 2>/dev/null \
      | sort -z | xargs -0 shasum -a 256
    ls "$MAIN/node_modules/@img"
  } 2>/dev/null
}
BEFORE="$(main_fingerprint)"

echo "== worktree $WT at $COMMIT"
if git -C "$MAIN" worktree list --porcelain | grep -qx "worktree $WT"; then
  [[ -z "$(git -C "$WT" status --porcelain --untracked-files=no)" ]] || fail "$WT has local changes to tracked files — not touching it"
  git -C "$WT" checkout --quiet --detach "$COMMIT"
else
  [[ ! -e "$WT" ]] || fail "$WT exists but is not a worktree of this repository"
  git -C "$MAIN" worktree add --detach "$WT" "$COMMIT"
fi
[[ "$(git -C "$WT" rev-parse HEAD)" == "$COMMIT" ]] || fail "worktree is not on $COMMIT"

cd "$WT"
[[ "$(pwd -P)" == "$WT" ]] || fail "not in the worktree"

LOCK_BEFORE="$(shasum -a 256 package-lock.json)"

# Phase 1 — compile with this Mac's own tools. The build tools (rollup,
# esbuild) are native for the machine that runs them; installed for x64 they
# do not load here. Their output (out/) is plain JavaScript, the same for
# every processor.
# npm ci runs the dependencies' install scripts: they do not get the
# notarisation key's variables (NO_KEY; electron-builder gets them later).
NO_KEY=(env -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER)
echo "== npm ci for this Mac, to compile"
"${NO_KEY[@]}" npm ci --no-audit --no-fund
rm -rf out release
npx electron-vite build

# Phase 2 — reinstall for darwin/x64 and package. --os/--cpu make npm pick the
# darwin-x64 optional packages from the lockfile (@img/sharp-darwin-x64,
# @img/sharp-libvips-darwin-x64) instead of this Mac's arm64 ones.
# ffmpeg-static downloads its binary in an install script that reads
# npm_config_platform / npm_config_arch (else os.arch(), arm64 here); npm 11
# warns about the unknown "arch" setting but passes it through.
echo "== npm ci for darwin/x64, to package"
"${NO_KEY[@]}" npm_config_platform=darwin npm_config_arch=x64 npm ci --os=darwin --cpu=x64 --no-audit --no-fund
[[ "$(shasum -a 256 package-lock.json)" == "$LOCK_BEFORE" ]] || fail "npm ci changed package-lock.json"
git diff --quiet -- package-lock.json || fail "package-lock.json differs from the commit"

echo "== dependencies"
file node_modules/ffmpeg-static/ffmpeg
ls node_modules/@img
file node_modules/ffmpeg-static/ffmpeg | grep -q 'x86_64' || fail "ffmpeg-static is not x86_64"
[[ -d node_modules/@img/sharp-darwin-x64 && -d node_modules/@img/sharp-libvips-darwin-x64 ]] || fail "sharp darwin-x64 packages missing"
[[ ! -e node_modules/@img/sharp-darwin-arm64 ]] || fail "sharp darwin-arm64 is installed too"
[[ -f out/main/index.js ]] || fail "out/ missing after phase 1"

if [[ $SIGNED -eq 1 ]]; then
  echo "== package — signed (environment as seen in the worktree)"
  bash scripts/check-mac-signing.sh || fail "the signing environment did not reach the worktree"
  npx electron-builder --mac --x64 --publish never
else
  echo "== package — unsigned"
  npx electron-builder --mac --x64 --publish never "${UNSIGNED_FLAGS[@]}"
fi

APP="$WT/release/mac/ImageIQ Resizer.app"
[[ -d "$APP" ]] || APP="$(find "$WT/release" -maxdepth 2 -name 'ImageIQ Resizer.app' -type d | head -1)"
[[ -d "$APP" ]] || fail "ImageIQ Resizer.app not found under release/"
DMG="$WT/release/ImageIQ-Resizer-mac-x64.dmg"
[[ -f "$DMG" ]] || fail "release/ImageIQ-Resizer-mac-x64.dmg not found"
ZIP="$WT/release/ImageIQ-Resizer-mac-x64.zip"
[[ -f "$ZIP" ]] || fail "release/ImageIQ-Resizer-mac-x64.zip not found"

echo "== Mach-O architectures (every file in the .app)"
machos=0; bad=0
while IFS= read -r -d '' f; do
  desc="$(file -b "$f")"
  [[ "$desc" == *Mach-O* ]] || continue
  machos=$((machos + 1))
  archs="$(lipo -archs "$f" 2>/dev/null || echo '?')"
  if [[ " $archs " != *" x86_64 "* ]]; then
    bad=$((bad + 1)); echo "  NOT x86_64: [$archs] ${f#"$APP/"}"
  fi
done < <(find "$APP" -type f -print0)
echo "  Mach-O files: $machos, without x86_64: $bad"
[[ $machos -gt 0 ]] || fail "no Mach-O files found"
[[ $bad -eq 0 ]] || fail "$bad Mach-O file(s) without x86_64"

echo "== Info.plist"
MINOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist" 2>/dev/null || echo 'not set')"
echo "  LSMinimumSystemVersion: $MINOS"

echo "== --smoke-test under Rosetta"
UD="$(mktemp -d -t iq-x64-smoke)"
set +e
SMOKE="$(arch -x86_64 "$APP/Contents/MacOS/ImageIQ Resizer" --smoke-test "--user-data-dir=$UD/ud" 2>&1)"
CODE=$?
set -e
rm -rf "$UD"
echo "$SMOKE" | grep -E 'SMOKE|BINARY-ASSERT|MODULE-ASSERT' | sed 's/^/  /'
echo "  exit code: $CODE"
OK="$(echo "$SMOKE" | grep -cE 'BINARY-ASSERT OK (sharp|ffmpeg)' || true)"
[[ $CODE -eq 0 ]] || fail "--smoke-test exit code $CODE"
[[ $OK -eq 2 ]] || fail "--smoke-test: $OK of 2 BINARY-ASSERT OK"
echo "$SMOKE" | grep -q 'MODULE-ASSERT OK electron-updater' || fail "--smoke-test: electron-updater did not load"
echo "$SMOKE" | grep -q 'SMOKE OK' || fail "--smoke-test: the window did not render"

echo "== ffmpeg from the package under Rosetta"
FF="$(find "$APP/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static" -maxdepth 1 -name ffmpeg -type f | head -1)"
[[ -x "$FF" ]] || fail "bundled ffmpeg not found"
CLIP="$(mktemp -d -t iq-x64-ff)"
arch -x86_64 "$FF" -hide_banner -nostdin -v error -y -f lavfi -i testsrc=duration=2:size=1280x720:rate=30 \
  -c:v libx264 -pix_fmt yuv420p "$CLIP/x264.mp4" || { rm -rf "$CLIP"; fail "libx264 encode failed under Rosetta"; }
echo "  libx264: OK ($(stat -f%z "$CLIP/x264.mp4") bytes)"
if arch -x86_64 "$FF" -hide_banner -nostdin -v error -y -f lavfi -i testsrc=duration=2:size=1280x720:rate=30 \
  -c:v h264_videotoolbox -pix_fmt yuv420p "$CLIP/vt.mp4" 2>"$CLIP/vt.err"; then
  echo "  h264_videotoolbox: OK ($(stat -f%z "$CLIP/vt.mp4") bytes)"
else
  echo "  h264_videotoolbox: did not work under Rosetta (reported, not required): $(tail -2 "$CLIP/vt.err" | tr '\n' ' ')"
fi
rm -rf "$CLIP"

if [[ $SIGNED -eq 1 ]]; then
  echo "== dmg: sign, notarise, staple"
  bash scripts/notarize-mac-dmg.sh "$APP" "$DMG"
fi

echo "== main checkout unchanged"
cd "$MAIN"
[[ "$(main_fingerprint)" == "$BEFORE" ]] || fail "the main node_modules changed — this must never happen"
echo "  $MAIN/node_modules: unchanged"

echo
echo "$([[ $SIGNED -eq 1 ]] && echo signed, notarised and stapled || echo unsigned)"
echo "DMG: $DMG"
echo "size: $(du -h "$DMG" | cut -f1) ($(stat -f%z "$DMG") bytes)"
echo "ZIP: $ZIP"
if [[ $SIGNED -eq 1 ]]; then
  echo "check: bash scripts/verify-mac-sign.sh \"$APP\" \"$DMG\" x86_64"
fi
