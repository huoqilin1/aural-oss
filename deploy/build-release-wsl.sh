#!/usr/bin/env bash
set -euo pipefail

# Build an immutable release artifact for the Aural interview system.
# Runs inside WSL with nvm-managed Node pinned to the server runtime line;
# see deploy/release.core.ps1. The artifact carries the full dependency
# tree because aural-voice.service runs through tsx (a devDependency).
if [ "$#" -ne 4 ]; then
  echo "usage: build-release-wsl.sh <source.tar> <output-dir> <full-sha> <build-env-file>" >&2
  exit 2
fi

SOURCE_TAR=$(realpath "$1")
OUTPUT_DIR=$(realpath -m "$2")
REVISION=$3
BUILD_ENV_FILE=$4
NODE_VERSION=20.20.2

[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "full Git SHA required" >&2; exit 2; }
[ -f "$SOURCE_TAR" ] || { echo "source archive not found" >&2; exit 1; }
[ -f "$BUILD_ENV_FILE" ] || { echo "build env file not found: $BUILD_ENV_FILE" >&2; exit 1; }
[ -s "$HOME/.nvm/nvm.sh" ] || { echo "nvm is required" >&2; exit 1; }

BUILD_ROOT="/tmp/aural-release-build-$REVISION"
cleanup() {
  if [[ "$BUILD_ROOT" == /tmp/aural-release-build-* ]]; then rm -rf -- "$BUILD_ROOT"; fi
}
trap cleanup EXIT
cleanup
mkdir -p "$BUILD_ROOT/source" "$BUILD_ROOT/package" "$OUTPUT_DIR"
tar -xf "$SOURCE_TAR" -C "$BUILD_ROOT/source"

# Domestic mirrors keep Node and package downloads fast and stable from
# China; they do not touch the user's global npm or nvm configuration.
export NVM_NODEJS_ORG_MIRROR=${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}
# shellcheck disable=SC1090
source "$HOME/.nvm/nvm.sh"
nvm install "$NODE_VERSION" >/dev/null 2>&1
nvm use "$NODE_VERSION" >/dev/null
[ "$(node --version)" = "v$NODE_VERSION" ] || { echo "unexpected Node version" >&2; exit 1; }

SOURCE="$BUILD_ROOT/source"
export CI=1

npm --prefix "$SOURCE" ci --no-audit --no-fund --registry=https://registry.npmmirror.com
# Tests run hermetically BEFORE any server env is loaded; with server env
# present, three tests take provider-specific paths and fail. The suite
# passing clean here is the release gate.
(cd "$SOURCE" && npm run lint:ratchet)
(cd "$SOURCE" && npm run typecheck:ratchet)
(cd "$SOURCE" && npm run test:web)
(cd "$SOURCE" && npx playwright install chromium)
(cd "$SOURCE" && npm run test:functional)

# Build-time env is fetched from the server: NEXT_PUBLIC_* values are inlined
# into client bundles by design; the remaining server-only values are needed
# because some API routes initialise clients at module load during page-data
# collection. Secrets are evaluated in memory only -- they never land in the
# artifact (runtime env is linked server-side) and never appear in logs.
set -a
# shellcheck disable=SC1090
source "$BUILD_ENV_FILE"
set +a
(cd "$SOURCE" && npm run build)
[ -d "$SOURCE/.next" ] || { echo "next build produced no .next" >&2; exit 1; }

STAGE="$BUILD_ROOT/package/app"
mkdir -p "$STAGE"
rsync -a \
  --exclude='.git/' --exclude='tests/' --exclude='.tmp/' \
  --exclude='.env*' --exclude='node_modules/' --exclude='.next/' \
  "$SOURCE/" "$STAGE/"
mv "$SOURCE/node_modules" "$STAGE/node_modules"
mv "$SOURCE/.next" "$STAGE/.next"

printf '%s\n' "$REVISION" > "$STAGE/REVISION"
printf 'revision=%s\nnode_version=%s\nbuilt_at=%s\n' \
  "$REVISION" "$NODE_VERSION" "$(date --iso-8601=seconds)" \
  > "$STAGE/BUILD_INFO"

python3 - "$BUILD_ROOT/package/manifest.json" "$REVISION" "$NODE_VERSION" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, revision, node = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({
        "schema": "aural-release.v1",
        "revision": revision,
        "node_version": node,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }, handle, sort_keys=True, indent=2)
    handle.write("\n")
PY

ARTIFACT="$OUTPUT_DIR/aural-$REVISION.tar.gz"
tar -czf "$ARTIFACT" -C "$BUILD_ROOT/package" manifest.json app
sha256sum "$ARTIFACT" > "$ARTIFACT.sha256"
echo "$ARTIFACT"
